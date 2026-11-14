import { useEffect, useState } from 'react';

/**
 * The bottom of the layout viewport that the visual viewport leaves uncovered.
 * Positional readers use it as is, zoomed or not: under a pinch zoom it puts
 * a bottom-fixed element at the visible bottom edge. It is not a keyboard
 * reading: once iOS pans the page to the field, it shrinks while the keyboard
 * stays up.
 */
export function keyboardInsetOf(viewport: VisualViewport): number {
  return Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
}

/**
 * How much shorter than the layout viewport an on-screen keyboard leaves the
 * visual viewport, wherever that is panned. iOS pans it to reveal the field,
 * on focus and again when typing moves the caret into view; neither lowers
 * the keyboard. Yes/no keyboard readers (onScreenKeyboardUp,
 * useKeyboardDismiss) use this and also check the scale.
 */
export function keyboardHeightOf(viewport: VisualViewport): number {
  return Math.max(0, Math.round(window.innerHeight - viewport.height));
}

/** Above this height the on-screen keyboard is up. */
export const KEYBOARD_UP_PX = 120;

/** Whether an on-screen keyboard is up now. Pinch zoom shrinks the visual viewport too; that is not a keyboard. */
export function onScreenKeyboardUp(): boolean {
  const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
  return !!viewport && Math.abs(viewport.scale - 1) <= 0.01 && keyboardHeightOf(viewport) >= KEYBOARD_UP_PX;
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
