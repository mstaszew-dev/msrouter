# ADR 0002: Provider chain + mst/free alias

- Status: Accepted
- Date: 2026-07-26

## Context
msrouter pools OpenRouter free-model keys and must also reach OpenAI, ZAI (GLM), and OpenCode Zen (BigPickle) directly. We need a clear rule for which provider serves a request.

## Decision
- An explicit model-id prefix short-circuits to one provider: `openai/`, `glm-`/`zai/`, `opencode/`.
- Otherwise the request walks a fallback chain: OpenRouter key pool -> OpenAI -> ZAI -> OpenCode.
- The alias `mst/free` (configurable via `WALK_ALIAS`) means "walk every provider with each provider's OWN configured default model" (`OPENROUTER_MODEL`, `OPENAI_MODEL`, `ZAI_MODEL`, `OPENCODE_MODEL`). This lets a client say "give me the best available, I don't care which" without naming a model each provider hosts.

## Result classification
- `OK` -> return/stream, stop.
- `KEY_FAILURE` (401/402/429) -> rotate to the next key/provider.
- `TRANSIENT` (408/502/503) -> backoff + retry the same provider.
- `BAD_REQUEST` (400/422/403) -> reject, do not rotate (client error).

## Consequences
- Adding a provider = one env block + one chain entry.
- The alias is the recommended way to maximize success rate across free tiers.
