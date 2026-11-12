import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, useIsPresent } from 'motion/react';
import { Brain } from 'lucide-react';
import { toast } from 'sonner';
import type { ConversationMemoryMode } from 'michi-shared';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { useBackLayer } from '../../lib/backStack';
import { isMemoryNotFound } from '../../services/api/memories';
import { useConversationMemory } from '../../state/memory/conversationMemory';
import { menuOpenKey } from '../ContextMenu';
import { measureSurface, PopoverSurface } from '../ui/Popover';
import { COMPOSER_ICON_STROKE, composerIconSize, composerMenusOpenBelow } from './PaneComposerToolbarLeft';
import './ComposerModelPicker.css';
import './ConversationMemoryControl.css';

export const CONVERSATION_MEMORY_CHOICES: ReadonlyArray<{ mode: ConversationMemoryMode; label: string; description: string }> = [
  { mode: 'learn', label: 'Learn', description: 'Use your memories, and remember what matters from this chat.' },
  { mode: 'use_only', label: 'Use only', description: 'Use your memories, but remember nothing from this chat.' },
  { mode: 'off', label: 'Off', description: 'Don’t use memory or other chats, and remember nothing from this chat.' },
];

const labelOf = (mode: ConversationMemoryMode) => CONVERSATION_MEMORY_CHOICES.find((choice) => choice.mode === mode)?.label ?? 'Learn';

function MemoryIcon({ mode }: { mode: ConversationMemoryMode }) {
  const size = composerIconSize(usePhoneLayout());
  // Off: the same brain, struck through, as the permission chip strikes its shield.
  return (
    <Brain size={size} strokeWidth={COMPOSER_ICON_STROKE} absoluteStrokeWidth aria-hidden="true">
      {mode === 'off' && <path key="strike" d="M3 3l18 18" />}
    </Brain>
  );
}

/**
 * The chat's memory setting in its composer: Learn (the default, a quiet
 * icon), Use only or Off (named, so a chat Michi does not learn from says
 * so). Hidden where the chat's backend has no such setting and while memory
 * is off for every chat (Settings › Memory).
 */
export function ConversationMemoryControl({ apiBase, nodeId, toolbarTier = 0, disabled = false }: {
  apiBase: string;
  nodeId: string;
  /** The composer toolbar's width tier: at 2 (narrowest) every mode is an icon. */
  toolbarTier?: 0 | 1 | 2;
  disabled?: boolean;
}) {
  const memory = useConversationMemory(apiBase, nodeId);
  const [anchor, setAnchor] = useState<{ trigger: HTMLButtonElement } | null>(null);
  useEffect(() => { if (disabled) setAnchor(null); }, [disabled]);
  if (!memory.mode) return null;
  const mode = memory.mode;
  const label = labelOf(mode);

  const choose = async (next: ConversationMemoryMode) => {
    try {
      const change = await memory.setMode(next);
      if (change.removedMemories > 0) {
        toast(change.removedMemories === 1
          ? 'Forgot 1 memory Michi had learned from this chat'
          : `Forgot ${change.removedMemories} memories Michi had learned from this chat`);
      }
    } catch (error) {
      toast.error(isMemoryNotFound(error)
        ? 'Couldn’t change memory for this chat yet. Try again in a moment.'
        : `Couldn’t change memory for this chat: ${error instanceof Error && error.message ? error.message : 'unknown error'}`);
    }
  };

  return <>
    {/* Busy, not disabled, while saving: a disabled button would drop the focus the menu just gave back. */}
    <button type="button" className="t-toolbar-chip composer-memory-chip" style={{ flexShrink: 0 }}
      data-icononly={(mode === 'learn' && !memory.saving) || toolbarTier === 2 || undefined}
      aria-label={`Memory: ${label}`} title={`Memory for this chat: ${label}`}
      aria-haspopup="menu" aria-expanded={!!anchor} aria-busy={memory.saving || undefined} disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (memory.saving) return;
        const trigger = event.currentTarget;
        setAnchor((open) => open ? null : { trigger });
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        if (memory.saving) return;
        const trigger = event.currentTarget;
        setAnchor((open) => open ?? { trigger });
      }}>
      <MemoryIcon mode={mode} />
      <span className="t-chip-label">{memory.saving ? 'Saving…' : label}</span>
    </button>
    <AnimatePresence>{anchor && !disabled && (
      <ConversationMemoryMenu key={menuOpenKey(anchor)} trigger={anchor.trigger} mode={mode}
        onClose={() => setAnchor(null)} onSelect={(next) => { void choose(next); }} />
    )}</AnimatePresence>
  </>;
}

/**
 * The three choices, as a menu of radio items: focus starts on the current
 * one; arrows, Home and End move; Enter or Space picks; Esc and Tab close and
 * give focus back to the chip. It opens above the chip (below in the tray
 * and on Home, as the composer's other menus do) and stays on screen.
 */
function ConversationMemoryMenu({ trigger, mode, onClose, onSelect }: {
  trigger: HTMLButtonElement;
  mode: ConversationMemoryMode;
  onClose: () => void;
  onSelect: (mode: ConversationMemoryMode) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: -9999, top: 0 });
  const present = useIsPresent();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback((refocus: boolean) => {
    if (refocus) trigger.focus({ preventScroll: true });
    closeRef.current();
  }, [trigger]);
  useBackLayer(present, { back: () => close(true) });

  useLayoutEffect(() => {
    const place = () => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = trigger.getBoundingClientRect();
      const { width, height } = measureSurface(surface);
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const above = rect.top - 6 - height;
      const below = rect.bottom + 6;
      const fitsAbove = above >= viewportTop + 8;
      const fitsBelow = below + height <= viewportTop + viewportHeight - 8;
      const preferBelow = composerMenusOpenBelow(trigger);
      const top = preferBelow ? (fitsBelow || !fitsAbove ? below : above) : (fitsAbove || !fitsBelow ? above : below);
      const next = {
        left: Math.max(viewportLeft + 8, Math.min(rect.right - width, viewportLeft + viewportWidth - width - 8)),
        top: Math.max(viewportTop + 8, Math.min(top, viewportTop + viewportHeight - height - 8)),
      };
      setPosition((previous) => previous.left === next.left && previous.top === next.top ? previous : next);
    };
    place();
    surfaceRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [trigger]);

  useEffect(() => {
    if (!present) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || surfaceRef.current?.contains(event.target) || trigger.contains(event.target)) return;
      close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [present, trigger, close]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    // Back to the chip first, so Tab moves on from there, not from the menu's end of the page.
    if (event.key === 'Tab') { close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(surfaceRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index]?.focus({ preventScroll: true });
  };

  return (
    <PopoverSurface ref={surfaceRef} menuKind="composer" role="menu" aria-label="Memory for this chat"
      className="composer-picker composer-memory-menu" left={position.left} top={position.top}
      width="var(--m-width)" maxWidth="calc(100vw - 16px)"
      onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <div className="composer-picker-body" onKeyDown={onKeyDown}>
        <div className="michi-menu-section" aria-hidden="true">Memory · this chat</div>
        {CONVERSATION_MEMORY_CHOICES.map((choice) => {
          const checked = choice.mode === mode;
          return (
            <button key={choice.mode} type="button" role="menuitemradio" aria-checked={checked} className="composer-picker-row"
              onClick={() => {
                close(true);
                if (!checked) onSelect(choice.mode);
              }}>
              <span className="composer-picker-copy">
                <span className="composer-picker-value">{choice.label}</span>
                <span className="composer-picker-caption">{choice.description}</span>
              </span>
              <span className="michi-menu-glyph" aria-hidden="true">{checked ? '✓' : ''}</span>
            </button>
          );
        })}
        {mode === 'learn' && (
          <p className="michi-menu-footer composer-memory-menu__note">
            Leaving Learn also forgets what Michi learned from this chat on its own. Memories you asked it to save stay.
          </p>
        )}
      </div>
    </PopoverSurface>
  );
}
