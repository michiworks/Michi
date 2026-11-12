/**
 * Michi's menu-bar (macOS) / notification-area (Windows) icon, DESIGN-v2 §5.1:
 * how Michi starts and what closing its last window does, the menu, the
 * icon, and the data behind them.
 *
 * The data is `GET /api/companion/tray` (CompanionTrayDto, computed by the
 * backend: Electron main loads no workspace package at runtime). It is
 * fetched again, debounced, after each `companion_changed` frame on the
 * notifier feed main already holds (companionNotifications.ts), and once a
 * minute with no frame (its status line carries an age), so a click pops the
 * menu up from the cached copy at once, without fetching first.
 *
 * Nothing here imports `electron`: main injects the Tray and Menu and turns
 * the plain menu model into Electron's template, so all of it is testable
 * in Node (scripts/electron-tray.test.mjs).
 */
import * as http from 'node:http';
import { parseCompanionTarget, type CompanionTarget } from './companionNotifications';

// ── How Michi starts and what closing its last window does ──────────────────

/** Passed by the backend's app launcher (macOS service): a hidden launch that only delivers notifications. */
export const BACKGROUND_LAUNCH_ARG = '--michi-background-launch';
/** Passed by the Windows login item ("Open Michi at login"): start in the notification area. */
export const LOGIN_LAUNCH_ARG = '--michi-login-launch';
/** The packaged app's id (package.json build.appId); Windows groups toasts under it. */
export const APP_USER_MODEL_ID = 'com.michi.app';

/**
 * `window`: open a window (and the icon, when on). `tray`: the icon only, no
 * window (Windows at login). `background`: a hidden launch by the background
 * service that only delivers notifications; it shows no icon until the user
 * opens a window, and quits again after 15 idle minutes (main.ts).
 */
export type StartupMode = 'window' | 'tray' | 'background';

export interface StartupModeInput {
  argv: readonly string[];
  platform: string;
  /** The OS's own word that it opened Michi at login. */
  wasOpenedAtLogin: boolean;
  /** The menu-bar / notification-area icon is on (desktop-settings.json). */
  trayEnabled: boolean;
}

/**
 * Only Windows offers "Open Michi at login" (its login item passes
 * LOGIN_LAUNCH_ARG). macOS does not: after a restart the background service
 * brings Michi back when it has something to show (Q3), and a Login Items
 * entry the user added opens a window, as before v2. A login launch with the
 * icon turned off opens a window too: nothing else would show Michi is running.
 */
export function startupMode({ argv, platform, wasOpenedAtLogin, trayEnabled }: StartupModeInput): StartupMode {
  if (argv.includes(BACKGROUND_LAUNCH_ARG)) return 'background';
  const atLogin = platform === 'win32' && (argv.includes(LOGIN_LAUNCH_ARG) || wasOpenedAtLogin);
  return atLogin && trayEnabled ? 'tray' : 'window';
}

/**
 * The mode once the icon was tried: a login launch whose icon did not come
 * up (TrayIconSlot) opens a window, as before v2, since nothing else would
 * show that Michi runs.
 */
export function startupModeAfterTray(mode: StartupMode, trayShown: boolean): StartupMode {
  return mode === 'tray' && !trayShown ? 'window' : mode;
}

/**
 * `app.relaunch({args})` after an update: this instance's arguments (after
 * the executable) without the login and background flags, or a relaunched
 * login launch would start in the notification area and a woken one hidden,
 * and Michi would seem to vanish.
 */
export function relaunchArgs(argv: readonly string[]): string[] {
  return argv.slice(1).filter((arg) => arg !== LOGIN_LAUNCH_ARG && arg !== BACKGROUND_LAUNCH_ARG);
}

export interface WindowAllClosedInput {
  platform: string;
  /** The icon is up. */
  trayShown: boolean;
  /** macOS: "Hide the Dock icon when no windows are open" (default off). */
  hideDockWhenNoWindows: boolean;
  /** The one-time "still running" note was shown before (desktop-settings.json). */
  hintShown: boolean;
}

export interface WindowAllClosedAction {
  quit: boolean;
  hideDock: boolean;
  /** Say once, on either platform, that Michi still runs in the menu bar / notification area. */
  showHint: boolean;
}

/**
 * With the icon up Michi keeps running on macOS and Windows alike. Without
 * it, as before v2: macOS keeps running with its Dock icon, other platforms
 * quit. The Dock icon goes only while the icon is up, or Michi would vanish.
 */
export function windowAllClosedAction({ platform, trayShown, hideDockWhenNoWindows, hintShown }: WindowAllClosedInput): WindowAllClosedAction {
  if (trayShown) return { quit: false, hideDock: platform === 'darwin' && hideDockWhenNoWindows, showHint: !hintShown };
  return { quit: platform !== 'darwin', hideDock: false, showHint: false };
}

/** The one-time note after the last window closes. */
export function stillRunningHint(platform: string): { title: string; body: string } {
  return {
    title: 'Michi',
    body: platform === 'win32' ? 'Michi is still running in the notification area.' : 'Michi is still running in the menu bar.',
  };
}

/** What a click on the icon does: macOS pops the menu up on either button; Windows opens Michi on a left click and the menu on a right one. */
export function trayClickBehavior(platform: string, click: 'click' | 'right-click' | 'double-click'): 'menu' | 'open-michi' | 'none' {
  if (platform === 'win32') return click === 'right-click' ? 'menu' : 'open-michi';
  return click === 'double-click' ? 'none' : 'menu';
}

/**
 * Lets the OS keep the icon where the user put it. Windows binds the GUID to
 * the executable's path, so dev and packaged builds must not share it: only
 * the packaged build passes one there.
 */
const TRAY_GUID = '6a1f3c52-8d4e-4b7a-9c21-5e0f8b3d7a14';

export function trayGuid(platform: string, packaged: boolean): string | undefined {
  if (platform === 'darwin') return TRAY_GUID;
  return platform === 'win32' && packaged ? TRAY_GUID : undefined;
}

// ── The data: a mirror of shared/src/companion.ts CompanionTrayDto ───────────

export type TrayStatusTone = 'ok' | 'working' | 'quiet' | 'off' | 'warn';

export interface TrayItem {
  id: string;
  title: string;
  isNew: boolean;
  target: CompanionTarget;
}

/**
 * The fields of CompanionTrayDto the menu reads (main.ts checks the shared
 * type still fits). The welcome is `welcomeWanted`, the panel's rule; the
 * deprecated `welcomeDone` is never read (W0b recheck D-1).
 */
export interface TrayCompanionDto {
  displayName: string;
  enabled: boolean;
  paused: boolean;
  welcomeWanted: boolean;
  conversationWaiting: boolean;
  statusLine: { text: string; tone: TrayStatusTone };
  badge: number;
  needsYou: TrayItem[];
  needsYouTotal: number;
  briefReady: boolean;
  revision: number;
}

/** The name until a DTO says otherwise: DEFAULT_COMPANION_NAME (DESIGN-v2 Q4). */
const DEFAULT_NAME = 'Michi';
const MAX_NAME_CHARS = 40;
const MAX_TITLE_CHARS = 80;
const MAX_STATUS_CHARS = 80;
const MAX_ID_CHARS = 160;
/** "Needs you" shows at most this many rows. */
export const TRAY_MAX_NEEDS_YOU = 5;
const TONES: readonly TrayStatusTone[] = ['ok', 'working', 'quiet', 'off', 'warn'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** One line, control characters out, at most `max` characters. */
function oneLine(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function parseTrayItem(value: unknown): TrayItem | null {
  if (!isRecord(value)) return null;
  const { id, title, isNew, target } = value;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_CHARS || typeof title !== 'string') return null;
  const text = oneLine(title, MAX_TITLE_CHARS);
  if (!text) return null;
  return {
    id,
    title: text,
    isNew: isNew === true,
    // A target this app cannot place opens Today at the item.
    target: parseCompanionTarget(target) ?? { kind: 'companion', tab: 'today', itemId: id },
  };
}

/**
 * A DTO from `GET /api/companion/tray`, rebuilt from its known fields, or
 * null when its core is malformed. Rows the menu can do without fall back
 * (a bad row is dropped; a missing flag reads as false).
 */
export function parseCompanionTrayDto(value: unknown): TrayCompanionDto | null {
  if (!isRecord(value)) return null;
  const { displayName, enabled, paused, statusLine, badge, revision } = value;
  if (typeof displayName !== 'string' || typeof enabled !== 'boolean' || typeof paused !== 'boolean') return null;
  if (!isRecord(statusLine) || typeof statusLine.text !== 'string' || !TONES.includes(statusLine.tone as TrayStatusTone)) return null;
  if (!isCount(badge) || typeof revision !== 'number' || !Number.isFinite(revision)) return null;
  const needsYou = (Array.isArray(value.needsYou) ? value.needsYou : [])
    .map(parseTrayItem)
    .filter((item): item is TrayItem => item !== null)
    .slice(0, TRAY_MAX_NEEDS_YOU);
  return {
    displayName: oneLine(displayName, MAX_NAME_CHARS) || DEFAULT_NAME,
    enabled,
    paused,
    welcomeWanted: value.welcomeWanted === true,
    conversationWaiting: value.conversationWaiting === true,
    statusLine: { text: oneLine(statusLine.text, MAX_STATUS_CHARS), tone: statusLine.tone as TrayStatusTone },
    badge,
    needsYou,
    needsYouTotal: Math.max(needsYou.length, isCount(value.needsYouTotal) ? value.needsYouTotal : 0),
    briefReady: value.briefReady === true,
    revision,
  };
}

/**
 * What the icon knows. `loading`: the backend has not answered yet (it is
 * starting). `unreachable`: it did not answer, or answered badly.
 * `unsupported`: it has no tray endpoint (404: an older backend).
 */
export type TrayData =
  | { kind: 'loading' }
  | { kind: 'ready'; dto: TrayCompanionDto }
  | { kind: 'unreachable'; displayName: string }
  | { kind: 'unsupported'; displayName: string };

function nameOf(data: TrayData): string {
  if (data.kind === 'ready') return data.dto.displayName;
  return data.kind === 'loading' ? DEFAULT_NAME : data.displayName;
}

// ── The menu ─────────────────────────────────────────────────────────────────

export type TrayAction =
  /** Bring Michi forward with the agent's panel at the target (as a notification click). */
  | { kind: 'open'; target: CompanionTarget }
  /** Focus the last Michi window, or open one. */
  | { kind: 'open-michi' }
  | { kind: 'check-now' }
  | { kind: 'set-paused'; paused: boolean }
  | { kind: 'quit' };

export type TrayMenuEntry =
  | { type: 'item'; label: string; enabled: boolean; action: TrayAction | null }
  | { type: 'separator' };

export interface TrayMenuEnv {
  platform: string;
  /** A short-lived status that replaces the status row, e.g. after Check now met another Michi. */
  transientStatus?: string | null;
}

const CHAT: CompanionTarget = { kind: 'companion', tab: 'chat' };
const TODAY: CompanionTarget = { kind: 'companion', tab: 'today' };
const SETTINGS: CompanionTarget = { kind: 'settings' };

/** Windows reads `&` in a menu label as the mnemonic marker; text from the backend keeps its own. */
function menuText(text: string, platform: string): string {
  return platform === 'win32' ? text.replace(/&/g, '&&') : text;
}

function item(label: string, action: TrayAction | null, enabled = action !== null): TrayMenuEntry {
  return { type: 'item', label, enabled, action };
}

/**
 * The menu (DESIGN-v2 §5.1), top to bottom: the status row; Needs you (≤5),
 * View all in Today and Today's brief; Chat with <name>, Check now,
 * Pause/Resume check-ins; Open Michi, Settings…, Quit Michi. It names the
 * agent by its display name and marks no shortcut (⌘J is a window shortcut,
 * not a global one). Item titles only, never a summary.
 */
export function trayMenuModel(data: TrayData, env: TrayMenuEnv): TrayMenuEntry[] {
  const name = menuText(nameOf(data), env.platform);
  const menu: TrayMenuEntry[] = [];
  const dto = data.kind === 'ready' ? data.dto : null;

  let status: TrayMenuEntry | null;
  if (env.transientStatus) status = item(env.transientStatus, null);
  else if (data.kind === 'loading') status = item('Michi is starting…', null);
  else if (data.kind === 'unreachable') status = item("Can't reach Michi's backend", null);
  else if (!dto) status = null;
  // The conversation still answers with check-ins off, so its wait comes first.
  else if (dto.conversationWaiting) status = item(`${name} is waiting for you`, { kind: 'open', target: CHAT });
  // welcomeWanted is the panel's "not met yet"; like the panel (CompanionChatTab's
  // maySpeak) the tray offers the hello only while the agent may speak, since the
  // backend starts no welcome while it is off or paused (coordinator welcomeBlocked).
  else if (dto.enabled && !dto.paused && dto.welcomeWanted) status = item(`Say hello to ${name}`, { kind: 'open', target: CHAT });
  else {
    // A warning ("Auth expired — refresh your credentials", a source degraded) opens Settings,
    // where it is fixed (E-map §2.4); any other status is only read.
    const action: TrayAction | null = dto.statusLine.tone === 'warn' ? { kind: 'open', target: SETTINGS } : null;
    status = item(`${name} · ${menuText(dto.statusLine.text, env.platform)}`, action);
  }
  if (status) menu.push(status);

  if (dto?.enabled) {
    if (dto.needsYou.length > 0) {
      menu.push(item('Needs you', null));
      for (const row of dto.needsYou) {
        menu.push(item(`${row.isNew ? '●' : '○'} ${menuText(row.title, env.platform)}`, { kind: 'open', target: row.target }));
      }
      menu.push(item('View all in Today', { kind: 'open', target: TODAY }));
    }
    if (dto.briefReady) menu.push(item("Today's brief", { kind: 'open', target: TODAY }));
  }
  if (menu.length > 0) menu.push({ type: 'separator' });

  menu.push(item(`Chat with ${name}`, { kind: 'open', target: CHAT }));
  if (dto) {
    if (dto.enabled) {
      menu.push(item('Check now', { kind: 'check-now' }));
      menu.push(dto.paused
        ? item('Resume check-ins', { kind: 'set-paused', paused: false })
        : item('Pause check-ins', { kind: 'set-paused', paused: true }));
    } else {
      // Check-ins are off: the switch lives in Settings.
      menu.push(item('Turn on check-ins…', { kind: 'open', target: SETTINGS }));
    }
  } else if (data.kind !== 'unsupported') {
    // Starting, or the backend does not answer: shown, but nothing to act on yet.
    menu.push(item('Check now', { kind: 'check-now' }, false));
    menu.push(item('Pause check-ins', { kind: 'set-paused', paused: true }, false));
  }
  menu.push({ type: 'separator' });
  menu.push(item('Open Michi', { kind: 'open-michi' }));
  menu.push(item('Settings…', { kind: 'open', target: SETTINGS }));
  menu.push({ type: 'separator' });
  menu.push(item('Quit Michi', { kind: 'quit' }));
  return menu;
}

/** The part of Electron's MenuItemConstructorOptions the tray menu uses. */
export interface TrayMenuTemplateItem {
  type?: 'separator';
  label?: string;
  enabled?: boolean;
  click?: () => void;
}

/** Electron's menu template for a model: `Menu.buildFromTemplate(trayMenuTemplate(model, dispatch))`. */
export function trayMenuTemplate(model: readonly TrayMenuEntry[], dispatch: (action: TrayAction) => void): TrayMenuTemplateItem[] {
  return model.map((entry) => {
    if (entry.type === 'separator') return { type: 'separator' };
    const { action } = entry;
    return action && entry.enabled
      ? { label: entry.label, enabled: true, click: () => dispatch(action) }
      : { label: entry.label, enabled: false };
  });
}

// ── The icon ─────────────────────────────────────────────────────────────────

/** `attention`: the glyph with a dot, while something waits for the user (the Topbar badge, or the conversation waiting). */
export type TrayIconState = 'normal' | 'attention';

export function trayIconState(data: TrayData): TrayIconState {
  return data.kind === 'ready' && (data.dto.badge > 0 || data.dto.conversationWaiting) ? 'attention' : 'normal';
}

/**
 * The file under assets/icons for the icon (generated by
 * scripts/generate-icons.mjs from assets/icons/tray-glyph.png). macOS: a
 * template image (its @2x sibling loads with it). Windows: `-light` for a
 * light taskbar (a dark glyph), `-dark` for a dark one
 * (nativeTheme.shouldUseDarkColorsForSystemIntegratedUI).
 */
export function trayIconFile(data: TrayData, platform: string, darkTaskbar: boolean): string {
  const attention = trayIconState(data) === 'attention';
  if (platform === 'win32') return `tray${attention ? '-attention' : ''}-${darkTaskbar ? 'dark' : 'light'}.ico`;
  return attention ? 'trayAttentionTemplate.png' : 'trayTemplate.png';
}

// ── The icon's lifecycle: an icon that can be seen, or none ─────────────────

type TrayLog = (level: 'INFO' | 'WARN', message: string, meta?: Record<string, unknown>) => void;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The part of Electron's NativeImage the icon's lifecycle reads. */
export interface TrayImageLike {
  isEmpty(): boolean;
}

/** The part of Electron's Tray the icon's lifecycle drives. */
export interface TrayIconLike<I> {
  setImage(image: I): void;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface TrayIconSlotOptions<I, T> {
  /** The image of an icon file under assets/icons (nativeImage.createFromPath: a file that is not there gives an empty image). */
  load(file: string): I;
  /** `new Tray(image, guid?)`; it may throw. */
  construct(image: I, guid?: string): T;
  log?: TrayLog;
}

/**
 * Holds the icon, if there is one. It comes up only with an image that
 * shows, and changing its file never blanks it. When it cannot come up (an
 * icon file missing from the package, the OS refusing it) there is none and
 * nothing throws, so Michi behaves as before v2: closing the last window
 * quits on Windows and keeps the Dock icon on macOS (windowAllClosedAction),
 * and a login launch opens a window (startupModeAfterTray). A blank icon
 * would instead keep Michi running with no visible way back.
 */
export class TrayIconSlot<I extends TrayImageLike, T extends TrayIconLike<I>> {
  private icon: T | null = null;
  private file: string | null = null;
  /** Each file is loaded once; null: it cannot be shown. */
  private readonly images = new Map<string, I | null>();

  constructor(private readonly options: TrayIconSlotOptions<I, T>) {}

  /** The icon while it is up. */
  get current(): T | null {
    if (this.icon?.isDestroyed()) {
      this.icon = null;
      this.file = null;
    }
    return this.icon;
  }

  /**
   * Puts the icon up with `file`, then runs `setup` on it (its listeners);
   * null, with the reason logged, when it cannot come up. A GUID the OS has
   * bound to another executable path is refused, so a refusal with one is
   * tried once more without it. A `setup` that throws takes the icon down.
   */
  show(file: string, guid: string | undefined, setup?: (icon: T) => void): T | null {
    const up = this.current;
    if (up) return up;
    const image = this.image(file);
    if (!image) return null;
    const icon = this.construct(image, guid);
    if (!icon) return null;
    this.icon = icon;
    this.file = file;
    try {
      setup?.(icon);
    } catch (error) {
      this.options.log?.('WARN', 'tray icon could not be set up', { error: errorText(error) });
      this.destroy();
      return null;
    }
    return icon;
  }

  /** Shows `file`; one that cannot be shown leaves the icon as it is. */
  setFile(file: string): void {
    const icon = this.current;
    if (!icon || file === this.file) return;
    const image = this.image(file);
    if (!image) return;
    try {
      icon.setImage(image);
      this.file = file;
    } catch (error) {
      this.options.log?.('WARN', 'tray icon image not changed', { file, error: errorText(error) });
    }
  }

  /** Takes the icon down; afterwards there is none, even if the OS call throws. */
  destroy(): void {
    const icon = this.icon;
    this.icon = null;
    this.file = null;
    if (!icon) return;
    try {
      if (!icon.isDestroyed()) icon.destroy();
    } catch (error) {
      this.options.log?.('WARN', 'tray icon could not be destroyed', { error: errorText(error) });
    }
  }

  private construct(image: I, guid: string | undefined): T | null {
    if (guid) {
      try {
        return this.options.construct(image, guid);
      } catch (error) {
        this.options.log?.('WARN', 'tray icon could not keep its position', { error: errorText(error) });
      }
    }
    try {
      return this.options.construct(image);
    } catch (error) {
      this.options.log?.('WARN', 'tray icon could not be shown', { error: errorText(error) });
      return null;
    }
  }

  private image(file: string): I | null {
    if (this.images.has(file)) return this.images.get(file) ?? null;
    let image: I | null = null;
    try {
      const loaded = this.options.load(file);
      if (loaded.isEmpty()) this.options.log?.('WARN', 'tray icon missing', { file });
      else image = loaded;
    } catch (error) {
      this.options.log?.('WARN', 'tray icon could not be loaded', { file, error: errorText(error) });
    }
    this.images.set(file, image);
    return image;
  }
}

/** The hover text: "Michi", plus what waits. */
export function trayTooltip(data: TrayData): string {
  if (data.kind !== 'ready') return 'Michi';
  const { dto } = data;
  if (dto.conversationWaiting) return `Michi — ${dto.displayName} is waiting for you`;
  return dto.badge > 0 ? `Michi — ${dto.badge} new` : 'Michi';
}

// ── The controller: fetch, debounce, cache, act ──────────────────────────────

/** `'/api' + COMPANION_TRAY_PATH` (shared; scripts/electron-tray.test.mjs checks the two agree). */
export const TRAY_DATA_PATH = '/api/companion/tray';
const CHECK_PATH = '/api/companion/check';
const SETTINGS_PATH = '/api/companion/settings';

/** A `companion_changed` frame is followed by one fetch, this long after the first frame of a burst. */
export const TRAY_REFRESH_DEBOUNCE_MS = 500;
/**
 * With no change signal the copy is fetched again this long after the last
 * fetch, while the icon is up. The status line carries an age ("Watching ·
 * checked 2m ago", companionStatusLine) and turns at times no frame marks
 * (quiet hours begin and end, the turn budget resumes the next day), so the
 * first click after a quiet hour must not show the hour-old line. It also
 * retries a backend that did not answer, but not one without the endpoint
 * (404), which only a restart changes. The backend leaves these polls out of
 * its access log (accessLog.ts).
 */
export const TRAY_STALE_REFRESH_MS = 60_000;
/** How long "Another Michi is checking" replaces the status row. */
export const TRAY_TRANSIENT_STATUS_MS = 5_000;

export interface TrayControllerOptions {
  /** Current backend port; null while there is none. */
  port(): number | null;
  /** The cached data changed: main redraws the icon and the tooltip. */
  onChange?(data: TrayData): void;
  log?(level: 'INFO' | 'WARN', message: string, meta?: Record<string, unknown>): void;
  debounceMs?: number;
  /** TRAY_STALE_REFRESH_MS by default. */
  staleRefreshMs?: number;
  requestTimeoutMs?: number;
  transientStatusMs?: number;
  now?(): number;
  /** Runs `callback` after `delayMs`; the returned function cancels it. Default: an unref'd setTimeout. */
  setTimer?(callback: () => void, delayMs: number): () => void;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

/**
 * Keeps the tray's copy of CompanionTrayDto: fetched when the icon is up and
 * the backend is ready, then again after each change signal (debounced),
 * after its own actions, and a minute after the last fetch when nothing else
 * asked (TRAY_STALE_REFRESH_MS). A click reads the copy; it never waits on
 * the network.
 */
export class TrayController {
  private data: TrayData = { kind: 'loading' };
  private active = false;
  private started = false;
  private inFlight = false;
  /** A change arrived while a fetch was out: fetch once more after it. */
  private dirty = false;
  private generation = 0;
  private cancelDebounce: (() => void) | null = null;
  /** The minute's fetch, armed after each fetch while nothing else is due. */
  private cancelStale: (() => void) | null = null;
  private transient: { text: string; until: number } | null = null;
  private lastFailure: string | null = null;

  constructor(private readonly options: TrayControllerOptions) {}

  current(): TrayData {
    return this.data;
  }

  /** The icon is up (true) or gone (false). While it is gone nothing is fetched. */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.generation += 1;
    this.cancelPending();
    if (active && this.started) void this.refresh();
  }

  /** The backend answers its health check: fetching may begin. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.active) void this.refresh();
  }

  /** Stop fetching (quit, relaunch). */
  stop(): void {
    this.started = false;
    this.generation += 1;
    this.cancelPending();
  }

  /** Something changed (a `companion_changed` frame, a notice, a reconnect, a wake): fetch soon, once per burst. */
  scheduleRefresh(): void {
    if (!this.active || !this.started) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    if (this.cancelDebounce) return;
    this.cancelDebounce = (this.options.setTimer ?? unrefTimer)(() => {
      this.cancelDebounce = null;
      void this.refresh();
    }, this.options.debounceMs ?? TRAY_REFRESH_DEBOUNCE_MS);
  }

  /** Fetch now. */
  async refresh(): Promise<void> {
    if (!this.active || !this.started) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    this.cancelDebounce?.();
    this.cancelDebounce = null;
    this.cancelStale?.();
    this.cancelStale = null;
    this.inFlight = true;
    const generation = this.generation;
    let next: TrayData;
    try {
      const response = await this.request('GET', TRAY_DATA_PATH);
      if (response.status === 404) {
        next = { kind: 'unsupported', displayName: nameOf(this.data) };
      } else {
        const dto = response.status === 200 ? parseCompanionTrayDto(response.body) : null;
        if (!dto) this.noteFailure(`status ${response.status}${response.status === 200 ? ' (malformed)' : ''}`);
        next = dto ? { kind: 'ready', dto } : { kind: 'unreachable', displayName: nameOf(this.data) };
      }
    } catch (error) {
      this.noteFailure(error instanceof Error ? error.message : String(error));
      next = { kind: 'unreachable', displayName: nameOf(this.data) };
    } finally {
      this.inFlight = false;
    }
    // The icon went away (or came back) meanwhile: this answer is not for it,
    // but a fetch the new icon asked for while this one was out goes now.
    if (generation !== this.generation) {
      if (this.dirty) {
        this.dirty = false;
        void this.refresh();
      }
      return;
    }
    if (next.kind === 'ready') this.lastFailure = null;
    this.apply(next);
    if (this.dirty) {
      this.dirty = false;
      this.scheduleRefresh();
    }
    // A backend without the endpoint (404) gets no minute poll, so it logs no warning a minute: a backend
    // restart, a feed reconnect, a click or an action fetches again (D2-review #1).
    if (next.kind !== 'unsupported') this.armStaleRefresh();
  }

  /** The menu as it stands, from the cached copy. */
  menu(platform: string): TrayMenuEntry[] {
    const now = (this.options.now ?? Date.now)();
    if (this.transient && this.transient.until <= now) this.transient = null;
    return trayMenuModel(this.data, { platform, transientStatus: this.transient?.text ?? null });
  }

  /** Check now: `POST /api/companion/check`. A 409 `not_owner` means another Michi runs the agent on this computer. */
  async checkNow(): Promise<void> {
    try {
      const response = await this.request('POST', CHECK_PATH, {});
      if (response.status === 409 && isRecord(response.body) && response.body.code === 'not_owner') {
        this.transient = { text: 'Another Michi is checking', until: (this.options.now ?? Date.now)() + (this.options.transientStatusMs ?? TRAY_TRANSIENT_STATUS_MS) };
      } else if (response.status >= 300) {
        this.options.log?.('WARN', 'tray check now refused', { status: response.status });
      }
    } catch (error) {
      this.options.log?.('WARN', 'tray check now failed', { error: error instanceof Error ? error.message : String(error) });
    }
    this.scheduleRefresh();
  }

  /** Pause or resume check-ins: `PATCH /api/companion/settings {paused}`, then the menu follows at once. */
  async setPaused(paused: boolean): Promise<void> {
    try {
      const response = await this.request('PATCH', SETTINGS_PATH, { paused });
      if (response.status >= 300) this.options.log?.('WARN', 'tray pause refused', { status: response.status });
    } catch (error) {
      this.options.log?.('WARN', 'tray pause failed', { error: error instanceof Error ? error.message : String(error) });
    }
    await this.refresh();
  }

  private apply(next: TrayData): void {
    if (JSON.stringify(next) === JSON.stringify(this.data)) return;
    this.data = next;
    this.options.onChange?.(next);
  }

  /** A failure is logged when it differs from the last one, not on every retry. */
  private noteFailure(reason: string): void {
    if (this.lastFailure === reason) return;
    this.lastFailure = reason;
    this.options.log?.('WARN', 'tray data unavailable', { reason });
  }

  /**
   * The next fetch a minute after this one. Called only as a fetch for this
   * icon ends (so it is up and started, and no fetch is out); a fetch that
   * starts sooner (a change, a click, an action) cancels it, and so does the
   * icon going away or stop().
   */
  private armStaleRefresh(): void {
    this.cancelStale = (this.options.setTimer ?? unrefTimer)(() => {
      this.cancelStale = null;
      void this.refresh();
    }, this.options.staleRefreshMs ?? TRAY_STALE_REFRESH_MS);
  }

  private cancelPending(): void {
    this.cancelDebounce?.();
    this.cancelDebounce = null;
    this.cancelStale?.();
    this.cancelStale = null;
    this.dirty = false;
  }

  /** A loopback JSON request without an Origin, like the notice acknowledgements (the backend's origin guard lets it through). */
  private request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<JsonResponse> {
    const port = this.options.port();
    if (!port) return Promise.reject(new Error('no backend port'));
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          accept: 'application/json',
          ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
        timeout: this.options.requestTimeoutMs ?? 5_000,
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          if (text.length > 256_000) req.destroy(new Error('tray response too large'));
        });
        res.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('tray request timed out')));
      req.on('error', reject);
      req.end(payload ?? undefined);
    });
  }
}

function unrefTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
