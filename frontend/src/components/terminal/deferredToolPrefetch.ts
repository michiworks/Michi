import { useContext, useEffect, type RefObject } from 'react';
import { DeferredToolCallsContext } from '../../state/deferredToolCalls';

/** How long a turn stays on screen before its deferred calls are read. */
const DWELL_MS = 400;

/**
 * Reads a finished turn's deferred calls (state/deferredToolCalls.ts) once its
 * frame has been on screen a moment, so opening its "Worked for…" row or a
 * step finds them there. Frames holding such calls carry data-deferred-tools;
 * `signature` changes when that set does.
 */
export function useDeferredToolPrefetch(rootRef: RefObject<HTMLElement | null>, nodeId: string, signature: string): void {
  const loader = useContext(DeferredToolCallsContext);
  useEffect(() => {
    const root = rootRef.current;
    if (!loader || !root || !signature || typeof IntersectionObserver === 'undefined') return;
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const frame = entry.target as HTMLElement;
        if (!entry.isIntersecting) {
          clearTimeout(timers.get(frame));
          timers.delete(frame);
          continue;
        }
        if (timers.has(frame)) continue;
        timers.set(frame, setTimeout(() => {
          timers.delete(frame);
          observer.unobserve(frame);
          const messageId = frame.dataset.msgId;
          if (messageId) loader.load(nodeId, messageId);
        }, DWELL_MS));
      }
    });
    for (const frame of root.querySelectorAll('[data-deferred-tools]')) observer.observe(frame);
    return () => {
      observer.disconnect();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [loader, rootRef, nodeId, signature]);
}
