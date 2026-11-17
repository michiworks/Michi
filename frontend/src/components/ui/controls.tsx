import React from 'react';

/**
 * Shared interactive-control primitives. Before these existed, ghost /
 * secondary / primary buttons, toggle switches, and text inputs were
 * re-inlined per call site (~7 button copies, 3 toggle copies, ~13 input
 * copies), which is why the same control looked subtly different depending on
 * which drawer / modal it lived in. All visual state (hover, focus, disabled,
 * danger) is CSS-driven via `.ui-btn` / `.ui-input` in index.css so callers
 * stop sprinkling inline style objects.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'action';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight. Defaults to 'secondary' (bordered, transparent fill). */
  variant?: ButtonVariant;
  /** Compact padding + smaller text. Pairs with any variant. */
  size?: 'sm';
  /** Recolor to the danger token (fill for primary, text for the rest). */
  danger?: boolean;
  /**
   * Its action is in flight: presses are ignored (a submit included) and
   * keyboard focus stays, as aria-disabled rather than `disabled`, which would
   * drop focus to the page; it shows the disabled look with the progress cursor.
   */
  busy?: boolean;
  /** The label while busy, ending in "…" ("Saving…"); the button keeps the wider label's width. */
  busyLabel?: React.ReactNode;
}

/** Text button. `<Button variant="primary">Save</Button>`. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size, danger, busy = false, busyLabel, className, children, type = 'button', onClick, ...rest },
  ref,
) {
  const cls = [
    'ui-btn',
    variant !== 'secondary' && `ui-btn--${variant}`,
    size === 'sm' && 'ui-btn--sm',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={cls} data-danger={danger ? 'true' : undefined} {...rest}
      aria-disabled={busy || rest['aria-disabled']} aria-busy={busy || rest['aria-busy']}
      onClick={busy ? (event) => event.preventDefault() : onClick}>
      {busyLabel === undefined ? children : <BusyLabel busy={busy} label={busyLabel}>{children}</BusyLabel>}
    </button>
  );
});

/**
 * A control's label and its in-flight form ("Saving…") in one grid cell, the
 * one not shown hidden, so the control keeps its width when it swaps.
 * `<Button busyLabel>` uses it; a control that is not a Button can too.
 */
export function BusyLabel({ busy, label, children }: { busy: boolean; label: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="ui-busy-label">
      <span aria-hidden={busy || undefined}>{children}</span>
      <span aria-hidden={!busy || undefined}>{label}</span>
    </span>
  );
}

export interface SwitchProps {
  on: boolean;
  onChange: (next: boolean) => void;
  'aria-label'?: string;
  disabled?: boolean;
  /**
   * Its save is in flight: it keeps its value and keyboard focus, ignores
   * presses and shows the disabled look (aria-disabled, not `disabled`, which
   * would drop focus to the page).
   */
  busy?: boolean;
}

/**
 * The sliding toggle switch, 28×16 by default. Its markup was written verbatim
 * three times in Settings alone; this is the single source. Purely
 * presentational — wrap it in a ClickableRow / label for the tappable text.
 * Its look is CSS (.ui-switch in index.css), so a surface can restyle it:
 * Settings draws it larger (Settings.css).
 */
export function Switch({ on, onChange, disabled, busy, ...rest }: SwitchProps) {
  const ariaLabel = rest['aria-label'];
  return (
    <button
      type="button"
      role="switch"
      className="ui-switch"
      aria-checked={on}
      aria-label={ariaLabel}
      aria-disabled={busy || undefined}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!busy) onChange(!on);
      }}
    >
      <span className="ui-switch__knob" aria-hidden="true" />
    </button>
  );
}
