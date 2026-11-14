import { useEffect, useRef } from 'react';
import { KEYBOARD_UP_PX, keyboardHeightOf } from './useKeyboardInset';

/** Below this height it has gone down again (the gap avoids flicker mid-animation). */
const KEYBOARD_DOWN_PX = 60;
/** After a file picker closes, the keyboard's moves still belong to it for this long. */
const PICKER_SETTLE_MS = 800;

let releasePicker: ((graceMs: number) => void) | null = null;
let pickerHeldUntil = 0;

function filePickerHoldsKeyboard(): boolean {
  return releasePicker !== null || performance.now() < pickerHeldUntil;
}

/**
 * Opens a file input's native picker. On a phone the picker takes the
 * keyboard down while it covers the page, and the browser raises it again
 * for the same field when the picker closes. Until then a keyboard going
 * down is not the user dismissing it, so useKeyboardDismiss leaves the field
 * focused and the composer open. Choosing, cancelling or touching the page
 * again ends that.
 */
export function openFilePicker(input: HTMLInputElement): void {
  releasePicker?.(0);
  const onClose = () => release(PICKER_SETTLE_MS);
  // A browser without `cancel` on file inputs: a touch on the page means the picker is gone.
  const onTouch = () => release(0);
  const release = (graceMs: number) => {
    if (releasePicker !== release) return;
    releasePicker = null;
    pickerHeldUntil = performance.now() + graceMs;
    input.removeEventListener('change', onClose);
    input.removeEventListener('cancel', onClose);
    window.removeEventListener('focus', onClose);
    document.removeEventListener('pointerdown', onTouch, true);
  };
  releasePicker = release;
  pickerHeldUntil = 0;
  input.addEventListener('change', onClose);
  input.addEventListener('cancel', onClose);
  window.addEventListener('focus', onClose);
  document.addEventListener('pointerdown', onTouch, true);
  input.click();
}

/**
 * Calls onDismiss when the on-screen keyboard goes down after it came up for
 * one of the caller's fields: Done, a swipe, Android's back key or a tap
 * elsewhere all end the same way. `owns` says whether that field has focus
 * now; a keyboard raised for another input does not count.
 */
export function useKeyboardDismiss(active: boolean, owns: () => boolean, onDismiss: () => void): void {
  const ownsRef = useRef(owns);
  ownsRef.current = owns;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !viewport) return;
    let up = false;
    let width = window.innerWidth;
    const measure = () => {
      // Rotation and pinch zoom resize the visual viewport too; neither is the keyboard.
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        up = false;
        return;
      }
      if (Math.abs(viewport.scale - 1) > 0.01) return;
      const height = keyboardHeightOf(viewport);
      if (height >= KEYBOARD_UP_PX) {
        if (!up && ownsRef.current()) up = true;
      } else if (up && height <= KEYBOARD_DOWN_PX) {
        up = false;
        if (!filePickerHoldsKeyboard()) onDismissRef.current();
      }
    };
    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
    };
  }, [active]);
}
