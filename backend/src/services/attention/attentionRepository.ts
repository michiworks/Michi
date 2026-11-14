import { randomUUID } from 'node:crypto';
import {
  deriveConversationTitle,
  isAssistantWorkspaceSettings,
  nodeLifecycleState,
  oneLine,
  parseAttentionOpenTarget,
  type AttentionClaimResultV1,
  type AttentionKind,
  type AttentionNotificationV1,
  type AttentionReason,
  type AttentionResolveReason,
  type AttentionResolvedV1,
  type AttentionStatus,
  type AttentionTargetV1,
} from 'michi-shared';
import { getDb, runInTransaction } from '../db';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';

/**
 * The attention service's queries (attentionService.ts): the
 * attention_notifications records and the node and turn facts they are
 * decided from (migrations 0064, 0087); the wake records it reads are in
 * attentionWakeFacts.ts. Record queries are owner-scoped, except the upkeep
 * that follows a target (moved or purged), whatever owner holds its records.
 */

interface AttentionRow {
  id: string;
  owner_user_id: string;
  workspace_id: string;
  target_type: AttentionTargetV1['type'];
  target_id: string;
  /** agent: the CompanionTarget a click opens; scheduled_run: {jobId, nodeId}; null otherwise. */
  target_detail: string | null;
  key: string;
  fact: string;
  kind: AttentionKind;
  reason: AttentionReason;
  title: string;
  body: string;
  created_at: number;
  status: AttentionStatus;
  resolve_reason: AttentionResolveReason | null;
  claimed_by_window_id: string | null;
  claimed_at: number | null;
  resolved_at: number | null;
}

export interface StoredAttention {
  id: string;
  ownerUserId: string;
  key: string;
  fact: string;
  kind: AttentionKind;
  reason: AttentionReason;
  title: string;
  body: string;
  target: AttentionTargetV1;
  createdAt: number;
  status: AttentionStatus;
  resolveReason: AttentionResolveReason | null;
  claimedByWindowId: string | null;
  claimedAt: number | null;
  resolvedAt: number | null;
}

export interface NewAttention {
  ownerUserId: string;
  key: string;
  fact: string;
  kind: AttentionKind;
  reason: AttentionReason;
  title: string;
  body: string;
  target: AttentionTargetV1;
  createdAt: number;
}

/** What the service needs to know about a chat node to decide about it. */
export interface NodeAttentionFacts {
  nodeId: string;
  /** The workspace that holds the node now. */
  workspaceId: string;
  ownerUserId: string;
  /** The thread's name for its root node when the thread has one, else the node's title, else its first message. */
  title: string | null;
  /**
   * Not a place to call the user to: the node, its tree or its workspace is
   * in the trash or archived, or it is a scheduled maintenance transcript.
   */
  hidden: boolean;
  /** A conversation of the agent's own (V, in the assistant's workspace; local only): it speaks under the agent's name. */
  assistant: boolean;
  completionSeq: number;
  seenCompletionSeq: number;
  lastCompletedTurnId: string | null;
}

/** A workspace as a record's target: `gone` once purged (or missing), `hidden` in the trash or archived. */
export type AttentionWorkspaceState = 'live' | 'hidden' | 'gone';

const TITLE_MAX = 200;
const BODY_MAX = 500;

function detailOf(row: AttentionRow): Record<string, unknown> {
  try {
    const parsed: unknown = row.target_detail === null ? null : JSON.parse(row.target_detail);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function targetOf(row: AttentionRow): AttentionTargetV1 {
  switch (row.target_type) {
    case 'node':
      return { type: 'node', nodeId: row.target_id, workspaceId: row.workspace_id };
    case 'agent_run':
      return { type: 'agent_run', runId: row.target_id, workspaceId: row.workspace_id };
    case 'agent':
      // A detail this build cannot read opens the agent's conversation.
      return { type: 'agent', ref: row.target_id, open: parseAttentionOpenTarget(detailOf(row)) ?? { kind: 'companion', tab: 'chat' }, workspaceId: row.workspace_id };
    case 'scheduled_run': {
      const detail = detailOf(row);
      return {
        type: 'scheduled_run',
        runId: row.target_id,
        jobId: typeof detail.jobId === 'string' ? detail.jobId : '',
        nodeId: typeof detail.nodeId === 'string' && detail.nodeId ? detail.nodeId : null,
        workspaceId: row.workspace_id,
      };
    }
  }
}

function targetDetailOf(target: AttentionTargetV1): string | null {
  if (target.type === 'agent') return JSON.stringify(target.open);
  if (target.type === 'scheduled_run') return JSON.stringify({ jobId: target.jobId, nodeId: target.nodeId });
  return null;
}

function fromRow(row: AttentionRow): StoredAttention {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    key: row.key,
    fact: row.fact,
    kind: row.kind,
    reason: row.reason,
    title: row.title,
    body: row.body,
    target: targetOf(row),
    createdAt: row.created_at,
    status: row.status,
    resolveReason: row.resolve_reason,
    claimedByWindowId: row.claimed_by_window_id,
    claimedAt: row.claimed_at,
    resolvedAt: row.resolved_at,
  };
}

export function toAttentionNotification(record: StoredAttention): AttentionNotificationV1 {
  return {
    id: record.id,
    key: record.key,
    kind: record.kind,
    reason: record.reason,
    title: record.title,
    body: record.body,
    target: record.target,
    createdAt: record.createdAt,
    claimedByWindowId: record.claimedByWindowId,
    claimedAt: record.claimedAt,
  };
}

export function toAttentionResolved(record: StoredAttention): AttentionResolvedV1 {
  return {
    id: record.id,
    key: record.key,
    target: record.target,
    reason: record.resolveReason ?? 'stale',
    resolvedAt: record.resolvedAt ?? record.createdAt,
  };
}

/** The owner attention records of a workspace belong to: its account in the
 *  cloud, the one local user on the desktop (as presence and the feed see it). */
export function attentionOwnerOf(storedOwnerUserId: string | null): string | null {
  if (process.env.MICHI_CLOUD === '1') return storedOwnerUserId || null;
  return LOCAL_AGENT_OWNER_ID;
}

export class AttentionRepository {
  constructor(private readonly newId: () => string = () => `attn-${randomUUID()}`) {}

  /**
   * Makes `record` the active record of its key. The key's previous active
   * record is resolved as superseded in the same transaction. Returns null,
   * writing nothing, when this fact was already recorded under the key in any
   * status: an event observed twice (a replay, a redelivered Run watch) is
   * delivered once.
   */
  insertReplacing(record: NewAttention): { created: StoredAttention; superseded: StoredAttention | null } | null {
    return runInTransaction(() => {
      const db = getDb();
      const duplicate = db.prepare('SELECT 1 FROM attention_notifications WHERE owner_user_id = ? AND key = ? AND fact = ?')
        .get(record.ownerUserId, record.key, record.fact);
      if (duplicate) return null;
      const previous = db.prepare(`SELECT * FROM attention_notifications
        WHERE owner_user_id = ? AND key = ? AND status = 'active'`).get(record.ownerUserId, record.key) as AttentionRow | undefined;
      if (previous) {
        db.prepare(`UPDATE attention_notifications SET status = 'resolved', resolve_reason = 'superseded', resolved_at = ?
          WHERE id = ? AND status = 'active'`).run(record.createdAt, previous.id);
      }
      const id = this.newId();
      const targetId = targetIdOf(record.target);
      db.prepare(`INSERT INTO attention_notifications
        (id, owner_user_id, workspace_id, target_type, target_id, target_detail, key, fact, kind, reason, title, body, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`).run(
        id, record.ownerUserId, record.target.workspaceId, record.target.type, targetId, targetDetailOf(record.target), record.key,
        record.fact, record.kind, record.reason, oneLine(record.title, TITLE_MAX), oneLine(record.body, BODY_MAX), record.createdAt,
      );
      return {
        created: this.byId(id)!,
        superseded: previous ? this.byId(previous.id) : null,
      };
    });
  }

  private byId(id: string): StoredAttention | null {
    const row = getDb().prepare('SELECT * FROM attention_notifications WHERE id = ?').get(id) as AttentionRow | undefined;
    return row ? fromRow(row) : null;
  }

  get(ownerUserId: string, id: string): StoredAttention | null {
    const row = getDb().prepare('SELECT * FROM attention_notifications WHERE id = ? AND owner_user_id = ?')
      .get(id, ownerUserId) as AttentionRow | undefined;
    return row ? fromRow(row) : null;
  }

  /** The owner's active records, oldest first. */
  listActive(ownerUserId: string): StoredAttention[] {
    return (getDb().prepare(`SELECT * FROM attention_notifications
      WHERE owner_user_id = ? AND status = 'active' ORDER BY created_at, id`).all(ownerUserId) as unknown as AttentionRow[])
      .map(fromRow);
  }

  /** Every owner's active records: startup reconciliation only. */
  listAllActive(): StoredAttention[] {
    return (getDb().prepare(`SELECT * FROM attention_notifications
      WHERE status = 'active' ORDER BY created_at, id`).all() as unknown as AttentionRow[]).map(fromRow);
  }

  /** Resolves an active record; null when it is not active (already resolved, or unknown). */
  resolve(id: string, reason: Exclude<AttentionResolveReason, 'expired'>, at: number): StoredAttention | null {
    const result = getDb().prepare(`UPDATE attention_notifications SET status = 'resolved', resolve_reason = ?, resolved_at = ?
      WHERE id = ? AND status = 'active'`).run(reason, at, id);
    return Number(result.changes) === 1 ? this.byId(id) : null;
  }

  /**
   * First claimer wins: one UPDATE that only an active, unclaimed record
   * matches. The winning window claiming again is still told it holds the
   * claim. Null when the record is not this owner's.
   */
  claim(ownerUserId: string, id: string, windowId: string, at: number): AttentionClaimResultV1 | null {
    getDb().prepare(`UPDATE attention_notifications SET claimed_by_window_id = ?, claimed_at = ?
      WHERE id = ? AND owner_user_id = ? AND status = 'active' AND claimed_by_window_id IS NULL`)
      .run(windowId, at, id, ownerUserId);
    const record = this.get(ownerUserId, id);
    if (!record) return null;
    return {
      claimed: record.status === 'active' && record.claimedByWindowId === windowId,
      claimedByWindowId: record.claimedByWindowId,
      status: record.status,
    };
  }

  /** Expires active records created before `cutoff`; returns them, now expired. */
  expireCreatedBefore(cutoff: number, at: number): StoredAttention[] {
    return runInTransaction(() => {
      const ids = (getDb().prepare(`SELECT id FROM attention_notifications
        WHERE status = 'active' AND created_at < ?`).all(cutoff) as Array<{ id: string }>).map((row) => row.id);
      const expire = getDb().prepare(`UPDATE attention_notifications SET status = 'expired', resolve_reason = 'expired', resolved_at = ?
        WHERE id = ? AND status = 'active'`);
      for (const id of ids) expire.run(at, id);
      return ids.map((id) => this.byId(id)).filter((record): record is StoredAttention => !!record);
    });
  }

  /** Deletes records that stopped being active before `cutoff`. Returns how many. */
  pruneInactiveBefore(cutoff: number): number {
    const result = getDb().prepare(`DELETE FROM attention_notifications
      WHERE status <> 'active' AND resolved_at < ?`).run(cutoff);
    return Number(result.changes);
  }

  // ── Records of targets that moved or went away ──────────────────────────

  /** The target moved to `workspaceId`: every record of it (any status) goes with it. */
  moveTargetRecords(target: AttentionTargetV1, workspaceId: string): void {
    getDb().prepare('UPDATE attention_notifications SET workspace_id = ? WHERE target_type = ? AND target_id = ?')
      .run(workspaceId, target.type, targetIdOf(target));
  }

  /** The target was purged: its records (any status) carry its text, so they go too. */
  deleteTargetRecords(target: AttentionTargetV1): void {
    getDb().prepare('DELETE FROM attention_notifications WHERE target_type = ? AND target_id = ?')
      .run(target.type, targetIdOf(target));
  }

  /**
   * Deletes the records (any status) of purged workspaces, of nodes that are
   * purged or no longer exist, and of Scheduled Job runs that were pruned;
   * only `workspaceId`'s when given. Returns how many.
   */
  deleteRecordsOfGoneTargets(workspaceId?: string): number {
    const gone = `(workspace_id IN (SELECT id FROM workspaces WHERE purged_at IS NOT NULL)
      OR (target_type = 'node' AND NOT EXISTS (
        SELECT 1 FROM nodes n WHERE n.id = attention_notifications.target_id AND n.purged_at IS NULL))
      OR (target_type = 'scheduled_run' AND NOT EXISTS (
        SELECT 1 FROM scheduled_job_runs r WHERE r.id = attention_notifications.target_id)))`;
    const result = workspaceId === undefined
      ? getDb().prepare(`DELETE FROM attention_notifications WHERE ${gone}`).run()
      : getDb().prepare(`DELETE FROM attention_notifications WHERE workspace_id = ? AND ${gone}`).run(workspaceId);
    return Number(result.changes);
  }

  // ── Facts the records are decided from ──────────────────────────────────

  /** Null for a node that is gone: purged, missing, or in a purged workspace. */
  nodeFacts(nodeId: string): NodeAttentionFacts | null {
    const row = getDb().prepare(`SELECT n.id, n.workspace_id, n.title, n.status, n.deleted_at, n.maintenance_job_id,
        n.scheduled_only_job_id, n.completion_seq, n.seen_completion_seq, n.last_completed_turn_id, w.owner_user_id,
        w.settings AS workspace_settings, t.archived_at AS tree_archived_at, w.deleted_at AS workspace_deleted_at,
        w.archived_at AS workspace_archived_at, CASE WHEN t.root_node_id = n.id THEN t.name END AS thread_name,
        (SELECT f.content FROM messages f WHERE f.node_id = n.id AND f.role = 'user' ORDER BY f.seq LIMIT 1) AS first_user
      FROM nodes n JOIN workspaces w ON w.id = n.workspace_id LEFT JOIN trees t ON t.id = n.tree_id
      WHERE n.id = ? AND n.purged_at IS NULL AND w.purged_at IS NULL`).get(nodeId) as {
        id: string; workspace_id: string; title: string | null; status: string | null; deleted_at: number | null;
        maintenance_job_id: string | null; scheduled_only_job_id: string | null; completion_seq: number; seen_completion_seq: number;
        last_completed_turn_id: string | null; owner_user_id: string | null; workspace_settings: string | null;
        tree_archived_at: number | null; workspace_deleted_at: number | null; workspace_archived_at: number | null; thread_name: string | null;
        first_user: string | null;
      } | undefined;
    if (!row) return null;
    const ownerUserId = attentionOwnerOf(row.owner_user_id);
    if (!ownerUserId) return null;
    return {
      nodeId: row.id,
      workspaceId: row.workspace_id,
      ownerUserId,
      // A renamed thread's root goes by the thread's name, an untitled one by its first message, as in the sidebar.
      title: row.thread_name?.trim() || row.title?.trim() || deriveConversationTitle(row.first_user),
      hidden: row.maintenance_job_id !== null || row.scheduled_only_job_id !== null || nodeLifecycleState({
        deletedAt: row.deleted_at, status: row.status, treeArchivedAt: row.tree_archived_at,
        workspaceDeletedAt: row.workspace_deleted_at, workspaceArchivedAt: row.workspace_archived_at,
      }) !== 'live',
      // As assistant/identity.ts isAssistantWorkspace: the agent lives only in the local app.
      assistant: process.env.MICHI_CLOUD !== '1' && isAssistantWorkspaceSettings(row.workspace_settings),
      completionSeq: row.completion_seq,
      seenCompletionSeq: row.seen_completion_seq,
      lastCompletedTurnId: row.last_completed_turn_id,
    };
  }

  /** The turn was sent by a Scheduled Job, which reports its own runs. */
  turnIsScheduled(turnId: string): boolean {
    const row = getDb().prepare(`SELECT json_extract(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.scheduledJobId') AS job
      FROM turns t JOIN messages m ON m.id = t.user_message_id WHERE t.turn_id = ?`).get(turnId) as { job: unknown } | undefined;
    return !!row?.job;
  }

  /** Whose records a workspace's events are: attentionOwnerOf its owner; null for a workspace that is gone. */
  workspaceOwner(workspaceId: string): string | null {
    const row = getDb().prepare('SELECT owner_user_id FROM workspaces WHERE id = ? AND purged_at IS NULL').get(workspaceId) as
      { owner_user_id: string | null } | undefined;
    return row ? attentionOwnerOf(row.owner_user_id) : null;
  }

  /** For a run's record, whose target lives as long as its workspace. */
  workspaceState(workspaceId: string): AttentionWorkspaceState {
    const row = getDb().prepare('SELECT deleted_at, archived_at, purged_at FROM workspaces WHERE id = ?').get(workspaceId) as
      { deleted_at: number | null; archived_at: number | null; purged_at: number | null } | undefined;
    if (!row || row.purged_at !== null) return 'gone';
    return row.deleted_at !== null || row.archived_at !== null ? 'hidden' : 'live';
  }
}

function targetIdOf(target: AttentionTargetV1): string {
  switch (target.type) {
    case 'node': return target.nodeId;
    case 'agent': return target.ref;
    default: return target.runId;
  }
}
