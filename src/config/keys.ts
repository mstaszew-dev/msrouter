/**
 * Numbered-key pool collectors (OPENROUTER_KEY1..N, OPENCODE_KEY1..N). One
 * generic implementation shared by both pooled providers; extracted from
 * env.ts so env.ts stays under its 250-line module-size budget.
 */

type RawEnv = Record<string, string | undefined>;

/**
 * Collect numbered `${PREFIX}_KEY1..N` from the raw env in stable ascending
 * numeric order by suffix; duplicates dropped. A single `${PREFIX}_API_KEY`
 * is appended last when not already present (parity with the upstream SDKs).
 * Blank/whitespace values are ignored.
 */
export function collectNumberedKeys(raw: RawEnv, prefix: string): string[] {
  // prefix is an internal literal ('OPENROUTER'/'OPENCODE'); it is interpolated
  // unescaped, so it must stay regex-safe.
  const re = new RegExp(`^${prefix}_KEY(\\d+)$`, 'i');
  const numbered: Array<{ n: number; key: string }> = [];
  for (const [k, v] of Object.entries(raw)) {
    const m = re.exec(k);
    if (m && v && v.trim()) {
      numbered.push({ n: Number(m[1]), key: v.trim() });
    }
  }
  numbered.sort((a, b) => a.n - b.n);
  // Dedupe while preserving first-seen order (so identical keys collapse).
  const keys: string[] = [];
  for (const x of numbered) {
    if (!keys.includes(x.key)) keys.push(x.key);
  }
  const single = raw[`${prefix}_API_KEY`];
  if (single && single.trim() && !keys.includes(single.trim())) {
    keys.push(single.trim());
  }
  return keys;
}
