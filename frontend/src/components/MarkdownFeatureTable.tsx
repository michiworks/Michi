import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { ModalShell } from './ui/ModalShell';
import { copyText } from '../lib/clipboard';
import { downloadText } from '../lib/download';

function tableRows(table: HTMLTableElement): string[][] {
  return Array.from(table.rows).map((row) => (
    Array.from(row.cells).map((cell) => cell.textContent?.trim() ?? '')
  ));
}
function escapeMarkdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function tableAsMarkdown(table: HTMLTableElement): string {
  const rows = tableRows(table);
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from(
    { length: width },
    (_, index) => escapeMarkdownCell(row[index] ?? ''),
  ));
  const header = normalized[0];
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/**
 * After content stops mutating for this long (ms), switch from fixed
 * (stable during streaming) to auto (content-aware column widths).
 * A short delay avoids switching prematurely between rapid streaming batches.
 */
const SETTLE_DELAY_MS = 400;

/**
 * Whether the message around a table is still streaming. Only a live table
 * starts fixed and waits to settle; one whose message is complete (opened from
 * history, or finished) mounts settled, so its columns never move on open.
 */
export const MarkdownTableLiveContext = createContext(false);

/* ------------------------------------------------------------------ */
/*  TableLightbox — portal-based fullscreen table viewer              */
/* ------------------------------------------------------------------ */

interface TableLightboxProps {
  /** The original <table> element to clone into the lightbox. */
  sourceTable: HTMLTableElement;
  onClose: () => void;
  onCopy: () => void;
  onDownload: () => void;
}

function TableLightbox({ sourceTable, onClose, onCopy, onDownload }: TableLightboxProps) {
  // Escape is captured so TerminalShell's own Escape (clear selection / leave
  // the Digest page) does not also fire in the same keypress.
  return (
    <ModalShell
      open
      onClose={onClose}
      title="Table"
      titleGlyph="▦"
      aria-label="Table fullscreen"
      width={1200}
      maxHeight="84vh"
      captureEscape
      headerTrailing={
        <span className="michi-table-lightbox-controls">
          <button aria-label="Copy table" onClick={onCopy} type="button">copy</button>
          <button aria-label="Download table" onClick={onDownload} type="button">download</button>
        </span>
      }
    >
      <div className="michi-table-lightbox-scroll term-scrollbar">
        <table
          className="michi-table-settled"
          dangerouslySetInnerHTML={{ __html: sourceTable.innerHTML }}
        />
      </div>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/*  MarkdownFeatureTable — inline table with toolbar + settle logic    */
/* ------------------------------------------------------------------ */

export default function MarkdownFeatureTable({
  children,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const live = useContext(MarkdownTableLiveContext);

  // false = streaming phase (table-layout: fixed, stable columns)
  // true  = settled phase  (table-layout: auto, content-aware columns)
  const [settled, setSettled] = useState(() => !live);
  const settledRef = useRef(settled);

  /**
   * Observe the table's subtree for mutations. While content is changing
   * (streaming), the table stays `table-layout: fixed` so column widths
   * don't jump. Once content stops changing for SETTLE_DELAY_MS, or the
   * message stops streaming, flip to `table-layout: auto` so the browser
   * recalculates column widths based on all content — a one-time auto-fit.
   */
  useEffect(() => {
    const table = tableRef.current;
    if (!table || settledRef.current) return;
    if (!live) {
      settledRef.current = true;
      setSettled(true);
      return;
    }

    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      settledRef.current = true;
      setSettled(true);
      observer.disconnect();
    };

    const observer = new MutationObserver(() => {
      // Content changed — reset the settle timer.
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, SETTLE_DELAY_MS);
    });

    observer.observe(table, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // A live table may already be complete (its rows arrived before a pause
    // in the stream), so there may be no further mutations. Schedule a settle.
    settleTimer = setTimeout(settle, SETTLE_DELAY_MS);

    return () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      observer.disconnect();
    };
  }, [live]);

  // Phones lay a settled table out as cards: label each cell with its column.
  // Before paint, so a table that mounts settled never shows as columns first.
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!settled || !table) return;
    const head = table.tHead?.rows[0] ?? table.rows[0];
    if (!head?.querySelector('th')) return;
    const labels = Array.from(head.cells, (cell) => cell.textContent?.trim() ?? '');
    for (const row of Array.from(table.rows)) {
      if (row === head) {
        if (!table.tHead) row.setAttribute('data-cards-head', '');
        continue;
      }
      Array.from(row.cells).forEach((cell, index) => cell.setAttribute('data-label', labels[index] ?? ''));
    }
    table.setAttribute('data-cards', '');
  }, [settled]);

  const copy = () => {
    const table = tableRef.current;
    if (table) void copyText(tableAsMarkdown(table));
  };

  const download = () => {
    const table = tableRef.current;
    if (!table) return;
    downloadText('table.md', tableAsMarkdown(table), 'text/markdown;charset=utf-8');
  };

  return (
    <div className="michi-table-feature" data-michi-table-feature>
      <div className="michi-table-controls" data-michi-table-controls>
        <button aria-label="Copy table" onClick={copy} type="button">copy</button>
        <button aria-label="Download table" onClick={download} type="button">download</button>
        <button
          aria-label="View table fullscreen"
          onClick={() => setFullscreen(true)}
          type="button"
        >
          fullscreen
        </button>
      </div>
      <div className="michi-table-scroll">
        <table
          {...props}
          ref={tableRef}
          className={settled ? 'michi-table-settled' : undefined}
        >
          {children}
        </table>
      </div>

      <AnimatePresence>
        {fullscreen && tableRef.current && (
          <TableLightbox
            key="fullscreen"
            sourceTable={tableRef.current}
            onClose={() => setFullscreen(false)}
            onCopy={copy}
            onDownload={download}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
