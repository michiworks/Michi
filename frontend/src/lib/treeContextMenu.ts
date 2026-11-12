import type { MenuSection } from '../components/ContextMenu';
import type { ChatNodeState, Project } from '../state/chatStore';
import { findTreeIdForNode } from '../state/tree';

import { requestDigest } from './digestPrompt';

export interface TreeMenuActions {
  openPane: (id: string) => void;
  createBlankChild: (parentId: string) => Promise<unknown> | void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  deleteNode: (id: string) => void;
  /** Trim a single node out of the conversation, reparenting its children up.
   *  See chatStore for semantics; restore reverses via the trimSnapshot. */
  trimNode: (id: string) => void;
  extractNodeTree?: (id: string) => Promise<unknown>;
  /** Archive a single node (same mechanics as trim, routed to the Archived
   *  surface instead of Trash). */
  archiveNode: (id: string) => void;
  /** Merge ≥2 nodes into a new woven chat node. */
  createMergedChat: (sourceIds: string[]) => Promise<string>;
  /** Create a digest covering the given chat nodes. */
  createDigest: (projectId: string, sourceIds: string[], customPrompt?: string) => Promise<string>;
  /** Open the export panel for the given nodes. */
  openExportPanel: (ids: string[]) => void;
  /** Archive a tree by its tree id. Used by the multi-select menu when every
   *  selected node is the root of a live tree. */
  archiveTree: (treeId: string) => void;
  /** Open the pane for the given node (called after creating a digest). */
  focusOrOpen: (id: string) => void;
  /** Begin inline rename for a node. Without it the menu offers no Rename. */
  beginInlineRename?: (id: string) => void;
  /** Toggle the node-level sidebar pin. Both must be supplied for the
   *  Pin/Unpin item to appear. Not offered on tree roots, which pin at
   *  the thread level instead (see threadRowContextMenu). */
  pinNode?: (id: string) => void;
  unpinNode?: (id: string) => void;
}

/** Rules a surface adds to the store's for Weave and Digest. The Map applies
 *  both; the sidebar's cross-thread selection keeps the store's rules. */
export interface SelectionRules {
  /** Refuse while a selected chat is streaming. */
  requireIdle?: boolean;
  /** Refuse when the selected chats span threads. */
  requireSingleThread?: boolean;
}

export interface SelectionActionState {
  chatIds: string[];
  hasStreaming: boolean;
  spansThreads: boolean;
  canWeave: boolean;
  /** Why Weave is refused; absent when it is allowed. */
  weaveReason?: string;
  canDigest: boolean;
  /** Why Digest is refused; absent when it is allowed. */
  digestReason?: string;
}

/** Which of `ids` Weave and Digest act on, and whether they may. */
export function selectionActionState({
  ids,
  project,
  nodes,
  requireIdle = false,
  requireSingleThread = false,
}: {
  ids: readonly string[];
  project: Project;
  nodes: Record<string, ChatNodeState>;
} & SelectionRules): SelectionActionState {
  const chatIds = ids.filter((id) => nodes[id]?.kind === 'chat');
  const hasStreaming = chatIds.some((id) => nodes[id]?.status === 'streaming');
  const treeIds = chatIds.map((id) => findTreeIdForNode(id, project));
  const spansThreads = treeIds.some((id) => !id) || new Set(treeIds).size > 1;
  const blocked = requireIdle && hasStreaming
    ? 'streaming'
    : requireSingleThread && spansThreads
      ? 'threads'
      : null;
  const weaveReason = blocked === 'streaming'
    ? 'Wait for streaming to finish before merging.'
    : blocked === 'threads'
      ? 'Merge requires nodes from a single thread.'
      : chatIds.length < 2
        ? 'Select at least two nodes to merge.'
        : undefined;
  const digestReason = blocked === 'streaming'
    ? 'Wait for streaming to finish before creating a digest.'
    : blocked === 'threads'
      ? 'Digest requires nodes from a single thread.'
      : chatIds.length < 1
        ? 'Select at least one chat to digest.'
        : undefined;
  return {
    chatIds,
    hasStreaming,
    spansThreads,
    canWeave: !weaveReason,
    weaveReason,
    canDigest: !digestReason,
    digestReason,
  };
}

/**
 * Build the context-menu sections for a right-click on a tree row.
 *
 * `targetId` is the node that was right-clicked. If it belongs to the
 * current `selection`, the menu treats the whole selection as the target.
 * If it's outside the selection, the menu applies to the single target
 * only — even if there is a multi-selection. This matches Finder behavior.
 */
export function buildTreeContextMenu({
  targetId,
  project,
  nodes,
  selection,
  actions,
  rules,
  digestEnabled = false,
}: {
  targetId: string;
  project: Project;
  nodes: Record<string, ChatNodeState>;
  selection: ReadonlySet<string>;
  actions: TreeMenuActions;
  rules?: SelectionRules;
  /** Settings › Digest; the multi-select "Digest from N chats" item needs it on. */
  digestEnabled?: boolean;
}): MenuSection[] {
  const rootIds = new Set(project.trees.map((tree) => tree.rootNodeId));
  const targetIsSelected = selection.has(targetId);
  const scope: string[] = targetIsSelected && selection.size >= 2
    ? Array.from(selection)
    : [targetId];
  const isMulti = scope.length >= 2;
  const anyRoot = scope.some((id) => rootIds.has(id));

  // Map live tree-root nodeId → tree id. Used to decide whether the multi-
  // selection is "all roots" (i.e. archive-able as a batch).
  const treeIdByRoot = new Map<string, string>();
  for (const t of project.trees) {
    if (t.archivedAt) continue;
    treeIdByRoot.set(t.rootNodeId, t.id);
  }
  const allRoots = isMulti && scope.every((id) => treeIdByRoot.has(id));

  if (isMulti) {
    const state = selectionActionState({ ids: scope, project, nodes, ...rules });
    const chatScope = state.chatIds;
    const sections: MenuSection[] = [
      {
        items: [
          {
            id: 'weave',
            label: `Weave ${chatScope.length} chats`,
            sublabel: state.weaveReason,
            keys: 'W',
            disabled: !state.canWeave,
            run: () => {
              void actions.createMergedChat(chatScope).then((newId) => {
                actions.focusOrOpen(newId);
                actions.clearSelection();
              }).catch(() => {});
            },
          },
          ...(digestEnabled ? [{
            id: 'digest',
            label: `Digest from ${chatScope.length} chats`,
            sublabel: state.digestReason,
            keys: 'G',
            disabled: !state.canDigest,
            run: () => {
              requestDigest(project.id, chatScope);
              actions.clearSelection();
            },
          }] : []),
          {
            id: 'export',
            label: `Export ${scope.length} selected`,
            keys: 'E',
            run: () => actions.openExportPanel(scope),
          },
        ],
      },
      {
        items: [
          ...(allRoots
            ? [
                {
                  id: 'archive',
                  label: `Archive ${scope.length} threads`,
                  keys: 'A',
                  run: () => {
                    for (const id of scope) {
                      const treeId = treeIdByRoot.get(id);
                      if (treeId) actions.archiveTree(treeId);
                    }
                    actions.clearSelection();
                  },
                },
              ]
            : []),
          ...(allRoots
            ? [] // all-roots is handled by "Archive N threads" above
            : [
                {
                  // Archive each selected node out of the conversation
                  // (children slide up). Tree roots are skipped — same
                  // protection as bulk delete.
                  id: 'archive-nodes',
                  label: anyRoot
                    ? `Archive ${scope.length} (root excluded)`
                    : `Archive ${scope.length}`,
                  run: () => {
                    for (const id of scope) {
                      if (rootIds.has(id)) continue;
                      actions.archiveNode(id);
                    }
                    actions.clearSelection();
                  },
                },
              ]),
          {
            id: 'clear',
            label: 'Clear selection',
            keys: 'esc',
            run: actions.clearSelection,
          },
          {
            id: 'delete',
            label: anyRoot
              ? `Delete ${scope.length} (root excluded)`
              : `Delete ${scope.length} nodes`,
            danger: true,
            keys: 'D',
            run: () => {
              for (const id of scope) {
                if (rootIds.has(id)) continue;
                actions.deleteNode(id);
              }
              actions.clearSelection();
            },
          },
        ],
      },
    ];
    return sections;
  }

  // Single target
  const isRoot = rootIds.has(targetId);
  const isChat = nodes[targetId]?.kind === 'chat';
  const owningTree = project.trees.find(t => t.id === findTreeIdForNode(targetId, project));
  const canExtract = isChat && !!actions.extractNodeTree && !!owningTree
    && owningTree.rootNodeId !== targetId && !owningTree.archivedAt
    && !project.archivedAt && !project.deletedAt && !nodes[targetId]?.deletedAt;
  const canPin = !isRoot && !!actions.pinNode && !!actions.unpinNode;
  const pinned = !!nodes[targetId]?.pinnedAt;

  return [
    {
      items: [
        {
          id: 'open',
          label: 'Open in pane',
          keys: 'O',
          run: () => actions.openPane(targetId),
        },
        ...(actions.beginInlineRename
          ? [{ id: 'rename', label: 'Rename…', keys: 'R', run: () => actions.beginInlineRename!(targetId) }]
          : []),
        ...(canPin
          ? [
              pinned
                ? { id: 'unpin', label: 'Unpin', keys: 'P', run: () => actions.unpinNode!(targetId) }
                : { id: 'pin', label: 'Pin', keys: 'P', run: () => actions.pinNode!(targetId) },
            ]
          : []),
        {
          id: 'branch',
          label: 'Branch new chat',
          keys: 'B',
          disabled: !isChat,
          run: () => {
            void Promise.resolve(actions.createBlankChild(targetId)).catch(() => {});
          },
        },
        ...(canExtract ? [{
          id: 'extract-tree', label: 'Extract as new thread',
          disabled: nodes[targetId]?.status === 'streaming',
          run: () => { void actions.extractNodeTree!(targetId); },
        }] : []),
      ],
    },
    {
      items: [
        {
          id: 'select',
          label: targetIsSelected ? 'Deselect' : 'Select',
          keys: 'S',
          run: () => actions.toggleSelection(targetId),
        },
        {
          // "Trim" prunes the single node out of the conversation, sliding
          // its children up. Always allowed — the tree-root case promotes
          // the oldest live child and stays a single-rooted tree (Option A).
          id: 'trim',
          label: 'Trim node',
          keys: 'T',
          run: () => actions.trimNode(targetId),
        },
        {
          // "Archive" is trim that lands in the Archived surface (durable,
          // restorable) instead of Trash. Children slide up either way.
          id: 'archive',
          label: 'Archive',
          keys: 'A',
          run: () => actions.archiveNode(targetId),
        },
        {
          // "Delete" sends the whole subtree to trash. Root is protected
          // because deleting the entire tree this way would leave the
          // workspace with one fewer tree silently — users who want that
          // should use "Archive thread" or empty the workspace.
          id: 'delete',
          label: isRoot ? 'Delete subtree (root protected)' : 'Delete subtree',
          danger: true,
          keys: 'D',
          disabled: isRoot,
          run: () => actions.deleteNode(targetId),
        },
      ],
    },
  ];
}
