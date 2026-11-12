// SQL forms of shared/src/nodeLifecycle.ts. No database import, so agents/** may use them.
import { ARCHIVE_GROUP_PREFIX } from 'michi-shared';

/** A deletion group column that is not the archive lane: NULL or a Trash group. */
export function trashGroupSql(groupColumn: string): string {
  return `(${groupColumn} IS NULL OR ${groupColumn} NOT LIKE '${ARCHIVE_GROUP_PREFIX}%')`;
}

/** A deletion group column in the archive lane. */
export function archiveGroupSql(groupColumn: string): string {
  return `${groupColumn} LIKE '${ARCHIVE_GROUP_PREFIX}%'`;
}

/**
 * A live conversation node: not purged, not in Trash and not archived (the
 * archive lane also sets deleted_at; the older status; an archived thread).
 * Workspace terms, purpose filters and owner scoping stay with each query.
 */
export function liveConversationSql({ node, tree }: { node: string; tree: string }): string {
  return `${liveNodeSql(node)} AND ${tree}.archived_at IS NULL`;
}

/** liveConversationSql without the thread term: a live node of any thread, archived ones included. */
export function liveNodeSql(node: string): string {
  return `${node}.deleted_at IS NULL AND ${node}.purged_at IS NULL AND ${node}.status <> 'archived'`;
}
