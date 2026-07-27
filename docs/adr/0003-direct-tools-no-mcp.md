# ADR 0003: Direct tools, no MCP SDK

- Status: Accepted
- Date: 2026-07-26

## Context
The scheduled agent needs tool use (terminal, browser). joblooper already drives the browser over CDP directly and the OpenCode env launches playwright-mcp as an external process; there is no in-process `@modelcontextprotocol/sdk` precedent in this user's code.

## Decision
Implement tools directly in TypeScript:
- `terminal`: `child_process.execFile` with a strict executable allowlist (`TERMINAL_ALLOWLIST`) + timeout.
- `browser_navigate`: `playwright-core` `connectOverCDP(CDP_URL)` (lazy-imported so the gateway runs without playwright installed).

No `@modelcontextprotocol/sdk` dependency.

## Consequences
- Simpler, fewer deps, matches joblooper's proven pattern.
- Not generalizable to arbitrary MCP servers (acceptable for this scope).
- Playwright is an optional dependency; the browser tool fails gracefully if absent.
