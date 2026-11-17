import React, { useCallback, useId, useMemo, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { shallowArrayEqual, useChatActions, useChatNodesSnapshot, useChatPanes, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import { isWorkspaceExpanded, sortTrees, sortLiveProjects, workspaceHasUnread, type NodePinnedAt } from '../../state/sidebarSelectors';
import { isListedThread, isVisibleConversationNode } from '../../state/conversationVisibility';
import { useRunningWorkNodeIds } from '../../state/runningWork';
import WorkspaceRow, { type WorkspaceRowMove } from './WorkspaceRow';
import ContextMenu, { menuOpenKey } from '../ContextMenu';
import { descendants } from '../../state/tree';
import { flattenBranchIds, useSidebarTreeController } from './sidebar/useSidebarTreeController';
import { EARLIER_GROUP_KEY, splitEarlierWorkspaces } from './sidebar/earlierWorkspaces';
import { PROVISIONAL_LABEL_STYLE, rowLabel, type RowLabel } from './sidebar/rowLabel';
import { rowKeyDown } from './sidebar/rowKeyboard';
import { Row } from './primitives';
import { Chevron } from './ThreadRow';
import { rowGeom, spinePadding, WORKSPACE_ICON_GAP, WORKSPACE_ICON_SIZE, type RowGeom } from './sidebarRowStyle';
import type { Project, ChatNodeState } from '../../state/chatTypes';
import { SidebarScroller } from './SidebarScroller';
import { ICON_PX, strokeFor } from './icons';

const MERGED_PREVIEW_LIMIT = 5;
const MERGED_PAGE_SIZE = 10;
/** A merged-section title fades out at the row's end. */
const TITLE_FADE = 'linear-gradient(to right, black calc(100% - 14px), transparent)';

interface MergeGroup {
  mergeNodeId: string;
  sources: string[];
  mergeTreeId: string;
}

export default function WorkspaceTree({
  onActivate,
  chatViewActive = true,
  onOpenWorkspaces,
  workspacesPageOpen = false,
  phoneDrawer = false,
}: {
  /** Called after a thread/branch click so the parent can switch to dashboard. */
  onActivate?: () => void;
  /** False when the user is on Map/Digest/etc. — suppresses thread/branch
   *  active highlights so the sidebar doesn't claim something is open when
   *  the user has navigated away. The workspace row still gets a marker. */
  chatViewActive?: boolean;
  /** The Projects header's "All N ›": opens the Workspaces page. Omit to hide it. */
  onOpenWorkspaces?: () => void;
  /** The Workspaces page is on screen: "All N ›" reads as current. */
  workspacesPageOpen?: boolean;
  /** The tree is the phone drawer's: its folder rows follow ST-36 (useSidebarTreeController). */
  phoneDrawer?: boolean;
}) {
  const {
    projects,
    activeProjectId,
    focusedNodeId,
    unreadFilterOn,
  } = useChatProjects();
  const {
    selectProject,
    activateTree,
    archiveTree,
    unarchiveTree,
    pinTree,
    unpinTree,
    renameTree,
    deleteTree,
    moveTreeToWorkspace,
    renameProject,
    archiveProject,
    unarchiveProject,
    pinProject,
    unpinProject,
    deleteProject,
    createThread,
    markAllRead,
    renameNode,
  } = useChatActions();
  const { prefs, setPref } = usePrefs();
  const nodesSnapshot = useChatNodesSnapshot();
  const { openPanes } = useChatPanes();
  // Conversations whose workflow or background agents still run after their turn ended.
  const workRunning = useRunningWorkNodeIds();
  const geom = rowGeom(prefs.sidebarRowStyle);
  const earlierGroupId = `sidebar-earlier-${useId().replace(/[^\w-]/g, '')}`;

  const liveProjects = useMemo(
    () => sortLiveProjects(projects, prefs.workspaceOrder),
    [projects, prefs.workspaceOrder],
  );
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [collapsedMergeGroups, setCollapsedMergeGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleMergeGroup = useCallback((mergeNodeId: string) => {
    setCollapsedMergeGroups((prev) => {
      const next = new Set(prev);
      if (next.has(mergeNodeId)) next.delete(mergeNodeId);
      else next.add(mergeNodeId);
      return next;
    });
  }, []);

  /** Puts `sourceId` just before (a drop, Move up) or after (Move down) `targetId`. */
  const commitWorkspaceReorder = useCallback(
    (sourceId: string, targetId: string, place: 'before' | 'after' = 'before') => {
      if (sourceId === targetId) return;
      const ids = liveProjects.map((p) => p.id);
      if (!ids.includes(sourceId) || !ids.includes(targetId)) return;
      const next = ids.filter((id) => id !== sourceId);
      next.splice(next.indexOf(targetId) + (place === 'after' ? 1 : 0), 0, sourceId);
      // Preserve any archived/stale IDs from the current pref as tombstones
      // — sortLiveProjects ignores them, but they let us restore explicit
      // ordering if a workspace is later unarchived.
      const liveSet = new Set(ids);
      const tombstones = prefs.workspaceOrder.filter((id) => !liveSet.has(id));
      setPref('workspaceOrder', [...next, ...tombstones]);
    },
    [liveProjects, prefs.workspaceOrder, setPref],
  );
  // The drag's order without dragging: past the neighbour in the row's own
  // list. Pinned workspaces keep their pin order, so they get none.
  const moveWithin = (group: readonly Project[], index: number): WorkspaceRowMove => ({
    up: index > 0 ? () => commitWorkspaceReorder(group[index].id, group[index - 1].id, 'before') : undefined,
    down: index < group.length - 1 ? () => commitWorkspaceReorder(group[index].id, group[index + 1].id, 'after') : undefined,
  });

  const dndForProject = useCallback(
    (projectId: string) => ({
      draggable: true as const,
      isDragSource: dragSourceId === projectId,
      isDropTarget: dropTargetId === projectId && dragSourceId !== null && dragSourceId !== projectId,
      onDragStart: (e: React.DragEvent) => {
        setDragSourceId(projectId);
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          // Some browsers refuse to start a drag without setData.
          try { e.dataTransfer.setData('text/plain', projectId); } catch {}
        }
      },
      onDragOver: (e: React.DragEvent) => {
        if (!dragSourceId || dragSourceId === projectId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        if (dropTargetId !== projectId) setDropTargetId(projectId);
      },
      onDragLeave: () => {
        setDropTargetId((cur) => (cur === projectId ? null : cur));
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (dragSourceId) commitWorkspaceReorder(dragSourceId, projectId);
        setDragSourceId(null);
        setDropTargetId(null);
      },
      onDragEnd: () => {
        setDragSourceId(null);
        setDropTargetId(null);
      },
    }),
    [dragSourceId, dropTargetId, commitWorkspaceReorder],
  );

  const isAlive = useCallback(
    (id: string) => !nodesSnapshot[id]?.deletedAt && isVisibleConversationNode(nodesSnapshot[id]),
    [nodesSnapshot],
  );
  const nodePinnedAt = useCallback<NodePinnedAt>(
    (id) => nodesSnapshot[id]?.pinnedAt,
    [nodesSnapshot],
  );

  const branchIdsForProject = useCallback(
    (project: Project) => flattenBranchIds(project.trees, project.edges, isAlive, nodePinnedAt),
    [isAlive, nodePinnedAt],
  );
  const {
    isThreadOpen,
    isBranchOpen,
    toggleThread,
    setThreadExpanded,
    toggleBranch,
    snapshotBeforeSwitch,
    updateExpanded,
    clickThreadRow,
    selectBranch,
    focusNode,
    isBranchSelected,
    menu,
    menuSections,
    openBranchMenu,
    closeMenu,
    isBranchMenuTarget,
    renamingNodeId,
    endRename,
  } = useSidebarTreeController({ onActivate, branchIdsForProject, phoneDrawer });

  const toggleWorkspace = useCallback(
    (projectId: string) =>
      updateExpanded((cur) => ({
        ...cur,
        workspaces: { ...cur.workspaces, [projectId]: !isWorkspaceExpanded(cur, projectId, activeProjectId) },
      })),
    [activeProjectId, updateExpanded],
  );

  const activateTreeStable = useCallback(
    (treeId: string, projectId: string) => {
      snapshotBeforeSwitch(treeId, projectId);
      if (projectId !== activeProjectId) selectProject(projectId);
      activateTree(treeId);
      onActivate?.();
    },
    [snapshotBeforeSwitch, activeProjectId, selectProject, activateTree, onActivate],
  );

  /** Select a project and set its expand state in the same sidebarExpanded
   *  write as the switch snapshot. `expanded === undefined` preserves whatever
   *  the snapshot pinned (i.e. the visual state right before the switch). */
  const selectProjectStable = useCallback(
    (projectId: string, expanded?: boolean) => {
      const sameProject = projectId === activeProjectId;
      if (sameProject && expanded === undefined) return;
      snapshotBeforeSwitch(null, projectId, (next) =>
        expanded === undefined
          ? next
          : { ...next, workspaces: { ...next.workspaces, [projectId]: expanded } },
      );
      if (!sameProject) selectProject(projectId);
    },
    [snapshotBeforeSwitch, activeProjectId, selectProject],
  );

  const toggleWorkspaceExpand = useCallback(
    (projectId: string) => {
      // Clicking an INACTIVE workspace is a project switch: activate it and
      // keep it expanded (never collapse on activation), routing through
      // selectProjectStable so snapshotBeforeSwitch pins the outgoing
      // (implicit-active → expanded) workspace before the active flip.
      // Without this the previously-active workspace silently collapses.
      // Collapse only happens on a SECOND click, once the workspace is active.
      if (projectId !== activeProjectId) {
        selectProjectStable(projectId, true);
        return;
      }
      // Active workspace: plain expand/collapse toggle. Collapsing must NOT
      // switch active project — that would trigger the focusedPane reveal
      // effect which re-expands it.
      toggleWorkspace(projectId);
    },
    [activeProjectId, selectProjectStable, toggleWorkspace],
  );

  const renderProject = (project: typeof projects[number], opts: { dnd?: ReturnType<typeof dndForProject>; move?: WorkspaceRowMove } = {}) => {
    const wsExpanded = isWorkspaceExpanded(
      prefs.sidebarExpanded,
      project.id,
      activeProjectId,
    );
    const normalTrees = project.trees.filter((t) => t.kind !== 'merge');
    const mergeTrees = project.trees.filter((t) => t.kind === 'merge' && isListedThread(t, nodesSnapshot[t.rootNodeId]));
    const sortedTreesArr = sortTrees(normalTrees, project.activeTreeId);
    const isActive = project.id === activeProjectId;
    const mergeGroups = isActive
      ? sortTrees(mergeTrees, project.activeTreeId).map((t) => {
          const sources = (nodesSnapshot[t.rootNodeId]?.mergeSources ?? []) as string[];
          return { mergeNodeId: t.rootNodeId, sources, mergeTreeId: t.id };
        })
      : [];
    return (
      <React.Fragment key={project.id}>
        <WorkspaceRow
          project={project}
          dnd={opts.dnd}
          move={opts.move}
          workspaceExpanded={wsExpanded}
          forceExpand={unreadFilterOn}
          activeProjectId={activeProjectId}
          chatViewActive={chatViewActive}
          activeTreeId={chatViewActive ? project.activeTreeId : null}
          focusedNodeId={chatViewActive ? focusedNodeId : null}
          isThreadExpanded={(treeId) => isThreadOpen(treeId, project.activeTreeId)}
          isBranchExpanded={isBranchOpen}
          isBranchSelected={isBranchSelected}
          isBranchMenuTarget={isBranchMenuTarget}
          isNodeAlive={isAlive}
          nodePinnedAt={nodePinnedAt}
          sortedTrees={sortedTreesArr}
          edges={project.edges}
          actions={{
            toggleWorkspace,
            toggleThread,
            setThreadExpanded,
            toggleBranch,
            activateTree: (treeId) => activateTreeStable(treeId, project.id),
            selectProject: selectProjectStable,
            toggleWorkspaceExpand,
            createThread: () => {
              createThread();
              onActivate?.();
            },
            archiveTree,
            unarchiveTree,
            pinTree,
            unpinTree,
            renameTree: (treeId, name) => renameTree(treeId, name, project.id),
            deleteTree,
            moveTreeToWorkspace: (treeId, targetProjectId) => {
              // Fire-and-forget — the action is async but the menu invoker is
              // synchronous; failures surface via toast inside the store.
              void moveTreeToWorkspace(treeId, targetProjectId);
            },
            renameProject,
            archiveProject,
            unarchiveProject,
            pinProject,
            unpinProject,
            deleteProject,
            selectBranch,
            branchContextMenu: openBranchMenu,
            clickThreadRow,
          }}
          renamingNodeId={renamingNodeId}
          onRenameNode={renameNode}
          onRenameEnd={endRename}
          phoneDrawer={phoneDrawer}
        />
        {wsExpanded && mergeGroups.length > 0 && (
          <MergedGroupsSection
            key={`merged-${project.id}`}
            project={project}
            mergeGroups={mergeGroups}
            nodesSnapshot={nodesSnapshot}
            focusedNodeId={focusedNodeId}
            collapsedMergeGroups={collapsedMergeGroups}
            toggleMergeGroup={toggleMergeGroup}
            isAlive={isAlive}
            onSelectMergeNode={focusNode}
            onSelectMergeSource={focusNode}
            onContextMenu={openBranchMenu}
          />
        )}
      </React.Fragment>
    );
  };

  // Subscribed, so reading a thread (or "Read all") updates the filtered list
  // and the caught-up state without waiting for an unrelated re-render.
  const projectsToRender = useStructuralSelector(
    (nodes) => (unreadFilterOn
      ? liveProjects.filter((p) => workspaceHasUnread(p, nodes, focusedNodeId))
      : liveProjects),
    shallowArrayEqual,
  );

  return (
    <SidebarScroller
      scrollKey="structure"
      style={{
        // Horizontal gutter between tree content and the sidebar edges. The
        // scroll thumb still sits at the list's true right edge; only the rows
        // inset. See Sidebar.tsx `--sb-inset`.
        paddingLeft: 'var(--sb-inset, 0px)',
        paddingRight: 'var(--sb-inset, 0px)',
      }}
    >
      {unreadFilterOn && projectsToRender.length > 0 && (
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 2,
            padding: '6px 8px',
            background: 'var(--term-sidebar-bg, var(--term-surface))',
            borderBottom: '1px solid color-mix(in srgb, var(--term-line) 50%, transparent)',
          }}
        >
          <button
            type="button"
            className="t-row-hover sb-flush"
            aria-label="Mark all threads as read"
            onClick={() => markAllRead()}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '5px 8px',
              background: 'transparent',
              border: '1px solid var(--term-line)',
              borderRadius: 'var(--ui-radius)',
              color: 'var(--term-mid)',
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-md)',
              cursor: 'pointer',
            }}
          >
            <ReadAllIcon />
            Read all
          </button>
        </div>
      )}
      {(() => {
        const pinned = projectsToRender.filter((p) => !!p.pinnedAt);
        const unpinned = projectsToRender.filter((p) => !p.pinnedAt);
        const showPinnedSection = pinned.length > 0;
        // Workspaces left alone for a month fold into Earlier at the end of
        // Projects; each part keeps the manual order. The unread filter
        // already shows only workspaces with something new.
        const { recent, earlier } = unreadFilterOn
          ? { recent: unpinned, earlier: [] }
          : splitEarlierWorkspaces(unpinned, {
              activeProjectId, now: Date.now(), nodes: nodesSnapshot, openPaneIds: openPanes, workRunning,
            });
        const earlierOpen = prefs.sidebarExpanded.groups?.[EARLIER_GROUP_KEY] === true;
        // "All N ›" rides the top header, Pinned's when there is one, so it is
        // in view without scrolling past every pinned workspace.
        const allLink = onOpenWorkspaces && liveProjects.length > 0 ? (
          <AllWorkspacesLink count={liveProjects.length} current={workspacesPageOpen} onOpen={onOpenWorkspaces} />
        ) : null;
        return (
          <>
            {showPinnedSection && (
              <>
                <SectionLabel label="Pinned" action={allLink} />
                <div className="sb-section-items">
                  {pinned.map((p) => renderProject(p, { dnd: dndForProject(p.id) }))}
                </div>
              </>
            )}
            {unpinned.length > 0 && (
              <>
                <SectionLabel label="Projects" action={showPinnedSection ? null : allLink} />
                <div className="sb-section-items">
                  {recent.map((p, index) => renderProject(p, { dnd: dndForProject(p.id), move: moveWithin(recent, index) }))}
                  {earlier.length > 0 && (
                    <EarlierGroup
                      id={earlierGroupId}
                      count={earlier.length}
                      open={earlierOpen}
                      geom={geom}
                      onToggle={() => updateExpanded((cur) => ({
                        ...cur,
                        groups: { ...cur.groups, [EARLIER_GROUP_KEY]: !(cur.groups?.[EARLIER_GROUP_KEY] === true) },
                      }))}
                    >
                      {earlier.map((p, index) => renderProject(p, { dnd: dndForProject(p.id), move: moveWithin(earlier, index) }))}
                    </EarlierGroup>
                  )}
                </div>
              </>
            )}
          </>
        );
      })()}
      {unreadFilterOn && projectsToRender.length === 0 && (
        <div
          data-testid="all-caught-up"
          style={{
            padding: '24px 16px',
            color: 'var(--term-muted)',
            fontSize: 'var(--fs-md)',
            textAlign: 'center',
          }}
        >
          All caught up ✓
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
    </SidebarScroller>
  );
}

/** Section header for the Structure sidebar (Pinned / Projects / Chats).
 *  Style matches ActivityView's time-label: sentence case, small, muted,
 *  aligned to WorkspaceRow folder-icon left edge (6 + inset from sidebar).
 *  `action` sits at the header's right end. */
function SectionLabel({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div
      data-testid={`section-label-${label.toLowerCase()}`}
      className="sidebar-section-label"
    >
      {label}
      {action}
    </div>
  );
}

/** The quiet way to the Workspaces page, at the right end of a section header. */
function AllWorkspacesLink({ count, current, onOpen }: { count: number; current: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="sidebar-section-label__action"
      aria-label={`All ${count} workspaces`}
      aria-current={current ? 'page' : undefined}
      onClick={onOpen}
    >
      All {count}<span aria-hidden="true"> ›</span>
    </button>
  );
}

/**
 * Earlier · N: workspaces nobody touched for a month, folded at the end of
 * Projects. Closed by default; its open state is remembered with the rest of
 * the sidebar's (`sidebarExpanded.groups`). Shaped like a workspace header,
 * with a chevron where a workspace has its folder, but quieter.
 */
function EarlierGroup({ id, count, open, geom, onToggle, children }: {
  id: string;
  count: number;
  open: boolean;
  geom: RowGeom;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="sidebar-earlier" style={{ marginTop: geom.workspaceAsHeader ? 14 : 'var(--sb-ws-gap, 6px)' }}>
      <Row
        role="button"
        tabIndex={0}
        aria-label={`Earlier, ${count} ${count === 1 ? 'workspace' : 'workspaces'}`}
        aria-expanded={open}
        aria-controls={id}
        className="t-row-focus sidebar-earlier__toggle"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onToggle();
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: geom.workspaceAsHeader ? WORKSPACE_ICON_GAP : 6,
          padding: geom.workspaceAsHeader
            ? `3px ${spinePadding(geom, geom.rightGap)} 3px ${spinePadding(geom, geom.titleX)}`
            : 'var(--sb-row-py, 5px) calc(10px + var(--sb-inset, 0px)) var(--sb-row-py, 4px) calc(4px + var(--sb-inset, 0px))',
          ...(geom.workspaceAsHeader ? {} : { borderLeft: '2px solid transparent' }),
          fontSize: 'var(--sb-fs, var(--fs-xl))',
          fontFamily: 'var(--ui-font)',
          color: 'var(--term-muted)',
        }}
      >
        <span aria-hidden="true" className="sidebar-earlier__chevron" data-open={open || undefined} style={{ width: WORKSPACE_ICON_SIZE }}>›</span>
        <span>Earlier</span>
        <span className="sidebar-earlier__count">· {count}</span>
      </Row>
      {open && (
        <div id={id} role="group" aria-label="Earlier workspaces">
          {children}
        </div>
      )}
    </div>
  );
}

function MergedGroupsSection({
  project,
  mergeGroups,
  nodesSnapshot,
  focusedNodeId,
  collapsedMergeGroups,
  toggleMergeGroup,
  isAlive,
  onSelectMergeNode,
  onSelectMergeSource,
  onContextMenu,
}: {
  project: Project;
  mergeGroups: MergeGroup[];
  nodesSnapshot: Readonly<Record<string, ChatNodeState>>;
  focusedNodeId: string | null;
  collapsedMergeGroups: ReadonlySet<string>;
  toggleMergeGroup: (mergeNodeId: string) => void;
  isAlive: (nodeId: string) => boolean;
  onSelectMergeNode: (nodeId: string) => void;
  onSelectMergeSource: (nodeId: string) => void;
  onContextMenu: (nodeId: string, event: React.MouseEvent) => void;
}) {
  const [mergedVisibleLimit, setMergedVisibleLimit] = useState(MERGED_PREVIEW_LIMIT);
  const visibleGroups = mergeGroups.filter((g) => nodesSnapshot[g.mergeNodeId]);
  const displayedGroups = visibleGroups.slice(0, mergedVisibleLimit);

  return (
    <div data-testid="merged-section" style={{ marginTop: 12 }}>
      <div style={{
        padding: '4px 10px', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)',
      }}>
        ── Merged ──
      </div>
      {displayedGroups.map((g) => {
        const merged = nodesSnapshot[g.mergeNodeId];
        const mergedLabel = rowLabel(undefined, merged);
        const isFocused = focusedNodeId === g.mergeNodeId;
        const expanded = !collapsedMergeGroups.has(g.mergeNodeId);
        const branchChildIds = Array.from(descendants(g.mergeNodeId, project.edges, isAlive));
        const hasChildren = g.sources.length > 0 || branchChildIds.length > 0;
        const toggle = () => toggleMergeGroup(g.mergeNodeId);
        return (
          <div key={g.mergeNodeId} data-testid={`merge-group-${g.mergeNodeId}`}>
            <Row
              active={isFocused}
              onContextMenu={(e: React.MouseEvent) => onContextMenu(g.mergeNodeId, e)}
              data-context-target=""
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                // +--sb-inset indents the text; full-bleed box keeps the focused
                // borderLeft flush to the sidebar edge (see index.css / ThreadRow).
                padding: 'var(--sb-row-py, 4px) calc(10px + var(--sb-inset, 0px)) var(--sb-row-py, 4px) calc(8px + var(--sb-inset, 0px))',
                background: isFocused ? 'var(--term-alt)' : 'transparent',
                borderLeft: isFocused
                  ? '2px solid var(--term-accent)'
                  : '2px solid transparent',
                // Focus changes colour and fill, not weight (see ThreadRow).
                color: isFocused ? 'var(--term-fg)' : 'var(--term-mid)',
                fontWeight: 400,
                fontSize: 'var(--fs-md)',
                fontFamily: 'var(--ui-font)',
              }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="sb-row-caret"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${mergedLabel.text}`}
                  onClick={toggle}
                >
                  <Chevron expanded={expanded} visible />
                </button>
              ) : (
                <Chevron expanded={expanded} visible={false} />
              )}
              <MergedRowTitle
                label={mergedLabel}
                current={isFocused}
                onOpen={() => onSelectMergeNode(g.mergeNodeId)}
                onMenu={(anchor) => onContextMenu(g.mergeNodeId, menuEventAt(anchor))}
                expanded={hasChildren ? expanded : undefined}
                onToggle={hasChildren ? toggle : undefined}
              />
            </Row>
            {expanded && g.sources.map((sid) => {
              const src = nodesSnapshot[sid];
              const deleted = !src || !!src.deletedAt;
              const focused = focusedNodeId === sid;
              return (
                <Row
                  key={`src-${sid}`}
                  active={focused}
                  onContextMenu={(e: React.MouseEvent) => { if (!deleted) onContextMenu(sid, e); }}
                  data-context-target={deleted ? undefined : ''}
                  style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: 'var(--sb-row-py, 4px) calc(10px + var(--sb-inset, 0px)) var(--sb-row-py, 4px) calc(28px + var(--sb-inset, 0px))',
                    background: focused ? 'var(--term-alt)' : undefined,
                    borderLeft: focused
                      ? '2px solid var(--term-accent)'
                      : '2px solid transparent',
                    color: 'var(--term-muted)',
                    fontStyle: 'italic',
                    textDecoration: deleted ? 'line-through' : 'none',
                    fontSize: 'var(--fs-md)',
                    fontFamily: 'var(--ui-font)',
                    cursor: deleted ? 'default' : 'pointer',
                  }}
                >
                  {deleted ? (
                    <span style={{ flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', maskImage: TITLE_FADE, WebkitMaskImage: TITLE_FADE }}>
                      (deleted)
                    </span>
                  ) : (
                    // Source rows are already italic and muted, so an excerpt needs no extra mark.
                    <MergedRowTitle
                      label={{ text: rowLabel(undefined, src).text, provisional: false }}
                      current={focused}
                      onOpen={() => onSelectMergeSource(sid)}
                      onMenu={(anchor) => onContextMenu(sid, menuEventAt(anchor))}
                    />
                  )}
                </Row>
              );
            })}
            {expanded && branchChildIds.map((cid) => {
              const child = nodesSnapshot[cid];
              if (!child) return null;
              const focused = focusedNodeId === cid;
              return (
                <Row
                  key={`child-${cid}`}
                  active={focused}
                  onContextMenu={(e: React.MouseEvent) => onContextMenu(cid, e)}
                  data-context-target=""
                  style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: 'var(--sb-row-py, 4px) calc(10px + var(--sb-inset, 0px)) var(--sb-row-py, 4px) calc(28px + var(--sb-inset, 0px))',
                    background: focused ? 'var(--term-alt)' : undefined,
                    borderLeft: focused
                      ? '2px solid var(--term-accent)'
                      : '2px solid transparent',
                    color: focused ? 'var(--term-fg)' : 'var(--term-mid)',
                    fontWeight: 400,
                    fontSize: 'var(--fs-md)',
                    fontFamily: 'var(--ui-font)',
                    cursor: 'pointer',
                  }}
                >
                  <MergedRowTitle
                    label={rowLabel(undefined, child)}
                    current={focused}
                    onOpen={() => onSelectMergeSource(cid)}
                    onMenu={(anchor) => onContextMenu(cid, menuEventAt(anchor))}
                  />
                </Row>
              );
            })}
          </div>
        );
      })}
      {visibleGroups.length > mergedVisibleLimit && (
        <button
          type="button"
          className="sb-flush show-more-toggle"
          aria-label="Show more merged threads"
          aria-expanded={mergedVisibleLimit > MERGED_PREVIEW_LIMIT}
          onClick={() => setMergedVisibleLimit((v) => v + MERGED_PAGE_SIZE)}
          style={{ padding: '0 8px 0 25px' }}
        >
          Show {Math.min(MERGED_PAGE_SIZE, visibleGroups.length - mergedVisibleLimit)} more
        </button>
      )}

    </div>
  );
}

/** What a merged row's menu handler reads of a right-click, for a menu the keyboard opens. */
function menuEventAt(anchor: { x: number; y: number }): React.MouseEvent {
  return { preventDefault: () => {}, clientX: anchor.x, clientY: anchor.y } as unknown as React.MouseEvent;
}

/**
 * A merged-section row's title: a button whose ::after covers the row
 * (sidebar.css), so the whole row opens it, keyed like the other sidebar
 * rows (rowKeyDown).
 */
function MergedRowTitle({ label, current, onOpen, onMenu, expanded, onToggle }: {
  label: RowLabel;
  current: boolean;
  onOpen: () => void;
  onMenu: (anchor: { x: number; y: number }) => void;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      className="sb-row-open"
      aria-current={current ? 'true' : undefined}
      onClick={onOpen}
      onKeyDown={(e) => rowKeyDown(e, { activate: onOpen, expanded, toggle: onToggle, openMenu: onMenu })}
    >
      <span
        style={{
          display: 'block',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          maskImage: TITLE_FADE,
          WebkitMaskImage: TITLE_FADE,
          ...(label.provisional ? PROVISIONAL_LABEL_STYLE : {}),
        }}
      >
        {label.text}
      </span>
    </button>
  );
}

/** Double-check glyph — "mark all read". */
function ReadAllIcon() {
  return (
    <svg
      width={ICON_PX.md}
      height={ICON_PX.md}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeFor(ICON_PX.md)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 8.5l3 3 6-6.5" />
      <path d="M7 11l.7.7 6-6.7" />
    </svg>
  );
}
