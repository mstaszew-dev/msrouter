#!/usr/bin/env bash
#
# scripts/kafka.sh - manage the local Kafka broker (KRaft mode, no Zookeeper).
#
#   scripts/kafka.sh start    # start the broker
#   scripts/kafka.sh stop     # stop the broker
#   scripts/kafka.sh restart  # stop + start
#   scripts/kafka.sh status   # is the broker running + topic offsets
#   scripts/kafka.sh topics   # create/verify the director topics
#   scripts/kafka.sh tail <topic>  # stream a topic to stdout (real-time)
#   scripts/kafka.sh produce <topic> <key> <value>  # one-shot produce
#   scripts/kafka.sh monitor  # show the first 5 messages of every topic
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"

KAFKA_HOME="${KAFKA_HOME:-$HOME/kafka/kafka_2.13-3.7.0}"
KAFKA_PORT="${KAFKA_PORT:-19092}"
KAFKA_BOOTSTRAP="${KAFKA_BOOTSTRAP:-localhost:${KAFKA_PORT}}"
PIDFILE=".run/kafka.pid"

mkdir -p .run

# Fast, JVM-free port probe. The old readiness loop called kafka-topics.sh
# 20x against a possibly-dead broker; each JVM call hung ~15s, turning the
# "20s" wait into minutes and stalling the Director's recovery tab.
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/${KAFKA_PORT}") 2>/dev/null; }

# True when SOMETHING already holds the broker port, whether or not it is ours.
# Distinct from port_open (does the socket accept?) and from is_running (does
# our pidfile hold a live pid?). Two manual starts used to race past the pidfile
# check and both bind, which is how duplicate broker+monitor tabs appeared.
port_in_use() {
  local port="${1:-$KAFKA_PORT}"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  # lsof absent: fall back to the dependency-free /dev/tcp probe so the guard
  # cannot silently disable itself (exit 127 would read as "port free").
  (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null
}

# PID of whatever holds the broker port (empty if unknown). `head -1` adopts a
# single pid, so if duplicates ever exist, stop() kills only one; the guard in
# start() is what prevents duplicates in the first place.
broker_pid() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -tiTCP:"${1:-$KAFKA_PORT}" -sTCP:LISTEN 2>/dev/null | head -1
}

# True when a real Kafka broker answers on the bootstrap address. A non-Kafka
# listener (nc, a stray JVM) holds the port but has no topic API, so "the port
# is bound" must never be taken as "the broker is up".
kafka_responding() {
  "$KAFKA_HOME/bin/kafka-topics.sh" --bootstrap-server "$KAFKA_BOOTSTRAP" --list >/dev/null 2>&1
}

# Generate the port-overridden broker properties (idempotent).
generate_props() {
  local props=".run/kafka-server.properties"
  sed -e "s/:9092/:${KAFKA_PORT}/g" \
    "$KAFKA_HOME/config/kraft/server.properties" > "$props"
  printf '%s' "$props"
}

# KRaft storage health: log.dirs must hold meta.properties. A wiped/corrupt
# dir makes the broker die instantly with 'No readable meta.properties files
# found' - detectable BEFORE starting, so the caller can format first.
storage_ok() {
  local props log_dirs
  props="$(generate_props)"
  log_dirs="$(grep '^log.dirs=' "$props" | cut -d= -f2- || true)"
  [[ -n "$log_dirs" && -f "$log_dirs/meta.properties" ]]
}

log()  { printf '\033[1;34m[kafka]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; exit 1; }

# NOTE on the pidfile (2026-10-03): it IS reliable. kafka-server-start.sh ends in
# `exec ... kafka.Kafka`, so the shell is replaced by the JVM and `$!` in start()
# is the broker's real pid. An older comment here claimed the pidfile was
# unreliable because of nohup; that was wrong and it made stop() look suspect.
# The genuine gap was that is_running() was the ONLY check, which is what
# allowed duplicate brokers; see port_in_use in start().
is_running() {
  [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

start() {
  if is_running; then die "Kafka already running (pid $(cat "$PIDFILE"))"; fi
  # Duplicate-broker guard (2026-10-03): the pidfile alone is not enough. A
  # broker started from another tab (or one whose pidfile was lost) leaves the
  # port bound with no pid of ours, so start would race it and both would try to
  # bind. Refuse when the port is taken; if it is OUR broker responding, treat it
  # as success rather than an error so idempotent callers do not fail.
  if port_in_use "$KAFKA_PORT"; then
    if kafka_responding; then
      # Adopt the running broker's pid so stop()/monitor/restart keep working.
      # Without this, returning 0 with no pidfile made `restart` a silent no-op
      # and left an orphan no command could stop.
      local adopted
      adopted="$(broker_pid)"
      if [[ -n "$adopted" ]]; then
        printf '%s' "$adopted" > "$PIDFILE"
        ok "Kafka already running on ${KAFKA_BOOTSTRAP} (adopted pid ${adopted})"
      else
        ok "Kafka already running on ${KAFKA_BOOTSTRAP} (pid not recoverable)"
      fi
      return 0
    fi
    die "port ${KAFKA_PORT} is already in use by another process (not a Kafka broker).
  Refusing to start a second broker. Free the port, or stop that process first:
    lsof -nP -iTCP:${KAFKA_PORT} -sTCP:LISTEN"
  fi
  # Override ports in KRaft config so the broker listens on KAFKA_PORT.
  local props
  props="$(generate_props)"
  log "starting Kafka broker in KRaft mode on port ${KAFKA_PORT}"
  nohup "$KAFKA_HOME/bin/kafka-server-start.sh" \
    "$props" \
    > .run/kafka.log 2>&1 &
  echo $! > "$PIDFILE"
  ok "kafka pid $(cat "$PIDFILE")"

  log "waiting for broker on ${KAFKA_BOOTSTRAP}"
  # Fast port probe first (instant fail against a dead broker), then a single
  # kafka-topics.sh call to confirm the topic API once the port accepts.
  local tries="${KAFKA_READINESS_TRIES:-20}"
  local sleep_s="${KAFKA_READINESS_SLEEP:-1}"
  local i
  for i in $(seq 1 "$tries"); do
    if port_open && kafka_responding; then
      ok "broker ready"
      return 0
    fi
    sleep "$sleep_s"
  done
  echo "--- kafka log ---" >&2
  tail -n 20 .run/kafka.log >&2 || true
  echo "broker did not become ready (${tries} tries)" >&2
  return 1
}

# Reinitialize KRaft storage (fixes corrupted/missing meta.properties from /tmp cleanup).
reinit_kraft() {
  log "reinitializing KRaft storage..."
  # Kill any lingering broker from a failed start attempt
  if is_running; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 2
  fi
  rm -f "$PIDFILE" .run/kafka-server.properties
  # Generate a fresh cluster UUID and format storage
  local cluster_uuid
  cluster_uuid=$("$KAFKA_HOME/bin/kafka-storage.sh" random-uuid)
  local props=".run/kafka-server.properties"
  sed -e "s/:9092/:${KAFKA_PORT}/g" \
      "$KAFKA_HOME/config/kraft/server.properties" > "$props"
  # A formatted data dir whose meta.properties holds a FOREIGN cluster id
  # makes 'format --ignore-formatted' fail with 'Invalid cluster.id'.
  # Wipe the disposable KRaft data dir first; guard on meta.properties so we
  # only ever remove something that is unmistakably a KRaft data dir.
  local log_dirs
  log_dirs=$(grep '^log.dirs=' "$props" | cut -d= -f2- || true)
  if [ -n "$log_dirs" ] && [ -f "$log_dirs/meta.properties" ]; then
    rm -rf "$log_dirs"
    log "wiped stale KRaft data dir $log_dirs (foreign cluster id)"
  fi
  "$KAFKA_HOME/bin/kafka-storage.sh" format \
    --cluster-id "$cluster_uuid" \
    --config "$props" \
    --ignore-formatted
  ok "KRaft storage reinitialized (cluster-id: $cluster_uuid)"
}

# Try to start; if broker fails to come up, reinitialize KRaft and retry once.
start_or_init() {
  # NOTE: start() calls die() when a foreign process holds the port, and die()
  # exits the whole script. That is deliberate and must not be "fixed": we must
  # NOT run reinit_kraft (which can rm -rf the KRaft log dir) just because some
  # unrelated process owns the port. Free the port, then retry.
  #
  # Preflight: format the KRaft storage BEFORE starting when metadata is
  # missing/corrupt, so the broker doesn't die instantly on every attempt
  # (and the Director doesn't spawn duplicate recovery tabs).
  if ! storage_ok; then
    log "KRaft storage unhealthy (meta.properties missing); formatting before start"
    reinit_kraft
  fi
  if start; then
    return 0
  fi
  log "Kafka start failed; attempting KRaft reinitialization"
  reinit_kraft
  start
}

# Stop the monitor started by `monitor()`. It `exec`s ConsoleConsumer, so it
# owns no pidfile and stopping only the broker left it consuming against a dead
# one (observed 2026-10-06: pid 99503 survived `kafka.sh stop`). Matched by
# $KAFKA_HOME + topic so another checkout's monitor is never touched.
stop_monitor() {
  local pid cmd stopped=0
  for pid in $(pgrep -f 'director-events' 2>/dev/null || true); do
    [[ "$pid" == "$$" ]] && continue
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    [[ "$cmd" == *"$KAFKA_HOME"* ]] || continue
    kill "$pid" 2>/dev/null && { ok "stopped kafka monitor (pid $pid)"; stopped=$((stopped+1)); }
  done
  [[ "$stopped" -gt 0 ]]
}

stop() {
  if is_running; then
    kill "$(cat "$PIDFILE")" && ok "stopped kafka (pid $(cat "$PIDFILE"))"
  else
    log "kafka not running"
  fi
  stop_monitor || true
  rm -f "$PIDFILE" .run/kafka-server.properties
}

status() {
  if is_running; then
    ok "kafka running (pid $(cat "$PIDFILE"))"
  else
    log "kafka not running"
  fi
  log "topics:"
  "$KAFKA_HOME/bin/kafka-topics.sh" --bootstrap-server "$KAFKA_BOOTSTRAP" --list 2>/dev/null || true
  for topic in director-slack-raw director-events; do
    log "offsets for ${topic}:"
    "$KAFKA_HOME/bin/kafka-get-offsets.sh" --bootstrap-server "$KAFKA_BOOTSTRAP" --topic "$topic" 2>/dev/null || true
  done
}

create_topics() {
  for topic in director-slack-raw director-events; do
    log "creating topic ${topic} (if not exists)"
    "$KAFKA_HOME/bin/kafka-topics.sh" --create --topic "$topic" \
      --bootstrap-server "$KAFKA_BOOTSTRAP" --partitions 1 --replication-factor 1 \
      2>/dev/null || log "  topic ${topic} already exists"
  done
  ok "topics ready"
}

tail_topic() {
  local topic="${1:?usage: kafka.sh tail <topic>}"
  log "tailing ${topic} (Ctrl-C to stop)"
  exec "$KAFKA_HOME/bin/kafka-console-consumer.sh" \
    --topic "$topic" --from-beginning \
    --bootstrap-server "$KAFKA_BOOTSTRAP" \
    --property print.key=true --property key.separator=$'\t'
}

produce_one() {
  local topic="${1:?usage: kafka.sh produce <topic> <key> <value>}"
  local key="${2:-}"
  local value="${3:?usage: kafka.sh produce <topic> <key> <value>}"
  printf '%s\t%s\n' "$key" "$value" | "$KAFKA_HOME/bin/kafka-console-producer.sh" \
    --topic "$topic" --bootstrap-server "$KAFKA_BOOTSTRAP" \
    --property parse.key=true --property key.separator=$'\t'
  ok "produced to ${topic}"
}

report() {
  cat <<EOF

Kafka broker is up on ${KAFKA_BOOTSTRAP}

  Kafka is OBSERVATION-ONLY: the Director publishes proposed/decided/observation
  events here for visibility and monitoring. Nothing consumes these topics, so
  lag is expected and benign. Slack is delivered DIRECTLY from msrouter TS
  (SlackSurface -> Slack Web API outbound, SlackPoller <- conversations.history
  inbound); Kafka is not in the Slack path.

  Topics:
    director-events     - Director observation/event stream (director -> Kafka, monitoring only)
    director-slack-raw  - legacy/unused (old Kafka-based Slack pipeline, replaced by the in-process SlackPoller)

  Tail:    scripts/kafka.sh tail director-events
  Produce: scripts/kafka.sh produce director-events test-key '{"kind":"test"}'
  Status:  scripts/kafka.sh status

EOF
}

monitor() {
  if ! is_running; then
    log "kafka not running; skipping monitor"
    return 0
  fi
  log "tailing director-events (Ctrl-C to stop)"
  exec "$KAFKA_HOME/bin/kafka-console-consumer.sh" \
    --topic director-events --from-beginning \
    --bootstrap-server "$KAFKA_BOOTSTRAP" \
    --property print.key=true --property key.separator=$'\t'
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  [[ -d "$KAFKA_HOME" ]] || die "KAFKA_HOME not found: $KAFKA_HOME. Download Kafka first."
  [[ -f "$KAFKA_HOME/bin/kafka-server-start.sh" ]] || die "Kafka scripts not found in $KAFKA_HOME/bin"

  case "${1:-status}" in
    start)   start; create_topics; report ;;
    start-or-init)  start_or_init; create_topics; report ;;
    stop)    stop ;;
    restart) stop; sleep 2; start; create_topics; report ;;
    status)  status ;;
    topics)  create_topics ;;
    monitor) monitor ;;
    tail)    shift; tail_topic "$@" ;;
    produce) shift; produce_one "$@" ;;
    *) die "unknown: $1 (use: start | start-or-init | stop | restart | status | topics | monitor | tail <topic> | produce <topic> <key> <value>)" ;;
  esac
fi
