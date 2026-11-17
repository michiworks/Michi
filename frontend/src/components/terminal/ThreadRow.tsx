import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useChatActions, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import { Row, RowKebab } from './primitives';
import ContextMenu, { MenuPresence, menuOpenKey } from '../ContextMenu';
import MoveThreadDialog from '../MoveThreadDialog';
import { buildThreadRowContextMenu } from '../../lib/threadRowContextMenu';
import type { ChatNodeState, ProjectEdge, Tree } from '../../state/chatTypes';
import type { MoveTargetWorkspace } from '../../state/moveTargets';
import type { OpenState } from '../../state/sidebarSelectors';
import { treeHasUnread, isNodeUnread, nodeAttention, subtreeAttention, type RowAttention } from '../../state/sidebarSelectors';
import { buildBranchChildrenOf } from '../../state/tree';
import { isVisibleConversationNode } from '../../state/conversationVisibility';
import { rowGeom, rowPadding, caretKebabClearance, CARD_FILL, CARD_FILL_SELECT, type RowGeom } from './sidebarRowStyle';
import { UnreadDot, UNREAD_TITLE_WEIGHT, type UnreadMark } from './UnreadDot';
import { SidebarOpenRail } from './RailAfterglow';
import { RowAttentionChip, attentionLabel } from './RowAttentionChip';
import { useNewPanePulse } from './useNewPanePulse';
import { useTreePrefetchIntent } from '../../state/treePrefetch';
import { exportPanelEvent } from '../../state/appEvents';
import { InlineRenameInput } from '../ui/InlineRenameInput';
import { formatMichiAge } from './content/michiFormat';
import { PROVISIONAL_LABEL_STYLE, rowLabel } from './sidebar/rowLabel';
import { rowKeyDown } from './sidebar/rowKeyboard';
import { TemporaryChatGlyph } from './TemporaryChat';
import { CheckIcon, FolderIcon, StarIcon } from './icons';

const EMPTY_EDGES: readonly ProjectEdge[] = [];

// Card-mode row fills live with the row geometry (sidebarRowStyle); re-exported for the rows that take them from here.
export { CARD_FILL, CARD_FILL_SELECT } from './sidebarRowStyle';

/** How far left of a card row's text the pin star's left edge sits: the 9px
 *  star and 3px of air. */
export const PIN_MARK_LEAD = 12;

/** Small star glyph marking a pinned row. Shared by ThreadRow (tree pin),
 *  BranchRow (node pin) and WorkspaceRow so every level reads identically.
 *  Card rows hang it in the gutter left of the text (`gutterLeft`, its left
 *  edge), where it takes no room from the title and stays put whatever the
 *  row's end shows. Classic rows, which have no gutter, and the workspace name
 *  put it after the text. Never in the flow in front of the text: there its
 *  15px pushed a pinned thread's title past its own branches' 12px indent, so a
 *  pinned thread read as a level deeper. */
export function PinMark({ gutterLeft }: { gutterLeft?: string | number }) {
  return (
    <StarIcon
      aria-label="pinned"
      size={9}
      fill="currentColor"
      style={{
        color: 'var(--term-select)',
        flexShrink: 0,
        ...(gutterLeft === undefined
          ? {}
          : { position: 'absolute', left: gutterLeft, top: '50%', transform: 'translateY(-50%)' }),
      }}
    />
  );
}

/** Equality for a row's structural selector, whose result is a flat object of primitives. */
export function sameRowFields<T extends object>(a: T, b: T): boolean {
  return (Object.keys(a) as Array<keyof T>).every((key) => Object.is(a[key], b[key]));
}

interface Actions {
  activateTree: (treeId: string) => void;
  archiveTree: (treeId: string) => void;
  unarchiveTree: (treeId: string) => void;
  pinTree: (treeId: string) => void;
  unpinTree: (treeId: string) => void;
  renameTree: (treeId: string, name: string) => void;
  deleteTree: (treeId: string) => void;
  /** Optional — wire only when there are other live workspaces to move to. */
  moveTreeToWorkspace?: (treeId: string, targetProjectId: string) => void;
}

interface Props {
  tree: Tree;
  projectId: string;
  isActive: boolean;
  hasBranches: boolean;
  /** Whether the thread's branches are currently shown. */
  expanded: boolean;
  /** Click on the row body — activates the thread (does not toggle).
   *  Receives the click event so the parent can inspect modifiers. */
  onActivate: (e?: React.MouseEvent) => void;
  /** Click on the chevron — toggles expand (does not activate). */
  onToggleExpand: () => void;
  actions: Actions;
  /** Subtree open-state. The bar is painted only when the row is collapsed. */
  openState?: OpenState;
  /** Other live workspaces this thread can be moved to. When empty/omitted,
   *  the "Move to workspace" section is hidden in the context menu. */
  moveTargets?: readonly MoveTargetWorkspace[];
  /** Extra left indent in px, folded into the row's own paddingLeft so the box
   *  (and its edge indicators) stay where they belong. Structure view passes a
   *  step so a workspace's threads sit in from the workspace name. */
  indent?: number;
  /** Workspace name shown as a second line INSIDE the row, card modes only.
   *  Activity view passes it (its threads span workspaces); Structure view
   *  omits it because the workspace group header already says it. */
  subtitle?: string;
}

export default function ThreadRow({
  tree,
  projectId,
  isActive,
  hasBranches,
  expanded,
  onActivate,
  onToggleExpand,
  actions,
  openState = 'none',
  moveTargets,
  indent = 0,
  subtitle,
}: Props) {
  const { treeSelection, focusedNodeId, projects } = useChatProjects();
  const { clearTreeSelection } = useChatActions();
  const { prefs } = usePrefs();
  const selected = treeSelection.has(tree.id);
  const prefetchIntent = useTreePrefetchIntent(tree.rootNodeId);
  const projectEdges = projects.find((p) => p.id === projectId)?.edges ?? EMPTY_EDGES;
  const branchChildrenOf = useMemo(
    () => buildBranchChildrenOf(projectEdges),
    [projectEdges],
  );
  const rootNodeId = tree.rootNodeId;
  const unreadSelector = useCallback(
    (nodes: Parameters<typeof treeHasUnread>[2]) =>
      treeHasUnread({ rootNodeId }, projectEdges, nodes, focusedNodeId, branchChildrenOf),
    [rootNodeId, projectEdges, focusedNodeId, branchChildrenOf],
  );
  const treeUnread = useStructuralSelector(unreadSelector);
  // What this thread needs from the user (R2): its root's own state while it is
  // expanded (each branch then speaks for itself), the strongest in its subtree
  // while it is collapsed — the rule its unread dot follows.
  const attentionSelector = useCallback(
    (nodes: Record<string, ChatNodeState>): RowAttention => {
      const now = Date.now();
      const perNode = (id: string) => nodeAttention(id, nodes[id], focusedNodeId, now);
      return expanded
        ? perNode(rootNodeId)
        : subtreeAttention(
            rootNodeId,
            projectEdges,
            (id) => !nodes[id]?.deletedAt && isVisibleConversationNode(nodes[id]),
            perNode,
            branchChildrenOf,
          );
    },
    [rootNodeId, projectEdges, focusedNodeId, branchChildrenOf, expanded],
  );
  const attention = useStructuralSelector(attentionSelector);
  const treeName = tree.name;
  // What the row shows of its root, as primitives: a streamed chunk replaces
  // the node but leaves these fields and the structure version alone, so it
  // re-renders no row.
  const rootSelector = useCallback((nodes: Record<string, ChatNodeState>) => {
    const root = nodes[rootNodeId];
    // With no title yet, an excerpt of the first message, styled as provisional.
    // It never fills the root's title, so the main response can still provide
    // the first durable title while the user sees a useful sidebar label.
    const { text, provisional } = rowLabel(treeName, root);
    return {
      label: text,
      provisional,
      // The root itself vs. something in its tree: the root gets the solid dot and
      // a brighter title; a collapsed thread hiding an unread branch gets the ring.
      ownUnread: !!root && isVisibleConversationNode(root) && isNodeUnread(root, focusedNodeId),
      temporary: root?.temporary === true,
    };
  }, [rootNodeId, treeName, focusedNodeId]);
  const { label, provisional, ownUnread, temporary } = useStructuralSelector(rootSelector, sameRowFields);
  const unreadMark: UnreadMark = ownUnread
    ? 'self'
    : treeUnread && hasBranches && !expanded ? 'within' : 'none';
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const geom = rowGeom(prefs.sidebarRowStyle);
  // The current row keeps its ⋯ showing; its right padding keeps its title and
  // workspace lines from running under it. (A caret, when there is one,
  // already keeps that room.)
  const paddingClearsKebab = geom.isCard && isActive && !!subtitle && !hasBranches;
  const newPanePulse = useNewPanePulse(tree.rootNodeId);
  // Same rule in every mode: the rail is a SUMMARY for a collapsed subtree, so
  // it's suppressed once the row is expanded and each branch speaks for itself.
  const showIdleMark = !expanded && openState === 'idle';

  useEffect(() => {
    if (!renaming) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [renaming]);

  const beginRename = () => setRenaming(true);

  const exportTree = () =>
    exportPanelEvent.dispatch({ projectId, treeId: tree.id });

  const sections = menu
    ? buildThreadRowContextMenu({
        treeId: tree.id,
        tree,
        moveTargets,
        treeSelection,
        clearTreeSelection,
        actions: {
          activateTree: actions.activateTree,
          archiveTree: actions.archiveTree,
          unarchiveTree: actions.unarchiveTree,
          pinTree: actions.pinTree,
          unpinTree: actions.unpinTree,
          renameTree: actions.renameTree,
          deleteTree: actions.deleteTree,
          exportTree,
          beginInlineRename: beginRename,
          moveToWorkspace: actions.moveTreeToWorkspace
            ? (targetProjectId: string) =>
                actions.moveTreeToWorkspace!(tree.id, targetProjectId)
            : undefined,
          openMoveDialog: actions.moveTreeToWorkspace
            ? () => setMoveOpen(true)
            : undefined,
        },
      })
    : [];

  return (
    <>
      <Row
        {...prefetchIntent}
        data-sidebar-row={tree.rootNodeId}
        data-context-target=""
        // A button to the keyboard: Tab reaches it, Enter/Space opens it (sidebar/rowKeyboard).
        role="button"
        tabIndex={0}
        className="t-row-focus"
        // Its title (and workspace), not the ⋯ inside it.
        aria-label={attentionLabel([label, subtitle, temporary && 'temporary chat'], attention)}
        aria-current={isActive ? 'true' : undefined}
        aria-expanded={hasBranches ? expanded : undefined}
        active={isActive || selected}
        onClick={(e) => {
          if (renaming) return;
          onActivate(e);
        }}
        onKeyDown={(e) => {
          if (renaming) return;
          rowKeyDown(e, {
            activate: () => onActivate(),
            expanded: hasBranches ? expanded : undefined,
            toggle: hasBranches ? onToggleExpand : undefined,
            openMenu: (anchor) => setMenu(anchor),
          });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{
          // Flex in both modes. Card modes put the two text lines in a column
          // child and hang the caret off the Row itself, so the caret (and the
          // absolutely-positioned kebab) centre across BOTH lines instead of
          // riding the first one.
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          // Classic: horizontal padding folds in --sb-inset so the label indents
          // from the sidebar edge while the row box stays full-bleed (its negative
          // margin cancels the tree container's inset padding) — keeping the
          // borderLeft selection indicator and the streaming bar flush to the
          // true edge. Card modes take their padding from rowGeom instead, which
          // resolves the title onto a fixed absolute spine.
          ...(geom.isCard
            ? {
                paddingTop: 'var(--sb-row-py, 4px)',
                paddingBottom: 'calc(var(--sb-row-py, 4px) + 1px)',
                paddingLeft: rowPadding(geom, indent).paddingLeft,
                paddingRight: paddingClearsKebab
                  ? `calc(${rowPadding(geom, indent).paddingRight} + ${caretKebabClearance(geom)}px)`
                  : rowPadding(geom, indent).paddingRight,
              }
            : {
                padding: 'var(--sb-row-py, 4px) calc(10px + var(--sb-inset, 0px)) var(--sb-row-py, 4px) calc(8px + var(--sb-inset, 0px))',
              }),
          // Card modes keep the fill PARTIALLY TRANSPARENT. A solid --term-alt
          // punches an opaque hole through the sidebar's glass / vibrancy
          // material, so the selected row stops frosting and reads as a pasted-on
          // block. color-mix against `transparent` keeps the blur underneath.
          background: selected
            ? (geom.isCard ? CARD_FILL_SELECT : 'var(--term-select-f)')
            : (isActive || menu)
              ? (geom.isCard ? CARD_FILL : 'var(--term-alt)')
              : 'transparent',
          // Card modes carry selection with the fill alone — no edge bar.
          ...(geom.isCard
            ? {}
            : {
                borderLeft: selected
                  ? '2px solid var(--term-select)'
                  : isActive ? '2px solid var(--term-accent)'
                  : '2px solid transparent',
              }),
          // Shared with classic. Focus/selection is carried by colour (mid → fg)
          // and the fill, never by weight: the title keeps 450 in every state so
          // it doesn't widen and re-truncate as the selection moves. Only an
          // unread root changes weight, alongside its dot (see UnreadDot).
          color: isActive || selected || menu || ownUnread ? 'var(--term-fg)' : 'var(--term-mid)',
          fontWeight: ownUnread ? UNREAD_TITLE_WEIGHT : 450,
          fontSize: 'var(--sb-fs, var(--fs-xl))',
          fontFamily: 'var(--ui-font)',
          position: 'relative',
        }}
      >
        {/* Text column (card modes) / transparent passthrough (classic). */}
        <div style={geom.isCard ? { flex: 1, minWidth: 0 } : { display: 'contents' }}>
        <div
          style={
            geom.isCard
              ? { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, position: 'relative' }
              : { display: 'contents' }
          }
        >
        {/* Card modes: the star hangs in the gutter just left of the title,
            anchored to this title line so it centres on it; unread is the
            rail's (SidebarOpenRail). Classic: the line is display:contents, so
            the dot anchors to the Row and lands in its left padding, before
            the chevron. */}
        {geom.isCard
          ? !!tree.pinnedAt && <PinMark gutterLeft={-PIN_MARK_LEAD} />
          : <UnreadDot mark={unreadMark} left="calc(1px + var(--sb-inset, 0px))" />}
        {geom.chevronLeading && (
          <Chevron
            expanded={expanded}
            visible={hasBranches}
            onClick={(e) => {
              e.stopPropagation();
              if (hasBranches) onToggleExpand();
            }}
          />
        )}
        {renaming ? (
          <InlineRenameInput
            ref={renameRef}
            aria-label="Thread name"
            value={label}
            onCommit={(name) => actions.renameTree(tree.id, name)}
            onEnd={() => setRenaming(false)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 'var(--fs-xl)',
              // Matches the row title so entering rename doesn't change weight.
              fontWeight: 450,
              color: 'var(--term-fg)',
              fontFamily: 'var(--ui-font)',
              background: 'var(--term-surface)',
              // Mounted only while it holds focus: the accent border is its focus cue.
              border: '1px solid var(--term-accent)',
              outline: 'none',
              padding: '1px 4px',
            }}
          />
        ) : (<>
          {temporary && <TemporaryChatGlyph />}
          <span
            data-provisional={provisional || undefined}
            style={{
              flex: 1,
              // Card modes only — see BranchRow. Classic keeps its original box.
              ...(geom.isCard ? { minWidth: 0 } : {}),
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              maskImage: `linear-gradient(to right, black calc(100% - ${geom.isCard ? 28 : 14}px), transparent)`,
              WebkitMaskImage: `linear-gradient(to right, black calc(100% - ${geom.isCard ? 28 : 14}px), transparent)`,
              ...(provisional ? PROVISIONAL_LABEL_STYLE : {}),
            }}
          >
            {label}
          </span>
        </>)}
        <RowAttentionChip attention={attention} />
        {!geom.isCard && !!tree.pinnedAt && <PinMark />}
        {prefs.showSidebarTimestamps && (
          <span style={{ color: 'var(--term-muted)', fontSize: 'var(--sb-ts-fs, var(--fs-sm))', marginRight: 2 }}>
            {formatMichiAge(tree.lastActiveAt)}
          </span>
        )}
        {selected && (
          <CheckIcon size="sm" style={{ color: 'var(--term-select)', flexShrink: 0 }} />
        )}
        </div>
        {geom.isCard && geom.subtitleInRow && subtitle && (
          <div
            data-row-workspace=""
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 2,
              fontSize: 'var(--sb-ts-fs, var(--fs-md))',
              color: 'var(--term-muted)',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            }}
          >
            <SubtitleFolder />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                maskImage: 'linear-gradient(to right, black calc(100% - 28px), transparent)',
                WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 28px), transparent)',
              }}
            >
              {subtitle}
            </span>
          </div>
        )}
        </div>
        {/* Card modes move the expand affordance to the row end. With no branch
            count shown, this caret is the ONLY hint that a thread has branches,
            so it stays visible rather than appearing on hover.

            It sits OUTSIDE the text column — a sibling of it under the Row's
            `align-items: center` — so on a two-line card it centres across both
            lines, matching the absolutely-positioned kebab. Inside the first
            line it was centred on that line alone and read as misaligned.

            The right margin clears the kebab — see caretKebabClearance, which
            derives it per mode from that mode's own right padding. */}
        {geom.isCard && hasBranches && (
          <CardCaret expanded={expanded} geom={geom} onToggle={onToggleExpand} />
        )}
        <RowKebab
          open={!!menu}
          onOpen={(p) => setMenu((open) => (open ? null : { x: p.x, y: p.y }))}
          ariaLabel={`Actions for ${label}`}
        />
        <SidebarOpenRail
          state={openState === 'streaming' || showIdleMark ? openState : 'none'}
          isCard={geom.isCard}
          pulseOnce={newPanePulse}
          unread={geom.isCard ? unreadMark : 'none'}
          waiting={attention === 'waiting'}
        />
      </Row>
      <MenuPresence>
        {menu && (
          <ContextMenu
            key={menuOpenKey(menu)}
            x={menu.x}
            y={menu.y}
            sections={sections}
            onClose={() => setMenu(null)}
          />
        )}
      </MenuPresence>
      <MoveThreadDialog
        open={moveOpen}
        threadLabel={label}
        targets={moveTargets ?? []}
        onClose={() => setMoveOpen(false)}
        onPick={(targetProjectId) => {
          actions.moveTreeToWorkspace?.(tree.id, targetProjectId);
        }}
      />
    </>
  );
}

/** Small folder glyph that anchors the workspace-name subtitle in card modes,
 *  so the second line reads as metadata rather than another list item. */
export function SubtitleFolder() {
  return <FolderIcon size="sm" style={{ flexShrink: 0, opacity: 0.8 }} />;
}

/**
 * A card-mode row's expand caret, in thread and branch rows: its own column at
 * the row end, `--sb-caret-w` square (24px with a mouse, 40px on touch,
 * sidebar.css), so a hit on it only folds the card and the title ends before
 * it (ST-21). A hit anywhere else on the row opens it. A finger on it presses
 * the column alone (sidebar.css), never the row or its long press (ST-36).
 */
export function CardCaret({ expanded, geom, onToggle }: { expanded: boolean; geom: RowGeom; onToggle: () => void }) {
  return (
    <span
      aria-hidden
      data-card-caret=""
      data-own-press=""
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 'var(--sb-caret-w, 24px)',
        height: 'var(--sb-caret-w, 24px)',
        // Into the row's vertical padding, so the column leaves the row's height alone.
        marginBlock: 'calc(-1 * var(--sb-row-py, 4px))',
        // Keeps clear of the hover-revealed ⋯ — see caretKebabClearance.
        marginRight: caretKebabClearance(geom),
        // The phone drawer draws a larger, brighter › (mobile.css).
        fontSize: 'var(--sb-caret-fs, var(--fs-xs))',
        color: 'var(--sb-caret-color, var(--term-muted))',
        cursor: 'pointer',
      }}
    >
      {/* Expanded turns the same › a quarter turn, as the classic leading
          Chevron does, rather than drawing ⌄, whose glyph sits below the
          line's centre and so below the ⋯. Only the glyph turns: the column
          keeps its box. */}
      <span
        style={{
          display: 'inline-block',
          transform: expanded ? 'rotate(90deg)' : undefined,
          transition: 'transform var(--t-soft) var(--t-ease, ease-out)',
        }}
      >
        ›
      </span>
    </span>
  );
}

/** Single-style chevron used across sidebar tree rows. Always gray, rotates
 *  90° when expanded. `visible=false` keeps the box but hides the glyph so
 *  rows align. */
export function Chevron({
  expanded,
  visible,
  onClick,
}: {
  expanded: boolean;
  visible: boolean;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <span
      // A 24px hit area round a glyph shown (sidebar.css).
      className={visible ? 't-caret-hit' : undefined}
      onClick={onClick}
      style={{
        width: 12,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--ui-font)',
        fontSize: 'var(--fs-sm)',
        color: visible ? 'var(--term-muted)' : 'transparent',
        // Without a handler it takes its row's or its button's cursor.
        cursor: visible && onClick ? 'pointer' : undefined,
        userSelect: 'none',
        transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        transformOrigin: 'center',
        transition: 'transform var(--t-soft) var(--t-ease, ease-out)',
      }}
    >
      ›
    </span>
  );
}
