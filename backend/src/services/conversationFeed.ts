import { ConversationUpdatesError } from 'michi-shared';
import { getDb } from './db';
import { liveConversationSql, liveNodeSql } from './nodeLifecycleSql';
import { notTemporaryChatSql } from './memory/temporaryChat';

export function conversationCompletionCounter(workspaceId: string): number {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?')
    .get(`conversation_completion_seq:${workspaceId}`) as { value: string } | undefined;
  const value = row ? Number(row.value) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new ConversationUpdatesError('cursor_invalid', 'Invalid workspace counter');
  return value;
}

// Archived, trashed and purged nodes, archived trees, Scheduled-only run threads and
// temporary chats (no reader of the feed is the temporary chat itself) are excluded.
const readableFrom = (live: string) => `FROM turns t JOIN nodes n ON n.id = t.node_id
  JOIN workspaces w ON w.id = n.workspace_id LEFT JOIN trees tr ON tr.id = n.tree_id
  WHERE n.workspace_id = ? AND w.deleted_at IS NULL AND w.purged_at IS NULL
    AND (? = 0 OR w.owner_user_id = ?) AND n.kind = 'chat'
    AND ${live}
    AND n.scheduled_only_job_id IS NULL AND ${notTemporaryChatSql('n')}
    AND t.status = 'completed' AND t.user_message_id IS NOT NULL`;
const READABLE_FROM = readableFrom(liveConversationSql({ node: 'n', tree: 'tr' }));
const READABLE_IN_ANY_TREE = readableFrom(liveNodeSql('n'));
const READABLE = `${READABLE_FROM} AND t.completion_seq > ? AND t.completion_seq <= ?`;

/**
 * The feed's predicate for a reader that adds conditions of its own
 * (automatic memory reads one conversation at a time): a FROM … WHERE clause
 * over turns t and nodes n with no ORDER or LIMIT, and its parameters. The
 * caller checks AI navigation (getAiGlobalContext) as readConversationUpdates does.
 * `archivedTrees`: archived threads' turns too (the assistant's: New
 * conversation archives V at once, and what V was told before still waits).
 */
export function readableTurnsFrom(workspaceId: string, ownerUserId: string | null, options: { archivedTrees?: boolean } = {}): {
  sql: string; params: Array<string | number | null>;
} {
  return { sql: options.archivedTrees ? READABLE_IN_ANY_TREE : READABLE_FROM, params: [workspaceId, process.env.MICHI_CLOUD === '1' ? 1 : 0, ownerUserId] };
}

/**
 * The completed turns in (after, through] that count as conversation input.
 * `from` ends inside its WHERE clause, so callers may append `AND ...` terms
 * (with their arguments after `args`), then GROUP BY / ORDER BY. Every reader of
 * the feed uses this: the scheduler requires maintenance plan sources to be
 * among the turns readConversationUpdates returns.
 */
export function readableCompletedTurns(input: { workspaceId: string; ownerUserId: string; after: number; through: number }):
  { from: string; args: Array<string | number> } {
  const cloud = process.env.MICHI_CLOUD === '1';
  return { from: READABLE, args: [input.workspaceId, cloud ? 1 : 0, input.ownerUserId, input.after, input.through] };
}
