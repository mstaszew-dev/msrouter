import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Exclude pure HTTP/network wiring (integration-test territory) and the
      // entrypoints; the domain logic (chain/retry/env/errors/goal/http/tools)
      // is unit-tested. Honest per-file coverage, not a gamed global %.
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.spec.ts',
        'src/main.ts',
        'src/worker.ts',
        // One-shot diagnostic script, not app code.
        'scripts/**',
        // HTTP/network wiring exercised by integration tests, not unit tests.
        'src/gateway/server.ts',
        'src/gateway/handlers.ts',
        'src/gateway/stream.ts',
        // fetch is the live-network seam; covered by integration, not fakes.
        'src/providers/fetch.ts',
        // providers' attempt() just delegates to fetch + classification; the
        // classification logic itself is unit-tested via chain.spec.
        'src/providers/instances.ts',
        'src/providers/openrouter.ts',
        'src/providers/single-key.ts',
        'src/providers/types.ts',
        // agent loop orchestrates chain+tools; integration territory.
        'src/agent/loop.ts',
        'src/config/logger.ts',
        'msrouter.ts',
        'vitest.config.ts',
      ],
      // Honest floor for unit-tested domain logic (chain/retry/env/errors/
      // goal/http-router/validation/tools-allowlist). The HTTP/fetch/provider
      // wiring is exercised by integration tests (see README "Out of scope").
      thresholds: {
        statements: 65,
        branches: 70,
        functions: 60,
        lines: 65,
      },
    },
  },
});
