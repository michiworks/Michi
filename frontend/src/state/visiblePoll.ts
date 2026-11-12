import { useEffect } from 'react';

export interface VisiblePollOptions {
  intervalMs: number;
  /** Also refresh when the window gains focus. */
  focus?: boolean;
}

/** A focus and a visibility change usually arrive together; refresh once for both. */
const CATCH_UP_MS = 1_000;

/**
 * Runs `refresh` every `intervalMs` while the document is visible, and once
 * when it becomes visible again (and on window focus, unless `focus` is
 * false). A hidden window makes no requests. Returns the stop function.
 */
export function startVisiblePoll(refresh: () => void, { intervalMs, focus = true }: VisiblePollOptions): () => void {
  let last: { type: string; at: number } | null = null;
  const catchUp = (event: Event) => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    const paired = last && last.type !== event.type && now - last.at < CATCH_UP_MS;
    last = paired ? null : { type: event.type, at: now };
    if (!paired) refresh();
  };
  const timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, intervalMs);
  document.addEventListener('visibilitychange', catchUp);
  if (focus) window.addEventListener('focus', catchUp);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', catchUp);
    if (focus) window.removeEventListener('focus', catchUp);
  };
}

/** {@link startVisiblePoll} for a component's lifetime, while `enabled`. */
export function useVisiblePoll(refresh: () => void, { intervalMs, enabled = true, focus = true }: VisiblePollOptions & { enabled?: boolean }): void {
  useEffect(() => (enabled ? startVisiblePoll(refresh, { intervalMs, focus }) : undefined), [enabled, focus, intervalMs, refresh]);
}
