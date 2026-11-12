export const LOCAL_AGENT_OWNER_ID = 'local-user';

/**
 * Desktop workspaces predate cloud ownership and persist NULL owners. On the
 * desktop every workspace in the local database is the local user's, as
 * listWorkspaces and getWorkspace treat it, including rows a cloud-mode run
 * left with its own owner id.
 */
export function workspaceOwnerMatches(storedOwnerUserId: string | null, ownerUserId: string): boolean {
  if (storedOwnerUserId === ownerUserId) return true;
  return process.env.MICHI_CLOUD !== '1' && ownerUserId === LOCAL_AGENT_OWNER_ID;
}

/** workspaceOwnerMatches as SQL over the workspace row `alias`; bind ownerMatchParams where it appears. */
export function ownerMatchSql(alias = 'w'): string {
  return `(${alias}.owner_user_id=? OR (?='${LOCAL_AGENT_OWNER_ID}' AND ?<>'1'))`;
}

export function ownerMatchParams(ownerUserId: string): string[] {
  return [ownerUserId, ownerUserId, process.env.MICHI_CLOUD ?? ''];
}

/** The owner a request acts for: the signed-in user in cloud mode ('' without one, which owns nothing), the local user on the desktop. */
export function requestAgentOwner(userId: string | undefined): string {
  return process.env.MICHI_CLOUD === '1' ? (userId ?? '') : LOCAL_AGENT_OWNER_ID;
}

/**
 * requestAgentOwner for callers that answer 401 without a user: null instead
 * of '' in cloud mode. Settings → Memory, the agents' memory tools and the
 * owner-filtered change feed all use it, so they agree on whose memory it is;
 * memoryTools.test.ts checks them against each other.
 */
export function requestAgentOwnerOrNull(userId: string | null | undefined): string | null {
  if (process.env.MICHI_CLOUD === '1') return typeof userId === 'string' ? userId.trim() || null : null;
  return LOCAL_AGENT_OWNER_ID;
}
