import { useEffect } from 'react';
import { toast } from 'sonner';
import { markCompanionOffNotice } from '../../services/api/companion';
import { getCompanionState, updateCompanionSnapshot, useCompanion } from './companionStore';

const TOAST_ID = 'companion-off-notice';
const NOTICE_MS = 12_000;
let taken = false;

/**
 * Once per owner (Q29 item 1): Michi has no button or ⌘J while it is off, so
 * the first time a window finds it off, after an upgrade or a new install,
 * a toast says so with the way to Settings › <name>. Finding it on records
 * the notice too, so turning it off later says nothing. The backend keeps
 * the record (snapshot `offNoticeAt`), for every window and after restarts;
 * an older backend without one shows nothing. Waits until `ready` (setup is
 * done) and never moves focus.
 */
export function useCompanionOffNotice(ready: boolean, name: string, openSettings: () => void): void {
  const { availability, snapshot } = useCompanion();
  const due = ready && !taken && availability === 'available' && snapshot?.offNoticeAt === null;
  useEffect(() => {
    if (!due) return;
    taken = true;
    const off = getCompanionState().snapshot?.settings.paused === true;
    updateCompanionSnapshot((current) => ({ ...current, offNoticeAt: Date.now() }));
    void markCompanionOffNotice().catch(() => { taken = false; });
    if (off) toast(`${name} is off · Turn it on in Settings`, { id: TOAST_ID, duration: NOTICE_MS, action: { label: 'Open Settings', onClick: openSettings } });
  }, [due, name, openSettings]);
}

/**
 * Let the next window take the notice again.
 * @testonly
 */
export function resetCompanionOffNoticeForTests(): void {
  taken = false;
}
