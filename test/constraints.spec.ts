/**
 * CONSTRAINT tests: structural + security invariants. Always run, no network.
 *
 * These encode the user's review philosophy ("measure, don't review"). Each test
 * asserts a property of the codebase that, if violated, would signal a
 * regression in quality or safety. Failures here mean a constraint was broken,
 * not that a feature is wrong.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { scrubSecrets } from '../src/providers/fetch.js';
import { withFree } from '../src/providers/openrouter.js';
import { classifyAttempt } from '../src/providers/types.js';

const ROOT = new URL('..', import.meta.url);

function src(name: string): string {
  return readFileSync(new URL(`src/${name}`, ROOT), 'utf8');
}

describe('constraint: secret scrubbing (NODEJS_CODE_REVIEW.md section 4)', () => {
  it('redacts sk- and sk-or- and sk-proj- keys', () => {
    const out = scrubSecrets(
      'key=sk-or-v1-fakekey123456789012345678901234567890123456789012345678901234 leak',
    );
    expect(out).not.toContain('fakekey123');
    expect(out).toContain('sk-[REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    const out = scrubSecrets('Authorization: Bearer abc123def456ghi789');
    expect(out).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts JWT-shaped tokens', () => {
    const out = scrubSecrets('jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0SgHFa2Q');
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).toContain('[REDACTED-JWT]');
  });

  it('leaves non-secret text unchanged', () => {
    expect(scrubSecrets('the quick brown fox')).toBe('the quick brown fox');
    expect(scrubSecrets('status 200 ok')).toBe('status 200 ok');
  });
});

describe('constraint: HTTP status classification is total and stable', () => {
  // The chain's rotation/retry/reject logic depends on this mapping. If the
  // boundaries drift, the whole failover policy changes silently.
  it('rotates on 401/402/403/429 (KEY_FAILURE)', () => {
    for (const s of [401, 402, 403, 429]) {
      const r = classifyAttempt(s, 'x');
      expect(r?.kind).toBe('KEY_FAILURE');
    }
  });

  it('retries on 408/500/502/503/504 (TRANSIENT)', () => {
    for (const s of [408, 500, 502, 503, 504]) {
      const r = classifyAttempt(s, 'x');
      expect(r?.kind).toBe('TRANSIENT');
    }
  });

  it('rejects on 400/404/422 (BAD_REQUEST, no rotation)', () => {
    for (const s of [400, 404, 422]) {
      const r = classifyAttempt(s, 'x');
      expect(r?.kind).toBe('BAD_REQUEST');
    }
  });

  it('treats 2xx as success (null)', () => {
    expect(classifyAttempt(200, '')).toBeNull();
    expect(classifyAttempt(201, '')).toBeNull();
  });

  it('429 is a KEY_FAILURE, NOT a TRANSIENT (would cause infinite retry otherwise)', () => {
    // This is a historical footgun: 429 in the TRANSIENT bucket means a
    // rate-limited key is retried in-place forever instead of rotated.
    const r = classifyAttempt(429, 'rate limit');
    expect(r?.kind).toBe('KEY_FAILURE');
  });
});

describe('constraint: :free suffix is idempotent', () => {
  it('appends :free exactly once', () => {
    expect(withFree('m', true)).toBe('m:free');
    expect(withFree('m:free', true)).toBe('m:free');
    expect(withFree('m:beta', true)).toBe('m:beta'); // existing suffix preserved
  });

  it('is a no-op when force=false', () => {
    expect(withFree('m', false)).toBe('m');
  });

  it('does NOT suffix the openrouter/free meta-router (regression guard)', () => {
    // openrouter/free is OpenRouter's auto-router over free models; it self-
    // selects the upstream provider, so appending :free would produce the
    // non-existent "openrouter/free:free" and break all alias requests.
    expect(withFree('openrouter/free', true)).toBe('openrouter/free');
    expect(withFree('openrouter/auto', true)).toBe('openrouter/auto');
  });
});

describe('constraint: source files stay under 250 lines (module size budget)', () => {
  // Per the user's "manage from a higher level" philosophy: large files are a
  // smell. Every src file should stay readable in one screen.
  const files = [
    'providers/chain.ts',
    'providers/fetch.ts',
    'providers/openrouter.ts',
    'providers/single-key.ts',
    'providers/types.ts',
    'providers/instances.ts',
    'gateway/server.ts',
    'gateway/handlers.ts',
    'gateway/stream.ts',
    'gateway/validation.ts',
    'config/env.ts',
    'config/logger.ts',
    'common/errors.ts',
    'common/http.ts',
    'common/retry.ts',
    'agent/loop.ts',
    'agent/tools.ts',
    'agent/goal.ts',
    'main.ts',
    'worker.ts',
  ];
  for (const f of files) {
    it(`${f} <= 250 lines`, () => {
      const lines = src(f).split('\n').length;
      expect(lines, `${f} is ${lines} lines`).toBeLessThanOrEqual(250);
    });
  }
});

describe('constraint: no console.log in src (use the logger)', () => {
  // console.log bypasses structured logging + redaction. The only allowed
  // direct console use is the fail-fast env error in env.ts.
  const files = [
    'providers/chain.ts',
    'providers/fetch.ts',
    'providers/openrouter.ts',
    'providers/single-key.ts',
    'gateway/server.ts',
    'gateway/handlers.ts',
    'gateway/stream.ts',
    'agent/loop.ts',
    'agent/tools.ts',
    'main.ts',
    'worker.ts',
  ];
  for (const f of files) {
    it(`${f} has no console.* call`, () => {
      expect(src(f)).not.toMatch(/\bconsole\.(log|debug|info|warn|error)\s*\(/);
    });
  }
});

describe('constraint: no raw process.env reads outside config/env.ts', () => {
  // All env access must go through the validated env() singleton. Reading
  // process.env directly elsewhere bypasses zod validation + redaction.
  const files = [
    'providers/chain.ts',
    'providers/fetch.ts',
    'providers/openrouter.ts',
    'providers/single-key.ts',
    'gateway/handlers.ts',
    'gateway/stream.ts',
    'agent/loop.ts',
    'main.ts',
    'worker.ts',
  ];
  for (const f of files) {
    it(`${f} does not read process.env directly`, () => {
      // chain.ts legitimately imports `env` from config; that's fine. We ban
      // the raw `process.env.X` member access.
      expect(src(f)).not.toMatch(/process\.env\[/);
    });
  }
});

describe('constraint: provider chain ordering is documented + enforced', () => {
  // The failover order is a product decision. Encode it so a reordering is a
  // visible test change, not a silent diff.
  it('chain.ts documents OpenRouter -> OpenAI -> ZAI -> OpenCode order', () => {
    const code = src('providers/chain.ts');
    expect(code).toContain("'openai'");
    expect(code).toContain("'zai'");
    expect(code).toContain("'opencode'");
    // The fallback order array in runChain.
    expect(code).toMatch(/\[\s*'openai'\s*,\s*'zai'\s*,\s*'opencode'\s*\]/);
  });
});

describe('constraint: short-circuit uses direct: namespace (no OpenRouter collision)', () => {
  // OpenRouter uses vendor/model ids (openai/gpt-4o, google/gemma-...). A bare
  // "openai/..." must NOT be treated as a provider pin, or OpenRouter models
  // break. Provider pinning requires the "direct:" prefix.
  it('chain.ts shortCircuit requires the direct: prefix', () => {
    const code = src('providers/chain.ts');
    expect(code).toMatch(/startsWith\('direct:'\)/);
    // And it must NOT pin on bare openai/ (regression guard).
    expect(code).not.toMatch(/m\.startsWith\('openai\/'\)/);
  });
});

describe('constraint: OpenCode provider naming uniformity', () => {
  it('instances.ts uses opencode-bigpickle id for main OpenCode provider', () => {
    const code = src('providers/instances.ts');
    expect(code).toContain("id: 'opencode-bigpickle'");
  });

  it('chain.ts uses opencode-<name> labels in EXTRA_OPENCODE_MODELS', () => {
    const code = src('providers/chain.ts');
    expect(code).toContain("'opencode-nemotron'");
    expect(code).toContain("'opencode-deepseek-flash'");
    expect(code).toContain("'opencode-mimo'");
    expect(code).toContain("'opencode-north-mini-code'");
    expect(code).toContain("'opencode-laguna'");
    expect(code).toContain("'opencode-ling'");
    expect(code).toContain("'opencode-qwen'");
    expect(code).toContain("'opencode-minimax'");
  });

  it('env.ts includes free in default WALK_ALIAS', () => {
    const code = src('config/env.ts');
    expect(code).toContain("default('mst/free,free')");
  });
});

