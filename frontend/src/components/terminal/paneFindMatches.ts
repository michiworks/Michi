import { useEffect, useState, type RefObject } from 'react';

/** Bursts of transcript changes (a streaming reply) re-collect at most this often. */
const RECOLLECT_MS = 100;
const NO_MATCHES: Range[] = [];

/**
 * Every occurrence of `q` (already lowercased) in the messages under `root`,
 * in document order. Skipped: a frame's own labels, marked data-find-skip
 * (the speaker label, the time and usage row), which are not what was said;
 * and text never shown on screen, where a hit would be counted but unseen.
 */
function collectFindRanges(root: Element, q: string): Range[] {
  const ranges: Range[] = [];
  for (const frame of Array.from(root.querySelectorAll('[data-msg-id]'))) {
    const walker = document.createTreeWalker(frame, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        const el = node as Element;
        // Never shown: a mermaid SVG's theme <style>, the MathML copy
        // rehype-katex renders beside the visible math, screen-reader labels.
        const unshown = el.localName === 'style' || el.classList.contains('katex-mathml') || el.classList.contains('sr-only');
        return unshown || el.hasAttribute('data-find-skip') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });
    let textNode: Text | null;
    while ((textNode = walker.nextNode() as Text | null)) {
      const lower = textNode.data.toLowerCase();
      for (let found = lower.indexOf(q); found !== -1; found = lower.indexOf(q, found + q.length)) {
        const range = document.createRange();
        range.setStart(textNode, found);
        range.setEnd(textNode, found + q.length);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

/**
 * The pane find's one match list for `query` in the transcript under
 * `rootRef`: what its counter counts, its highlight paints and Enter visits.
 * Re-collected as the transcript changes, so a streaming reply's new text
 * is found too.
 */
export function usePaneFindMatches(rootRef: RefObject<HTMLElement | null>, query: string): Range[] {
  const [matches, setMatches] = useState<Range[]>(NO_MATCHES);
  useEffect(() => {
    const root = rootRef.current;
    const q = query.trim().toLowerCase();
    if (!root || !q) {
      setMatches(NO_MATCHES);
      return;
    }
    const collect = () => setMatches(collectFindRanges(root, q));
    collect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      timer ??= setTimeout(() => {
        timer = undefined;
        collect();
      }, RECOLLECT_MS);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [rootRef, query]);
  return matches;
}

// Briefly flash a DOM Range by overlaying an absolutely-positioned, fading box
// on top of it. Uses a real stylesheet animation (index.css .t-find-flash) and a
// rAF loop to keep the box glued to the text while a smooth scroll is in flight,
// so it works regardless of CSS Custom Highlight API support. Returns a cancel fn.
export function flashMatchOverlay(range: Range): () => void {
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') {
    return () => {};
  }
  const overlay = document.createElement('div');
  overlay.className = 't-find-flash';
  document.body.appendChild(overlay);
  const startedAt = performance.now();
  let raf = 0;
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    overlay.remove();
  };
  const position = (now: number) => {
    const rect = range.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    if (now - startedAt < 650) {
      raf = requestAnimationFrame(position);
    } else {
      cleanup();
    }
  };
  raf = requestAnimationFrame(position);
  return cleanup;
}
