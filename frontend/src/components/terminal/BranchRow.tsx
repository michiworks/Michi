import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { DUR, EASE } from '../../motion/tokens';
import { isFresh } from '../../motion/useFresh';
import { useChatNode, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import type { ProjectEdge } from '../../state/chatTypes';
import { usePrefs } from '../../state/prefs';
import { Row, RowKebab } from './primitives';
import { CardCaret, Chevron, CARD_FILL, CARD_FILL_SELECT, PinMark } from './ThreadRow';
import { rowGeom, rowPadding, pinMarkEndMargin } from './sidebarRowStyle';
import type { TreeNode } from '../../state/tree';
import { branchSubtreeHasUnread, isNodeUnread, type OpenState } from '../../state/sidebarSelectors';
import { BRANCH_TITLE_CHARS } from '../../state/branchAnchors';
import { UnreadDot, UNREAD_DOT_LEAD, UNREAD_TITLE_WEIGHT, type UnreadMark } from './UnreadDot';
import { SidebarOpenRail } from './RailAfterglow';
import { relativeTime } from '../../lib/relativeTime';
import { useNewPanePulse } from './useNewPanePulse';
import { useTreePrefetchIntent } from '../../state/treePrefetch';
import { InlineRenameInput } from '../ui/InlineRenameInput';
import { isBranchEdge } from '../../state/tree';
import { PROVISIONAL_LABEL_STYLE, rowLabel } from './sidebar/rowLabel';
import { rowKeyDown } from './sidebar/rowKeyboard';

interface Props {
  /** This branch node and its descendants. */
  node: TreeNode;
  /** 1 = direct child of a thread. 2/3+ for deeper levels. */
  depth: number;
  /** Whether this branch is currently expanded in the UI. */
  expanded: boolean;
  /** Per-node lookup: is this node the focused/open node in the dashboard? */
  isFocused: (nodeId: string) => boolean;
  /** Per-node lookup: is this node in the current multi-selection? */
  isSelected: (nodeId: string) => boolean;
  /** Resolves whether a deeper branch is expanded (called per child). */
  isExpanded: (nodeId: string) => boolean;
  /** Per-node lookup: is this node the current target of the open context
   *  menu? Used to pin the hover kebab visible while the parent-rendered
   *  menu is showing, since branch menu state lives upstream. */
  isMenuTarget?: (nodeId: string) => boolean;
  /** Click on chevron — toggles `expanded`. No-op when leaf. */
  onToggle: (nodeId: string) => void;
  /** Click on row body — `event` lets the handler branch on ⌘ / ⇧ modifiers. */
  onSelect: (nodeId: string, event: React.MouseEvent) => void;
  /** Right-click — open context menu at cursor. */
  onContextMenu: (nodeId: string, event: React.MouseEvent) => void;
  /** The current row's openState, already resolved by the caller. */
  openState: OpenState;
  /** Resolves openState for any descendant (called per child during recursion). */
  getOpenState: (nodeId: string) => OpenState;
  /** The nodeId currently in inline-rename mode (or null). */
  renamingNodeId?: string | null;
  /** Commit a node rename. */
  onRenameNode?: (nodeId: string, title: string) => void;
  /** Clear the renaming state. */
  onRenameEnd?: () => void;
  /** Extra left indent in px that the whole branch block inherits, card modes
   *  only. Structure view passes the workspace header's folder-glyph slot so
   *  branches keep stepping in from their thread, which itself sits under the
   *  workspace name. */
  baseIndent?: number;
}

/**
 * When each branch target was made, built once per edges array (a new array
 * whenever an edge is added), so a mounting row looks itself up instead of
 * scanning every edge. Freshness is judged at lookup time, never cached.
 */
const branchBirths = new WeakMap<readonly ProjectEdge[], Map<string, number>>();

function branchBornAt(edges: readonly ProjectEdge[] | undefined, nodeId: string): number | undefined {
  if (!edges) return undefined;
  let births = branchBirths.get(edges);
  if (!births) {
    births = new Map();
    for (const edge of edges) {
      if (!isBranchEdge(edge) || edge.createdAt === undefined) continue;
      births.set(edge.target, Math.max(births.get(edge.target) ?? 0, edge.createdAt));
    }
    branchBirths.set(edges, births);
  }
  return births.get(nodeId);
}

/**
 * Opens room for a new row: its height grows from 0 as it fades in. Only the
 * vertical axis clips while it grows, so the row's full-bleed fill and edge
 * indicator (negative side margins) stay visible. Settled rows render bare.
 */
function GrowIn({ active, grown, onGrown, children }: {
  active: boolean;
  grown: boolean;
  onGrown: () => void;
  children: React.ReactNode;
}) {
  if (!active) return <>{children}</>;
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      transition={{ duration: DUR.enter, ease: EASE.out }}
      onAnimationComplete={onGrown}
      style={grown ? undefined : { overflowX: 'visible', overflowY: 'clip' }}
    >
      {children}
    </motion.div>
  );
}

export default function BranchRow({
  node,
  depth,
  expanded,
  isFocused,
  isSelected,
  isExpanded,
  isMenuTarget,
  onToggle,
  onSelect,
  onContextMenu,
  openState,
  getOpenState,
  renamingNodeId,
  onRenameNode,
  onRenameEnd,
  baseIndent = 0,
}: Props) {
  const n = useChatNode(node.nodeId);
  const prefetchIntent = useTreePrefetchIntent(node.nodeId);
  const { prefs } = usePrefs();
  const newPanePulse = useNewPanePulse(node.nodeId);
  const hasChildren = node.children.length > 0;
  // With no title yet, an excerpt of the first message, styled as provisional,
  // cut at a branch row's 40 characters.
  const { text: title, provisional } = rowLabel(undefined, n, BRANCH_TITLE_CHARS);
  const nodeUpdatedAt = n?.lastAssistantAt ?? n?.messages[n.messages.length - 1]?.createdAt ?? 0;
  const focused = isFocused(node.nodeId);
  const selected = isSelected(node.nodeId);
  const menuOpen = !!isMenuTarget?.(node.nodeId);
  const { focusedNodeId, projects } = useChatProjects();
  const unread = !!n && isNodeUnread(n, focusedNodeId);
  // A collapsed branch hides its sub-branches, so an unread one below it shows
  // here as a ring. Expanded, each sub-branch shows its own dot.
  const hiddenUnreadSelector = useCallback(
    (nodes: Parameters<typeof branchSubtreeHasUnread>[1]) =>
      hasChildren && !expanded && branchSubtreeHasUnread(node.children, nodes, focusedNodeId),
    [hasChildren, expanded, node.children, focusedNodeId],
  );
  const hiddenUnread = useStructuralSelector(hiddenUnreadSelector);
  const unreadMark: UnreadMark = unread ? 'self' : hiddenUnread ? 'within' : 'none';
  // Decided once, on mount: a row a branch, fan-out or spawn just added grows
  // in under its parent. Hydrated rows, and rows shown by expanding a thread
  // (100+ times a day), render settled. Looked up in every workspace, so a
  // node whose state has not loaded yet still finds its edge.
  const [entrance] = useState(() => {
    const fresh = projects?.some((project) => isFresh(branchBornAt(project.edges, node.nodeId)));
    return fresh ? { rail: openState !== 'none' } : null;
  });
  const [grown, setGrown] = useState(false);
  const [washed, setWashed] = useState(false);
  const geom = rowGeom(prefs.sidebarRowStyle, prefs.sidebarInset);
  const cardPaddingLeft = rowPadding(geom, baseIndent + depth * geom.indentStep).paddingLeft;
  // The star ends the row and takes the caret's place, so it clears the ⋯.
  const pinTakesEnd = !!n?.pinnedAt && geom.isCard && !hasChildren && !prefs.showSidebarTimestamps && !selected;

  const renaming = renamingNodeId === node.nodeId;
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renaming) return;
    // Small delay so the input is mounted before focus
    requestAnimationFrame(() => {
      renameRef.current?.focus();
      renameRef.current?.select();
    });
  }, [renaming]);

  const openMenuAt = (clientX: number, clientY: number) => {
    // Reuse the upstream branch context menu handler. It only reads
    // clientX/Y + preventDefault, so a synthetic event-like is enough.
    onContextMenu(
      node.nodeId,
      { preventDefault: () => {}, clientX, clientY } as unknown as React.MouseEvent,
    );
  };

  // A click, or Enter/Space on the focused row (whose key event carries the
  // same modifier flags the selection reads).
  const activate = (e: React.MouseEvent | React.KeyboardEvent) => {
    // Capture focus state BEFORE selecting so the toggle decision
    // reflects the highlight state at click time, not after.
    const wasFocused = focused;
    onSelect(node.nodeId, e as React.MouseEvent);
    // ⌘/⇧+click are pure selection ops — don't toggle the branch open.
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (!hasChildren) return;
    // Unified expand rule (see WorkspaceRow):
    //   collapsed → expand; expanded + already highlighted → collapse;
    //   expanded + not highlighted → keep open (just highlight).
    if (!expanded) {
      onToggle(node.nodeId);
    } else if (wasFocused) {
      onToggle(node.nodeId);
    }
  };

  return (
    <>
      <GrowIn active={!!entrance} grown={grown} onGrown={() => setGrown(true)}>
      <Row
        {...prefetchIntent}
        data-context-target=""
        data-sidebar-row={node.nodeId}
        // A button to the keyboard: Tab reaches it, Enter/Space opens it (sidebar/rowKeyboard).
        role="button"
        tabIndex={0}
        className="t-row-focus"
        // Its title, not the ⋯ inside it.
        aria-label={title}
        aria-current={focused ? 'true' : undefined}
        aria-expanded={hasChildren ? expanded : undefined}
        active={focused || selected}
        onClick={(e) => {
          if (renaming) return;
          activate(e);
        }}
        onKeyDown={(e) => {
          if (renaming) return;
          rowKeyDown(e, {
            activate: () => activate(e),
            expanded: hasChildren ? expanded : undefined,
            toggle: hasChildren ? () => onToggle(node.nodeId) : undefined,
            openMenu: (anchor) => openMenuAt(anchor.x, anchor.y),
          });
        }}
        onContextMenu={(e) => onContextMenu(node.nodeId, e)}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 'var(--sb-row-py, 4px)',
          // Classic: +--sb-inset on both sides indents the text while the
          // full-bleed row box (negative margin cancels the container inset)
          // keeps the borderLeft indicator + streaming bar flush to the sidebar
          // edge. See index.css.
          //
          // Card modes reuse rowPadding with a per-depth indent, which means the
          // row BOX is identical to a thread row's — only the text steps in. A
          // selected branch therefore fills the full row width instead of
          // showing an inset notch.
          paddingRight: geom.isCard
            ? rowPadding(geom).paddingRight
            : 'calc(10px + var(--sb-inset, 0px))',
          paddingBottom: 'var(--sb-row-py, 4px)',
          paddingLeft: geom.isCard
            ? cardPaddingLeft
            : `calc(${8 + depth * 10}px + var(--sb-inset, 0px))`,
          // Translucent in card modes so a selected branch keeps the sidebar's
          // glass — see CARD_FILL in ThreadRow.
          background: selected
            ? (geom.isCard ? CARD_FILL_SELECT : 'var(--term-select-f)')
            : (focused || menuOpen)
              ? (geom.isCard ? CARD_FILL : 'var(--term-alt)')
              : undefined,
          ...(geom.isCard
            ? { borderRadius: 'var(--sb-radius, 0px)' }
            : {
                borderLeft: selected
                  ? '2px solid var(--term-select)'
                  : focused ? '2px solid var(--term-accent)'
                  : '2px solid transparent',
              }),
          // Same as ThreadRow: focus/selection changes colour and fill, not
          // weight. Only an unread branch changes weight, alongside its dot.
          color: focused || selected || menuOpen || unread ? 'var(--term-fg)' : 'var(--term-mid)',
          fontWeight: unread ? UNREAD_TITLE_WEIGHT : 450,
          fontSize: 'var(--sb-fs, var(--fs-xl))',
          fontFamily: 'var(--ui-font)',
        }}
      >
        {entrance && !washed && (
          // The new row's accent wash: 14% over whatever fill the row has, fading out.
          <motion.span
            aria-hidden
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={{ duration: DUR.slow, delay: 0.08, ease: 'easeOut' }}
            onAnimationComplete={() => setWashed(true)}
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 'inherit',
              background: 'color-mix(in srgb, var(--term-accent) 14%, transparent)',
              pointerEvents: 'none',
            }}
          />
        )}
        {geom.chevronLeading && (
          <Chevron
            expanded={expanded}
            visible={hasChildren}
            onClick={(e) => {
              if (!hasChildren) return;
              e.stopPropagation();
              onToggle(node.nodeId);
            }}
          />
        )}
        {/* In the gutter just left of where the row's content starts: before the
            title in card modes, before the chevron in classic. Kept mid-row
            so the entrance wash stays the first child and the rail the last. */}
        <UnreadDot
          mark={unreadMark}
          left={geom.isCard
            ? `calc(${cardPaddingLeft} - ${UNREAD_DOT_LEAD}px)`
            : `calc(${1 + depth * 10}px + var(--sb-inset, 0px))`}
        />
        {renaming ? (
          <InlineRenameInput
            ref={renameRef}
            value={title}
            onCommit={(name) => onRenameNode?.(node.nodeId, name)}
            onEnd={() => onRenameEnd?.()}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '1px 4px',
              fontSize: 'var(--fs-xl)',
              fontFamily: 'var(--ui-font)',
              // Matches the row title so entering rename doesn't change weight.
              fontWeight: 450,
              background: 'var(--term-surface)',
              border: '1px solid var(--term-accent)',
              borderRadius: 'var(--ui-radius-sm)',
              color: 'var(--term-fg)',
              outline: 'none',
            }}
          />
        ) : (
          <span
            style={{
              flex: 1,
              // Card modes only: lets the title shrink past its content so the
              // trailing marks/caret can't push the row wider. Classic is left
              // exactly as it was.
              ...(geom.isCard ? { minWidth: 0 } : {}),
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              maskImage: `linear-gradient(to right, black calc(100% - ${geom.isCard ? 26 : 14}px), transparent)`,
              WebkitMaskImage: `linear-gradient(to right, black calc(100% - ${geom.isCard ? 26 : 14}px), transparent)`,
              ...(provisional ? PROVISIONAL_LABEL_STYLE : {}),
            }}
            data-provisional={provisional || undefined}
          >
            {title}
          </span>
        )}
        {/* After the title, so it can't push the title off its indent; see PinMark. */}
        {!!n?.pinnedAt && (
          <PinMark endMargin={pinTakesEnd ? pinMarkEndMargin(geom, 6) : undefined} />
        )}
        {geom.isCard && hasChildren && (
          <CardCaret expanded={expanded} geom={geom} onToggle={() => onToggle(node.nodeId)} />
        )}
        {prefs.showSidebarTimestamps && nodeUpdatedAt > 0 && (
          <span style={{ color: 'var(--term-muted)', fontSize: 'var(--sb-ts-fs, var(--fs-sm))', flexShrink: 0 }}>
            {relativeTime(nodeUpdatedAt)}
          </span>
        )}
        {selected && (
          <span style={{ color: 'var(--term-select)', fontSize: 'var(--fs-sm)', fontWeight: 700 }}>
            ✓
          </span>
        )}
        <RowKebab
          open={menuOpen}
          onOpen={(p) => openMenuAt(p.x, p.y)}
          ariaLabel={`Actions for ${title}`}
        />
        {/* A new row's rail draws down from the top once it has room to. */}
        <SidebarOpenRail
          state={openState}
          isCard={geom.isCard}
          pulseOnce={newPanePulse}
          drawIn={!!entrance?.rail && !washed}
        />
      </Row>
      </GrowIn>
      {hasChildren && expanded &&
        node.children.map((child) => (
          <BranchRow
            key={child.nodeId}
            node={child}
            depth={depth + 1}
            expanded={isExpanded(child.nodeId)}
            isFocused={isFocused}
            isSelected={isSelected}
            isExpanded={isExpanded}
            isMenuTarget={isMenuTarget}
            onToggle={onToggle}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            openState={getOpenState(child.nodeId)}
            getOpenState={getOpenState}
            renamingNodeId={renamingNodeId}
            onRenameNode={onRenameNode}
            onRenameEnd={onRenameEnd}
            baseIndent={baseIndent}
          />
        ))}
    </>
  );
}
