/**
 * Prefix of the deletion group that archives a single node. Archive reuses the
 * trim engine (deleted_at set, children reparented, restorable snapshot); this
 * prefix sends the node to Settings › Archived instead of Trash and keeps it
 * out of the trash-only flows (TTL sweep, empty Trash, ⌘Z). The frontend mints
 * these ids and the backend reads them, so both take the prefix from here.
 */
export const ARCHIVE_GROUP_PREFIX = 'arch-';

/** Whether a deletion group is the archive lane rather than Trash. */
export function isArchiveGroupId(groupId: string | null | undefined): boolean {
  return !!groupId && groupId.startsWith(ARCHIVE_GROUP_PREFIX);
}

export type NodeLifecycleState = 'live' | 'archived' | 'trashed' | 'purged';

/** A node's columns and those of its thread and workspace; leave out what a caller does not read. */
export interface NodeLifecycleFacts {
  purgedAt?: number | null;
  deletedAt?: number | null;
  deletionGroupId?: string | null;
  /** nodes.status: 'archived' is an older way to archive a node. */
  status?: string | null;
  treeArchivedAt?: number | null;
  workspaceArchivedAt?: number | null;
  workspaceDeletedAt?: number | null;
}

/**
 * Where a conversation node stands. Purged beats Trash, and Trash beats
 * archived: a thread moved to Trash while archived is in Trash.
 */
export function nodeLifecycleState(facts: NodeLifecycleFacts): NodeLifecycleState {
  if (facts.purgedAt != null) return 'purged';
  if (facts.workspaceDeletedAt != null || (facts.deletedAt != null && !isArchiveGroupId(facts.deletionGroupId))) return 'trashed';
  if (facts.deletedAt != null || facts.status === 'archived' || facts.treeArchivedAt != null || facts.workspaceArchivedAt != null) return 'archived';
  return 'live';
}
