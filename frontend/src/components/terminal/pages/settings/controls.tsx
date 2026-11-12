import React from 'react';
import '../Settings.css';

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

const option = <T extends string>(item: T | RadioOption<T>): RadioOption<T> => typeof item === 'string' ? { value: item, label: item } : item;

/** Native inputs supply Tab, Space and arrow-key behavior; labels keep the full row clickable. */
export function Radio<T extends string>({
  opts,
  value,
  onChange,
  label,
}: {
  opts: ReadonlyArray<T | RadioOption<T>>;
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  const name = React.useId();
  return (
    <div role="radiogroup" aria-label={label} className="settings-radio">
      {opts.map((item, i) => {
        const o = option(item);
        const sel = o.value === value;
        return (
          <label key={o.value} className={`settings-radio__option t-row-hover${sel ? ' is-active' : ''}`}>
            <input type="radio" aria-label={o.label} name={name} value={o.value} checked={sel} onChange={() => onChange(o.value)}
              className="settings-radio__input"
              aria-describedby={o.description ? `${name}-${i}-description` : undefined} />
            <span>
              <span className="settings-radio__label">{o.label}</span>
              {o.description && <span id={`${name}-${i}-description`} className="settings-radio__description">{o.description}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * A few short choices side by side, for the control slot of a settings row.
 * Native radios underneath, so Tab, Space and the arrow keys work as in Radio.
 */
export function Segmented<T extends string>({
  opts,
  value,
  onChange,
  label,
  disabled = false,
}: {
  opts: ReadonlyArray<T | RadioOption<T>>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  /** While a choice saves: the choices stay in view and take no input. */
  disabled?: boolean;
}) {
  const name = React.useId();
  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className="settings-segmented">
      {opts.map((item) => {
        const o = option(item);
        return (
          <label key={o.value} className="settings-segmented__option">
            <input type="radio" name={name} value={o.value} checked={o.value === value} disabled={disabled} onChange={() => onChange(o.value)}
              className="settings-segmented__input" />
            <span>{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

/** Up to this many choices read as a segmented control; more go in a select. */
export const SEGMENTED_MAX = 5;
