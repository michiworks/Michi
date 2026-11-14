import type { CompanionTarget, ScheduledRunTarget } from 'michi-shared';

/**
 * A click on a notification of Michi's own (an `agent` attention record) or
 * of a Scheduled Job run opens where its record says. The policy's toast and
 * the window's OS notification are raised from chatStore, which cannot reach
 * the openers the shell mounts (components may not be imported from state):
 * it asks here, and the opener that is mounted (CompanionNotifications,
 * useScheduledRunOpening) answers, as it answers Electron main's clicks.
 */
const OPEN_COMPANION_TARGET_EVENT = 'michi:open-companion-target';
const OPEN_SCHEDULED_RUN_EVENT = 'michi:open-scheduled-run';

function listen<T>(name: string, handler: (detail: T) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<T>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}

/** Open a conversation, Michi's panel or Settings, as a Today row would. */
export function requestOpenCompanionTarget(target: CompanionTarget): void {
  window.dispatchEvent(new CustomEvent<CompanionTarget>(OPEN_COMPANION_TARGET_EVENT, { detail: target }));
}

export function onOpenCompanionTargetRequest(handler: (target: CompanionTarget) => void): () => void {
  return listen(OPEN_COMPANION_TARGET_EVENT, handler);
}

/** Open a Scheduled Job's run, wherever its thread shows (ids of the local backend). */
export function requestOpenScheduledRun(target: ScheduledRunTarget): void {
  window.dispatchEvent(new CustomEvent<ScheduledRunTarget>(OPEN_SCHEDULED_RUN_EVENT, { detail: target }));
}

export function onOpenScheduledRunRequest(handler: (target: ScheduledRunTarget) => void): () => void {
  return listen(OPEN_SCHEDULED_RUN_EVENT, handler);
}
