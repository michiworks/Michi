import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MEMORY_SETTINGS,
  isConversationMemoryMode,
  MEMORY_BODY_MAX_CHARS,
  MEMORY_KEYWORD_MAX_CHARS,
  MEMORY_KEYWORDS_MAX_COUNT,
  MEMORY_TOPIC_MAX_CHARS,
  isMemoryKind,
  isMemoryMode,
  isMemoryOrigin,
  isMemoryStatus,
  type ConversationMemoryMode,
  type MemoryChangeAction,
  type MemoryChangedEvent,
  type MemoryErrorCode,
  type MemoryKind,
  type MemoryMode,
  type MemoryOrigin,
  type MemoryRecord,
  type MemoryScope,
  type MemorySettings,
  type MemorySource,
  type MemorySourceRisk,
  type MemoryStatus,
} from 'michi-shared';
import { DomainError, type DomainErrorKind } from '../domainErrors';
import { log } from '../logger';
import { runAfterCommit } from '../db';
import { restartExtractionAt, skipConversationExtraction, workspaceCompletionCounter } from './extractionRepository';
import {
  bumpScopeVersion,
  conversationWorkspaceId,
  deleteMemoryRow,
  deleteOwnerMemoryRows,
  extractedMemoryIdsFromNode,
  findMemory,
  hasLearningSource,
  insertMemoryRow,
  listMemoryRows,
  markMemoryNoticeSeen,
  memoryTransaction,
  memoryVersionChain,
  mergedDirectlyInto,
  mergedPredecessors,
  readConversationMemoryMode,
  readMemoryMode,
  readMemoryNotice,
  readScopeVersion,
  spelledTopic,
  splitTerms,
  updateMemoryRow,
  workspaceAccessible,
  writeConversationMemoryMode,
  writeMemoryMode,
  type MemoryRowChanges,
  type MemoryScopeFilter,
} from './memoryRepository';
import { hideConversationTurns, indexMemory, removeMemory as removeRecallDoc, resetOwnerRecall } from './recallIndex';

/**
 * Michi Memory service (C1). Every entry point takes the caller's owner and
 * nothing else that grants access: rows are read and written only for that
 * owner (memoryRepository), and a workspace scope must be a workspace the
 * owner owns. Changes bump a per-scope counter (memoryVersion) and are
 * announced on memoryEvents after they commit. Every row write also updates
 * the memory's recall document in the same transaction (recallIndex).
 */

export interface MemoryCaller {
  ownerUserId: string;
}

const KIND_FOR_CODE: Record<MemoryErrorCode, DomainErrorKind> = {
  invalid_argument: 'invalid_argument',
  not_found: 'not_found',
  version_conflict: 'conflict',
  invalid_state: 'conflict',
  memory_disabled: 'conflict',
};

/**
 * not_found also covers another owner's memory or workspace, so callers
 * cannot tell the two apart. memory_disabled: the owner's mode is off.
 */
export class MemoryError extends DomainError {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    /** The stored version, for version_conflict. */
    readonly currentVersion?: number,
  ) {
    super(KIND_FOR_CODE[code], code, message);
  }
}

// ── events and hooks ───────────────────────────────────────────────────────

export interface MemorySettingsChangedEvent {
  ownerUserId: string;
  mode: MemoryMode;
  previousMode: MemoryMode;
}

interface MemoryEventMap {
  /** One per stored record change (C4 payload). */
  changed: [MemoryChangedEvent];
  settingsChanged: [MemorySettingsChangedEvent];
}

/**
 * `changed` is emitted synchronously once the change commits: at once, or when
 * the caller's own transaction commits, and never if that rolls back. A
 * throwing listener is logged, never the caller's failure.
 */
export const memoryEvents = new EventEmitter<MemoryEventMap>();

export interface MemoryRemoval {
  /** The record as it was stored just before removal. */
  record: MemoryRecord;
  reason: 'deleted' | 'rejected';
}

type MemoryRemovalHook = (removal: MemoryRemoval) => void;
const removalHooks = new Set<MemoryRemovalHook>();

/**
 * Run `hook` whenever deleteMemory, forgetMemory or rejectMemory removes a
 * record, once for each version a deletion takes (for example to write a
 * tombstone so extraction never proposes it again). The hook runs
 * synchronously inside the removing transaction, after the rows are gone:
 * its own writes to data.db commit with the removal, and a hook that throws
 * rolls the removal back. Returns an unregister function.
 */
export function onMemoryRemoved(hook: MemoryRemovalHook): () => void {
  removalHooks.add(hook);
  return () => { removalHooks.delete(hook); };
}

/**
 * Announce changes a caller committed in a transaction of its own (consolidation.ts: what it put away, after
 * its commit), as every write here announces its own.
 */
export function announceMemoryChanges(records: readonly MemoryRecord[], action: MemoryChangeAction): void {
  for (const record of records) emitChanged(record, action);
}

function emitChanged(record: MemoryRecord, action: MemoryChangeAction): void {
  const event: MemoryChangedEvent = {
    ownerUserId: record.ownerUserId,
    workspaceId: scopeWorkspaceId(record.scope),
    memoryId: record.id,
    action,
    status: record.status,
    body: record.body,
    origin: record.origin,
    ...(record.source?.nodeId ? { nodeId: record.source.nodeId } : {}),
    supersedesId: record.supersedesId,
  };
  runAfterCommit(() => {
    try {
      memoryEvents.emit('changed', event);
    } catch (error) {
      log.warn('workspace', 'memory change listener failed', { action, error: (error as Error).message });
    }
  });
}

// ── validation ─────────────────────────────────────────────────────────────

function owner(caller: MemoryCaller): string {
  const id = typeof caller?.ownerUserId === 'string' ? caller.ownerUserId.trim() : '';
  if (!id) throw new MemoryError('invalid_argument', 'ownerUserId is required');
  return id;
}

function memoryId(id: unknown): string {
  if (typeof id !== 'string' || !id.trim()) throw new MemoryError('not_found', 'Memory not found');
  return id;
}

function normalizeBody(body: unknown): string {
  if (typeof body !== 'string') throw new MemoryError('invalid_argument', 'body must be a string');
  const trimmed = body.trim();
  if (!trimmed) throw new MemoryError('invalid_argument', 'body must not be empty');
  if (trimmed.length > MEMORY_BODY_MAX_CHARS) {
    throw new MemoryError('invalid_argument', `body must be at most ${MEMORY_BODY_MAX_CHARS} characters`);
  }
  return trimmed;
}

function normalizeKind(kind: unknown): MemoryKind {
  if (!isMemoryKind(kind)) throw new MemoryError('invalid_argument', 'kind must be preference, fact, decision or convention');
  return kind;
}

function normalizeOrigin(origin: unknown): MemoryOrigin {
  if (!isMemoryOrigin(origin)) throw new MemoryError('invalid_argument', 'origin must be explicit or extracted');
  return origin;
}

type NewMemoryStatus = Exclude<MemoryStatus, 'superseded'>;

function normalizeNewStatus(status: unknown): NewMemoryStatus {
  if (status !== 'active' && status !== 'pending') throw new MemoryError('invalid_argument', 'status must be active or pending');
  return status;
}

function normalizeSourceRisk(risk: unknown): MemorySourceRisk | null {
  if (risk === undefined || risk === null) return null;
  if (risk !== 'untrusted') throw new MemoryError('invalid_argument', 'sourceRisk must be untrusted or null');
  return risk;
}

/**
 * Trimmed keywords with inner whitespace collapsed (so a keyword is never two
 * lines), blanks dropped, and duplicates (by NFKC, case-insensitive) kept once
 * in their first spelling.
 */
function normalizeKeywords(keywords: unknown): string[] {
  if (keywords === undefined || keywords === null) return [];
  if (!Array.isArray(keywords)) throw new MemoryError('invalid_argument', 'keywords must be a list of strings');
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of keywords) {
    if (typeof value !== 'string') throw new MemoryError('invalid_argument', 'keywords must be a list of strings');
    const keyword = value.replace(/\s+/gu, ' ').trim();
    if (!keyword) continue;
    if (keyword.length > MEMORY_KEYWORD_MAX_CHARS) {
      throw new MemoryError('invalid_argument', `a keyword must be at most ${MEMORY_KEYWORD_MAX_CHARS} characters`);
    }
    const key = keyword.normalize('NFKC').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(keyword);
  }
  if (result.length > MEMORY_KEYWORDS_MAX_COUNT) {
    throw new MemoryError('invalid_argument', `a memory takes at most ${MEMORY_KEYWORDS_MAX_COUNT} keywords`);
  }
  return result;
}

/** A topic on one line, trimmed and clipped to MEMORY_TOPIC_MAX_CHARS (a label, so a long one is cut, not refused); null for none. */
function normalizeTopic(topic: unknown): string | null {
  if (topic === undefined || topic === null) return null;
  if (typeof topic !== 'string') throw new MemoryError('invalid_argument', 'topic must be a string');
  const line = topic.replace(/\s+/gu, ' ').trim();
  return line ? Array.from(line).slice(0, MEMORY_TOPIC_MAX_CHARS).join('').trim() : null;
}

/** The range of a JavaScript Date, in ms since the epoch. */
const MAX_TIME_MS = 8.64e15;

function normalizeTime(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > MAX_TIME_MS) {
    throw new MemoryError('invalid_argument', `${name} must be a time in milliseconds since the epoch`);
  }
  return value;
}

function sameKeywords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((keyword, index) => keyword === b[index]);
}

const SOURCE_KEYS = ['nodeId', 'messageId', 'turnId', 'artifactId'] as const;
const SOURCE_ID_MAX_CHARS = 256;

function normalizeSource(source: unknown): MemorySource | null {
  if (source === undefined || source === null) return null;
  if (typeof source !== 'object' || Array.isArray(source)) throw new MemoryError('invalid_argument', 'source must be an object');
  const input = source as Record<string, unknown>;
  const unknownKey = Object.keys(input).find((key) => !(SOURCE_KEYS as readonly string[]).includes(key));
  if (unknownKey) throw new MemoryError('invalid_argument', `source.${unknownKey} is not supported`);
  const result: MemorySource = {};
  for (const key of SOURCE_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length > SOURCE_ID_MAX_CHARS) {
      throw new MemoryError('invalid_argument', `source.${key} must be a string of at most ${SOURCE_ID_MAX_CHARS} characters`);
    }
    if (value.trim()) result[key] = value.trim();
  }
  return Object.keys(result).length > 0 ? result : null;
}

function scopeWorkspaceId(scope: MemoryScope): string | null {
  return scope.kind === 'workspace' ? scope.workspaceId : null;
}

/** A workspace id the owner may use, or not_found (missing, permanently deleted or someone else's). */
function accessibleWorkspace(ownerUserId: string, workspaceId: unknown): string {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    throw new MemoryError('invalid_argument', 'workspaceId must be a non-empty string');
  }
  if (!workspaceAccessible(ownerUserId, workspaceId)) throw new MemoryError('not_found', 'Workspace not found');
  return workspaceId;
}

/** The stored workspace id for a scope: null for the user scope. */
function resolveScope(ownerUserId: string, scope: unknown): string | null {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new MemoryError('invalid_argument', 'scope must be { kind: "user" } or { kind: "workspace", workspaceId }');
  }
  const value = scope as Record<string, unknown>;
  if (value.kind === 'user' && Object.keys(value).every((key) => key === 'kind')) return null;
  if (value.kind === 'workspace' && Object.keys(value).every((key) => key === 'kind' || key === 'workspaceId')) {
    return accessibleWorkspace(ownerUserId, value.workspaceId);
  }
  throw new MemoryError('invalid_argument', 'scope must be { kind: "user" } or { kind: "workspace", workspaceId }');
}

function normalizeStatuses(statuses: unknown, fallback: readonly MemoryStatus[]): readonly MemoryStatus[] {
  if (statuses === undefined || statuses === null) return fallback;
  if (!Array.isArray(statuses) || !statuses.every(isMemoryStatus)) {
    throw new MemoryError('invalid_argument', 'status must list active, pending or superseded');
  }
  return statuses.length > 0 ? [...new Set(statuses)] : fallback;
}

function normalizeLimit(limit: unknown, fallback: number, max: number): number {
  if (limit === undefined || limit === null) return fallback;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new MemoryError('invalid_argument', 'limit must be a positive integer');
  }
  return Math.min(limit, max);
}

function optionalWorkspaceId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new MemoryError('invalid_argument', 'workspaceId must be a string');
  return value;
}

// ── mode ───────────────────────────────────────────────────────────────────

/** The mode in effect: the retired 'explicit' (explicit-only) counts as 'auto', so memory is either on or off. */
function effectiveMode(mode: MemoryMode): MemoryMode {
  return mode === 'explicit' ? 'auto' : mode;
}

/** The stored mode, else the default (on), as effectiveMode reads it: never 'explicit'. */
function memoryMode(ownerUserId: string): MemoryMode {
  return effectiveMode(readMemoryMode(ownerUserId) ?? DEFAULT_MEMORY_SETTINGS.mode);
}

function assertEnabled(ownerUserId: string): void {
  if (memoryMode(ownerUserId) === 'off') throw new MemoryError('memory_disabled', 'Memory is turned off');
}

/** 'auto' (on) or 'off'; an owner without a setting, or with the retired 'explicit', is on. */
export function getMemorySettings(ownerUserId: string): MemorySettings {
  return { mode: memoryMode(owner({ ownerUserId })) };
}

/** GET /api/memory-settings: the mode, and the state of the one-time notice that memory is on. */
export function memorySettingsView(ownerUserId: string): MemorySettings {
  const ownerId = owner({ ownerUserId });
  return { mode: memoryMode(ownerId), ...readMemoryNotice(ownerId) };
}

/** The owner has seen the one-time notice (PUT /api/memory-settings { noticeSeen: true }). */
export function markNoticeSeen(ownerUserId: string): void {
  markMemoryNoticeSeen(owner({ ownerUserId }), Date.now());
}

/**
 * 'explicit', which older clients still send, is stored as 'auto'. A change of
 * the mode in effect also bumps the user scope's version, so injected memory
 * refreshes, and emits settingsChanged.
 */
export function setMemorySettings(ownerUserId: string, settings: MemorySettings): void {
  const ownerId = owner({ ownerUserId });
  const requested = settings?.mode;
  if (!isMemoryMode(requested)) throw new MemoryError('invalid_argument', 'mode must be off, explicit or auto');
  const mode = effectiveMode(requested);
  const previousMode = memoryMode(ownerId);
  memoryTransaction(() => {
    const now = Date.now();
    writeMemoryMode(ownerId, mode, now);
    if (mode !== previousMode) bumpScopeVersion(ownerId, null, now);
  });
  if (mode === previousMode) return;
  try {
    memoryEvents.emit('settingsChanged', { ownerUserId: ownerId, mode, previousMode });
  } catch (error) {
    log.warn('workspace', 'memory settings listener failed', { error: (error as Error).message });
  }
}

// ── writes ─────────────────────────────────────────────────────────────────

export interface CreateMemoryInput {
  scope: MemoryScope;
  kind: MemoryKind;
  body: string;
  source?: MemorySource | null;
  /** Every writer stores active; pending remains only for records older versions left (see activateLegacyPending). */
  status: NewMemoryStatus;
  origin: MemoryOrigin;
  /** The record this one corrects (see supersedeMemory). */
  supersedesId?: string | null;
  sourceRisk?: MemorySourceRisk | null;
  /** Search aliases (see MemoryRecord.keywords); at most MEMORY_KEYWORDS_MAX_COUNT. Default none. */
  keywords?: readonly string[] | null;
  /** What it is about (see MemoryRecord.topic); at most MEMORY_TOPIC_MAX_CHARS. Default none. */
  topic?: string | null;
  /** When the described event happens or happened (ms epoch). Default null. */
  eventAt?: number | null;
  /** When the user said it (ms epoch), for example the user message's time. Default: now. */
  observedAt?: number | null;
}

function requireMemory(ownerUserId: string, id: unknown): MemoryRecord {
  const record = findMemory(ownerUserId, memoryId(id));
  if (!record) throw new MemoryError('not_found', 'Memory not found');
  return record;
}

function markSuperseded(ownerUserId: string, old: MemoryRecord, now: number): MemoryRecord | null {
  if (old.status === 'superseded') return null;
  const updated = updateMemoryRow(ownerUserId, old.id, old.version, { status: 'superseded' }, now);
  if (!updated) throw new MemoryError('version_conflict', 'The corrected memory changed; reload it and try again');
  bumpScopeVersion(ownerUserId, scopeWorkspaceId(old.scope), now);
  indexMemory(updated);
  return updated;
}

/**
 * Store a memory. With supersedesId the new record corrects that one (same
 * owner; active or pending): an active correction supersedes it now. status
 * pending (approved later with approveMemory) is kept for older callers; no
 * writer in this version uses it.
 */
export function createMemory(caller: MemoryCaller, input: CreateMemoryInput): MemoryRecord {
  const ownerUserId = owner(caller);
  if (!input || typeof input !== 'object') throw new MemoryError('invalid_argument', 'input is required');
  const body = normalizeBody(input.body);
  const kind = normalizeKind(input.kind);
  const status = normalizeNewStatus(input.status);
  const origin = normalizeOrigin(input.origin);
  const source = normalizeSource(input.source);
  const sourceRisk = normalizeSourceRisk(input.sourceRisk);
  const keywords = normalizeKeywords(input.keywords);
  const topic = normalizeTopic(input.topic);
  const eventAt = normalizeTime(input.eventAt, 'eventAt');
  const observedAt = normalizeTime(input.observedAt, 'observedAt');
  assertEnabled(ownerUserId);
  const { created, superseded } = memoryTransaction(() => {
    const workspaceId = resolveScope(ownerUserId, input.scope);
    let old: MemoryRecord | null = null;
    if (input.supersedesId !== undefined && input.supersedesId !== null) {
      old = requireMemory(ownerUserId, input.supersedesId);
      if (old.status === 'superseded') {
        throw new MemoryError('invalid_state', 'That memory was already corrected; correct the newer one');
      }
    }
    const now = Date.now();
    const record = insertMemoryRow({
      id: `mem-${randomUUID()}`, ownerUserId, workspaceId, kind, body, status, origin, source, sourceRisk,
      supersedesId: old?.id ?? null, keywords, topic: topic === null ? null : spelledTopic(ownerUserId, topic), eventAt,
      observedAt: observedAt ?? now, now,
    });
    bumpScopeVersion(ownerUserId, workspaceId, now);
    indexMemory(record);
    const replaced = old && status === 'active' ? markSuperseded(ownerUserId, old, now) : null;
    return { created: record, superseded: replaced };
  });
  emitChanged(created, 'created');
  if (superseded) emitChanged(superseded, 'superseded');
  return created;
}

export interface SupersedeMemoryInput {
  body: string;
  /** Defaults to the corrected record's kind. */
  kind?: MemoryKind;
  source?: MemorySource | null;
  status: NewMemoryStatus;
  origin: MemoryOrigin;
  sourceRisk?: MemorySourceRisk | null;
  /** As for createMemory; nothing is taken from the corrected record. */
  keywords?: readonly string[] | null;
  /** Defaults to the corrected record's topic; null for none. */
  topic?: string | null;
  eventAt?: number | null;
  observedAt?: number | null;
}

/** Correct a memory: a new record in the old one's scope, linked by supersedesId. */
export function supersedeMemory(caller: MemoryCaller, oldId: string, input: SupersedeMemoryInput): MemoryRecord {
  const ownerUserId = owner(caller);
  const old = requireMemory(ownerUserId, oldId);
  return createMemory(caller, {
    scope: old.scope,
    kind: input?.kind ?? old.kind,
    body: input?.body,
    source: input?.source,
    status: input?.status,
    origin: input?.origin,
    sourceRisk: input?.sourceRisk,
    keywords: input?.keywords,
    topic: input?.topic !== undefined ? input.topic : old.topic ?? null,
    eventAt: input?.eventAt,
    observedAt: input?.observedAt,
    supersedesId: old.id,
  });
}

export interface MemoryPatch {
  body?: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  /** Replaces the keywords; [] clears them. */
  keywords?: readonly string[];
  /** null clears the topic. */
  topic?: string | null;
  /** null clears the event time. */
  eventAt?: number | null;
}

/**
 * Edit body, scope, kind, keywords, topic or event time. With expectedVersion the
 * edit applies only to that version (version_conflict otherwise). Superseded
 * records are history and cannot be edited. `byUser`: the user edited it
 * (Settings › Memory): consolidation never changes such a memory
 * (user_edited_at); its origin stays as it was. What consolidation merged
 * into it comes back when what it says changed (releaseMergedOnChange).
 */
export function updateMemory(caller: MemoryCaller, id: string, patch: MemoryPatch, expectedVersion?: number, options: { byUser?: boolean } = {}): MemoryRecord {
  const ownerUserId = owner(caller);
  if (!patch || typeof patch !== 'object') throw new MemoryError('invalid_argument', 'patch is required');
  if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    throw new MemoryError('invalid_argument', 'expectedVersion must be a positive integer');
  }
  const changes: MemoryRowChanges = {};
  if (patch.body !== undefined) changes.body = normalizeBody(patch.body);
  if (patch.kind !== undefined) changes.kind = normalizeKind(patch.kind);
  if (patch.keywords !== undefined) changes.keywords = normalizeKeywords(patch.keywords);
  if (patch.topic !== undefined) changes.topic = normalizeTopic(patch.topic);
  if (patch.eventAt !== undefined) changes.eventAt = normalizeTime(patch.eventAt, 'eventAt');
  const updated = memoryTransaction(() => {
    const current = requireMemory(ownerUserId, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new MemoryError('version_conflict', 'The memory changed since it was read', current.version);
    }
    if (current.status === 'superseded') throw new MemoryError('invalid_state', 'A superseded memory cannot be edited');
    const fromWorkspaceId = scopeWorkspaceId(current.scope);
    if (patch.scope !== undefined) {
      const toWorkspaceId = resolveScope(ownerUserId, patch.scope);
      if (toWorkspaceId !== fromWorkspaceId) changes.workspaceId = toWorkspaceId;
    }
    if (changes.body === current.body) delete changes.body;
    if (changes.kind === current.kind) delete changes.kind;
    if (changes.keywords !== undefined && sameKeywords(changes.keywords, current.keywords ?? [])) delete changes.keywords;
    if (changes.eventAt !== undefined && changes.eventAt === (current.eventAt ?? null)) delete changes.eventAt;
    if (changes.topic) changes.topic = spelledTopic(ownerUserId, changes.topic);
    if (changes.topic !== undefined && changes.topic === (current.topic ?? null)) delete changes.topic;
    if (Object.keys(changes).length === 0) return null;
    const now = Date.now();
    const record = updateMemoryRow(ownerUserId, current.id, current.version, { ...changes, ...(options.byUser ? { userEditedAt: now } : {}) }, now);
    if (!record) throw new MemoryError('version_conflict', 'The memory changed since it was read');
    bumpScopeVersion(ownerUserId, fromWorkspaceId, now);
    if (changes.workspaceId !== undefined) bumpScopeVersion(ownerUserId, changes.workspaceId, now);
    indexMemory(record);
    return { record, restored: releaseMergedOnChange(ownerUserId, current, record, now) };
  });
  if (!updated) return requireMemory(ownerUserId, id);
  emitChanged(updated.record, 'updated');
  for (const record of updated.restored) emitChanged(record, 'updated');
  return updated.record;
}

/** Whether two versions of a memory say the same, as consolidation compared them: scope, kind, text, keywords, event time. */
function sameContent(a: MemoryRecord, b: MemoryRecord): boolean {
  return scopeWorkspaceId(a.scope) === scopeWorkspaceId(b.scope) && a.kind === b.kind && a.body === b.body
    && sameKeywords(a.keywords ?? [], b.keywords ?? []) && (a.eventAt ?? null) === (b.eventAt ?? null);
}

/**
 * A memory consolidation merged others into was changed in place (an edit in
 * Settings, an import following its file, a move to another scope): what was
 * merged directly into it comes back (when trusted and its source still
 * learns), version up by one, so the next consolidation run looks at it again
 * against what the note says now; without that, a detail only the merged note
 * held would be lost for good. Consolidation decides again; nothing here reads
 * the text. A correction is a new version instead: what was merged into the
 * old one resolves to it (currentCorrection), as an older value would. Call
 * inside the change's transaction; the caller announces them.
 */
function releaseMergedOnChange(ownerUserId: string, before: MemoryRecord, after: MemoryRecord, now: number): MemoryRecord[] {
  if (sameContent(before, after)) return [];
  const restored: MemoryRecord[] = [];
  for (const merged of mergedDirectlyInto(ownerUserId, [before.id])) {
    if (merged.status !== 'superseded' || merged.sourceRisk !== null || !hasLearningSource(merged)) continue;
    const back = restoreMergedMemory(ownerUserId, merged, now);
    if (back) restored.push(back);
  }
  return restored;
}

/**
 * pending → active; the record it corrects, if still there, becomes
 * superseded. Used by older clients and once at startup for the pending
 * records older versions left (activateLegacyPending.ts).
 */
export function approveMemory(caller: MemoryCaller, id: string): MemoryRecord {
  const ownerUserId = owner(caller);
  const { approved, superseded } = memoryTransaction(() => {
    const current = requireMemory(ownerUserId, id);
    if (current.status !== 'pending') throw new MemoryError('invalid_state', 'Only a pending memory can be approved');
    const now = Date.now();
    const record = updateMemoryRow(ownerUserId, current.id, current.version, { status: 'active' }, now);
    if (!record) throw new MemoryError('version_conflict', 'The memory changed since it was read');
    bumpScopeVersion(ownerUserId, scopeWorkspaceId(record.scope), now);
    indexMemory(record);
    const old = record.supersedesId ? findMemory(ownerUserId, record.supersedesId) : null;
    return { approved: record, superseded: old ? markSuperseded(ownerUserId, old, now) : null };
  });
  emitChanged(approved, 'approved');
  if (superseded) emitChanged(superseded, 'superseded');
  return approved;
}

/** What forgetMemory removed. */
export interface ForgetResult {
  /** Every version of the memory the user asked to forget, the one named first, and what consolidation merged into them. */
  removed: MemoryRecord[];
}

/** A row and its recall document go; false when the row is already gone. */
function deleteRow(ownerUserId: string, record: MemoryRecord): boolean {
  if (!deleteMemoryRow(ownerUserId, record.id)) return false;
  removeRecallDoc(ownerUserId, record.id);
  return true;
}

/**
 * Consolidation (consolidation.ts) puts one of Michi's own notes away into
 * another (`intoId`: the note it repeats, or the newer note that replaced
 * it): a compare-and-set at the version the run listed to superseded with
 * the merge link, its scope's version bumped and its recall document
 * inactive (memory_search still finds it as history). No removal hooks and
 * no tombstone run; nothing is announced, the caller does once its
 * transaction committed (announceMemoryChanges). Null when the memory changed
 * since. Not for routes or tools. Call inside the caller's transaction.
 */
export function mergeMemoryInto(ownerUserId: string, memory: { id: string; version: number }, intoId: string, now: number): MemoryRecord | null {
  const updated = updateMemoryRow(ownerUserId, memory.id, memory.version, { status: 'superseded', mergedIntoId: intoId }, now);
  if (!updated) return null;
  bumpScopeVersion(ownerUserId, scopeWorkspaceId(updated.scope), now);
  indexMemory(updated);
  return updated;
}

/**
 * Brings back a memory consolidation merged into another (a removal without
 * forget, or a revert): active again, the link cleared, its version up by
 * one (so the next consolidation run looks at it again), its scope's version
 * bumped and its recall document active. A compare-and-set at `version`; null
 * when it changed since. Nothing is announced: the caller emits 'updated'
 * once its transaction committed. Never resurrects a deleted row. Not for
 * routes or tools.
 */
export function restoreMergedMemory(ownerUserId: string, memory: { id: string; version: number }, now: number): MemoryRecord | null {
  const restored = updateMemoryRow(ownerUserId, memory.id, memory.version, { status: 'active', mergedIntoId: null }, now);
  if (!restored) return null;
  bumpScopeVersion(ownerUserId, scopeWorkspaceId(restored.scope), now);
  indexMemory(restored);
  return restored;
}

/**
 * A removal without forget (a conversation left learn, an imported item left
 * its file): what consolidation merged directly into a removed memory comes
 * back when it is trusted and its source still learns; otherwise it is
 * removed with its versions, and the same rule applies to what was merged
 * into it. `removed` gains what goes, `restored` what comes back.
 */
function releaseMergedInto(ownerUserId: string, ids: readonly string[], now: number, removed: MemoryRecord[], restored: MemoryRecord[]): void {
  const seen = new Set(removed.map((record) => record.id));
  let frontier = [...ids];
  for (let depth = 0; frontier.length > 0 && depth < 100; depth += 1) {
    const next: string[] = [];
    for (const record of mergedDirectlyInto(ownerUserId, frontier)) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      if (record.sourceRisk === null && hasLearningSource(record)) {
        const back = restoreMergedMemory(ownerUserId, record, now);
        if (back) restored.push(back);
        continue;
      }
      for (const version of memoryVersionChain(ownerUserId, record.id)) {
        if (version.id !== record.id && seen.has(version.id)) continue;
        seen.add(version.id);
        if (!deleteRow(ownerUserId, version)) continue;
        removed.push(version);
        next.push(version.id);
      }
    }
    frontier = next;
  }
}

/**
 * Remove a memory: a rejection the pending record alone; a deletion every
 * version (memoryVersionChain), since a correction's history says the same
 * thing. With `forget` (the user asked to forget it, by any path), what
 * consolidation merged into those versions goes too (mergedPredecessors: a
 * duplicate says the same, an outdated note is an older value). Without it,
 * what was merged into them comes back or goes by releaseMergedInto's rule.
 * The removal hooks run for every record removed, unless `hooks` is false:
 * a tombstone each, so automatic extraction never saves it again from where
 * it came from (extractionService.ts), and the profile lines citing it go
 * (userProfile.ts). Past conversations are not touched. Returns the removed
 * records, the one named first.
 */
function removeMemory(ownerUserId: string, id: string, reason: MemoryRemoval['reason'], forget = false, hooks = true): ForgetResult {
  const { restored, ...result } = memoryTransaction((): ForgetResult & { restored: MemoryRecord[] } => {
    const current = requireMemory(ownerUserId, id);
    if (reason === 'rejected' && current.status !== 'pending') {
      throw new MemoryError('invalid_state', 'Only a pending memory can be rejected');
    }
    const versions = reason === 'deleted' ? memoryVersionChain(ownerUserId, current.id) : [current];
    const removed = [...versions, ...(forget ? mergedPredecessors(ownerUserId, versions.map((record) => record.id)) : [])];
    for (const record of removed) {
      if (!deleteRow(ownerUserId, record)) throw new MemoryError('not_found', 'Memory not found');
    }
    const now = Date.now();
    const back: MemoryRecord[] = [];
    if (!forget) releaseMergedInto(ownerUserId, versions.map((record) => record.id), now, removed, back);
    for (const workspaceId of new Set(removed.map((record) => scopeWorkspaceId(record.scope)))) bumpScopeVersion(ownerUserId, workspaceId, now);
    if (hooks) for (const record of removed) for (const hook of [...removalHooks]) hook({ record, reason });
    return { removed, restored: back };
  });
  for (const record of result.removed) emitChanged(record, reason);
  for (const record of restored) emitChanged(record, 'updated');
  return result;
}

/** Discard a pending memory (a hard delete of that record only); kept for older clients and legacy activation. */
export function rejectMemory(caller: MemoryCaller, id: string): void {
  removeMemory(owner(caller), id, 'rejected');
}

/**
 * Hard delete of the memory with every version of it (the records a
 * correction links, either way) and their search index entries;
 * onMemoryRemoved hooks run for each in the same transaction.
 */
export function deleteMemory(caller: MemoryCaller, id: string): void {
  removeMemory(owner(caller), id, 'deleted');
}

/**
 * A copy the native memory import made of an item it now keeps once
 * (nativeMemoryImport.ts): deleted as deleteMemory deletes, but no removal
 * hook runs, since the user did not remove it; no tombstone bars its text. A
 * pack already leaves out a profile line citing a memory that is gone. Not
 * for routes or tools.
 */
export function removeImportCopy(caller: MemoryCaller, id: string): void {
  removeMemory(owner(caller), id, 'deleted', false, false);
}

/**
 * The user asked to forget a memory (memory_delete, a delete in Settings →
 * Memory or under a reply, a profile line's Remove): every version of it and
 * what consolidation merged into them, each with a tombstone so automatic
 * extraction never saves it again from where it came from (removeMemory).
 * As ChatGPT's and Claude's forget, it deletes the memory; the conversations
 * it came from are unchanged.
 */
export function forgetMemory(caller: MemoryCaller, id: string): ForgetResult {
  return removeMemory(owner(caller), id, 'deleted', true);
}

// ── conversations and reset ────────────────────────────────────────────────

/** A conversation of the owner's: its workspace, or not_found (missing, in Trash, not a chat, or someone else's). */
function ownedConversation(ownerUserId: string, nodeId: unknown): { nodeId: string; workspaceId: string } {
  const id = typeof nodeId === 'string' ? nodeId.trim() : '';
  const workspaceId = id ? conversationWorkspaceId(id) : null;
  if (!workspaceId || !workspaceAccessible(ownerUserId, workspaceId)) throw new MemoryError('not_found', 'Conversation not found');
  return { nodeId: id, workspaceId };
}

/** A conversation's memory setting (GET /api/nodes/:nodeId/memory-mode): learn unless the user chose otherwise. */
export function getConversationMemoryMode(caller: MemoryCaller, nodeId: string): ConversationMemoryMode {
  const conversation = ownedConversation(owner(caller), nodeId);
  return readConversationMemoryMode(conversation.nodeId);
}

export interface ConversationModeChange {
  mode: ConversationMemoryMode;
  /** Turns of the conversation recall no longer shows. */
  hiddenTurns: number;
  /** Memories Michi had saved on its own from it, now removed (the user's own stay). */
  removedMemories: number;
}

/**
 * Set a conversation's memory setting (PUT /api/nodes/:nodeId/memory-mode).
 * Leaving learn hides its turns from recall (recallIndex.hideConversationTurns)
 * and removes the memories Michi saved on its own from it, each with its
 * versions and a tombstone (deleteMemory); the user's own saved ones stay,
 * with their history, and so do earlier versions from it that a later
 * conversation's correction replaced (that memory's history). Coming back to
 * learn starts after what was said meanwhile: extraction never reads it.
 * Works with memory off.
 */
export function setConversationMemoryMode(caller: MemoryCaller, nodeId: string, mode: unknown): ConversationModeChange {
  const ownerUserId = owner(caller);
  if (!isConversationMemoryMode(mode)) throw new MemoryError('invalid_argument', 'mode must be learn, use_only or off');
  return memoryTransaction((): ConversationModeChange => {
    const conversation = ownedConversation(ownerUserId, nodeId);
    const previous = readConversationMemoryMode(conversation.nodeId);
    if (previous === mode) return { mode, hiddenTurns: 0, removedMemories: 0 };
    writeConversationMemoryMode(conversation.nodeId, mode);
    if (mode === 'learn') {
      skipConversationExtraction({ ...conversation, ownerUserId, now: Date.now() });
      return { mode, hiddenTurns: 0, removedMemories: 0 };
    }
    let removedMemories = 0;
    for (const id of extractedMemoryIdsFromNode(ownerUserId, conversation.nodeId)) {
      const record = findMemory(ownerUserId, id);
      if (!record) continue; // removed with an earlier one's versions
      // One consolidation put away is history the user does not see listed: it goes, uncounted.
      const shown = record.status !== 'superseded';
      if (removeMemory(ownerUserId, id, 'deleted').removed.length > 0 && shown) removedMemories += 1;
    }
    return { mode, hiddenTurns: hideConversationTurns(ownerUserId, conversation.nodeId), removedMemories };
  });
}

/**
 * Delete all of the owner's memories (POST /api/memories/reset): every
 * memory and version, the profile of the user, the memories' recall
 * documents and the text of every past turn recall indexed (the turns stay
 * hidden, never indexed again); extraction starts after everything said so
 * far, in every workspace. The memory setting, tombstones and import records
 * stay: what was removed comes back only when the user says it again.
 * Returns how many memories were removed.
 */
export function resetMemories(caller: MemoryCaller): { removed: number; hiddenTurns: number } {
  const ownerUserId = owner(caller);
  const { removed, hiddenTurns } = memoryTransaction(() => {
    const now = Date.now();
    const records = deleteOwnerMemoryRows(ownerUserId);
    const hidden = resetOwnerRecall(ownerUserId);
    for (const workspaceId of new Set([null, ...records.map((record) => scopeWorkspaceId(record.scope))])) bumpScopeVersion(ownerUserId, workspaceId, now);
    restartExtractionAt(ownerUserId, workspaceCompletionCounter, now);
    return { removed: records, hiddenTurns: hidden };
  });
  for (const record of removed) emitChanged(record, 'deleted');
  return { removed: removed.length, hiddenTurns };
}

// ── reads ──────────────────────────────────────────────────────────────────

/** One of the caller's memories, whatever its status; not_found for a missing or another owner's id. Works with mode off. */
export function getMemory(caller: MemoryCaller, id: string): MemoryRecord {
  return requireMemory(owner(caller), id);
}

export interface MemoryListQuery {
  /** user: the user scope only. workspace: workspaceId's, or every workspace's. Absent: both. */
  scope?: 'user' | 'workspace';
  workspaceId?: string | null;
  /** Default ['active', 'pending']. */
  status?: MemoryStatus[];
  cursor?: string | null;
  /** Default 50, at most 200. */
  limit?: number;
  /** Keep records containing every whitespace-separated term. */
  query?: string;
}

const LIST_DEFAULT_STATUSES: readonly MemoryStatus[] = ['active', 'pending'];
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

function encodeCursor(rowId: number): string {
  return Buffer.from(`m:${rowId}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  const match = typeof cursor === 'string' ? /^m:([1-9]\d{0,15})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8')) : null;
  if (!match) throw new MemoryError('invalid_argument', 'cursor is invalid');
  return Number(match[1]);
}

/**
 * Newest first, for managing memories (works with mode off). With no scope
 * and no workspaceId: everything the caller owns.
 */
export function listMemories(caller: MemoryCaller, q: MemoryListQuery = {}): { items: MemoryRecord[]; nextCursor: string | null } {
  const ownerUserId = owner(caller);
  if (q.scope !== undefined && q.scope !== 'user' && q.scope !== 'workspace') {
    throw new MemoryError('invalid_argument', 'scope must be user or workspace');
  }
  const workspaceId = optionalWorkspaceId(q.workspaceId);
  if (q.scope === 'user' && workspaceId !== null) {
    throw new MemoryError('invalid_argument', 'workspaceId cannot be combined with scope user');
  }
  if (q.query !== undefined && typeof q.query !== 'string') throw new MemoryError('invalid_argument', 'query must be a string');
  const statuses = normalizeStatuses(q.status, LIST_DEFAULT_STATUSES);
  const limit = normalizeLimit(q.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const beforeRowId = decodeCursor(q.cursor);
  const workspaces = workspaceId === null ? 'all' as const : [accessibleWorkspace(ownerUserId, workspaceId)];
  const scope: MemoryScopeFilter = {
    user: q.scope !== 'workspace',
    workspaceIds: q.scope === 'user' ? [] : workspaces,
  };
  const terms = q.query ? splitTerms(q.query) : null;
  const page = listMemoryRows(ownerUserId, {
    scope, statuses, terms: terms && terms.all.length > 0 ? terms : null, beforeRowId, limit,
  });
  return { items: page.records, nextCursor: page.more && page.lastRowId !== null ? encodeCursor(page.lastRowId) : null };
}

/**
 * Grows whenever anything in the caller's user scope (including the memory
 * mode) or in this workspace's scope changes; compare for equality only.
 */
export function memoryVersion(caller: MemoryCaller, workspaceId: string | null): number {
  const ownerUserId = owner(caller);
  const ws = optionalWorkspaceId(workspaceId);
  return readScopeVersion(ownerUserId, null) + (ws === null ? 0 : readScopeVersion(ownerUserId, ws));
}
