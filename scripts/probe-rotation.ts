/**
 * PROBE: prove the pool rotates to the next key when one is exhausted.
 *
 * Calls the OpenRouterProvider directly, attempting each pooled key in order,
 * and prints the classified outcome of every single attempt. Run live:
 *
 *   npx tsx scripts/probe-rotation.ts
 *
 * You should see KEY_FAILURE(403/429) advance the index, and stop at the first
 * OK. If every key is exhausted, it falls through (the gateway would then go
 * to Zen/BigPickle).
 */

import 'dotenv/config';

import pino from 'pino';

import { loadEnv } from '../src/config/env.js';
import { scrubSecrets } from '../src/providers/fetch.js';
import { OpenRouterProvider, withFree } from '../src/providers/openrouter.js';
import type { ChatRequestBody } from '../src/providers/types.js';

const env = loadEnv(process.env).env;
const log = pino({ level: 'warn', name: 'probe' });

const keys = Object.keys(process.env)
  .filter((k) => /^OPENROUTER_KEY\d+$/.test(k))
  .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
  .map((k) => process.env[k]!)
  .filter(Boolean);

const provider = new OpenRouterProvider(keys, 60_000, log);
const model = withFree(env.OPENROUTER_MODEL, env.FORCE_FREE);
const body: ChatRequestBody = {
  model,
  messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
  max_tokens: 512,
};

// eslint-disable-next-line no-console
console.log(`\nProbing ${provider.keyCount} OpenRouter keys with model "${model}"...\n`);

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
  // KEY_FAILURE / TRANSIENT / BAD_REQUEST all surface status + message.
  // eslint-disable-next-line no-console
  console.log(`${tag} ${res.kind.padEnd(12)} (${res.status}) ${scrubSecrets((res.message ?? '').slice(0, 70))}`);
}

// eslint-disable-next-line no-console
console.log(
  okAt >= 0
    ? `\nResult: rotated through keys, FIRST SUCCESS at key${okAt + 1}.`
    : `\nResult: every key exhausted (the gateway would now fall through to Zen/BigPickle).`,
);
