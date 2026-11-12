import { useCallback, useEffect } from 'react';
import { backTarget, hasBackLayer, modalOpen, subscribeBackLayers } from '../lib/backStack';
import { arrowTrack, panelTrack } from '../lib/backSwipeTracks';
import { useSwipeTrack, type SwipeStart, type SwipeTrack } from './useEdgeSwipe';

/**
 * The back swipe: right from the left screen edge, it steps back the top of
 * the back stack (lib/backStack.ts) with the finger. With nothing to go
 * back to, the swipe is `root`'s (the shell opens its drawer); a modal that
 * cannot be dismissed keeps it from both.
 */
export function useBackSwipe(enabled: boolean, root?: (start: SwipeStart) => SwipeTrack | null): void {
  const begin = useCallback((start: SwipeStart): SwipeTrack | null => {
    const target = backTarget();
    if (!target) return modalOpen() ? null : root?.(start) ?? null;
    if (target.kind === 'escape') return arrowTrack(target.back, start.y);
    const { swipe } = target.layer;
    if (swipe === false) return null;
    return swipe ? panelTrack(swipe, target.back) : arrowTrack(target.back, start.y);
  }, [root]);
  useSwipeTrack(enabled, 1, 'edge', begin);
}

const ENTRY_KEY = 'michiBack';

function isOurEntry(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[ENTRY_KEY] === true;
}

/**
 * The system Back (Android's gesture and button; a browser's back) steps the
 * back stack too. While there is somewhere to go back to, one history entry
 * of ours sits on top of the page's: Back pops it and the app steps back
 * instead of leaving. With nothing left, the entry goes and Back leaves the
 * app, as the system expects.
 */
export function useSystemBack(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    // A reload while ours was on top keeps it on top.
    let armed = isOurEntry(window.history.state);
    // Pops we started ourselves (dropping our entry) are not the user's Back.
    let ownPops = 0;
    const sync = () => {
      if (ownPops > 0) return; // our pop is on its way; sync again when it lands
      const want = hasBackLayer();
      if (want && !armed) {
        const state = window.history.state;
        window.history.pushState({ ...(typeof state === 'object' && state ? state : {}), [ENTRY_KEY]: true }, '');
        armed = true;
      } else if (!want && armed) {
        armed = false;
        ownPops += 1;
        window.history.back();
      }
    };
    const onPop = (event: PopStateEvent) => {
      const atOurs = isOurEntry(event.state);
      if (ownPops > 0) {
        ownPops -= 1;
        armed = atOurs;
        sync();
        return;
      }
      if (atOurs) {
        // Forward again, onto our entry.
        armed = true;
        sync();
        return;
      }
      armed = false;
      backTarget()?.back();
      // The layer closes in this task's render; arm again for what is left.
      window.setTimeout(sync, 0);
    };
    window.addEventListener('popstate', onPop);
    const unsubscribe = subscribeBackLayers(sync);
    sync();
    return () => {
      unsubscribe();
      window.removeEventListener('popstate', onPop);
      if (armed) window.history.back();
    };
  }, [enabled]);
}
