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

/** Current Proton VPN server name (from the app's stored preference). */
export function protonVpnServer(): string {
  try {
    const out = execFileSync(
      'defaults',
      ['read', 'ch.protonvpn.mac', 'ConnectedServerNameDoNotUse'],
      { encoding: 'utf8', timeout: 5000 },
    );
    return out.trim();
  } catch {
    return '';
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
 * Strategy (no osascript / app automation — that triggers a TCC permission
 * prompt every time under a non-GUI node process):
 *   1. protonvpn-cli if installed (future-proof; not on macOS today).
 *   2. scutil --nc stop + start (the network-configuration layer; reconnects
 *      to a different server because ProtonVPN's ConnectOnDemand picks a new
 *      fastest server on each connect). Retries up to 3 times until the
 *      public IP or server name actually changes.
 * Returns true only when connected AND the IP or server changed.
 */
export async function rotateVpnIp(): Promise<boolean> {
  const beforeIp = publicIp();
  const beforeServer = protonVpnServer();

  // 1. protonvpn-cli if installed (future-proof).
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
      if (publicIp() !== beforeIp || protonVpnServer() !== beforeServer) break;
    }
  }

  const afterIp = publicIp();
  const afterServer = protonVpnServer();
  const changed = afterIp !== beforeIp || afterServer !== beforeServer;
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
