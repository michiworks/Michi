import { getElectron, type DesktopNotificationTarget, type ElectronBridge } from '../../lib/electronBridge';

/** How long a click on a desktop notification can still open its target.
 *  Notification Center keeps them for hours; a stale handler is not worth it. */
const CLICK_TTL_MS = 30 * 60_000;
const MAX_CLICK_TARGETS = 64;
/** Browser notifications held so their onclick survives garbage collection. */
const MAX_BROWSER_NOTIFICATIONS = 16;

interface OsNotification {
  /** One OS notification per key: a newer one replaces the older one, and alerts again. */
  key: string;
  title: string;
  body?: string;
  /** Mute the OS sound (the caller plays its own). */
  silent?: boolean;
  /** Runs after the window has been focused by a click on the notification. */
  onOpen?: () => void;
}

const clickTargets = new Map<string, { open: () => void; expiresAt: number }>();
const browserNotifications = new Set<Notification>();
let listeningTo: ElectronBridge | null = null;

function rememberClick(key: string, open: () => void): void {
  const now = Date.now();
  clickTargets.delete(key);
  clickTargets.set(key, { open, expiresAt: now + CLICK_TTL_MS });
  for (const [candidate, entry] of clickTargets) {
    if (clickTargets.size <= MAX_CLICK_TARGETS && entry.expiresAt > now) break;
    clickTargets.delete(candidate);
  }
}

function openClicked(key: string): void {
  const entry = clickTargets.get(key);
  clickTargets.delete(key);
  if (entry && entry.expiresAt > Date.now()) entry.open();
}

/** False for older builds, whose clicks only focus a window. */
function listenForClicks(electron: ElectronBridge): boolean {
  if (listeningTo === electron) return true;
  if (!electron.onAttentionNotificationClick) return false;
  listeningTo = electron;
  electron.onAttentionNotificationClick(openClicked);
  return true;
}

/**
 * Show an OS notification whose click returns to this window and runs
 * `onOpen`. Electron routes the click back through main (older builds only
 * focus a window); browsers need notification permission already granted.
 */
export function showOsNotification({ key, title, body, silent, onOpen }: OsNotification): void {
  const electron = getElectron();
  if (electron?.showNotification) {
    if (onOpen && listenForClicks(electron)) rememberClick(key, onOpen);
    const target: DesktopNotificationTarget = silent ? { key, silent } : { key };
    electron.showNotification(title, body ?? '', target);
    return;
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  let notification: Notification;
  try {
    // The tag replaces an older notification for the target; renotify alerts
    // again for the newer one, which would otherwise update in place unseen.
    const options: NotificationOptions & { renotify?: boolean } = { body: body ?? '', tag: key, renotify: true, silent: silent === true };
    notification = new Notification(title, options);
  } catch {
    return; // Some browsers only allow notifications from a service worker.
  }
  browserNotifications.add(notification);
  for (const oldest of browserNotifications) {
    if (browserNotifications.size <= MAX_BROWSER_NOTIFICATIONS) break;
    browserNotifications.delete(oldest);
  }
  const release = () => { browserNotifications.delete(notification); };
  notification.onclose = release;
  notification.onclick = () => {
    release();
    window.focus();
    notification.close();
    onOpen?.();
  };
}

/** @testonly */
export function resetOsNotificationsForTests(): void {
  clickTargets.clear();
  browserNotifications.clear();
  listeningTo = null;
}
