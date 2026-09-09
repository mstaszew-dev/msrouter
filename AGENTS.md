# AGENTS.md - msrouter

Local OpenAI-compatible LLM gateway + campaign Director (`127.0.0.1:8787`).

## Startup rule: always run the gateway in an iTerm tab

The gateway/director **must** be started in a **new iTerm2 tab** via:

```
cd /Users/mst/ZCodeProject/msrouter && ./scripts/run.sh dev
```

It refuses to start outside iTerm by design (`assertInIterm()` in `src/main.ts`
walks the process parent chain via ps and requires a LIVE iTerm2 ancestor -
inherited `TERM_PROGRAM` env is not accepted as proof, because it survives
nohup/detachment). Supervision depends on visible tabs. Never launch it from an agent shell, a script, or a non-iTerm terminal.

If it is down and you need it up:

1. Open an iTerm tab yourself and run the command above, or
2. Use osascript exactly as the Director does (`create tab with default
   profile` + `write text`) - this is the only sanctioned programmatic path.

Never `nohup`, never background it from a non-iTerm shell, never start a
second instance while one is listening on :8787 (`scripts/run.sh down` first).

## Layout

- `src/config/` - zod env schema (`env.ts`, 250-line module budget), providers
- `src/providers/` - chain + routing (openrouter pool, openai, zai, tokenrouter,
  opencode triples, opencodego, lmstudio, local)
- `src/director/` - campaign supervision: `loop.ts` (5-min ticks,
  `DIRECTOR_AUTOSTART`), `iterm.ts` (worker spawn), `classify.ts`
- `src/gateway/` - HTTP handlers (`/v1/chat/completions`, `/v1/models`, 10MB body cap)

## Conventions

- TDD, fresh-context review subagent before merge (rule `60-code-review-subagent`)
- Secrets live only in gitignored `.env`; `.env.example` carries names, empty values
- Direct tools, no MCP hop for internal calls (ADR `0003-direct-tools-no-mcp`)
- Conventional commits; push to `origin/master` after review
