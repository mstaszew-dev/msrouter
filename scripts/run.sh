#!/usr/bin/env bash
#
# scripts/run.sh - bring up the msrouter gateway (+ optional worker).
#
#   scripts/run.sh            # gateway only, dev mode (tsx watch)
#   scripts/run.sh prod       # build + run gateway (compiled)
#   scripts/run.sh worker     # start the scheduled agent worker
#   scripts/run.sh chrome     # launch Chrome with remote debugging for the browser tool
#   scripts/run.sh down       # stop gateway + worker started by this script
#
# See .env.example for configuration. Defaults are dev-only.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"

log()  { printf '\033[1;34m[run]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; exit 1; }

mkdir -p .run

# Chrome CDP for the agent's browser tool.
start_chrome() {
  log "starting Chrome with remote debugging on :9222"
  nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 \
    --user-data-dir="$HOME/.playwright-chrome" \
    --no-first-run --no-default-browser-check \
    >/tmp/msrouter-chrome.log 2>&1 &
  ok "chrome pid $!"
}

ensure_gateway_not_running() {
  if [[ -f .run/gateway.pid ]] && kill -0 "$(cat .run/gateway.pid)" 2>/dev/null; then
    die "gateway already running (pid $(cat .run/gateway.pid))"
  fi
}

start_gateway_dev() {
  ensure_gateway_not_running
  log "installing deps (if needed)"
  [[ -d node_modules ]] || npm install
  log "starting gateway in dev mode (tsx)"
  nohup npx tsx src/main.ts > .run/gateway.log 2>&1 &
  echo $! > .run/gateway.pid
  ok "gateway pid $(cat .run/gateway.pid)"
}

start_gateway_prod() {
  ensure_gateway_not_running
  log "installing deps"
  npm install
  log "building"
  npm run build
  nohup node dist/main.js > .run/gateway.log 2>&1 &
  echo $! > .run/gateway.pid
  ok "gateway pid $(cat .run/gateway.pid)"
}

start_worker() {
  [[ -d node_modules ]] || npm install
  npm run build
  nohup node dist/worker.js > .run/worker.log 2>&1 &
  echo $! > .run/worker.pid
  ok "worker pid $(cat .run/worker.pid)"
}

down() {
  for name in gateway worker; do
    if [[ -f .run/$name.pid ]] && kill -0 "$(cat .run/$name.pid)" 2>/dev/null; then
      kill "$(cat .run/$name.pid)" && ok "stopped $name"
    fi
    rm -f .run/$name.pid
  done
}

wait_ready() {
  local port="${PORT:-8787}"
  log "waiting for gateway on :${port}"
  for _ in $(seq 1 20); do
    if curl -sf "http://localhost:${port}/health/live" >/dev/null 2>&1; then
      ok "gateway ready"; return 0
    fi
    sleep 1
  done
  echo "--- gateway log ---" >&2
  tail -n 30 .run/gateway.log >&2 || true
  die "gateway did not become ready in 20s"
}


report() {
  local port="${PORT:-8787}"
  cat <<EOF

msrouter gateway is up on http://localhost:${port}

  OpenRouter-compatible endpoint:
    POST http://localhost:${port}/api/v1/chat/completions
    GET  http://localhost:${port}/api/v1/models
  Health: http://localhost:${port}/health/live

  Point any OpenAI/OpenRouter SDK at this base URL (no key needed unless
  GATEWAY_TOKEN is set). Send "model": "mst/free" to walk every provider
  (OpenRouter keys -> OpenAI -> ZAI -> OpenCode/BigPickle) with each provider's
  own default model.

  Example:
    curl -s http://localhost:${port}/api/v1/chat/completions \\
      -H 'content-type: application/json' \\
      -d '{"model":"mst/free","messages":[{"role":"user","content":"say hi"}]}'

  Logs:    scripts/run.sh logs gateway
  Stop:    scripts/run.sh down
EOF
}

case "${1:-dev}" in
  dev|"")  start_gateway_dev; wait_ready; report ;;
  prod)    start_gateway_prod; wait_ready; report ;;
  worker)  start_worker; ok "worker started" ;;
  chrome)  start_chrome ;;
  down)    down ;;
  logs)    LOGFILE=".run/${2:-gateway}.log"; [[ -f "$LOGFILE" ]] || die "no log for ${2:-gateway}"; exec tail -F "$LOGFILE" ;;
  *) die "unknown command: $1 (use: dev | prod | worker | chrome | logs <name> | down)" ;;
esac
