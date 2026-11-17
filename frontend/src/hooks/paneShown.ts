import { createContext, useContext } from 'react';

/**
 * Whether a pane can be seen, kept outside React state so that hiding or
 * freezing a pane renders nothing (motion.md MO-17, MO-25):
 *
 * - `hidden`: a pane hidden in place under `visibility: hidden` (a phone pane
 *   that is not the visible one, a pane hidden by zoom). It still renders per
 *   chunk, and its typewriter snaps to its source like a backgrounded window.
 * - `frozen`: a desktop pane scrolled off the strip, as Dashboard's
 *   IntersectionObserver writes it. Its node subscriptions (useChatNode) keep
 *   its last node and render nothing, and its typewriter stops; once it is
 *   back it catches up in one render and shows its text at the source.
 *
 * Dashboard creates one store per pane wrapper and provides it through
 * PaneShownContext; the object never changes, so the context never renders
 * anything. Listeners (useSmooth, useChatNode) read it when it notifies.
 */
export interface PaneShownStore {
  readonly hidden: boolean;
  readonly frozen: boolean;
  setHidden: (hidden: boolean) => void;
  setFrozen: (frozen: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPaneShownStore(): PaneShownStore {
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const store = {
    hidden: false,
    frozen: false,
    setHidden(hidden: boolean) {
      if (store.hidden === hidden) return;
      store.hidden = hidden;
      notify();
    },
    setFrozen(frozen: boolean) {
      if (store.frozen === frozen) return;
      store.frozen = frozen;
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return store;
}

/** The store of the Dashboard pane a component renders in; null outside one (sidebar rows, the Companion panel). */
export const PaneShownContext = createContext<PaneShownStore | null>(null);

/** The store of the pane this component renders in; null outside a Dashboard pane. */
export function usePaneShown(): PaneShownStore | null {
  return useContext(PaneShownContext);
}
