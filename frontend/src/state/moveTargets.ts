import type { Project } from './chatTypes';
import { isLiveUserWorkspace } from './assistant/systemWorkspace';
import { sameBackendConnection } from '../config/backendConnections';

export interface MoveTargetWorkspace {
  id: string;
  name: string;
}

/** Workspaces a thread in `sourceProjectId` can move to: every one moveTreeToWorkspace accepts. */
export function moveTargetsFor(projects: readonly Project[], sourceProjectId: string): MoveTargetWorkspace[] {
  const source = projects.find((p) => p.id === sourceProjectId);
  if (!source) return [];
  return projects
    .filter((p) => p.id !== sourceProjectId && isLiveUserWorkspace(p) && sameBackendConnection(source, p))
    .map((p) => ({ id: p.id, name: p.name }));
}
