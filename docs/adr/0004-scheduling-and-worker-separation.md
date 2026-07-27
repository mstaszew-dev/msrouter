# ADR 0004: Scheduling + worker separation

- Status: Accepted
- Date: 2026-07-26

## Context
The agent runner is long-running and must not block the gateway HTTP process (NODEJS_CODE_REVIEW.md section 6 BLOCKER).

## Decision
- Two processes: `main.ts` (gateway) and `worker.ts` (scheduler).
- The worker uses `setInterval` at `SCHEDULE_INTERVAL_MINUTES` (`-1` disables).
- Each tick runs the agent loop once; a shared `AbortController` is aborted on SIGTERM so an in-flight run drains and the process exits within ~2s.

## Consequences
- Run them independently: `npm start` (gateway) and `npm run worker`.
- A crash in the agent does not take down the gateway.
