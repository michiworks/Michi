/**
 * How Michi stays around when its windows are closed (DESIGN-v2 §5.1):
 * `userData/desktop-settings.json`, owned by Electron main, and the
 * DesktopResidency the renderer's settings read and change over
 * `desktop:getResidency` / `desktop:setResidency`.
 *
 * The file holds `{tray:{enabled, hideDockWhenNoWindows, hintShown}}`;
 * "Open Michi at login" is read from the OS each time (the user can change
 * it in the OS's own settings), never stored. "Keep Michi running after you
 * quit" is the background service (backgroundService.ts), not part of it.
 *
 * Nothing here imports `electron`; testable in Node.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DESKTOP_SETTINGS_FILE = 'desktop-settings.json';

export interface DesktopSettings {
  tray: {
    /** Keep Michi in the menu bar / notification area. Default on. */
    enabled: boolean;
    /** macOS: hide the Dock icon while no window is open (only while the icon is up). Default off. */
    hideDockWhenNoWindows: boolean;
    /** The one-time "Michi is still running in …" note was shown. */
    hintShown: boolean;
  };
}

export function defaultDesktopSettings(): DesktopSettings {
  return { tray: { enabled: true, hideDockWhenNoWindows: false, hintShown: false } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Settings from the file's JSON: each field that is not a boolean keeps its default. */
export function parseDesktopSettings(value: unknown): DesktopSettings {
  const settings = defaultDesktopSettings();
  const tray = isRecord(value) && isRecord(value.tray) ? value.tray : {};
  if (typeof tray.enabled === 'boolean') settings.tray.enabled = tray.enabled;
  if (typeof tray.hideDockWhenNoWindows === 'boolean') settings.tray.hideDockWhenNoWindows = tray.hideDockWhenNoWindows;
  if (typeof tray.hintShown === 'boolean') settings.tray.hintShown = tray.hintShown;
  return settings;
}

type FsLike = Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync'>;

/** The stored settings; the defaults when the file is missing or unreadable. */
export function readDesktopSettings(file: string, fsLike: FsLike = fs): DesktopSettings {
  try {
    return parseDesktopSettings(JSON.parse(fsLike.readFileSync(file, 'utf8')));
  } catch {
    return defaultDesktopSettings();
  }
}

/** Written whole through a temporary file, so a crash never leaves half a file. */
export function writeDesktopSettings(file: string, settings: DesktopSettings, fsLike: FsLike = fs): void {
  fsLike.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fsLike.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  fsLike.renameSync(temporary, file);
}

/**
 * A change Michi makes on its own from an event handler (the one-time note
 * was shown): a write that fails (no permission, a full disk) goes to
 * `onError` instead of being thrown where nothing catches it, which Electron
 * would show as a main-process error dialog. Returns whether it was written.
 */
export function writeDesktopSettingsQuietly(file: string, settings: DesktopSettings, onError: (error: Error) => void, fsLike: FsLike = fs): boolean {
  try {
    writeDesktopSettings(file, settings, fsLike);
    return true;
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

// ── DesktopResidency: a mirror of shared/src/desktopContracts.ts (main.ts checks it fits) ──

export interface ResidencySetting {
  supported: boolean;
  enabled: boolean;
}

export interface Residency {
  tray: ResidencySetting;
  hideDock: ResidencySetting;
  openAtLogin: ResidencySetting;
  reason?: string;
}

export interface ResidencyPatch {
  tray?: boolean;
  hideDock?: boolean;
  openAtLogin?: boolean;
}

export interface ResidencyEnv {
  platform: string;
  /** An installed (electron-builder) build, not `electron:dev`. */
  packaged: boolean;
  /** The OS's login item for Michi, read just now; null where Michi offers none. */
  openAtLogin: boolean | null;
}

/** The icon exists on macOS (menu bar) and Windows (notification area); other platforms are no build target. */
export function traySupported(platform: string): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/** "Open Michi at login" is Windows-only, and only in the installed app: a dev build would register the bare Electron binary. */
export function openAtLoginSupported(env: Pick<ResidencyEnv, 'platform' | 'packaged'>): boolean {
  return env.platform === 'win32' && env.packaged;
}

export function desktopResidency(settings: DesktopSettings, env: ResidencyEnv): Residency {
  const tray = traySupported(env.platform);
  const login = openAtLoginSupported(env);
  let reason: string | undefined;
  if (!tray) reason = 'The menu bar icon is available on macOS and Windows.';
  else if (env.platform === 'win32' && !login) reason = 'Opening Michi at login is available in the installed app.';
  return {
    tray: { supported: tray, enabled: tray && settings.tray.enabled },
    hideDock: { supported: env.platform === 'darwin', enabled: env.platform === 'darwin' && settings.tray.hideDockWhenNoWindows },
    openAtLogin: { supported: login, enabled: login && env.openAtLogin === true },
    ...(reason ? { reason } : {}),
  };
}

const PATCH_KEYS = new Set(['tray', 'hideDock', 'openAtLogin']);

/** A `desktop:setResidency` argument: an object of booleans for the known switches, nothing else. */
export function parseResidencyPatch(value: unknown): ResidencyPatch {
  if (!isRecord(value)) throw new Error('The residency change must be an object.');
  const patch: ResidencyPatch = {};
  for (const [key, flag] of Object.entries(value)) {
    if (!PATCH_KEYS.has(key)) throw new Error(`Unknown residency setting: ${key}`);
    if (typeof flag !== 'boolean') throw new Error(`${key} must be true or false.`);
    patch[key as keyof ResidencyPatch] = flag;
  }
  return patch;
}

export interface ResidencyChange {
  settings: DesktopSettings;
  /** Set the OS login item to this; absent when the patch leaves it alone. */
  openAtLogin?: boolean;
}

/** The settings after `patch`, and the login item to set; a switch this install does not offer is refused, so nothing is changed. */
export function applyResidencyPatch(settings: DesktopSettings, patch: ResidencyPatch, env: Pick<ResidencyEnv, 'platform' | 'packaged'>): ResidencyChange {
  if (patch.tray !== undefined && !traySupported(env.platform)) throw new Error('The menu bar icon is not available here.');
  if (patch.hideDock !== undefined && env.platform !== 'darwin') throw new Error('Hiding the Dock icon is available on macOS.');
  if (patch.openAtLogin !== undefined && !openAtLoginSupported(env)) throw new Error('Opening Michi at login is available in the installed Windows app.');
  const next: DesktopSettings = { tray: { ...settings.tray } };
  if (patch.tray !== undefined) next.tray.enabled = patch.tray;
  if (patch.hideDock !== undefined) next.tray.hideDockWhenNoWindows = patch.hideDock;
  return { settings: next, ...(patch.openAtLogin !== undefined ? { openAtLogin: patch.openAtLogin } : {}) };
}
