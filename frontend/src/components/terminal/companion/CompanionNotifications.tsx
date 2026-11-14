import { useEffect, useRef } from 'react';
import type { CompanionTarget } from 'michi-shared';
import { getElectron } from '../../../lib/electronBridge';
import { onOpenCompanionTargetRequest } from '../../../state/attentionOpenRequests';
import { startCompanionFeed } from '../../../state/companion/companionFeed';
import { startCompanionPresence } from '../../../state/companion/companionPresence';
import { useCompanionName } from '../../../state/companion/companionName';
import { useCompanionOffNotice } from '../../../state/companion/companionOffNotice';
import { openCompanionSettingsSwitch, useOpenCompanionTarget } from './companionTargets';

/** The parameter of a window a banner's click opened (electron/attentionNotifications.ts COMPANION_TARGET_PARAM). */
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

/**
 * The Companion's feed and beacons once the workspaces have loaded (the shell
 * mounts it like MemoryNotifications), and where a click on one of Michi's
 * notifications lands. Michi's notices are attention records: this window
 * presents them like any other (chatStore through services/serverAttention.ts,
 * whose clicks ask here, attentionOpenRequests.ts), and Electron main shows
 * them while no window is open (a click on its banner arrives as
 * `onCompanionOpen`, or as the target of the window it opened). Notices never
 * move focus or switch what is on screen until the user clicks one, and every
 * click opens the record's target: the same notice lands in the same place
 * whether or not Michi had focus. Renders nothing.
 */
export function CompanionNotifications({ noticeReady = false }: { noticeReady?: boolean }) {
  const openTarget = useOpenCompanionTarget();
  // Off, Michi has no button: once, a toast says where to turn it on (Q29).
  useCompanionOffNotice(noticeReady, useCompanionName(), openCompanionSettingsSwitch);
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

  // Electron: a banner's click, and the window a click opened.
  useEffect(() => {
    const electron = getElectron();
    const initial: CompanionTarget | null = electron?.initialCompanionTarget ?? null;
    if (initial && !initialTargetTaken) {
      initialTargetTaken = true;
      clearCompanionTargetParam();
      void openRef.current(initial);
    }
    const detachOpen = electron?.onCompanionOpen?.((target: CompanionTarget) => { void openRef.current(target); });
    return () => { detachOpen?.(); };
  }, []);

  // A click on a toast or an OS notification this window raised for one of Michi's records.
  useEffect(() => onOpenCompanionTargetRequest((target) => { void openRef.current(target); }), []);

  return null;
}

/**
 * Forget that this page's launch target was taken.
 * @testonly
 */
export function resetCompanionNotificationsForTests(): void {
  initialTargetTaken = false;
}
