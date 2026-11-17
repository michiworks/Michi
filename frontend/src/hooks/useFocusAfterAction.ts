import { useCallback, useLayoutEffect, useRef } from 'react';

type FindTarget = () => HTMLElement | null | undefined;

/**
 * Keeps focus on screen when the user's own action swaps the control they
 * pressed for another, or removes it (Pause → Resume, × → Undo, Start → the
 * running card). Arm it with a finder as the action starts; in the commit
 * where `busy` is false again, if focus fell to the page body, the finder's
 * element takes it. Only an armed action moves focus, never a stream or
 * poll update that swaps the same controls.
 */
export function useFocusAfterAction(busy: boolean): (find: FindTarget) => void {
  const armed = useRef<FindTarget | null>(null);
  useLayoutEffect(() => {
    if (busy || !armed.current) return;
    const find = armed.current;
    armed.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) find()?.focus({ preventScroll: true });
  }, [busy]);
  return useCallback((find: FindTarget) => { armed.current = find; }, []);
}

/** The button now at `index` in `row`, which replaced the one pressed there, else the row's last. */
export function buttonAt(row: Element | null | undefined, index: number): HTMLElement | undefined {
  const buttons = row ? Array.from(row.querySelectorAll<HTMLElement>('button')) : [];
  return buttons[index] ?? buttons.at(-1);
}

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The first control in `container`, else the container itself (a card with tabIndex −1). */
export function firstControlIn(container: HTMLElement | null | undefined): HTMLElement | null | undefined {
  return container?.querySelector<HTMLElement>(FOCUSABLE) ?? container;
}
