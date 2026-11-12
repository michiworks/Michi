// Per-workspace settings: the aiGlobalContext and Instructions keys of workspaces.settings,
// and the always-allow tool grants.
import { isAssistantWorkspaceSettings, parseWorkspaceSettings } from 'michi-shared';
import { getDb } from '../db';

// --- aiGlobalContext toggle (stored inside workspaces.settings JSON) ---

export function getAiGlobalContext(workspaceId: string, userId?: string): boolean {
  let sql = 'SELECT settings FROM workspaces WHERE id = ?';
  const params: string[] = [workspaceId];
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    sql += ' AND owner_user_id = ?';
    params.push(userId);
  }
  const row = getDb().prepare(sql).get(...params as [string, ...string[]]) as { settings: string | null } | undefined;
  if (!row?.settings) return true; // default ON
  // The Michi assistant's own workspace exists to navigate the others.
  if (isAssistantWorkspaceSettings(row.settings)) return true;
  return parseWorkspaceSettings(row.settings)?.aiGlobalContext !== false; // default ON unless explicitly false
}

export function setAiGlobalContext(workspaceId: string, on: boolean, userId?: string): void {
  const db = getDb();
  let sql = 'SELECT settings FROM workspaces WHERE id = ?';
  const params: string[] = [workspaceId];
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    sql += ' AND owner_user_id = ?';
    params.push(userId);
  }
  const row = db.prepare(sql).get(...params as [string, ...string[]]) as { settings: string | null } | undefined;
  const parsed = parseWorkspaceSettings(row?.settings) ?? {};
  // If cloud mode and userId was given, row will be null for non-owned workspaces — no-op.
  if (!row && process.env.MICHI_CLOUD === '1' && userId !== undefined) return;
  parsed.aiGlobalContext = on;
  const serialized = JSON.stringify(parsed);
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    db.prepare('UPDATE workspaces SET settings = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?')
      .run(serialized, Date.now(), workspaceId, userId);
  } else {
    db.prepare('UPDATE workspaces SET settings = ?, updated_at = ? WHERE id = ?')
      .run(serialized, Date.now(), workspaceId);
  }
}

// --- per-workspace system-prompt addendum (stored inside workspaces.settings JSON) ---

/** Returns the workspace's Instructions text, or null when unset/empty. The
 *  frontend keeps the field optional; the runtime should treat a null return
 *  as "no addendum, use the default system prompt only". */
export function getWorkspaceInstructions(workspaceId: string): string | null {
  const row = getDb()
    .prepare('SELECT settings FROM workspaces WHERE id = ?')
    .get(workspaceId) as { settings: string | null } | undefined;
  const value = parseWorkspaceSettings(row?.settings)?.instructions;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

// --- per-workspace, per-tool always-allow grants ---

export interface PermissionGrant {
  workspace_id: string;
  tool_name: string;
  granted_at: number;
}

export function listGrants(workspaceId: string): PermissionGrant[] {
  return getDb()
    .prepare(
      'SELECT workspace_id, tool_name, granted_at FROM workspace_permission_grants WHERE workspace_id = ? ORDER BY tool_name ASC',
    )
    .all(workspaceId) as unknown as PermissionGrant[];
}

export function revokePermission(workspaceId: string, toolName: string): void {
  getDb()
    .prepare(
      'DELETE FROM workspace_permission_grants WHERE workspace_id = ? AND tool_name = ?',
    )
    .run(workspaceId, toolName);
}
