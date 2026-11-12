import React, { useRef } from 'react';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { usePanelWidth } from '../../state/prefs';
import ResizeHandle from '../ResizeHandle';

/** Narrowest the list column gets. */
const SIDE_MIN = 220;
/** What the column always leaves the main view beside it. */
const MAIN_MIN = 240;
/** The column before anyone drags it: 31% of the pane, at least SIDE_MIN. */
const DEFAULT_COLUMNS = `minmax(0, 1fr) minmax(${SIDE_MIN}px, 31%)`;

/**
 * A pane's list column on its right (the Files tree, the Review changes):
 * the grid's columns, a ref for the column, and the handle on its left edge
 * that drags its width. The width is saved under `key` for every pane of the
 * kind; double-click goes back to the default. A phone gets no handle.
 */
export function useSideColumn(key: string): {
  columns: string;
  columnRef: React.RefObject<HTMLElement | null>;
  handle: React.ReactNode;
} {
  const columnRef = useRef<HTMLElement>(null);
  const saved = usePanelWidth(key);
  const phone = usePhoneLayout();
  const width = saved?.width;
  const columns = width === undefined
    ? DEFAULT_COLUMNS
    : `minmax(0, 1fr) minmax(${SIDE_MIN}px, min(${width}px, calc(100% - ${MAIN_MIN}px)))`;
  const handle = saved && !phone ? (
    <ResizeHandle
      paneRef={columnRef}
      side="left"
      min={SIDE_MIN}
      onResize={(w) => {
        const total = columnRef.current?.parentElement?.clientWidth;
        saved.set(total ? Math.max(SIDE_MIN, Math.min(w, total - MAIN_MIN)) : w);
      }}
      onReset={saved.reset}
    />
  ) : null;
  return { columns, columnRef, handle };
}
