import { fetchNodeWorkspace, fetchWorkspaceStructure } from '../../services/api/persistence';
import { namesRemoteEntity } from '../../config/backendIdentity';

/**
 * The workspace snapshot holding `nodeId`, for a thread this window doesn't
 * have yet: one created in another window since this one loaded, which the
 * assistant can name because it reads the backend. Asks the backend where
 * the node lives, then reads that one workspace's structure: its threads
 * install as placeholders whose bodies load when opened.
 *
 * Null only when the backend confirms there is no live thread by that id (a
 * deleted one, or one in a deleted workspace, included); throws when it
 * can't be asked, so the caller can try again. A remote connection's thread
 * throws too: this machine's backend can't answer for it, and only that
 * connection's own load brings it in. `readStartedAt` is when the workspace
 * read began, for installWorkspaceSnapshot.
 */
export async function fetchWorkspaceHoldingNode(
  nodeId: string,
  signal?: AbortSignal,
): Promise<{ workspace: unknown; readStartedAt: number } | null> {
  if (namesRemoteEntity(nodeId)) throw new Error('A remote thread loads with its connection');
  const where = await fetchNodeWorkspace(nodeId, signal);
  if (!where) return null;
  const readStartedAt = Date.now();
  const workspace = await fetchWorkspaceStructure(where.workspaceId, signal);
  // Its workspace went away after the lookup: no live thread either.
  return workspace === null ? null : { workspace, readStartedAt };
}
