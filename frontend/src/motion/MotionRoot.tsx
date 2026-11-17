import React from 'react';
import { MotionConfig } from 'motion/react';
import { PREFS_KEY, usePrefs } from '../state/prefs';
import { TRANSITION } from './tokens';

/**
 * App-wide motion settings. `reducedMotion="user"` only reads the OS setting,
 * so the in-app Reduce motion preference maps to "always". Either way motion
 * keeps opacity and colour animations and drops transforms and layout moves.
 */
export function MotionRoot({ children }: { children: React.ReactNode }) {
  const { prefs } = usePrefs();
  return (
    <MotionConfig reducedMotion={prefs.reduceMotion ? 'always' : 'user'} transition={TRANSITION.enter}>
      {children}
    </MotionConfig>
  );
}

/** Reduce motion as this device stored it (a local pref), off when unreadable. */
function storedReduceMotion(): boolean {
  try {
    return JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? 'null')?.reduceMotion === true;
  } catch {
    return false;
  }
}

/**
 * MotionRoot for a root that renders without PrefsProvider (the page preview,
 * the dev specimens), which must not fetch or save prefs: the stored Reduce
 * motion pref, read once, picks the MotionConfig and writes
 * html[data-reduce-motion] as PrefsProvider does, so both triggers reach it.
 */
export function StandaloneMotionRoot({ children }: { children: React.ReactNode }) {
  const [reduce] = React.useState(storedReduceMotion);
  React.useLayoutEffect(() => {
    document.documentElement.dataset.reduceMotion = reduce ? 'on' : 'off';
  }, [reduce]);
  return (
    <MotionConfig reducedMotion={reduce ? 'always' : 'user'} transition={TRANSITION.enter}>
      {children}
    </MotionConfig>
  );
}
