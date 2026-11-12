import { createContext, useContext } from 'react';

/**
 * Gets the agent's panel out of the way of a page something in it opens (a
 * card's View, a page link): the panel provides it while it lies over the
 * page in a narrow window, where it closes the panel (F1a-review #6). Null
 * when the panel is docked beside the page, which stays in view.
 */
export const MetaChatRevealPageContext = createContext<(() => void) | null>(null);

export function useMetaChatRevealPage(): (() => void) | null {
  return useContext(MetaChatRevealPageContext);
}
