import { useSyncExternalStore } from 'react';

/**
 * The width of a pane while its edge is being dragged. The dashboard strip and
 * the topbar caption strip lay out from it; the pane store receives the width
 * once, on release. Saving every frame to the store re-rendered the shell, the
 * sidebar rows and every open pane on each frame of the drag.
 */
export type PaneDragWidth = { id: string; width: number } | null;

let current: PaneDragWidth = null;
const listeners = new Set<() => void>();

export function setPaneDragWidth(next: PaneDragWidth): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const read = () => current;

export function usePaneDragWidth(): PaneDragWidth {
  return useSyncExternalStore(subscribe, read, read);
}

/** Saved widths with the dragged pane's live width in its place. */
export function withPaneDragWidth<T extends number | undefined>(
  widths: readonly T[],
  ids: readonly string[],
  drag: PaneDragWidth,
): readonly (T | number)[] {
  if (!drag) return widths;
  const index = ids.indexOf(drag.id);
  if (index < 0) return widths;
  const next: (T | number)[] = [...widths];
  next[index] = drag.width;
  return next;
}
