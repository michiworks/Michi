import { useEffect, useState, type RefObject } from 'react';

/**
 * Whether `ref`'s element has been on screen since `watch` turned on; once
 * true it stays true. Without IntersectionObserver every element counts as
 * seen.
 */
export function useSeenOnScreen(ref: RefObject<Element | null>, watch: boolean): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!watch || seen) return;
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, watch, seen]);
  return seen;
}
