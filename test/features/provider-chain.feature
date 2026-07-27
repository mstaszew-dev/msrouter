Feature: Provider chain failover
  As a local OpenRouter-compatible gateway
  I want to fall back across providers when one fails
  So that a free-model request succeeds even when a key is rate-limited

  Background:
    Given the gateway is configured with an OpenRouter pool of N keys
      and optional OpenAI / ZAI / OpenCode fallbacks
      and FORCE_FREE is "true"

  # --- Alias walk (mst/free) ---
  Scenario: Alias walks every provider with each one's default model
    Given a client sends a chat completion with model "mst/free"
    Then the gateway tries every OpenRouter key (each with OPENROUTER_MODEL,
      default "openrouter/free" - OpenRouter's own auto-router, which handles
      upstream free-model failover internally)
      and if all OpenRouter keys fail it tries OpenAI with OPENAI_MODEL
      and then ZAI with ZAI_MODEL
      and then OpenCode Zen with OPENCODE_MODEL
      and returns the first successful response

  Scenario: Alias short-circuits on the first OpenRouter key that succeeds
    Given OpenRouter key 1 returns 200 OK
    Then no fallback provider is contacted

  Scenario: Alias fails with 502 only when every provider fails
    Given every OpenRouter key returns 429
      and OpenAI returns 401
      and ZAI is not configured
      and OpenCode returns 500
    Then the gateway responds 502 NoProviderAvailable

  # --- Explicit model with prefix short-circuit (direct: namespace) ---
  # NOTE: bare "openai/gpt-4o" is an OpenRouter model id (vendor/model), NOT a
  # provider pin. To force a specific fallback provider, use the "direct:"
  # namespace so there is no collision with OpenRouter's vendor ids.
  Scenario Outline: direct: prefix pins a single provider
    Given a client sends model "<model>"
    Then only the "<provider>" provider is contacted
      and no other provider is tried

    Examples:
      | model                     | provider   |
      | direct:openai/gpt-4o-mini | openai     |
      | direct:opencode/big-pickle| opencode   |
      | direct:zai/glm-4.6        | zai        |
      | direct:glm-4.6            | zai        |

  Scenario: A bare vendor/model id goes through the default chain (OpenRouter)
    Given a client sends model "openai/gpt-4o-mini"
    Then OpenRouter is contacted first (it is an OpenRouter model id)
      and the OpenAI provider is NOT short-circuited

  # --- Explicit model, no prefix (default chain) ---
  Scenario: Explicit model tries OpenRouter pool first then fallbacks
    Given a client sends model "openrouter/free"
    Then OpenRouter is called with "openrouter/free" (NOT suffixed; it is a meta-router)
      and on pool exhaustion the same model is sent to OpenAI, ZAI, OpenCode

  # --- Status classification drives the policy ---
  Scenario Outline: Upstream status maps to a chain action
    Given an upstream returns status <status>
    Then the chain performs <action>

    Examples:
      | status | action                                   |
      | 200    | return                                   |
      | 401    | rotate to next key/provider              |
      | 402    | rotate to next key/provider              |
      | 403    | rotate to next key/provider              |
      | 429    | rotate to next key/provider (NOT retry)  |
      | 408    | backoff + retry same provider            |
      | 500    | backoff + retry same provider            |
      | 502    | backoff + retry same provider            |
      | 503    | backoff + retry same provider            |
      | 400    | reject immediately (BAD_REQUEST)         |
      | 422    | reject immediately (BAD_REQUEST)         |
