#!/usr/bin/env bash
# start-msrouter.sh: Launch the full msrouter pipeline in iTerm2 tabs.
#   Tab 1: Kafka broker (KRaft mode, no Zookeeper)
#   Tab 2: Gateway (msrouter OpenRouter proxy)
#   Tab 3: Job campaign + Director (poller + sender + director all in one)
#   Tab 4: Kafka events tail (visibility)

set -euo pipefail

cd /Users/mst/ZCodeProject/msrouter

osascript <<'ASCRIPT'
tell application "iTerm2"
  if (count of windows) = 0 then create window with default profile

  tell current window

    # --- Tab 1: Kafka broker ---
    set t1 to (create tab with default profile)
    tell current session of t1
      write text "cd /Users/mst/ZCodeProject/msrouter; clear; echo KAFKA KRaft; ./scripts/kafka.sh start; tail -f .run/kafka.log"
    end tell

    # --- Tab 2: Router gateway ---
    set t2 to (create tab with default profile)
    tell current session of t2
      write text "cd /Users/mst/ZCodeProject/msrouter; clear; echo ROUTER GATEWAY; scripts/run.sh dev"
    end tell

    # --- Tab 3: Director + Poller + Sender ---
    set t3 to (create tab with default profile)
    tell current session of t3
      write text "cd /Users/mst/ZCodeProject/msrouter; clear; echo DIRECTOR + POLLER + SENDER; npx tsx src/director-kafka-poller.ts & npx tsx src/director-slack-sender.ts & sleep 3; KAFKA_ENABLED=true npx tsx src/director-worker.ts; wait"
    end tell

    # --- Tab 4: Kafka events tail (visibility) ---
    set t4 to (create tab with default profile)
    tell current session of t4
      write text "cd /Users/mst/ZCodeProject/msrouter; clear; echo EVENTS; ./scripts/kafka.sh tail director-events"
    end tell

  end tell
end tell
ASCRIPT

echo "Tabs created. Wait 20s for all processes to start..."
sleep 20

echo ""
echo "=== Pipeline ==="
for p in "kafka broker" "msrouter gateway" "slack poller" "slack sender" "director worker" "campaign agent"; do
  case "$p" in
    "kafka broker")     pat="kafka\.Kafka";;
    "msrouter gateway") pat="main.ts";;
    "slack poller")     pat="director-kafka-poller";;
    "slack sender")     pat="director-slack-sender";;
    "director worker")  pat="director-worker";;
    "campaign agent")   pat="openclaw-agent";;
  esac
  pid=$(ps aux | grep "$pat" | grep -v grep | awk 'NR==1{print $2}')
  if [ -n "$pid" ]; then
    echo "  $p: PID $pid OK"
  else
    echo "  $p: starting..."
  fi
done
