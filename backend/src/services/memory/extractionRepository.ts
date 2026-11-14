import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_MEMORY_SETTINGS, type MemoryExtractionScopeHint } from 'michi-shared';
import { getDb, runInTransaction } from '../db';

/**
 * Storage for automatic memory extraction (migrations 0061, 0072, 0074 and
 * 0076: a run reads one conversation, or rebuilds the user's profile,
 * userProfile.ts). Every query names its owner; callers in extractionRun.ts,
 * extractionTools.ts and extractionV2.ts decide what is allowed. Nothing here
 * keeps the text of a deleted memory, and a run's staged payload goes when
 * the run finishes.
 */

const db = () => getDb();

// ── body identity ────────────────────────────────────────────────────────────

/** Case, width and spacing differences, and closing punctuation, do not make a different memory. */
export function normalizeMemoryBody(body: string): string {
  return body.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim().replace(/[\s。．.!！?？;；,，、]+$/u, '');
}

export function memoryBodyHash(body: string): string {
  return createHash('sha256').update(normalizeMemoryBody(body), 'utf8').digest('hex');
}

/** One proposal per owner, workspace, source turn and normalized body. */
export function extractionIdempotencyKey(input: { ownerUserId: string; workspaceId: string; sourceTurnId: string; bodyHash: string }): string {
  return createHash('sha256').update(JSON.stringify(['memory-extraction', 1, input.ownerUserId, input.workspaceId, input.sourceTurnId, input.bodyHash])).digest('hex');
}

// ── owner state ──────────────────────────────────────────────────────────────

export interface ExtractionOwnerState { paused: boolean; enabledAt: number | null }

/** Automatic memory is off (paused) until the owner turns it on in Settings: an owner without a row is paused, and so is a new row. */
export function getExtractionState(ownerUserId: string, database: DatabaseSync = db()): ExtractionOwnerState {
  const row = database.prepare('SELECT paused, enabled_at FROM memory_extraction_state WHERE owner_user_id = ?').get(ownerUserId) as
    { paused: number; enabled_at: number | null } | undefined;
  return { paused: row ? row.paused === 1 : true, enabledAt: row?.enabled_at ?? null };
}

export function setExtractionPaused(ownerUserId: string, paused: boolean, now: number): void {
  db().prepare(`INSERT INTO memory_extraction_state(owner_user_id, paused, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(owner_user_id) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at`).run(ownerUserId, paused ? 1 : 0, now);
}

/** Pauses automatic memory for every owner with a row (turnBackgroundWorkOffOnce); the others are paused already. */
export function pauseEveryExtraction(now: number): void {
  db().prepare('UPDATE memory_extraction_state SET paused = 1, updated_at = ? WHERE paused = 0').run(now);
}

/** The time auto mode was first switched on, recording `now` the first time. */
export function ensureExtractionEnabledAt(ownerUserId: string, now: number): number {
  db().prepare(`INSERT INTO memory_extraction_state(owner_user_id, paused, enabled_at, updated_at) VALUES (?, 1, ?, ?)
    ON CONFLICT(owner_user_id) DO UPDATE SET enabled_at = COALESCE(memory_extraction_state.enabled_at, excluded.enabled_at),
      updated_at = CASE WHEN memory_extraction_state.enabled_at IS NULL THEN excluded.updated_at ELSE memory_extraction_state.updated_at END`)
    .run(ownerUserId, now, now);
  return getExtractionState(ownerUserId).enabledAt!;
}

/**
 * Auto mode was switched back on: conversations from while it was off are
 * never read. Every existing consumer moves forward to `cursorFor` (never
 * back), and enabledAt becomes `now`, so a workspace created while auto mode
 * was off also starts at its current position. The revision bump fences any
 * execution still holding an older claim.
 */
export function restartExtractionAt(ownerUserId: string, cursorFor: (workspaceId: string) => number, now: number): void {
  const database = db();
  const workspaces = database.prepare('SELECT workspace_id FROM memory_extraction_cursors WHERE owner_user_id = ?')
    .all(ownerUserId) as Array<{ workspace_id: string }>;
  const move = database.prepare(`UPDATE memory_extraction_cursors
    SET completion_cursor = MAX(completion_cursor, ?), revision = revision + 1, updated_at = ?
    WHERE workspace_id = ? AND owner_user_id = ?`);
  runInTransaction(() => {
    for (const { workspace_id: workspaceId } of workspaces) move.run(cursorFor(workspaceId), now, workspaceId, ownerUserId);
    // Every conversation now starts at its workspace's cursor.
    database.prepare('DELETE FROM memory_extraction_conversations WHERE owner_user_id = ?').run(ownerUserId);
    database.prepare(`INSERT INTO memory_extraction_state(owner_user_id, paused, enabled_at, updated_at) VALUES (?, 1, ?, ?)
      ON CONFLICT(owner_user_id) DO UPDATE SET enabled_at = excluded.enabled_at, updated_at = excluded.updated_at`)
      .run(ownerUserId, now, now);
  });
}

/**
 * Owners whose memory is on (mode auto in effect): every stored mode but off
 * (the retired explicit counts as auto), and `defaultOwnerUserId` (the
 * desktop's local user) while it has no stored mode, because memory is on by
 * default. In id order.
 */
export function listAutoModeOwners(defaultOwnerUserId: string | null): string[] {
  const owners = (db().prepare("SELECT owner_user_id FROM memory_settings WHERE mode <> 'off' ORDER BY owner_user_id").all() as Array<{ owner_user_id: string }>)
    .map((row) => row.owner_user_id);
  if (defaultOwnerUserId !== null && DEFAULT_MEMORY_SETTINGS.mode !== 'off'
    && !db().prepare('SELECT 1 FROM memory_settings WHERE owner_user_id = ?').get(defaultOwnerUserId)) {
    owners.push(defaultOwnerUserId);
    owners.sort();
  }
  return owners;
}

// ── cursors ──────────────────────────────────────────────────────────────────

export interface ExtractionCursor {
  workspaceId: string; ownerUserId: string; jobId: string | null; completionCursor: number;
  paused: boolean; revision: number; createdAt: number; updatedAt: number;
}

interface CursorRow {
  workspace_id: string; owner_user_id: string; job_id: string | null; completion_cursor: number;
  paused: number; revision: number; created_at: number; updated_at: number;
}

function cursorDto(row: CursorRow): ExtractionCursor {
  return { workspaceId: row.workspace_id, ownerUserId: row.owner_user_id, jobId: row.job_id, completionCursor: row.completion_cursor,
    paused: row.paused === 1, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function getExtractionCursor(workspaceId: string, ownerUserId: string): ExtractionCursor | null {
  const row = db().prepare('SELECT * FROM memory_extraction_cursors WHERE workspace_id = ? AND owner_user_id = ?').get(workspaceId, ownerUserId) as CursorRow | undefined;
  return row ? cursorDto(row) : null;
}

export function getExtractionCursorByJob(jobId: string): ExtractionCursor | null {
  const row = db().prepare('SELECT * FROM memory_extraction_cursors WHERE job_id = ?').get(jobId) as CursorRow | undefined;
  return row ? cursorDto(row) : null;
}

/** Creates a workspace's consumer at `cursor`; an existing one keeps its own cursor. */
export function insertExtractionCursor(input: { workspaceId: string; ownerUserId: string; cursor: number; now: number }): void {
  db().prepare(`INSERT INTO memory_extraction_cursors(workspace_id, owner_user_id, job_id, completion_cursor, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?) ON CONFLICT(workspace_id, owner_user_id) DO NOTHING`)
    .run(input.workspaceId, input.ownerUserId, input.cursor, input.now, input.now);
}

export function setExtractionCursorJob(workspaceId: string, ownerUserId: string, jobId: string, now: number): boolean {
  const changed = db().prepare(`UPDATE memory_extraction_cursors SET job_id = ?, updated_at = ?
    WHERE workspace_id = ? AND owner_user_id = ? AND job_id IS NULL`).run(jobId, now, workspaceId, ownerUserId);
  return Number(changed.changes) === 1;
}

/** Cursors whose execution identity is missing or was deleted (for example with its workspace's scheduled jobs). */
export function listExtractionCursorsWithoutJob(ownerUserId: string): ExtractionCursor[] {
  return (db().prepare(`SELECT c.* FROM memory_extraction_cursors c
      WHERE c.owner_user_id = ? AND (c.job_id IS NULL OR NOT EXISTS (SELECT 1 FROM scheduled_jobs j WHERE j.id = c.job_id))
      ORDER BY c.created_at, c.workspace_id`).all(ownerUserId) as unknown as CursorRow[]).map(cursorDto);
}

export function clearExtractionCursorJob(workspaceId: string, ownerUserId: string, now: number): void {
  db().prepare('UPDATE memory_extraction_cursors SET job_id = NULL, updated_at = ? WHERE workspace_id = ? AND owner_user_id = ?')
    .run(now, workspaceId, ownerUserId);
}

export function setExtractionWorkspacePaused(workspaceId: string, ownerUserId: string, paused: boolean, now: number): boolean {
  const changed = db().prepare(`UPDATE memory_extraction_cursors SET paused = ?, revision = revision + 1, updated_at = ?
    WHERE workspace_id = ? AND owner_user_id = ?`).run(paused ? 1 : 0, now, workspaceId, ownerUserId);
  return Number(changed.changes) === 1;
}

/**
 * Moves a workspace's cursor forward to `to` (never back): no turn at or
 * below it is read any more. The conversations' own positions at or below it
 * go, since the cursor says as much.
 */
export function raiseExtractionCursor(workspaceId: string, ownerUserId: string, to: number, now: number): boolean {
  const changed = db().prepare(`UPDATE memory_extraction_cursors SET completion_cursor = ?, updated_at = ?
    WHERE workspace_id = ? AND owner_user_id = ? AND completion_cursor < ?`).run(to, now, workspaceId, ownerUserId, to);
  if (Number(changed.changes) !== 1) return false;
  db().prepare('DELETE FROM memory_extraction_conversations WHERE workspace_id = ? AND owner_user_id = ? AND extracted_seq <= ?')
    .run(workspaceId, ownerUserId, to);
  return true;
}

/** The workspace's completion counter (conversationUpdates.conversationCompletionCounter's meta key), read here to keep the memory modules free of the feed's imports. */
export function workspaceCompletionCounter(workspaceId: string): number {
  const row = db().prepare('SELECT value FROM meta WHERE key = ?').get(`conversation_completion_seq:${workspaceId}`) as { value: string } | undefined;
  const value = row ? Number(row.value) : 0;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

// ── conversations ────────────────────────────────────────────────────────────

/**
 * Where extraction stands in one conversation: the completion position it
 * settled up to, or its workspace's cursor (`floor`) when that is later or
 * the conversation has no row yet.
 */
export function conversationExtractedSeq(nodeId: string, ownerUserId: string, floor: number): number {
  const row = db().prepare('SELECT extracted_seq FROM memory_extraction_conversations WHERE node_id = ? AND owner_user_id = ?')
    .get(nodeId, ownerUserId) as { extracted_seq: number } | undefined;
  return Math.max(floor, row?.extracted_seq ?? 0);
}

/**
 * Compare-and-set of a conversation's position (conversationExtractedSeq)
 * from `from` to `to`; false when it moved meanwhile. With `firstSeq` (the
 * first turn the batch read), a position that rose past `from` only as the
 * workspace's cursor did, and not to that turn, still counts as unmoved: the
 * conversation has no turn in between. Call inside the caller's transaction.
 */
export function advanceConversationExtraction(input: {
  nodeId: string; ownerUserId: string; workspaceId: string; floor: number; from: number; to: number; firstSeq?: number; now: number;
}): boolean {
  const position = conversationExtractedSeq(input.nodeId, input.ownerUserId, input.floor);
  const own = (db().prepare('SELECT extracted_seq FROM memory_extraction_conversations WHERE node_id = ? AND owner_user_id = ?')
    .get(input.nodeId, input.ownerUserId) as { extracted_seq: number } | undefined)?.extracted_seq ?? 0;
  const unmoved = position === input.from
    || (input.firstSeq !== undefined && position > input.from && position < input.firstSeq && own <= input.from);
  if (!unmoved || input.to < input.from) return false;
  db().prepare(`INSERT INTO memory_extraction_conversations (node_id, owner_user_id, workspace_id, extracted_seq, updated_at)
      VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(node_id, owner_user_id) DO UPDATE SET workspace_id = excluded.workspace_id, extracted_seq = excluded.extracted_seq,
      updated_at = excluded.updated_at`).run(input.nodeId, input.ownerUserId, input.workspaceId, input.to, input.now);
  return true;
}

/**
 * A conversation went back to learning (its memory setting): what was said
 * in it meanwhile is never read. Its position moves to its newest completed
 * turn, never back.
 */
export function skipConversationExtraction(input: { nodeId: string; ownerUserId: string; workspaceId: string; now: number }): void {
  const newest = (db().prepare('SELECT COALESCE(MAX(completion_seq), 0) AS seq FROM turns WHERE node_id = ? AND completion_seq IS NOT NULL')
    .get(input.nodeId) as { seq: number }).seq;
  if (newest <= 0) return;
  db().prepare(`INSERT INTO memory_extraction_conversations (node_id, owner_user_id, workspace_id, extracted_seq, updated_at)
      VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(node_id, owner_user_id) DO UPDATE SET workspace_id = excluded.workspace_id,
      extracted_seq = MAX(memory_extraction_conversations.extracted_seq, excluded.extracted_seq), updated_at = excluded.updated_at`)
    .run(input.nodeId, input.ownerUserId, input.workspaceId, newest, input.now);
}

/** Each consumer with its execution identity's scheduler state (repeated-failure stop). */
export function listExtractionJobStates(ownerUserId: string): Array<ExtractionCursor & { autoPaused: boolean; lastError: string | null }> {
  return (db().prepare(`SELECT c.*, COALESCE(j.auto_paused, 0) AS auto_paused, j.last_error FROM memory_extraction_cursors c
      LEFT JOIN scheduled_jobs j ON j.id = c.job_id WHERE c.owner_user_id = ? ORDER BY c.created_at, c.workspace_id`).all(ownerUserId) as unknown as
    Array<CursorRow & { auto_paused: number; last_error: string | null }>)
    .map((row) => ({ ...cursorDto(row), autoPaused: row.auto_paused === 1, lastError: row.last_error }));
}

export function isMemoryExtractionJob(jobId: string): boolean {
  return !!db().prepare('SELECT 1 FROM memory_extraction_cursors WHERE job_id = ?').get(jobId);
}

/** The execution identities of an owner's extraction consumers (usage accounting). */
export function memoryExtractionJobIds(ownerUserId: string, database: DatabaseSync = db()): string[] {
  return (database.prepare('SELECT job_id FROM memory_extraction_cursors WHERE owner_user_id = ? AND job_id IS NOT NULL ORDER BY job_id')
    .all(ownerUserId) as Array<{ job_id: string }>).map((row) => row.job_id);
}

// ── executions ───────────────────────────────────────────────────────────────

export type ExtractionRunState = 'active' | 'succeeded' | 'failed' | 'cancelled';
export type ExtractionStopReason = 'invalid_limit' | 'budget';
/**
 * What a run does (migration 0074): read conversation turns, rebuild the
 * user's profile (userProfile.ts), or tidy Michi's own notes (consolidation.ts,
 * migration 0077).
 */
export type ExtractionRunKind = 'extract' | 'profile' | 'consolidate';

/**
 * An existing memory a run's prompt listed (an update may target only these).
 * A consolidation run's listing adds the version, group and input mark of
 * each line (consolidation.ConsolidationListing).
 */
export interface ExtractionRelatedRef { ref: string; memoryId: string; version?: number; group?: number | null; input?: boolean }

export interface ExtractionRunRecord {
  id: string; kind: ExtractionRunKind; ownerUserId: string; workspaceId: string; jobId: string; runId: string; configRevision: number;
  after: number; through: number; memoryVersion: number; tombstoneMark: number; state: ExtractionRunState;
  invalidCalls: number; stoppedReason: ExtractionStopReason | null; tokenBudget: number; estimatedTokens: number;
  reportedTokens: number | null; proposedCount: number; droppedCount: number; noChangeCount: number;
  summary: string | null; error: string | null; startedAt: number; finishedAt: number | null;
  /** The memory_extract arguments staged until the run settles (JSON), or null. */
  payload: string | null;
  related: ExtractionRelatedRef[];
}

interface RunRow {
  id: string; kind: string | null; owner_user_id: string; workspace_id: string; job_id: string; run_id: string; config_revision: number;
  after_seq: number; through_seq: number; memory_version: number; tombstone_mark: number; state: ExtractionRunState;
  invalid_calls: number; stopped_reason: ExtractionStopReason | null; token_budget: number; estimated_tokens: number;
  reported_tokens: number | null; proposed_count: number; dropped_count: number; no_change_count: number;
  summary: string | null; error: string | null; started_at: number; finished_at: number | null;
  payload: string | null; related_memories: string | null;
}

function relatedRefs(stored: string | null): ExtractionRelatedRef[] {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is ExtractionRelatedRef => !!entry && typeof entry === 'object'
      && typeof (entry as ExtractionRelatedRef).ref === 'string' && typeof (entry as ExtractionRelatedRef).memoryId === 'string') : [];
  } catch {
    return [];
  }
}

function runKind(kind: string | null): ExtractionRunKind {
  return kind === 'profile' || kind === 'consolidate' ? kind : 'extract';
}

function runDto(row: RunRow): ExtractionRunRecord {
  return { id: row.id, kind: runKind(row.kind), ownerUserId: row.owner_user_id, workspaceId: row.workspace_id,
    jobId: row.job_id, runId: row.run_id,
    configRevision: row.config_revision, after: row.after_seq, through: row.through_seq, memoryVersion: row.memory_version,
    tombstoneMark: row.tombstone_mark, state: row.state, invalidCalls: row.invalid_calls, stoppedReason: row.stopped_reason,
    tokenBudget: row.token_budget, estimatedTokens: row.estimated_tokens, reportedTokens: row.reported_tokens,
    proposedCount: row.proposed_count, droppedCount: row.dropped_count, noChangeCount: row.no_change_count,
    summary: row.summary, error: row.error, startedAt: row.started_at, finishedAt: row.finished_at,
    payload: row.payload ?? null, related: relatedRefs(row.related_memories) };
}

export interface ExtractionSourceInput {
  sourceTurnId: string; nodeId: string; userMessageId: string; assistantMessageId: string;
  completionSeq: number; completedAt: number; untrusted: boolean;
}

/**
 * Records a run as active. A profile run (kind 'profile') has no sources: it
 * stays at the cursor (after = through), memoryVersion is the user scope's,
 * and related lists the notes its prompt shows.
 */
export function insertExtractionRun(input: {
  id: string; kind?: ExtractionRunKind; ownerUserId: string; workspaceId: string; jobId: string; runId: string; configRevision: number;
  after: number; through: number; memoryVersion: number; tombstoneMark: number; tokenBudget: number; estimatedTokens: number;
  now: number; sources: ExtractionSourceInput[]; related: readonly ExtractionRelatedRef[];
}): void {
  db().prepare(`INSERT INTO memory_extraction_runs(id, kind, owner_user_id, workspace_id, job_id, run_id, config_revision, after_seq, through_seq,
      memory_version, tombstone_mark, state, token_budget, context_tokens, estimated_tokens, started_at, related_memories)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
    .run(input.id, input.kind ?? 'extract', input.ownerUserId, input.workspaceId, input.jobId, input.runId, input.configRevision, input.after,
      input.through, input.memoryVersion, input.tombstoneMark, input.tokenBudget, input.estimatedTokens, input.estimatedTokens, input.now,
      JSON.stringify(input.related.map(({ ref, memoryId, version, group, input: listedInput }) => ({
        ref, memoryId, ...(version !== undefined ? { version } : {}), ...(group !== undefined ? { group } : {}),
        ...(listedInput !== undefined ? { input: listedInput } : {}),
      }))));
  const source = db().prepare(`INSERT INTO memory_extraction_sources(run_id, source_turn_id, node_id, user_message_id, assistant_message_id,
      completion_seq, completed_at, untrusted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const item of input.sources) {
    source.run(input.id, item.sourceTurnId, item.nodeId, item.userMessageId, item.assistantMessageId, item.completionSeq,
      item.completedAt, item.untrusted ? 1 : 0);
  }
}

export function getExtractionRun(id: string, ownerUserId: string): ExtractionRunRecord | null {
  const row = db().prepare('SELECT * FROM memory_extraction_runs WHERE id = ? AND owner_user_id = ?').get(id, ownerUserId) as RunRow | undefined;
  return row ? runDto(row) : null;
}

/** Runs still marked active whose scheduler run is no longer running: the process stopped under them. */
export function failOrphanedExtractionRuns(workspaceId: string, ownerUserId: string, now: number): void {
  db().prepare(`UPDATE memory_extraction_runs AS x SET state = 'failed', error = 'The run stopped before it finished', finished_at = ?,
      payload = NULL
    WHERE x.workspace_id = ? AND x.owner_user_id = ? AND x.state = 'active'
      AND NOT EXISTS (SELECT 1 FROM scheduled_job_runs r WHERE r.id = x.run_id AND r.status = 'running')`).run(now, workspaceId, ownerUserId);
}

/** SQL for an optional kinds filter on memory_extraction_runs (alias `alias`); '' when every kind counts. */
function kindsClause(kinds: readonly ExtractionRunKind[] | undefined, alias = ''): { sql: string; params: string[] } {
  if (!kinds) return { sql: '', params: [] };
  return { sql: ` AND ${alias}kind IN (${kinds.map(() => '?').join(', ')})`, params: [...kinds] };
}

/** The owner's newest runs; `kinds`: of these kinds only (Settings › Memory shows extraction and profile runs, never consolidation's). */
export function listRecentExtractionRuns(ownerUserId: string, limit: number, database: DatabaseSync = db(), kinds?: readonly ExtractionRunKind[]): ExtractionRunRecord[] {
  const filter = kindsClause(kinds);
  return (database.prepare(`SELECT * FROM memory_extraction_runs WHERE owner_user_id = ?${filter.sql} ORDER BY started_at DESC, rowid DESC LIMIT ?`)
    .all(ownerUserId, ...filter.params, limit) as unknown as RunRow[]).map(runDto);
}

/** The newest finished extraction run of a workspace (profile runs aside), for batch sizing after a budget failure. */
export function lastFinishedExtractionRun(workspaceId: string, ownerUserId: string): ExtractionRunRecord | null {
  const row = db().prepare(`SELECT * FROM memory_extraction_runs WHERE workspace_id = ? AND owner_user_id = ? AND state <> 'active'
    AND kind = 'extract' ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(workspaceId, ownerUserId) as RunRow | undefined;
  return row ? runDto(row) : null;
}

/** The owner's live runs (active, their scheduler run running); `kinds`: of these kinds only. */
export function liveExtractionRunCount(ownerUserId: string, kinds?: readonly ExtractionRunKind[]): number {
  const filter = kindsClause(kinds, 'x.');
  return (db().prepare(`SELECT COUNT(*) AS n FROM memory_extraction_runs x WHERE x.owner_user_id = ? AND x.state = 'active'${filter.sql}
    AND EXISTS (SELECT 1 FROM scheduled_job_runs r WHERE r.id = x.run_id AND r.status = 'running')`).get(ownerUserId, ...filter.params) as { n: number }).n;
}

export function isExtractionRunLive(id: string): boolean {
  return !!db().prepare(`SELECT 1 FROM memory_extraction_runs x JOIN scheduled_job_runs r ON r.id = x.run_id
    WHERE x.id = ? AND x.state = 'active' AND r.status = 'running'`).get(id);
}

export function recordExtractionInvalidCall(id: string, limit: number): { invalidCalls: number; stopped: boolean } {
  db().prepare(`UPDATE memory_extraction_runs SET invalid_calls = invalid_calls + 1,
      stopped_reason = CASE WHEN invalid_calls + 1 > ? AND stopped_reason IS NULL THEN 'invalid_limit' ELSE stopped_reason END
    WHERE id = ? AND state = 'active'`).run(limit, id);
  const row = db().prepare('SELECT invalid_calls, stopped_reason FROM memory_extraction_runs WHERE id = ?').get(id) as { invalid_calls: number; stopped_reason: string | null } | undefined;
  return { invalidCalls: row?.invalid_calls ?? 0, stopped: row?.stopped_reason === 'invalid_limit' };
}

/**
 * Charges one tool call to the run's estimate: its arguments and result join
 * the context, and the model reads the whole context again for its next step.
 * Returns the new estimate.
 */
export function chargeExtractionCall(id: string, callTokens: number): number {
  const tokens = Math.max(0, Math.ceil(callTokens));
  db().prepare(`UPDATE memory_extraction_runs SET context_tokens = context_tokens + ?,
      estimated_tokens = estimated_tokens + context_tokens + ? WHERE id = ? AND state = 'active'`).run(tokens, tokens, id);
  return (db().prepare('SELECT estimated_tokens FROM memory_extraction_runs WHERE id = ?').get(id) as { estimated_tokens: number } | undefined)?.estimated_tokens ?? 0;
}

/**
 * Stages a run's memory_extract arguments; the first call wins. False when
 * the run already has them or is no longer active.
 */
export function stageExtractionPayload(id: string, payload: string): boolean {
  const changed = db().prepare("UPDATE memory_extraction_runs SET payload = ? WHERE id = ? AND state = 'active' AND payload IS NULL")
    .run(payload, id);
  return Number(changed.changes) === 1;
}

/** Ends an active run; its staged payload goes with it, committed or not. */
export function finishExtractionRun(input: {
  id: string; state: Exclude<ExtractionRunState, 'active'>; summary: string | null; error: string | null; reportedTokens: number | null;
  counts?: { proposed: number; dropped: number; noChange: number }; now: number;
}): boolean {
  const changed = db().prepare(`UPDATE memory_extraction_runs SET state = ?, summary = ?, error = ?, reported_tokens = ?,
      proposed_count = COALESCE(?, proposed_count), dropped_count = COALESCE(?, dropped_count), no_change_count = COALESCE(?, no_change_count),
      finished_at = ?, payload = NULL WHERE id = ? AND state = 'active'`)
    .run(input.state, input.summary, input.error ? input.error.slice(0, 2000) : null, input.reportedTokens,
      input.counts?.proposed ?? null, input.counts?.dropped ?? null, input.counts?.noChange ?? null, input.now, input.id);
  return Number(changed.changes) === 1;
}

/**
 * Keep the latest runs per workspace; their sources and candidates cascade.
 * Consolidation runs are left to pruneConsolidation (kept about 7 days, for
 * the spacing and backoff rules and a revert).
 */
export function pruneExtractionRuns(workspaceId: string, ownerUserId: string, keep: number): void {
  db().prepare(`DELETE FROM memory_extraction_runs WHERE workspace_id = ? AND owner_user_id = ? AND state <> 'active' AND kind <> 'consolidate'
    AND id NOT IN (SELECT id FROM memory_extraction_runs WHERE workspace_id = ? AND owner_user_id = ? AND kind <> 'consolidate'
      ORDER BY started_at DESC, rowid DESC LIMIT ?)`)
    .run(workspaceId, ownerUserId, workspaceId, ownerUserId, keep);
}

/** The owner's finished consolidation runs, and its consolidation log rows, from before `before` (ms) go. */
export function pruneConsolidation(ownerUserId: string, before: number): void {
  db().prepare(`DELETE FROM memory_extraction_runs WHERE owner_user_id = ? AND kind = 'consolidate' AND state <> 'active' AND started_at < ?`)
    .run(ownerUserId, before);
  db().prepare('DELETE FROM memory_consolidation_log WHERE owner_user_id = ? AND created_at < ?').run(ownerUserId, before);
}

// ── sources and receipts ─────────────────────────────────────────────────────

export interface ExtractionSourceRecord extends ExtractionSourceInput {
  readAt: number | null; decision: 'proposed' | 'no_change' | null; reason: string | null;
}

interface SourceRow {
  source_turn_id: string; node_id: string; user_message_id: string; assistant_message_id: string; completion_seq: number;
  completed_at: number; untrusted: number; read_at: number | null;
  decision: 'proposed' | 'no_change' | null; reason: string | null;
}

function sourceDto(row: SourceRow): ExtractionSourceRecord {
  return { sourceTurnId: row.source_turn_id, nodeId: row.node_id, userMessageId: row.user_message_id, assistantMessageId: row.assistant_message_id,
    completionSeq: row.completion_seq, completedAt: row.completed_at, untrusted: row.untrusted === 1,
    readAt: row.read_at, decision: row.decision, reason: row.reason };
}

export function listExtractionSources(runId: string): ExtractionSourceRecord[] {
  return (db().prepare('SELECT * FROM memory_extraction_sources WHERE run_id = ? ORDER BY completion_seq, source_turn_id').all(runId) as unknown as SourceRow[]).map(sourceDto);
}

export function extractionSourceCount(runId: string): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM memory_extraction_sources WHERE run_id = ?').get(runId) as { n: number }).n;
}

/** Records a receipt once: a no-change keeps its first reason; a turn never holds both kinds. */
export function recordExtractionDecision(runId: string, sourceTurnId: string, decision: 'proposed' | 'no_change', reason: string | null, now: number): boolean {
  const changed = db().prepare(`UPDATE memory_extraction_sources SET decision = ?, reason = ?, decided_at = ?
    WHERE run_id = ? AND source_turn_id = ? AND (decision IS NULL OR (decision = 'proposed' AND ? = 'proposed'))`)
    .run(decision, reason, now, runId, sourceTurnId, decision);
  return Number(changed.changes) === 1;
}

// ── the proposal ledger ──────────────────────────────────────────────────────

export function getCommittedProposal(idempotencyKey: string): { memoryId: string; runId: string } | null {
  const row = db().prepare('SELECT memory_id, run_id FROM memory_extraction_proposals WHERE idempotency_key = ?').get(idempotencyKey) as
    { memory_id: string; run_id: string } | undefined;
  return row ? { memoryId: row.memory_id, runId: row.run_id } : null;
}

export function insertCommittedProposal(input: {
  idempotencyKey: string; ownerUserId: string; workspaceId: string; sourceTurnId: string; memoryId: string;
  scopeHint: MemoryExtractionScopeHint; runId: string; now: number;
}): void {
  db().prepare(`INSERT INTO memory_extraction_proposals(idempotency_key, owner_user_id, workspace_id, source_turn_id, memory_id, scope_hint, run_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.idempotencyKey, input.ownerUserId, input.workspaceId, input.sourceTurnId, input.memoryId,
    input.scopeHint, input.runId, input.now);
}

/** Pending extracted memories (an older version's) whose proposal suggested making them global. */
export function pendingMaybeGlobalMemoryIds(ownerUserId: string): string[] {
  return (db().prepare(`SELECT p.memory_id FROM memory_extraction_proposals p JOIN memories m ON m.id = p.memory_id
      WHERE p.owner_user_id = ? AND m.owner_user_id = ? AND m.status = 'pending' AND p.scope_hint = 'maybe_global'
      ORDER BY p.created_at, p.memory_id`).all(ownerUserId, ownerUserId) as Array<{ memory_id: string }>).map((row) => row.memory_id);
}

export function pendingExtractedMemoryCount(ownerUserId: string): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM memories WHERE owner_user_id = ? AND status = 'pending' AND origin = 'extracted'")
    .get(ownerUserId) as { n: number }).n;
}

// ── tombstones ───────────────────────────────────────────────────────────────

export function insertExtractionTombstone(input: {
  ownerUserId: string; workspaceId: string | null; sourceTurnId: string | null; bodyHash: string; reason: 'deleted' | 'rejected'; now: number;
}): void {
  db().prepare(`INSERT INTO memory_extraction_tombstones(owner_user_id, workspace_id, source_turn_id, body_hash, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(input.ownerUserId, input.workspaceId, input.sourceTurnId, input.bodyHash, input.reason, input.now);
}

export function latestTombstoneSeq(ownerUserId: string): number {
  return (db().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_extraction_tombstones WHERE owner_user_id = ?').get(ownerUserId) as { seq: number }).seq;
}

/**
 * Whether a removal names this turn: a memory saved from it was deleted, or
 * the turn was kept out of automatic memory (recallIndex.keepTurnOutOfMemory).
 * Automatic extraction never reads such a turn.
 */
export function turnTombstoned(ownerUserId: string, sourceTurnId: string): boolean {
  return !!db().prepare('SELECT 1 FROM memory_extraction_tombstones WHERE owner_user_id = ? AND source_turn_id = ? LIMIT 1').get(ownerUserId, sourceTurnId);
}

/**
 * Whether a removal written after `mark` (latestTombstoneSeq when a run was
 * planned) names one of these turns: the run read what the user has since
 * removed or kept out of memory.
 */
export function turnsTombstonedAfter(ownerUserId: string, sourceTurnIds: readonly string[], mark: number): boolean {
  if (sourceTurnIds.length === 0) return false;
  return !!db().prepare(`SELECT 1 FROM memory_extraction_tombstones WHERE owner_user_id = ?
    AND source_turn_id IN (SELECT value FROM json_each(?)) AND seq > ? LIMIT 1`).get(ownerUserId, JSON.stringify(sourceTurnIds), mark);
}

/**
 * When the owner last removed a memory with this body (normalized hash,
 * memoryBodyHash) at or after `since`, or null: one of the user scope or of
 * `workspaceId`, and for a memory that would apply everywhere
 * (`everywhere`), one of any workspace, since it would show there again.
 * memory_save checks it too (agents/memoryTools.ts).
 */
export function bodyRemovedAt(input: { ownerUserId: string; bodyHash: string; workspaceId: string | null; everywhere: boolean; since?: number }): number | null {
  const row = db().prepare(`SELECT MAX(created_at) AS at FROM memory_extraction_tombstones WHERE owner_user_id = ? AND body_hash = ?
    AND (? = 1 OR workspace_id IS NULL OR workspace_id = ?) AND created_at >= ?`)
    .get(input.ownerUserId, input.bodyHash, input.everywhere ? 1 : 0, input.workspaceId, input.since ?? 0) as { at: number | null } | undefined;
  return row?.at ?? null;
}

/**
 * Whether a removal bars this extracted memory: one from the same source
 * turn, or one with the same body removed at or after `statedAt`, when the
 * user sent the source turn (bodyRemovedAt: of this workspace or the user
 * scope, and of any workspace for a memory that goes to the user scope). So a
 * removal made while that turn ran (the turn that asked to forget it, often
 * restating it) bars it too, and a statement the user sent again after the
 * removal is a new expression and passes.
 */
export function tombstoneBlocks(input: {
  ownerUserId: string; workspaceId: string; sourceTurnId: string; bodyHash: string; statedAt: number; everywhere?: boolean;
}): 'source_turn' | 'body' | null {
  if (turnTombstoned(input.ownerUserId, input.sourceTurnId)) return 'source_turn';
  return bodyRemovedAt({ ownerUserId: input.ownerUserId, bodyHash: input.bodyHash, workspaceId: input.workspaceId,
    everywhere: input.everywhere === true, since: input.statedAt }) === null ? null : 'body';
}

// ── usage ────────────────────────────────────────────────────────────────────

export function addExtractionUsage(ownerUserId: string, dayStart: number, tokens: number): number {
  db().prepare(`INSERT INTO memory_extraction_usage(owner_user_id, day_start, tokens, executions) VALUES (?, ?, ?, 1)
    ON CONFLICT(owner_user_id, day_start) DO UPDATE SET tokens = memory_extraction_usage.tokens + excluded.tokens,
      executions = memory_extraction_usage.executions + 1`).run(ownerUserId, dayStart, Math.max(0, Math.round(tokens)));
  return extractionTokensOn(ownerUserId, dayStart);
}

export function extractionTokensOn(ownerUserId: string, dayStart: number, database: DatabaseSync = db()): number {
  return (database.prepare('SELECT tokens FROM memory_extraction_usage WHERE owner_user_id = ? AND day_start = ?').get(ownerUserId, dayStart) as
    { tokens: number } | undefined)?.tokens ?? 0;
}

export function markExtractionBudgetExhausted(ownerUserId: string, dayStart: number, now: number): void {
  db().prepare(`INSERT INTO memory_extraction_usage(owner_user_id, day_start, exhausted_at) VALUES (?, ?, ?)
    ON CONFLICT(owner_user_id, day_start) DO UPDATE SET exhausted_at = COALESCE(memory_extraction_usage.exhausted_at, excluded.exhausted_at)`)
    .run(ownerUserId, dayStart, now);
}

// ── purge ────────────────────────────────────────────────────────────────────

/** A permanently deleted workspace takes its extraction state, receipts and tombstones with it. */
export function purgeWorkspaceExtraction(workspaceId: string): void {
  const database = db();
  database.prepare('DELETE FROM memory_extraction_runs WHERE workspace_id = ?').run(workspaceId);
  database.prepare('DELETE FROM memory_extraction_cursors WHERE workspace_id = ?').run(workspaceId);
  database.prepare('DELETE FROM memory_extraction_conversations WHERE workspace_id = ?').run(workspaceId);
  database.prepare('DELETE FROM memory_extraction_proposals WHERE workspace_id = ?').run(workspaceId);
  database.prepare('DELETE FROM memory_extraction_tombstones WHERE workspace_id = ?').run(workspaceId);
}

/** A deleted account's extraction state, receipts, tombstones and usage. */
export function purgeOwnerExtraction(ownerUserId: string): void {
  const database = db();
  database.prepare('DELETE FROM memory_extraction_runs WHERE owner_user_id = ?').run(ownerUserId);
  database.prepare('DELETE FROM memory_extraction_cursors WHERE owner_user_id = ?').run(ownerUserId);
  database.prepare('DELETE FROM memory_extraction_conversations WHERE owner_user_id = ?').run(ownerUserId);
  database.prepare('DELETE FROM memory_extraction_proposals WHERE owner_user_id = ?').run(ownerUserId);
  database.prepare('DELETE FROM memory_extraction_tombstones WHERE owner_user_id = ?').run(ownerUserId);
  database.prepare('DELETE FROM memory_extraction_usage WHERE owner_user_id = ?').run(ownerUserId);
  database.prepare('DELETE FROM memory_extraction_state WHERE owner_user_id = ?').run(ownerUserId);
}
