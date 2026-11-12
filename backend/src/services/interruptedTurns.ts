import {
  INTERRUPTED_TURN_LIMITS,
  isSystemWorkspaceSettings,
  turnInterruptionCause,
  type InterruptedTurnV1,
  type InterruptedTurnsDto,
} from 'michi-shared';
import { getDb } from './db';

/**
 * The conversations whose latest turn was interrupted (shared/src/interruptedTurns.ts):
 * Michi restarted under it, or the agent's credentials expired. Listed for
 * the owner across every live workspace until the conversation moves on (a
 * Resume or any new turn becomes its latest turn) or the user dismisses it.
 *
 * Left out, as on the Spaces Home: trashed, archived and purged conversations
 * and workspaces, archived threads, background maintenance and scheduled-only
 * chats, turns a Scheduled Job sent (the scheduler reports its runs), the
 * hidden system workspaces, and multi-model run turns (`mm-` ids: the run
 * owns their outcome). A conversation that got a newer message after the
 * failure is the user carrying on by hand.
 */

const TITLE_MAX = 120;
/** Dismissed turn ids kept per owner, newest last. */
const DISMISSED_KEEP = 500;

/** The workspace is the owner's (on a local backend, the local user owns them all). Params: owner, owner, MICHI_CLOUD. */
const OWNER_SQL = "(w.owner_user_id=? OR (?='local-user' AND ?<>'1'))";
const SCHEDULED_SQL = "COALESCE(json_extract(CASE WHEN json_valid(um.metadata) THEN um.metadata ELSE '{}' END,'$.scheduledJobId'),'')";

type CandidateRow = {
  turn_id: string; node_id: string; workspace_id: string; workspace_name: string; workspace_settings: string | null;
  title: string | null; first_user: string | null; error: string | null; completed_at: number | null; updated_at: number;
};

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const dismissedKey = (ownerUserId: string) => `interrupted_turns_dismissed:${ownerUserId}`;

function readDismissed(ownerUserId: string): string[] {
  const row = getDb().prepare('SELECT value FROM meta WHERE key=?').get(dismissedKey(ownerUserId)) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function listInterruptedTurns(ownerUserId: string, now = Date.now()): InterruptedTurnsDto {
  const since = now - INTERRUPTED_TURN_LIMITS.maxAgeMs;
  const rows = getDb().prepare(`SELECT t.turn_id,t.node_id,n.workspace_id,w.name AS workspace_name,w.settings AS workspace_settings,
      n.title,t.error,t.completed_at,t.updated_at,
      CASE WHEN trim(COALESCE(n.title,''))='' THEN (SELECT f.content FROM messages f WHERE f.node_id=n.id AND f.role='user'
        AND trim(f.content)<>'' ORDER BY f.seq LIMIT 1) END AS first_user
    FROM turns t JOIN nodes n ON n.id=t.node_id JOIN workspaces w ON w.id=n.workspace_id
    LEFT JOIN trees tr ON tr.id=n.tree_id
    LEFT JOIN messages um ON um.id=t.user_message_id AND um.node_id=n.id
    WHERE t.status='error' AND COALESCE(t.completed_at,t.updated_at)>=? AND substr(t.turn_id,1,3)<>'mm-'
      AND t.turn_id=(SELECT l.turn_id FROM turns l WHERE l.node_id=n.id ORDER BY l.started_at DESC,l.rowid DESC LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM messages r WHERE r.node_id=n.id AND r.role='user' AND r.id IS NOT t.user_message_id
        AND r.created_at>COALESCE(t.completed_at,t.updated_at))
      AND n.kind='chat' AND n.deleted_at IS NULL AND n.purged_at IS NULL AND n.status<>'archived'
      AND n.maintenance_job_id IS NULL AND n.scheduled_only_job_id IS NULL
      AND tr.archived_at IS NULL AND w.deleted_at IS NULL AND w.purged_at IS NULL AND w.archived_at IS NULL
      AND ${OWNER_SQL} AND ${SCHEDULED_SQL}=''
    ORDER BY COALESCE(t.completed_at,t.updated_at) DESC`)
    .all(since, ownerUserId, ownerUserId, process.env.MICHI_CLOUD ?? '') as unknown as CandidateRow[];
  const dismissed = new Set(readDismissed(ownerUserId));
  const items: InterruptedTurnV1[] = [];
  for (const row of rows) {
    if (items.length >= INTERRUPTED_TURN_LIMITS.items) break;
    if (dismissed.has(row.turn_id) || isSystemWorkspaceSettings(row.workspace_settings)) continue;
    if (!turnInterruptionCause(row.error)) continue;
    const title = row.title?.trim() || oneLine((row.first_user ?? '').split('\n')[0] ?? '', TITLE_MAX) || 'Untitled conversation';
    items.push({
      turnId: row.turn_id,
      nodeId: row.node_id,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      title,
      interruptedAt: row.completed_at ?? row.updated_at,
    });
  }
  return { items };
}

/**
 * Stops listing the turn for this owner. False when it is not one of the
 * owner's turns; dismissing one twice is fine.
 */
export function dismissInterruptedTurn(ownerUserId: string, turnId: string): boolean {
  const db = getDb();
  const owned = db.prepare(`SELECT 1 FROM turns t JOIN nodes n ON n.id=t.node_id JOIN workspaces w ON w.id=n.workspace_id
    WHERE t.turn_id=? AND ${OWNER_SQL}`).get(turnId, ownerUserId, ownerUserId, process.env.MICHI_CLOUD ?? '');
  if (!owned) return false;
  const ids = readDismissed(ownerUserId).filter((id) => id !== turnId);
  ids.push(turnId);
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(dismissedKey(ownerUserId), JSON.stringify(ids.slice(-DISMISSED_KEEP)));
  return true;
}
