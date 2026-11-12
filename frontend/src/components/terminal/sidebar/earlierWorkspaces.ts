import type { ChatNodeState, Project } from '../../../state/chatTypes';

/** A workspace untouched for this long folds into By project's Earlier group. */
export const EARLIER_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** The key of the Earlier group's open state in `sidebarExpanded.groups`. */
export const EARLIER_GROUP_KEY = 'earlier';

/** The latest thing that happened in a workspace: a thread's last activity, or its creation. */
export function workspaceLastActiveAt(project: Project): number {
  let latest = project.createdAt ?? 0;
  for (const tree of project.trees) if (tree.lastActiveAt > latest) latest = tree.lastActiveAt;
  return latest;
}

export interface EarlierContext {
  activeProjectId: string | null;
  now: number;
  nodes: Readonly<Record<string, ChatNodeState | undefined>>;
  /** Nodes shown in a pane right now. */
  openPaneIds: readonly string[];
  /** Nodes whose workflow or background agents still run after their turn. */
  workRunning: ReadonlySet<string>;
}

function isBusy(project: Project, ctx: EarlierContext): boolean {
  for (const id of ctx.openPaneIds) if (ctx.nodes[id]?.projectId === project.id) return true;
  for (const id of project.chatIds) {
    if (ctx.nodes[id]?.status === 'streaming' || ctx.workRunning.has(id)) return true;
  }
  return false;
}

/**
 * Whether a workspace belongs in Earlier: nothing happened in it for
 * EARLIER_AFTER_MS, and it is not the active workspace, not pinned, not on
 * screen in a pane and has nothing running.
 */
export function isEarlierWorkspace(project: Project, ctx: EarlierContext): boolean {
  if (project.id === ctx.activeProjectId || project.pinnedAt) return false;
  if (ctx.now - workspaceLastActiveAt(project) < EARLIER_AFTER_MS) return false;
  return !isBusy(project, ctx);
}

/** Splits workspaces into the ones Projects shows and the ones Earlier holds, each in the given order. */
export function splitEarlierWorkspaces(
  projects: readonly Project[],
  ctx: EarlierContext,
): { recent: Project[]; earlier: Project[] } {
  const recent: Project[] = [];
  const earlier: Project[] = [];
  for (const project of projects) (isEarlierWorkspace(project, ctx) ? earlier : recent).push(project);
  return { recent, earlier };
}
