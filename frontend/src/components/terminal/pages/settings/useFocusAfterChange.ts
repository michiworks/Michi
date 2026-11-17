import { useLayoutEffect, useRef } from 'react';

/**
 * Settings' editors and forms open and close in place, so the control the
 * user pressed often leaves the page: Cancel, Save or Escape closes a form,
 * the button that opened one gives way to it. After `mode` changes, when that
 * left keyboard focus on the page body, this focuses `target(mode, previous)`,
 * the control that now stands where the pressed one was, or else the page's
 * heading. Focus the user moved elsewhere meanwhile stays where it is, and
 * the first render moves nothing.
 */
export function useFocusAfterChange<T>(mode: T, target: (mode: T, previous: T) => HTMLElement | null | undefined): void {
  const previous = useRef(mode);
  const latest = useRef(target);
  useLayoutEffect(() => { latest.current = target; });
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = mode;
    if (Object.is(before, mode)) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const next = latest.current(mode, before);
    (next?.isConnected ? next : settingsHeading())?.focus({ preventScroll: true });
  }, [mode]);
}

/** The heading of the Settings page on screen; it takes focus without being a control (tabIndex -1). */
function settingsHeading(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.terminal-settings-content h1.terminal-settings-heading[tabindex="-1"]');
}
