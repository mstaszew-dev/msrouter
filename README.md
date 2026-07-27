# msrouter

A local, **OpenRouter-compatible gateway** written in TypeScript/Node.js. Point
any OpenAI/OpenRouter client at `http://localhost:8787/api/v1` and it routes
your request across a pool of OpenRouter free-model keys, falling back to
OpenAI, ZAI (GLM), and OpenCode Zen (BigPickle). Ships with a separate scheduled
agent worker that drives a prompt+goal loop using direct terminal + browser
tools.

## What it does

- **Gateway** (`POST /api/v1/chat/completions`, `GET /api/v1/models`): an
  OpenAI-compatible proxy. Pools `OPENROUTER_KEY1..N`, rotates keys on
  per-key failure (401/402/429), then walks a fallback chain: OpenAI -> ZAI ->
  OpenCode Zen (BigPickle). SSE streaming is passed through unchanged.
- **Alias `mst/free`**: send `model: "mst/free"` to walk **every** provider,
  each using its own configured default model. Maximize the success rate across
  free tiers without naming a model each provider hosts.
- **Short-circuit by `direct:` prefix**: `direct:openai/*`, `direct:glm-*` /
  `direct:zai/*`, `direct:opencode/*` pin a single provider. (Bare `openai/*`
  etc. are treated as OpenRouter vendor/model ids and go through the default
  chain.)
- **Scheduled agent** (`src/worker.ts`): runs every
  `SCHEDULE_INTERVAL_MINUTES` (`-1` disables), using terminal
  (`child_process` + allowlist) and browser (`playwright-core` over CDP) tools.

## Quick start

```bash
cp .env.example .env            # fill in your keys
scripts/run.sh                  # gateway, dev mode
# or:
scripts/run.sh prod             # build + run compiled
scripts/run.sh worker           # start the scheduled agent
scripts/run.sh chrome           # launch Chrome w/ remote debugging (for the browser tool)
scripts/run.sh down             # stop gateway + worker
```

Smoke:

```bash
curl -s http://localhost:8787/api/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mst/free","messages":[{"role":"user","content":"say hi"}]}'
```

Point an OpenAI SDK at it:

```python
client = OpenAI(base_url="http://localhost:8787/api/v1", api_key="anything")
client.chat.completions.create(model="mst/free", messages=[{"role":"user","content":"hi"}])
```

## Provider chain

| Requested model       | Behavior                                                        |
| --------------------- | --------------------------------------------------------------- |
| `mst/free`            | Walk every OpenRouter key, then OpenAI, ZAI, OpenCode (per-provider defaults) |
| `direct:openai/<id>`  | OpenAI only                                                     |
| `direct:glm-*` / `direct:zai/*` | ZAI only                                                        |
| `direct:opencode/<id>` | OpenCode Zen only                                              |
| `openai/gpt-4o-mini`  | OpenRouter model (vendor/model id) -> default chain             |
| any other             | OpenRouter pool (model + `:free` if `FORCE_FREE`), then OpenAI -> ZAI -> OpenCode |

> **Why `direct:`?** OpenRouter uses `vendor/model` ids (`openai/gpt-4o`,
> `google/gemma-...`). A bare `openai/...` is therefore an OpenRouter model, not
> a provider pin. The `direct:` namespace disambiguates "force this fallback
> provider" from "use this OpenRouter-hosted model".

Result classification: `KEY_FAILURE` (401/402/429) rotates; `TRANSIENT`
(408/502/503) retries with backoff; `BAD_REQUEST` (400/422) rejects.

## Configuration

All config is validated via zod at boot. See [`.env.example`](.env.example) for
every variable. Key ones:

- `OPENROUTER_KEY1..N` / `OPENROUTER_API_KEY` - the key pool.
- `OPENAI_API_KEY`, `ZAI_API_KEY`, `OPENCODE_API_KEY` - fallback providers.
- `OPENROUTER_MODEL`, `OPENAI_MODEL`, `ZAI_MODEL`, `OPENCODE_MODEL` - per-provider defaults for the alias.
- `WALK_ALIAS` - the model id(s) that mean "walk all" (default `mst/free`).
- `FORCE_FREE=true` - append `:free` to OpenRouter models.
- `UPSTREAM_TIMEOUT_MS`, `MAX_TRANSIENT_RETRIES` - upstream call behavior.
- `SCHEDULE_INTERVAL_MINUTES`, `AGENT_PROMPT`, `AGENT_GOAL`, `AGENT_MAX_STEPS` - the scheduled agent.
- `CDP_URL`, `TERMINAL_ALLOWLIST` - agent tools.
- `LOG_LEVEL`, `LOG_REDACT` - structured logging with secret redaction.

## Project layout

```
src/
  config/     env (zod), pino logger
  common/     errors, http router, retry predicates
  providers/  types, openrouter (pool), single-key, openai/zai/opencode, chain
  gateway/    server (node:http), handlers, sse stream, validation
  agent/      loop, tools (terminal/browser), goal detection
  main.ts     gateway entrypoint
  worker.ts   scheduler entrypoint
docs/adr/     0001 gateway surface, 0002 chain+alias, 0003 direct tools, 0004 scheduling
```

## Quality gates

- TypeScript `strict` + `noUncheckedIndexedAccess`; zod at boundaries.
- `AbortController` + timeout on every upstream call; SSE streamed, never buffered.
- Secrets only from env; `LOG_REDACT` redacts `openrouter_key`, api keys, `authorization`.
- vitest specs cover the chain logic (alias walk, short-circuit, all-fail),
  retry predicates, env parsing, and tool allowlisting.
- SIGTERM graceful shutdown on both processes.

## Out of scope (documented)

- No persistent key-quota tracking across restarts (in-memory rotation only).
- Single `GATEWAY_TOKEN` for local client auth (not multi-tenant).
- LLM-judge for goal-met detection is off by default (cheap heuristic first).

## License

MIT.
