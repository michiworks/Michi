import React, { useEffect, useState } from 'react';
import { smoothScrollBehavior } from '../../../hooks/useReducedMotion';

/** Group titles a page's sections carry: Settings sections (h2) and the Pages upkeep groups inside one (h3). */
const HEADINGS = '.settings-section__title, .meta-set__head > h3, .meta-set__sec > h3';
/** Pages shorter than this many screens are read by scrolling; longer ones get the list. */
const SCREENS = 2;
/** The fewest groups worth a list. */
const MIN_ENTRIES = 3;
/** Narrower than this, the page column keeps the room (the window is laid out at a fixed width). */
const MIN_WINDOW_WIDTH = 1000;
/** A group counts as the one in view once its top is this close under the page's top. */
const SPY_OFFSET = 48;

interface Entry { label: string; target: HTMLElement; sub: boolean }

const sameEntries = (a: Entry[], b: Entry[]) => a.length === b.length
  && a.every((entry, i) => entry.label === b[i].label && entry.target === b[i].target && entry.sub === b[i].sub);

function readEntries(root: HTMLElement): Entry[] {
  const shell = root.parentElement;
  if (!shell || shell.clientWidth < MIN_WINDOW_WIDTH || root.scrollHeight <= root.clientHeight * SCREENS) return [];
  const entries = Array.from(root.querySelectorAll<HTMLElement>(HEADINGS)).flatMap((heading) => {
    const label = heading.textContent?.trim();
    const target = heading.closest<HTMLElement>('section') ?? heading;
    return label ? [{ label, target, sub: heading.tagName === 'H3' }] : [];
  });
  return entries.length >= MIN_ENTRIES ? entries : [];
}

/**
 * On this page: a long Settings page's groups in a column beside it, the one
 * in view marked; choosing one scrolls the page to it. `contentRef` is the
 * page's scrolling column, which keeps the list current as the page loads.
 */
export function SettingsToc({ contentRef }: { contentRef: React.RefObject<HTMLElement | null> }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = readEntries(root);
      setEntries((previous) => sameEntries(previous, next) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    schedule();
    // Pages load their parts lazily and grow; the window can be resized.
    const mutations = new MutationObserver(schedule);
    mutations.observe(root, { childList: true, subtree: true });
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    sizes?.observe(root);
    if (root.parentElement) sizes?.observe(root.parentElement);
    return () => { cancelAnimationFrame(frame); mutations.disconnect(); sizes?.disconnect(); };
  }, [contentRef]);

  useEffect(() => {
    const root = contentRef.current;
    if (!root || entries.length === 0) return;
    const spy = () => {
      const top = root.getBoundingClientRect().top;
      let at = 0;
      entries.forEach((entry, i) => { if (entry.target.getBoundingClientRect().top - top <= SPY_OFFSET) at = i; });
      // Scrolled to the end, the last groups never reach the top: the last one is in view.
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) at = entries.length - 1;
      setCurrent(at);
    };
    spy();
    root.addEventListener('scroll', spy, { passive: true });
    return () => root.removeEventListener('scroll', spy);
  }, [contentRef, entries]);

  if (entries.length === 0) return null;
  const jump = (entry: Entry) => {
    const root = contentRef.current;
    if (!root) return;
    const top = entry.target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 10;
    root.scrollTo({ top, behavior: smoothScrollBehavior() });
  };
  return (
    <nav className="settings-toc term-scrollbar" aria-label="On this page">
      <h2 className="settings-toc__title">On this page</h2>
      {entries.map((entry, i) => (
        <button key={`${i}:${entry.label}`} type="button" className="settings-toc__item" data-sub={entry.sub ? '' : undefined}
          aria-current={i === current ? 'location' : undefined} onClick={() => jump(entry)}>
          {entry.label}
        </button>
      ))}
    </nav>
  );
}
