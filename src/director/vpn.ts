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

/** Relaunch the ProtonVPN app (AppleScript quit + reopen) to force a new server. */
export async function relaunchProtonVpnApp(): Promise<boolean> {
  try {
    execFileSync('osascript', ['-e', 'tell application "ProtonVPN" to quit'], {
      encoding: 'utf8', timeout: 10000,
    });
    await sleep(2000);
    execFileSync('open', ['-a', 'ProtonVPN'], { encoding: 'utf8', timeout: 10000 });
    await sleep(5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rotate Proton VPN IP, preferring the ProtonVPN app itself over raw scutil
 * stop/start: use protonvpn-cli if installed, else relaunch the app (the
 * macOS app has no CLI; relaunching reconnects via ConnectOnDemand). Fall
 * back to scutil --nc start to ensure the connection service is up.
 * Returns true only when connected AND the IP or server actually changed.
 */
export async function rotateVpnIp(): Promise<boolean> {
  const beforeIp = publicIp();
  const beforeServer = protonVpnServer();

  // 1. protonvpn-cli if installed (future-proof; not on macOS today).
  let usedCli = false;
  try {
    execFileSync('which', ['protonvpn-cli'], { encoding: 'utf8', timeout: 5000 });
    execFileSync('protonvpn-cli', ['connect', '--fastest'], { encoding: 'utf8', timeout: 30000 });
    usedCli = true;
  } catch {
    // 2. ProtonVPN app relaunch.
    await relaunchProtonVpnApp();
  }

  // Ensure the connection service is up (the app may reconnect on its own).
  if (!protonVpnConnected()) {
    try {
      execFileSync('scutil', ['--nc', 'start', 'ProtonVPN'], { encoding: 'utf8', timeout: 10000 });
    } catch {
      // ignore; verification below decides the outcome
    }
  }
  await sleep(3000);

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
