import type { ChatNodeState, Project } from '../chatTypes';
import { hasUnseenCompletion } from '../completionFacts';
import { isListedThread, isVisibleConversationNode } from '../conversationVisibility';
import { threadDisplayTitle } from '../displayTitle';
import { isSystemWorkspace } from '../assistant/systemWorkspace';
import { buildBranchChildrenOf } from '../tree';

/** A conversation on Home's "Jump back in" (Q46): one card that opens it. */
export interface HomeRecentThread {
  projectId: string;
  treeId: string;
  rootNodeId: string;
  workspaceName: string;
  title: string;
  /**
   * What the conversation's own agent last wrote about a turn (the newest
   * branch overview entry of any of its branches), or null before one.
   */
  overview: string | null;
  /** A turn of it is running now. */
  running: boolean;
  /** A reply finished that the user has not looked at. */
  unread: boolean;
  /** Michi started it (one of its delegations). */
  startedByMichi: boolean;
  /** When the thread was last active. */
  at: number;
}

type HomeNode = Pick<ChatNodeState, 'kind' | 'status' | 'deletedAt' | 'title' | 'pageId' | 'maintenanceJobId' | 'scheduledOnlyJobId' | 'temporary'
  | 'branchOverviewEntries' | 'completionSeq' | 'seenCompletionSeq' | 'lastAssistantAt' | 'viewedAt'> & Partial<Pick<ChatNodeState, 'messages'>>;

/**
 * The user's most recently active conversations across their workspaces
 * (Tree.lastActiveAt, as ⌘K's Recent), newest first: the threads their lists
 * show, less temporary chats (Home recommends; it is not a list the user
 * looks things up in), with what each card says about it. `michiStarted`
 * holds the node ids of the conversations Michi started.
 */
export function selectHomeRecent(
  projects: readonly Project[],
  nodes: Readonly<Record<string, HomeNode | undefined>>,
  { limit = 3, michiStarted = new Set<string>() }: { limit?: number; michiStarted?: ReadonlySet<string> } = {},
): HomeRecentThread[] {
  const found: HomeRecentThread[] = [];
  for (const project of projects) {
    if (project.deletedAt || project.archivedAt || isSystemWorkspace(project)) continue;
    let childrenOf: ReadonlyMap<string, readonly string[]> | null = null;
    for (const tree of project.trees) {
      const root = nodes[tree.rootNodeId];
      if (!isListedThread(tree, root) || root?.temporary) continue;
      childrenOf ??= buildBranchChildrenOf(project.edges);
      let running = false;
      let unread = false;
      let startedByMichi = false;
      let overview: { at: number; text: string } | null = null;
      const seen = new Set<string>();
      const stack = [tree.rootNodeId];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const node = nodes[id];
        if (!node || node.deletedAt) continue;
        if (isVisibleConversationNode(node)) {
          running ||= node.status === 'streaming';
          unread ||= node.kind !== 'digest' && hasUnseenCompletion(node);
          startedByMichi ||= michiStarted.has(id);
          const entries = node.branchOverviewEntries ?? [];
          // Legacy entries have no time (0): the last one of a branch stands for it.
          const last = entries.reduce<{ at: number; text: string } | null>((best, entry) => (entry.text.trim() && (!best || entry.at >= best.at) ? entry : best), null);
          if (last && (!overview || last.at > overview.at)) overview = last;
        }
        for (const child of childrenOf.get(id) ?? []) stack.push(child);
      }
      found.push({
        projectId: project.id,
        treeId: tree.id,
        rootNodeId: tree.rootNodeId,
        workspaceName: project.name,
        title: threadDisplayTitle(tree, root, 'Untitled'),
        overview: overview ? overview.text.trim() : null,
        running,
        unread,
        startedByMichi,
        at: tree.lastActiveAt ?? tree.createdAt ?? 0,
      });
    }
  }
  return found.sort((a, b) => b.at - a.at).slice(0, limit);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2h ago" today, then "Yesterday", the weekday within a week, and "Nov 3" before. */
export function homeWhen(at: number, now: number): string {
  const day = new Date(now);
  const startOfToday = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  if (at >= startOfToday) {
    const minutes = Math.max(0, Math.floor((now - at) / 60_000));
    if (minutes < 1) return 'Just now';
    return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
  }
  const then = new Date(at);
  if (at >= startOfToday - 86_400_000) return 'Yesterday';
  if (at >= startOfToday - 6 * 86_400_000) return WEEKDAYS[then.getDay()]!;
  return `${MONTHS[then.getMonth()]} ${then.getDate()}`;
}

/** The card's small status line: what the thread is doing, or when it was last active. */
export function homeRecentStatus(thread: Pick<HomeRecentThread, 'running' | 'unread' | 'startedByMichi' | 'at'>, now: number, name: string): string {
  if (thread.running) return thread.startedByMichi ? `Started by ${name} · running` : 'Running';
  const when = homeWhen(thread.at, now);
  if (thread.unread) return `Done · ${when === 'Just now' || when === 'Yesterday' ? when.toLowerCase() : when}`;
  return thread.startedByMichi ? `Started by ${name} · ${when}` : when;
}
