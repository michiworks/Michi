import { useSyncExternalStore } from 'react';

/** The phone layout's widest window, in CSS px (the CSS's `max-width: 700px`). */
const PHONE_MAX_WIDTH = 700;
/** A touch screen this short is a phone on its side, however wide. */
const PHONE_LANDSCAPE_MAX_HEIGHT = 500;

/**
 * Whether the window gets the phone layout: up to PHONE_MAX_WIDTH wide, or
 * a phone turned sideways (a coarse pointer, at most 500px tall). The CSS
 * says the same with `(max-width: 700px), (pointer: coarse) and (max-height: 500px)`.
 */
function isPhoneLayout(): boolean {
  if (window.innerWidth <= PHONE_MAX_WIDTH) return true;
  return window.innerHeight <= PHONE_LANDSCAPE_MAX_HEIGHT && (window.matchMedia?.('(pointer: coarse)')?.matches ?? false);
}

const subscribe = (notify: () => void) => {
  window.addEventListener('resize', notify);
  return () => window.removeEventListener('resize', notify);
};
export function usePhoneLayout() {
  return useSyncExternalStore(subscribe, isPhoneLayout, () => false);
}
