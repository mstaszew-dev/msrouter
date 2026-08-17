/**
 * PROBE: prove the pool SKIPS an exhausted key and rotates to a working one.
 *
 * Puts a known-exhausted key (the 403 "Key limit exceeded" one) at index 0,
 * then a working key at index 1, and shows the router advancing past the bad
 * key to succeed. This is the exact "if a key is exhausted, move to next"
 * behavior the user asked about.
 *
 *   npx tsx scripts/probe-rotation-badfirst.ts
 */

import 'dotenv/config';

import pino from 'pino';

import { loadEnv } from '../src/config/env.js';
import { scrubSecrets } from '../src/providers/fetch.js';
import { OpenRouterProvider, withFree } from '../src/providers/openrouter.js';
import type { ChatRequestBody } from '../src/providers/types.js';

const env = loadEnv(process.env).env;
const log = pino({ level: 'warn', name: 'probe' });

// Key 2 (mstaszew) historically returns 403 "Key limit exceeded (total limit)".
// Key 1 (halluxfizjo) works. We put the bad key FIRST to force a rotation.
const BAD_KEY = process.env['OPENROUTER_KEY2']!;
const GOOD_KEY = process.env['OPENROUTER_KEY1']!;
const provider = new OpenRouterProvider([BAD_KEY, GOOD_KEY], 60_000, log);

const model = withFree(env.OPENROUTER_MODEL, env.FORCE_FREE);
const body: ChatRequestBody = {
  model,
  messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
  max_tokens: 512,
};

// eslint-disable-next-line no-console
console.log(`\nProbing [badKey(403), goodKey] with model "${model}"...\n`);

let okAt = -1;
for (let i = 0; i < provider.keyCount; i++) {
  const res = await provider.attempt(body, new AbortController().signal, {
    keyIndex: i,
    model,
  });
  const tag = `key${i + 1}`.padEnd(6);
  if (res.kind === 'OK') {
    const text = scrubSecrets(await res.response.clone().text());
    const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const content = parsed.choices?.[0]?.message?.content;
    // eslint-disable-next-line no-console
    console.log(`${tag} OK     (200) content=${JSON.stringify(content)}`);
    okAt = i;
    break;
  }
  // eslint-disable-next-line no-console
  console.log(
    `${tag} ${res.kind.padEnd(12)} (${res.status}) ${scrubSecrets((res.message ?? '').slice(0, 70))}`,
  );
}

// eslint-disable-next-line no-console
console.log(
  okAt === 1
    ? `\n✓ ROTATION PROVEN: skipped exhausted key1 (403), succeeded on key2.`
    : okAt === 0
      ? `\n- key1 unexpectedly succeeded (its quota may have reset); rerun later.`
      : `\n- both keys failed.`,
);
