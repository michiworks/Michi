import { useEffect, useRef, useState, type RefObject } from 'react';
import { smoothScrollBehavior } from '../../hooks/useReducedMotion';
import { isImeComposing } from '../../lib/ime';
import { flashMatchOverlay, usePaneFindMatches } from './paneFindMatches';

export interface PaneFindProps {
  open: boolean;
  /** The pane's transcript (TPane's scroll container); find searches its messages only. */
  rootRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /**
   * Brings a visited match into view and flashes it; returns what lets it
   * go when the next one is visited. The chat pane passes its jumpToMessage,
   * which holds the match while a streaming reply grows below it. Without
   * it, the match is scrolled to once.
   */
  onVisitMatch?: (range: Range) => () => void;
  /**
   * Bumped by the parent on every ⌘F press. While `open` is already true,
   * incrementing this re-focuses + selects the existing input so the user
   * can retype without first clearing.
   */
  focusNonce?: number;
}

// One highlight name for every pane: find closes when its pane loses focus,
// so two panes rarely paint at once, and then the latest wins.
const HIGHLIGHT_NAME = 'pane-find';

export default function PaneFind({ open, rootRef, onClose, onVisitMatch, focusNonce }: PaneFindProps) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [currentIdx, setCurrentIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelFlashRef = useRef<(() => void) | null>(null);
  const matches = usePaneFindMatches(rootRef, open ? debounced : '');

  useEffect(() => {
    if (open) {
      setQuery('');
      setDebounced('');
      setCurrentIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Refocus + select on each ⌘F nonce bump while already open.
  useEffect(() => {
    if (!open) return;
    if (focusNonce === undefined) return;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }, [focusNonce, open]);

  // Global ESC while find is open — closes regardless of focus location.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isImeComposing(e)) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 80);
    return () => clearTimeout(t);
  }, [query]);

  // Painted with the CSS Custom Highlight API, apart from React render, so
  // streaming and markdown rendering don't fight it.
  useEffect(() => {
    const highlights = typeof CSS === 'undefined' ? undefined : (CSS as unknown as { highlights?: Map<string, Highlight> }).highlights;
    if (!highlights || typeof Highlight === 'undefined' || matches.length === 0) return;
    highlights.set(HIGHLIGHT_NAME, new Highlight(...matches));
    return () => { highlights.delete(HIGHLIGHT_NAME); };
  }, [matches]);

  useEffect(() => () => cancelFlashRef.current?.(), []);

  // A new query starts from its first match. Typing only updates the
  // highlight and counter; scrolling and the flash wait for Enter or the
  // prev/next buttons. A transcript change (a streaming reply) keeps the place.
  useEffect(() => {
    setCurrentIdx(0);
  }, [debounced]);

  if (!open) return null;

  const current = Math.min(currentIdx, Math.max(matches.length - 1, 0));

  function go(delta: number) {
    if (matches.length === 0) return;
    const next = (current + delta + matches.length) % matches.length;
    setCurrentIdx(next);
    const range = matches[next];
    cancelFlashRef.current?.();
    if (onVisitMatch) {
      cancelFlashRef.current = onVisitMatch(range);
      return;
    }
    range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: smoothScrollBehavior() });
    cancelFlashRef.current = flashMatchOverlay(range);
  }

  return (
    // Closes on any Esc while up: a layer the ⌘J panel's Esc yields to when
    // it is in the panel, or the page has focus ("pane": under the panel).
    <div className="t-pane-find" data-escape-layer="pane" data-notice-avoid onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="find in pane…"
        className="t-pane-find-input"
        type="text"
        onKeyDown={(e) => {
          if (isImeComposing(e)) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <button type="button" className="t-pane-find-nav" onClick={() => go(-1)} aria-label="prev">◀</button>
      <button type="button" className="t-pane-find-nav" onClick={() => go(1)} aria-label="next">▶</button>
      <span className="t-pane-find-counter">
        {matches.length === 0 ? '0 / 0' : `${current + 1} / ${matches.length}`}
      </span>
      <button type="button" className="t-pane-find-close" onClick={onClose} aria-label="close">×</button>
    </div>
  );
}

const FIND_CSS = `
/* CSS Custom Highlight API rule for ⌘F per-pane find. Keep this runtime-injected
   so Lightning CSS does not warn on the valid ::highlight() pseudo-element. */
::highlight(pane-find) {
  background-color: color-mix(in srgb, var(--term-select, #ffd54f) 38%, transparent);
}
.t-pane-find {
  position: absolute; top: 8px; right: 8px;
  display: flex; align-items: center; gap: 4px;
  padding: 4px 6px;
  background: var(--term-surface);
  border: 1px solid var(--term-line);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  font-family: var(--ui-font);
  font-size: var(--fs-sm);
  z-index: var(--z-pane-overlay);
}
.t-pane-find-input {
  width: 160px;
  background: transparent; border: 0; outline: none;
  font: inherit; color: var(--term-fg);
  padding: 2px 6px;
}
.t-pane-find-input::placeholder { color: var(--term-faint); }
.t-pane-find-nav, .t-pane-find-close {
  background: transparent; border: 0; cursor: pointer;
  color: var(--term-mid);
  padding: 2px 4px;
  font: inherit;
  border-radius: var(--ui-radius-sm);
}
.t-pane-find-nav:hover, .t-pane-find-close:hover {
  background: var(--term-hover-bg, var(--term-alt)); color: var(--term-fg);
}
.t-pane-find-counter {
  color: var(--term-muted);
  padding: 0 4px;
  white-space: nowrap;
}
`;

if (typeof document !== 'undefined' && !document.getElementById('t-pane-find-css')) {
  const el = document.createElement('style');
  el.id = 't-pane-find-css';
  el.textContent = FIND_CSS;
  document.head.appendChild(el);
}
