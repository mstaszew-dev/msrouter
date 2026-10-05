# msrouter

A local LLM routing gateway: one OpenAI-compatible API over a failover chain of
free-tier providers, plus an observe-only Director that watches the job-search
campaign agent, surfaces it to Slack, and rotates the VPN IP. Everything runs on
this machine; nothing leaves it except upstream LLM calls.

## The chain (2026-10-05)

Requests with `model: "mst/free"` (or `free`) walk every provider with its own
default model, in this order, demoting failures to the back and parking
rate-limited entries for a cooldown:

1. **OpenRouter pool** - 15 keys x `openrouter/free` (the free auto-router,
   0-cost, 50 req/day per key, 1000 once the account holds $10 of credits)
   - no extra models (`OPENROUTER_MODELS` is empty): the `stealth/` namespace
     is no longer listed upstream. `stealth/space-bunny-alpha` 404s "No
     endpoints found"; `stealth/union-alpha` had already graduated to
     `unbiased/pareto`, which is **paid** (~$2.50 / $7.50 per M tokens), so it
     is deliberately not a chain entry.
2. **ZAI** - GLM coding plan, `glm-5.3-flash` on `api.z.ai/api/coding/paas/v4`
3. **TokenRouter** - `z-ai/glm-5.3-free`
4. **OpenCodeGo** - `glm-5.3-flash` on `/zen/go/v1` (monthly-capped)
5. **Extras** - UnoRouter (`glm-5.3-flash:free` + CSV models), Groq
   (`openai/gpt-oss-120b` + CSV), Mistral (`mistral-small-latest` + CSV),
   Cloudflare Workers AI (4 models). SambaNova is retired: every model 402s
   without a payment method.
6. **Local tail** - laptop tailnet Ollama `qwen35-2b-64k` (context guard 100K,
   30-min timeout; ABSOLUTE LAST). LM Studio and the llama-server local slot are
   parked (disabled flags); the tail is always reachable.

The OpenCode `/zen/v1` free pool was removed: every model 403s
`FreeTierError` ("free tier can only be used from within OpenCode") for
non-OpenCode clients, so it can never serve this gateway.

## Direct pinning

`model: "direct:<provider>/<model>"` pins a single provider, no fallback:

```
direct:openrouter/<model>     direct:zai/<model>          direct:groq/<model>
direct:opencodego/<model>     direct:tokenrouter/<model>  direct:unorouter/<model>
direct:mistral/<model>        direct:cloudflare/<model>   direct:sambanova/<model>
direct:local/<model>          direct:lmstudio/<model>     direct:laptop/<model>
```

`direct:zai/glm-...` and `direct:glm-...` strip/alias the ZAI prefix;
`direct:openrouter/<model>` applies the FORCE_FREE `:free` rewrite except for
the `stealth/` namespace, which is passed through unsuffixed. That namespace is
no longer listed upstream, so the rule is defensive only.

## Run

```
./scripts/run.sh dev       # gateway, dev mode (tsx watch); MUST run inside iTerm
./scripts/run.sh prod      # build + run compiled
./scripts/run.sh down      # stop it
./scripts/run.sh chrome    # Chrome with CDP 9222 (campaign browser)
npx tsx scripts/check-env.ts   # what the chain will actually route to
```

The gateway refuses to start outside iTerm by design (supervision depends on
visible tabs; see AGENTS.md).

## Surfaces

- `POST /v1/chat/completions` (+ `/api/v1` alias) - OpenAI-compatible,
  streaming via SSE. `X-Served-By-Provider` / `X-Served-By-Model` on every OK.
- `GET /v1/models` - the configured models (walk aliases, per-provider
  defaults, extras CSV models).
- `GET /health/live`, `GET /health/ready`.
- Read-only GraphQL at `/graphql` (`models`, `completion` demo).
- Admin API (`src/admin/`, JWT, SQL console over the Director ledger) + React
  console in `web/` (`npm run web:dev`, demo/viewer accounts via
  `npm run seed:users`).

## The Director (fully opt-in)

The Director - observation, Slack mirroring, Proton VPN rotation, worker
supervision - is DISABLED by default (`DIRECTOR_INTERVAL_MINUTES=-1`,
`VPN_ROTATION_INTERVAL_MINUTES=0`, no Slack token, `DIRECTOR_AUTOSTART=false`,
`KAFKA_ENABLED=false`). The gateway boots as a pure LLM router. To turn the
supervisor back on: set `DIRECTOR_INTERVAL_MINUTES>=1`, provide the Slack vars,
and optionally `VPN_ROTATION_INTERVAL_MINUTES=30`; in that mode it observes
`/Users/mst/Downloads/job-search/job-apply`, classifies ticks, keeps a ledger,
drafts read-only proposals, applies approved patches to
`~/.campaign-agent/director-overrides.env`, keeps Chrome CDP alive, and never
spawns/kills/restarts the campaign worker unless `DIRECTOR_AUTOSTART=true`.
Kafka (`scripts/kafka.sh`, port 19092) stays dormant.

## Configuration

Everything is env-driven (`.env`; see `.env.example` for the annotated
template). The load-bearing groups:

- OpenRouter: `OPENROUTER_KEY1..N`, `OPENROUTER_MODEL`, `OPENROUTER_MODELS` (CSV),
  `FORCE_FREE`.
- Single-key providers (incl. `ZAI_*`, `TOKENROUTER_*`, `OPENCODEGO_*` and the
  2026-09-18 extras `UNOROUTER_*/GROQ_*/SAMBANOVA_*/MISTRAL_*/CLOUDFLARE_*`):
  each joins the walk when key AND model are set; an empty model var retires
  the slot; `<PROVIDER>_MODELS` CSV adds models per provider.
- Locals: `LOCAL_*` (parked), `LMSTUDIO_*` (parked, port 1235), `LAPTOP_*`
  (active tail).
- Walk behavior: `WALK_ALIAS`, `WALK_DEADLINE_MS` (300s), `UPSTREAM_TIMEOUT_MS`
  (60s), `RATE_LIMIT_COOLDOWN_MS`, `SUCCESS_DEMOTE_LIMIT`.
- Director: `DIRECTOR_INTERVAL_MINUTES`, `DIRECTOR_AUTOSTART`,
  `STALE_THRESHOLD_MINUTES`, `VPN_ROTATION_INTERVAL_MINUTES`,
  `DIRECTOR_OVERRIDES` (`~` expanded), `DIRECTOR_RUNNER` (python campaign
  agent), Slack vars.

Timeout stack, sized additively: walk deadline 300s + LM Studio first try
300s + laptop 1800s = 2400s, which is exactly the python campaign agent's
`TIMEOUT_SECONDS` (its hard deadline is 2520s).

## Layout

```
src/gateway/     OpenAI-compatible surface, model list, SSE, validation
src/providers/   chain, rotation queue, per-provider adapters, extras
src/director/    observe-only supervisor (loop, classify, vpn, slack, ledger)
src/admin/       JWT admin API (SQL console, observability)
src/config/      zod env schema (single-key fields in single-key-env.ts)
web/             React console (own vitest config)
scripts/         run.sh, check-env.ts, kafka.sh (dormant), seed-users.ts
docs/adr/        architecture decision records
```

## Out of scope

- Multi-tenant anything: this is a single-user, single-machine gateway.
- Queueing/persistence of requests: a failed walk fails the request; the
  adaptive rotation (demote + 429 parking) is the whole availability story.
- Byzantine provider selection: env-declared order + failure demotion, nothing
  model-aware beyond `openrouter/free` upstream.

`LOG_REDACT` (CSV of secret field names) redacts those keys in log objects. It
does **not** scrub substrings out of upstream bodies: that was removed on
2026-10-03 because it ran on the success path and rewrote real client data (a
JustJoin slug containing "sk-" came back to the agent as "sk-[REDACTED]"). On
this single-user local gateway the client owns its secrets.
