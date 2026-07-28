import { describe, expect, it } from 'vitest';

import { parseConsumeOutput } from './kafka.js';

describe('kafka.ts CLI wrapper', () => {
  describe('parseConsumeOutput', () => {
    it('parses key\\tvalue lines', () => {
      const raw = 'key-1\t{"text":"hello"}\nkey-2\t{"text":"approve patch-abc"}\n';
      const parsed = parseConsumeOutput(raw);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ key: 'key-1', value: '{"text":"hello"}' });
      expect(parsed[1]).toMatchObject({ key: 'key-2', value: '{"text":"approve patch-abc"}' });
    });

    it('handles empty output', () => {
      expect(parseConsumeOutput('')).toEqual([]);
      expect(parseConsumeOutput('\n')).toEqual([]);
    });

    it('handles lines without keys (no tab separator)', () => {
      const raw = '{"no":"key"}\n';
      const parsed = parseConsumeOutput(raw);
      expect(parsed).toHaveLength(1);
      // Lines without a tab separator have key undefined
      expect(parsed[0]!.key).toBeUndefined();
      expect(parsed[0]!.value).toBe('{"no":"key"}');
    });

    it('handles multiple blank lines between messages', () => {
      const raw = 'k1\tv1\n\n\nk2\tv2\n';
      const parsed = parseConsumeOutput(raw);
      expect(parsed).toHaveLength(2);
    });

    it('handles values with embedded tabs (only first tab is the separator)', () => {
      const raw = 'key-1\tvalue\twith\ttabs\n';
      const parsed = parseConsumeOutput(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.key).toBe('key-1');
      expect(parsed[0]!.value).toBe('value\twith\ttabs');
    });
  });
});
