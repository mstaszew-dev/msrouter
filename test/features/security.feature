Feature: Security invariants
  As a gateway that proxies authenticated LLM calls
  I want to never leak secrets and never allow arbitrary code execution
  So that logs and error bodies stay safe

  Scenario: API keys are never written to logs
    Given an upstream error body echoes the request key as "Bearer sk-or-v1-..."
    When the gateway logs the failure
    Then the log line contains "sk-[REDACTED]" and not the raw key
      and it contains "Bearer [REDACTED]" and not the raw token

  Scenario: A non-JSON upstream error body is scrubbed before being returned
    Given an upstream returns HTML containing "sk-or-v1-deadbeef"
    When the client receives the error envelope
    Then the body contains "sk-[REDACTED]" not "sk-or-v1-deadbeef"

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
