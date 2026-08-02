import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock execFileSync (restart.ts imports it from node:child_process); keep
// spawn real. Also fast-forward timers so the sleep() calls don't stall.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async () => undefined),
}));

import { execFileSync } from 'node:child_process';
import {
  protonVpnConnected,
  protonVpnServer,
  publicIp,
  rotateVpnIp,
  shouldRotateVpn,
} from './restart.js';

const mockedExec = vi.mocked(execFileSync);

/** Command-based stub. value can be a literal or an array (shifted per call);
 *  `undefined` means the command is unavailable (throws, like a missing binary). */
function stubExec(calls: Record<string, unknown | unknown[]>) {
  mockedExec.mockReset();
  mockedExec.mockImplementation(((cmd: string) => {
    if (!(cmd in calls)) throw new Error(`unexpected command: ${cmd}`);
    const v = calls[cmd];
    if (v === undefined) throw new Error(`command unavailable: ${cmd}`);
    if (Array.isArray(v)) {
      const next = v.shift();
      if (next === undefined) throw new Error(`no more values for ${cmd}`);
      return next as never;
    }
    return v as never;
  }) as typeof execFileSync);
}

beforeEach(() => {
  mockedExec.mockReset();
});

describe('protonVpnConnected', () => {
  it('returns true when scutil reports Connected', () => {
    stubExec({ scutil: 'Connected (Disconnected | Connected)' });
    expect(protonVpnConnected()).toBe(true);
  });

  it('returns false when scutil reports Disconnected', () => {
    stubExec({ scutil: 'Disconnected' });
    expect(protonVpnConnected()).toBe(false);
  });

  it('returns false when scutil throws', () => {
    stubExec({});
    expect(protonVpnConnected()).toBe(false);
  });
});

describe('protonVpnServer / publicIp', () => {
  it('reads the ProtonVPN server name from app defaults', () => {
    stubExec({ defaults: 'NL-FREE#120' });
    expect(protonVpnServer()).toBe('NL-FREE#120');
  });

  it('returns empty string when defaults fail', () => {
    stubExec({});
    expect(protonVpnServer()).toBe('');
  });

  it('reads the public IP via ipify', () => {
    stubExec({ curl: '1.2.3.4' });
    expect(publicIp()).toBe('1.2.3.4');
  });
});

describe('rotateVpnIp', () => {
  it('uses scutil stop+start when no protonvpn-cli exists, never osascript', async () => {
    stubExec({
      which: undefined,
      scutil: 'Connected',
      defaults: ['NL-FREE#120', 'NL-FREE#321'],
      curl: ['1.2.3.4', '5.6.7.8'],
    });
    expect(await rotateVpnIp()).toBe(true);
    const cmds = mockedExec.mock.calls.map((c) => c[0]);
    expect(cmds).not.toContain('osascript');
    expect(cmds).not.toContain('open');
    const scutilCalls = mockedExec.mock.calls.filter((c) => c[0] === 'scutil');
    expect(scutilCalls.some((c) => c[1]?.includes('stop'))).toBe(true);
    expect(scutilCalls.some((c) => c[1]?.includes('start'))).toBe(true);
  });

  it('uses protonvpn-cli when installed (app not invoked)', async () => {
    stubExec({
      which: '/usr/local/bin/protonvpn-cli',
      'protonvpn-cli': '',
      scutil: 'Connected',
      defaults: ['NL-FREE#120', 'NL-FREE#321'],
      curl: ['1.2.3.4', '5.6.7.8'],
    });
    expect(await rotateVpnIp()).toBe(true);
    const cmds = mockedExec.mock.calls.map((c) => c[0]);
    expect(cmds).toContain('protonvpn-cli');
    expect(cmds).not.toContain('osascript');
  });

  it('retries scutil stop+start until IP changes', async () => {
    stubExec({
      which: undefined,
      scutil: ['Disconnected', 'Connected', 'Connected'],
      defaults: ['NL-FREE#120', 'NL-FREE#321'],
      curl: ['1.2.3.4', '5.6.7.8'],
    });
    expect(await rotateVpnIp()).toBe(true);
    const calls = mockedExec.mock.calls.filter((c) => c[0] === 'scutil');
    expect(calls.some((c) => c[1]?.includes('start'))).toBe(true);
  });

  it('returns false when neither IP nor server changed after retries', async () => {
    // retry loop does stop+start+status checks 3x; provide enough values
    stubExec({
      which: undefined,
      scutil: 'Connected',
      defaults: 'NL-FREE#120',
      curl: '1.2.3.4',
    });
    expect(await rotateVpnIp()).toBe(false);
  });

  it('returns false when the VPN is not connected after rotation', async () => {
    stubExec({
      which: undefined,
      scutil: 'Disconnected',
      defaults: 'NL-FREE#120',
      curl: '1.2.3.4',
    });
    expect(await rotateVpnIp()).toBe(false);
  });
});

describe('shouldRotateVpn', () => {
  const NOW = new Date('2026-08-02T12:00:00Z').getTime();

  it('returns true when no previous rotation exists', () => {
    expect(shouldRotateVpn(undefined, 30, NOW)).toBe(true);
  });

  it('returns true when the last rotation is older than the interval', () => {
    const old = new Date(NOW - 31 * 60_000).toISOString();
    expect(shouldRotateVpn(old, 30, NOW)).toBe(true);
  });

  it('returns false when the last rotation is newer than the interval', () => {
    const fresh = new Date(NOW - 10 * 60_000).toISOString();
    expect(shouldRotateVpn(fresh, 30, NOW)).toBe(false);
  });

  it('returns false when the interval is 0 or negative (disabled)', () => {
    expect(shouldRotateVpn(undefined, 0, NOW)).toBe(false);
    expect(shouldRotateVpn(undefined, -1, NOW)).toBe(false);
  });
});
