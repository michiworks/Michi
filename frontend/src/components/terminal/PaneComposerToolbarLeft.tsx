import type { MouseEvent } from 'react';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import type { AgentStatus, SessionMode } from '../../services/api';
import { HoverTip } from '../ui/Popover';
import { AgentIcon, AtSignIcon, ChevronRightIcon, PlusIcon } from './icons';

/**
 * A pointer press on + or @ leaves focus where it is, as the click-only chips
 * did: focus moving onto a chip would open the phone's resting composer under
 * the pointer before the click lands, and @ goes in at the field's caret. The
 * keyboard still reaches them with Tab.
 */
const keepFocus = (e: MouseEvent) => e.preventDefault();

/** Icon-only toolbar buttons: 16px on desktop, 18px on a phone. */
export const composerIconSize = (phone: boolean) => (phone ? 18 : 16);

export const REASONING_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** Toolbar menus open downward, off the draft, where the toolbar is near the
 *  top of the screen: the tray under the composer, and Home, whose composer
 *  sits at the top of the page. Elsewhere they open above. */
export const composerMenusOpenBelow = (trigger: Element) => !!trigger.closest('.composer-tray, .home-compose');

/** Where a toolbar menu's top goes when it opens below: 6px under the
 *  composer's frame, which would otherwise cover the frame's bottom edge.
 *  A trigger outside the frame (the tray) is measured from itself. */
export const composerMenuBelowEdge = (trigger: Element) =>
  (trigger.closest('.terminal-composer') ?? trigger).getBoundingClientRect().bottom + 6;

export interface PaneMenuAnchor {
  x: number;
  y: number;
  anchorBottom?: number;
  /** Open below the trigger, flipping above only when it does not fit
   *  (composerMenusOpenBelow). */
  preferBelow?: boolean;
  align?: 'start' | 'end';
  trigger?: HTMLButtonElement;
  keyboard?: boolean;
}

interface PaneComposerToolbarLeftProps {
  canAttach: boolean;
  /** Show + (attach) and @ (mention). Off where neither does anything (the Michi assistant). */
  contextTools?: boolean;
  toolbarTier: 0 | 1 | 2;
  enableAgentChip?: boolean;
  currentMode?: SessionMode;
  currentModeId?: string;
  availableModesCount: number;
  agentStatus: AgentStatus | null;
  onPickFile: () => void;
  onInsertMentionTrigger: () => void;
  /** Called on every agent-chip press; the owner toggles the menu. */
  onOpenAgentMenu: (anchor: PaneMenuAnchor) => void;
  agentMenuOpen?: boolean;
}

export function PaneComposerToolbarLeft({
  canAttach,
  contextTools = true,
  toolbarTier,
  enableAgentChip = true,
  currentMode,
  currentModeId,
  availableModesCount,
  agentStatus,
  onPickFile,
  onInsertMentionTrigger,
  onOpenAgentMenu,
  agentMenuOpen = false,
}: PaneComposerToolbarLeftProps) {
  const showAgentChip =
    enableAgentChip &&
    toolbarTier < 2 &&
    agentStatus?.capabilities.modes !== false &&
    !!(
      currentMode ||
      currentModeId ||
      availableModesCount > 0 ||
      agentStatus?.capabilities.modes === true
    );
  const iconSize = composerIconSize(usePhoneLayout());

  return (
    <>
      {contextTools && (
        <>
          {/* Without a workspace the chip stays focusable and says why on hover and on focus (ST-12). */}
          <HoverTip label={canAttach ? 'Attach file' : 'Open a workspace to attach files'}>
            <button
              type="button"
              className="t-toolbar-chip composer-attach"
              aria-label="Attach file"
              aria-disabled={!canAttach || undefined}
              onMouseDown={keepFocus}
              onClick={(e) => {
                e.stopPropagation();
                if (canAttach) onPickFile();
              }}
              style={{ flexShrink: 0, padding: 0, width: 'var(--composer-chip-height, 30px)', justifyContent: 'center', lineHeight: 1 }}
            >
              <PlusIcon size={iconSize} />
            </button>
          </HoverTip>

          <HoverTip label="Mention context or node">
            <button
              type="button"
              className="t-toolbar-chip composer-mention"
              aria-label="Mention context or node"
              onMouseDown={keepFocus}
              onClick={onInsertMentionTrigger}
              style={{ flexShrink: 0, padding: 0, width: 'var(--composer-chip-height, 30px)', justifyContent: 'center', lineHeight: 1 }}
            >
              <AtSignIcon size={iconSize} />
            </button>
          </HoverTip>
        </>
      )}

      {showAgentChip && (
        <button
          type="button"
          className="t-toolbar-chip"
          data-icononly={toolbarTier >= 1 ? 'true' : undefined}
          title={`Switch agent — ${currentMode?.name ?? currentModeId ?? 'agent'}`}
          aria-haspopup="menu"
          aria-expanded={agentMenuOpen}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onOpenAgentMenu({ x: r.left, y: composerMenuBelowEdge(e.currentTarget), anchorBottom: r.top - 6, preferBelow: composerMenusOpenBelow(e.currentTarget), trigger: e.currentTarget });
          }}
        >
          {/* Chip icons follow the 11px label (14px); ⌄ marks it as a picker, like the model chip. */}
          <AgentIcon />
          <span className="t-chip-label">{currentMode?.name ?? currentModeId ?? 'agent'}</span>
          <ChevronRightIcon className="composer-agent-chevron" />
        </button>
      )}
    </>
  );
}
