import type { MatcherFunction } from '@testing-library/react';

/**
 * A command-palette row by its whole name. The palette marks the typed words
 * inside a name (CommandPalette's <mark>), so the name's text spans elements
 * and a plain text query no longer finds it. The workspace or kind at the
 * row's end, and a caption under the name, are not part of it.
 */
export function paletteRow(name: string | RegExp): MatcherFunction {
  return (_content, element) => {
    if (!element?.classList.contains('michi-menu-label')) return false;
    const own = Array.from(element.childNodes)
      .filter((child) => !(child instanceof HTMLElement && child.classList.contains('michi-menu-sublabel')))
      .map((child) => child.textContent ?? '')
      .join('');
    return typeof name === 'string' ? own === name : name.test(own);
  };
}
