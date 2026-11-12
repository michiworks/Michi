import React, { useEffect } from 'react';
import type { CardLeafState } from './workflowCardModel';

/**
 * What the Background work drawer's cards share. Not in
 * BackgroundWorkDrawer.tsx, which imports the cards.
 */

/* A card takes the composer's corners, like the chat's workflow card:
   square on desktop, rounded on the phone (mobile.css). Boxes inside it
   follow the card, capped at 6px. */
export const WORK_CARD: React.CSSProperties = {
  border: '1px solid var(--term-line)',
  borderRadius: 'var(--term-composer-radius, 0px)',
  background: 'color-mix(in srgb, var(--term-alt) 28%, transparent)',
  overflow: 'hidden',
  minWidth: 0,
};
export const WORK_CARD_CLASS = 'background-workflow-card';
export const INNER_RADIUS = 'min(6px, var(--term-composer-radius, 0px))';

/** A fold of one row is no shorter than the row: one stays inline. */
const FOLD_MIN = 2;

/**
 * Finished items folded behind one line (or band): the ones `folded` names
 * that are no longer active, when there are at least FOLD_MIN. The fold
 * opens on a click, or by itself while it holds the expanded item (a
 * focused finished item, or one the user expanded before it finished), and
 * then stays open, so collapsing that row does not close it under the
 * user. Closing it collapses the row it hides.
 */
export function useFinishedFold<T extends { active: boolean }>({ items, keyOf, folded, foldKey, foldOpen, onSetFold, expandedKey, onToggle }: {
  items: readonly T[];
  keyOf: (item: T) => string;
  folded: ReadonlySet<string>;
  foldKey: string;
  foldOpen: boolean;
  onSetFold: (key: string, open: boolean) => void;
  expandedKey: string | null;
  onToggle: (key: string) => void;
}) {
  const keyed = items.map((item) => ({ item, key: keyOf(item) }));
  const tucked = keyed.filter(({ item, key }) => !item.active && folded.has(key));
  const folds = tucked.length >= FOLD_MIN;
  const inline = folds ? keyed.filter((entry) => !tucked.includes(entry)) : keyed;
  const holdsExpanded = folds && expandedKey !== null && tucked.some(({ key }) => key === expandedKey);
  useEffect(() => {
    if (holdsExpanded && !foldOpen) onSetFold(foldKey, true);
  }, [holdsExpanded, foldOpen, foldKey, onSetFold]);
  const open = foldOpen || holdsExpanded;
  const toggle = () => {
    if (!open) {
      onSetFold(foldKey, true);
      return;
    }
    if (holdsExpanded && expandedKey) onToggle(expandedKey);
    onSetFold(foldKey, false);
  };
  return { inline, tucked, folds, open, toggle };
}

export const GLYPH_BOX: React.CSSProperties = { width: 10, flexShrink: 0, display: 'inline-flex', justifyContent: 'center', alignItems: 'center', alignSelf: 'center', lineHeight: 1 };

/** A row's state mark. Running is a card's default: the chip carries the one running light, and the column stays empty. */
export function StateGlyph({ state }: { state: CardLeafState }) {
  if (state === 'failed') return <span aria-hidden style={{ ...GLYPH_BOX, color: 'var(--term-danger)', fontWeight: 600, fontSize: 'var(--fs-md)' }}>×</span>;
  if (state === 'completed') return <span aria-hidden style={{ ...GLYPH_BOX, color: 'var(--term-digest)', fontSize: 'var(--fs-xs)' }}>✓</span>;
  if (state === 'cancelled') return <span aria-hidden style={GLYPH_BOX}><span style={{ width: 6, height: 6, background: 'var(--term-faint)' }} /></span>;
  if (state === 'queued' || state === 'skipped') return <span aria-hidden style={GLYPH_BOX}><span style={{ width: 6, height: 6, boxSizing: 'border-box', borderRadius: '50%', border: '1px solid var(--term-faint)' }} /></span>;
  if (state === 'running') return <span aria-hidden style={GLYPH_BOX} />;
  return <span aria-hidden style={GLYPH_BOX}><span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--term-select)' }} /></span>;
}

/** Finished work is green, the Done chip's colour; running work is neutral, the chip carries the run colour. */
export const SEGMENT_COLOR: Record<CardLeafState, string> = {
  queued: 'var(--term-line)', skipped: 'var(--term-line)', running: 'color-mix(in srgb, var(--term-fg) 36%, transparent)', paused: 'var(--term-select)',
  waiting: 'var(--term-select)', completed: 'color-mix(in srgb, var(--term-digest) 82%, transparent)',
  failed: 'var(--term-danger)', cancelled: 'var(--term-faint)',
};

/**
 * One segment per item, up to 48; none draws a dashed strip. `fixed` keeps
 * each segment one width, so the strip's length is the group's size.
 */
export function SegmentStrip({ segments, fixed = false }: { segments: ReadonlyArray<{ key: string; state: CardLeafState; title?: string }>; fixed?: boolean }) {
  if (segments.length === 0) {
    return <div aria-hidden style={{ height: 4, borderRadius: 'var(--ui-radius-sm)', background: 'repeating-linear-gradient(90deg, var(--term-line) 0 5px, transparent 5px 9px)' }} />;
  }
  return (
    <div aria-hidden style={{ display: 'flex', gap: 3, height: 4, minWidth: 0 }}>
      {segments.slice(0, 48).map((segment) => (
        <span key={segment.key} title={segment.title} style={{ ...(fixed ? { flex: '0 1 12px', minWidth: 2 } : { flex: 1 }), borderRadius: 'var(--ui-radius-sm)', background: SEGMENT_COLOR[segment.state], transition: 'background-color var(--t-enter) ease-out' }} />
      ))}
    </div>
  );
}
