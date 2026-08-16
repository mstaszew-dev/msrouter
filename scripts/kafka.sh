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
KAFKA_BOOTSTRAP="${KAFKA_BOOTSTRAP:-localhost:9092}"
PIDFILE=".run/kafka.pid"

mkdir -p .run

log()  { printf '\033[1;34m[kafka]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d "$KAFKA_HOME" ]] || die "KAFKA_HOME not found: $KAFKA_HOME. Download Kafka first."
[[ -f "$KAFKA_HOME/bin/kafka-server-start.sh" ]] || die "Kafka scripts not found in $KAFKA_HOME/bin"

is_running() {
  [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

start() {
  if is_running; then die "Kafka already running (pid $(cat "$PIDFILE"))"; fi
  log "starting Kafka broker in KRaft mode"
  nohup "$KAFKA_HOME/bin/kafka-server-start.sh" \
    "$KAFKA_HOME/config/kraft/server.properties" \
    > .run/kafka.log 2>&1 &
  echo $! > "$PIDFILE"
  ok "kafka pid $(cat "$PIDFILE")"

  log "waiting for broker on ${KAFKA_BOOTSTRAP}"
  for i in $(seq 1 20); do
    if "$KAFKA_HOME/bin/kafka-topics.sh" --bootstrap-server "$KAFKA_BOOTSTRAP" --list >/dev/null 2>&1; then
      ok "broker ready"
      return 0
    fi
    sleep 1
  done
  echo "--- kafka log ---" >&2
  tail -n 20 .run/kafka.log >&2 || true
  die "broker did not become ready in 20s"
}

stop() {
  if is_running; then
    kill "$(cat "$PIDFILE")" && ok "stopped kafka (pid $(cat "$PIDFILE"))"
  else
    log "kafka not running"
  fi
  rm -f "$PIDFILE"
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
  local topics="$KAFKA_HOME/bin/kafka-topics.sh --bootstrap-server $KAFKA_BOOTSTRAP --list 2>/dev/null"
  for topic in $(eval "$topics"); do
    if [ -n "$topic" ]; then
      log "first 5 messages for ${topic}:"
      "$KAFKA_HOME/bin/kafka-console-consumer.sh" \
        --topic "$topic" --from-beginning \
        --bootstrap-server "$KAFKA_BOOTSTRAP" \
        --property print.key=true --property key.separator=$'\t' \
        --max-messages 5 --timeout-ms 3000 2>/dev/null || log "  (no messages or error)"
    fi
  done
  ok "monitor complete"
}

case "${1:-status}" in
  start)   start; create_topics; report ;;
  stop)    stop ;;
  restart) stop; sleep 2; start; create_topics; report ;;
  status)  status ;;
  topics)  create_topics ;;
  monitor) monitor ;;
  tail)    shift; tail_topic "$@" ;;
  produce) shift; produce_one "$@" ;;
  *) die "unknown: $1 (use: start | stop | restart | status | topics | monitor | tail <topic> | produce <topic> <key> <value>)" ;;
esac
