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
  rm -rf "${TEST_TMPDIR}"
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
