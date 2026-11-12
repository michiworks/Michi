import React, { createContext, useEffect, useRef, useState } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { Minus } from 'lucide-react';
import { DUR, EASE } from '../../motion/tokens';

/**
 * The building blocks every corner notice shares (motion, shrink-to-tab,
 * header, tab, announcements). Kept apart from ShellNotices, which mounts the
 * notices, so the notices can use them without an import cycle.
 */

/** Says a notice's news once, politely, through the corner's one live region. */
export const NoticeAnnounceContext = createContext<(text: string) => void>(() => {});

const SLIDE_IN = { duration: DUR.enter, ease: EASE.out };
const SLIDE_OUT = { duration: DUR.exit, ease: EASE.drawer };

/** A notice slides in from the window's right edge and back out, like a toast. */
export function NoticeMotion({ children, noticeKey }: { children: React.ReactNode; noticeKey: string }) {
  return (
    <motion.div
      key={noticeKey}
      className="shell-notice-motion"
      initial={{ x: '100%', opacity: 0 }}
      animate={{ x: 0, opacity: 1, transition: SLIDE_IN }}
      exit={{ x: '100%', opacity: 0, transition: SLIDE_OUT }}
    >
      {children}
    </motion.div>
  );
}

type Shrunk = ReadonlySet<string> | 'until-opened' | null;

function readShrunk(storageKey: string, startShrunk: boolean): Shrunk {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw === null) return startShrunk ? 'until-opened' : null;
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? new Set(value.filter((key): key is string => typeof key === 'string')) : null;
  } catch {
    return startShrunk ? 'until-opened' : null;
  }
}

function writeShrunk(storageKey: string, keys: readonly string[] | null): void {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(keys ?? 'open'));
  } catch {
    // A window without storage keeps the choice until it reloads.
  }
}

/**
 * Shrunk to its tab until something it did not show yet arrives: `keys` are
 * the notice's current items, and shrinking remembers the ones it had then,
 * for this window across reloads (sessionStorage). `startShrunk` keeps it a
 * tab, whatever arrives, until the user opens it. `focus` says where the
 * keyboard goes after the user shrank or opened it.
 */
export function useNoticeMinimized(keys: readonly string[], { storageKey, startShrunk = false }: { storageKey: string; startShrunk?: boolean }): {
  minimized: boolean;
  /** `moveFocus: false` when the notice gets out of the way of something the user opened. */
  minimize: (moveFocus?: boolean) => void;
  expand: () => void;
  focus: 'tab' | 'card' | null;
  focusDone: () => void;
} {
  const key = `michi:notice:${storageKey}`;
  const [shrunkWith, setShrunkWith] = useState<Shrunk>(() => readShrunk(key, startShrunk));
  const [focus, setFocus] = useState<'tab' | 'card' | null>(null);
  const minimized = shrunkWith === 'until-opened' || (shrunkWith !== null && keys.every((item) => shrunkWith.has(item)));
  return {
    minimized,
    minimize: (moveFocus = true) => {
      setShrunkWith(new Set(keys));
      writeShrunk(key, keys);
      setFocus(moveFocus ? 'tab' : null);
    },
    expand: () => {
      setShrunkWith(null);
      writeShrunk(key, null);
      setFocus('card');
    },
    focus,
    focusDone: () => setFocus(null),
  };
}

/** Says `text` once when `keys` gains an item it did not have (not for the items already there on mount). */
export function useAnnounceNew(keys: readonly string[], text: () => string): void {
  const announce = React.useContext(NoticeAnnounceContext);
  const seen = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = new Set(keys);
    if (before && keys.some((key) => !before.has(key))) announce(text());
    // `text` reads the current items; only a change of the item set says anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.join('\n'), announce]);
}

export type NoticeTone = 'ask' | 'interrupted';

/** A count, as the pane caption's ◆1 shows one: mono digits in the notice's colour. */
export function NoticeCount({ tone, count }: { tone: NoticeTone; count: number }) {
  return <span className={`shell-notice-count shell-notice-count--${tone}`}>{count}</span>;
}

/** Focuses `ref` once after mount when asked to, then says it is done. */
function useFocusOnMount(ref: React.RefObject<HTMLElement | null>, wanted: boolean, done?: () => void): void {
  useEffect(() => {
    if (!wanted) return;
    ref.current?.focus();
    done?.();
    // Mount only: the notice asks once, right after the user shrank or opened it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** A notice's first line: icon, title (and its count), a status pill, the shrink control. */
export function NoticeHeader({ tone, icon, title, count, status, cardId, minimizeLabel, onMinimize, focusTitle, onFocused }: {
  tone: NoticeTone;
  icon: React.ReactNode;
  title: string;
  count?: number;
  status?: React.ReactNode;
  /** The card the shrink control collapses (aria-controls). */
  cardId: string;
  minimizeLabel: string;
  onMinimize: () => void;
  /** The user just opened the card: the keyboard lands on its title. */
  focusTitle?: boolean;
  onFocused?: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnMount(heading, !!focusTitle, onFocused);
  return (
    <div className="shell-notice-head">
      <span aria-hidden className={`shell-notice-icon-mark shell-notice-icon-mark--${tone}`}>{icon}</span>
      <h3 ref={heading} tabIndex={-1} className="shell-notice-title" title={title}>{title}</h3>
      {count !== undefined && <NoticeCount tone={tone} count={count} />}
      <span className="shell-notice-spacer" />
      {status}
      <button
        type="button"
        className="t-icon-btn shell-notice-icon"
        aria-label={minimizeLabel}
        aria-expanded="true"
        aria-controls={cardId}
        title="Shrink (Esc)"
        onClick={(event) => { event.stopPropagation(); onMinimize(); }}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Esc inside a card shrinks it; the shell's own Esc then leaves the key alone (escapeIsForPage). */
export function shrinkOnEscape(onMinimize: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onMinimize();
  };
}

/** The shrunk form: the notice's icon and count, docked to the edge; a click opens it again. */
export function NoticeTab({ tone, icon, count, label, onExpand, focusOnMount, onFocused }: {
  tone: NoticeTone;
  icon: React.ReactNode;
  count: number;
  label: string;
  onExpand: () => void;
  /** The user just shrank the card: the keyboard lands on its tab. */
  focusOnMount?: boolean;
  onFocused?: () => void;
}) {
  const present = useIsPresent();
  const button = useRef<HTMLButtonElement>(null);
  useFocusOnMount(button, !!focusOnMount, onFocused);
  return (
    <button
      ref={button}
      type="button"
      className="shell-notice-tab"
      aria-label={label}
      aria-expanded="false"
      title={label}
      inert={!present}
      onClick={present ? onExpand : undefined}
    >
      <span aria-hidden className={`shell-notice-icon-mark shell-notice-icon-mark--${tone}`}>{icon}</span>
      <NoticeCount tone={tone} count={count} />
    </button>
  );
}
