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
}

teardown() {
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

@test "unknown command fails with usage hint" {
  run bash "${RUN}" frobnicate
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown command: frobnicate"* ]]
  [[ "$output" == *"dev | prod | worker | chrome | logs"* ]]
}

@test "down with no pidfiles is a clean no-op" {
  run bash "${RUN}" down
  [ "$status" -eq 0 ]
  [ ! -f .run/gateway.pid ]
  [ ! -f .run/worker.pid ]
}

@test "down reaps a stale (dead) pidfile without killing anything" {
  echo 999999999 > .run/gateway.pid
  echo 999999998 > .run/worker.pid
  run bash "${RUN}" down
  [ "$status" -eq 0 ]
  [ ! -f .run/gateway.pid ]
  [ ! -f .run/worker.pid ]
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

@test "down kills gateway and worker together" {
  spawn_sleeper; local gwpid="$SPAWNED_PID"
  spawn_sleeper; local wkpid="$SPAWNED_PID"
  echo "$gwpid" > .run/gateway.pid
  echo "$wkpid" > .run/worker.pid
  run bash "${RUN}" down
  [ "$status" -eq 0 ]
  [[ "$output" == *"stopped gateway"* ]]
  [[ "$output" == *"stopped worker"* ]]
  sleep 0.3
  local leak=0
  kill -0 "$gwpid" 2>/dev/null && leak=1
  kill -0 "$wkpid" 2>/dev/null && leak=1
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
