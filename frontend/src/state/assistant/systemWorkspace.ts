import type { Project } from '../chatTypes';

/**
 * Workspaces the backend creates for Michi itself carry `settings.system`
 * (today only `'assistant'`: the ⌘J assistant's conversation). They hold real
 * nodes, so panes and navigation still resolve them, but nothing that lists
 * workspaces to the user shows them. Hydration reads the flag with shared
 * workspaceSystemOf, the backend's rule.
 */

export function isSystemWorkspace(project: Pick<Project, 'system'> | null | undefined): boolean {
  return !!project?.system;
}

/** Neither trashed, archived nor a system workspace: one a window may open on. */
export function isLiveUserWorkspace(project: Project | null | undefined): project is Project {
  return !!project && !project.deletedAt && !project.archivedAt && !isSystemWorkspace(project);
}

/** The first live user workspace, other than `exceptId`; null when there is none. */
export function firstLiveUserWorkspaceId(projects: readonly Project[], exceptId?: string): string | null {
  return projects.find((project) => project.id !== exceptId && isLiveUserWorkspace(project))?.id ?? null;
}

/** The user's own workspaces. Returns `projects` itself when none is a system workspace. */
export function withoutSystemWorkspaces<T extends Pick<Project, 'system'>>(projects: readonly T[]): T[] {
  return projects.some(isSystemWorkspace)
    ? projects.filter((project) => !isSystemWorkspace(project))
    : (projects as T[]);
}

export function systemWorkspaceIds(projects: readonly Pick<Project, 'id' | 'system'>[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const project of projects) if (isSystemWorkspace(project)) ids.add(project.id);
  return ids;
}
