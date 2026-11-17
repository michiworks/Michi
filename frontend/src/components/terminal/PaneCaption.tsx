import React, { useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { Dot } from './primitives';
import ContextMenu, { menuOpenKey } from '../ContextMenu';
import { kbd } from '../../lib/platform';
import { describeRunningWork, type RunningWorkCounts } from '../../state/backgroundWork';
import { openBackgroundWork } from './backgroundWork/backgroundWorkEvents';
import { HoverTip } from '../ui/Popover';
import type { PaneItemKind } from '../../state/paneItems';
import { TemporaryChatGlyph } from './TemporaryChat';
import { AgentRunGlyph, CloseIcon, MaximizeIcon, WarningIcon } from './icons';
import PaneZoomExit, { type ZoomHiddenPane } from './PaneZoomExit';

const PANE_DRAG_MIME = 'application/x-michi-pane-id';
const PANE_ZOOM_KEYS = kbd('shift', 'mod', 'enter');
// The caption's controls share one height (the icon buttons are square), so
// boxes shown side by side line up: the exit control beside a hovered × or ◆.
const CONTROL_SIZE = 22;
const NO_HIDDEN_PANES: readonly ZoomHiddenPane[] = [];

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
  /** Panes the zoom hides, listed from the exit control. */
  hiddenPanes?: readonly ZoomHiddenPane[];
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
  hiddenPanes = NO_HIDDEN_PANES,
  onZoom,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const zoomable = !!onZoom && (zoomed || canZoom);
  const toggleZoom = () => { if (zoomable) onZoom?.(zoomed ? null : nodeId); };

  const isDigest = kind === 'digest';
  const kindGlyph = kind === 'launcher' ? '+'
    : kind === 'files' ? '▱'
    : kind === 'review' ? '±'
    : kind === 'file' ? '▤'
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
        data-focused={focused || undefined}
        // Hover and keyboard focus show the ⤢ and × (.t-reveal) and light the
        // caption, all in CSS (index.css .pane-caption): no render on hover.
        className="pane-caption t-reveal-host"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 28,
          maxWidth: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          padding: '0 11px',
          borderRadius: 0,
          fontFamily: 'var(--ui-font)',
          fontSize: 'var(--fs-lg)',
          userSelect: 'none',
          cursor: 'pointer',
          WebkitAppRegion: 'no-drag',
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
          <WarningIcon size="sm" data-testid="pane-caption-error" style={{ color: 'var(--term-danger)', flexShrink: 0 }} />
        )}
        {zoomed && onZoom ? (
          <PaneZoomExit
            hiddenPanes={hiddenPanes}
            shortcut={PANE_ZOOM_KEYS}
            onZoom={onZoom}
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
          />
        ) : zoomable && (
          <HoverTip label="Zoom pane" kbd={PANE_ZOOM_KEYS}>
            <button
              type="button"
              data-testid="pane-zoom"
              aria-label={`Zoom ${title}`}
              onClick={(e) => { e.stopPropagation(); onZoom?.(nodeId); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="pane-caption-icon t-reveal"
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
              }}
            >
              <MaximizeIcon />
            </button>
          </HoverTip>
        )}
        <button
          type="button"
          aria-label={`Close ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose(nodeId);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="pane-caption-icon t-reveal"
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
          }}
        >
          <CloseIcon />
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
      className="pane-caption-badge"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: CONTROL_SIZE,
        padding: '0 5px',
        flexShrink: 0,
        borderRadius: 'var(--ui-radius-sm)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-xs)',
        lineHeight: 1,
        cursor: 'pointer',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <AgentRunGlyph running={!waiting} style={{ color: waiting ? 'inherit' : 'var(--term-mauve)', flexShrink: 0 }} />
      <span>{waiting ? `${total} · needs you` : total}</span>
    </button>
  );
}
