import { isSystemWorkspaceSettings } from 'michi-shared';
import { workspaceOwnerMatches } from '../agentOwner';

/**
 * Joins the owner's home page of the workspace row `workspace` as hp: its
 * hidden_at is set while the workspace is hidden from Spaces. Binds the owner.
 */
export function homeHiddenJoin(workspace: string): string {
  return `LEFT JOIN pages hp ON hp.workspace_id=${workspace}.id AND hp.role='workspace-home' AND hp.owner_user_id=? AND hp.deleted_at IS NULL`;
}

export interface HomeWorkspace {
  owner_user_id: string | null;
  settings: string | null;
  deleted_at: number | null;
  archived_at: number | null;
  purged_at: number | null;
  /** hp.hidden_at through homeHiddenJoin. */
  home_hidden_at: number | null;
}

function liveOwnedAndShown(workspace: HomeWorkspace, ownerUserId: string): boolean {
  return workspace.deleted_at === null && workspace.purged_at === null && workspace.archived_at === null
    && workspace.home_hidden_at === null && workspaceOwnerMatches(workspace.owner_user_id, ownerUserId);
}

/**
 * Whether the owner's Spaces Home may show what happens in a workspace: a
 * live, unarchived workspace of theirs that is not hidden from Spaces and is
 * not a system workspace (the Meta agent's or the assistant's). The Home's
 * conversation query applies the same rule in SQL.
 */
export function workspaceShownOnHome(workspace: HomeWorkspace, ownerUserId: string): boolean {
  return liveOwnedAndShown(workspace, ownerUserId) && !isSystemWorkspaceSettings(workspace.settings);
}

/** Whether a page may appear in the owner's Home lists: a live page of theirs in a workspace shown there, or their own Spaces Home. */
export function pageShownOnHome(
  page: { role: string | null; deleted_at: number | null; owner_user_id: string },
  workspace: HomeWorkspace,
  ownerUserId: string,
): boolean {
  if (page.deleted_at !== null || page.owner_user_id !== ownerUserId) return false;
  return liveOwnedAndShown(workspace, ownerUserId) && (!isSystemWorkspaceSettings(workspace.settings) || page.role === 'spaces-home');
}
