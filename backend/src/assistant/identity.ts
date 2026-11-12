/**
 * Which workspaces and nodes belong to the Michi assistant. Every chat in an
 * assistant workspace (`settings.system = 'assistant'`) runs as the
 * assistant, current or archived, so none of them can become a worker.
 */

import { isAssistantWorkspaceSettings, isCheckinNodeId, isSystemWorkspaceSettings } from 'michi-shared';
import { getDb } from '../services/db';
import { getNode, getWorkspace, type WorkspaceRow } from '../services/dbRepository';
import type { AssistantPurpose } from './policy';

/**
 * The `meta` key recording an assistant conversation's purpose as the MVP
 * wrote it: 'schedule' (the Scheduled window's), 'companion' (the MVP's
 * pinned conversation, and every check-in node S, W2-G1a's
 * createCheckinNode: code from before v2 reads 'companion' as closed).
 */
export const assistantPurposeKey = (nodeId: string) => `assistant:purpose:${nodeId}`;

/** Recorded purposes that mean a closed conversation (DESIGN-v2 §2.2). Any other value, or none, is V's kind. */
const CHECKIN_PURPOSE_RECORDS: ReadonlySet<string> = new Set(['checkin', 'companion']);

/**
 * What an assistant conversation is for (DESIGN-v2 §2.2), fail closed:
 * a check-in node id (CHECKIN_NODE_PREFIX) is 'checkin' whatever its meta
 * says, or with no meta at all; so is a node recorded 'checkin' or
 * 'companion' (the MVP's conversation). Everything else (unrecorded,
 * 'spaces', 'schedule') is 'main'. Says nothing about whether the node is in
 * an assistant workspace: isAssistantNode does.
 */
export function assistantPurposeOf(nodeId: string | null | undefined): AssistantPurpose {
  if (!nodeId) return 'main';
  if (isCheckinNodeId(nodeId)) return 'checkin';
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(assistantPurposeKey(nodeId)) as { value: string } | undefined;
  return row && CHECKIN_PURPOSE_RECORDS.has(row.value) ? 'checkin' : 'main';
}

const jobCreatedKey = (nodeId: string) => `assistant:job-created:${nodeId}`;
const scheduleTurnKey = (nodeId: string) => `assistant:schedule-turn:${nodeId}`;

/**
 * The user sent V's turn `turnId` from the Scheduled area (its message
 * carried the Scheduled context): routes/michi.ts records it as the turn
 * starts. Only the latest such turn is kept; a job created in it is the one
 * "Create with agent" starts over for (W2 fix decision D6).
 */
export function noteAssistantScheduleTurn(nodeId: string, turnId: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(scheduleTurnKey(nodeId), turnId);
}

/** Whether `turnId` is the turn of `nodeId` the user last sent from the Scheduled area. */
export function isAssistantScheduleTurn(nodeId: string, turnId: string | null | undefined): boolean {
  if (!turnId) return false;
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(scheduleTurnKey(nodeId)) as { value: string } | undefined;
  return row?.value === turnId;
}

/**
 * A turn of an assistant conversation that the user sent from the Scheduled
 * area created a scheduled job (D6): the Scheduled page's "Create with agent"
 * then starts a new conversation. A job made from any other area leaves it.
 */
export function markAssistantJobCreated(nodeId: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(jobCreatedKey(nodeId), '1');
}

export function assistantJobCreated(nodeId: string): boolean {
  return Boolean(getDb().prepare('SELECT 1 FROM meta WHERE key = ?').get(jobCreatedKey(nodeId)));
}

/**
 * True for the assistant's hidden workspace (any of them). Always false in
 * cloud mode: the assistant reads every workspace and maintains Pages on
 * this machine, so it exists only in the local app.
 */
export function isAssistantWorkspace(workspaceId: string | null | undefined): boolean {
  if (!workspaceId || process.env.MICHI_CLOUD === '1') return false;
  return isAssistantWorkspaceSettings(getWorkspace(workspaceId)?.settings);
}

/** True for every chat node in an assistant workspace. */
export function isAssistantNode(nodeId: string | null | undefined): boolean {
  if (!nodeId) return false;
  const node = getNode(nodeId);
  return !!node && isAssistantWorkspace(node.workspace_id);
}

/**
 * A workspace the assistant may name: the owner's, not deleted and not a
 * system workspace, so its own conversations are never a target. Null
 * otherwise; each tool words its own "not found".
 */
export function assistantTargetWorkspace(ownerUserId: string | null | undefined, workspaceId: string): WorkspaceRow | null {
  const workspace = getWorkspace(workspaceId, ownerUserId ?? undefined);
  if (!workspace || workspace.deleted_at != null || isSystemWorkspaceSettings(workspace.settings)) return null;
  return workspace;
}

/** The assistantTargetWorkspace a live node is in; null for a deleted or missing node. */
export function assistantTargetWorkspaceOfNode(ownerUserId: string | null | undefined, nodeId: string): WorkspaceRow | null {
  const row = getDb().prepare('SELECT workspace_id FROM nodes WHERE id = ? AND deleted_at IS NULL').get(nodeId) as
    { workspace_id: string } | undefined;
  return row ? assistantTargetWorkspace(ownerUserId, row.workspace_id) : null;
}
