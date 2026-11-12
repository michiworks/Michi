import { useEffect, useRef } from 'react';
import { isImeComposing } from '../../lib/ime';

/**
 * Esc closes an open menu, and only the menu. The listener runs in the
 * window's capture phase and stops the key there, so the modal, drawer or
 * page the menu opened over never sees it: their listeners (window, bubble
 * phase) were registered first and would otherwise close first, leaving the
 * menu an Esc whose default is already prevented. An Esc that ends an IME
 * composition is the composition's.
 */
export function useMenuEscape(active: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeComposing(event)) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);
}
