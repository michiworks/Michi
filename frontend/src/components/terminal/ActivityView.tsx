import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { useChatPanes, useChatProjects, useChatActions, useChatNodesSnapshot, useStructuralSelector } from '../../state/chatStore';
import { EASE } from '../../motion/tokens';
import { usePrefs } from '../../state/prefs';
import type { Project, Tree, ProjectEdge, ChatNodeState } from '../../state/chatTypes';
import { buildBranchChildrenOf, buildTree, findTreeIdForNode } from '../../state/tree';
import ThreadRow from './ThreadRow';
import BranchRow from './BranchRow';
import ContextMenu, { menuOpenKey } from '../ContextMenu';
import { rowGeom, spinePadding, branchBlockGap } from './sidebarRowStyle';
import { flattenBranchIds, useSidebarTreeController, type ThreadRowClick } from './sidebar/useSidebarTreeController';
import {
  nodeOpenState,
  subtreeOpenState,
  selectProjectNodeStatuses,
  orderPinnedFirst,
  treeHasUnread,
  type NodePinnedAt,
  type OpenState,
} from '../../state/sidebarSelectors';
import { useOptionalAgentDomain } from '../../state/agentDomain';
import { useRunningWorkNodeIds } from '../../state/runningWork';
import { agentResourceKey, identityOf } from '../../state/agentIdentity';
import { AgentRunsActivity } from './agentRuns/AgentRunsActivity';
import {
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_PREVIEW_LIMIT,
  truncateActivityBuckets,
} from './activityTruncation';
import { withoutSystemWorkspaces } from '../../state/assistant/systemWorkspace';
import { moveTargetsFor, type MoveTargetWorkspace } from '../../state/moveTargets';
import { isListedThread } from '../../state/conversationVisibility';
import { SidebarScroller } from './SidebarScroller';

// ── Time bucket helpers ────────────────────────────────────────────────────

type TimeBucket = 'unread' | 'now' | 'today' | 'yesterday' | 'earlier';

function getTimeBucket(lastActiveAt: number, isRunning: boolean, isUnread: boolean): TimeBucket {
  if (isRunning) return 'now';
  if (isUnread) return 'unread';
  const now = Date.now();
  const d = new Date(lastActiveAt);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (lastActiveAt >= today.getTime()) return 'today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (lastActiveAt >= yesterday.getTime()) return 'yesterday';
  return 'earlier';
}

// Finished but unseen work sits above what is still running; everything the
// user has read follows by recency.
const BUCKET_ORDER: TimeBucket[] = ['unread', 'now', 'today', 'yesterday', 'earlier'];
const BUCKET_LABELS: Record<TimeBucket, string> = {
  unread: 'Unread',
  now: 'Now',
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
};
// Unread trees wait on the user to read them, running trees (a turn streams,
// or a workflow it launched still runs) on the agent; neither counts toward
// the preview cap or is ever hidden behind "Show more".
const CAP_EXEMPT_BUCKETS: ReadonlySet<TimeBucket> = new Set<TimeBucket>(['unread', 'now']);

// ── Re-sort motion ─────────────────────────────────────────────────────────
// When the list re-sorts (a thread starts or stops streaming, or a send moves
// it to the top), rows and bucket labels glide to their new places. Position
// only: a row that also changed height snaps to it.
const RESORT_MOVE: Transition = { layout: { duration: 0.22, ease: EASE.drawer } };
// Under the pointer the list re-sorts at once, so nothing slides under the cursor.
const RESORT_INSTANT: Transition = { layout: { duration: 0 } };
/** Stands in for the order while the pointer is over the list: an unchanged
 *  layoutDependency means motion does not even measure. */
const RESORT_FROZEN = 'pointer-over';

// ── Data derivation ────────────────────────────────────────────────────────

interface ActivityTree {
  tree: Tree;
  project: Project;
  isRunning: boolean;
  bucket: TimeBucket;
}

const NO_RUNNING_WORK: ReadonlySet<string> = new Set();
const NO_TREES: ReadonlySet<string> = new Set();
/** The list's preview cap for the life of the page; see visibleLimit below. */
let rememberedVisibleLimit = ACTIVITY_PREVIEW_LIMIT;

/**
 * A node of the tree streams a turn, or runs work its turn left running
 * (`workRunning`: nodes with an open workflow run or a running background
 * subagent).
 */
function hasRunningNode(
  tree: Tree,
  childrenOf: ReadonlyMap<string, readonly string[]>,
  nodes: Record<string, ChatNodeState>,
  workRunning: ReadonlySet<string>,
): boolean {
  const stack = [tree.rootNodeId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = nodes[id];
    if (n?.status === 'streaming') return true;
    if (n && !n.deletedAt && workRunning.has(id)) return true;
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return false;
}

export function deriveActivityData(
  projects: readonly Project[],
  nodes: Record<string, ChatNodeState>,
  workRunning: ReadonlySet<string> = NO_RUNNING_WORK,
  focusedNodeId: string | null = null,
  /** Trees the list last showed under Unread (see `heldTreeId` below). */
  shownUnread: ReadonlySet<string> = NO_TREES,
): ActivityTree[] {
  const items: ActivityTree[] = [];
  const focusedProjectId = focusedNodeId !== null ? nodes[focusedNodeId]?.projectId : undefined;
  for (const project of projects) {
    if (project.deletedAt || project.archivedAt) continue;
    const childrenOf = buildBranchChildrenOf(project.edges);
    // The thread being read keeps the Unread place it was opened from until
    // the user switches to another thread: reading it must not pull its row
    // out from under them.
    const heldTreeId = shownUnread.size > 0 && focusedNodeId !== null && project.id === focusedProjectId
      ? findTreeIdForNode(focusedNodeId, project)
      : null;
    for (const tree of project.trees) {
      if (!isListedThread(tree, nodes[tree.rootNodeId])) continue;
      const running = hasRunningNode(tree, childrenOf, nodes, workRunning);
      const held = tree.id === heldTreeId && shownUnread.has(tree.id);
      const unread = !running && (held || treeHasUnread(tree, project.edges, nodes, focusedNodeId, childrenOf));
      const bucket = getTimeBucket(tree.lastActiveAt, running, unread);
      items.push({ tree, project, isRunning: running, bucket });
    }
  }
  items.sort((a, b) => {
    const ai = BUCKET_ORDER.indexOf(a.bucket);
    const bi = BUCKET_ORDER.indexOf(b.bucket);
    if (ai !== bi) return ai - bi;
    return b.tree.lastActiveAt - a.tree.lastActiveAt;
  });
  return items;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function ActivityView({
  onActivate,
  chatViewActive = true,
}: {
  onActivate?: () => void;
  /** False on Home and other pages: no row reads as the one on screen. */
  chatViewActive?: boolean;
}) {
  const { projects: allProjects, activeProjectId, focusedNodeId } = useChatProjects();
  // The assistant's system workspace has no place in the activity list.
  const projects = useMemo(() => withoutSystemWorkspaces(allProjects), [allProjects]);
  const { openPanes, focusedPane } = useChatPanes();
  const {
    archiveTree,
    unarchiveTree,
    pinTree,
    unpinTree,
    renameTree,
    deleteTree,
    moveTreeToWorkspace,
    renameNode,
    openAgentRunPane,
  } = useChatActions();
  const agentDomain = useOptionalAgentDomain();
  const agentState = agentDomain?.state;
  const { prefs } = usePrefs();
  const nodes = useChatNodesSnapshot();
  // Conversations whose workflow or background agents still run after their turn ended.
  const workRunning = useRunningWorkNodeIds();
  const geom = rowGeom(prefs.sidebarRowStyle, prefs.sidebarInset);

  // Trees under Unread at the last commit: opening one marks it read in the
  // same update that focuses it, so only the list's previous state knows it
  // was opened from there.
  const shownUnreadRef = useRef<ReadonlySet<string>>(NO_TREES);
  const activityItems = useMemo(
    () => deriveActivityData(projects, nodes, workRunning, focusedNodeId, shownUnreadRef.current),
    [projects, nodes, workRunning, focusedNodeId],
  );
  useEffect(() => {
    shownUnreadRef.current = new Set(
      activityItems.filter((item) => item.bucket === 'unread').map((item) => item.tree.id),
    );
  }, [activityItems]);
  const agentRuns = useMemo(
    () => Object.values(agentState?.runs ?? {}).filter((resource) => resource.value.workspaceId === activeProjectId),
    [activeProjectId, agentState?.runs],
  );

  const bucketGroups = useMemo(() => {
    const groups = new Map<TimeBucket, ActivityTree[]>();
    for (const item of activityItems) {
      const arr = groups.get(item.bucket) ?? [];
      arr.push(item);
      groups.set(item.bucket, arr);
    }
    return groups;
  }, [activityItems]);

  // Preview cap, grown by scrolling to the end. It outlives the list like its
  // scroll offset does (SidebarScroller's scrollKey): reopening the drawer at a
  // thread past the default cap needs that thread rendered.
  const [visibleLimit, setVisibleLimit] = useState(() => rememberedVisibleLimit);
  useEffect(() => { rememberedVisibleLimit = visibleLimit; }, [visibleLimit]);
  const { visible: visibleBuckets, hidden: hiddenCount } = useMemo(
    () => truncateActivityBuckets(bucketGroups, BUCKET_ORDER, visibleLimit, CAP_EXEMPT_BUCKETS),
    [bucketGroups, visibleLimit],
  );
  // ⇧+click range selection walks the thread rows on screen, across workspaces.
  const shownTreeIds = useMemo(
    () => BUCKET_ORDER.flatMap((bucket) => visibleBuckets.get(bucket) ?? []).map((item) => item.tree.id),
    [visibleBuckets],
  );

  // The visible order, the only thing whose change lets rows glide: streaming
  // chunks re-render this list every frame without re-sorting it, and motion
  // measures rows only when their layoutDependency changes.
  const visibleOrder = useMemo(
    () => BUCKET_ORDER.map((bucket) => `${bucket}:${(visibleBuckets.get(bucket) ?? []).map((item) => item.tree.id).join(',')}`).join('|'),
    [visibleBuckets],
  );
  // A ref, not state: hovering must not re-render (and re-measure) every row.
  // It is read on the render that re-sorts, which is all that needs it.
  const pointerOverRef = useRef(false);
  const pointerOver = pointerOverRef.current;
  const resortDependency = pointerOver ? RESORT_FROZEN : visibleOrder;
  const resortTransition = pointerOver ? RESORT_INSTANT : RESORT_MOVE;

  const isAlive = useCallback(
    (id: string) => !nodes[id]?.deletedAt,
    [nodes],
  );
  const nodePinnedAt = useCallback<NodePinnedAt>(
    (id) => nodes[id]?.pinnedAt,
    [nodes],
  );

  // ⇧+click range selection walks a project's branches in the order this
  // list shows its threads.
  const branchIdsForProject = useCallback(
    (project: Project) =>
      flattenBranchIds(
        activityItems.filter((item) => item.project.id === project.id).map((item) => item.tree),
        project.edges,
        isAlive,
        nodePinnedAt,
      ),
    [activityItems, isAlive, nodePinnedAt],
  );
  const {
    isThreadOpen,
    isBranchOpen,
    toggleThread,
    toggleBranch,
    openThreadRoot,
    clickThreadRow,
    selectBranch,
    isBranchSelected,
    menu,
    menuSections,
    openBranchMenu,
    closeMenu,
    isBranchMenuTarget,
    renamingNodeId,
    endRename,
  } = useSidebarTreeController({ onActivate, branchIdsForProject });

  // ── Node status for open-state bars ──
  const allChatIds = useMemo(
    () => projects.flatMap((p) => p.chatIds),
    [projects],
  );
  const nodeStatusesSelector = useCallback(
    (ns: Record<string, ChatNodeState>) => selectProjectNodeStatuses(allChatIds, ns),
    [allChatIds],
  );
  const nodeStatuses = useStructuralSelector(
    nodeStatusesSelector,
    (a, b) => {
      const ak = Object.keys(a);
      if (ak.length !== Object.keys(b).length) return false;
      for (const id of ak) if (a[id] !== b[id]) return false;
      return true;
    },
  );

  const getNodeOpenState = useCallback(
    (id: string): OpenState =>
      nodeOpenState(id, openPanes, focusedPane, nodeStatuses[id] ?? 'idle', workRunning.has(id)),
    [openPanes, focusedPane, nodeStatuses, workRunning],
  );

  const getSubtreeOpenState = useCallback(
    (rootId: string, edges: readonly ProjectEdge[]): OpenState =>
      subtreeOpenState(rootId, edges, isAlive, getNodeOpenState),
    [isAlive, getNodeOpenState],
  );

  // ── Other live workspaces for the "Move to workspace" menu ──
  const moveTargetsOf = useCallback((projectId: string) => moveTargetsFor(projects, projectId), [projects]);

  return (
    <SidebarScroller
      scrollKey="activity"
      className="activity-view"
      style={{
        paddingLeft: 'var(--sb-inset, 0px)',
        paddingRight: 'var(--sb-inset, 0px)',
        fontSize: 'var(--sb-fs, var(--fs-xl))',
      }}
      onPointerEnter={() => { pointerOverRef.current = true; }}
      onPointerLeave={() => { pointerOverRef.current = false; }}
    >
      {agentRuns.length > 0 && (
        <AgentRunsActivity
          runs={agentRuns}
          onOpen={(identity) => {
            const resource = agentState?.runs[agentResourceKey(identity)];
            if (!resource) return;
            openAgentRunPane(identityOf(resource), resource.value.workspaceId, resource.value.effectiveDefinition.name);
            onActivate?.();
          }}
        />
      )}
      {/* One flat list, labels and rows as siblings, so a row that changes
          bucket moves instead of remounting under another section. */}
      {BUCKET_ORDER.flatMap((bucket) => {
        const items = visibleBuckets.get(bucket);
        if (!items || items.length === 0) return [];
        return [
          <motion.div
            key={`bucket:${bucket}`}
            className="activity-time-label"
            layout="position"
            layoutDependency={resortDependency}
            transition={resortTransition}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              // Sentence case in every mode, like the By project section labels.
              fontSize: geom.isCard ? 'var(--sb-ts-fs, var(--fs-md))' : 'var(--fs-sm)',
              fontWeight: 600,
              color: 'var(--term-muted)',
              // Card modes drop the label onto the same text spine as the
              // thread titles below it, at one shared size.
              padding: geom.isCard
                ? `0 ${spinePadding(geom, geom.rightGap)} 6px ${spinePadding(geom, geom.titleX)}`
                : 'var(--sb-row-py, 5px) 10px var(--sb-row-py, 4px) 6px',
              marginTop: geom.isCard ? 17 : 8,
            }}
          >
            {bucket === 'now' && (
              // Running colour, held still: the running rows below already pulse.
              // Green stays for unread.
              <span className="term-dot-i" style={{ width: 6, height: 6, background: 'var(--term-run)', opacity: 1 }} />
            )}
            {BUCKET_LABELS[bucket]}
          </motion.div>,
          ...items.map((item) => (
            <ActivityTreeEntry
              key={`tree:${item.tree.id}`}
              resortDependency={resortDependency}
              resortTransition={resortTransition}
              item={item}
              isAlive={isAlive}
              nodePinnedAt={nodePinnedAt}
              isThreadExpandedFn={isThreadOpen}
              isBranchExpanded={isBranchOpen}
              isBranchSelected={isBranchSelected}
              isBranchMenuTarget={isBranchMenuTarget}
              toggleThread={toggleThread}
              toggleBranch={toggleBranch}
              getNodeOpenState={getNodeOpenState}
              getSubtreeOpenState={getSubtreeOpenState}
              onActivateTree={openThreadRoot}
              onClickThread={clickThreadRow}
              shownTreeIds={shownTreeIds}
              onSelectBranch={selectBranch}
              onBranchContextMenu={openBranchMenu}
              moveTargets={moveTargetsOf(item.project.id)}
              activeProjectId={chatViewActive ? activeProjectId : null}
              focusedNodeId={chatViewActive ? focusedNodeId : null}
              archiveTree={archiveTree}
              unarchiveTree={unarchiveTree}
              pinTree={pinTree}
              unpinTree={unpinTree}
              renameTree={renameTree}
              deleteTree={deleteTree}
              moveTreeToWorkspace={moveTreeToWorkspace}
              renamingNodeId={renamingNodeId}
              onRenameNode={renameNode}
              onRenameEnd={endRename}
            />
          )),
        ];
      })}
      {hiddenCount > 0 && (
        <ActivityLoadMoreSentinel onLoadMore={() => setVisibleLimit((v) => v + ACTIVITY_PAGE_SIZE)} />
      )}
      {activityItems.length === 0 && agentRuns.length === 0 && (
        <div
          style={{
            padding: '40px 16px',
            textAlign: 'center',
            color: 'var(--term-muted)',
            fontSize: 'var(--fs-md)',
          }}
        >
          No activity yet
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

// ── Infinite-scroll sentinel ───────────────────────────────────────────────

/** Invisible element that triggers `onLoadMore` when it enters the viewport. */
function ActivityLoadMoreSentinel({ onLoadMore }: { onLoadMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMoreRef.current();
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} aria-hidden style={{ height: 1 }} />;
}

// ── Per-tree entry: ThreadRow + workspace label + BranchRow children ────────

function ActivityTreeEntry({
  resortDependency,
  resortTransition,
  item,
  isAlive,
  nodePinnedAt,
  isThreadExpandedFn,
  isBranchExpanded,
  isBranchSelected,
  isBranchMenuTarget,
  toggleThread,
  toggleBranch,
  getNodeOpenState,
  getSubtreeOpenState,
  onActivateTree,
  onClickThread,
  shownTreeIds,
  onSelectBranch,
  onBranchContextMenu,
  moveTargets,
  activeProjectId,
  focusedNodeId,
  archiveTree,
  unarchiveTree,
  pinTree,
  unpinTree,
  renameTree,
  deleteTree,
  moveTreeToWorkspace,
  renamingNodeId,
  onRenameNode,
  onRenameEnd,
}: {
  /** The list's re-sort motion (see RESORT_MOVE): rows glide only when this changes. */
  resortDependency: string;
  resortTransition: Transition;
  item: ActivityTree;
  isAlive: (id: string) => boolean;
  nodePinnedAt: NodePinnedAt;
  isThreadExpandedFn: (treeId: string, ownerActiveTreeId: string | null) => boolean;
  isBranchExpanded: (nodeId: string) => boolean;
  isBranchSelected: (nodeId: string) => boolean;
  isBranchMenuTarget: (nodeId: string) => boolean;
  toggleThread: (treeId: string) => void;
  toggleBranch: (nodeId: string) => void;
  getNodeOpenState: (id: string) => OpenState;
  getSubtreeOpenState: (rootId: string, edges: readonly ProjectEdge[]) => OpenState;
  onActivateTree: (tree: Tree, project: Project) => void;
  onClickThread: (tree: Tree, project: Project, event: React.MouseEvent | undefined, row: ThreadRowClick) => void;
  shownTreeIds: readonly string[];
  onSelectBranch: (nodeId: string, event: React.MouseEvent) => void;
  onBranchContextMenu: (nodeId: string, event: React.MouseEvent) => void;
  moveTargets: readonly MoveTargetWorkspace[];
  activeProjectId: string | null;
  focusedNodeId: string | null;
  archiveTree: (treeId: string) => void;
  unarchiveTree: (treeId: string) => void;
  pinTree: (treeId: string) => void;
  unpinTree: (treeId: string) => void;
  renameTree: (treeId: string, name: string, projectId?: string) => void;
  deleteTree: (treeId: string) => void;
  moveTreeToWorkspace: (treeId: string, targetProjectId: string) => void;
  renamingNodeId: string | null;
  onRenameNode: (nodeId: string, title: string) => void;
  onRenameEnd: () => void;
}) {
  const { prefs } = usePrefs();
  const geom = rowGeom(prefs.sidebarRowStyle, prefs.sidebarInset);
  const { tree, project } = item;
  const root = orderPinnedFirst(buildTree(tree.rootNodeId, project.edges, isAlive), nodePinnedAt);
  const hasBranches = root.children.length > 0;
  const isActive = tree.id === project.activeTreeId && project.id === activeProjectId;
  // In Activity view, threads default to expanded to show their branches
  const threadOpen = isThreadExpandedFn(tree.id, project.activeTreeId);
  const threadOpenState = getSubtreeOpenState(tree.rootNodeId, project.edges);

  return (
    <motion.div
      layout="position"
      layoutDependency={resortDependency}
      transition={resortTransition}
      style={{ marginTop: 'var(--sb-ws-gap, 6px)' }}
    >
      <ThreadRow
        tree={tree}
        projectId={project.id}
        isActive={isActive}
        hasBranches={hasBranches}
        expanded={threadOpen}
        openState={threadOpenState}
        onActivate={(e?: React.MouseEvent) =>
          onClickThread(tree, project, e, { hasBranches, expanded: threadOpen, isActive, shownTreeIds })}
        onToggleExpand={() => toggleThread(tree.id)}
        actions={{
          activateTree: (treeId) => {
            const t = project.trees.find((tt) => tt.id === treeId);
            if (t) onActivateTree(t, project);
          },
          archiveTree,
          unarchiveTree,
          pinTree,
          unpinTree,
          renameTree: (treeId, name) => renameTree(treeId, name, project.id),
          deleteTree,
          moveTreeToWorkspace: (treeId, targetProjectId) => {
            void moveTreeToWorkspace(treeId, targetProjectId);
          },
        }}
        moveTargets={moveTargets}
        subtitle={project.name}
      />
      {/* Workspace name. Card modes render it INSIDE the row (see ThreadRow's
          `subtitle`) so the focus fill covers both lines; classic keeps it as a
          sibling below. */}
      {!geom.subtitleInRow && (
      <div
        style={{
          fontSize: 'var(--fs-sm)',
          color: 'var(--term-muted)',
          fontFamily: 'var(--ui-font)',
          // Indent to align with the thread title text:
          // ThreadRow: borderLeft(2) + paddingLeft(8+inset) + chevron(12) + gap(5) = 27+inset
          // We match that alignment for the workspace subtitle
          padding: '0 calc(10px + var(--sb-inset, 0px)) 0 calc(27px + var(--sb-inset, 0px))',
          marginTop: -1,
          marginBottom: threadOpen && hasBranches ? 2 : 0,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          maskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
          WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
        }}
      >
        {project.name}
      </div>
      )}
      {/* Branches — same as Structure view */}
      {threadOpen && hasBranches && (
        <div
          style={{
            // No horizontal offset — branch rows keep the full row width and
            // carry the indent in their own padding, so a selected branch fills
            // edge to edge. And no vertical gap in card modes, or a selected
            // thread + selected first branch show a slot between them.
            marginTop: branchBlockGap(geom),
          }}
        >
          {root.children.map((child) => (
            <BranchRow
              key={child.nodeId}
              node={child}
              depth={1}
              expanded={isBranchExpanded(child.nodeId)}
              isFocused={(id) => id === focusedNodeId}
              isSelected={isBranchSelected}
              isExpanded={isBranchExpanded}
              isMenuTarget={isBranchMenuTarget}
              onToggle={toggleBranch}
              onSelect={onSelectBranch}
              onContextMenu={onBranchContextMenu}
              openState={getNodeOpenState(child.nodeId)}
              getOpenState={getNodeOpenState}
              renamingNodeId={renamingNodeId}
              onRenameNode={onRenameNode}
              onRenameEnd={onRenameEnd}
            />
          ))}
        </div>
      )}
    </motion.div>
  );
}
