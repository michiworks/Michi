import { normalizeWorkspaceCwd } from '../../agents/tools/pathSandbox';
import { getWorkspace } from '../dbRepository';
import { skillsAvailable } from './paths';

/**
 * The folder whose project skills a workspace's chats see, or null when the
 * workspace is not the owner's. A workspace without a folder sees the
 * backend's own folder, or none (null) in cloud mode.
 */
export function workspaceSkillCwd(workspaceId: string, ownerUserId?: string | null): string | null {
  return workspaceSkillFolder(workspaceId, ownerUserId)?.cwd ?? null;
}

/**
 * The owner's workspace with the folder its chats run in (as for
 * workspaceSkillCwd), or null when no such workspace is the owner's. The
 * folder always comes from the workspace row, never from a request.
 */
export function workspaceSkillFolder(workspaceId: string, ownerUserId?: string | null): { cwd: string | null } | null {
  const workspace = getWorkspace(workspaceId, ownerUserId ?? undefined);
  if (!workspace) return null;
  if (workspace.cwd) return { cwd: normalizeWorkspaceCwd(workspace.cwd) };
  // A workspace without a folder (the default Chats) still runs its chats
  // somewhere: ensure-session opens them in the backend's own folder, so
  // their runtimes see that folder's skills and the user's own.
  return { cwd: skillsAvailable() ? normalizeWorkspaceCwd(process.cwd()) : null };
}
