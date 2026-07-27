# ADR 0001: OpenRouter-compatible gateway surface

- Status: Accepted
- Date: 2026-07-26

## Context
msrouter must be usable from any existing OpenAI/OpenRouter client unchanged. The simplest contract that achieves this is the OpenRouter/OpenAI REST surface.

## Decision
Expose exactly:
- `POST /api/v1/chat/completions` (OpenAI-compatible body incl. `stream`)
- `GET /api/v1/models`
- `GET /health/live` and `/health/ready`

Clients point their base URL at `http://localhost:<port>/api/v1`. Streaming uses SSE pass-through (`text/event-stream`, `data:` chunks, `[DONE]`).

## Consequences
- Any OpenAI/OpenRouter SDK works with no code change.
- We must faithfully proxy `choices[].message` (non-stream) and `choices[].delta` (stream), and terminate streams with `[DONE]`.
