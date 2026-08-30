/**
 * Vitest global setup: load a known-good env before any spec imports env().
 * Mirrors flosum's jest.setup pattern. Tests can override via loadEnv() in
 * individual specs when they need a different config.
 *
 * Integration tests (INTEGRATION=1) read live secrets from .env via dotenv so
 * real API keys are available without polluting the unit-test fixtures.
 */

import 'dotenv/config';

import { loadEnv } from '../src/config/env.js';

// Deterministic multi-model chain in tests regardless of any per-spec
// loadEnv() re-resolution (loadEnv re-reads process.env by default).
process.env['OPENROUTER_MODELS'] = 'vendor/extra';

if (process.env['INTEGRATION'] === '1') {
  // Live secrets from .env; production guard is skipped under NODE_ENV=test.
  loadEnv({ ...process.env, NODE_ENV: 'test', PORT: '8788', OPENROUTER_MODELS: 'vendor/extra' });
} else {
  loadEnv({
    NODE_ENV: 'test',
    PORT: '8788',
    OPENROUTER_KEY1: 'sk-or-test-key-1111',
    OPENROUTER_KEY2: 'sk-or-test-key-2222',
    OPENAI_API_KEY: 'sk-openai-test',
    ZAI_API_KEY: 'sk-zai-test',
    TOKENROUTER_API_KEY: 'sk-tokenrouter-test',
    // OpenCode pool: numbered keys (collected ascending, deduped). The chain
    // builds (model, key) triples from these, so two keys exercise the pool.
    OPENCODE_KEY1: 'sk-opencode-test-1',
    OPENCODE_KEY2: 'sk-opencode-test-2',
    FORCE_FREE: 'true',
    SCHEDULE_INTERVAL_MINUTES: '-1',
    UPSTREAM_TIMEOUT_MS: '5000',
    OPENROUTER_MODELS: 'vendor/extra',
  });
}
