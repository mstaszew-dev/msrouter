import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/** Check Proton VPN status via scutil. */
export function protonVpnConnected(): boolean {
  try {
    const out = execFileSync('scutil', ['--nc', 'status', 'ProtonVPN'], { encoding: 'utf8', timeout: 5000 });
    return out.trim().startsWith('Connected');
  } catch {
    return false;
  }
}

/** Current public IP via ipify (best-effort, short timeout). */
export function publicIp(): string {
  try {
    const out = execFileSync(
      'curl',
      ['-s', '--max-time', '5', 'https://api.ipify.org'],
      { encoding: 'utf8', timeout: 8000 },
    );
    return out.trim();
  } catch {
    return '';
  }
}

/**
 * Rotate Proton VPN IP.
 *
 * Strategy (no osascript / app automation, no `defaults read`):
 * - osascript triggers a TCC permission prompt every time under a node process.
 * - `defaults read ch.protonvpn.mac ConnectedServerNameDoNotUse` fails with
 *   "domain/default pair does not exist" on macOS containers — the key is not
 *   at that path. So server-name comparison is removed; IP change is the sole
 *   verification signal.
 * - protonvpn-cli is Linux-only (PyPI 2.2.11 targets linux-cli-community);
 *   kept as a future-proof branch but never hits on macOS.
 *
 * Uses scutil --nc stop + start with up to 3 retries until the public IP
 * actually changes. Returns true only when connected AND IP changed.
 */
export async function rotateVpnIp(): Promise<boolean> {
  const beforeIp = publicIp();

  // 1. protonvpn-cli if installed (Linux only; future-proof).
  let usedCli = false;
  try {
    execFileSync('which', ['protonvpn-cli'], { encoding: 'utf8', timeout: 5000 });
    execFileSync('protonvpn-cli', ['connect', '--fastest'], { encoding: 'utf8', timeout: 30000 });
    usedCli = true;
  } catch {
    // 2. scutil stop/start with retry.
  }

  if (!usedCli) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        execFileSync('scutil', ['--nc', 'stop', 'ProtonVPN'], { encoding: 'utf8', timeout: 5000 });
      } catch { /* ignore */ }
      await sleep(2000);
      try {
        execFileSync('scutil', ['--nc', 'start', 'ProtonVPN'], { encoding: 'utf8', timeout: 10000 });
      } catch { /* ignore */ }
      await sleep(4000);
      // Check if IP changed already; if so, done.
      if (publicIp() !== beforeIp) break;
    }
  }

  const afterIp = publicIp();
  const changed = afterIp !== beforeIp && afterIp !== '';
  const connected = protonVpnConnected() || usedCli;
  return connected && changed;
}

/**
 * Decide whether the VPN IP should be rotated now, based on the last rotation
 * timestamp and the configured interval (minutes). Pure and unit-testable.
 */
export function shouldRotateVpn(
  lastRotationIso: string | undefined,
  intervalMinutes: number,
  now: number = Date.now(),
): boolean {
  if (intervalMinutes <= 0) return false;
  if (!lastRotationIso) return true;
  return now - new Date(lastRotationIso).getTime() > intervalMinutes * 60_000;
}
