import type pino from 'pino';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { parseAgentPatches, runDirectorAgent } from './agent-loop.js';
import { callTool } from './agent-tools.js';

vi.mock('./agent-tools.js', () => ({
  callTool: vi.fn(),
  toolDefinitions: vi.fn(() => []),
}));
vi.mock('../common/retry.js', () => ({ sleep: vi.fn(async () => undefined) }));

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

function assistantMessage(message: unknown): unknown {
  return { response: { json: async () => ({ choices: [{ message }] }) }, servedBy: {} };
}

function patchMessage(): unknown {
  return assistantMessage({
    role: 'assistant',
    content: '{"patches":[{"overrides":{"MAX_STEPS":"200"},"rationale":"slow down","risk":"low"}]}',
  });
}

describe('runDirectorAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callTool).mockResolvedValue({ content: 'ok' });
  });

  it('returns early when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const chain = { handle: vi.fn() } as never;
    const result = await runDirectorAgent(chain, 'sys', 'goal', 'm', silent, controller.signal);
    expect(result).toEqual({ steps: 0, patches: [], transcript: '' });
  });

  it('executes tool calls and returns extracted patches', async () => {
    const chain = {
      handle: vi
        .fn()
        .mockResolvedValueOnce(
          assistantMessage({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'terminal', arguments: '{"command":"ls"}' },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(patchMessage()),
    } as never;

    const result = await runDirectorAgent(
      chain,
      'sys',
      'goal',
      'm',
      silent,
      new AbortController().signal,
    );
    expect(result.steps).toBe(2);
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0]!.overrides).toEqual({ MAX_STEPS: '200' });
    expect(result.transcript).toContain('[tool terminal]');
    expect(vi.mocked(callTool)).toHaveBeenCalledWith('terminal', { command: 'ls' }, silent);
  });

  it('handles non-object and malformed tool arguments', async () => {
    const chain = {
      handle: vi
        .fn()
        .mockResolvedValueOnce(
          assistantMessage({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'a',
                type: 'function',
                function: { name: 'write_prompt_override', arguments: '"just-a-string"' },
              },
              {
                id: 'b',
                type: 'function',
                function: { name: 'write_prompt_override', arguments: 'not-json' },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(patchMessage()),
    } as never;

    const result = await runDirectorAgent(
      chain,
      'sys',
      '',
      'm',
      silent,
      new AbortController().signal,
    );
    expect(result.patches).toHaveLength(1);
    const argCalls = vi.mocked(callTool).mock.calls.map((c) => c[1]);
    expect(argCalls).toEqual([{ _value: 'just-a-string' }, { _raw: 'not-json' }]);
  });

  it('logs and retries when the chain call fails', async () => {
    const chain = {
      handle: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(patchMessage()),
    } as never;

    const result = await runDirectorAgent(
      chain,
      'sys',
      'goal',
      'm',
      silent,
      new AbortController().signal,
    );
    expect(silent.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: 1 }),
      'director agent call failed',
    );
    expect(result.steps).toBe(2);
    expect(result.patches).toHaveLength(1);
  });

  it('breaks when the model returns no message', async () => {
    const chain = {
      handle: vi.fn().mockResolvedValueOnce(assistantMessage(undefined)),
    } as never;

    const result = await runDirectorAgent(
      chain,
      'sys',
      'goal',
      'm',
      silent,
      new AbortController().signal,
    );
    expect(silent.warn).toHaveBeenCalledWith({ step: 1 }, 'director agent: no message returned');
    expect(result.steps).toBe(1);
    expect(result.patches).toEqual([]);
  });
});

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
    const text =
      'Some reasoning\n\n```json\n{"patches":[{"overrides":{"X":"1"},"rationale":"r","risk":"low"}]}\n```\n';
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
