import type {
  BackgroundServiceStatus, BrowserSurfaceState, CompanionChangedEvent, CompanionNotice as SharedCompanionNotice,
  CompanionTarget as SharedCompanionTarget, CompanionTrayDto, DesktopCommandContract, DesktopEventContract, DesktopInvokeContract,
  DesktopBootstrapParam, DesktopInvokeArgs, DesktopInvokeResult, DesktopResidency, DesktopResidencyPatch, MichiBackendHealth,
  ScheduledRunTarget, TerminalSurfaceSnapshot, VibrancyMaterial,
} from 'michi-shared';
import { app, BrowserWindow, Menu, Tray, WebContentsView, ipcMain, dialog, shell, nativeImage, nativeTheme, powerSaveBlocker, powerMonitor, Notification as ElectronNotification } from 'electron';
import type { NativeImage } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';
import { execFile, fork, ChildProcess } from 'child_process';
import {
  isStartupTraceLine,
  startupMark,
  startupRunId,
  startupTraceEnabled,
  startupTraceFileQuery,
  withStartupTraceQuery,
} from './startupTrace';
import { checkForUpdate, getUpdateState, downloadUpdate, installUpdate, initAutoUpdate, stopAutoUpdate } from './autoUpdate';
import { forwardedShellChord, isClosePaneShortcut } from './paneShortcuts';
import { listWorkspaceDirectory, resolveAllowedDirectory } from './workspaceFiles';
import { applyBrowserTheme, normalizeBrowserTheme, type BrowserTheme } from './browserTheme';
import { toSurfaceBounds } from './browserBounds';
import { remoteAuthenticationProcess } from './remoteAuthentication';
import { SIGN_IN_COMMANDS } from './remoteCredentials';
import {
  appBundlePath,
  buildServiceLaunchSpec,
  desktopBackendEnv,
  expectedServerId,
  installAndStartService,
  michiDotenvPath,
  readDotenvFile,
  readServiceState,
  runLaunchctl,
  serviceBuildStamp,
  servicePaths,
  stopService,
  writeServiceState,
} from './backgroundService';
import { planNoticeDelivery, ScheduledNotificationFeed, type ScheduledRunNotice } from './scheduledNotifications';
import {
  HIDDEN_LAUNCH_ARG,
  PACKAGED_TRAY_ICON_NAME,
  TRAY_MENU,
  WindowsLifetimeController,
  isOwnedLifetimeSender,
  packagedTrayIconPath,
} from './windowsLifecycle';
import { createNotificationHolder, parseNotificationRequest } from './rendererNotifications';
import {
  COMPANION_READY_CHANNEL,
  COMPANION_TARGET_PARAM,
  CompanionNotificationFeed,
  CompanionNotifier,
  CompanionRenderers,
  companionNoticeChannel,
  type CompanionChangedFrame,
  type CompanionNoticeChannel,
  type CompanionTarget,
} from './companionNotifications';
import { appendLogLine, formatLogLine } from './logFile';
import { mergeFeatureList, michiDisabledFeatures } from './chromiumFeatures';
import { readWindowGlass, writeWindowGlass } from './windowGlass';
import { backdropCaptureBounds, backdropImageWidth } from './backdropCapture';
import {
  APP_USER_MODEL_ID,
  BACKGROUND_LAUNCH_ARG,
  LOGIN_LAUNCH_ARG,
  TrayController,
  TrayIconSlot,
  relaunchArgs,
  startupMode,
  startupModeAfterTray,
  stillRunningHint,
  trayClickBehavior,
  trayGuid,
  trayIconFile,
  trayMenuTemplate,
  trayTooltip,
  windowAllClosedAction,
  type TrayAction,
  type TrayCompanionDto,
} from './tray';
import {
  DESKTOP_SETTINGS_FILE,
  applyResidencyPatch,
  desktopResidency,
  parseResidencyPatch,
  readDesktopSettings,
  traySupported,
  writeDesktopSettings,
  writeDesktopSettingsQuietly,
  type DesktopSettings,
  type Residency,
  type ResidencyPatch,
} from './desktopSettings';

// The mirrors Electron main keeps of shared contracts (it loads no workspace
// package at runtime) must still fit them: the tray reads every
// CompanionTrayDto the backend sends, the notifier feed every change frame,
// notice gate and target, and the residency is the bridge's.
type Fits<T extends U, U> = T;
type MirrorsFitTheirContracts = [
  Fits<CompanionTrayDto, TrayCompanionDto>,
  Fits<CompanionChangedEvent, CompanionChangedFrame>,
  // The gate a notice came through, both ways: a gate the backend adds must reach this mirror.
  Fits<NonNullable<SharedCompanionNotice['channel']>, CompanionNoticeChannel>,
  Fits<CompanionNoticeChannel, NonNullable<SharedCompanionNotice['channel']>>,
  Fits<SharedCompanionTarget, CompanionTarget>,
  Fits<Residency, DesktopResidency>,
  Fits<DesktopResidencyPatch, ResidencyPatch>,
];

// Patch PATH from the user's login shell so the forked backend can find
// kiro-cli (common macOS issue when launched from Finder). fix-path v5 is
// ESM-only; use dynamic import so our CommonJS build doesn't fail at require.
(async () => {
  try {
    const mod = await import('fix-path');
    (mod.default ?? (mod as unknown as () => void))();
  } catch {
    /* best effort */
  }
})();

function handleDesktopInvoke<K extends keyof DesktopInvokeContract>(
  channel: K,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: DesktopInvokeArgs<K>) => DesktopInvokeResult<K> | Promise<DesktopInvokeResult<K>>,
): void {
  ipcMain.handle(channel, handler);
}

function sendDesktopEvent<K extends keyof DesktopEventContract>(target: Pick<Electron.WebContents, 'send'>, channel: K, ...args: DesktopEventContract[K]): void {
  target.send(channel, ...args);
}
function onDesktopCommand<K extends keyof DesktopCommandContract>(
  channel: K,
  handler: (event: Electron.IpcMainEvent, ...args: DesktopCommandContract[K]) => void,
): void {
  ipcMain.on(channel, handler);
}

const isDev = process.env.ELECTRON_DEV === '1';

// Bare Electron uses one global userData directory by default. Without an
// override, a dev process from another checkout owns the single-instance lock
// and receives this checkout's second-instance event. Keep each checkout's
// localStorage/session/lock isolated; packaged Michi retains its normal path.
if (isDev && process.env.MICHI_ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.MICHI_ELECTRON_USER_DATA_DIR));
}

// True window vibrancy (see-through to desktop / other apps behind Michi) is a
// native macOS NSVisualEffectView feature. Off on Windows/Linux (no equivalent)
// and can be force-disabled with MICHI_NO_VIBRANCY=1 for debugging. The renderer
// reads this via the `michiVibrancy` URL query param (injected by createWindow)
// so it can punch the sidebar hole only when the window base is actually the
// vibrancy material — main authoritatively owns the flag so the CSS never
// assumes see-through the window doesn't have.
const VIBRANCY_ENABLED = process.platform === 'darwin' && process.env.MICHI_NO_VIBRANCY !== '1';

// Whether windows use that vibrancy now. Settings → Appearance → Window glass
// switches it live and main saves it for the next launch (windowGlass.ts).
// The renderer learns the starting state from `michiGlass=0` in the URL.
function windowGlassFile(): string {
  return path.join(app.getPath('userData'), 'window-glass.json');
}
let windowGlass = VIBRANCY_ENABLED && readWindowGlass(windowGlassFile());
// The material the renderer last chose (Settings), kept while glass is off.
let vibrancyMaterial: VibrancyMaterial = 'under-window';

// Minimal skeleton HTML shown immediately while the backend starts. Matches
// the app's warm light / dark background so the transition to the real UI is
// seamless. Loaded via data: URL — no network, no disk read.
const SKELETON_HTML = `<!DOCTYPE html>
<html style="margin:0;height:100%">
<head><meta charset="utf-8"><title>Michi</title></head>
<body style="margin:0;height:100%;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  background:${windowGlass ? 'transparent' : '#F5F2EE'};color:#8B7E74;font-size:13px">
<div style="opacity:0.6">loading…</div>
</body></html>`;

// Replaces the skeleton once the backend has missed its first health
// deadline (see BackendBoot). A window on this page still loads the UI if the
// backend answers later, so the text promises nothing more than that.
function backendFailedHtml(): string {
  const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!DOCTYPE html>
<html style="margin:0;height:100%">
<head><meta charset="utf-8"><title>Michi</title></head>
<body style="margin:0;height:100%;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  background:${VIBRANCY_ENABLED ? 'transparent' : '#F5F2EE'};color:#8B7E74;font-size:13px;line-height:1.5">
<div style="max-width:440px;padding:24px">
<p style="margin:0 0 6px;font-weight:600">Michi's backend did not start.</p>
<p style="margin:0">If it starts later, Michi opens here. The logs are in ${escapeHtml(LOG_DIR)}.</p>
</div>
</body></html>`;
}

// Capture once at load — Electron may not chdir, but be defensive.
// `bin/michi` forwards the shell's pwd via `open --env MICHI_LAUNCH_CWD=…`
// because `open` doesn't inherit cwd. Direct `electron …` invocations
// fall back to process.cwd(). Finder launches give "/".
const LAUNCH_CWD = process.env.MICHI_LAUNCH_CWD || process.cwd();
startupMark('electron_main_start', { isDev, launchCwd: LAUNCH_CWD });

// Power-save blocker — prevents macOS/Windows from sleeping while Michi is
// running (useful during long agent sessions). Controlled exclusively via
// ~/.michi/config.json top-level key "preventSleep": true. No UI toggle.
let powerSaveBlockerId: number | null = null;

function readPreventSleep(): boolean {
  try {
    const cfgPath = path.join(os.homedir(), '.michi', 'config.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return raw?.preventSleep === true;
  } catch {
    return false;
  }
}

function applyPowerSaveBlocker(): void {
  const wanted = readPreventSleep();
  if (wanted && powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    elog('INFO', 'power', 'powerSaveBlocker started', { id: powerSaveBlockerId });
  } else if (!wanted && powerSaveBlockerId !== null) {
    powerSaveBlocker.stop(powerSaveBlockerId);
    elog('INFO', 'power', 'powerSaveBlocker stopped', { id: powerSaveBlockerId });
    powerSaveBlockerId = null;
  }
}

// Lifecycle log dir — same root as the SQLite store (~/.michi/) so a single
// "open log folder" button can take the user to everything they need to
// attach when reporting a startup issue. Override via MICHI_LOG_DIR for
// tests / debugging.
const LOG_DIR = process.env.MICHI_LOG_DIR || path.join(os.homedir(), '.michi', 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* falls back to stdout */ }
const ELECTRON_LOG = path.join(LOG_DIR, 'electron-main.log');

function elog(level: 'INFO' | 'WARN' | 'ERROR', stage: string, msg: string, meta?: Record<string, unknown>): void {
  const line = formatLogLine(new Date().toISOString(), level, stage, msg, meta);
  appendLogLine(ELECTRON_LOG, line);
  if (level === 'ERROR') process.stderr.write(line);
  else process.stdout.write(line);
}

const windows = new Set<BrowserWindow>();
const restoredWindows = new WeakSet<BrowserWindow>();
const windowSlots = new WeakMap<BrowserWindow, number>();
let nextWindowSlot = 0;
let backendChild: ChildProcess | null = null;
let resolvedBackendPort: number | null = null;
/** child: forked with the app. service: launchd LaunchAgent. external: dev server. */
let backendMode: 'child' | 'service' | 'external' = 'child';

/**
 * The backend's boot, as windows see it. `starting` until the backend has a
 * port and first answers /api/health (dev and unbundled launches have no
 * health to wait for); then `ready`. `failed` when startup threw, or when
 * that first answer missed its deadline; watchBackendBoot then keeps
 * checking, so a slow backend can still make it `ready`. Only
 * setBackendBoot changes it, along BACKEND_BOOT_MOVES. A production window
 * shows the skeleton, then the failure page, and loads the UI only once
 * boot is `ready`: none loads the offline UI because the port is still
 * unknown, nor a backend that does not answer yet.
 */
type BackendBoot = 'starting' | 'ready' | 'failed';
const BACKEND_BOOT_MOVES: Record<BackendBoot, readonly BackendBoot[]> = {
  starting: ['ready', 'failed'],
  failed: ['ready'],
  ready: [],
};
let backendBoot: BackendBoot = 'starting';
const backendBootListeners = new Set<() => void>();

function setBackendBoot(next: BackendBoot): void {
  if (!BACKEND_BOOT_MOVES[backendBoot].includes(next)) return;
  backendBoot = next;
  for (const listener of [...backendBootListeners]) listener();
}

/** Resolves with boot's state once it is one of `states`. */
function whenBackendBoot(states: readonly BackendBoot[]): Promise<BackendBoot> {
  if (states.includes(backendBoot)) return Promise.resolve(backendBoot);
  return new Promise((resolve) => {
    const listener = () => {
      if (!states.includes(backendBoot)) return;
      backendBootListeners.delete(listener);
      resolve(backendBoot);
    };
    backendBootListeners.add(listener);
  });
}

/** False until boot has opened its own window (or decided on none); see the 'activate' handler. */
let bootWindowDecided = false;

/** Set at will-quit, once every window has closed and the app is really ending. */
let appQuitting = false;

// The background service launches the app with this flag so it can deliver
// notifications without opening a window (see backend appLauncher.ts).
const launchedInBackground = process.argv.includes(BACKGROUND_LAUNCH_ARG);
const launchedHidden = process.argv.includes(HIDDEN_LAUNCH_ARG);
/**
 * A background launch the user has since touched (opened a window): from
 * then on it is an ordinary instance, with the tray icon and no idle quit.
 */
let backgroundEngaged = false;
/** Background launches quit after this long without any window. */
const BACKGROUND_IDLE_QUIT_MS = 15 * 60_000;

const MAX_TERMINAL_REPLAY_CHARS = 1024 * 1024;

interface TerminalSurface {
  ownerId: number;
  process: pty.IPty;
  replay: string;
  exited: boolean;
  exitCode?: number;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
}

interface BrowserSurface {
  ownerId: number;
  host: BrowserWindow;
  view: WebContentsView;
  surfaceId: string;
  error?: string;
}

const terminalSurfaces = new Map<string, TerminalSurface>();
const browserSurfaces = new Map<string, BrowserSurface>();
let currentBrowserTheme: BrowserTheme = normalizeBrowserTheme(nativeTheme.shouldUseDarkColors, undefined);

function surfaceKey(ownerId: number, surfaceId: string): string {
  return `${ownerId}:${surfaceId}`;
}

function validSurfaceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
}

function normalizeSurfaceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function browserState(surface: BrowserSurface): BrowserSurfaceState {
  const contents = surface.view.webContents;
  return {
    surfaceId: surface.surfaceId,
    url: contents.getURL(),
    title: contents.getTitle(),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    ...(surface.error ? { error: surface.error } : {}),
  };
}

function emitBrowserState(surface: BrowserSurface): void {
  if (!surface.host.isDestroyed()) {
    sendDesktopEvent(surface.host.webContents, 'browser:state', browserState(surface));
  }
}

async function syncBrowserTheme(surface: BrowserSurface): Promise<void> {
  try {
    await applyBrowserTheme(surface.view, currentBrowserTheme);
  } catch (error) {
    elog('WARN', 'browser', 'failed to apply browser color scheme', {
      surfaceId: surface.surfaceId,
      colorScheme: currentBrowserTheme.colorScheme,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function destroyBrowserSurface(key: string): void {
  const surface = browserSurfaces.get(key);
  if (!surface) return;
  browserSurfaces.delete(key);
  try { surface.host.contentView.removeChildView(surface.view); } catch { /* already detached */ }
  try { surface.view.webContents.close(); } catch { /* already destroyed */ }
}

function destroyTerminalSurface(key: string): void {
  const surface = terminalSurfaces.get(key);
  if (!surface) return;
  terminalSurfaces.delete(key);
  if (surface.flushTimer) clearTimeout(surface.flushTimer);
  try { surface.process.kill(); } catch { /* already exited */ }
}

function destroyOwnedSurfaces(ownerId: number): void {
  for (const [key, surface] of terminalSurfaces) {
    if (surface.ownerId === ownerId) destroyTerminalSurface(key);
  }
  for (const [key, surface] of browserSurfaces) {
    if (surface.ownerId === ownerId) destroyBrowserSurface(key);
  }
}

function createTerminalSurface(event: Electron.IpcMainInvokeEvent, surfaceId: unknown, cwd: unknown, cols: unknown, rows: unknown, authentication?: unknown): TerminalSurfaceSnapshot {
  if (!validSurfaceId(surfaceId)) throw new Error('Invalid terminal surface id');
  const key = surfaceKey(event.sender.id, surfaceId);
  const existing = terminalSurfaces.get(key);
  if (existing) {
    return { surfaceId, data: existing.replay, exited: existing.exited, exitCode: existing.exitCode };
  }
  const requestedCwd = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : os.homedir();
  const safeCwd = (() => {
    try { return fs.statSync(requestedCwd).isDirectory() ? requestedCwd : os.homedir(); }
    catch { return os.homedir(); }
  })();
  const shellPath = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const auth = authentication === undefined ? undefined : remoteAuthenticationProcess(authentication, SIGN_IN_COMMANDS);
  const processHandle = pty.spawn(auth?.binary ?? shellPath, auth?.args ?? (process.platform === 'win32' ? [] : ['-l']), {
    name: 'xterm-256color',
    cols: typeof cols === 'number' ? Math.max(2, Math.floor(cols)) : 80,
    rows: typeof rows === 'number' ? Math.max(1, Math.floor(rows)) : 24,
    cwd: safeCwd,
    env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  const surface: TerminalSurface = {
    ownerId: event.sender.id,
    process: processHandle,
    replay: '',
    exited: false,
    pending: '',
    flushTimer: null,
  };
  terminalSurfaces.set(key, surface);
  processHandle.onData((data) => {
    // Authentication output is ephemeral and never enters terminal replay/logs.
    if (!auth) surface.replay = (surface.replay + data).slice(-MAX_TERMINAL_REPLAY_CHARS);
    surface.pending += data;
    if (surface.flushTimer) return;
    surface.flushTimer = setTimeout(() => {
      surface.flushTimer = null;
      const chunk = surface.pending;
      surface.pending = '';
      if (!event.sender.isDestroyed() && chunk) sendDesktopEvent(event.sender, 'terminal:data', surfaceId, chunk);
    }, 8);
  });
  processHandle.onExit(({ exitCode }) => {
    if (surface.flushTimer) { clearTimeout(surface.flushTimer); surface.flushTimer = null; }
    if (!event.sender.isDestroyed() && surface.pending) sendDesktopEvent(event.sender, 'terminal:data', surfaceId, surface.pending);
    surface.pending = '';
    surface.exited = true;
    surface.exitCode = exitCode;
    if (!event.sender.isDestroyed()) sendDesktopEvent(event.sender, 'terminal:exit', surfaceId, exitCode);
  });
  return { surfaceId, data: '', exited: false };
}

handleDesktopInvoke('terminal:create', (event, surfaceId, cwd, cols, rows) => createTerminalSurface(event, surfaceId, cwd, cols, rows));
handleDesktopInvoke('remote-auth:create', (event, surfaceId, target, cols, rows) => {
  remoteAuthenticationProcess(target, SIGN_IN_COMMANDS);
  return createTerminalSurface(event, surfaceId, os.homedir(), cols, rows, target);
});

onDesktopCommand('terminal:write', (event, surfaceId: unknown, data: unknown) => {
  if (!validSurfaceId(surfaceId) || typeof data !== 'string') return;
  const surface = terminalSurfaces.get(surfaceKey(event.sender.id, surfaceId));
  if (surface && !surface.exited) surface.process.write(data);
});

onDesktopCommand('terminal:resize', (event, surfaceId: unknown, cols: unknown, rows: unknown) => {
  if (!validSurfaceId(surfaceId) || typeof cols !== 'number' || typeof rows !== 'number') return;
  const surface = terminalSurfaces.get(surfaceKey(event.sender.id, surfaceId));
  if (!surface || surface.exited) return;
  try { surface.process.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows))); } catch { /* process exited */ }
});

onDesktopCommand('terminal:destroy', (event, surfaceId: unknown) => {
  if (validSurfaceId(surfaceId)) destroyTerminalSurface(surfaceKey(event.sender.id, surfaceId));
});

handleDesktopInvoke('browser:create', async (event, surfaceId: unknown, projectId: unknown, rawUrl: unknown) => {
  if (!validSurfaceId(surfaceId)) throw new Error('Invalid browser surface id');
  const url = normalizeSurfaceUrl(rawUrl);
  if (!url) throw new Error('Only HTTP(S) URLs are supported');
  const host = BrowserWindow.fromWebContents(event.sender);
  if (!host) throw new Error('Browser host window not found');
  const key = surfaceKey(event.sender.id, surfaceId);
  let surface = browserSurfaces.get(key);
  if (!surface) {
    const partitionSuffix = String(projectId ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `persist:michi-browser-${partitionSuffix}`,
      },
    });
    surface = { ownerId: event.sender.id, host, view, surfaceId };
    browserSurfaces.set(key, surface);
    host.contentView.addChildView(view);
    view.setVisible(false);
    // A brand-new WebContentsView does not have a fully initialized CDP target
    // until its first navigation. Prime it before registering state listeners
    // so the internal about:blank never leaks into renderer pane metadata.
    view.setBackgroundColor(currentBrowserTheme.backgroundColor);
    await view.webContents.loadURL('about:blank');
    await syncBrowserTheme(surface);
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
      const next = normalizeSurfaceUrl(popupUrl);
      if (next) void view.webContents.loadURL(next);
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (navEvent, target) => {
      if (!normalizeSurfaceUrl(target)) navEvent.preventDefault();
    });
    const syncState = () => {
      surface!.error = undefined;
      emitBrowserState(surface!);
    };
    view.webContents.on('did-start-loading', syncState);
    view.webContents.on('did-stop-loading', syncState);
    view.webContents.on('did-navigate', syncState);
    view.webContents.on('did-navigate-in-page', syncState);
    view.webContents.on('page-title-updated', syncState);
    view.webContents.on('focus', () => {
      if (!host.isDestroyed()) sendDesktopEvent(host.webContents, 'browser:focus', surfaceId);
    });
    view.webContents.on('before-input-event', (inputEvent, input) => {
      if (isClosePaneShortcut(input)) {
        inputEvent.preventDefault();
        if (!host.isDestroyed()) sendDesktopEvent(host.webContents, 'browser:close-request', surfaceId);
        return;
      }
      const chord = forwardedShellChord(input);
      if (!chord) return;
      inputEvent.preventDefault();
      if (host.isDestroyed()) return;
      // Each forwarded chord moves the user to the shell; the renderer's own
      // focus() cannot take keyboard focus back from a native view.
      host.webContents.focus();
      sendDesktopEvent(host.webContents, 'browser:shortcut', surfaceId, chord);
    });
    view.webContents.on('did-fail-load', (_loadEvent, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      surface!.error = `${description} (${code})`;
      emitBrowserState(surface!);
      elog('WARN', 'browser', 'surface navigation failed', { failedUrl, code, description });
    });
  }
  if (surface.view.webContents.getURL() !== url) await surface.view.webContents.loadURL(url);
  return browserState(surface);
});

handleDesktopInvoke('browser:navigate', async (event, surfaceId: unknown, rawUrl: unknown) => {
  if (!validSurfaceId(surfaceId)) throw new Error('Invalid browser surface id');
  const url = normalizeSurfaceUrl(rawUrl);
  if (!url) throw new Error('Only HTTP(S) URLs are supported');
  const surface = browserSurfaces.get(surfaceKey(event.sender.id, surfaceId));
  if (!surface) throw new Error('Browser surface not found');
  surface.error = undefined;
  await surface.view.webContents.loadURL(url);
  return browserState(surface);
});

onDesktopCommand('browser:set-bounds', (event, surfaceId: unknown, value: unknown, visible: unknown) => {
  if (!validSurfaceId(surfaceId)) return;
  const surface = browserSurfaces.get(surfaceKey(event.sender.id, surfaceId));
  if (!surface) return;
  // The renderer sends CSS pixels; setBounds takes window points. Scale by the
  // sending window's current zoom so View > Zoom In/Out cannot misplace the view.
  const bounds = toSurfaceBounds(value, event.sender.getZoomFactor());
  if (!bounds) return;
  const nowVisible = visible === true && bounds.width > 1 && bounds.height > 1;
  // Always set bounds BEFORE visibility so the view lands in the right place
  // when transitioning to visible. Then re-apply AFTER setVisible for safety —
  // Electron may not reliably apply setBounds to a hidden view (see #39993).
  surface.view.setBounds(bounds);
  surface.view.setVisible(nowVisible);
  if (nowVisible) {
    // Re-apply after setVisible(true) ensures the compositor has the correct
    // position even if the first setBounds was a no-op on a hidden view.
    surface.view.setBounds(bounds);
  }
});

for (const [channel, action] of [
  ['browser:back', 'back'],
  ['browser:forward', 'forward'],
  ['browser:reload', 'reload'],
  ['browser:stop', 'stop'],
] as const) {
  onDesktopCommand(channel, (event, surfaceId: unknown) => {
    if (!validSurfaceId(surfaceId)) return;
    const surface = browserSurfaces.get(surfaceKey(event.sender.id, surfaceId));
    if (!surface) return;
    const contents = surface.view.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'stop') contents.stop();
  });
}

onDesktopCommand('browser:destroy', (event, surfaceId: unknown) => {
  if (validSurfaceId(surfaceId)) destroyBrowserSurface(surfaceKey(event.sender.id, surfaceId));
});

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? windows.values().next().value ?? null;
}

interface WindowState {
  width: number;
  height: number;
  isMaximized: boolean;
}

const DEFAULT_WINDOW_STATE: WindowState = { width: 1600, height: 1000, isMaximized: false };
const MIN_PERSISTED_WIDTH = 1000;
const MIN_PERSISTED_HEIGHT = 700;

function windowStateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function coerceWindowState(value: unknown): WindowState {
  if (value && typeof value === 'object') {
    const p = value as Record<string, unknown>;
    const w = typeof p.width === 'number' ? p.width : NaN;
    const h = typeof p.height === 'number' ? p.height : NaN;
    if (Number.isFinite(w) && Number.isFinite(h) && w >= MIN_PERSISTED_WIDTH && h >= MIN_PERSISTED_HEIGHT) {
      return {
        width: Math.round(w),
        height: Math.round(h),
        isMaximized: !!p.isMaximized,
      };
    }
  }
  return DEFAULT_WINDOW_STATE;
}

function loadWindowStates(): WindowState[] {
  try {
    const raw = fs.readFileSync(windowStateFile(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(coerceWindowState);
    if (parsed && typeof parsed === 'object') return [coerceWindowState(parsed)];
  } catch {
    /* fall through to defaults */
  }
  return [];
}

function loadWindowState(slot: number): WindowState {
  return loadWindowStates()[slot] ?? DEFAULT_WINDOW_STATE;
}

function captureWindowState(win: BrowserWindow): WindowState | null {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getNormalBounds();
  return {
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
  };
}

function writeWindowStateForSlot(slot: number, state: WindowState): void {
  try {
    const states = loadWindowStates();
    while (states.length <= slot) states.push(DEFAULT_WINDOW_STATE);
    states[slot] = state;
    const file = windowStateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(states));
  } catch {
    /* best effort */
  }
}

const windowStateSaveTimers = new WeakMap<BrowserWindow, NodeJS.Timeout>();
function scheduleSaveWindowState(win: BrowserWindow): void {
  const existing = windowStateSaveTimers.get(win);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    windowStateSaveTimers.delete(win);
    const state = captureWindowState(win);
    const slot = windowSlots.get(win);
    if (state && slot !== undefined) writeWindowStateForSlot(slot, state);
  }, 300);
  windowStateSaveTimers.set(win, timer);
}

function flushWindowState(win: BrowserWindow): void {
  const existing = windowStateSaveTimers.get(win);
  if (existing) {
    clearTimeout(existing);
    windowStateSaveTimers.delete(win);
  }
  const state = captureWindowState(win);
  const slot = windowSlots.get(win);
  if (state && slot !== undefined) writeWindowStateForSlot(slot, state);
}

function parsePort(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return null;
  return n;
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

const PORT_FILE = path.join(os.homedir(), '.michi', 'backend-port');

async function chooseBackendPort(): Promise<number> {
  const envPort = parsePort(process.env.MICHI_PORT) ?? parsePort(process.env.PORT);
  if (envPort) return envPort;

  // Reuse the previously persisted port so the origin stays stable and
  // localStorage (prefs, workspace state) survives across restarts.
  try {
    const saved = parsePort(fs.readFileSync(PORT_FILE, 'utf8').trim());
    if (saved && await isPortAvailable(saved)) return saved;
  } catch { /* no saved port or unreadable — pick a new one */ }

  const port = await findAvailablePort();
  try { fs.writeFileSync(PORT_FILE, String(port), 'utf8'); } catch { /* best-effort */ }
  return port;
}

/** How long boot waits for the backend's first /api/health; MICHI_BACKEND_HEALTH_TIMEOUT_MS overrides it. */
const BOOT_HEALTH_TIMEOUT_MS = parsePositiveInt(process.env.MICHI_BACKEND_HEALTH_TIMEOUT_MS) ?? 15_000;

function parsePositiveInt(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function waitForBackend(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Backend did not become ready on port ${port}`));
        return;
      }
      setTimeout(attempt, 150);
    };

    const attempt = () => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/api/health', timeout: 1000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry();
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', retry);
    };

    attempt();
  });
}

/**
 * Boot's wait for the backend's first answer: `ready` when it comes in time,
 * `failed` at the deadline. A slow first start (a long migration, a cold
 * disk) can still finish after that, so it keeps checking once a second
 * until the backend answers or the app quits.
 */
async function watchBackendBoot(port: number): Promise<void> {
  startupMark('backend_health_wait_start', { port });
  try {
    await waitForBackend(port, BOOT_HEALTH_TIMEOUT_MS);
    elog('INFO', 'boot', 'backend ready', { port });
    startupMark('backend_health_ready', { port });
    setBackendBoot('ready');
    return;
  } catch (err) {
    elog('ERROR', 'boot', 'backend did not become ready', { port, err: (err as Error).message });
    startupMark('backend_health_failed', { port, error: (err as Error).message });
    setBackendBoot('failed');
  }
  while (!appQuitting && backendBoot === 'failed') {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const current = resolvedBackendPort;
    if (appQuitting || current === null) return;
    if (await probeHealth(current, 1_000)) {
      elog('INFO', 'boot', 'backend ready after its deadline', { port: current });
      setBackendBoot('ready');
    }
  }
}

function resolveBackendEntry(): string | null {
  // In dev mode backend runs via nodemon externally; don't fork.
  if (isDev) return null;
  // In packaged prod, app.getAppPath() resolves inside the asar.
  const candidate = path.join(app.getAppPath(), 'backend', 'dist', 'server.js');
  if (!fs.existsSync(candidate)) return null;
  return candidate;
}

/**
 * Fork the backend child and return the port immediately — does NOT wait for
 * /api/health. Callers that need readiness should follow up with
 * waitForBackend(port). This split lets us show a skeleton window in parallel
 * with backend startup.
 */
async function forkBackend(): Promise<number | null> {
  const entry = resolveBackendEntry();
  if (!entry) {
    startupMark('backend_external_dev', { isDev });
    return null;
  }
  const port = await chooseBackendPort();

  // ~/.michi/.env keeps runtime API keys in one place whatever launched the
  // app (terminal, Dock, Spotlight). Explicit env vars and launchctl setenv
  // still take precedence over it.
  const userDotenv = readDotenvFile(michiDotenvPath());
  const userDotenvKeys = Object.keys(userDotenv);
  if (userDotenvKeys.length > 0) {
    elog('INFO', 'boot', 'loaded ~/.michi/.env', { keys: userDotenvKeys.length });
  }

  // Runtime selection belongs to the backend config and the user's setup choice.
  const env = desktopBackendEnv({ base: process.env, dotenv: userDotenv, port, logDir: LOG_DIR, packaged: app.isPackaged });
  env.MICHI_LAUNCH_CWD = LAUNCH_CWD;
  if (startupTraceEnabled()) {
    env.MICHI_STARTUP_TRACE = '1';
    env.MICHI_STARTUP_RUN_ID = startupRunId();
  }


  elog('INFO', 'boot', 'forking backend', { entry, port });
  startupMark('backend_fork_start', { entry, port });
  backendChild = fork(entry, [], {
    env,
    silent: false,
    stdio: 'inherit',
  });
  backendChild.on('exit', (code, signal) => {
    elog('WARN', 'boot', 'backend child exited', { code, signal });
    backendChild = null;
  });
  return port;
}

async function stopBackend(): Promise<void> {
  if (!backendChild) return;
  const child = backendChild;
  backendChild = null;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch { resolve(); }
  });
}

// ── Background service (macOS LaunchAgent) ─────────────────────────────────
// When enabled, the backend runs under launchd and outlives the app, so
// scheduled jobs keep running after Michi quits. The app attaches to it on
// launch and never stops it on quit.

const SERVICE_PATHS = servicePaths();
let dockHidden = false;

function showDock(): void {
  if (process.platform !== 'darwin' || !dockHidden || !app.dock) return;
  dockHidden = false;
  void app.dock.show();
}

function serviceSupport(): { supported: boolean; reason?: string } {
  if (process.platform !== 'darwin') return { supported: false, reason: 'The background service is available on macOS.' };
  if (isDev || !app.isPackaged) return { supported: false, reason: 'The background service is available in the installed app.' };
  if (!resolveBackendEntry()) return { supported: false, reason: 'The bundled backend is missing.' };
  return { supported: true };
}

type BackendHealth = Partial<MichiBackendHealth>;

function probeHealth(port: number, timeoutMs = 1500): Promise<BackendHealth | null> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 64_000) req.destroy();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body) as BackendHealth); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function isOurService(health: BackendHealth | null): boolean {
  return !!health
    && health.service === 'michi-backend'
    && health.serverId === expectedServerId({ ...readDotenvFile(michiDotenvPath()), ...process.env })
    && health.serviceMode === true;
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortAvailable(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * Make sure our LaunchAgent serves `port` with the current app build,
 * installing or restarting it as needed. Resolves true once healthy.
 */
async function ensureServiceRunning(port: number): Promise<boolean> {
  const build = serviceBuildStamp(app.getAppPath(), app.getVersion());
  const health = await probeHealth(port);
  if (isOurService(health) && health!.serviceBuild === build) return true;
  if (health && !isOurService(health)) {
    elog('WARN', 'service', 'port is held by a different backend', { port, serviceMode: health.serviceMode });
    return false;
  }
  const entry = resolveBackendEntry();
  if (!entry) return false;
  const helper = (process as NodeJS.Process & { helperExecPath?: string }).helperExecPath || process.execPath;
  const spec = buildServiceLaunchSpec({
    nodeExecPath: helper,
    entry,
    port,
    logDir: LOG_DIR,
    bundlePath: appBundlePath(process.execPath),
    build,
    baseEnv: process.env,
  });
  try {
    elog('INFO', 'service', health ? 'restarting background service for this build' : 'starting background service', { port, build });
    await installAndStartService({ spec, run: runLaunchctl, uid: os.userInfo().uid, plistFile: SERVICE_PATHS.plistFile });
    await waitForBackend(port, 30_000);
  } catch (err) {
    elog('ERROR', 'service', 'background service did not start', { port, err: (err as Error).message });
    return false;
  }
  return isOurService(await probeHealth(port));
}

/** Attach to the background service when enabled, else fork the app-owned backend. */
async function startBackend(): Promise<number | null> {
  if (!resolveBackendEntry()) {
    backendMode = 'external';
    return forkBackend();
  }
  const state = serviceSupport().supported ? readServiceState(SERVICE_PATHS.stateFile) : null;
  if (state?.enabled) {
    startupMark('backend_service_attach_start', { port: state.port });
    if (await ensureServiceRunning(state.port)) {
      backendMode = 'service';
      elog('INFO', 'service', 'attached to background service', { port: state.port });
      return state.port;
    }
    elog('ERROR', 'service', 'background service unavailable; using an app-owned backend this session', { port: state.port });
    await stopService({ run: runLaunchctl, uid: os.userInfo().uid, plistFile: SERVICE_PATHS.plistFile }).catch(() => {});
  }
  backendMode = 'child';
  return forkBackend();
}

function backgroundServiceStatus(): BackgroundServiceStatus {
  const support = serviceSupport();
  const state = support.supported ? readServiceState(SERVICE_PATHS.stateFile) : null;
  return {
    supported: support.supported,
    ...(support.reason ? { reason: support.reason } : {}),
    enabled: !!state?.enabled,
    running: backendMode === 'service',
    port: resolvedBackendPort,
  };
}

let serviceTransition: Promise<unknown> | null = null;

/**
 * Hand the backend over between the app-owned child and the LaunchAgent on
 * the same port, so the renderer origin (and its local state) is unchanged.
 */
async function setBackgroundServiceEnabled(enabled: boolean): Promise<BackgroundServiceStatus> {
  const support = serviceSupport();
  if (!support.supported) throw new Error(support.reason ?? 'The background service is not available.');
  while (serviceTransition) await serviceTransition.catch(() => {});
  const uid = os.userInfo().uid;
  const work = (async () => {
    if (enabled && backendMode !== 'service') {
      const port = resolvedBackendPort ?? await chooseBackendPort();
      await stopBackend();
      await waitForPortFree(port, 10_000);
      writeServiceState(SERVICE_PATHS.stateFile, { enabled: true, port });
      if (await ensureServiceRunning(port)) {
        backendMode = 'service';
        resolvedBackendPort = port;
      } else {
        writeServiceState(SERVICE_PATHS.stateFile, { enabled: false, port });
        await stopService({ run: runLaunchctl, uid, plistFile: SERVICE_PATHS.plistFile, removePlist: true }).catch(() => {});
        await waitForPortFree(port, 10_000);
        backendMode = 'child';
        resolvedBackendPort = await forkBackend();
        if (resolvedBackendPort) await waitForBackend(resolvedBackendPort).catch(() => {});
        throw new Error(`The background service did not start. See ${path.join(LOG_DIR, 'service.err.log')}.`);
      }
    } else if (!enabled && backendMode === 'service') {
      const port = resolvedBackendPort;
      const state = readServiceState(SERVICE_PATHS.stateFile);
      if (state) writeServiceState(SERVICE_PATHS.stateFile, { ...state, enabled: false });
      await stopService({ run: runLaunchctl, uid, plistFile: SERVICE_PATHS.plistFile, removePlist: true });
      if (port) await waitForPortFree(port, 15_000);
      backendMode = 'child';
      resolvedBackendPort = await forkBackend();
      if (resolvedBackendPort) await waitForBackend(resolvedBackendPort);
      if (resolvedBackendPort !== port) {
        for (const win of windows) {
          if (!win.isDestroyed()) void win.loadURL(`http://127.0.0.1:${resolvedBackendPort}`);
        }
      }
    } else if (!enabled) {
      const state = readServiceState(SERVICE_PATHS.stateFile);
      if (state?.enabled) writeServiceState(SERVICE_PATHS.stateFile, { ...state, enabled: false });
    }
    notificationFeed.restart();
    companionFeed.restart();
    return backgroundServiceStatus();
  })();
  serviceTransition = work;
  try {
    return await work;
  } finally {
    serviceTransition = null;
  }
}

// ── Scheduled job notifications ────────────────────────────────────────────

// Window id 0 is no webContents id; a separate holder keeps renderer notices from evicting these.
const scheduledBanners = createNotificationHolder<ElectronNotification>();
let backgroundIdleTimer: ReturnType<typeof setTimeout> | null = null;

function devBackendPort(): number {
  return parsePort(process.env.MICHI_BACKEND_PORT) ?? parsePort(process.env.PORT) ?? 3000;
}

const notificationFeed = new ScheduledNotificationFeed({
  port: () => resolvedBackendPort ?? (backendMode === 'external' ? devBackendPort() : null),
  onNotice: (notice) => handleScheduledNotice(notice),
  log: (level, message, meta) => elog(level, 'schedule', message, meta),
});

function cancelBackgroundIdleQuit(): void {
  if (backgroundIdleTimer) clearTimeout(backgroundIdleTimer);
  backgroundIdleTimer = null;
}

/** A hidden background launch exits again if the user never opens a window. */
function armBackgroundIdleQuit(): void {
  if (!launchedInBackground || backgroundEngaged) return;
  cancelBackgroundIdleQuit();
  backgroundIdleTimer = setTimeout(() => {
    if (windows.size === 0) {
      elog('INFO', 'schedule', 'background launch idle; quitting');
      app.quit();
    }
  }, BACKGROUND_IDLE_QUIT_MS);
}

function targetOf(notice: ScheduledRunNotice): ScheduledRunTarget {
  return { runId: notice.runId, jobId: notice.jobId, workspaceId: notice.workspaceId, nodeId: notice.nodeId };
}

function openScheduledRun(target: ScheduledRunTarget): void {
  cancelBackgroundIdleQuit();
  showDock();
  const existing = BrowserWindow.getFocusedWindow() ?? [...windows].find((win) => !win.isDestroyed()) ?? null;
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    sendDesktopEvent(existing.webContents, 'scheduled:open-run', target);
  } else {
    void createWindow(target);
  }
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function handleScheduledNotice(notice: ScheduledRunNotice): void {
  const focused = BrowserWindow.getFocusedWindow();
  const focusedWindow = focused && windows.has(focused) && !focused.isDestroyed() ? focused : null;
  const plan = planNoticeDelivery(notice, {
    hasFocusedWindow: focusedWindow !== null,
    osNotificationsSupported: ElectronNotification.isSupported(),
  });
  const target = targetOf(notice);
  if (plan.kind === 'toast' && focusedWindow) {
    sendDesktopEvent(focusedWindow.webContents, 'scheduled:notice', { ...plan.content, target });
  } else if (plan.kind === 'banner') {
    const { title, subtitle, body } = plan.content;
    const notification = new ElectronNotification({ title, subtitle, body });
    const release = scheduledBanners.hold(0, `scheduled:${notice.runId}`, notification);
    notification.on('click', () => {
      release();
      openScheduledRun(target);
    });
    notification.on('close', release);
    notification.show();
  }
  if (plan.ack) notificationFeed.acknowledge(notice.runId);
  if (plan.kind === 'banner' || plan.kind === 'defer') armBackgroundIdleQuit();
}

// ── Companion notifications ────────────────────────────────────────────────

/** Blurring a window precedes focusing the next: a held notice turns into a banner only if no Michi window has focus by then. */
const COMPANION_BLUR_SETTLE_MS = 250;

/** Whose renderer listens for Companion notices and clicks, and the click waiting for a window that is still loading. */
const companionRenderers = new CompanionRenderers((windowId, target) => {
  const win = [...windows].find((candidate) => !candidate.isDestroyed() && candidate.webContents.id === windowId);
  if (win) sendDesktopEvent(win.webContents, 'companion:open', target);
});

/** Bring Michi forward with the Companion open at `target` (a Companion banner click). */
function openCompanionTarget(target: CompanionTarget): void {
  cancelBackgroundIdleQuit();
  showDock();
  const existing = BrowserWindow.getFocusedWindow() ?? [...windows].find((win) => !win.isDestroyed()) ?? null;
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    // Sent once its renderer listens: a window that is still loading would drop the click.
    companionRenderers.open(existing.webContents.id, target);
  } else {
    void createWindow(undefined, target);
  }
  if (process.platform === 'darwin') app.focus({ steal: true });
}

const companionNotifier = new CompanionNotifier({
  Notification: ElectronNotification,
  focusedWindow: () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused || !windows.has(focused) || focused.isDestroyed()) return null;
    const contents = focused.webContents;
    return {
      listening: companionRenderers.listens(contents.id, 'notice'),
      showNotice: (notice) => sendDesktopEvent(contents, 'companion:notice', notice),
    };
  },
  open: (target) => openCompanionTarget(target),
  acknowledge: (noticeId) => companionFeed.acknowledge(noticeId),
  now: () => Date.now(),
  onBackgroundDelivery: () => armBackgroundIdleQuit(),
  onHandled: (notice, plan) => {
    // Ids and outcomes only: notice text stays out of the log.
    elog('INFO', 'companion', 'notice handled', { id: notice.id, channel: companionNoticeChannel(notice), delivery: plan.kind, ...(plan.kind === 'skip' ? { reason: plan.reason } : {}) });
    // A notice means the agent's items moved, or (a `chat` notice) a
    // conversation, the agent's own included, asked for an approval or an
    // answer or finished a reply: the tray's Needs you and "<name> is waiting
    // for you" follow.
    trayController.scheduleRefresh();
  },
});

const companionFeed = new CompanionNotificationFeed({
  port: () => resolvedBackendPort ?? (backendMode === 'external' ? devBackendPort() : null),
  onNotice: (notice) => { companionNotifier.deliver(notice); },
  onConnected: () => {
    // The backend replays every unacknowledged notice on a new connection, held ones included.
    companionNotifier.dropHeld();
    // Changes made while the feed was away sent no frame here.
    trayController.scheduleRefresh();
  },
  // The tray's refresh signal (DESIGN-v2 §5.1). Main never subscribes to the
  // agent's events stream (COMPANION_EVENTS_PATH): its subscribers are windows
  // only, which is how the backend tells that no window is open (§5.2).
  onChanged: () => trayController.scheduleRefresh(),
  log: (level, message, meta) => elog(level, 'companion', message, meta),
});

// A window's preload reports when its renderer starts or stops listening for
// Companion notices and clicks. Not a DesktopCommandContract channel: no
// renderer code sends it (see COMPANION_READY_CHANNEL).
ipcMain.on(COMPANION_READY_CHANNEL, (event, kind: unknown, listening: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !windows.has(win)) return;
  if (companionRenderers.report(event.sender.id, kind, listening)) companionNotifier.refresh();
});

// A held notice is shown in whichever Michi window has focus once its renderer listens, or becomes a banner when Michi loses focus.
app.on('browser-window-focus', (_event, win) => {
  if (windows.has(win)) lastFocusedWindow = win;
  companionNotifier.refresh();
});
app.on('browser-window-blur', () => {
  setTimeout(() => companionNotifier.refresh(), COMPANION_BLUR_SETTLE_MS);
});

// ── Menu-bar / notification-area icon (DESIGN-v2 §5.1) ─────────────────────

/** The Michi window focused last: the tray's Open Michi brings it back. */
let lastFocusedWindow: BrowserWindow | null = null;
let desktopSettingsCache: DesktopSettings | null = null;

function desktopSettingsFile(): string {
  return path.join(app.getPath('userData'), DESKTOP_SETTINGS_FILE);
}

function desktopSettings(): DesktopSettings {
  desktopSettingsCache ??= readDesktopSettings(desktopSettingsFile());
  return desktopSettingsCache;
}

function saveDesktopSettings(next: DesktopSettings): void {
  writeDesktopSettings(desktopSettingsFile(), next);
  desktopSettingsCache = next;
}

/** "Open Michi at login" as the OS has it now (Windows, installed app only), with the argument its login item passes. */
function loginItemOpensAtLogin(): boolean | null {
  if (process.platform !== 'win32' || !app.isPackaged || isDev) return null;
  return app.getLoginItemSettings({ args: [LOGIN_LAUNCH_ARG] }).openAtLogin;
}

function residencyEnv() {
  return { platform: process.platform, packaged: app.isPackaged && !isDev };
}

function currentResidency(): DesktopResidency {
  if (process.platform === 'win32') {
    const status = windowsLifetime.status();
    return {
      tray: { supported: status.supported, enabled: status.keepInBackground },
      hideDock: { supported: false, enabled: false },
      openAtLogin: { supported: status.supported, enabled: status.openAtLogin },
      ...(status.reason ? { reason: status.reason } : {}),
    };
  }
  return desktopResidency(desktopSettings(), { ...residencyEnv(), openAtLogin: loginItemOpensAtLogin() });
}

function setResidency(raw: unknown): DesktopResidency {
  const patch = parseResidencyPatch(raw);
  if (process.platform === 'win32') {
    if (patch.hideDock !== undefined) throw new Error('Hiding the Dock is available on macOS.');
    if (patch.tray !== undefined) {
      const status = windowsLifetime.setKeepInBackground(patch.tray);
      if (!status.canStartHidden) recoverVisibleWindows();
    }
    if (patch.openAtLogin !== undefined) windowsLifetime.setOpenAtLogin(patch.openAtLogin);
    return currentResidency();
  }
  const change = applyResidencyPatch(desktopSettings(), patch, residencyEnv());
  saveDesktopSettings(change.settings);
  syncTray();
  return currentResidency();
}

const TRAY_ICON_DIR = path.join(__dirname, '..', '..', 'assets', 'icons');

/**
 * The icon, when one is up. It holds only an icon that can be seen: a file
 * that does not load (say, missing from app.asar) or a Tray the OS refuses
 * leaves none, and Michi then behaves as before v2 (window-all-closed, the
 * login launch below).
 */
const trayIcon = new TrayIconSlot<NativeImage, Tray>({
  load: (file) => {
    // A template image's @2x sibling loads with it (the asar archive included).
    const image = nativeImage.createFromPath(path.join(TRAY_ICON_DIR, file));
    if (process.platform === 'darwin' && !image.isEmpty()) image.setTemplateImage(true);
    return image;
  },
  construct: (image, guid) => (guid ? new Tray(image, guid) : new Tray(image)),
  log: (level, message, meta) => elog(level, 'tray', message, meta),
});

const trayController = new TrayController({
  port: () => resolvedBackendPort ?? (backendMode === 'external' ? devBackendPort() : null),
  onChange: () => renderTray(),
  log: (level, message, meta) => elog(level, 'tray', message, meta),
});

/** The icon is up unless it is off, unsupported, or this is a background launch the user has not touched yet. */
function trayWanted(): boolean {
  return traySupported(process.platform) && desktopSettings().tray.enabled && (!launchedInBackground || backgroundEngaged);
}

/**
 * The icon is an add-on: whatever goes wrong with it stays here, so startup,
 * createWindow (a background launch the user opens) and setResidency go on
 * without it.
 */
function syncTray(): void {
  if (process.platform === 'win32') return; // WindowsLifetimeController owns the shared icon.
  try {
    if (trayWanted()) ensureTray();
    else destroyTray();
  } catch (err) {
    elog('WARN', 'tray', 'tray icon failed; going on without it', { err: (err as Error).message });
    destroyTray();
  }
}

function ensureTray(): void {
  if (trayIcon.current) return;
  const file = trayIconFile(trayController.current(), process.platform, nativeTheme.shouldUseDarkColorsForSystemIntegratedUI);
  const icon = trayIcon.show(file, trayGuid(process.platform, app.isPackaged && !isDev), (created) => {
    const onClick = (click: 'click' | 'right-click' | 'double-click') => () => {
      const behavior = trayClickBehavior(process.platform, click);
      if (behavior === 'menu') popUpTrayMenu();
      else if (behavior === 'open-michi') openMichiWindow();
    };
    created.on('click', onClick('click'));
    created.on('right-click', onClick('right-click'));
    created.on('double-click', onClick('double-click'));
  });
  // None came up (the reason is logged): no icon, as before v2.
  if (!icon) return;
  renderTray();
  trayController.setActive(true);
}

/** Never throws: the controller stops fetching and the slot takes the icon down. */
function destroyTray(): void {
  trayController.setActive(false);
  trayIcon.destroy();
}

function renderTray(): void {
  const icon = trayIcon.current;
  if (!icon) return;
  try {
    const data = trayController.current();
    trayIcon.setFile(trayIconFile(data, process.platform, nativeTheme.shouldUseDarkColorsForSystemIntegratedUI));
    icon.setToolTip(trayTooltip(data));
  } catch (err) {
    elog('WARN', 'tray', 'tray icon not updated', { err: (err as Error).message });
  }
}

/**
 * The menu from the cached data, at once: the feed's change frames and the
 * controller's minute refresh keep the cache fresh, so a click never waits on
 * the network. Never set as the tray's context menu, which would have to be
 * rebuilt while it is open.
 */
function popUpTrayMenu(): void {
  const icon = trayIcon.current;
  if (!icon) return;
  const menu = Menu.buildFromTemplate(trayMenuTemplate(trayController.menu(process.platform), dispatchTrayAction));
  icon.popUpContextMenu(menu);
  // Ages in the cached status ("checked 2m ago") are fresh again for the next click.
  trayController.scheduleRefresh();
}

function dispatchTrayAction(action: TrayAction): void {
  switch (action.kind) {
    case 'open':
      openCompanionTarget(action.target);
      return;
    case 'open-michi':
      openMichiWindow();
      return;
    case 'check-now':
      void trayController.checkNow();
      return;
    case 'set-paused':
      void trayController.setPaused(action.paused);
      return;
    case 'quit':
      app.quit();
      return;
  }
}

/** Bring back the Michi window focused last, or open one. */
function openMichiWindow(): void {
  cancelBackgroundIdleQuit();
  showDock();
  const existing = lastFocusedWindow && windows.has(lastFocusedWindow) && !lastFocusedWindow.isDestroyed()
    ? lastFocusedWindow
    : [...windows].find((win) => !win.isDestroyed()) ?? null;
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  } else {
    void createWindow();
  }
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function hideDock(): void {
  if (process.platform !== 'darwin' || dockHidden || !app.dock) return;
  app.dock.hide();
  dockHidden = true;
}

// Hold a reference until the user acts on it, or its click handler can be collected.
const liveNotifications = new Set<ElectronNotification>();

/** Said once, the first time the last window closes with the icon up. */
function showStillRunningHint(): void {
  const next: DesktopSettings = { tray: { ...desktopSettings().tray, hintShown: true } };
  // Kept for this run even when the file cannot be written, so it still shows once.
  desktopSettingsCache = next;
  writeDesktopSettingsQuietly(desktopSettingsFile(), next, (err) => elog('WARN', 'tray', 'desktop settings not saved', { err: err.message }));
  if (!ElectronNotification.isSupported()) return;
  const { title, body } = stillRunningHint(process.platform);
  const notification = new ElectronNotification({ title, body });
  liveNotifications.add(notification);
  notification.on('click', () => {
    liveNotifications.delete(notification);
    openMichiWindow();
  });
  notification.on('close', () => liveNotifications.delete(notification));
  notification.show();
}

/** A background launch the user opened a window in becomes an ordinary instance: the icon appears, and it no longer quits when idle. */
function engageBackgroundLaunch(): void {
  if (!launchedInBackground || backgroundEngaged) return;
  backgroundEngaged = true;
  cancelBackgroundIdleQuit();
  elog('INFO', 'boot', 'background launch engaged by the user');
  syncTray();
}

handleDesktopInvoke('desktop:getResidency', () => currentResidency());

handleDesktopInvoke('desktop:setResidency', (_ev, patch: unknown) => setResidency(patch));

handleDesktopInvoke('service:getStatus', () => backgroundServiceStatus());

handleDesktopInvoke('service:setEnabled', (_ev, enabled: unknown) => {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  return setBackgroundServiceEnabled(enabled);
});

handleDesktopInvoke('app:getUpdateState', () => getUpdateState());
handleDesktopInvoke('app:checkForUpdate', async () => { await checkForUpdate(); return getUpdateState(); });
handleDesktopInvoke('app:downloadUpdate', async () => { await downloadUpdate(); return getUpdateState(); });
handleDesktopInvoke('app:installUpdate', async () => { await installUpdate(); return getUpdateState(); });

function lifetimePrefsFile(): string {
  return path.join(app.getPath('userData'), 'desktop-lifetime.json');
}

function findWindowById(id: number): BrowserWindow | undefined {
  return [...windows].find((win) => !win.isDestroyed() && win.id === id);
}

function restoreLifetimeWindow(): void {
  const decision = windowsLifetime.handleSecondInstance([]);
  if (decision.action === 'create-window') void createWindow();
}

function createWindowsTray(): boolean {
  try { ensureTray(); return trayIcon.current !== null; }
  catch (err) {
    elog('WARN', 'lifetime', 'tray creation failed', { err: (err as Error).message });
    return false;
  }
}

function destroyWindowsTray(): void { destroyTray(); }

const windowsLifetime = new WindowsLifetimeController(
  { platform: process.platform, isPackaged: app.isPackaged, isDev },
  {
    readPreferences() {
      try { return JSON.parse(fs.readFileSync(lifetimePrefsFile(), 'utf8')); } catch { return null; }
    },
    writePreferences(prefs) {
      const file = lifetimePrefsFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(prefs)}\n`, { mode: 0o600 });
    },
    fileExists: (candidate) => fs.existsSync(candidate),
    execPath: process.execPath,
    createTray: createWindowsTray,
    destroyTray: destroyWindowsTray,
    hideWindow(id) { findWindowById(id)?.hide(); },
    restoreWindow(id) {
      const win = findWindowById(id);
      if (win) revealWindow(win);
    },
    focusWindow(id) { findWindowById(id)?.focus(); },
    listWindows: () => [...windows].filter((win) => !win.isDestroyed()).map((win) => ({
      id: win.id,
      webContentsId: win.webContents.id,
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      destroyed: win.isDestroyed(),
    })),
    quit: () => { app.quit(); },
    stopBackend: () => stopBackend(),
    setLoginItem(settings) {
      try {
        app.setLoginItemSettings({
          openAtLogin: settings.openAtLogin,
          path: settings.path,
          args: settings.args,
          ...(settings.enabled !== undefined ? { enabled: settings.enabled } : {}),
        });
        return true;
      } catch (err) {
        elog('WARN', 'lifetime', 'login item update failed', { err: (err as Error).message });
        return false;
      }
    },
    getLoginItem(query) {
      const settings = app.getLoginItemSettings({ path: query.path, args: query.args });
      const items = settings.launchItems ?? [];
      return {
        openAtLogin: settings.openAtLogin,
        executableWillLaunchAtLogin: settings.executableWillLaunchAtLogin,
        enabled: items.length === 0 ? undefined : items.every((item) => item.enabled),
      };
    },
  },
);

function revealWindow(win: BrowserWindow): void {
  restoredWindows.add(win);
  win.setSkipTaskbar(false);
  if (win.isMinimized()) win.restore();
  win.show();
}

function recoverVisibleWindows(): void {
  for (const win of windows) {
    if (!win.isDestroyed()) revealWindow(win);
  }
}

function attachWindowSessionEnd(win: BrowserWindow): void {
  win.on('query-session-end', () => {
    // Query can still be cancelled by Windows. Do not mark an irrevocable quit.
  });
  win.on('session-end', () => {
    windowsLifetime.beginQuit('shutdown');
    destroyWindowsTray();
    void stopBackend();
  });
}

function assertOwnedLifetimeSender(event: Electron.IpcMainInvokeEvent): void {
  const ids = [...windows].filter((win) => !win.isDestroyed()).map((win) => win.webContents.id);
  const frame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  if (!isOwnedLifetimeSender({
    senderId: event.sender.id,
    windowWebContentsIds: ids,
    senderFrameIsMainFrame: !!frame && !!mainFrame && frame === mainFrame,
  })) throw new Error('Unauthorized');
}

handleDesktopInvoke('lifetime:getStatus', (event) => {
  assertOwnedLifetimeSender(event);
  return windowsLifetime.status();
});

handleDesktopInvoke('lifetime:setKeepInBackground', (event, enabled: unknown) => {
  assertOwnedLifetimeSender(event);
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  const status = windowsLifetime.setKeepInBackground(enabled);
  if (!status.canStartHidden) recoverVisibleWindows();
  return status;
});

handleDesktopInvoke('lifetime:setOpenAtLogin', (event, enabled: unknown) => {
  assertOwnedLifetimeSender(event);
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  return windowsLifetime.setOpenAtLogin(enabled);
});

// Custom application menu. macOS's default menu binds Cmd+W to "Close Window",
// which intercepts the accelerator before the renderer can use it for "close
// focused pane". We rebuild the menu mirroring the platform default but bind
// "Close Window" to Shift+Cmd+W (Chrome/Safari convention) so plain Cmd+W
// falls through as a normal keydown that TerminalShell handles.
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{
          label: app.name,
          submenu: [
            { role: 'about' },
            {
              label: 'Check for Updates…',
              click: () => { void checkForUpdate(); },
            },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => { void createWindow(); },
        },
        { type: 'separator' },
        isMac
          ? { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', role: 'close' }
          : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Learn More',
          click: () => { void shell.openExternal('https://github.com/'); },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(openRun?: ScheduledRunTarget, openCompanion?: CompanionTarget, options?: { hidden?: boolean }): Promise<void> {
  // Every window a background launch opens is the user's doing (a banner, the Dock, `michi`).
  engageBackgroundLaunch();
  showDock();
  const slot = nextWindowSlot++;
  const savedState = loadWindowState(slot);
  const cascade = slot * 32;
  const windowId = `win-${slot}`;
  startupMark('browser_window_create_start', { backendPort: resolvedBackendPort, slot });
  const win = new BrowserWindow({
    width: savedState.width,
    height: savedState.height,
    ...(cascade > 0 ? { x: 80 + cascade, y: 80 + cascade } : {}),
    minWidth: 360,
    minHeight: 480,
    show: false,
    // With vibrancy on: the NSVisualEffectView material IS the window base and
    // provides its own alpha, so the desktop shows through wherever the DOM is
    // transparent. Do NOT also set `transparent: true` — that makes a hard-alpha
    // window that SUPPRESSES the material (looks flat/opaque). backgroundColor
    // must be fully transparent so no solid layer paints over the material.
    // Without vibrancy, keep the warm opaque background (web/Win/Linux path).
    // 'under-window' is the lightest / most see-through NSVisualEffectView
    // material — the desktop shows through much more than 'sidebar' (which is
    // a denser frost). Still frosted (macOS has no fully-clear vibrancy
    // material), just far more transparent.
    // visualEffectState 'followWindow' (the macOS default): the material is
    // active/see-through only while the window is focused, and goes muted/opaque
    // when Michi is in the background. This is the native NSVisualEffectView
    // behavior (Finder, Notes) and gives a clear focus cue in a multi-window
    // setup — the front window "glows" glassy, background ones recede.
    ...(windowGlass
      ? {
          vibrancy: vibrancyMaterial,
          visualEffectState: 'followWindow' as const,
          backgroundColor: '#00000000',
        }
      : { backgroundColor: '#F5F2EE' }),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload needs only contextBridge, ipcRenderer and webUtils;
      // scripts/electron-preload-contract.test.mjs keeps it sandbox-safe.
      sandbox: true,
      // Streaming output should keep draining even when the app is behind
      // another window; otherwise Chromium pauses rAF/timers and the UI
      // replays a stale typewriter backlog when the window returns.
      backgroundThrottling: false,
    },
  });
  windows.add(win);
  windowSlots.set(win, slot);
  const ownerWebContentsId = win.webContents.id;
  // Before the first await: a window closed while it waits for the backend
  // is forgotten at once, and the loads below check isDestroyed().
  win.on('closed', () => {
    destroyOwnedSurfaces(ownerWebContentsId);
    windows.delete(win);
    windowSlots.delete(win);
    if (lastFocusedWindow === win) lastFocusedWindow = null;
  });
  startupMark('browser_window_created', { backendPort: resolvedBackendPort, slot });
  attachWindowSessionEnd(win);

  if (savedState.isMaximized) {
    win.maximize();
  }

  win.on('resize', () => scheduleSaveWindowState(win));
  win.on('maximize', () => scheduleSaveWindowState(win));
  win.on('unmaximize', () => scheduleSaveWindowState(win));

  // Confirm close when active (non-exited) terminal surfaces are running.
  let closingConfirmed = false;
  win.on('close', (event) => {
    flushWindowState(win);
    if (closingConfirmed) return;
    const closeDecision = windowsLifetime.handleWindowClose(win.id);
    if (closeDecision === 'hide') {
      event.preventDefault();
      return;
    }
    if (closeDecision === 'quit-close') return;

    let activeTerminals = 0;
    for (const [, surface] of terminalSurfaces) {
      if (surface.ownerId === ownerWebContentsId && !surface.exited) activeTerminals++;
    }

    if (activeTerminals > 0) {
      event.preventDefault();
      dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Close anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Active terminals',
        message: `${activeTerminals} terminal${activeTerminals > 1 ? 's' : ''} still running`,
        detail: 'Closing this window will terminate all running processes.',
      }).then(({ response }) => {
        if (response === 0) {
          closingConfirmed = true;
          win.close();
        }
      });
    }
  });

  win.once('ready-to-show', () => {
    startupMark('window_ready_to_show', { slot });
    if (options?.hidden && !restoredWindows.has(win)) {
      win.setSkipTaskbar(true);
      return;
    }
    win.setSkipTaskbar(false);
    win.show();
  });

  win.webContents.on('did-finish-load', () => {
    startupMark('renderer_did_finish_load', { slot });
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    destroyOwnedSurfaces(ownerWebContentsId);
    // V8-level renderer crash (OOM, segfault, etc.) — not triggered by React
    // errors, but covers extreme cases.  Must be deferred: calling reload()
    // synchronously inside this handler can crash the main process on older
    // Electron versions (Chromium re-enters RenderProcessHostImpl::Init
    // while iterating the observer list).
    if (details.reason !== 'clean-exit') {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          // eslint-disable-next-line no-console
          console.log(`[main] renderer gone (${details.reason}), reloading window`);
          win.webContents.reload();
        }
      }, 1000);
    }
  });

  // The Companion sends notices and clicks only to a renderer that listens;
  // a new document listens only once its preload says so.
  const companionDocumentGone = (): void => {
    if (companionRenderers.documentGone(ownerWebContentsId)) companionNotifier.refresh();
  };
  win.webContents.on('did-start-navigation', (details) => {
    // A navigation main starts (loadURL, reload) replaces the document. One
    // the page starts can still be refused by will-navigate, so it counts
    // once it commits (did-navigate).
    if (details.isMainFrame && !details.isSameDocument && !details.initiator) companionDocumentGone();
  });
  win.webContents.on('did-navigate', companionDocumentGone);
  win.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
    // An error page replaced the document.
    if (isMainFrame) companionDocumentGone();
  });
  win.webContents.on('render-process-gone', companionDocumentGone);
  win.webContents.once('destroyed', () => companionRenderers.forget(ownerWebContentsId));

  win.webContents.on('console-message', (_event, _level, message) => {
    if (isStartupTraceLine(message)) {
      process.stdout.write(`${message}\n`);
    }
  });

  // Keep web navigation out of the app window. The renderer resolves the
  // user's browser preference; explicit external opening uses its own IPC.
  const routeLink = (url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') sendDesktopEvent(win.webContents, 'app:openUrl', parsed.href);
      else if (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:') void shell.openExternal(parsed.href);
    } catch { /* Ignore malformed navigation. */ }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    routeLink(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return;
    try {
      const current = new URL(win.webContents.getURL());
      const target = new URL(url);
      if (['http:', 'https:'].includes(current.protocol) && target.origin === current.origin) return;
    } catch { /* Invalid navigation is blocked below. */ }
    event.preventDefault();
    routeLink(url);
  });

  const bootstrapQuery: Partial<Record<DesktopBootstrapParam, string>> = {
    michiWindowId: windowId,
    ...(app.isPackaged ? { michiPackaged: '1' } : {}),
    ...(VIBRANCY_ENABLED ? { michiVibrancy: '1' } : {}),
    ...(VIBRANCY_ENABLED && !windowGlass ? { michiGlass: '0' } : {}),
    // Read once by the preload; the renderer opens the run after hydration.
    ...(openRun ? { michiOpenRun: openRun.runId, michiOpenJob: openRun.jobId, michiOpenWorkspace: openRun.workspaceId } : {}),
    ...(openRun?.nodeId ? { michiOpenNode: openRun.nodeId } : {}),
  };
  const withWindowId = (base: string): string => {
    const url = new URL(base);
    for (const [name, value] of Object.entries(bootstrapQuery)) url.searchParams.set(name, value);
    if (openCompanion) {
      // Read once by the preload (initialCompanionTarget); the renderer opens the Companion there.
      url.searchParams.set(COMPANION_TARGET_PARAM, JSON.stringify(openCompanion));
    }
    return url.toString();
  };

  if (isDev) {
    // Each worktree may have its own Vite process. The launcher selects an
    // available port and passes the exact renderer URL so we never attach to
    // a stale dev server from another checkout.
    const url = withWindowId(process.env.MICHI_RENDERER_URL || 'http://127.0.0.1:3001');
    startupMark('renderer_load_start', { url, slot });
    await win.loadURL(withStartupTraceQuery(url));
    startupMark('renderer_load_done', { slot });
    // DevTools only opens when explicitly requested. Set
    // ELECTRON_OPEN_DEVTOOLS=1 in the environment to auto-open; otherwise
    // use Cmd+Opt+I / View → Toggle Developer Tools.
    if (process.env.ELECTRON_OPEN_DEVTOOLS === '1' && !win.isDestroyed()) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    // In production the backend serves the frontend HTML. While boot waits
    // for it, the window shows a local skeleton, then the failure page if
    // the first health deadline passes, and loads the UI once boot is ready.
    if (backendBoot === 'starting') {
      startupMark('skeleton_load_start', { slot });
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SKELETON_HTML)}`);
      startupMark('skeleton_load_done', { slot });
      await whenBackendBoot(['ready', 'failed']);
    }
    if (backendBoot === 'failed') {
      if (win.isDestroyed()) return;
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(backendFailedHtml())}`);
      await whenBackendBoot(['ready']);
    }
    if (win.isDestroyed()) return;
    if (resolvedBackendPort) {
      const url = withWindowId(`http://127.0.0.1:${resolvedBackendPort}`);
      startupMark('renderer_load_start', { url, slot });
      await win.loadURL(withStartupTraceQuery(url));
      startupMark('renderer_load_done', { slot });
    } else {
      const indexPath = path.join(app.getAppPath(), 'frontend', 'build', 'index.html');
      startupMark('renderer_load_start', { file: indexPath, slot });
      await win.loadFile(indexPath, {
        query: { ...(startupTraceFileQuery() ?? {}), ...bootstrapQuery },
      });
      startupMark('renderer_load_done', { slot });
    }
  }
}

function pickerDefaultPath(): string {
  if (LAUNCH_CWD && LAUNCH_CWD !== '/' && LAUNCH_CWD !== path.sep) return LAUNCH_CWD;
  return app.getPath('home');
}

// Explicit system-browser actions bypass the preferred link destination.
onDesktopCommand('app:openExternal', (_ev, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    void shell.openExternal(url);
  }
});

handleDesktopInvoke('app:chooseFolder', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: pickerDefaultPath(),
  });
  if (r.canceled || r.filePaths.length === 0) {
    return { canceled: true };
  }
  const p = r.filePaths[0];
  return {
    canceled: false,
    path: p,
    name: path.basename(p),
  };
});

handleDesktopInvoke('app:chooseFolders', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory', 'multiSelections'],
    defaultPath: pickerDefaultPath(),
  });
  if (r.canceled || r.filePaths.length === 0) {
    return { canceled: true, folders: [] };
  }
  return {
    canceled: false,
    folders: r.filePaths.map((p) => ({ path: p, name: path.basename(p) })),
  };
});

// Mint a per-project scratch cwd outside macOS-protected directories so
// kiro-cli doesn't trip TCC prompts when the user skips folder selection.
handleDesktopInvoke('app:resolveSkipCwd', async (_ev, projectId: string) => {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('resolveSkipCwd: projectId required');
  }
  const safeId = projectId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const target = path.join(app.getPath('home'), '.michi', 'workspaces', safeId);
  await fs.promises.mkdir(target, { recursive: true });
  return { path: target };
});

// Open an absolute path with the OS default app. Used by the Contexts list
// to open pinned files on click; the path is the resolved cwd-relative path
// the renderer already has, so no extra validation is needed beyond the
// shell call's own existence check.
handleDesktopInvoke('app:openPath', async (_ev, absPath: string) => {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return { ok: false, error: 'absPath required' };
  }
  const err = await shell.openPath(absPath);
  if (err) return { ok: false, error: err };
  return { ok: true };
});

handleDesktopInvoke('app:chooseFiles', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    defaultPath: pickerDefaultPath(),
  });
  if (r.canceled || r.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, paths: r.filePaths };
});

handleDesktopInvoke('app:saveMarkdown', async (_ev, suggestedName: string, content: string) => {
  const r = await dialog.showSaveDialog({
    defaultPath: suggestedName,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  await fs.promises.writeFile(r.filePath, content, 'utf8');
  return { canceled: false, path: r.filePath };
});

handleDesktopInvoke('app:listDirectory', async (_ev, absPath: unknown, rawRoots: unknown) => {
  return listWorkspaceDirectory(absPath, rawRoots);
});

// Keep in step with imageMimeType (runtime/src/core/attachments.ts): main is compiled
// without bundling and does not ship workspace packages, so it cannot import it.
const IMAGE_MIME = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);

handleDesktopInvoke('app:readFilePreview', async (_ev, absPath: unknown) => {
  try {
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return null;
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return null;
    const extension = path.extname(absPath).slice(1).toLowerCase();
    const mime = IMAGE_MIME.get(extension);
    const data = await fs.promises.readFile(absPath);
    if (mime) {
      return { kind: 'image', dataUrl: `data:${mime};base64,${data.toString('base64')}`, size: stat.size, modifiedAt: stat.mtimeMs, extension };
    }
    if (data.subarray(0, 8192).includes(0)) return null;
    const content = data.toString('utf8');
    return { kind: 'text', content, size: stat.size, modifiedAt: stat.mtimeMs, extension };
  } catch {
    return null;
  }
});

handleDesktopInvoke('app:listGitChanges', async (_ev, cwd: unknown, rawRoots: unknown) => {
  const { directory } = await resolveAllowedDirectory(cwd, rawRoots);
  return new Promise<Array<{ path: string; status: string }>>((resolve) => {
    execFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: directory,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      if (error && !stdout) {
        resolve([]);
        return;
      }
      resolve(stdout.split('\n').flatMap((line) => {
        if (line.length < 4) return [];
        const status = line.slice(0, 2).trim() || '?';
        const rawPath = line.slice(3).trim();
        const filePath = rawPath.includes(' -> ') ? rawPath.slice(rawPath.lastIndexOf(' -> ') + 4) : rawPath;
        return filePath ? [{ path: filePath.replace(/^"|"$/g, ''), status }] : [];
      }));
    });
  });
});

handleDesktopInvoke('app:statFile', async (_ev, absPath: string) => {
  try {
    if (!absPath || !path.isAbsolute(absPath)) return null;
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile()) return null;
    return { size: stat.size, modifiedAt: stat.mtimeMs };
  } catch {
    return null;
  }
});

// OS-level notification triggered from the renderer via preload bridge. A
// click focuses the window that raised it; with a target key it also reports
// the key back so that window can open what the notification is about.
const rendererNotifications = createNotificationHolder<ElectronNotification>();
onDesktopCommand('app:showNotification', (event, title, body, target) => {
  const request = parseNotificationRequest(title, body, target);
  if (!request) return;
  const sender = event.sender;
  const n = new ElectronNotification({ title: request.title, body: request.body, ...(request.silent ? { silent: true } : {}) });
  const release = rendererNotifications.hold(sender.id, request.key, n);
  n.on('click', () => {
    release();
    const owner = sender.isDestroyed() ? null : BrowserWindow.fromWebContents(sender);
    if (!owner || owner.isDestroyed()) {
      focusedWindow()?.focus();
      return;
    }
    if (owner.isMinimized()) owner.restore();
    owner.show();
    owner.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
    if (request.key) sendDesktopEvent(owner.webContents, 'app:attentionNotificationClicked', request.key);
  });
  n.on('close', release);
  n.show();
});

// Relaunch the app (used after self-update). app.exit() skips the quit
// events, will-quit included, so stop an app-owned backend first; otherwise
// the orphan keeps the port and the relaunched app starts a second backend
// on the same data.
onDesktopCommand('app:relaunch', () => {
  void (async () => {
    notificationFeed.stop();
    companionFeed.stop();
    // app.exit() skips before-quit and will-quit: the icon goes now, or Windows leaves a ghost icon.
    trayController.stop();
    destroyTray();
    await stopBackend();
    // Not as a login or background launch again, which would bring Michi back with no window.
    app.relaunch({ args: relaunchArgs(process.argv) });
    app.exit(0);
  })();
});

// isPackaged and vibrancy flags are injected via URL query params by
// createWindow — the preload reads them from window.location.search with
// zero IPC. Legacy sendSync handlers removed.

// (vibrancy flag is now injected via URL query param — see above comment)

// Keep native chrome, vibrancy, and Browser WebContentsViews aligned with the
// active Michi palette. Browser views receive a Chromium preferred-color-scheme
// emulation, so sites with native dark CSS update without destructive filters.
onDesktopCommand('app:setDarkMaterial', (_ev, dark: boolean, backgroundColor?: string) => {
  currentBrowserTheme = normalizeBrowserTheme(dark, backgroundColor);
  nativeTheme.themeSource = currentBrowserTheme.colorScheme;
  for (const surface of browserSurfaces.values()) void syncBrowserTheme(surface);
  // Without glass the window base shows wherever the page has not painted yet.
  if (VIBRANCY_ENABLED && !windowGlass) {
    for (const w of windows) if (!w.isDestroyed()) w.setBackgroundColor(currentBrowserTheme.backgroundColor);
  }
});

// Runtime-switch the sidebar's NSVisualEffectView material so users can pick how
// see-through / dense the desktop-vibrancy sidebar reads. macOS materials range
// from 'under-window' (lightest, our default) to denser frosts ('sidebar',
// 'menu', 'hud'). Applies to every open window. No-op unless vibrancy is on
// (off macOS / MICHI_NO_VIBRANCY) or on an invalid material string. With window
// glass off it is only remembered for when glass comes back.
// A copy of shared VIBRANCY_MATERIALS (main cannot load shared at runtime); tsc holds it to the type.
const VIBRANCY_MATERIALS = { 'under-window': true, sidebar: true, menu: true, hud: true } satisfies Record<VibrancyMaterial, true>;
onDesktopCommand('app:setVibrancy', (_ev, material) => {
  if (!VIBRANCY_ENABLED || typeof material !== 'string' || !Object.hasOwn(VIBRANCY_MATERIALS, material)) return;
  vibrancyMaterial = material;
  if (!windowGlass) return;
  for (const w of windows) {
    if (!w.isDestroyed()) w.setVibrancy(vibrancyMaterial);
  }
});

// Settings → Appearance → Window glass. Off removes the material and gives the
// window an opaque base in the palette's background; on brings both back.
function applyWindowGlass(win: BrowserWindow): void {
  if (windowGlass) {
    win.setBackgroundColor('#00000000');
    win.setVibrancy(vibrancyMaterial);
  } else {
    win.setVibrancy(null);
    win.setBackgroundColor(currentBrowserTheme.backgroundColor);
  }
}
onDesktopCommand('app:setWindowGlass', (_ev, enabled: boolean) => {
  if (!VIBRANCY_ENABLED || typeof enabled !== 'boolean' || enabled === windowGlass) return;
  windowGlass = enabled;
  try {
    writeWindowGlass(windowGlassFile(), enabled);
  } catch (err) {
    elog('WARN', 'window', 'failed to save window glass', { error: String(err) });
  }
  for (const w of windows) if (!w.isDestroyed()) applyWindowGlass(w);
});

// Frozen glass: one downscaled capture of the window, blurred by the renderer
// in place of a live backdrop-filter (see backdropCapture.ts). Null when the
// window or the rect is gone, or the capture fails; the renderer then uses
// an opaque theme surface rather than returning to live backdrop sampling.
handleDesktopInvoke('app:captureBackdrop', async (event, rect) => {
  const diagnostics = process.env.MICHI_GLASS_DIAGNOSTICS === '1';
  const start = diagnostics ? performance.now() : 0;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) {
    if (diagnostics) elog('INFO', 'glass', 'backdrop timing', { outcome: 'window-gone' });
    return null;
  }
  const [width, height] = win.getContentSize();
  const bounds = backdropCaptureBounds(rect, event.sender.getZoomFactor(), { width, height });
  if (!bounds) {
    if (diagnostics) elog('INFO', 'glass', 'backdrop timing', { outcome: 'invalid-bounds' });
    return null;
  }
  try {
    const image = await event.sender.capturePage(bounds);
    const captured = diagnostics ? performance.now() : 0;
    if (image.isEmpty()) {
      if (diagnostics) elog('INFO', 'glass', 'backdrop timing', { outcome: 'empty', captureMs: captured - start });
      return null;
    }
    const resized = image.resize({ width: backdropImageWidth(bounds), quality: 'good' });
    const scaled = diagnostics ? performance.now() : 0;
    const url = resized.toDataURL();
    if (diagnostics) elog('INFO', 'glass', 'backdrop timing', {
      outcome: 'success', captureMs: captured - start, resizeMs: scaled - captured,
      encodeMs: performance.now() - scaled, dataUrlChars: url.length,
      sourceSize: image.getSize(), outputSize: resized.getSize(),
    });
    return url;
  } catch (err) {
    elog('WARN', 'glass', 'backdrop capture failed', { error: String(err), ...(diagnostics ? { elapsedMs: performance.now() - start } : {}) });
    return null;
  }
});

async function installDevExtensions(): Promise<void> {
  if (!isDev) return;
  try {
    const { downloadChromeExtension } = await import(
      'electron-devtools-installer/dist/downloadChromeExtension'
    ) as { downloadChromeExtension: (id: string, opts?: { forceDownload?: boolean }) => Promise<string> };
    const REACT_DEVELOPER_TOOLS_ID = 'fmkadmapgofadopljbjfkapdkoienihi';
    const { session } = await import('electron');
    const target = session.defaultSession;
    const extensions = target.extensions ?? (target as unknown as { extensions: { getAllExtensions: () => { id: string; name: string }[]; loadExtension: (path: string, opts?: { allowFileAccess?: boolean }) => Promise<{ name: string }> } }).extensions;
    const already = extensions.getAllExtensions().find((e: { id: string }) => e.id === REACT_DEVELOPER_TOOLS_ID);
    const folder = already ? null : await downloadChromeExtension(REACT_DEVELOPER_TOOLS_ID);
    const ext = already ?? (folder ? await extensions.loadExtension(folder, { allowFileAccess: true }) : null);
    if (ext) console.log(`[devtools] installed ${ext.name}`);
  } catch (err) {
    console.warn('[devtools] failed to install React DevTools:', err);
  }
}

// Chromium features must be switched off before the app is ready. Merge with
// any --disable-features Michi was launched with: a second switch would
// replace the first. See chromiumFeatures.ts for why each one is off.
const disabledFeatures = michiDisabledFeatures(process.platform, process.env, windowGlass);
if (disabledFeatures.length > 0) {
  const value = mergeFeatureList(app.commandLine.getSwitchValue('disable-features'), disabledFeatures);
  app.commandLine.appendSwitch('disable-features', value);
  elog('INFO', 'boot', 'disabled Chromium features', { features: value });
}

// Single-instance lock: when `michi` (CLI) and Spotlight both launch the same
// bundle, the second invocation should activate the existing window instead
// of spawning a duplicate backend + window. Acquired before whenReady so
// rejected instances exit cleanly without booting the backend.
if (!app.requestSingleInstanceLock()) {
  elog('INFO', 'boot', 'another instance owns the Electron profile; forwarded launch', { userData: app.getPath('userData') });
  app.exit(0);
}

app.on('second-instance', (_event, argv) => {
  // A background wake while we are already running needs no window.
  if (argv.includes(BACKGROUND_LAUNCH_ARG)) return;
  if (process.platform === 'win32') {
    const decision = windowsLifetime.handleSecondInstance(argv);
    if (decision.action === 'ignore' || decision.action === 'restore') return;
  }
  void createWindow();
});

// Registered at import so the Dock icon works however boot ends; until boot
// has opened its own window (or chosen none), boot owns the first window.
app.on('activate', () => {
  if (!bootWindowDecided || appQuitting) return;
  // Michi's own windows: a window of anything else (a smoke host, a
  // future tray popover) must not keep the Dock click from opening one.
  if (windows.size === 0) {
    cancelBackgroundIdleQuit();
    void createWindow();
  }
});

app.whenReady().then(async () => {
  powerMonitor.on('resume', () => {
    // A sleep can outlast the feed's connection: the tray refreshes as it comes back.
    trayController.scheduleRefresh();
    if (!resolvedBackendPort) return;
    // Ask the owning backend to check its forwards. A healthy SSH session
    // survives; repeated end-to-end failure triggers its bounded supervisor.
    const request = http.request({ hostname: '127.0.0.1', port: resolvedBackendPort,
      path: '/api/backend-connections/check', method: 'POST', timeout: 5_000 }, response => response.resume());
    request.on('timeout', () => request.destroy());
    request.on('error', () => {});
    request.end();
  });
  elog('INFO', 'boot', 'app ready', { isDev, isPackaged: app.isPackaged, logDir: LOG_DIR, launchCwd: LAUNCH_CWD });
  startupMark('electron_app_ready', { isDev, isPackaged: app.isPackaged, logDir: LOG_DIR });
  applyPowerSaveBlocker();
  // Windows shows and groups toasts under the app's id (package.json build.appId).
  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
  const requestedMode = startupMode({
    argv: process.argv,
    platform: process.platform,
    wasOpenedAtLogin: process.platform === 'win32' && app.getLoginItemSettings({ args: [LOGIN_LAUNCH_ARG] }).wasOpenedAtLogin === true,
    trayEnabled: traySupported(process.platform) && desktopSettings().tray.enabled,
  });
  try {
    // In dev the bare `electron` binary uses Electron's default dock icon —
    // override it so `npm run electron:dev` matches the packaged app.
    if (isDev && process.platform === 'darwin' && app.dock) {
      const devIcon = path.join(__dirname, '..', '..', 'assets', 'icons', 'icon.png');
      if (fs.existsSync(devIcon)) app.dock.setIcon(devIcon);
    }
    buildAppMenu();
    // The icon comes up before the backend answers ("Michi is starting…"); a
    // background launch shows none until the user opens a window.
    syncTray();
    // A login launch whose icon did not come up opens a window instead.
    const mode = startupModeAfterTray(requestedMode, trayIcon.current !== null);
    // The Windows icon follows the taskbar's light or dark theme.
    nativeTheme.on('updated', () => renderTray());

    // Fork the backend and get the port immediately (fast: ~50ms for port
    // selection + fork), then open the window while watchBackendBoot waits
    // for /api/health. In dev mode forkBackend returns null (external Vite
    // serves the frontend); in prod the backend serves the frontend HTML, so
    // the window shows a local skeleton until boot is ready (see BackendBoot).
    // A hidden background launch (woken by the service to deliver a
    // notification) keeps the Dock icon away until a window opens.
    if (launchedInBackground && process.platform === 'darwin' && app.dock) {
      app.dock.hide();
      dockHidden = true;
    }
    resolvedBackendPort = await startBackend();
    if (resolvedBackendPort === null) setBackendBoot('ready');
    else void watchBackendBoot(resolvedBackendPort);

    await installDevExtensions();
    if (mode === 'background') {
      elog('INFO', 'boot', 'background launch; delivering notifications without a window', { backendMode });
      armBackgroundIdleQuit();
    } else if (mode === 'tray' && process.platform !== 'win32') {
      elog('INFO', 'boot', 'login launch; starting in the notification area', { backendMode });
    } else {
      const ready = windowsLifetime.onAppReady({ launchedHidden: launchedHidden || requestedMode === 'tray' });
      void createWindow(undefined, undefined, { hidden: ready.startHidden }).catch((err) => {
        elog('ERROR', 'boot', 'the first window did not load', { err: (err as Error).message });
      });
    }
    bootWindowDecided = true;

    // The icon's state settles with boot: a backend that missed its first
    // health deadline shows "Can't reach Michi's backend", not "starting…"
    // forever; the controller's own polls and the feed's reconnect pick it up
    // once it answers.
    void whenBackendBoot(['ready', 'failed']).then(() => {
      if (!appQuitting) trayController.start();
    });
    void whenBackendBoot(['ready']).then(() => {
      if (appQuitting) return;
      elog('INFO', 'boot', 'starting the notification feed', { port: resolvedBackendPort, backendMode, mode });
      notificationFeed.start();
      companionFeed.start();
      initAutoUpdate({ isDev, isPackaged: app.isPackaged, sendToWindows: (channel, payload) => {
        for (const w of windows) if (!w.isDestroyed()) w.webContents.send(channel, payload);
      } });
    });
  } catch (err) {
    elog('ERROR', 'boot', 'startup failed', { err: (err as Error).message, stack: (err as Error).stack });
    // A window the Dock icon opens shows the failure page, not the skeleton.
    setBackendBoot('failed');
    bootWindowDecided = true;
    // The icon's state settles all the same (a backend that never became
    // healthy shows "Can't reach Michi's backend", not "starting…" forever),
    // and each menu opening tries again.
    trayController.start();
    throw err;
  }
});

if (process.platform === 'win32') {
  app.on('before-quit', () => { windowsLifetime.beginQuit('user'); });
}

app.on('window-all-closed', () => {
  if (process.platform === 'win32') {
    if (windowsLifetime.shouldQuitWhenNoWindows()) void app.quit();
    return;
  }
  const settings = desktopSettings();
  const action = windowAllClosedAction({
    platform: process.platform,
    trayShown: trayIcon.current !== null,
    hideDockWhenNoWindows: settings.tray.hideDockWhenNoWindows,
    hintShown: settings.tray.hintShown,
  });
  if (action.quit) {
    void app.quit();
    return;
  }
  if (action.hideDock) hideDock();
  if (action.showHint) showStillRunningHint();
});

// Electron emits before-quit before it asks the windows to close, and a
// window can still cancel the quit then (the running-terminals prompt does).
// will-quit comes only once every window has closed, so the feeds, the icon
// and the backend stop here, when the app really ends.
app.on('will-quit', async (ev) => {
  stopAutoUpdate();
  appQuitting = true;
  windowsLifetime.beginQuit('user');
  destroyWindowsTray();
  notificationFeed.stop();
  companionFeed.stop();
  // The quit goes ahead (app.quit() emits no window-all-closed): the icon
  // goes now, or Windows leaves a ghost icon in the notification area until
  // the pointer passes over it.
  trayController.stop();
  destroyTray();

  // Only an app-owned backend stops with the app. The background service
  // (backendMode === 'service') deliberately keeps running.
  if (backendChild) {
    ev.preventDefault();
    elog('INFO', 'boot', 'stopping backend on quit');
    await stopBackend();
    app.quit();
  }
});
