import {
  isConversationMemoryMode,
  type ConversationMemoryMode,
  type MemoryImportSource,
  type MemoryKind,
  type MemoryMode,
  type MemoryOrigin,
  type MemoryRecord,
  type MemorySource,
  type MemorySourceRisk,
  type MemoryStatus,
} from 'michi-shared';
import { getDb, runInTransaction } from '../db';
import { workspaceOwnerMatches } from '../agentOwner';
import { memoryBodyHash, normalizeMemoryBody, purgeOwnerExtraction, purgeWorkspaceExtraction } from './extractionRepository';

/**
 * SQL for Michi Memory (migrations 0059_memories and 0071_memory_v3). Every
 * read and write takes the caller's ownerUserId and filters on it here, so no
 * parameter a caller passes can reach another owner's rows. Workspace-scope
 * rows additionally require the workspace to belong to that owner when they
 * are written. Validation, versioning and events live in memoryService.ts.
 */

interface MemoryRow {
  row_id: number;
  id: string;
  owner_user_id: string;
  scope: 'user' | 'workspace';
  workspace_id: string | null;
  kind: MemoryKind;
  body: string;
  status: MemoryStatus;
  origin: MemoryOrigin;
  source_node_id: string | null;
  source_message_id: string | null;
  source_turn_id: string | null;
  source_artifact_id: string | null;
  source_risk: MemorySourceRisk | null;
  supersedes_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  keywords: string;
  event_at: number | null;
  observed_at: number | null;
  /** Migration 0075 (nativeMemoryImport.ts). */
  import_source: MemoryImportSource | null;
  import_ref: string | null;
  /** Migration 0085. */
  topic: string | null;
}

const COLUMNS = `m.row_id, m.id, m.owner_user_id, m.scope, m.workspace_id, m.kind, m.body, m.status, m.origin,
  m.source_node_id, m.source_message_id, m.source_turn_id, m.source_artifact_id, m.source_risk,
  m.supersedes_id, m.version, m.created_at, m.updated_at, m.keywords, m.event_at, m.observed_at, m.import_source, m.import_ref, m.topic`;
// A read by ids or links writes +owner_user_id: without statistics SQLite would take the owner's index for it and walk
// every row of the owner's, not the id, supersedes or merged_into index.

/** user scope in memory_scope_versions; workspace ids are never empty. */
const USER_SCOPE_KEY = '';

/** memories.keywords holds one keyword per line (the service collapses whitespace inside each); '' is none. */
function encodeKeywords(keywords: readonly string[]): string {
  return keywords.join('\n');
}

function decodeKeywords(stored: string | null): string[] {
  return stored ? stored.split('\n').filter(Boolean) : [];
}

function toRecord(row: MemoryRow): MemoryRecord {
  const source: MemorySource = {};
  if (row.source_node_id !== null) source.nodeId = row.source_node_id;
  if (row.source_message_id !== null) source.messageId = row.source_message_id;
  if (row.source_turn_id !== null) source.turnId = row.source_turn_id;
  if (row.source_artifact_id !== null) source.artifactId = row.source_artifact_id;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    scope: row.scope === 'workspace' && row.workspace_id !== null
      ? { kind: 'workspace', workspaceId: row.workspace_id }
      : { kind: 'user' },
    kind: row.kind,
    body: row.body,
    source: Object.keys(source).length > 0 ? source : null,
    status: row.status,
    origin: row.origin,
    version: row.version,
    supersedesId: row.supersedes_id,
    sourceRisk: row.source_risk,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    keywords: decodeKeywords(row.keywords),
    topic: row.topic ?? null,
    eventAt: row.event_at,
    observedAt: row.observed_at ?? row.created_at,
    ...(row.import_source ? { importSource: row.import_source, importRef: row.import_ref ?? '' } : {}),
  };
}

/** Composes with a caller's transaction (and its hooks' writes): a savepoint inside one. */
export function memoryTransaction<T>(fn: () => T): T {
  return runInTransaction(fn);
}

/**
 * Whether ownerUserId may keep memories in this workspace: it exists, was not
 * permanently deleted, and belongs to the owner (workspaceOwnerMatches, the
 * same rule as every other owner-scoped repository).
 */
export function workspaceAccessible(ownerUserId: string, workspaceId: string): boolean {
  const row = getDb().prepare('SELECT owner_user_id, purged_at FROM workspaces WHERE id = ?')
    .get(workspaceId) as { owner_user_id: string | null; purged_at: number | null } | undefined;
  return !!row && row.purged_at === null && workspaceOwnerMatches(row.owner_user_id, ownerUserId);
}

export interface NewMemoryRow {
  id: string;
  ownerUserId: string;
  workspaceId: string | null;
  kind: MemoryKind;
  body: string;
  status: MemoryStatus;
  origin: MemoryOrigin;
  source: MemorySource | null;
  sourceRisk: MemorySourceRisk | null;
  supersedesId: string | null;
  keywords: readonly string[];
  topic: string | null;
  eventAt: number | null;
  observedAt: number;
  now: number;
}

const ID_SEQUENCES = {
  memories: { max: 'SELECT MAX(row_id) AS n FROM memories', key: 'memory_row_id_high_water' },
  memory_recall_docs: { max: 'SELECT MAX(id) AS n FROM memory_recall_docs', key: 'memory_recall_doc_id_high_water' },
} as const;

/**
 * The id for a new row of a table whose ids agents are shown as refs
 * (memoryRefs.ts): never one a deleted row had. SQLite gives a new row the
 * largest id plus one, so deleting the newest row would hand its id (and
 * its ref) to the next one; a high-water mark in meta keeps ids rising. Call
 * inside the insert's transaction.
 */
export function nextUnusedId(table: keyof typeof ID_SEQUENCES): number {
  const db = getDb();
  const sequence = ID_SEQUENCES[table];
  const max = (db.prepare(sequence.max).get() as { n: number | null }).n ?? 0;
  const mark = Number((db.prepare('SELECT value FROM meta WHERE key = ?').get(sequence.key) as { value: string } | undefined)?.value ?? 0);
  const next = Math.max(max, Number.isSafeInteger(mark) ? mark : 0) + 1;
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(sequence.key, String(next));
  return next;
}

export function insertMemoryRow(row: NewMemoryRow): MemoryRecord {
  getDb().prepare(`INSERT INTO memories (row_id, id, owner_user_id, scope, workspace_id, kind, body, status, origin,
      source_node_id, source_message_id, source_turn_id, source_artifact_id, source_risk, supersedes_id,
      version, created_at, updated_at, keywords, event_at, observed_at, topic)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`).run(
    nextUnusedId('memories'), row.id, row.ownerUserId, row.workspaceId === null ? 'user' : 'workspace', row.workspaceId,
    row.kind, row.body, row.status, row.origin,
    row.source?.nodeId ?? null, row.source?.messageId ?? null, row.source?.turnId ?? null, row.source?.artifactId ?? null,
    row.sourceRisk, row.supersedesId, row.now, row.now, encodeKeywords(row.keywords), row.eventAt, row.observedAt, row.topic,
  );
  const stored = findMemory(row.ownerUserId, row.id);
  if (!stored) throw new Error('memory insert was not readable');
  return stored;
}

/** The topics the owner's active memories in the user scope and this workspace use, most used first, then most recent. */
export function topicsInUse(ownerUserId: string, workspaceId: string | null, limit: number): string[] {
  return (getDb().prepare(`SELECT topic FROM memories
      WHERE owner_user_id = ? AND topic IS NOT NULL AND status = 'active' AND (scope = 'user' OR workspace_id = ?)
      GROUP BY topic ORDER BY COUNT(*) DESC, MAX(updated_at) DESC LIMIT ?`).all(ownerUserId, workspaceId, limit) as Array<{ topic: string }>)
    .map((row) => row.topic);
}

/**
 * A topic as the owner's memories already spell it: "michi" joins "Michi". A
 * new topic keeps its own spelling. (SQLite's lower() folds ASCII only; other
 * scripts match as written.)
 */
export function spelledTopic(ownerUserId: string, topic: string): string {
  const row = getDb().prepare(`SELECT topic FROM memories WHERE owner_user_id = ? AND topic IS NOT NULL AND lower(topic) = lower(?)
    ORDER BY updated_at DESC LIMIT 1`).get(ownerUserId, topic) as { topic: string } | undefined;
  return row?.topic ?? topic;
}

export function findMemory(ownerUserId: string, id: string): MemoryRecord | null {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM memories m WHERE m.id = ? AND m.owner_user_id = ?`)
    .get(id, ownerUserId) as MemoryRow | undefined;
  return row ? toRecord(row) : null;
}

export interface MemoryRowChanges {
  workspaceId?: string | null;
  kind?: MemoryKind;
  body?: string;
  status?: MemoryStatus;
  keywords?: readonly string[];
  /** null clears it. */
  topic?: string | null;
  eventAt?: number | null;
  /** Migration 0077: when the user edited it in Settings › Memory (consolidation never changes such a memory). */
  userEditedAt?: number | null;
  /** Migration 0077: the memory consolidation merged it into; null clears the link. */
  mergedIntoId?: string | null;
}

/**
 * Apply changes when the stored version still equals expectedVersion; the
 * version goes up by one. Null when the row is gone, not the owner's, or was
 * changed in the meantime.
 */
export function updateMemoryRow(
  ownerUserId: string, id: string, expectedVersion: number, changes: MemoryRowChanges, now: number,
): MemoryRecord | null {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (changes.workspaceId !== undefined) {
    sets.push('scope = ?', 'workspace_id = ?');
    params.push(changes.workspaceId === null ? 'user' : 'workspace', changes.workspaceId);
  }
  if (changes.kind !== undefined) { sets.push('kind = ?'); params.push(changes.kind); }
  if (changes.body !== undefined) { sets.push('body = ?'); params.push(changes.body); }
  if (changes.status !== undefined) { sets.push('status = ?'); params.push(changes.status); }
  if (changes.keywords !== undefined) { sets.push('keywords = ?'); params.push(encodeKeywords(changes.keywords)); }
  if (changes.topic !== undefined) { sets.push('topic = ?'); params.push(changes.topic); }
  if (changes.eventAt !== undefined) { sets.push('event_at = ?'); params.push(changes.eventAt); }
  if (changes.userEditedAt !== undefined) { sets.push('user_edited_at = ?'); params.push(changes.userEditedAt); }
  if (changes.mergedIntoId !== undefined) { sets.push('merged_into_id = ?'); params.push(changes.mergedIntoId); }
  sets.push('version = version + 1', 'updated_at = ?');
  params.push(now, id, ownerUserId, expectedVersion);
  const result = getDb().prepare(`UPDATE memories SET ${sets.join(', ')}
    WHERE id = ? AND owner_user_id = ? AND version = ?`).run(...params);
  return Number(result.changes) === 1 ? findMemory(ownerUserId, id) : null;
}

/** Versions a chain holds at most: a guard against a corrupt cycle, far above any real history. */
const MAX_CHAIN_VERSIONS = 1_000;

/**
 * Every version of the owner's memory with this id: the records linked to it
 * by corrections (supersedes_id), either way, in the order found (the memory
 * itself first). [] when the owner has no such memory.
 */
export function memoryVersionChain(ownerUserId: string, id: string): MemoryRecord[] {
  const start = findMemory(ownerUserId, id);
  if (!start) return [];
  const found = new Map<string, MemoryRecord>([[start.id, start]]);
  const linked = getDb().prepare(`SELECT ${COLUMNS} FROM memories m WHERE +m.owner_user_id = ?
    AND (m.id IN (SELECT value FROM json_each(?)) OR m.supersedes_id IN (SELECT value FROM json_each(?)))`);
  let frontier = [start];
  while (frontier.length > 0 && found.size < MAX_CHAIN_VERSIONS) {
    const earlier = frontier.map((record) => record.supersedesId).filter((value): value is string => !!value);
    const rows = linked.all(ownerUserId, JSON.stringify(earlier), JSON.stringify(frontier.map((record) => record.id))) as unknown as MemoryRow[];
    frontier = [];
    for (const row of rows) {
      if (found.has(row.id)) continue;
      const record = toRecord(row);
      found.set(record.id, record);
      frontier.push(record);
    }
  }
  return [...found.values()];
}

/**
 * The owner's memories consolidation merged into one of these (merged_into_id,
 * migration 0077), each with its own versions (memoryVersionChain), and in
 * turn whatever was merged into those: what forgetting these forgets too
 * (memoryService.removeMemory). The given ids are left out; at most
 * MAX_CHAIN_VERSIONS records.
 */
export function mergedPredecessors(ownerUserId: string, ids: readonly string[]): MemoryRecord[] {
  const given = new Set(ids);
  const found = new Map<string, MemoryRecord>();
  const merged = getDb().prepare('SELECT id FROM memories WHERE +owner_user_id = ? AND merged_into_id IN (SELECT value FROM json_each(?)) ORDER BY row_id');
  let frontier = [...given];
  while (frontier.length > 0 && found.size < MAX_CHAIN_VERSIONS) {
    const next: string[] = [];
    for (const { id } of merged.all(ownerUserId, JSON.stringify(frontier)) as Array<{ id: string }>) {
      if (given.has(id) || found.has(id)) continue;
      for (const record of memoryVersionChain(ownerUserId, id)) {
        if (given.has(record.id) || found.has(record.id) || found.size >= MAX_CHAIN_VERSIONS) continue;
        found.set(record.id, record);
        next.push(record.id);
      }
    }
    frontier = next;
  }
  return [...found.values()];
}

/** The owner's memories consolidation merged directly into one of these ids, in row order. */
export function mergedDirectlyInto(ownerUserId: string, ids: readonly string[]): MemoryRecord[] {
  if (ids.length === 0) return [];
  return (getDb().prepare(`SELECT ${COLUMNS} FROM memories m WHERE +m.owner_user_id = ? AND m.merged_into_id IN (SELECT value FROM json_each(?))
    ORDER BY m.row_id`).all(ownerUserId, JSON.stringify(ids)) as unknown as MemoryRow[]).map(toRecord);
}

/**
 * Whether a memory's source still learns (consolidation's "learning source"):
 * its conversation is gone or learns (nodes.memory_mode NULL). A turn the
 * user asked Michi not to recall (the reply footer's Don't recall) changes
 * nothing here: that hides the excerpt, not the memories saved from it, which
 * packs still pin and cite.
 */
export function hasLearningSource(record: Pick<MemoryRecord, 'source'>): boolean {
  const nodeId = record.source?.nodeId;
  if (!nodeId) return true;
  const node = getDb().prepare('SELECT memory_mode FROM nodes WHERE id = ?').get(nodeId) as { memory_mode: string | null } | undefined;
  return !node || node.memory_mode === null;
}

/** Hard delete; the FTS row goes with it (memories_fts_ad). */
export function deleteMemoryRow(ownerUserId: string, id: string): boolean {
  const result = getDb().prepare('DELETE FROM memories WHERE id = ? AND owner_user_id = ?').run(id, ownerUserId);
  return Number(result.changes) === 1;
}

/** Which scopes a read covers: the user scope, and some or all of the owner's workspaces. */
export interface MemoryScopeFilter {
  user: boolean;
  workspaceIds: readonly string[] | 'all';
}

type SqlParam = string | number;

function scopeClause(filter: MemoryScopeFilter, params: SqlParam[]): string | null {
  const parts: string[] = [];
  if (filter.user) parts.push(`m.scope = 'user'`);
  if (filter.workspaceIds === 'all') {
    parts.push(`m.scope = 'workspace'`);
  } else if (filter.workspaceIds.length > 0) {
    parts.push(`(m.scope = 'workspace' AND m.workspace_id IN (${filter.workspaceIds.map(() => '?').join(', ')}))`);
    params.push(...filter.workspaceIds);
  }
  return parts.length > 0 ? `(${parts.join(' OR ')})` : null;
}

function statusClause(statuses: readonly MemoryStatus[], params: SqlParam[]): string {
  params.push(...statuses);
  return `m.status IN (${statuses.map(() => '?').join(', ')})`;
}

/**
 * Whitespace-separated terms of a search. The trigram index can only match a
 * term of three or more characters; shorter terms (such as two-character
 * Chinese words) are matched with LIKE instead.
 */
interface TextTerms {
  all: string[];
  indexed: string[];
  short: string[];
}

const MIN_TRIGRAM_CHARS = 3;

export function splitTerms(query: string): TextTerms {
  const all = query.split(/\s+/u).filter(Boolean);
  const indexed = all.filter((term) => [...term].length >= MIN_TRIGRAM_CHARS);
  const short = all.filter((term) => [...term].length < MIN_TRIGRAM_CHARS);
  return { all, indexed, short };
}

/** A quoted FTS5 string is literal: operators, columns filters and wildcards inside it mean nothing. */
function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** LIKE pattern for a literal substring, with ESCAPE '\'. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const LIKE = `m.body LIKE ? ESCAPE '\\'`;

export interface MemoryListFilter {
  scope: MemoryScopeFilter;
  statuses: readonly MemoryStatus[];
  /** Every term must occur (a filter, not a ranking). */
  terms: TextTerms | null;
  /** Only rows older (smaller row_id) than this one. */
  beforeRowId: number | null;
  limit: number;
}

/** Newest first; one extra row tells the caller whether another page exists. */
export function listMemoryRows(ownerUserId: string, filter: MemoryListFilter): { records: MemoryRecord[]; lastRowId: number | null; more: boolean } {
  const params: SqlParam[] = [ownerUserId];
  const where = ['m.owner_user_id = ?'];
  const scope = scopeClause(filter.scope, params);
  if (!scope) return { records: [], lastRowId: null, more: false };
  where.push(scope, statusClause(filter.statuses, params));
  if (filter.terms && filter.terms.indexed.length > 0) {
    where.push('m.row_id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)');
    params.push(filter.terms.indexed.map(ftsPhrase).join(' AND '));
  }
  for (const term of filter.terms?.short ?? []) {
    where.push(LIKE);
    params.push(likePattern(term));
  }
  if (filter.beforeRowId !== null) {
    where.push('m.row_id < ?');
    params.push(filter.beforeRowId);
  }
  params.push(filter.limit + 1);
  const rows = getDb().prepare(`SELECT ${COLUMNS} FROM memories m WHERE ${where.join(' AND ')}
    ORDER BY m.row_id DESC LIMIT ?`).all(...params) as unknown as MemoryRow[];
  const more = rows.length > filter.limit;
  const page = more ? rows.slice(0, filter.limit) : rows;
  return { records: page.map(toRecord), lastRowId: page.length > 0 ? page[page.length - 1].row_id : null, more };
}

/** A memory with its row id (for refs, memoryRefs.ts) and the title of the conversation it came from, while that is readable. */
export interface StoredMemory {
  rowId: number;
  record: MemoryRecord;
  sourceTitle: string | null;
}

type StoredMemoryRow = MemoryRow & { source_title: string | null };

/**
 * COLUMNS plus the source conversation's title when it is neither purged nor
 * in Trash (an arch-* archive group is not Trash) and it still learns (its
 * memory setting is not Use only or Off). A memory outlives the conversation
 * it came from: deleting that, or switching it away from learn, only takes
 * the title away.
 */
const STORED_FROM = `SELECT ${COLUMNS},
    CASE WHEN n.purged_at IS NULL AND (n.deleted_at IS NULL OR n.deletion_group_id LIKE 'arch-%') AND n.memory_mode IS NULL THEN n.title END AS source_title
  FROM memories m LEFT JOIN nodes n ON n.id = m.source_node_id`;

/** Rows of STORED_FROM as StoredMemory. */
function storedRows(rows: readonly StoredMemoryRow[]): StoredMemory[] {
  return rows.map((row) => ({ rowId: row.row_id, record: toRecord(row), sourceTitle: row.source_title }));
}

/**
 * What a memory pack may pin (contextBuilder.ts): active memories the user
 * saved (origin explicit, any kind) and active standing preferences and
 * conventions (none tied to a dated event: event_at unset), in the user
 * scope and, with a workspaceId, that workspace; newest said first.
 */
export function packMemoryRows(ownerUserId: string, workspaceId: string | null, limit: number): StoredMemory[] {
  const inWorkspace = workspaceId === null ? '' : ` OR (m.scope = 'workspace' AND m.workspace_id = ?)`;
  const params: SqlParam[] = workspaceId === null ? [ownerUserId, limit] : [ownerUserId, workspaceId, limit];
  const rows = getDb().prepare(`${STORED_FROM}
    WHERE m.owner_user_id = ? AND m.status = 'active'
      AND (m.origin = 'explicit' OR (m.kind IN ('preference', 'convention') AND m.event_at IS NULL))
      AND (m.scope = 'user'${inWorkspace})
    ORDER BY COALESCE(m.observed_at, m.created_at) DESC, m.row_id DESC
    LIMIT ?`).all(...params) as unknown as StoredMemoryRow[];
  return storedRows(rows);
}

/**
 * What the user's profile is built from (userProfile.ts): the owner's active
 * user-scope memories Michi saved itself (origin extracted), newest said
 * first. The user's own saved memories are pinned word for word in every
 * pack and stay out of it.
 */
export function profileMemoryRows(ownerUserId: string, limit: number): StoredMemory[] {
  const rows = getDb().prepare(`${STORED_FROM}
    WHERE m.owner_user_id = ? AND m.status = 'active' AND m.scope = 'user' AND m.origin = 'extracted'
    ORDER BY COALESCE(m.observed_at, m.created_at) DESC, m.row_id DESC
    LIMIT ?`).all(ownerUserId, limit) as unknown as StoredMemoryRow[];
  return storedRows(rows);
}

/** How many memories profileMemoryRows would read (at most `limit`). */
export function profileMemoryCount(ownerUserId: string, limit: number): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM memories m
      WHERE m.owner_user_id = ? AND m.status = 'active' AND m.scope = 'user' AND m.origin = 'extracted' LIMIT ?)`)
    .get(ownerUserId, limit) as { n: number }).n;
}

/**
 * How many of the owner's user-scope memories that a profile may rest on
 * (origin extracted) changed after `since` (ms): written, edited or
 * corrected, plus the user-scope memories removed since (their tombstones);
 * counted up to `cap`.
 */
export function userScopeChangesSince(ownerUserId: string, since: number, cap: number): number {
  const row = getDb().prepare(`SELECT
      (SELECT COUNT(*) FROM (SELECT 1 FROM memories WHERE owner_user_id = ? AND scope = 'user' AND origin = 'extracted' AND updated_at > ? LIMIT ?))
    + (SELECT COUNT(*) FROM (SELECT 1 FROM memory_extraction_tombstones WHERE owner_user_id = ? AND workspace_id IS NULL AND created_at > ?
        AND body_hash <> ? LIMIT ?)) AS n`)
    // A turn's own tombstone (recallIndex: the empty body's hash) removed no memory.
    .get(ownerUserId, since, cap, ownerUserId, since, memoryBodyHash(''), cap) as { n: number };
  return Math.min(cap, row.n);
}

/** The owner's memories with these ids, whatever their status (absent ones are missing from the result). */
export function storedMemories(ownerUserId: string, ids: readonly string[]): StoredMemory[] {
  if (ids.length === 0) return [];
  const rows = getDb().prepare(`${STORED_FROM} WHERE +m.owner_user_id = ? AND m.id IN (SELECT value FROM json_each(?))`)
    .all(ownerUserId, JSON.stringify(ids)) as unknown as StoredMemoryRow[];
  return storedRows(rows);
}

/** Corrections followed at most, a guard against a corrupt cycle. */
const MAX_CORRECTION_STEPS = 50;

/**
 * The active memory that replaced this one through one or more corrections
 * (records linked by supersedes_id, forward) or merges (consolidation's
 * merged_into_id: the note it repeated, or the newer note that replaced it),
 * or null when there is none (the memory is current, or what replaced it was
 * deleted or is pending).
 */
export function currentCorrection(ownerUserId: string, id: string): StoredMemory | null {
  const seen = new Set<string>([id]);
  let ids = [id];
  for (let step = 0; step < MAX_CORRECTION_STEPS && ids.length > 0; step += 1) {
    const list = JSON.stringify(ids);
    const rows = getDb().prepare(`${STORED_FROM} WHERE +m.owner_user_id = ? AND (m.supersedes_id IN (SELECT value FROM json_each(?))
        OR m.id IN (SELECT o.merged_into_id FROM memories o WHERE +o.owner_user_id = ? AND o.merged_into_id IS NOT NULL
          AND o.id IN (SELECT value FROM json_each(?))))
      ORDER BY m.row_id DESC`).all(ownerUserId, list, ownerUserId, list) as unknown as StoredMemoryRow[];
    const active = rows.find((row) => row.status === 'active');
    if (active) return storedRows([active])[0]!;
    ids = rows.map((row) => row.id).filter((next) => !seen.has(next));
    for (const next of ids) seen.add(next);
  }
  return null;
}

// ── consolidation (migration 0077) ──────────────────────────────────────────

/** A memory as consolidation reads it: the record and its row, with the columns the wire never carries. */
export interface ConsolidationMemoryRow {
  rowId: number;
  record: MemoryRecord;
  /** The memory consolidation merged it into, or null. */
  mergedIntoId: string | null;
  /** When the user edited it in Settings › Memory, or null. */
  userEditedAt: number | null;
}

type ConsolidationRow = MemoryRow & { merged_into_id: string | null; user_edited_at: number | null };

const CONSOLIDATION_COLUMNS = `${COLUMNS}, m.merged_into_id, m.user_edited_at`;

function toConsolidationRow(row: ConsolidationRow): ConsolidationMemoryRow {
  return { rowId: row.row_id, record: toRecord(row), mergedIntoId: row.merged_into_id, userEditedAt: row.user_edited_at };
}

/** The owner's memories with these ids, whatever their status (absent ones are missing from the result). */
export function consolidationRows(ownerUserId: string, ids: readonly string[]): ConsolidationMemoryRow[] {
  if (ids.length === 0) return [];
  return (getDb().prepare(`SELECT ${CONSOLIDATION_COLUMNS} FROM memories m WHERE +m.owner_user_id = ? AND m.id IN (SELECT value FROM json_each(?))`)
    .all(ownerUserId, JSON.stringify(ids)) as unknown as ConsolidationRow[]).map(toConsolidationRow);
}

const AFTER_CURSOR = '(m.updated_at > ? OR (m.updated_at = ? AND m.row_id > ?))';

/** The owner's active, trusted memories written or changed after a consolidation cursor, oldest change first, at most `limit`. */
export function consolidationRowsAfter(ownerUserId: string, cursor: { at: number; row: number }, limit: number): ConsolidationMemoryRow[] {
  return (getDb().prepare(`SELECT ${CONSOLIDATION_COLUMNS} FROM memories m WHERE m.owner_user_id = ? AND m.status = 'active'
      AND m.source_risk IS NULL AND ${AFTER_CURSOR} ORDER BY m.updated_at, m.row_id LIMIT ?`)
    .all(ownerUserId, cursor.at, cursor.at, cursor.row, limit) as unknown as ConsolidationRow[]).map(toConsolidationRow);
}

/** How many of the owner's active, trusted memories wait after a consolidation cursor, and when the oldest of them changed. */
export function consolidationWaiting(ownerUserId: string, cursor: { at: number; row: number }): { count: number; oldest: number | null } {
  const row = getDb().prepare(`SELECT COUNT(*) AS n, MIN(m.updated_at) AS oldest FROM memories m WHERE m.owner_user_id = ?
      AND m.status = 'active' AND m.source_risk IS NULL AND ${AFTER_CURSOR}`)
    .get(ownerUserId, cursor.at, cursor.at, cursor.row) as { n: number; oldest: number | null };
  return { count: row.n, oldest: row.oldest };
}

/** The owner's active, trusted memories in the user scope and these workspaces (any or all), for consolidation's same-body neighbours. */
export function consolidationActiveRows(ownerUserId: string, workspaceIds: readonly string[]): ConsolidationMemoryRow[] {
  return (getDb().prepare(`SELECT ${CONSOLIDATION_COLUMNS} FROM memories m WHERE m.owner_user_id = ? AND m.status = 'active'
      AND m.source_risk IS NULL AND (m.scope = 'user' OR m.workspace_id IN (SELECT value FROM json_each(?))) ORDER BY m.row_id`)
    .all(ownerUserId, JSON.stringify(workspaceIds)) as unknown as ConsolidationRow[]).map(toConsolidationRow);
}

/** The workspaces the owner holds active workspace-scope memories in. */
export function memoryWorkspaceIds(ownerUserId: string): string[] {
  return (getDb().prepare(`SELECT DISTINCT workspace_id FROM memories WHERE owner_user_id = ? AND scope = 'workspace' AND status = 'active'
      ORDER BY workspace_id`).all(ownerUserId) as Array<{ workspace_id: string }>).map((row) => row.workspace_id);
}

/** How many active notes Michi wrote itself the owner has (extracted, not imported or edited by the user, trusted). */
export function activeMichiNoteCount(ownerUserId: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM memories WHERE owner_user_id = ? AND status = 'active' AND origin = 'extracted'
      AND import_source IS NULL AND user_edited_at IS NULL AND source_risk IS NULL`).get(ownerUserId) as { n: number }).n;
}

/** The owner's memory with this row id (a ref's), whatever its status; null for a missing or another owner's row. */
export function storedMemoryByRowId(ownerUserId: string, rowId: number): StoredMemory | null {
  const row = getDb().prepare(`${STORED_FROM} WHERE m.row_id = ? AND m.owner_user_id = ?`)
    .get(rowId, ownerUserId) as StoredMemoryRow | undefined;
  return row ? storedRows([row])[0]! : null;
}

export function bumpScopeVersion(ownerUserId: string, workspaceId: string | null, now: number): void {
  getDb().prepare(`INSERT INTO memory_scope_versions (owner_user_id, workspace_id, version, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT (owner_user_id, workspace_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at`)
    .run(ownerUserId, workspaceId ?? USER_SCOPE_KEY, now);
}

export function readScopeVersion(ownerUserId: string, workspaceId: string | null): number {
  const row = getDb().prepare('SELECT version FROM memory_scope_versions WHERE owner_user_id = ? AND workspace_id = ?')
    .get(ownerUserId, workspaceId ?? USER_SCOPE_KEY) as { version: number } | undefined;
  return row?.version ?? 0;
}

export function readMemoryMode(ownerUserId: string): MemoryMode | null {
  const row = getDb().prepare('SELECT mode FROM memory_settings WHERE owner_user_id = ?')
    .get(ownerUserId) as { mode: MemoryMode } | undefined;
  return row?.mode ?? null;
}

export function writeMemoryMode(ownerUserId: string, mode: MemoryMode, now: number): void {
  getDb().prepare(`INSERT INTO memory_settings (owner_user_id, mode, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (owner_user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`)
    .run(ownerUserId, mode, now);
}

const NOTICE_MOVED_KEY = (ownerUserId: string) => `memory_notice_moved_from_explicit:${ownerUserId}`;
const NOTICE_SEEN_KEY = (ownerUserId: string) => `memory_notice_seen:${ownerUserId}`;

/** The owner had the retired explicit-only mode, which became on (extractionService.migrateRetiredExplicitMode). */
export function markMovedFromExplicit(ownerUserId: string, now: number): void {
  getDb().prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(NOTICE_MOVED_KEY(ownerUserId), String(now));
}

/** The one-time notice of Settings › Memory: whether the owner came from explicit-only, and whether they have seen it. */
export function readMemoryNotice(ownerUserId: string): { migratedFromExplicit: boolean; noticeSeen: boolean } {
  const has = (key: string) => !!getDb().prepare('SELECT 1 FROM meta WHERE key = ?').get(key);
  return { migratedFromExplicit: has(NOTICE_MOVED_KEY(ownerUserId)), noticeSeen: has(NOTICE_SEEN_KEY(ownerUserId)) };
}

export function markMemoryNoticeSeen(ownerUserId: string, now: number): void {
  getDb().prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(NOTICE_SEEN_KEY(ownerUserId), String(now));
}

/** Owners whose stored mode is exactly `mode`, in id order. */
export function listOwnersWithStoredMode(mode: MemoryMode): string[] {
  return (getDb().prepare('SELECT owner_user_id FROM memory_settings WHERE mode = ? ORDER BY owner_user_id').all(mode) as
    Array<{ owner_user_id: string }>).map((row) => row.owner_user_id);
}

/** Owners with at least one pending memory (left by an older version), in id order. */
export function listOwnersWithPendingMemories(): string[] {
  return (getDb().prepare("SELECT DISTINCT owner_user_id FROM memories WHERE status = 'pending' ORDER BY owner_user_id").all() as
    Array<{ owner_user_id: string }>).map((row) => row.owner_user_id);
}

/**
 * The owner's active memory in the user scope or, with a workspaceId, that
 * workspace whose body reads the same once normalized (normalizeMemoryBody,
 * as extraction's dedupe compares them), the user's own first; else null.
 */
export function activeMemoryWithBody(ownerUserId: string, workspaceId: string | null, body: string): StoredMemory | null {
  const wanted = normalizeMemoryBody(body);
  const inWorkspace = workspaceId === null ? '' : ` OR (m.scope = 'workspace' AND m.workspace_id = ?)`;
  const rows = getDb().prepare(`SELECT m.id, m.body FROM memories m WHERE m.owner_user_id = ? AND m.status = 'active'
      AND (m.scope = 'user'${inWorkspace}) ORDER BY m.origin = 'explicit' DESC, m.row_id DESC`)
    .all(...(workspaceId === null ? [ownerUserId] : [ownerUserId, workspaceId])) as Array<{ id: string; body: string }>;
  const match = rows.find((row) => normalizeMemoryBody(row.body) === wanted);
  return match ? storedMemories(ownerUserId, [match.id])[0] ?? null : null;
}

// ── conversations ────────────────────────────────────────────────────────────

/** A conversation's memory setting (nodes.memory_mode, migration 0076): NULL is learn. */
export function readConversationMemoryMode(nodeId: string | null | undefined): ConversationMemoryMode {
  if (!nodeId) return 'learn';
  const row = getDb().prepare('SELECT memory_mode FROM nodes WHERE id = ?').get(nodeId) as { memory_mode: string | null } | undefined;
  return isConversationMemoryMode(row?.memory_mode) ? row.memory_mode : 'learn';
}

/** Stores a conversation's memory setting; learn is stored as NULL. */
export function writeConversationMemoryMode(nodeId: string, mode: ConversationMemoryMode): void {
  getDb().prepare('UPDATE nodes SET memory_mode = ? WHERE id = ?').run(mode === 'learn' ? null : mode, nodeId);
}

/** Whether a conversation holds a message, whether it has a turn, and the node it branched from. */
export function conversationStart(nodeId: string): { hasMessage: boolean; hasTurn: boolean; parentNodeId: string | null } {
  const row = getDb().prepare(`SELECT n.parent_node_id,
      EXISTS (SELECT 1 FROM messages m WHERE m.node_id = n.id) AS has_message, EXISTS (SELECT 1 FROM turns t WHERE t.node_id = n.id) AS has_turn
    FROM nodes n WHERE n.id = ?`).get(nodeId) as { parent_node_id: string | null; has_message: number; has_turn: number } | undefined;
  return { hasMessage: row?.has_message === 1, hasTurn: row?.has_turn === 1, parentNodeId: row?.parent_node_id ?? null };
}

/** A chat conversation's workspace, while it is neither purged nor in Trash; null otherwise. */
export function conversationWorkspaceId(nodeId: string): string | null {
  const row = getDb().prepare(`SELECT workspace_id FROM nodes WHERE id = ? AND kind = 'chat' AND purged_at IS NULL AND deleted_at IS NULL`)
    .get(nodeId) as { workspace_id: string } | undefined;
  return row?.workspace_id ?? null;
}

/** A memory consolidation put away into another (migration 0077): its text leaves with its source like an active one's. */
const MERGED_PREDECESSOR = "(status = 'superseded' AND merged_into_id IS NOT NULL)";

/**
 * The owner's memories Michi saved on its own from this conversation (active
 * or pending, and those consolidation merged into another): what leaving
 * learn removes.
 */
export function extractedMemoryIdsFromNode(ownerUserId: string, nodeId: string): string[] {
  return (getDb().prepare(`SELECT id FROM memories WHERE owner_user_id = ? AND source_node_id = ? AND origin = 'extracted'
      AND (status IN ('active', 'pending') OR ${MERGED_PREDECESSOR}) ORDER BY row_id`).all(ownerUserId, nodeId) as Array<{ id: string }>).map((row) => row.id);
}

/**
 * Every memory of the owner and their profile, removed at once (POST
 * /api/memories/reset): the records as they were. Settings, tombstones and
 * import records stay, so nothing removed comes back by itself.
 */
export function deleteOwnerMemoryRows(ownerUserId: string): MemoryRecord[] {
  const rows = getDb().prepare(`SELECT ${COLUMNS} FROM memories m WHERE m.owner_user_id = ? ORDER BY m.row_id`).all(ownerUserId) as unknown as MemoryRow[];
  getDb().prepare('DELETE FROM memories WHERE owner_user_id = ?').run(ownerUserId);
  getDb().prepare('DELETE FROM memory_user_profiles WHERE owner_user_id = ?').run(ownerUserId);
  // Consolidation's log names only memory ids, all gone now; its cursor stays (what follows is new).
  getDb().prepare('DELETE FROM memory_consolidation_log WHERE owner_user_id = ?').run(ownerUserId);
  getDb().prepare('DELETE FROM memory_turn_sources WHERE owner_user_id = ?').run(ownerUserId);
  return rows.map(toRecord);
}

/** The owner's active memories from this turn, any origin (idx_memories_owner_source_turn). */
export function activeMemoriesFromTurn(ownerUserId: string, turnId: string): Array<{ id: string; body: string; origin: MemoryOrigin }> {
  return getDb().prepare("SELECT id, body, origin FROM memories WHERE owner_user_id = ? AND source_turn_id = ? AND status = 'active'")
    .all(ownerUserId, turnId) as Array<{ id: string; body: string; origin: MemoryOrigin }>;
}

/** When a conversation's turn began (turns.started_at: the user sent it), or null when there is no such turn. */
export function turnStartedAt(nodeId: string, turnId: string): number | null {
  const row = getDb().prepare('SELECT started_at FROM turns WHERE turn_id = ? AND node_id = ?').get(turnId, nodeId) as { started_at: number } | undefined;
  return row?.started_at ?? null;
}

/**
 * The notes Michi took on its own (origin extracted, none imported) from a
 * conversation's turns other than `exceptTurnIds`, active, of the user scope
 * or this workspace, newest said first: what automatic extraction lists of a
 * conversation's earlier turns, so that a decline later in the conversation
 * can leave them out (extractionV2.buildExtractionPrompt).
 */
export function michiNotesFromConversation(input: {
  ownerUserId: string; nodeId: string; workspaceId: string; exceptTurnIds: readonly string[]; limit: number;
}): StoredMemory[] {
  const rows = getDb().prepare(`${STORED_FROM}
    WHERE m.owner_user_id = ? AND m.status = 'active' AND m.origin = 'extracted' AND m.import_source IS NULL
      AND m.source_node_id = ? AND m.source_turn_id IS NOT NULL AND m.source_turn_id NOT IN (SELECT value FROM json_each(?))
      AND (m.scope = 'user' OR (m.scope = 'workspace' AND m.workspace_id = ?))
    ORDER BY COALESCE(m.observed_at, m.created_at) DESC, m.row_id DESC
    LIMIT ?`).all(input.ownerUserId, input.nodeId, JSON.stringify(input.exceptTurnIds), input.workspaceId, input.limit) as unknown as StoredMemoryRow[];
  return storedRows(rows);
}

/** Every owner's memories after a row id, in row order, any status (the recall index backfill pages through them). */
export function memoriesAfterRow(afterRowId: number, limit: number): Array<{ rowId: number; record: MemoryRecord }> {
  const rows = getDb().prepare(`SELECT ${COLUMNS} FROM memories m WHERE m.row_id > ? ORDER BY m.row_id LIMIT ?`)
    .all(afterRowId, limit) as unknown as MemoryRow[];
  return rows.map((row) => ({ rowId: row.row_id, record: toRecord(row) }));
}

/** Bodies of the owner's active memories in the user scope and, with a workspaceId, in that workspace. */
export function activeMemoryBodies(ownerUserId: string, workspaceId: string | null): string[] {
  const inWorkspace = workspaceId === null ? '' : ` OR (m.scope = 'workspace' AND m.workspace_id = ?)`;
  return (getDb().prepare(`SELECT m.body FROM memories m WHERE m.owner_user_id = ? AND m.status = 'active'
      AND (m.scope = 'user'${inWorkspace})`).all(...(workspaceId === null ? [ownerUserId] : [ownerUserId, workspaceId])) as
    Array<{ body: string }>).map((row) => row.body);
}

/**
 * A permanently deleted workspace takes its memories, scope counter and
 * recall documents with it (deleteWorkspace). Removal hooks do not run:
 * nothing of the workspace is left for them to protect.
 */
export function purgeWorkspaceMemories(workspaceId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM memories WHERE workspace_id = ?').run(workspaceId);
  db.prepare('DELETE FROM memory_scope_versions WHERE workspace_id = ?').run(workspaceId);
  // memory_recall_docs_ad removes their index entries.
  db.prepare('DELETE FROM memory_recall_docs WHERE workspace_id = ?').run(workspaceId);
  db.prepare('DELETE FROM memory_import_items WHERE workspace_id = ?').run(workspaceId);
  purgeWorkspaceExtraction(workspaceId);
}

/** A deleted account's memories, counters, settings, recall documents and profile (admin user deletion). */
export function purgeOwnerMemories(ownerUserId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM memories WHERE owner_user_id = ?').run(ownerUserId);
  db.prepare('DELETE FROM memory_scope_versions WHERE owner_user_id = ?').run(ownerUserId);
  db.prepare('DELETE FROM memory_settings WHERE owner_user_id = ?').run(ownerUserId);
  db.prepare('DELETE FROM memory_recall_docs WHERE owner_user_id = ?').run(ownerUserId);
  db.prepare('DELETE FROM memory_user_profiles WHERE owner_user_id = ?').run(ownerUserId);
  db.prepare('DELETE FROM memory_import_items WHERE owner_user_id = ?').run(ownerUserId);
  db.prepare('DELETE FROM memory_consolidation_log WHERE owner_user_id = ?').run(ownerUserId);
  db.prepare('DELETE FROM memory_consolidation_state WHERE owner_user_id = ?').run(ownerUserId);
  db.prepare('DELETE FROM memory_turn_sources WHERE owner_user_id = ?').run(ownerUserId);
  db.prepare('DELETE FROM meta WHERE key IN (?, ?)').run(NOTICE_MOVED_KEY(ownerUserId), NOTICE_SEEN_KEY(ownerUserId));
  purgeOwnerExtraction(ownerUserId);
}
