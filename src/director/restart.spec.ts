vi.mock('node:child_process', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- importOriginal needs an inline typeof import(); a type-only namespace breaks the factory's return typing
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(), spawn: vi.fn() };
});
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async () => undefined),
}));

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pino from 'pino';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  assertInIterm,
  checkInfrastructure,
  detectWorker,
  detectProcess,
  ensureCdpRunning,
  ensureInfrastructureHealthy,
  ensureOverrideFiles,
  isInIterm,
  isRunningInIterm,
  pollCdp,
  snapshot,
  startChromeCdp,
  startWorkerInIterm,
  startKafkaInIterm,
  waitForStartup,
} from './restart.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

const kafkaOpts = {
  entryCommand: 'job-search-agent',
  workspace: '/test/workspace',
  cdpUrl: 'http://127.0.0.1:9222',
  log: silent,
};

describe('detectWorker', () => {
  it('returns a number[] of pids (length depends on whether campaign is running)', () => {
    const pids = detectWorker(kafkaOpts.entryCommand);
    expect(Array.isArray(pids)).toBe(true);
    for (const p of pids) {
      expect(typeof p).toBe('number');
      expect(p).toBeGreaterThan(0);
    }
  });

  it('returns a number[] even when only the python child pattern matches', () => {
    const pids = detectWorker('/this/path/does/not/exist/zzz-not-a-real-script-9999');
    expect(Array.isArray(pids)).toBe(true);
    for (const p of pids) {
      expect(typeof p).toBe('number');
      expect(p).toBeGreaterThan(0);
    }
  });
});

describe('snapshot', () => {
  it('returns a SuperviseState with running flag consistent with pids', () => {
    const s = snapshot(kafkaOpts);
    expect(s).toHaveProperty('pids');
    expect(s).toHaveProperty('running');
    expect(Array.isArray(s.pids)).toBe(true);
    expect(s.running).toBe(s.pids.length > 0);
  });
});

describe('pollCdp', () => {
  it('returns false on a non-listening URL within timeout', async () => {
    const out = await pollCdp('http://127.0.0.1:1', 500);
    expect(out).toBe(false);
  });
});

describe('ensureOverrideFiles', () => {
  let realHome: string;

  beforeEach(() => {
    realHome = process.env['HOME']!;
    const tmpHome = mkdtempSync(join(tmpdir(), 'director-restart-home-'));
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('creates director-overrides.env if missing', () => {
    ensureOverrideFiles();
    const envPath = join(process.env['HOME']!, '.campaign-agent', 'director-overrides.env');
    expect(existsSync(envPath)).toBe(true);
  });

  it('creates director-prompt-overrides.md if missing', () => {
    ensureOverrideFiles();
    const mdPath = join(process.env['HOME']!, '.campaign-agent', 'director-prompt-overrides.md');
    expect(existsSync(mdPath)).toBe(true);
  });

  it('does not overwrite existing files', () => {
    // Pre-create with content
    ensureOverrideFiles();
    const envPath = join(process.env['HOME']!, '.campaign-agent', 'director-overrides.env');
    writeFileSync(envPath, 'EXISTING_KEY=1\n');

    // Call again; should not truncate
    ensureOverrideFiles();
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('EXISTING_KEY=1');
  });
});

describe('detectProcess', () => {
  it('returns pids for a matching pattern', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('4242\n4243\n');
    const pids = detectProcess('my-process');
    expect(pids).toEqual([4242, 4243]);
  });

  it('returns [] for a non-existent pattern', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('');
    const pids = detectProcess('zzz-this-does-not-exist-9999');
    expect(pids).toEqual([]);
  });
});

describe('startKafkaInIterm', () => {
  let realHome: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    realHome = process.env['HOME']!;
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'director-kafka-home-'));
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('starts Kafka in an iTerm tab when broker is not running', () => {
    // Mock lsof to return nothing (port 9092 not in use) and pgrep to fail
    vi.mocked(execFileSync).mockImplementation((cmd: string) => {
      if (cmd === 'lsof' || cmd === 'pgrep') throw new Error('not found');
      return '';
    });
    startKafkaInIterm(kafkaOpts);
    const calls = vi.mocked(execFileSync).mock.calls;
    const osaCalls = calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(1);
    const script = osaCalls[0]![1]![1]!;
    expect(script).toContain('kafka');
    expect(script).toContain('scripts/kafka.sh');
    // Both start and monitor run in the SAME session (no separate tab for monitor)
    expect(script).toContain('bash scripts/kafka.sh start');
    expect(script).toContain('bash scripts/kafka.sh monitor');
    // Monitor should NOT spawn its own separate tab — it runs in the same session
    expect(script).not.toContain('tell current session of newTab');
    // Regression: scripts/kafka.sh lives in the msrouter repo, not in the
    // campaign workspace (startKafkaInIterm used to cd into opts.workspace).
    const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    expect(script).toContain(`cd ${repoRoot}`);
    expect(script).not.toContain('/test/workspace');
  });

  it('skips spawn when Kafka port 9092 is already listening', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: string) => {
      if (cmd === 'lsof') return 'node  12345  mst  5u  IPv4  ...\n';
      throw new Error('not found');
    });
    startKafkaInIterm(kafkaOpts);
    expect(execFileSync).not.toHaveBeenCalledWith('osascript', expect.anything());
  });

  it('skips spawn when a Kafka Java process is found', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === 'lsof') throw new Error('not found');
      if (cmd === 'pgrep' && args?.includes('kafka.server.KafkaServer')) return '12345\n';
      throw new Error('not found');
    });
    startKafkaInIterm(kafkaOpts);
    expect(execFileSync).not.toHaveBeenCalledWith('osascript', expect.anything());
  });
});

describe('isInIterm', () => {
  it('returns true when pgrep finds iTerm2', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('4242\n');
    expect(isInIterm()).toBe(true);
  });

  it('returns false when pgrep finds nothing', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('');
    expect(isInIterm()).toBe(false);
  });

  it('returns false when pgrep is unavailable', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('pgrep not found');
    });
    expect(isInIterm()).toBe(false);
  });
});

describe('isRunningInIterm', () => {
  let savedTermProgram: string | undefined;

  beforeEach(() => {
    savedTermProgram = process.env['TERM_PROGRAM'];
  });

  afterEach(() => {
    if (savedTermProgram === undefined) {
      delete process.env['TERM_PROGRAM'];
    } else {
      process.env['TERM_PROGRAM'] = savedTermProgram;
    }
  });

  it('returns true when TERM_PROGRAM is iTerm.app', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    expect(isRunningInIterm()).toBe(true);
  });

  it('returns false when TERM_PROGRAM is Apple_Terminal', () => {
    process.env['TERM_PROGRAM'] = 'Apple_Terminal';
    expect(isRunningInIterm()).toBe(false);
  });

  it('returns false when TERM_PROGRAM is undefined', () => {
    delete process.env['TERM_PROGRAM'];
    expect(isRunningInIterm()).toBe(false);
  });

  it('returns false when TERM_PROGRAM is vscode', () => {
    process.env['TERM_PROGRAM'] = 'vscode';
    expect(isRunningInIterm()).toBe(false);
  });
});

describe('assertInIterm', () => {
  let savedTermProgram: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: ReturnType<typeof vi.spyOn<any, 'exit'>>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedTermProgram = process.env['TERM_PROGRAM'];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedTermProgram === undefined) {
      delete process.env['TERM_PROGRAM'];
    } else {
      process.env['TERM_PROGRAM'] = savedTermProgram;
    }
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('does not exit when running inside iTerm2', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    assertInIterm();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits with code 1 when TERM_PROGRAM is Apple_Terminal', () => {
    process.env['TERM_PROGRAM'] = 'Apple_Terminal';
    assertInIterm();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('must be launched from iTerm2'),
    );
  });

  it('exits with code 1 when TERM_PROGRAM is unset', () => {
    delete process.env['TERM_PROGRAM'];
    assertInIterm();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('TERM_PROGRAM=(unset)'),
    );
  });
});

describe('startChromeCdp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns Chrome with remote debugging on the cdpUrl port', () => {
    vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as never);
    startChromeCdp('http://127.0.0.1:9333');
    const [file, args] = vi.mocked(spawn).mock.calls[0]!;
    expect(file).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(args).toContain('--remote-debugging-port=9333');
  });

  it('defaults the port to 9222 when absent', () => {
    vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as never);
    startChromeCdp('http://localhost');
    const args = vi.mocked(spawn).mock.calls[0]![1];
    expect(args).toContain('--remote-debugging-port=9222');
  });
});

describe('ensureCdpRunning', () => {
  it('launches Chrome when CDP is not reachable', async () => {
    vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as never);
    await ensureCdpRunning('http://127.0.0.1:1');
    expect(spawn).toHaveBeenCalled();
  });
});

describe('checkInfrastructure', () => {
  it('flags components as alive when their processes are found', () => {
    vi.mocked(execFileSync).mockReturnValue('4242\n');
    const status = checkInfrastructure();
    expect(status).toEqual({
      cdpAlive: true,
      playwrightMcpAlive: true,
      openclawGatewayAlive: true,
    });
  });

  it('flags all as down when no processes are found', () => {
    vi.mocked(execFileSync).mockReturnValue('');
    const status = checkInfrastructure();
    expect(status).toEqual({
      cdpAlive: false,
      playwrightMcpAlive: false,
      openclawGatewayAlive: false,
    });
  });
});

describe('waitForStartup', () => {
  let realHome: string;

  beforeEach(() => {
    realHome = process.env['HOME']!;
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'director-waitstart-home-'));
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('resolves true when the worker registers and clears the lock', async () => {
    const lockPath = join(process.env['HOME']!, '.campaign-agent', 'agent-start.lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '123\n456\n');
    vi.mocked(execFileSync).mockReturnValue('4242\n');
    const up = await waitForStartup(kafkaOpts, 1000);
    expect(up).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('');
  });

  it('resolves false when the worker never registers', async () => {
    vi.mocked(execFileSync).mockReturnValue('');
    const up = await waitForStartup(kafkaOpts, 1);
    expect(up).toBe(false);
  });
});

describe('startWorkerInIterm', () => {
  let realHome: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    realHome = process.env['HOME']!;
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'director-worker-home-'));
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('starts the worker in an iTerm tab', () => {
    startWorkerInIterm(kafkaOpts);
    const calls = vi.mocked(execFileSync).mock.calls;
    const osaCalls = calls.filter((c) => c[0] === 'osascript');
    expect(osaCalls.length).toBe(1);
    const workerScript = osaCalls[0]![1]![1]!;
    expect(workerScript).toContain('job-search-agent');
  });

  it('skips when the startup lock is held', () => {
    const lockPath = join(process.env['HOME']!, '.campaign-agent', 'agent-start.lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`);
    startWorkerInIterm(kafkaOpts);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('rethrows when osascript fails', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('osascript failed');
    });
    expect(() => startWorkerInIterm(kafkaOpts)).toThrow('iTerm2 launch failed');
  });
});

describe('ensureInfrastructureHealthy', () => {
  let realHome: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    realHome = process.env['HOME']!;
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'director-infra-home-'));
  });

  afterEach(() => {
    process.env['HOME'] = realHome;
  });

  it('returns false without restart when playwright-mcp is alive', async () => {
    vi.mocked(execFileSync).mockReturnValue('4242\n');
    const restarted = await ensureInfrastructureHealthy({ ...kafkaOpts, cdpTimeoutMs: 1 });
    expect(restarted).toBe(false);
    expect(silent.warn).not.toHaveBeenCalledWith(
      { missing: ['playwright-mcp'] },
      'Campaign infrastructure unhealthy; restarting campaign',
    );
  });

  it('skips restart when the campaign target is already met', async () => {
    const campaignDir = mkdtempSync(join(tmpdir(), 'director-done-campaign-'));
    writeFileSync(
      join(campaignDir, 'tracker.json'),
      JSON.stringify({ stats: { submitted: 5 }, targetApplications: 5 }),
    );
    vi.mocked(execFileSync).mockReturnValue('');
    const restarted = await ensureInfrastructureHealthy({
      ...kafkaOpts,
      cdpTimeoutMs: 1,
      campaignDir,
    });
    expect(restarted).toBe(false);
    expect(silent.info).toHaveBeenCalledWith(
      'Campaign target met; skipping infrastructure health restart',
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('restarts the campaign when playwright-mcp is missing', async () => {
    vi.mocked(execFileSync).mockReturnValue('');
    const restarted = await ensureInfrastructureHealthy({ ...kafkaOpts, cdpTimeoutMs: 1 });
    expect(restarted).toBe(true);
    expect(silent.warn).toHaveBeenCalledWith(
      { missing: ['playwright-mcp'] },
      'Campaign infrastructure unhealthy; restarting campaign',
    );
  });
});
