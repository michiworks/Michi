import type React from 'react';

export interface RowKeyActions {
  /** What a click on the row does. */
  activate: () => void;
  /** Rows that fold (a workspace, a thread or branch with branches): its state and toggle. */
  expanded?: boolean;
  toggle?: () => void;
  /** Opens the row's menu (its ⋯ / right-click menu) at this point. */
  openMenu?: (anchor: { x: number; y: number }) => void;
  /** Rows the user orders by dragging: one place up (-1) or down (1). */
  move?: (direction: -1 | 1) => void;
}

/**
 * Keys for a sidebar row that is a button to the keyboard (role="button",
 * tabIndex 0): Enter or Space does what a click does, → opens and ← closes a
 * row that folds, Shift+F10 or the menu key opens its menu, and ⌥↑ / ⌥↓ move
 * a row that a drag moves. Keys pressed inside the row (its ⋯ button, a
 * rename field) belong to that element, and other shortcuts with ⌘, Ctrl or
 * ⌥ pass through.
 */
export function rowKeyDown(event: React.KeyboardEvent<HTMLElement>, actions: RowKeyActions): void {
  if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey) return;
  const { key } = event;
  if (event.altKey) {
    if (actions.move && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault();
      actions.move(key === 'ArrowUp' ? -1 : 1);
    }
    return;
  }
  if (key === 'Enter' || key === ' ') {
    event.preventDefault();
    actions.activate();
  } else if (actions.toggle && ((key === 'ArrowRight' && actions.expanded === false) || (key === 'ArrowLeft' && actions.expanded === true))) {
    event.preventDefault();
    actions.toggle();
  } else if (actions.openMenu && (key === 'ContextMenu' || (key === 'F10' && event.shiftKey))) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    actions.openMenu({ x: rect.left + 12, y: rect.bottom + 2 });
  }
}
