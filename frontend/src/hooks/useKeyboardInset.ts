import { useEffect, useState } from 'react';

/**
 * The bottom of the layout viewport that the visual viewport leaves uncovered.
 * Positional readers use it as is, zoomed or not: under a pinch zoom it puts
 * a bottom-fixed element at the visible bottom edge. Only yes/no keyboard
 * readers (onScreenKeyboardUp, useKeyboardDismiss) also check the scale.
 */
export function keyboardInsetOf(viewport: VisualViewport): number {
  return Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
}

/** Above this inset the on-screen keyboard is up. */
export const KEYBOARD_UP_PX = 120;

/** Whether an on-screen keyboard covers the page's bottom now. Pinch zoom shrinks the visual viewport too; that is not a keyboard. */
export function onScreenKeyboardUp(): boolean {
  const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
  return !!viewport && Math.abs(viewport.scale - 1) <= 0.01 && keyboardInsetOf(viewport) >= KEYBOARD_UP_PX;
}

/**
 * How much of the layout viewport's bottom an on-screen keyboard covers, in
 * CSS px. Mobile Safari does not resize the layout viewport for the keyboard,
 * so a bottom-fixed element needs this offset to stay above it. 0 when inactive
 * or when visualViewport is unavailable.
 */
export function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !viewport) {
      setInset(0);
      return;
    }
    const measure = () => setInset(keyboardInsetOf(viewport));
    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
    };
  }, [active]);
  return inset;
}
