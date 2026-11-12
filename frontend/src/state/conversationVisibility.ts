import type { ChatNodeState, Tree } from './chatTypes';

/** Whether a hydrated node belongs in ordinary conversation surfaces.
 * Page helpers remain in authoritative workspace state for embedded rendering,
 * but are hidden until promoted (the backend clears `page_id` on promotion).
 * Meta agent maintenance transcripts stay in state too, reachable from
 * Scheduled, and are never shown among the user's conversations. So do
 * Scheduled-only runs' threads, until the user moves one to its workspace
 * (the backend clears `scheduled_only_job_id`).
 * System workspace policy remains enforced by each surface as before. */
export function isVisibleConversationNode(
  node: Pick<ChatNodeState, 'pageId' | 'maintenanceJobId' | 'scheduledOnlyJobId'> | null | undefined,
): boolean {
  return !node?.pageId && !node?.maintenanceJobId && !node?.scheduledOnlyJobId;
}

type ThreadRoot = Pick<ChatNodeState, 'deletedAt' | 'pageId' | 'maintenanceJobId' | 'scheduledOnlyJobId'>;

/** Whether the user's thread lists show `tree`: it is not archived, and its
 * root is loaded, not in Trash, and a visible conversation. Surfaces keep
 * their own extra rules on top (the sidebar lists merge chats apart from
 * threads, Manage has an archived lane). */
export function isListedThread(
  tree: Pick<Tree, 'archivedAt'>,
  root: ThreadRoot | null | undefined,
): boolean {
  return !tree.archivedAt && !!root && !root.deletedAt && isVisibleConversationNode(root);
}

/** The thread to open when the open one is archived, deleted, trimmed or
 * moved away: the most recently active listed thread, the lowest id on a tie
 * (as dbRepository.moveTreeToWorkspace's SQL picks), or none. A helper's
 * thread is often the newest, and a chat opened beside it would join it,
 * out of the user's lists. */
export function pickLandingTreeId(
  trees: readonly Pick<Tree, 'id' | 'rootNodeId' | 'archivedAt' | 'lastActiveAt'>[],
  nodes: Readonly<Record<string, ThreadRoot | undefined>>,
): string | null {
  let best: (typeof trees)[number] | undefined;
  for (const tree of trees) {
    if (!isListedThread(tree, nodes[tree.rootNodeId])) continue;
    if (!best || tree.lastActiveAt > best.lastActiveAt || (tree.lastActiveAt === best.lastActiveAt && tree.id < best.id)) best = tree;
  }
  return best?.id ?? null;
}
