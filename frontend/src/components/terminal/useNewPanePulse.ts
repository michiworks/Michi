import { useEffect, useState } from 'react';

/** Outlasts the rail's two var(--t-slow) pulses (1.2s, RailAfterglow). */
const PULSE_HOLD_MS = 1400;

/**
 * Listens for `michi:new-background-panes` events and returns true when the
 * given nodeId was just opened as a background pane. The flag auto-clears after
 * PULSE_HOLD_MS, once the sidebar bar pulse has played.
 * This drives the Layer 1b sidebar bar pulse-once indicator.
 */
export function useNewPanePulse(nodeId: string): boolean {
  const [isNew, setIsNew] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeIds: string[] }>).detail;
      if (detail.nodeIds.includes(nodeId)) {
        setIsNew(true);
      }
    };
    window.addEventListener('michi:new-background-panes', handler);
    return () => window.removeEventListener('michi:new-background-panes', handler);
  }, [nodeId]);

  useEffect(() => {
    if (!isNew) return;
    const timer = window.setTimeout(() => setIsNew(false), PULSE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [isNew]);

  return isNew;
}
