import { describe, expect, it } from 'vitest';

import { parseAgentPatches } from './agent-loop.js';

describe('parseAgentPatches', () => {
  it('extracts patches from a JSON block in the text', () => {
    const text = `Some reasoning here...

{"patches":[{"overrides":{"SLEEP_MS":"2000"},"rationale":"slow down","risk":"low"}]}

And some trailing text.`;
    const patches = parseAgentPatches(text);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.overrides).toEqual({ SLEEP_MS: '2000' });
    expect(patches[0]!.rationale).toBe('slow down');
    expect(patches[0]!.risk).toBe('low');
    expect(patches[0]!.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('returns [] when no JSON block is present', () => {
    expect(parseAgentPatches('just some text with no patches')).toEqual([]);
    expect(parseAgentPatches('')).toEqual([]);
  });

  it('returns [] when JSON has no patches array', () => {
    expect(parseAgentPatches('{"not":"patches"}')).toEqual([]);
    expect(parseAgentPatches('{"result":"ok"}')).toEqual([]);
  });

  it('filters out patches with invalid env-var keys', () => {
    const text = `{"patches":[{"overrides":{"bad-key":"x"},"rationale":"r","risk":"low"}]}`;
    expect(parseAgentPatches(text)).toEqual([]);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseAgentPatches('{"patches": broken json')).toEqual([]);
  });

  it('handles multiple patches', () => {
    const text = `{"patches":[
      {"overrides":{"A":"1"},"rationale":"first","risk":"low"},
      {"overrides":{"B":"2"},"rationale":"second","risk":"high"}
    ]}`;
    const patches = parseAgentPatches(text);
    expect(patches).toHaveLength(2);
    expect(patches[0]!.overrides).toEqual({ A: '1' });
    expect(patches[1]!.overrides).toEqual({ B: '2' });
    expect(patches[1]!.risk).toBe('high');
  });

  it('handles json wrapped in markdown code fences', () => {
    const text = 'Some reasoning\n\n```json\n{"patches":[{"overrides":{"X":"1"},"rationale":"r","risk":"low"}]}\n```\n';
    const patches = parseAgentPatches(text);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.overrides).toEqual({ X: '1' });
  });

  it('handles patches with empty overrides', () => {
    const text = `{"patches":[{"overrides":{"_EMPTY":"x"},"rationale":"test","risk":"low"}]}`;
    // _EMPTY contains underscore which IS valid for env vars (KEY_RE = /^[A-Z_][A-Z0-9_]*$/)
    const patches = parseAgentPatches(text);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.overrides).toEqual({ _EMPTY: 'x' });
  });

  it('filters out patches with non-string overrides', () => {
    const text = `{"patches":[{"overrides":{"KEY":123},"rationale":"r","risk":"low"}]}`;
    expect(parseAgentPatches(text)).toEqual([]);
  });
});
