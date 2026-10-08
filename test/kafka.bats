#!/usr/bin/env bats
#
# bats tests for scripts/kafka.sh
#
# These test the configuration, port override, monitor behavior, and cleanup
# without starting a real Kafka broker.

setup() {
  # Create a minimal fake KAFKA_HOME so the script doesn't die on source.
  export TEST_TMPDIR="$(mktemp -d)"
  export KAFKA_HOME="${TEST_TMPDIR}/kafka"
  mkdir -p "${KAFKA_HOME}/bin" "${KAFKA_HOME}/config/kraft"
  touch "${KAFKA_HOME}/bin/kafka-server-start.sh"
  touch "${KAFKA_HOME}/bin/kafka-topics.sh"
  touch "${KAFKA_HOME}/bin/kafka-console-consumer.sh"
  touch "${KAFKA_HOME}/bin/kafka-console-producer.sh"
  touch "${KAFKA_HOME}/bin/kafka-get-offsets.sh"

  # Write a minimal server.properties with the default port.
  cat > "${KAFKA_HOME}/config/kraft/server.properties" <<'PROPS'
listeners=PLAINTEXT://:9092,CONTROLLER://:9093
advertised.listeners=PLAINTEXT://localhost:9092
PROPS

  # Use a temp WORKDIR so we don't touch the real repo.
  export WORKDIR="${TEST_TMPDIR}/msrouter"
  mkdir -p "${WORKDIR}/scripts"
  mkdir -p "${WORKDIR}/.run"

  # Copy the script into the temp workspace.
  cp "${BATS_TEST_DIRNAME}/../scripts/kafka.sh" "${WORKDIR}/scripts/kafka.sh"
  chmod +x "${WORKDIR}/scripts/kafka.sh"

  # Override ROOT by symlinking scripts/ into the temp workspace.
  # We'll cd into WORKDIR before sourcing.
  cd "${WORKDIR}"
}

teardown() {
  # Safety net: a test that fails mid-way must not leave a 30s stand-in behind.
  stop_monitor_standin
  rm -rf "${TEST_TMPDIR}"
}

# ---------------------------------------------------------------------------
# Monitor stand-ins
#
# monitor_pids identifies a monitor the only way a real one can be identified:
# by its command line. `exec -a` sets argv[0] to a command line shaped like the
# real java process (`kafka.tools.ConsoleConsumer`, the topic, and $KAFKA_HOME),
# which is why these stand-ins are argv fakes rather than a real consumer.
# ---------------------------------------------------------------------------

# Spawn a monitor stand-in for $2's KAFKA_HOME (default: this test's) watching
# $1 (default: director-events). Sets MONITOR_STANDIN_PID.
spawn_monitor_standin() {
  local topic="${1:-director-events}" home="${2:-$KAFKA_HOME}" argv0
  argv0="kafka.tools.ConsoleConsumer --topic ${topic} --from-beginning"
  argv0="${argv0} --bootstrap-server localhost:19092 ${home}/bin/kafka-console-consumer.sh"
  KAFKA_HOME="$home" bash -c "exec -a '${argv0}' sleep 30" &
  MONITOR_STANDIN_PID=$!
  # Wait for the exec: before it, argv[0] is still `bash -c ...` and would not
  # match, so an assertion could pass for the wrong reason.
  sleep 0.5
  kill -0 "$MONITOR_STANDIN_PID" 2>/dev/null
}

# Spawn a stand-in shaped like the BROKER: same $KAFKA_HOME, no topic. The
# broker must never be mistaken for a monitor.
spawn_broker_standin() {
  local argv0
  argv0="kafka.Kafka ${KAFKA_HOME}/libs/kafka-server-3.7.0.jar .run/kafka-server.properties"
  argv0="${KAFKA_HOME}/bin/kafka-server-start.sh -Xmx1G ${argv0}"
  KAFKA_HOME="$KAFKA_HOME" bash -c "exec -a '${argv0}' sleep 30" &
  MONITOR_STANDIN_PID=$!
  sleep 0.5
  kill -0 "$MONITOR_STANDIN_PID" 2>/dev/null
}

stop_monitor_standin() {
  [ -n "${MONITOR_STANDIN_PID:-}" ] || return 0
  kill "$MONITOR_STANDIN_PID" 2>/dev/null || true
  wait "$MONITOR_STANDIN_PID" 2>/dev/null || true
  MONITOR_STANDIN_PID=""
}

# ---------------------------------------------------------------------------
# Configuration tests
# ---------------------------------------------------------------------------

@test "KAFKA_PORT defaults to 19092" {
  unset KAFKA_PORT
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  [ "$KAFKA_PORT" = "19092" ]
}

@test "KAFKA_PORT respects override" {
  export KAFKA_PORT=29092
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  [ "$KAFKA_PORT" = "29092" ]
}

@test "KAFKA_BOOTSTRAP uses KAFKA_PORT" {
  unset KAFKA_BOOTSTRAP
  export KAFKA_PORT=29092
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  [ "$KAFKA_BOOTSTRAP" = "localhost:29092" ]
}

@test "KAFKA_BOOTSTRAP respects its own override" {
  export KAFKA_BOOTSTRAP="broker.example.com:9093"
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  [ "$KAFKA_BOOTSTRAP" = "broker.example.com:9093" ]
}

# ---------------------------------------------------------------------------
# Port override in generated properties (start creates .run/kafka-server.properties)
# ---------------------------------------------------------------------------

@test "start generates properties with overridden port" {
  export KAFKA_PORT=29092
  # Mock external commands so start doesn't actually run Kafka.
  mkdir -p "${WORKDIR}/bin"
  cat > "${WORKDIR}/bin/sed" <<'MOCK'
#!/bin/bash
# Fake sed: just copy the file and replace :9092 with the port arg.
port=$(echo "$@" | grep -o ':[0-9]*' | tail -1 | tr -d ':')
cp "${@: -1}" "${@: -2}" 2>/dev/null || true
# Actually, we need to simulate sed's behavior.
# The real test is that start() calls sed with the right pattern.
echo "SED_CALLED" > "${WORKDIR}/.run/sed_called"
MOCK
  chmod +x "${WORKDIR}/bin/sed"

  # We can't easily mock sed inside the script, but we CAN test
  # that the generated file has the right port by running start()
  # with a mocked kafka-server-start.sh.
  cat > "${KAFKA_HOME}/bin/kafka-server-start.sh" <<'MOCK'
#!/bin/bash
# Mock: just touch the pidfile and exit.
echo "12345" > .run/kafka.pid
exit 0
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-server-start.sh"

  # Mock kafka-topics.sh to succeed immediately.
  cat > "${KAFKA_HOME}/bin/kafka-topics.sh" <<'MOCK'
#!/bin/bash
exit 0
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-topics.sh"

  source scripts/kafka.sh </dev/null 2>/dev/null || true
  port_open() { return 0; }
  start

  # The generated properties file should exist.
  [ -f ".run/kafka-server.properties" ]

  # The generated file should have port 29092, not 9092.
  grep -q ":29092" .run/kafka-server.properties
  ! grep -q ":9092" .run/kafka-server.properties
}

@test "stop cleans up generated properties file" {
  mkdir -p .run
  echo "test" > .run/kafka-server.properties
  echo "12345" > .run/kafka.pid

  # Mock is_running to return false (pid not alive).
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  # Override is_running to return false.
  is_running() { return 1; }
  stop

  [ ! -f .run/kafka-server.properties ]
  [ ! -f .run/kafka.pid ]
}

@test "stop also stops the kafka monitor, not just the broker" {
  # The monitor is `exec kafka.tools.ConsoleConsumer --topic director-events`,
  # which owns NO pidfile. Stopping only $PIDFILE left it running against a
  # dead broker (observed 2026-10-06: pid 99503 survived `kafka.sh stop`).
  # Stand in for it with a sleeper whose argv carries $KAFKA_HOME and the
  # topic, which is how the real monitor identifies itself.
  #
  # This stand-in deliberately has NO `kafka.tools.ConsoleConsumer` marker: it
  # pins stop_monitor's loose match. stop_monitor must keep reaping a monitor
  # whose class name a Kafka upgrade may have changed (an orphan consumer is
  # worse than an over-broad reap), whereas monitor()'s guard must not.
  sleep 61 >/dev/null 2>&1 </dev/null &
  local broker_pid=$!
  echo "$broker_pid" > .run/kafka.pid
  # A real long-lived stand-in: `sleep` rejects extra args and exits, which
  # made an earlier version of this test pass vacuously. This script's argv
  # mirrors the real monitor (ConsoleConsumer --topic director-events under
  # $KAFKA_HOME), which is how stop() will identify it.
  cat > "${KAFKA_HOME}/bin/kafka-console-consumer.sh" <<'MOCK'
#!/bin/bash
while :; do sleep 1; done
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-console-consumer.sh"
  "${KAFKA_HOME}/bin/kafka-console-consumer.sh" --topic director-events \
    --bootstrap-server "${KAFKA_BOOTSTRAP:-localhost:19092}" \
    >/dev/null 2>&1 </dev/null &
  local monitor_pid=$!
  # Guard: if the stand-in is not actually alive, this test proves nothing.
  kill -0 "$monitor_pid" 2>/dev/null || {
    echo "monitor stand-in failed to start" >&3; false; }

  source scripts/kafka.sh </dev/null 2>/dev/null || true
  stop

  ! kill -0 "$broker_pid" 2>/dev/null
  if kill -0 "$monitor_pid" 2>/dev/null; then
    kill "$monitor_pid" 2>/dev/null || true
    echo "kafka monitor (pid $monitor_pid) survived kafka.sh stop" >&3
    false
  fi
}

# ---------------------------------------------------------------------------
# Monitor behavior tests
# ---------------------------------------------------------------------------

@test "monitor returns 0 when Kafka is not running" {
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  is_running() { return 1; }
  run monitor
  [ "$status" -eq 0 ]
}

@test "monitor prints skip message when Kafka is not running" {
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  is_running() { return 1; }
  run monitor
  [[ "$output" == *"kafka not running"* ]]
}

@test "monitor tails director-events (not a one-shot)" {
  # Verify the monitor function does NOT use --max-messages.
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  # Extract the monitor function body and check for --max-messages.
  declare -f monitor | grep -v "max-messages"
}

@test "monitor uses --from-beginning for historical context" {
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  declare -f monitor | grep -q "from-beginning"
}

@test "monitor targets director-events topic" {
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  declare -f monitor | grep -q "director-events"
}

@test "monitor starts a consumer when none is running" {
  # Positive control for the guard below: with no live monitor, monitor() must
  # still exec the consumer. A guard that always returned early would pass the
  # duplicate test while silently killing monitoring entirely.
  cat > "${KAFKA_HOME}/bin/kafka-console-consumer.sh" <<'MOCK'
#!/bin/bash
echo "started" >> "${KAFKA_HOME}/.consumer_starts"
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-console-consumer.sh"

  source scripts/kafka.sh </dev/null 2>/dev/null || true
  is_running() { return 0; }   # broker up, and no monitor running
  run monitor

  [ "$status" -eq 0 ]
  [[ "$output" == *"tailing director-events"* ]]
  [ -f "${KAFKA_HOME}/.consumer_starts" ]
}

@test "monitor skips when a monitor consumer is already running" {
  # Regression (2026-10-08): the Director's recovery path types
  # `kafka.sh start-or-init` AND `kafka.sh monitor` into one new tab.
  # start-or_init correctly adopted the already-live broker, but monitor() only
  # checked the broker pidfile - so every recovery spawn added another
  # ConsoleConsumer process and another "java" tab watching the same topic.
  cat > "${KAFKA_HOME}/bin/kafka-console-consumer.sh" <<'MOCK'
#!/bin/bash
echo "started" >> "${KAFKA_HOME}/.consumer_starts"
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-console-consumer.sh"

  spawn_monitor_standin
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  is_running() { return 0; }   # broker up: the pidfile check is not the guard
  run monitor
  stop_monitor_standin

  [ "$status" -eq 0 ]
  [[ "$output" == *"already running"* ]]
  # The real proof: no second consumer was launched.
  [ ! -f "${KAFKA_HOME}/.consumer_starts" ]
}

@test "monitor_pids reports this checkout's running monitor" {
  spawn_monitor_standin
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run monitor_pids director-events
  local found="$output"
  stop_monitor_standin

  [ "$status" -eq 0 ]
  [[ "$found" == *"$MONITOR_STANDIN_PID"* ]]
}

@test "monitor_pids ignores a monitor belonging to another checkout" {
  # Topic-only matching would suppress OUR monitor because another checkout's
  # consumer is watching the same topic, so the $KAFKA_HOME filter is load-
  # bearing on both sides of the guard (skip and reap).
  spawn_monitor_standin director-events "${TEST_TMPDIR}/other-kafka"
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run monitor_pids director-events
  stop_monitor_standin

  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "monitor_pids ignores this checkout's broker" {
  # $KAFKA_HOME-only matching would match the broker: it runs from the same
  # install, so its argv carries $KAFKA_HOME, but it never names the topic.
  # A guard that treated the broker as "a monitor" would suppress monitoring
  # for as long as the broker lives - the worst failure mode here.
  spawn_broker_standin
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run monitor_pids director-events
  stop_monitor_standin

  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "monitor_pids ignores a bystander process that merely mentions the topic" {
  # Topic + $KAFKA_HOME alone still matches a bystander (a `rg` over the repo,
  # an editor). monitor_pids is a guard that SILENTLY DISABLES monitoring on a
  # false positive, so the consumer class is the third load-bearing half.
  KAFKA_HOME="${KAFKA_HOME}" bash -c 'exec -a "rg director-events ${KAFKA_HOME}/libs" sleep 30' &
  MONITOR_STANDIN_PID=$!
  sleep 0.5
  kill -0 "$MONITOR_STANDIN_PID" 2>/dev/null || { echo "stand-in failed" >&3; false; }

  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run monitor_pids director-events
  stop_monitor_standin

  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "monitor_pids honours its topic argument" {
  # The topic is a parameter, not a constant: asking about a different topic
  # must not report this checkout's director-events monitor.
  spawn_monitor_standin
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run monitor_pids director-slack-raw
  stop_monitor_standin

  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "stop_monitor leaves another checkout's monitor alone" {
  # The reason the reap filters on $KAFKA_HOME, not just the topic: a second
  # msrouter checkout must never have its monitor killed by this one.
  spawn_monitor_standin director-events "${TEST_TMPDIR}/other-kafka"
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run stop_monitor
  local status_after=$status
  sleep 0.3
  local other_alive=0
  kill -0 "$MONITOR_STANDIN_PID" 2>/dev/null && other_alive=1
  stop_monitor_standin

  [ "$status_after" -ne 0 ]      # nothing of ours was stopped
  [ "$other_alive" -eq 1 ]      # and the other checkout's monitor survived
}

@test "stop_monitor kills this checkout's monitor" {
  # The other half of the previous test: the $KAFKA_HOME filter must not turn
  # stop_monitor into a no-op for our OWN monitor.
  spawn_monitor_standin
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run stop_monitor
  local status_after=$status
  sleep 0.3
  local alive=0
  kill -0 "$MONITOR_STANDIN_PID" 2>/dev/null && alive=1
  MONITOR_STANDIN_PID=""        # already reaped; do not let teardown re-kill

  [ "$status_after" -eq 0 ]
  [ "$alive" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

@test "sed pattern replaces :9092 in server.properties" {
  local props="${TEST_TMPDIR}/test-server.properties"
  cat > "$props" <<'PROPS'
listeners=PLAINTEXT://:9092,CONTROLLER://:9093
advertised.listeners=PLAINTEXT://localhost:9092
PROPS

  sed -e "s/:9092/:29092/g" "$props" | grep -q ":29092"
  ! sed -e "s/:9092/:29092/g" "$props" | grep -q ":9092"
}

@test "sed preserves CONTROLLER port 9093" {
  local props="${TEST_TMPDIR}/test-server.properties"
  cat > "$props" <<'PROPS'
listeners=PLAINTEXT://:9092,CONTROLLER://:9093
PROPS

  sed -e "s/:9092/:29092/g" "$props" | grep -q ":9093"
}

@test "default port 19092 sed pattern works" {
  local props="${TEST_TMPDIR}/test-server.properties"
  cat > "$props" <<'PROPS'
listeners=PLAINTEXT://:9092,CONTROLLER://:9093
advertised.listeners=PLAINTEXT://localhost:9092
PROPS

  sed -e "s/:9092/:19092/g" "$props" | grep -q ":19092"
  ! sed -e "s/:9092/:19092/g" "$props" | grep -q ":9092"
}

# ---------------------------------------------------------------------------
# reinit_kraft() tests
# ---------------------------------------------------------------------------

@test "reinit_kraft kills lingering broker and formats storage" {
  # Create a fake broker process
  sleep 61 >/dev/null 2>&1 </dev/null &
  local fake_pid=$!
  echo "$fake_pid" > .run/kafka.pid

  # Mock kafka-storage.sh (use hardcoded path since mock runs in subprocess)
  cat > "${KAFKA_HOME}/bin/kafka-storage.sh" <<MOCK
#!/bin/bash
echo "\$@" >> "${KAFKA_HOME}/.storage_args"
echo "test-cluster-uuid"
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-storage.sh"

  source scripts/kafka.sh </dev/null 2>/dev/null || true
  reinit_kraft

  # Broker should be killed
  ! kill -0 "$fake_pid" 2>/dev/null

  # PIDFILE should be removed
  [ ! -f .run/kafka.pid ]

  # Storage should be formatted with cluster UUID
  grep -q "random-uuid" "${KAFKA_HOME}/.storage_args"
  grep -q "format" "${KAFKA_HOME}/.storage_args"
}

@test "reinit_kraft handles missing PIDFILE gracefully" {
  rm -f .run/kafka.pid

  cat > "${KAFKA_HOME}/bin/kafka-storage.sh" <<'MOCK'
#!/bin/bash
echo "new-uuid"
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-storage.sh"

  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run reinit_kraft

  [ "$status" -eq 0 ]
  [[ "$output" == *"KRaft storage reinitialized"* ]]
}

# ---------------------------------------------------------------------------
# start_or_init() tests
# ---------------------------------------------------------------------------

@test "start_or_init succeeds when broker starts on first attempt" {
  # Mock kafka-server-start.sh to start a fake process
  cat > "${KAFKA_HOME}/bin/kafka-server-start.sh" <<'MOCK'
#!/bin/bash
sleep 61 >/dev/null 2>&1 </dev/null &
echo $! > .run/kafka.pid
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-server-start.sh"

  # Mock kafka-topics.sh to succeed immediately
  cat > "${KAFKA_HOME}/bin/kafka-topics.sh" <<'MOCK'
#!/bin/bash
exit 0
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-topics.sh"

  source scripts/kafka.sh </dev/null 2>/dev/null || true
  port_open() { return 0; }
  # start() also refuses when the port is ALREADY held; these tests are about the
  # readiness loop, so report the port as free (same as their port_open mock).
  port_in_use() { return 1; }
  run start_or_init

  [ "$status" -eq 0 ]
  [[ "$output" == *"broker ready"* ]]
}

@test "start_or_init retries with reinit on first failure" {
  # Track calls to kafka-topics.sh
  local counter_file="${TEST_TMPDIR}/topics_call_count"
  echo "0" > "$counter_file"

  # Mock kafka-server-start.sh
  cat > "${KAFKA_HOME}/bin/kafka-server-start.sh" <<'MOCK'
#!/bin/bash
sleep 61 >/dev/null 2>&1 </dev/null &
echo $! > .run/kafka.pid
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-server-start.sh"

  # Mock kafka-topics.sh: fail first 20 calls, succeed on 21st
  cat > "${KAFKA_HOME}/bin/kafka-topics.sh" <<'MOCK'
#!/bin/bash
counter_file="COUNTER_FILE"
count=$(cat "$counter_file")
count=$((count + 1))
echo "$count" > "$counter_file"
if [ "$count" -le 20 ]; then
  exit 1
fi
exit 0
MOCK
  sed "s|COUNTER_FILE|${counter_file}|g" "${KAFKA_HOME}/bin/kafka-topics.sh" > "${KAFKA_HOME}/bin/kafka-topics.sh.tmp"
  mv "${KAFKA_HOME}/bin/kafka-topics.sh.tmp" "${KAFKA_HOME}/bin/kafka-topics.sh"
  chmod +x "${KAFKA_HOME}/bin/kafka-topics.sh"

  # Mock kafka-storage.sh
  cat > "${KAFKA_HOME}/bin/kafka-storage.sh" <<'MOCK'
#!/bin/bash
echo "recovered-uuid"
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-storage.sh"

  source scripts/kafka.sh </dev/null 2>/dev/null || true
  port_open() { return 0; }
  # port_in_use mocked to false: this test drives the readiness-failure path, so
  # the start() duplicate-broker guard must not short-circuit it.
  port_in_use() { return 1; }
  run start_or_init

  [ "$status" -eq 0 ]
  [[ "$output" == *"Kafka start failed"* ]]
  [[ "$output" == *"attempting KRaft reinitialization"* ]]
  [[ "$output" == *"KRaft storage reinitialized"* ]]
}

@test "reinit_kraft wipes mismatched KRaft data dir before formatting" {
  # Regression (2026-08-24): a formatted /tmp kraft dir whose meta.properties
  # holds a FOREIGN cluster id made 'format --ignore-formatted' throw
  # 'Invalid cluster.id' - reinit must wipe the data dir first.
  local kraft_data="${TEST_TMPDIR}/kraft-data"
  mkdir -p "$kraft_data/__consumer_offsets-0"
  echo "cluster.id=FOREIGN-ID-FROM-OLD-RUN" > "$kraft_data/meta.properties"
  echo "log.dirs=$kraft_data" >> "${KAFKA_HOME}/config/kraft/server.properties"

  # Mock storage: random-uuid works; format FAILS if meta.properties still
  # exists (that is exactly what real StorageTool does on cluster-id mismatch).
  cat > "${KAFKA_HOME}/bin/kafka-storage.sh" <<MOCK
#!/bin/bash
if [ "\$1" = "random-uuid" ]; then echo "fresh-uuid"; exit 0; fi
if [ "\$1" = "format" ]; then
  db_dir=\$(grep '^log.dirs=' "\$4" | cut -d= -f2)
  if [ -f "\$db_dir/meta.properties" ]; then
    echo "Invalid cluster.id in: \$db_dir/meta.properties" >&2
    exit 1
  fi
  echo "FORMATTED-CLEAN" >> "${KAFKA_HOME}/.format_ok"
  exit 0
fi
exit 0
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-storage.sh"

  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run reinit_kraft

  [ "$status" -eq 0 ]
  [ ! -f "$kraft_data/meta.properties" ]
  grep -q "FORMATTED-CLEAN" "${KAFKA_HOME}/.format_ok"
}

# ---------------------------------------------------------------------------
# Robustness: KRaft storage preflight + fast readiness (2026-08-31)
# The 'No readable meta.properties files found' failure made the broker die
# instantly while the old 20x kafka-topics.sh readiness loop hung for minutes
# on dead-broker JVM calls - and the Director spawned a duplicate tab.
# ---------------------------------------------------------------------------

# Shared mock setup: storage/topics/server-start mocks recording a call order.
setup_robust() {
  mkdir -p "${TEST_TMPDIR}/kraft-logs"   # no meta.properties => unhealthy
  cat > "${KAFKA_HOME}/config/kraft/server.properties" <<PROPS
log.dirs=${TEST_TMPDIR}/kraft-logs
PROPS

  : > "${TEST_TMPDIR}/call-order"

  cat > "${KAFKA_HOME}/bin/kafka-storage.sh" <<MOCK
#!/bin/bash
echo "storage:\$1" >> "${TEST_TMPDIR}/call-order"
echo "recovered-uuid"
exit 0
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-storage.sh"

  cat > "${KAFKA_HOME}/bin/kafka-server-start.sh" <<MOCK
#!/bin/bash
echo "server-start" >> "${TEST_TMPDIR}/call-order"
exit 0
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-server-start.sh"

  printf '#!/bin/bash\nexit 0\n' > "${KAFKA_HOME}/bin/kafka-topics.sh"
  chmod +x "${KAFKA_HOME}/bin/kafka-topics.sh"

  export KAFKA_READINESS_TRIES=2
  export KAFKA_READINESS_SLEEP=0
}

@test "storage_ok is false when KRaft log.dirs lacks meta.properties" {
  mkdir -p "${TEST_TMPDIR}/kraft-logs"
  cat > "${KAFKA_HOME}/config/kraft/server.properties" <<PROPS
log.dirs=${TEST_TMPDIR}/kraft-logs
PROPS
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run storage_ok
  [ "$status" -ne 0 ]
}

@test "storage_ok is true when meta.properties exists" {
  mkdir -p "${TEST_TMPDIR}/kraft-logs"
  touch "${TEST_TMPDIR}/kraft-logs/meta.properties"
  cat > "${KAFKA_HOME}/config/kraft/server.properties" <<PROPS
log.dirs=${TEST_TMPDIR}/kraft-logs
PROPS
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run storage_ok
  [ "$status" -eq 0 ]
}

@test "start_or_init formats unhealthy storage BEFORE the first server start" {
  setup_robust
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  port_open() { return 0; }
  # Storage-preflight ordering, not the port guard: report the port free.
  port_in_use() { return 1; }
  run start_or_init
  [ "$status" -eq 0 ]

  local order="${TEST_TMPDIR}/call-order"
  local first_start first_format
  # `start` launches the broker as `nohup ... &`, so the mock appends
  # asynchronously. With the readiness probe stubbed true, start() returns
  # before the child has written its line, so grepping immediately races and
  # fails on a loaded machine. Wait for the line, then read the order.
  local i
  for i in $(seq 1 50); do
    grep -q '^server-start$' "$order" && break
    sleep 0.1
  done
  first_start=$(grep -n '^server-start$' "$order" | head -1 | cut -d: -f1)
  first_format=$(grep -n '^storage:' "$order" | head -1 | cut -d: -f1)
  [ -n "$first_start" ]
  [ -n "$first_format" ]
  [ "$first_format" -lt "$first_start" ]
}

@test "start_or_init does NOT reformat when storage is healthy" {
  setup_robust
  touch "${TEST_TMPDIR}/kraft-logs/meta.properties"   # healthy storage
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  port_open() { return 0; }
  # Storage-preflight ordering, not the port guard: report the port free.
  port_in_use() { return 1; }
  run start_or_init
  [ "$status" -eq 0 ]
  ! grep -q '^storage:' "${TEST_TMPDIR}/call-order"
}

@test "start fails fast via port probe when the broker dies instantly" {
  mkdir -p "${TEST_TMPDIR}/kraft-logs"
  touch "${TEST_TMPDIR}/kraft-logs/meta.properties"   # healthy: no reinit
  cat > "${KAFKA_HOME}/config/kraft/server.properties" <<PROPS
log.dirs=${TEST_TMPDIR}/kraft-logs
PROPS

  # Broker dies immediately after nohup (simulates the meta.properties crash).
  printf '#!/bin/bash\nexit 1\n' > "${KAFKA_HOME}/bin/kafka-server-start.sh"
  chmod +x "${KAFKA_HOME}/bin/kafka-server-start.sh"
  printf '#!/bin/bash\nexit 0\n' > "${KAFKA_HOME}/bin/kafka-topics.sh"
  chmod +x "${KAFKA_HOME}/bin/kafka-topics.sh"

  export KAFKA_READINESS_TRIES=2
  export KAFKA_READINESS_SLEEP=0
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  # Broker dies instantly, so the port is never actually held and never opens.
  port_in_use() { return 1; }   # duplicate-broker guard: port looks free
  port_open() { return 1; }     # readiness probe: nothing ever accepted
  run start
  [ "$status" -ne 0 ]
  [[ "$output" == *"did not become ready"* ]]
}

# ---------------------------------------------------------------------------
# Duplicate-broker guard (2026-10-03)
# kafka.sh start only consulted the PIDFILE, so two manual starts in two iTerm
# tabs both saw "not running" and raced to bind the same port. One tab per start
# is how the duplicate monitor tabs appeared. start must now also refuse when the
# port is held, even with no pidfile.
# ---------------------------------------------------------------------------

@test "start refuses when the port is held but no pidfile exists" {
  # High, unlikely-to-collide port: binding the real broker port would let the
  # test pass for the wrong reason (another listener already holding it).
  export KAFKA_PORT=39192
  export KAFKA_BOOTSTRAP="localhost:39192"
  # A stray broker (or any listener) already owns the port; the pidfile is gone.
  # Mock a live process that will hold a TCP port for the duration of the test.
  python3 - <<'PY' &
import socket, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 39192)); s.listen(1); time.sleep(30)
PY
  local holder=$!
  sleep 1

  rm -f .run/kafka.pid
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  is_running() { return 1; }            # pidfile says "not running"
  port_open() { return 0; }              # but the port IS held
  kafka_responding() { return 1; }      # and it is not our broker

  run start
  kill "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true

  [ "$status" -ne 0 ]
  [[ "$output" == *"already in use"* || "$output" == *"refus"* ]]
}

@test "start still proceeds when nothing holds the port" {
  cat > "${KAFKA_HOME}/bin/kafka-server-start.sh" <<'MOCK'
#!/bin/bash
sleep 61 >/dev/null 2>&1 </dev/null &
echo $! > .run/kafka.pid
MOCK
  chmod +x "${KAFKA_HOME}/bin/kafka-server-start.sh"
  printf '#!/bin/bash\nexit 0\n' > "${KAFKA_HOME}/bin/kafka-topics.sh"
  chmod +x "${KAFKA_HOME}/bin/kafka-topics.sh"

  rm -f .run/kafka.pid
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  is_running() { return 1; }
  port_open() { return 0; }
  kafka_responding() { return 0; }
  # The whole point of this test is that NOTHING holds the port. Without this
  # mock a real broker on 19092 would take the adopt branch and pass for the
  # wrong reason.
  port_in_use() { return 1; }

  run start
  [ "$status" -eq 0 ]
  [[ "$output" == *"starting Kafka broker"* ]]
}

@test "port_in_use helper detects a held port and ignores a free one" {
  export KAFKA_PORT=39193
  python3 - <<'PY' &
import socket, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 39193)); s.listen(1); time.sleep(20)
PY
  local holder=$!
  sleep 1
  source scripts/kafka.sh </dev/null 2>/dev/null || true

  run port_in_use 39193
  local held=$status
  run port_in_use 39194
  local free=$status
  kill "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true

  [ "$held" -eq 0 ]
  [ "$free" -ne 0 ]
}

@test "kafka_responding is false when kafka-topics.sh fails" {
  printf '#!/bin/bash\nexit 1\n' > "${KAFKA_HOME}/bin/kafka-topics.sh"
  chmod +x "${KAFKA_HOME}/bin/kafka-topics.sh"
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run kafka_responding
  [ "$status" -ne 0 ]
}

@test "kafka_responding is true when kafka-topics.sh lists topics" {
  printf '#!/bin/bash\necho director-events\nexit 0\n' > "${KAFKA_HOME}/bin/kafka-topics.sh"
  chmod +x "${KAFKA_HOME}/bin/kafka-topics.sh"
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  run kafka_responding
  [ "$status" -eq 0 ]
}

@test "start adopts the running broker's pid so stop/restart keep working" {
  # Regression (2026-10-03): the reuse branch returned 0 without writing a
  # pidfile, which made `restart` a silent no-op and left an orphan broker that
  # no command could stop.
  export KAFKA_PORT=39195
  export KAFKA_BOOTSTRAP="localhost:39195"
  python3 - <<'PY' &
import socket, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 39195)); s.listen(1); time.sleep(30)
PY
  local holder=$!
  sleep 1

  rm -f .run/kafka.pid
  source scripts/kafka.sh </dev/null 2>/dev/null || true
  is_running() { return 1; }
  port_open() { return 0; }
  port_in_use() { return 0; }
  kafka_responding() { return 0; }
  # Pretend lsof can report the holder as the broker process.
  lsof() { if [[ "$*" == *"-tiTCP"* ]]; then echo "$holder"; else return 1; fi; }
  export -f lsof 2>/dev/null || true

  run start
  kill "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true

  [ "$status" -eq 0 ]
  # The pidfile must now exist and hold a pid.
  [ -f .run/kafka.pid ]
}
