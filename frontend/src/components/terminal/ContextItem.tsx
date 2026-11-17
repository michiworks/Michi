import { useLayoutEffect, useState, type RefObject } from 'react';
import type { AnyQuoteSource } from '../../lib/quoteFormat';

/**
 * Shared pieces of the comment and quote rows (.t-ctx in index.css): the
 * passages a person pointed at, in the composer before a send and in the
 * sent user message after it. A row is a gutter mark (a comment's speech
 * bubble, a quote's reply arrow), the passage as a tinted excerpt, the
 * person's own note under it for a comment, and one quiet action at the end.
 */

/** The text on one line, as a collapsed row shows it. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The file a passage came from, for the row's meta: its name, and with
 * `version` the read version the comment is pinned to.
 */
export function sourceMeta(source: AnyQuoteSource | undefined, version: boolean): string | null {
  if (source?.type !== 'artifact') return null;
  const name = source.name || source.filePath;
  if (!version) return name;
  return `${name} · ${source.snapshot?.contentHash.slice(0, 8) || 'version unknown'}`;
}

function clipped(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

/**
 * Whether a collapsed row cuts any of its text, so it offers to expand only
 * when expanding shows more. While expanded it keeps the last answer: the
 * open row's text no longer clips, and its toggle must stay to fold it back.
 */
export function useClipped(
  expanded: boolean,
  contentKey: string,
  first: RefObject<HTMLElement | null>,
  second?: RefObject<HTMLElement | null>,
): boolean {
  const [isClipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    if (expanded) return;
    const els = [first.current, second?.current].filter((el): el is HTMLElement => !!el);
    const measure = () => setClipped(els.some(clipped));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    for (const el of els) observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, contentKey, first, second]);
  return isClipped;
}

const glyph = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** A comment's mark: the speech bubble on the selection toolbar's Comment button. */
export function CommentGlyph() {
  return (
    <svg {...glyph}>
      <path d="M3.5 3h9A1.5 1.5 0 0 1 14 4.5v5.5a1.5 1.5 0 0 1-1.5 1.5H7.5L4.5 14v-2.5h-1A1.5 1.5 0 0 1 2 10V4.5A1.5 1.5 0 0 1 3.5 3z" />
    </svg>
  );
}

/** A quote's mark: the reply arrow, curving from the passage into the message. */
export function ReplyGlyph() {
  return (
    <svg {...glyph}>
      <path d="M3.5 3v4a3 3 0 0 0 3 3H13" />
      <path d="M10 7l3 3-3 3" />
    </svg>
  );
}

/** Attached context's mark: what was on screen, stacked. */
export function ContextGlyph() {
  return (
    <svg {...glyph}>
      <path d="M8 2.5l5.5 3L8 8.5l-5.5-3z" />
      <path d="M2.5 9L8 12l5.5-3" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg {...glyph} width={12} height={12}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg {...glyph} width={12} height={12}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/** The composer row's remove action; its row's hover brings it out. */
export function CtxRemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} className="t-ctx-btn t-reveal" onClick={onClick}>
      <CloseGlyph />
    </button>
  );
}

/** A sent row's expand action; its chevron turns over while open. */
export function CtxExpandButton({ label, expanded, controls, onToggle }: {
  label: string;
  expanded: boolean;
  /** Ids of the text the toggle unfolds (A-049: a disclosure says what it opens). */
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      className="t-ctx-btn t-ctx-toggle"
      onClick={onToggle}
    >
      <ChevronGlyph />
    </button>
  );
}
