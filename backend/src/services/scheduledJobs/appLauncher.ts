import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger';

/** Argument Electron recognizes as "start without a window to deliver notifications". */
export const BACKGROUND_LAUNCH_ARG = '--michi-background-launch';

/**
 * How long the desktop notifier (Electron main's attention feed) must have
 * been gone before a record wakes the app: longer than the feeds'
 * longest reconnect backoff (15 s), so a notifier that is only reconnecting
 * is never taken for a quit app (DESIGN-v2 §5.1; electron-tray-map §1.9).
 * The attention service waits this long before it wakes the app.
 */
export const NOTIFIER_GRACE_MS = 30_000;

/**
 * The data and config directories the woken app must use: the service's
 * own, so the app it wakes computes the same server id and talks to this
 * backend instead of stopping it as a stranger (DESIGN-v2 §5.1).
 */
export const FORWARDED_ENV_KEYS = ['MICHI_DATA_DIR', 'MICHI_CONFIG_DIR'] as const;

export interface AppLauncher {
  /** Ask the desktop app to start (hidden) so it can show pending notifications. */
  wake(): boolean;
}

type ExecFile = (file: string, args: string[], callback: (error: Error | null) => void) => void;

export interface DesktopAppLauncherOptions {
  bundlePath?: string | null;
  enabled?: boolean;
  platform?: NodeJS.Platform;
  throttleMs?: number;
  clock?: () => number;
  exec?: ExecFile;
  exists?: (file: string) => boolean;
  /** Where FORWARDED_ENV_KEYS are read (default: process.env). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** `--env KEY=value` for each forwarded key that has a usable value. */
function forwardedEnvArgs(env: Readonly<Record<string, string | undefined>>): string[] {
  return FORWARDED_ENV_KEYS.flatMap((key) => {
    const value = env[key];
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\r\n]/.test(value)) return [];
    return ['--env', `${key}=${value}`];
  });
}

/**
 * Only the macOS background service launches the app: the backend itself
 * cannot show clickable notifications, and a forked child exits with the app.
 * One launcher per backend, the attention service's: one wake a minute.
 */
export function createDesktopAppLauncher(options: DesktopAppLauncherOptions = {}): AppLauncher {
  const bundlePath = options.bundlePath ?? process.env.MICHI_APP_BUNDLE ?? null;
  const enabled = options.enabled ?? process.env.MICHI_SERVICE_MODE === '1';
  const platform = options.platform ?? process.platform;
  const throttleMs = options.throttleMs ?? 60_000;
  const clock = options.clock ?? Date.now;
  const env = options.env ?? process.env;
  const exec: ExecFile = options.exec ?? ((file, args, callback) => {
    execFile(file, args, { timeout: 15_000 }, (error) => callback(error));
  });
  const exists = options.exists ?? ((file: string) => fs.existsSync(file));
  let lastWakeAt = Number.NEGATIVE_INFINITY;

  const validBundle = !!bundlePath
    && path.isAbsolute(bundlePath)
    && bundlePath.endsWith('.app')
    && !bundlePath.includes('\0');

  return {
    wake() {
      if (!enabled || platform !== 'darwin' || !validBundle || !exists(bundlePath!)) return false;
      const now = clock();
      if (now - lastWakeAt < throttleMs) return false;
      lastWakeAt = now;
      // -g: do not bring to the foreground. -j: launch hidden. --env: the
      // service's data and config directories. Arguments are passed as an
      // argv array; nothing goes through a shell.
      exec('/usr/bin/open', ['-g', '-j', ...forwardedEnvArgs(env), bundlePath!, '--args', BACKGROUND_LAUNCH_ARG], (error) => {
        if (error) log.warn('scheduler', 'could not wake the desktop app', { error: error.message });
      });
      return true;
    },
  };
}
