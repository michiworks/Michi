import { useContext, useSyncExternalStore } from 'react';
import { MotionConfigContext } from 'motion/react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(notify: () => void) {
  const mq = window.matchMedia?.(REDUCED_MOTION_QUERY);
  mq?.addEventListener('change', notify);
  return () => mq?.removeEventListener('change', notify);
}

function getSnapshot() {
  return window.matchMedia?.(REDUCED_MOTION_QUERY)?.matches ?? false;
}

function getServerSnapshot() {
  return false;
}

/**
 * Returns `true` when motion should be suppressed: the OS reports
 * `prefers-reduced-motion: reduce`, or Michi's own "Reduce motion" is on
 * (MotionRoot maps it to MotionConfig's 'always'). `appReduceMotion` adds a
 * caller's own reading of the pref, for use outside MotionRoot.
 */
export function useReducedMotion(appReduceMotion?: boolean): boolean {
  const os = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const app = useContext(MotionConfigContext).reducedMotion === 'always';
  return os || app || appReduceMotion === true;
}

/**
 * One-shot check for non-hook call sites (event handlers, layout effects):
 * the OS setting or Michi's "Reduce motion" (html[data-reduce-motion]).
 */
export function prefersReducedMotion(appReduceMotion?: boolean): boolean {
  return getSnapshot()
    || document.documentElement.dataset.reduceMotion === 'on'
    || appReduceMotion === true;
}

/**
 * A script's explicit `behavior: 'smooth'` overrides the CSS that stops smooth
 * scrolling under Reduce motion, so scripted scrolls ask here.
 */
export function smoothScrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
