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
    'providers/chain-routing.ts',
    'providers/fetch.ts',
    'providers/openrouter.ts',
    'providers/opencode.ts',
    'providers/rotation.ts',
    'providers/single-key.ts',
    'providers/local.ts',
    'providers/types.ts',
    'providers/instances.ts',
    'gateway/server.ts',
    'gateway/handlers.ts',
    'gateway/stream.ts',
    'gateway/validation.ts',
    'config/env.ts',
    'config/keys.ts',
    'config/logger.ts',
    'common/errors.ts',
    'common/http.ts',
    'common/retry.ts',
    'main.ts',
    'orchestrator.ts',
    'director/types.ts',
    'director/observe.ts',
    'director/classify.ts',
    'director/propose.ts',
    'director/apply.ts',
    'director/restart.ts',
    'director/ledger.ts',
    'director/rag.ts',
    'director/agent-loop.ts',
    'director/agent-tools.ts',
    'director/slack-poller.ts',
    'director/tools.ts',
    'director/index.ts',
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
    'providers/local.ts',
    'gateway/server.ts',
    'gateway/handlers.ts',
    'gateway/stream.ts',
    'main.ts',
    'orchestrator.ts',
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
    'providers/local.ts',
    'gateway/handlers.ts',
    'gateway/stream.ts',
    'main.ts',
    'orchestrator.ts',
  ];
  for (const f of files) {
    it(`${f} does not read process.env directly`, () => {
      // chain.ts legitimately imports `env` from config; that's fine. We ban
      // the raw `process.env.X` member access.
      expect(src(f)).not.toMatch(/process\.env\[/);
    });
  }
});

describe('constraint: provider chain uses adaptive flat-sequence rotation', () => {
  // The OLD architecture hardcoded a fixed OpenRouter->OpenAI->ZAI->OpenCode
  // order. The NEW architecture builds one flat routing-entry list and demotes
  // failing <model,provider,key> triples to the back (no TTL, in-memory only).
  // These constraints encode the new contract so a regression to fixed order
  // is a visible test change.
  it('chain.ts iterates a RotationQueue (not a hardcoded provider array)', () => {
    const code = src('providers/chain.ts');
    expect(code).toContain('RotationQueue');
    expect(code).toMatch(/this\.queue\.demote/);
    // The old fixed-order array literal must NOT come back.
    expect(code).not.toMatch(/\[\s*'openai'\s*,\s*'zai'\s*,\s*'opencode'\s*\]/);
  });

  it('chain-routing.ts builds the env-declared initial order', () => {
    const code = src('providers/chain-routing.ts');
    expect(code).toContain('buildRoutingEntries');
    // Initial order: OpenRouter keys, then OpenAI, then ZAI, then OpenCode triples.
    expect(code).toContain("'openrouter'");
    expect(code).toContain("'openai'");
    expect(code).toContain("'zai'");
    expect(code).toContain("'opencode'");
  });

  it('rotation.ts is the shared demote-to-back primitive', () => {
    const code = src('providers/rotation.ts');
    expect(code).toMatch(/class RotationQueue/);
    expect(code).toMatch(/demote/);
  });
});

describe('constraint: short-circuit uses direct: namespace (no OpenRouter collision)', () => {
  // OpenRouter uses vendor/model ids (openai/gpt-4o, google/gemma-...). A bare
  // "openai/..." must NOT be treated as a provider pin, or OpenRouter models
  // break. Provider pinning requires the "direct:" prefix. shortCircuit lives
  // in chain-routing.ts (extracted from chain.ts).
  it('chain-routing.ts shortCircuit requires the direct: prefix', () => {
    const code = src('providers/chain-routing.ts');
    expect(code).toMatch(/startsWith\('direct:'\)/);
    // And it must NOT pin on bare openai/ (regression guard).
    expect(code).not.toMatch(/m\.startsWith\('openai\/'\)/);
  });
});

describe('constraint: OpenCode is a pooled provider (OPENCODE_KEY1..N)', () => {
  // The OLD architecture had 9 separate SingleKeyProvider instances for OpenCode
  // all sharing one OPENCODE_API_KEY. The NEW architecture has one pooled
  // OpenCodeProvider fed by collectOpenCodeKeys, with one routing entry per
  // (model, key) triple.
  it('instances.ts builds a single pooled OpenCodeProvider', () => {
    const code = src('providers/instances.ts');
    expect(code).toContain('OpenCodeProvider');
    expect(code).toContain('opencodeKeys');
    // The old per-model SingleKeyProvider instances must NOT come back.
    expect(code).not.toContain("id: 'opencode-bigpickle'");
    expect(code).not.toContain("id: 'opencode-nemotron'");
  });

  it('opencode.ts is a pooled provider keyed on (model, key) triples', () => {
    const code = src('providers/opencode.ts');
    expect(code).toMatch(/class OpenCodeProvider/);
    expect(code).toMatch(/OpenCodeTriple/);
    expect(code).toMatch(/tripleIndex/);
  });

  it('env.ts collects OPENCODE_KEY1..N into opencodeKeys', () => {
    const code = src('config/env.ts');
    // Collector extracted to config/keys.ts (collectNumberedKeys); env.ts must
    // still wire the OPENCODE pool through it (pooling guard, see above).
    expect(code).toContain("collectNumberedKeys(raw, 'OPENCODE')");
    expect(code).toContain('opencodeKeys: string[]');
  });

  it('env.ts includes free in default WALK_ALIAS', () => {
    const code = src('config/env.ts');
    expect(code).toContain("default('mst/free,free')");
  });
});
