import React, { useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Dot } from './primitives';
import ContextMenu, { menuOpenKey } from '../ContextMenu';
import { kbd } from '../../lib/platform';
import { describeRunningWork, type RunningWorkCounts } from '../../state/backgroundWork';
import { openBackgroundWork } from './backgroundWork/backgroundWorkEvents';
import { HoverTip } from '../ui/Popover';
import type { PaneItemKind } from '../../state/paneItems';
import { TemporaryChatGlyph } from './TemporaryChat';

const PANE_DRAG_MIME = 'application/x-michi-pane-id';
const PANE_ZOOM_KEYS = kbd('shift', 'mod', 'enter');
// The caption's controls share one height (the icon buttons are square), so
// boxes shown side by side line up: the exit control beside a hovered × or ◆.
const CONTROL_SIZE = 22;

function dotColorFor(streaming: boolean, error: boolean, focused: boolean): string {
  if (streaming) return 'var(--term-run)';
  if (error) return 'var(--term-danger)';
  if (focused) return 'var(--term-accent)';
  return 'var(--term-faint)';
}

interface Props {
  nodeId: string;
  title: string;
  focused: boolean;
  streaming: boolean;
  error: boolean;
  isNew?: boolean;
  /** Running subagents and workflows of this conversation (chat panes). */
  backgroundWork?: RunningWorkCounts;
  kind?: PaneItemKind | 'chat' | 'digest';
  /** A temporary chat (ChatNodeState.temporary): a ghost before its title. */
  temporary?: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (keepId: string) => void;
  canCloseOthers: boolean;
  onReorder: (fromId: string, toId: string) => void;
  /** This pane fills the strip alone. */
  zoomed?: boolean;
  /** There is more than one pane, so zooming would hide something. */
  canZoom?: boolean;
  /** Panes the zoom hides, shown on the exit control. */
  hiddenPaneCount?: number;
  /** Zoom this pane, or end the zoom with null. Absent where panes cannot zoom. */
  onZoom?: (id: string | null) => void;
}

export default function PaneCaption({
  nodeId,
  title,
  focused,
  streaming,
  error,
  isNew = false,
  backgroundWork,
  kind = 'chat',
  temporary = false,
  onFocus,
  onClose,
  onCloseOthers,
  canCloseOthers,
  // onReorder is intentionally accepted but unused: drops are handled by
  // TPane's existing pane-level drop zone (paneDropSide). Keeping it in
  // the API lets TPane pass reorderPane unconditionally.
  onReorder: _onReorder,
  zoomed = false,
  canZoom = false,
  hiddenPaneCount = 0,
  onZoom,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const zoomable = !!onZoom && (zoomed || canZoom);
  const toggleZoom = () => { if (zoomable) onZoom?.(zoomed ? null : nodeId); };

  const isDigest = kind === 'digest';
  const kindGlyph = kind === 'launcher' ? '+'
    : kind === 'files' ? '▱'
    : kind === 'review' ? '±'
    : kind === 'file' ? '◇'
    : kind === 'diff' ? '±'
    : kind === 'terminal' ? '>_'
    : kind === 'browser' ? '◎'
    : null;
  const dotColor = isDigest
    ? 'var(--term-digest)'
    : kind === 'file' || kind === 'files' || kind === 'browser' || kind === 'launcher'
      ? 'var(--term-accent)'
      : kind === 'diff' || kind === 'review' || kind === 'terminal'
        ? 'var(--term-digest)'
      : dotColorFor(streaming, error, focused);

  // Entrance animation for the Dot when the pane is newly opened in background.
  // isNew overrides to accent color with a one-shot spring scale animation.
  const dotStyle: React.CSSProperties = isNew && !isDigest
    && kind !== 'file' && kind !== 'files' && kind !== 'browser' && kind !== 'launcher'
    && kind !== 'diff' && kind !== 'review' && kind !== 'terminal'
    ? { animation: 'pane-entrance-dot var(--t-slow) cubic-bezier(.34, 1.56, .64, 1) forwards' }
    : {};

  const titleColor = focused ? 'var(--term-fg)' : 'var(--term-mid)';
  const titleWeight = focused ? 600 : 400;

  return (
    <>
      <div
        aria-label={`${title} pane${temporary ? ', temporary chat' : ''}${focused ? ', focused' : ''}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(PANE_DRAG_MIME, nodeId);
          e.dataTransfer.setData('text/plain', nodeId);
        }}
        onClick={() => onFocus(nodeId)}
        // Double-clicking a title bar maximizes, as on a desktop window.
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          toggleZoom();
        }}
        data-context-target=""
        data-pane-zoomed={zoomed || undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 28,
          maxWidth: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          padding: '0 11px',
          border: hovered
            ? '1px solid var(--term-line)'
            : '1px solid transparent',
          borderRadius: 0,
          fontFamily: 'var(--ui-font)',
          fontSize: 'var(--fs-lg)',
          color: titleColor,
          background: hovered ? 'var(--term-hover-bg, var(--term-alt))' : 'transparent',
          userSelect: 'none',
          cursor: 'pointer',
          WebkitAppRegion: 'no-drag',
          transition: 'background var(--t-quick) var(--t-ease)',
        } as React.CSSProperties}
      >
        <Dot color={dotColor} size={6} pulse={streaming && !isDigest} extraStyle={dotStyle} />
        {kindGlyph ? (
          <span aria-hidden style={{ color: dotColor, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', fontWeight: 700, flexShrink: 0 }}>{kindGlyph}</span>
        ) : null}
        {isDigest && (
          <span
            aria-hidden
            style={{
              color: 'var(--term-digest)',
              fontWeight: 700,
              fontSize: 'var(--fs-lg)',
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            §
          </span>
        )}
        {temporary && <TemporaryChatGlyph size={14} />}
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: titleWeight,
          }}
          title={title}
        >
          {title}
        </span>
        {kind === 'chat' && backgroundWork && (
          <BackgroundWorkBadge nodeId={nodeId} counts={backgroundWork} />
        )}
        {isDigest && (
          <span
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-2xs)',
              padding: '1px 5px',
              border: '1px solid var(--term-digest)',
              color: 'var(--term-digest)',
              letterSpacing: 'var(--ls-caps-wide)',
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            DIGEST
          </span>
        )}
        {error && (
          <span
            aria-hidden
            style={{ color: 'var(--term-danger)', fontSize: 'var(--fs-sm)', flexShrink: 0 }}
          >
            ⚠
          </span>
        )}
        {zoomed && onZoom ? (
          <HoverTip label="Exit zoom" kbd={PANE_ZOOM_KEYS}>
            <button
              type="button"
              data-testid="pane-zoom-exit"
              aria-label={`Exit zoom, ${hiddenPaneCount} more ${hiddenPaneCount === 1 ? 'pane' : 'panes'}`}
              onClick={(e) => { e.stopPropagation(); onZoom(null); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="pane-caption-zoom-exit"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                height: CONTROL_SIZE,
                padding: '0 7px 0 5px',
                flexShrink: 0,
                borderRadius: 'var(--ui-radius-sm)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-xs)',
                lineHeight: 1,
                cursor: 'pointer',
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties}
            >
              <Minimize2 size={11} aria-hidden />
              {hiddenPaneCount > 0 && <span>+{hiddenPaneCount}</span>}
            </button>
          </HoverTip>
        ) : zoomable && (
          <HoverTip label="Zoom pane" kbd={PANE_ZOOM_KEYS} disabled={!hovered}>
            <button
              type="button"
              data-testid="pane-zoom"
              aria-label={`Zoom ${title}`}
              tabIndex={hovered ? 0 : -1}
              aria-hidden={!hovered}
              onClick={(e) => { e.stopPropagation(); onZoom?.(nodeId); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="pane-caption-icon"
              style={{
                width: CONTROL_SIZE,
                height: CONTROL_SIZE,
                marginRight: -4,
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                borderRadius: 'var(--ui-radius-sm)',
                cursor: 'pointer',
                opacity: hovered ? 1 : 0,
                pointerEvents: hovered ? 'auto' : 'none',
              }}
            >
              <Maximize2 size={12} aria-hidden />
            </button>
          </HoverTip>
        )}
        <button
          type="button"
          aria-label={`Close ${title}`}
          tabIndex={hovered ? 0 : -1}
          aria-hidden={!hovered}
          onClick={(e) => {
            e.stopPropagation();
            onClose(nodeId);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="pane-caption-icon"
          style={{
            width: CONTROL_SIZE,
            height: CONTROL_SIZE,
            marginRight: -6,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            borderRadius: 'var(--ui-radius-sm)',
            fontFamily: 'inherit',
            fontSize: 'var(--fs-xl)',
            lineHeight: 1,
            cursor: 'pointer',
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? 'auto' : 'none',
          }}
        >
          ×
        </button>
      </div>
      <AnimatePresence>{menu && (
        <ContextMenu
          key={menuOpenKey(menu)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          sections={[
            {
              items: [
                ...(onZoom ? [{
                  id: 'zoom',
                  label: zoomed ? 'Exit Zoom' : 'Zoom Pane',
                  keys: PANE_ZOOM_KEYS,
                  disabled: !zoomable,
                  run: toggleZoom,
                }] : []),
                { id: 'close', label: 'Close', keys: kbd('mod', 'W'), run: () => onClose(nodeId) },
                {
                  id: 'close-others',
                  label: 'Close Others',
                  keys: 'O',
                  disabled: !canCloseOthers,
                  run: () => onCloseOthers(nodeId),
                },
              ],
            },
          ]}
        />
      )}</AnimatePresence>
    </>
  );
}

/**
 * "◆ 3" after the title while the conversation has background work running,
 * amber "◆ 3 · needs you" while a run waits for an approval. Opens the
 * Background work drawer on this conversation; the click never reaches the
 * caption (no pane focus) and never starts a pane drag.
 */
function BackgroundWorkBadge({ nodeId, counts }: { nodeId: string; counts: RunningWorkCounts }) {
  const label = describeRunningWork(counts);
  const [hover, setHover] = useState(false);
  if (!label) return null;
  const total = counts.subagents + counts.workflows;
  const waiting = !!counts.waiting;
  return (
    <button
      type="button"
      data-testid="pane-background-work-badge"
      data-state={waiting ? 'waiting' : 'running'}
      aria-label={`${waiting ? 'Needs your approval. ' : ''}${label}. Show background work`}
      aria-haspopup="dialog"
      title={label}
      draggable={false}
      onClick={(e) => {
        e.stopPropagation();
        openBackgroundWork({ nodeId });
      }}
      onMouseDown={(e) => {
        // The caption is draggable (pane reorder): a cancelled mousedown
        // never starts that native drag, and leaves focus where it was.
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: CONTROL_SIZE,
        padding: '0 5px',
        flexShrink: 0,
        border: hover ? '1px solid var(--term-line)' : '1px solid transparent',
        borderRadius: 'var(--ui-radius-sm)',
        background: waiting ? 'var(--term-select-f)' : hover ? 'var(--term-alt2, var(--term-alt))' : 'transparent',
        color: waiting ? 'var(--term-select)' : hover ? 'var(--term-fg)' : 'var(--term-mid)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-xs)',
        lineHeight: 1,
        cursor: 'pointer',
        WebkitAppRegion: 'no-drag',
        transition: 'background var(--t-quick) var(--t-ease), color var(--t-quick) var(--t-ease), border-color var(--t-quick) var(--t-ease)',
      } as React.CSSProperties}
    >
      <span aria-hidden className={waiting ? undefined : 'agent-glyph-run'} style={{ color: waiting ? 'inherit' : 'var(--term-mauve)', fontSize: 'var(--fs-2xs)' }}>◆</span>
      <span>{waiting ? `${total} · needs you` : total}</span>
    </button>
  );
}
