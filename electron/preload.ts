import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type {
  AppUpdateState, DesktopLifetimeStatus, BackdropRect, BackgroundServiceStatus, BrowserShellChord, BrowserSurfaceState, ChooseFolderResult, ChooseFoldersResult,
  CompanionTarget,
  DesktopBootstrapParam, DesktopBridge, DesktopCommandContract, DesktopEventContract, DesktopInvokeContract, DesktopInvokeArgs,
  DesktopResidency, DesktopResidencyPatch,
  DesktopInvokeResult, DesktopNotificationTarget, FilePreviewResult, FileTreeEntry, GitChangeEntry,
  RemoteAuthenticationTarget, SaveMarkdownResult, ScheduledRunTarget,
  TerminalSurfaceSnapshot, VibrancyMaterial,
} from 'michi-shared';

function invoke<K extends keyof DesktopInvokeContract>(channel: K, ...args: DesktopInvokeArgs<K>): Promise<DesktopInvokeResult<K>> {
  return ipcRenderer.invoke(channel, ...args);
}
function send<K extends keyof DesktopCommandContract>(channel: K, ...args: DesktopCommandContract[K]): void {
  ipcRenderer.send(channel, ...args);
}
function on<K extends keyof DesktopEventContract>(channel: K, handler: (...args: DesktopEventContract[K]) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: DesktopEventContract[K]) => handler(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Read bootstrap flags from the URL query string injected by main.ts —
// zero IPC, no sendSync blocking the renderer's main thread.
const _qs = new URLSearchParams(window.location.search);
const param = (name: DesktopBootstrapParam): string | null => _qs.get(name);
const isPackaged: boolean = param('michiPackaged') === '1';
const michiWindowId: string = param('michiWindowId') ?? '';
const hasVibrancy: boolean = param('michiVibrancy') === '1';
// Window glass may have been turned off (Settings → Appearance); main says so
// with michiGlass=0 and the window opens without the material.
let glassOn: boolean = hasVibrancy && param('michiGlass') !== '0';

// A window opened from a scheduled-run notification carries its target in
// the URL; the renderer opens it once the workspace has hydrated.
const initialScheduledRun: ScheduledRunTarget | null = param('michiOpenRun') && param('michiOpenWorkspace') && param('michiOpenJob')
  ? {
      runId: param('michiOpenRun')!,
      jobId: param('michiOpenJob')!,
      workspaceId: param('michiOpenWorkspace')!,
      nodeId: param('michiOpenNode'),
    }
  : null;

// A window opened from a notification's click carries its target (JSON, set
// by main.ts as COMPANION_TARGET_PARAM in attentionNotifications.ts); the
// renderer opens it once the workspace has hydrated.
const initialCompanionTarget: CompanionTarget | null = companionTargetFrom(_qs.get('michiCompanionTarget'));

/** A well-formed Companion target from its URL form, or null. Preload may load only 'electron', so this mirrors parseCompanionTarget. */
function companionTargetFrom(raw: string | null): CompanionTarget | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  const isId = (field: unknown): field is string => typeof field === 'string' && field.length > 0 && field.length <= 160;
  switch (target.kind) {
    case 'node':
      return isId(target.workspaceId) && isId(target.nodeId)
        ? { kind: 'node', workspaceId: target.workspaceId, nodeId: target.nodeId }
        : null;
    case 'url':
      return typeof target.url === 'string' && target.url.length <= 2048 && /^https?:\/\/\S/i.test(target.url)
        ? { kind: 'url', url: target.url }
        : null;
    case 'companion':
      if (target.tab !== 'chat' && target.tab !== 'today') return null;
      // The item to bring into view, on Today only.
      return target.tab === 'today' && isId(target.itemId)
        ? { kind: 'companion', tab: 'today', itemId: target.itemId }
        : { kind: 'companion', tab: target.tab };
    case 'settings':
      return { kind: 'settings' };
    default:
      return null;
  }
}

// Main sends notification clicks only to a renderer that listens for them
// (Electron drops a message nothing listens for, and the renderer subscribes
// only once the workspace has loaded), so this document reports when it
// starts and stops listening, as [kind, listening]. The name is
// COMPANION_READY_CHANNEL in attentionNotifications.ts; the renderer bridge
// has no method for it.
const COMPANION_READY_CHANNEL = 'companion:ready';
let companionOpenListeners = 0;

function onCompanionOpen(handler: (...args: DesktopEventContract['companion:open']) => void): () => void {
  const detach = on('companion:open', handler);
  companionOpenListeners += 1;
  if (companionOpenListeners === 1) ipcRenderer.send(COMPANION_READY_CHANNEL, 'open', true);
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    detach();
    companionOpenListeners -= 1;
    if (companionOpenListeners === 0) ipcRenderer.send(COMPANION_READY_CHANNEL, 'open', false);
  };
}

// Mark <html> before first paint so index.css can punch the see-through hole
// (transparent shell + sidebar) without an opaque→glass flash. document may not
// exist yet at preload start; set it as soon as it does.
function markVibrancy(): void {
  if (glassOn && document.documentElement) {
    document.documentElement.setAttribute('data-vibrancy', 'on');
  }
}
if (document.documentElement) markVibrancy();
else document.addEventListener('DOMContentLoaded', markVibrancy, { once: true });

const electronBridge = {
  openExternal(url: string): void { send('app:openExternal', url); },
  onOpenUrl(handler: (url: string) => void): () => void {
    return on('app:openUrl', handler);
  },
  isPackaged,
  michiWindowId,
  hasVibrancy,
  chooseFolder(): Promise<ChooseFolderResult> {
    return invoke('app:chooseFolder');
  },
  chooseFolders(): Promise<ChooseFoldersResult> {
    return invoke('app:chooseFolders');
  },
  resolveSkipCwd(projectId: string): Promise<{ path: string }> {
    return invoke('app:resolveSkipCwd', projectId);
  },
  saveMarkdown(suggestedName: string, content: string): Promise<SaveMarkdownResult> {
    return invoke('app:saveMarkdown', suggestedName, content);
  },
  openPath(absPath: string): Promise<{ ok: boolean; error?: string }> {
    return invoke('app:openPath', absPath);
  },
  /** Fire-and-forget OS notification via main process. With a target, its
   *  click focuses this window and comes back via onAttentionNotificationClick. */
  showNotification(title: string, body: string, target?: DesktopNotificationTarget): void {
    if (target) send('app:showNotification', title, body, target);
    else send('app:showNotification', title, body);
  },
  /** A notification this window raised with a target was clicked. */
  onAttentionNotificationClick(handler: (key: string) => void): () => void {
    return on('app:attentionNotificationClicked', handler);
  },
  /** Match native chrome and Browser panes to the active palette. */
  setDarkMaterial(dark: boolean, backgroundColor?: string): void {
    send('app:setDarkMaterial', dark, backgroundColor);
  },
  /** Switch the sidebar's native vibrancy material (desktop see-through density). */
  setVibrancy(material: VibrancyMaterial): void {
    send('app:setVibrancy', material);
  },
  /** Window glass on/off: flips the page's see-through CSS here, the native
   *  material in main. */
  setWindowGlass(enabled: boolean): void {
    if (!hasVibrancy || enabled === glassOn) return;
    glassOn = enabled;
    if (enabled) document.documentElement.setAttribute('data-vibrancy', 'on');
    else document.documentElement.removeAttribute('data-vibrancy');
    send('app:setWindowGlass', enabled);
  },
  /** The window's pixels in `rect` (CSS px) as a small PNG data URL, for frozen glass. */
  captureBackdrop(rect: BackdropRect): Promise<string | null> {
    return invoke('app:captureBackdrop', rect);
  },
  /** Relaunch the app (used after self-update). */
  relaunch(): void {
    send('app:relaunch');
  },
  /** Always-on backend (macOS LaunchAgent) status. */
  getBackgroundServiceStatus(): Promise<BackgroundServiceStatus> {
    return invoke('service:getStatus');
  },
  /** Hand the backend over to / back from the background service. */
  setBackgroundServiceEnabled(enabled: boolean): Promise<BackgroundServiceStatus> {
    return invoke('service:setEnabled', enabled);
  },
  getDesktopLifetimeStatus(): Promise<DesktopLifetimeStatus> {
    return invoke('lifetime:getStatus');
  },
  setKeepInBackground(enabled: boolean): Promise<DesktopLifetimeStatus> {
    return invoke('lifetime:setKeepInBackground', enabled);
  },
  setOpenAtLogin(enabled: boolean): Promise<DesktopLifetimeStatus> {
    return invoke('lifetime:setOpenAtLogin', enabled);
  },
  /** Menu bar / notification-area residency: the icon, the Dock icon, opening at login. */
  getResidency(): Promise<DesktopResidency> {
    return invoke('desktop:getResidency');
  },
  /** Change residency switches; resolves to the residency after the change (main refuses a switch this install lacks). */
  setResidency(patch: DesktopResidencyPatch): Promise<DesktopResidency> {
    return invoke('desktop:setResidency', patch);
  },
  initialScheduledRun,
  /** A scheduled run's notification was clicked while this window exists. */
  onScheduledRunOpen(handler: (target: ScheduledRunTarget) => void): () => void {
    return on('scheduled:open-run', handler);
  },
  getUpdateState(): Promise<AppUpdateState> {
    return invoke('app:getUpdateState');
  },
  checkForUpdate(): Promise<AppUpdateState> {
    return invoke('app:checkForUpdate');
  },
  downloadUpdate(): Promise<AppUpdateState> {
    return invoke('app:downloadUpdate');
  },
  installUpdate(): Promise<AppUpdateState> {
    return invoke('app:installUpdate');
  },
  onAppUpdate(listener: (state: AppUpdateState) => void): () => void {
    return on('app:update-state', listener);
  },
  initialCompanionTarget,
  /** A notification whose target is a conversation or Michi's panel was clicked (or a tray row), while this window exists. */
  onCompanionOpen(handler: (target: CompanionTarget) => void): () => void {
    return onCompanionOpen(handler);
  },
  chooseFiles(): Promise<{ canceled: boolean; paths?: string[] }> {
    return invoke('app:chooseFiles');
  },
  statFile(absPath: string): Promise<{ size: number; modifiedAt: number } | null> {
    return invoke('app:statFile', absPath);
  },
  listDirectory(absPath: string, allowedRoots: string[]): Promise<FileTreeEntry[]> {
    return invoke('app:listDirectory', absPath, allowedRoots);
  },
  readFilePreview(absPath: string): Promise<FilePreviewResult | null> {
    return invoke('app:readFilePreview', absPath);
  },
  listGitChanges(cwd: string, allowedRoots: string[]): Promise<GitChangeEntry[]> {
    return invoke('app:listGitChanges', cwd, allowedRoots);
  },
  getPathForFile(file: File): string | null {
    try {
      const p = webUtils.getPathForFile(file);
      return p && p.length > 0 ? p : null;
    } catch {
      return null;
    }
  },
  terminalCreate(surfaceId: string, cwd: string, cols: number, rows: number): Promise<TerminalSurfaceSnapshot> {
    return invoke('terminal:create', surfaceId, cwd, cols, rows);
  },
  terminalWrite(surfaceId: string, data: string): void {
    send('terminal:write', surfaceId, data);
  },
  remoteAuthCreate(surfaceId: string, target: RemoteAuthenticationTarget, cols: number, rows: number): Promise<TerminalSurfaceSnapshot> {
    return invoke('remote-auth:create', surfaceId, target, cols, rows);
  },
  terminalResize(surfaceId: string, cols: number, rows: number): void {
    send('terminal:resize', surfaceId, cols, rows);
  },
  terminalDestroy(surfaceId: string): void {
    send('terminal:destroy', surfaceId);
  },
  onTerminalData(handler: (surfaceId: string, data: string) => void): () => void {
    return on('terminal:data', handler);
  },
  onTerminalExit(handler: (surfaceId: string, exitCode: number) => void): () => void {
    return on('terminal:exit', handler);
  },
  browserCreate(surfaceId: string, projectId: string, url: string): Promise<BrowserSurfaceState> {
    return invoke('browser:create', surfaceId, projectId, url);
  },
  browserSetBounds(surfaceId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean): void {
    send('browser:set-bounds', surfaceId, bounds, visible);
  },
  browserNavigate(surfaceId: string, url: string): Promise<BrowserSurfaceState> {
    return invoke('browser:navigate', surfaceId, url);
  },
  browserBack(surfaceId: string): void { send('browser:back', surfaceId); },
  browserForward(surfaceId: string): void { send('browser:forward', surfaceId); },
  browserReload(surfaceId: string): void { send('browser:reload', surfaceId); },
  browserStop(surfaceId: string): void { send('browser:stop', surfaceId); },
  browserDestroy(surfaceId: string): void { send('browser:destroy', surfaceId); },
  onBrowserState(handler: (state: BrowserSurfaceState) => void): () => void {
    return on('browser:state', handler);
  },
  onBrowserFocus(handler: (surfaceId: string) => void): () => void {
    return on('browser:focus', handler);
  },
  onBrowserCloseRequest(handler: (surfaceId: string) => void): () => void {
    return on('browser:close-request', handler);
  },
  onBrowserShortcut(handler: (surfaceId: string, chord: BrowserShellChord) => void): () => void {
    return on('browser:shortcut', handler);
  },
} satisfies DesktopBridge & { getPathForFile(file: File): string | null };

contextBridge.exposeInMainWorld('electron', electronBridge);
