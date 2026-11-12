/**
 * Whether a chat may still take a turn the backend starts on its own: a
 * send_to_thread message or its wake reply, a multi-model step, an Agent Run
 * Watch wake, a scheduled run. Each caller maps the reason to its own codes.
 * The rule is the wake reply's (backend/src/docs/common-workflows.md): an
 * archived chat counts as archived even when its archive lane put it in
 * deleted_at, and a chat with no tree counts as not archived. As in
 * nodeLifecycleState, the Trash beats the archive: a chat put in the Trash
 * inside an archived thread is in the Trash.
 */
import { isArchiveGroupId } from 'michi-shared';
import { getWorkspace, type NodeRow } from './dbRepository';
import { isArchivedPaneNode } from './paneInspection';

export type ChatNodeUnavailable = 'gone' | 'not_chat' | 'archived' | 'trashed';
export type ChatTargetUnavailable = ChatNodeUnavailable | 'workspace_archived' | 'workspace_trashed' | 'moved';

/** The chat's own state; null when it may take the turn as far as the chat goes. */
export function chatNodeUnavailable(node: NodeRow | null): ChatNodeUnavailable | null {
  if (!node || node.purged_at != null) return 'gone';
  if (node.kind !== 'chat') return 'not_chat';
  if (node.deleted_at != null && !isArchiveGroupId(node.deletion_group_id)) return 'trashed';
  if (isArchivedPaneNode(node)) return 'archived';
  return null;
}

/** The chat's own state, then its workspace's, then (when given) that it is still in `expectedWorkspaceId`. */
export function chatTargetUnavailable(node: NodeRow | null, expectedWorkspaceId?: string): ChatTargetUnavailable | null {
  if (!node) return 'gone';
  const own = chatNodeUnavailable(node);
  if (own) return own;
  const workspace = getWorkspace(node.workspace_id);
  if (!workspace) return 'gone';
  if (workspace.archived_at != null) return 'workspace_archived';
  if (workspace.deleted_at != null) return 'workspace_trashed';
  if (expectedWorkspaceId !== undefined && node.workspace_id !== expectedWorkspaceId) return 'moved';
  return null;
}
