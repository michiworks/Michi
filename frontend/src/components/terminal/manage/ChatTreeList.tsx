import React from 'react';
import { AnimatePresence } from 'motion/react';
import type { ChatNodeState, Project, Tree } from '../../../state/chatTypes';
import { deriveTreeRows, deriveArchivedTreeRows, firstUserSnippet, type TreeRow } from './derive';
import { relativeTime } from '../../../lib/relativeTime';
import ContextMenu, { menuOpenKey } from '../../ContextMenu';
import { buildThreadRowContextMenu } from '../../../lib/threadRowContextMenu';
import { HoverTip } from '../../ui/Popover';
import { BranchIcon, MoreIcon, StarIcon } from '../icons';
import ManageListEmpty from './ManageListEmpty';
import './manage.css';

export interface ChatTreeListMenuActions {
  activateTree: (id: string) => void;
  archiveTree: (id: string) => void;
  unarchiveTree: (id: string) => void;
  pinTree?: (id: string) => void;
  unpinTree?: (id: string) => void;
  renameTree: (id: string, name: string) => void;
  deleteTree: (id: string) => void;
  exportTree: (id: string) => void;
}

export interface BulkActions {
  treeSelection: ReadonlySet<string>;
  toggleTreeSelection: (treeId: string) => void;
  clearTreeSelection: () => void;
  selectAllTrees: () => void;
  bulkArchiveTrees: () => void;
  bulkDeleteTrees: () => void;
  bulkUnarchiveTrees: () => void;
}

interface Props {
  workspace: Project;
  nodes: Record<string, ChatNodeState>;
  filter: string;
  onClearFilter?: () => void;
  onOpen: (chatId: string) => void;
  menuActions?: ChatTreeListMenuActions;
  bulkActions?: BulkActions;
  manageMode?: boolean;
}

interface TreeGroup {
  treeId: string;
  title: string;
  lastActiveAt: number;
  pinned: boolean;
  root: Extract<TreeRow, { kind: 'root' }>;
  branches: Extract<TreeRow, { kind: 'branch' }>[];
  overflow: Extract<TreeRow, { kind: 'overflow' }> | null;
}

function rowsToGroups(rows: TreeRow[]): TreeGroup[] {
  const groups: TreeGroup[] = [];
  let current: TreeGroup | null = null;
  for (const row of rows) {
    if (row.kind === 'label') {
      // Label rows mark the start of a new tree but we'll attach data on root.
      continue;
    }
    if (row.kind === 'root') {
      current = {
        treeId: row.treeId,
        title: '',
        lastActiveAt: 0,
        pinned: row.pinned,
        root: row,
        branches: [],
        overflow: null,
      };
      groups.push(current);
    } else if (row.kind === 'branch' && current && current.treeId === row.treeId) {
      current.branches.push(row);
    } else if (row.kind === 'overflow' && current && current.treeId === row.treeId) {
      current.overflow = row;
    }
  }
  // Backfill title + lastActiveAt from the label row pass.
  for (const row of rows) {
    if (row.kind !== 'label') continue;
    const g = groups.find((x) => x.treeId === row.treeId);
    if (g) {
      g.title = row.title;
      g.lastActiveAt = row.lastActiveAt;
    }
  }
  return groups;
}

export default function ChatTreeList({
  workspace,
  nodes,
  filter,
  onClearFilter,
  onOpen,
  menuActions,
  bulkActions,
  manageMode = false,
}: Props) {
  const rows = React.useMemo(
    () => deriveTreeRows(workspace, nodes, filter),
    [workspace, nodes, filter],
  );
  const archivedRows = React.useMemo(
    () => deriveArchivedTreeRows(workspace, nodes, filter),
    [workspace, nodes, filter],
  );
  const groups = React.useMemo(() => rowsToGroups(rows), [rows]);
  const archivedGroups = React.useMemo(() => rowsToGroups(archivedRows), [archivedRows]);
  const pinned = groups.filter((g) => g.pinned);
  const rest = groups.filter((g) => !g.pinned);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [menu, setMenu] = React.useState<{ x: number; y: number; tree: Tree } | null>(null);
  const [archivedExpanded, setArchivedExpanded] = React.useState(false);
  const archivedListId = React.useId();
  const lastClickedRef = React.useRef<string | null>(null);

  const treeById = React.useMemo(() => {
    const m = new Map<string, Tree>();
    for (const t of workspace.trees) m.set(t.id, t);
    return m;
  }, [workspace.trees]);

  const allVisibleTreeIds = React.useMemo(() => {
    const ids: string[] = [];
    for (const g of groups) ids.push(g.treeId);
    if (archivedExpanded) {
      for (const g of archivedGroups) ids.push(g.treeId);
    }
    return ids;
  }, [groups, archivedGroups, archivedExpanded]);

  const handleTreeCheck = React.useCallback((treeId: string, shiftKey: boolean) => {
    if (!bulkActions || !manageMode) return;
    if (shiftKey && lastClickedRef.current) {
      const startIdx = allVisibleTreeIds.indexOf(lastClickedRef.current);
      const endIdx = allVisibleTreeIds.indexOf(treeId);
      if (startIdx >= 0 && endIdx >= 0) {
        const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        for (let i = lo; i <= hi; i++) {
          if (!bulkActions.treeSelection.has(allVisibleTreeIds[i])) {
            bulkActions.toggleTreeSelection(allVisibleTreeIds[i]);
          }
        }
      }
    } else {
      bulkActions.toggleTreeSelection(treeId);
    }
    lastClickedRef.current = treeId;
  }, [bulkActions, manageMode, allVisibleTreeIds]);

  const openMenuForTree = (tree: Tree | undefined, x: number, y: number) => {
    if (!tree || !menuActions) return;
    setMenu({ x, y, tree });
  };

  const closeMenu = () => setMenu(null);

  const menuSections = menu && menuActions
    ? buildThreadRowContextMenu({
        treeId: menu.tree.id,
        tree: menu.tree,
        treeSelection: bulkActions?.treeSelection,
        clearTreeSelection: bulkActions?.clearTreeSelection,
        actions: {
          activateTree: menuActions.activateTree,
          archiveTree: menuActions.archiveTree,
          unarchiveTree: menuActions.unarchiveTree,
          pinTree: menuActions.pinTree,
          unpinTree: menuActions.unpinTree,
          renameTree: menuActions.renameTree,
          deleteTree: menuActions.deleteTree,
          exportTree: menuActions.exportTree,
        },
      })
    : [];

  if (groups.length === 0 && archivedGroups.length === 0) {
    return <ManageListEmpty query={filter.trim()} empty="no chats yet — start one above" onClearFilter={onClearFilter} />;
  }

  const renderGroup = (g: TreeGroup, isArchived?: boolean) => (
    <TreeBlock
      key={g.treeId}
      group={g}
      tree={treeById.get(g.treeId)}
      selectedId={selectedId}
      onSelect={(id) => {
        if (manageMode && bulkActions) return;
        setSelectedId(id);
        onOpen(id);
      }}
      onContextMenu={(e, tree) => {
        if (!tree || !menuActions) return;
        e.preventDefault();
        openMenuForTree(tree, e.clientX, e.clientY);
      }}
      onMoreClick={(rect, tree) => openMenuForTree(tree, rect.right, rect.bottom)}
      menuEnabled={!!menuActions && !manageMode}
      menuOpen={menu?.tree.id === g.treeId}
      manageMode={manageMode}
      checked={bulkActions ? bulkActions.treeSelection.has(g.treeId) : false}
      onCheck={(shiftKey) => handleTreeCheck(g.treeId, shiftKey)}
      isArchived={isArchived}
    />
  );

  return (
    <>
      <div role="list" style={manageMode ? { userSelect: 'none' } : undefined}>
        {pinned.length > 0 && (
          <>
            <SectionLabel icon={<StarIcon size="sm" fill="currentColor" />} text="PINNED" tone="pin" />
            {pinned.map((g) => renderGroup(g))}
            <div style={{ height: 6 }} />
            <SectionLabel text="RECENT" />
          </>
        )}
        {rest.map((g) => renderGroup(g))}
      </div>

      {/* Archived section */}
      {archivedGroups.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            aria-expanded={archivedExpanded}
            aria-controls={archivedListId}
            onClick={() => setArchivedExpanded((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '10px 10px',
              border: 'none',
              borderTop: '1px solid var(--term-line)',
              borderBottom: archivedExpanded ? '1px solid var(--term-line)' : 'none',
              background: 'var(--term-alt)',
              cursor: 'pointer',
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--term-muted)',
              letterSpacing: 'var(--ls-caps)',
              textTransform: 'uppercase',
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 'var(--fs-2xs)', transition: 'transform var(--t-soft)', transform: archivedExpanded ? 'rotate(90deg)' : 'none' }}>
              ▶
            </span>
            ARCHIVED
            <span style={{ fontWeight: 600, color: 'var(--term-fg)', fontSize: 'var(--fs-sm)', letterSpacing: 0, textTransform: 'none' }}>
              {archivedGroups.length}
            </span>
          </button>
          {archivedExpanded && (
            <div role="list" id={archivedListId} style={manageMode ? { userSelect: 'none' } : undefined}>
              {archivedGroups.map((g) => renderGroup(g, true))}
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {menu && (
          <ContextMenu
            key={menuOpenKey(menu)}
            x={menu.x}
            y={menu.y}
            sections={menuSections}
            onClose={closeMenu}
          />
        )}
      </AnimatePresence>
    </>
  );
}


function SectionLabel({
  text,
  icon,
  tone,
}: {
  text: string;
  icon?: React.ReactNode;
  tone?: 'pin';
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 'var(--fs-sm)',
        color: 'var(--term-muted)',
        padding: '6px 18px 14px',
        letterSpacing: 'var(--ls-caps-wide)',
        fontWeight: 500,
        fontFamily: 'var(--ui-font)',
      }}
    >
      {icon && (
        <span
          style={{
            color: tone === 'pin' ? 'var(--term-select)' : 'inherit',
            display: 'inline-flex',
          }}
        >
          {icon}
        </span>
      )}
      {text}
    </div>
  );
}

interface TreeBlockProps {
  group: TreeGroup;
  tree: Tree | undefined;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, tree: Tree | undefined) => void;
  onMoreClick: (rect: DOMRect, tree: Tree | undefined) => void;
  menuEnabled: boolean;
  /** The tree's menu is open, from its ⋯ or a right click. */
  menuOpen: boolean;
  manageMode?: boolean;
  checked?: boolean;
  /** Shift extends the selection from the last box checked. */
  onCheck?: (shiftKey: boolean) => void;
  isArchived?: boolean;
}

function TreeBlock({
  group,
  tree,
  selectedId,
  onSelect,
  onContextMenu,
  onMoreClick,
  menuEnabled,
  menuOpen,
  manageMode,
  checked,
  onCheck,
  isArchived,
}: TreeBlockProps) {
  return (
    <div
      className="chat-tree-block"
      style={{
        padding: '2px 0',
        transition: 'border-color var(--t-soft)',
        opacity: isArchived && !manageMode ? 0.7 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        {manageMode && (
          <label
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 36,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <input
              type="checkbox"
              aria-label={`Select ${group.title || group.root.node.title || 'Untitled'}`}
              checked={!!checked}
              // A checkbox's change comes from its click, which carries Shift.
              onChange={(e) => onCheck?.((e.nativeEvent as MouseEvent).shiftKey)}
              style={{ width: 14, height: 14, margin: 0, accentColor: 'var(--term-accent)', cursor: 'pointer' }}
            />
          </label>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <ChatRow
            row={group.root}
            title={group.title}
            isBranch={false}
            selected={selectedId === group.root.nodeId}
            onSelect={onSelect}
            onContextMenu={(e) => onContextMenu(e, tree)}
            onMoreClick={(r) => onMoreClick(r, tree)}
            menuEnabled={menuEnabled}
            menuOpen={menuOpen}
            isArchived={isArchived}
          />
        </div>
      </div>
      {!manageMode && group.branches.map((b) => (
        <ChatRow
          key={b.nodeId}
          row={b}
          isBranch
          selected={selectedId === b.nodeId}
          onSelect={onSelect}
          onContextMenu={(e) => e.preventDefault()}
          onMoreClick={() => undefined}
          menuEnabled={false}
        />
      ))}
      {!manageMode && group.overflow && (
        <div
          style={{
            paddingLeft: 40,
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--term-muted)',
          }}
        >
          … +{group.overflow.count} deeper
        </div>
      )}
    </div>
  );
}

interface ChatRowProps {
  row: Extract<TreeRow, { kind: 'root' | 'branch' }>;
  /** The thread's name, for a root row; a branch shows its own title. */
  title?: string;
  isBranch: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onMoreClick: (rect: DOMRect) => void;
  menuEnabled: boolean;
  menuOpen?: boolean;
  isArchived?: boolean;
}

function ChatRow({
  row,
  title,
  isBranch,
  selected,
  onSelect,
  onContextMenu,
  onMoreClick,
  menuEnabled,
  menuOpen = false,
  isArchived,
}: ChatRowProps) {
  const node = row.node;
  const snippet = firstUserSnippet(node);
  const isRoot = row.kind === 'root';
  const branchCount = !isBranch && row.kind === 'root' ? row.branchCount : 0;

  return (
    <div
      role="listitem"
      className="manage-row t-reveal-host"
      data-selected={selected}
      data-pinned={isRoot && row.kind === 'root' ? row.pinned : false}
      data-context-target={menuEnabled && !isBranch ? '' : undefined}
      onContextMenu={onContextMenu}
      style={{
        padding: '6px 10px 6px 8px',
        marginLeft: isBranch ? 18 : 0,
      }}
    >
      {selected && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 2,
            background: 'var(--term-accent)',
          }}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        {isBranch && (
          <span
            style={{
              color: 'var(--term-faint, var(--term-muted))',
              fontSize: 'var(--fs-md)',
              lineHeight: 1.2,
              flexShrink: 0,
            }}
          >
            ›
          </span>
        )}
        <button
          type="button"
          className="manage-row__open"
          onClick={() => onSelect(node.nodeId)}
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: isBranch ? 'var(--fs-xl)' : 'var(--fs-2xl)',
            lineHeight: 1.3,
            fontWeight: 500,
            color: isArchived ? 'var(--term-muted)' : 'var(--term-fg)',
            flex: 1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title || node.title || 'Untitled'}
          {isArchived && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 'var(--fs-2xs)',
                padding: '1px 5px',
                border: '1px solid var(--term-line)',
                color: 'var(--term-muted)',
                letterSpacing: 'var(--ls-wide)',
                verticalAlign: 'middle',
                fontWeight: 400,
              }}
            >
              archived
            </span>
          )}
        </button>
        <span
          style={{
            fontSize: 'var(--fs-md)',
            color: 'var(--term-muted)',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
            fontFamily: 'var(--ui-font)',
          }}
        >
          {(() => {
            const msgs = node.messages;
            const lastTs = msgs.length > 0
              ? msgs.reduce((max, m) => Math.max(max, m.createdAt ?? 0), 0)
              : 0;
            return lastTs > 0 ? relativeTime(lastTs) : '—';
          })()}
        </span>
        {branchCount > 0 && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontSize: 'var(--fs-md)',
              color: 'var(--term-muted)',
              flexShrink: 0,
              fontFamily: 'var(--ui-font)',
            }}
          >
            <BranchIcon size="sm" /> {branchCount}
          </span>
        )}
        {isRoot && menuEnabled && (
          <HoverTip label="More actions">
            <button
              type="button"
              className="t-icon-btn t-reveal manage-icon-btn manage-row__above manage-row__more"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                onMoreClick(e.currentTarget.getBoundingClientRect());
              }}
            >
              <MoreIcon />
            </button>
          </HoverTip>
        )}
      </div>
      {snippet && (
        <div
          style={{
            marginTop: 1,
            marginLeft: isBranch ? 16 : 0,
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-lg)',
            lineHeight: 1.4,
            color: 'var(--term-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {snippet}
        </div>
      )}
    </div>
  );
}
