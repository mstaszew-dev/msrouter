Feature: Security invariants
  As a gateway that proxies authenticated LLM calls
  I want to never rewrite client data and never allow arbitrary code execution
  So that the response the client receives is exactly what the upstream sent

  # 2026-10-03: the two scrubbing scenarios were deleted with scrubSecrets. It
  # ran on the SUCCESS path, so it rewrote real client data: the python campaign
  # agent received a JustJoin URL whose slug tail became "sk-[REDACTED]" and tried
  # to open the broken URL. This is a single-user local gateway; the client owns
  # its own secrets. See fetch.spec.ts "upstream responses are never rewritten".

  Scenario: Upstream bodies reach the client verbatim
    Given an upstream returns a completion body containing "sk-or-v1-deadbeef"
    When the client receives the response
    Then the body contains "sk-or-v1-deadbeef" unchanged
      and contains no "[REDACTED]" marker

  Scenario: A non-JSON upstream error body is returned verbatim
    Given an upstream returns HTML containing "sk-or-v1-deadbeef"
    When the client receives the error envelope
    Then the body contains "sk-or-v1-deadbeef" not "[REDACTED]"

  Scenario: Gateway token auth uses a constant-time compare
    Given GATEWAY_TOKEN is set
    When a client sends a wrong Authorization header
    Then the compare is not short-circuited on length or first byte
      and the response is 400 invalid gateway token

  Scenario: Idempotency cache is bounded
    Given 2000 distinct Idempotency-Key headers in one minute
    Then the cache holds at most IDEM_MAX_ENTRIES (1000) entries
      and the oldest entries are evicted

  Scenario: Terminal tool allowlist excludes code-execution primitives
    Given the default TERMINAL_ALLOWLIST
    Then "node", "npm", "find", "git", "bash", "sh", "python" are all rejected
      and only "ls,cat,echo,pwd,head,tail,grep" are permitted

  Scenario: Every upstream call has a timeout
    Given a provider is called
    Then an AbortController fires after UPSTREAM_TIMEOUT_MS
      and a hung upstream is classified TRANSIENT (not OK)
