import { useLayoutEffect, useRef, useState } from 'react';
import { DUR } from '../../../motion/tokens';

/** The arrival (home-arrive over --t-decay, home.css) has played out well within --t-slow. */
const ARRIVAL_MS = DUR.slow * 1000;

/**
 * True for a moment after the skeleton of the page named `key`, watched on
 * screen, gives way to its content, which then arrives as Home's does
 * (TR-30). A page read before, or another page opened meanwhile, renders
 * settled.
 */
export function usePageArrival(pending: boolean, key: string): boolean {
  const [arriving, setArriving] = useState(false);
  const was = useRef({ pending, key });
  useLayoutEffect(() => {
    const arrived = was.current.pending && !pending && was.current.key === key;
    was.current = { pending, key };
    if (!arrived) return;
    setArriving(true);
    const timer = window.setTimeout(() => setArriving(false), ARRIVAL_MS);
    return () => {
      window.clearTimeout(timer);
      setArriving(false);
    };
  }, [pending, key]);
  return arriving;
}
