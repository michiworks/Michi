import { useEffect, useRef, type ReactNode } from 'react';
import type { TerminalKeyName } from './terminalKeys';

export type TerminalBarKey = TerminalKeyName | 'Ctrl' | 'Hide' | `text:${string}`;

const KEYS: Array<{ key: TerminalBarKey; label: ReactNode; aria?: string; word?: boolean } | 'gap'> = [
  { key: 'Escape', label: 'esc', word: true },
  { key: 'Tab', label: 'tab', word: true },
  { key: 'Ctrl', label: 'ctrl', word: true },
  'gap',
  { key: 'ArrowLeft', label: '←', aria: 'Left' },
  { key: 'ArrowUp', label: '↑', aria: 'Up' },
  { key: 'ArrowDown', label: '↓', aria: 'Down' },
  { key: 'ArrowRight', label: '→', aria: 'Right' },
  'gap',
  { key: 'text:~', label: '~' },
  { key: 'text:/', label: '/' },
  { key: 'text:|', label: '|' },
  { key: 'text:-', label: '-' },
];

const HIDE_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3.5" width="18" height="11" rx="2" /><path d="M7 7.5h.01M10.5 7.5h.01M14 7.5h.01M17 7.5h.01M8 11h8" /><path d="m9 18 3 2.5 3-2.5" />
  </svg>
);

/**
 * The phone keyboard's missing keys, above it. A key acts on touch end and
 * never takes focus from the terminal, so the keyboard stays up. React's touch
 * listeners are passive, so these are native ones.
 */
export function TerminalKeyBar({ onKey, ctrlArmed, disabled }: {
  onKey: (key: TerminalBarKey) => void;
  ctrlArmed: boolean;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    let touchedAt = 0;
    const keyOf = (event: Event) => (event.target as Element | null)?.closest?.<HTMLButtonElement>('button[data-key]') ?? null;
    const onTouchStart = (event: TouchEvent) => {
      const button = keyOf(event);
      if (!button) return;
      event.preventDefault();
      button.dataset.down = 'true';
    };
    const onTouchEnd = (event: TouchEvent) => {
      const button = keyOf(event);
      if (!button) return;
      event.preventDefault();
      delete button.dataset.down;
      touchedAt = Date.now();
      if (!button.disabled) onKeyRef.current(button.dataset.key as TerminalBarKey);
    };
    const onTouchCancel = (event: TouchEvent) => { const button = keyOf(event); if (button) delete button.dataset.down; };
    const onMouseDown = (event: MouseEvent) => { if (keyOf(event)) event.preventDefault(); };
    const onClick = (event: MouseEvent) => {
      const button = keyOf(event);
      if (!button || button.disabled || Date.now() - touchedAt < 600) return;
      onKeyRef.current(button.dataset.key as TerminalBarKey);
    };
    bar.addEventListener('touchstart', onTouchStart, { passive: false });
    bar.addEventListener('touchend', onTouchEnd, { passive: false });
    bar.addEventListener('touchcancel', onTouchCancel);
    bar.addEventListener('mousedown', onMouseDown);
    bar.addEventListener('click', onClick);
    return () => {
      bar.removeEventListener('touchstart', onTouchStart);
      bar.removeEventListener('touchend', onTouchEnd);
      bar.removeEventListener('touchcancel', onTouchCancel);
      bar.removeEventListener('mousedown', onMouseDown);
      bar.removeEventListener('click', onClick);
    };
  }, []);
  return (
    <div ref={ref} className="terminal-keybar" role="toolbar" aria-label="Terminal keys">
      {KEYS.map((entry, index) => entry === 'gap'
        ? <span key={`gap-${index}`} className="terminal-keybar__gap" aria-hidden />
        : (
          <button
            key={entry.key}
            type="button"
            tabIndex={-1}
            data-key={entry.key}
            disabled={disabled}
            aria-label={entry.aria}
            aria-pressed={entry.key === 'Ctrl' ? ctrlArmed : undefined}
            className={`terminal-keybar__key${entry.word ? ' terminal-keybar__key--word' : ''}${entry.key === 'Ctrl' && ctrlArmed ? ' terminal-keybar__key--armed' : ''}`}
          >
            {entry.label}
          </button>
        ))}
      <button type="button" tabIndex={-1} data-key="Hide" aria-label="Hide keyboard" className="terminal-keybar__key terminal-keybar__key--hide">
        {HIDE_ICON}
      </button>
    </div>
  );
}
