import { useEffect, useState } from 'react';

/**
 * `Date.now()` that moves on every `intervalMs` while `enabled`. It reads the
 * time afresh when it is enabled, so a clock paused for a while never shows
 * the old time for a tick, and runs no timer while disabled.
 */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}
