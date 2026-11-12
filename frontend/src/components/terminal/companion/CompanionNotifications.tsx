import { useEffect, useRef } from 'react';
import type { CompanionNotice, CompanionTarget } from 'michi-shared';
import { getElectron } from '../../../lib/electronBridge';
import { notify } from '../../../services/notifications';
import { startCompanionFeed, subscribeCompanionNotices } from '../../../state/companion/companionFeed';
import { startCompanionPresence } from '../../../state/companion/companionPresence';
import { getCompanionPanelState } from '../../../state/companion/companionPanel';
import { useOpenCompanionTarget } from './companionTargets';

const SHOWN_LIMIT = 500;

/** The parameter of a window a banner's click opened (electron/companionNotifications.ts COMPANION_TARGET_PARAM). */
const COMPANION_TARGET_PARAM = 'michiCompanionTarget';

/**
 * The window's launch target was taken: once per page load, whatever
 * remounts (StrictMode's second effect, an error boundary's retry). A reload
 * starts over, and finds the parameter gone.
 */
let initialTargetTaken = false;

/** Drop the one-shot launch target from the URL, so a reload does not open it again. */
function clearCompanionTargetParam(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(COMPANION_TARGET_PARAM)) return;
    // Only this one: the preload reads the window's other parameters again on a reload.
    url.searchParams.delete(COMPANION_TARGET_PARAM);
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // Non-fatal: the worst case is opening the same target again after a reload.
  }
}

/** Remembers the notices shown, so each shows once. */
function shownOnce(): (notice: CompanionNotice) => boolean {
  const shown = new Set<string>();
  return (notice) => {
    if (shown.has(notice.id) || notice.expiresAt <= Date.now()) return false;
    shown.add(notice.id);
    if (shown.size > SHOWN_LIMIT) shown.delete(shown.values().next().value as string);
    return true;
  };
}

/**
 * The Companion's feed, beacons and notices, once the workspaces have loaded
 * (the shell mounts it like MemoryNotifications). Every notice is one the
 * backend's single notice gate let through (R2.7): in the desktop app
 * Electron main shows them (a toast while the window has focus arrives here
 * as `onCompanionNotice`; a click on a banner as `onCompanionOpen`); in a
 * browser they come over the change feed and this window toasts each once.
 * The desktop app's windows never toast the feed's notices: main already
 * showed each, as a toast or a banner. Nothing here derives a notice from
 * the snapshot. Notices never move focus or switch what is on screen until
 * the user clicks one, and every click (toast, banner, the window a banner
 * opened) opens the notice's target: the same notice lands in the same
 * place whether or not Michi had focus. Renders nothing.
 */
export function CompanionNotifications() {
  const openTarget = useOpenCompanionTarget();
  const openRef = useRef(openTarget);
  openRef.current = openTarget;

  useEffect(() => {
    const stopFeed = startCompanionFeed();
    const stopPresence = startCompanionPresence();
    return () => {
      stopFeed();
      stopPresence();
    };
  }, []);

  // Electron: a banner's click, the window a click opened, and toasts for notices while focused.
  useEffect(() => {
    const electron = getElectron();
    const initial: CompanionTarget | null = electron?.initialCompanionTarget ?? null;
    if (initial && !initialTargetTaken) {
      initialTargetTaken = true;
      clearCompanionTargetParam();
      void openRef.current(initial);
    }
    const firstTime = shownOnce();
    const detachOpen = electron?.onCompanionOpen?.((target: CompanionTarget) => { void openRef.current(target); });
    const detachNotice = electron?.onCompanionNotice?.((notice: CompanionNotice) => {
      if (!firstTime(notice)) return;
      notify({ title: notice.title, body: notice.body, onClick: () => { void openRef.current(notice.target); } });
    });
    return () => {
      detachOpen?.();
      detachNotice?.();
    };
  }, []);

  // A browser: no main process, so this window shows the gate's notices the feed brings.
  // In the desktop app main shows each of them already (Electron toasts arrive above).
  useEffect(() => {
    if (getElectron()?.onCompanionNotice) return undefined;
    const firstTime = shownOnce();
    return subscribeCompanionNotices((notice) => {
      if (!firstTime(notice)) return;
      // Already in front of the user: the panel shows that tab and the window has focus.
      const panel = getCompanionPanelState();
      if (notice.target.kind === 'companion' && panel.open && panel.tab === notice.target.tab && document.hasFocus()) return;
      notify({ title: notice.title, body: notice.body, onClick: () => { void openRef.current(notice.target); } });
    });
  }, []);

  return null;
}

/**
 * Forget that this page's launch target was taken.
 * @testonly
 */
export function resetCompanionNotificationsForTests(): void {
  initialTargetTaken = false;
}
