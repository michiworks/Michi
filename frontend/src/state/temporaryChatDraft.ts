import { useSyncExternalStore } from 'react';

/**
 * Home's temporary-chat switch (the topbar's ghost, the palette's "New
 * temporary chat"): whether the chat Home is about to start is temporary
 * (ChatNodeState.temporary). It is a choice for that one chat, made before
 * its first message, so it lives in memory only: a Home send turns it off,
 * and so does leaving Home (the topbar), so it never carries into a later
 * chat by accident.
 */
let on = false;
const listeners = new Set<() => void>();

export function setTemporaryChatDraft(next: boolean): void {
  if (on === next) return;
  on = next;
  for (const listener of [...listeners]) listener();
}

export function resetTemporaryChatDraft(): void { setTemporaryChatDraft(false); }

export function useTemporaryChatDraft(): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => on,
    () => on,
  );
}
