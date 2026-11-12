import React, { useEffect, useRef, useState } from 'react';
import { companionBadgeCount } from 'michi-shared';
import { kbd } from '../../../lib/platform';
import { Tooltip } from '../../ui/Popover';
import { loadCompanionAssistant, useCompanion, useCompanionAssistant } from '../../../state/companion/companionStore';
import { closeCompanionPanel, openCompanionPanel, useCompanionPanel } from '../../../state/companion/companionPanel';
import { useCompanionName } from '../../../state/companion/companionName';
import { CompanionGlyph } from './CompanionGlyph';
import './companion.css';

/**
 * The agent's one anchor (DESIGN-v2 §1.2): opens and closes the panel, in
 * every area. It shows as soon as there is a conversation (`/assistant`),
 * without waiting for the Companion snapshot (§1.3); the badge counts what
 * needs the user and is new plus the agent's messages since they last
 * looked, and goes without while there is no snapshot. Before the first open
 * a dot says it is new. Nothing shows when this backend has no assistant.
 */
export function CompanionTopbarButton() {
  const { snapshot } = useCompanion();
  const assistant = useCompanionAssistant();
  const panel = useCompanionPanel();
  const name = useCompanionName();
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => { void loadCompanionAssistant(); }, []);
  if (!assistant.info) return null;
  const count = companionBadgeCount(snapshot);
  const fresh = !panel.openedBefore;
  const label = count > 0 ? `${name}, ${count} new` : fresh ? `${name}, new` : name;
  return (
    <>
      <button
        ref={ref}
        type="button"
        data-companion-button=""
        className={`t-icon-btn companion-topbar-btn${panel.open ? ' is-on' : ''}`}
        aria-label={label}
        aria-pressed={panel.open}
        onClick={() => { if (panel.open) closeCompanionPanel(); else openCompanionPanel(); }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          minWidth: 26,
          height: 26,
          padding: '0 6px',
          color: panel.open ? undefined : 'var(--term-faint)',
          flexShrink: 0,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <CompanionGlyph size={14} />
        {count > 0
          ? <span className="companion-topbar-btn__badge" aria-hidden="true">{count > 9 ? '9+' : count}</span>
          : fresh ? <span className="companion-topbar-btn__new" aria-hidden="true" /> : null}
      </button>
      {hover && <Tooltip anchorRef={ref} label={panel.open ? `Close ${name}` : name} kbd={kbd('mod', 'J')} />}
    </>
  );
}
