#!/usr/bin/env bats
#
# bats tests for scripts/run.sh
#
# run.sh's no-argument default STARTS the gateway (npm install + tsx), so
# unlike kafka.bats these tests never source the script: every test runs it
# as a subprocess against a temp workspace. Only the deterministic surface is
# covered here (dispatch errors, `down` semantics, the already-running guard);
# dev/prod/worker/chrome launch real processes and are out of scope.
#
# NOTE on helper processes: sleepers must be spawned DIRECTLY in the test
# body (sleep N & SPAWNED_PID=$!), never via command substitution - bats
# kills background jobs when the substitution subshell exits.

setup() {
  export TEST_TMPDIR="$(mktemp -d)"
  export WORKDIR="${TEST_TMPDIR}/msrouter"
  mkdir -p "${WORKDIR}/scripts" "${WORKDIR}/.run"
  cp "${BATS_TEST_DIRNAME}/../scripts/run.sh" "${WORKDIR}/scripts/run.sh"
  chmod +x "${WORKDIR}/scripts/run.sh"
  cd "${WORKDIR}"
  export RUN="${WORKDIR}/scripts/run.sh"
  # `down` inspects $PORT for a listener it does not own, so pin it to a free
  # ephemeral port. Without this a real gateway on :8787 would make every
  # `down` test in this file fail.
  export PORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"
}

teardown() {
  if [[ -f "${WORKDIR}/.test-pids" ]]; then
    while read -r p; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done < "${WORKDIR}/.test-pids"
  fi
  for name in gateway worker; do
    if [[ -f "${WORKDIR}/.run/${name}.pid" ]]; then
      kill "$(cat "${WORKDIR}/.run/${name}.pid")" 2>/dev/null || true
      rm -f "${WORKDIR}/.run/${name}.pid"
    fi
  done
  rm -rf "${TEST_TMPDIR}"
}

spawn_sleeper() {
  # Start a live process the test can treat as a gateway/worker. Sets
  # SPAWNED_PID (direct spawn; see file-level note). Teardown and run.sh
  # down are responsible for reaping.
  sleep 60 &
  SPAWNED_PID=$!
}

# Record a pid for teardown reaping.
track_pid() { echo "$1" >> "${WORKDIR}/.test-pids"; }

# A node process whose argv looks like a PROD gateway of THIS workspace:
# `node <WORKDIR>/dist/main.js`. The cmdline carries both ROOT and the
# entrypoint, which is what `down` matches on to adopt an orphaned gateway.
spawn_fake_gateway() {
  mkdir -p "${WORKDIR}/dist"
  printf 'setInterval(() => {}, 1000);\n' > "${WORKDIR}/dist/main.js"
  node "${WORKDIR}/dist/main.js" &
  FAKE_GATEWAY_PID=$!
  track_pid "$FAKE_GATEWAY_PID"
}

# A listener on $PORT that is NOT ours (no ROOT in its cmdline).
spawn_foreign_listener() {
  PORT="${PORT}" node -e 'require("http").createServer((q,s)=>s.end("x")).listen(process.env.PORT,"127.0.0.1")' &
  FOREIGN_PID=$!
  track_pid "$FOREIGN_PID"
  for _ in $(seq 1 40); do
    if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  return 1
}

alive() { kill -0 "$1" 2>/dev/null; }

@test "unknown command fails with usage hint" {
  run bash "${RUN}" frobnicate
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown command: frobnicate"* ]]
  [[ "$output" == *"dev | prod | chrome | logs"* ]]
}

@test "down with no pidfiles is a clean no-op" {
  run bash "${RUN}" down
  [ "$status" -eq 0 ]
  [ ! -f .run/gateway.pid ]
}

# --- 2026-10-06: down() killed only the pid in .run/gateway.pid ------------
# `start_gateway_dev` records the pid of `npx`, but the process that actually
# holds :8787 is a GRANDchild (npx -> tsx -> node). Killing the recorded pid
# orphaned the listener, and the following `rm -f .run/gateway.pid` destroyed
# the only record of it, so every later `down` was a silent no-op that still
# exited 0. These pin the tree teardown and the loud failure.

@test "down kills the whole gateway process tree, not just the recorded pid" {
  # A parent with a child: killing the parent alone leaves the child orphaned.
  bash -c 'sleep 60 & echo $! > '"${WORKDIR}"'/.child.pid; wait' &
  local parent=$!
  track_pid "$parent"
  sleep 0.5
  local child
  child="$(cat "${WORKDIR}/.child.pid")"
  track_pid "$child"
  alive "$child"
  echo "$parent" > .run/gateway.pid

  run bash "${RUN}" down
  [ "$status" -eq 0 ]

  sleep 0.5
  if alive "$child"; then
    echo "gateway CHILD (pid $child) survived run.sh down; tree not reaped" >&3
    false
  fi
}

@test "down adopts an orphaned gateway when the pidfile is gone" {
  spawn_fake_gateway
  alive "$FAKE_GATEWAY_PID"
  [ ! -f .run/gateway.pid ]

  run bash "${RUN}" down
  [ "$status" -eq 0 ]
  [[ "$output" == *"orphan"* ]]

  sleep 0.5
  if alive "$FAKE_GATEWAY_PID"; then
    echo "orphaned gateway (pid $FAKE_GATEWAY_PID) survived run.sh down" >&3
    false
  fi
}

@test "down fails loudly when a foreign process still holds the port" {
  spawn_foreign_listener
  alive "$FOREIGN_PID"

  run bash "${RUN}" down
  [ "$status" -ne 0 ]
  [[ "$output" == *"$PORT"* ]]

  # It must NOT have killed a process it does not own.
  sleep 0.3
  if ! alive "$FOREIGN_PID"; then
    echo "down killed a FOREIGN listener on $PORT" >&3
    false
  fi
}

@test "down reaps a stale (dead) pidfile without killing anything" {
  echo 999999999 > .run/gateway.pid
  run bash "${RUN}" down
  [ "$status" -eq 0 ]
  [ ! -f .run/gateway.pid ]
  [[ "$output" != *"stopped gateway"* ]]  # dead pid: no stop message expected
}

@test "down kills a live gateway pid and reports it" {
  spawn_sleeper
  local pid="$SPAWNED_PID"
  echo "$pid" > .run/gateway.pid
  run bash "${RUN}" down
  [ "$status" -eq 0 ]
  [[ "$output" == *"stopped gateway"* ]]
  sleep 0.3
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    fail "gateway sleeper survived run.sh down"
  fi
  [ ! -f .run/gateway.pid ]
}

@test "down kills the gateway pid it owns (worker command was removed)" {
  spawn_sleeper; local gwpid="$SPAWNED_PID"
  echo "$gwpid" > .run/gateway.pid
  run bash "${RUN}" down
  [ "$status" -eq 0 ]
  [[ "$output" == *"stopped gateway"* ]]
  [[ "$output" != *"stopped worker"* ]]
  sleep 0.3
  local leak=0
  kill -0 "$gwpid" 2>/dev/null && leak=1
  [ "$leak" -eq 0 ]
}

@test "down keeps unrelated processes alive" {
  spawn_sleeper; local bystander="$SPAWNED_PID"
  spawn_sleeper; local pid="$SPAWNED_PID"
  echo "$pid" > .run/gateway.pid
  run bash "${RUN}" down
  [ "$status" -eq 0 ]
  if ! kill -0 "$bystander" 2>/dev/null; then
    fail "run.sh down killed an unrelated process"
  fi
  kill "$bystander" 2>/dev/null || true
}

@test "dev refuses to start when a gateway pid is already live" {
  spawn_sleeper
  echo "$SPAWNED_PID" > .run/gateway.pid
  run bash "${RUN}" dev
  [ "$status" -ne 0 ]
  [[ "$output" == *"gateway already running"* ]]
  # the guard fires before npm install: no node_modules side effects
  [ ! -d node_modules ]
  kill "$SPAWNED_PID" 2>/dev/null || true
  rm -f .run/gateway.pid
}

@test "prod refuses to start when a gateway pid is already live" {
  spawn_sleeper
  echo "$SPAWNED_PID" > .run/gateway.pid
  run bash "${RUN}" prod
  [ "$status" -ne 0 ]
  [[ "$output" == *"gateway already running"* ]]
  kill "$SPAWNED_PID" 2>/dev/null || true
  rm -f .run/gateway.pid
}

@test "logs fails cleanly when the log file does not exist" {
  run bash "${RUN}" logs gateway
  [ "$status" -ne 0 ]
  [[ "$output" == *"no log for gateway"* ]]
}

@test "logs failure names the requested component" {
  run bash "${RUN}" logs worker
  [ "$status" -ne 0 ]
  [[ "$output" == *"no log for worker"* ]]
}
