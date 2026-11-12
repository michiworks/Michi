import type React from 'react';

/**
 * The key belongs to an input method: it picks or dismisses a candidate
 * (Enter, Esc) while Chinese or Japanese text is still being composed.
 * Chromium flags it `isComposing`; Safari sends the key that ends the
 * composition after compositionend, unflagged, as keyCode 229. Android
 * soft keyboards send 229 too while a word is underlined, so an Enter there
 * can take a second press.
 */
export function isImeComposing(event: KeyboardEvent | React.KeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}
