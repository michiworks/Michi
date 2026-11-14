import React, { useState } from 'react';
import { HoverTip } from './Popover';
import './InfoTip.css';

/**
 * An explanation behind a "?" beside a name (a setting, a list's heading):
 * a hover or keyboard focus shows it as a tooltip, and a press (a phone has
 * no hover) shows it in place. Put it in a wrapping flex row with the name
 * so the text can take the next line.
 */
export function InfoTip({ text, label = 'More about this setting' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <HoverTip label={<span className="info-tip__bubble">{text}</span>} delayMs={200}>
        <button type="button" className="info-tip" aria-label={label} aria-expanded={open}
          onClick={() => setOpen((value) => !value)}>?</button>
      </HoverTip>
      {open && <span className="info-tip__text">{text}</span>}
    </>
  );
}
