import { useEffect, type RefObject } from 'react';

/** Keep `<meta name="theme-color">` (browser chrome, the iOS status-bar band)
 *  and `--term-topbar-paint` (the phone's root background, mobile.css) equal to
 *  the top bar's own colour, so the band above the app reads as part of it.
 *  index.html seeds the meta from the saved palette for the first frame.
 *  Re-reads after paint whenever `deps` change (page, palette). */
export function useThemeColorSync(bar: RefObject<HTMLElement | null>, deps: readonly unknown[]) {
  useEffect(() => {
    const el = bar.current;
    if (!el || typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
    const frame = requestAnimationFrame(() => {
      const color = getComputedStyle(el).backgroundColor;
      if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
      document.documentElement.style.setProperty('--term-topbar-paint', color);
    });
    return () => cancelAnimationFrame(frame);
    // The caller lists what can change the bar's colour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
