import type React from 'react';

/** The mouseup of a drag-select to copy text clicks too; it should not open what it landed on. */
export function endsTextSelectionIn(container: Node): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  return container.contains(selection.anchorNode) || container.contains(selection.focusNode);
}

const CARD_CONTROLS = 'button, a, input, textarea, select, [role="button"], [data-card-click="ignore"]';

/** A click on a card's background opens it, not one on its own controls or one that ends a text selection inside it. */
export function cardClickOpens(event: React.MouseEvent<HTMLElement>): boolean {
  if ((event.target as Element).closest(CARD_CONTROLS)) return false;
  return !endsTextSelectionIn(event.currentTarget);
}
