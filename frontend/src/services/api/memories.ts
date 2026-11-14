import {
  isMemoryKind,
  isMemoryMode,
  isMemoryOrigin,
  isMemoryStatus,
  SSE_HEARTBEAT_MS,
  sseSilenceTimeoutMs,
  type MemoryChangedEvent,
  type MemoryCreateRequest,
  type MemoryExtractionState,
  type MemoryListResponse,
  type MemoryMode,
  type MemoryProfileCitation,
  type MemoryProfileResponse,
  type MemoryRecord,
  type MemorySettings,
  type MemoryStatus,
  type MemoryUpdateRequest,
  type ReplyMemorySource,
  type ReplyMemorySourcesResponse,
} from 'michi-shared';
import { API_BASE_URL } from '../../config/env';
import { backendFetch } from './backendRequest';
import { openSseFeed } from './sseFeed';

// Michi Memory on this machine's backend (backend/src/routes/memories.ts):
// the records, the mode, the profile of the user, the change feed, and
// automatic memory's status (routes/memoryExtraction.ts). A conversation's
// memory setting is read from the backend that holds the conversation. A
// backend without a route answers 404; callers show that as unavailable
// rather than as a failure.

export class MemoryApiError extends Error {
  readonly status: number;
  /** version_conflict, invalid_state, memory_disabled, not_found, … when the backend named one. */
  readonly code: string | null;
  /** The stored version, with version_conflict. */
  readonly currentVersion: number | null;
  /** This backend has no such route: a 404 without a memory error code, or an answer of the wrong shape. */
  readonly unavailable: boolean;
  constructor(status: number, message: string, options: { code?: string | null; currentVersion?: number | null; unavailable?: boolean } = {}) {
    super(message);
    this.name = 'MemoryApiError';
    this.status = status;
    this.code = options.code ?? null;
    this.currentVersion = options.currentVersion ?? null;
    this.unavailable = options.unavailable ?? (status === 404 && !options.code);
  }
}

export function isMemoryVersionConflict(error: unknown): error is MemoryApiError {
  return error instanceof MemoryApiError && error.status === 409 && error.code === 'version_conflict';
}

export function isMemoryUnavailable(error: unknown): boolean {
  return error instanceof MemoryApiError && error.unavailable;
}

/** The memory is gone (deleted elsewhere, or never this owner's). */
export function isMemoryNotFound(error: unknown): boolean {
  return error instanceof MemoryApiError && error.status === 404 && error.code === 'not_found';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const optionalString = (value: unknown) => value === undefined || typeof value === 'string';

export function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!isObject(value)) return false;
  const scope = value.scope;
  const scopeOk = isObject(scope) && (scope.kind === 'user' || (scope.kind === 'workspace' && typeof scope.workspaceId === 'string'));
  const source = value.source;
  const sourceOk = source === null || (isObject(source)
    && optionalString(source.nodeId) && optionalString(source.messageId) && optionalString(source.turnId) && optionalString(source.artifactId));
  return typeof value.id === 'string' && typeof value.body === 'string' && scopeOk && sourceOk
    && isMemoryKind(value.kind) && isMemoryStatus(value.status) && isMemoryOrigin(value.origin)
    && typeof value.version === 'number' && (value.sourceRisk === null || value.sourceRisk === 'untrusted')
    && (value.supersedesId === null || typeof value.supersedesId === 'string')
    && typeof value.createdAt === 'number' && typeof value.updatedAt === 'number';
}

function isMemoryChangedEvent(value: unknown): value is MemoryChangedEvent {
  return isObject(value) && typeof value.memoryId === 'string' && typeof value.action === 'string'
    && isMemoryStatus(value.status) && typeof value.body === 'string' && isMemoryOrigin(value.origin)
    && (value.workspaceId === null || typeof value.workspaceId === 'string')
    && optionalString(value.nodeId) && (value.supersedesId === undefined || value.supersedesId === null || typeof value.supersedesId === 'string');
}

/** `apiBase`: another backend's API (a conversation's), reached through backendFetch; absent: this machine's. */
async function request(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}, apiBase?: string): Promise<unknown> {
  const options: RequestInit = {
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
  };
  const response = apiBase === undefined ? await fetch(`${API_BASE_URL}${path}`, options) : await backendFetch(`${apiBase}${path}`, options);
  if (response.status === 204) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = isObject(body) && typeof body.code === 'string' ? body.code : null;
    const message = isObject(body) && typeof body.error === 'string' ? body.error : `Memory request failed (${response.status})`;
    const currentVersion = isObject(body) && typeof body.currentVersion === 'number' ? body.currentVersion : null;
    throw new MemoryApiError(response.status, message, { code, currentVersion });
  }
  return body;
}

function unexpected(status = 200): MemoryApiError {
  return new MemoryApiError(status, 'Unexpected memory response', { unavailable: true });
}

function recordOf(body: unknown): MemoryRecord {
  const memory = isObject(body) ? body.memory : undefined;
  if (!isMemoryRecord(memory)) throw unexpected();
  return memory;
}

export interface MemoryListQuery {
  /** user: the global (user) scope only; workspace: workspace scopes; absent: both. */
  scope?: 'user' | 'workspace';
  workspaceId?: string;
  /** Default on the backend: active and pending. */
  status?: readonly MemoryStatus[];
  q?: string;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}

/** Newest first. */
export async function listMemories(query: MemoryListQuery = {}): Promise<MemoryListResponse> {
  const params = new URLSearchParams();
  if (query.scope) params.set('scope', query.scope);
  if (query.workspaceId) params.set('workspaceId', query.workspaceId);
  if (query.status?.length) params.set('status', query.status.join(','));
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const search = params.toString();
  const body = await request(`/memories${search ? `?${search}` : ''}`, { signal: query.signal });
  if (!isObject(body) || !Array.isArray(body.items) || !(body.nextCursor === null || typeof body.nextCursor === 'string')) throw unexpected();
  return { items: body.items.filter(isMemoryRecord), nextCursor: body.nextCursor };
}

/** Added by hand: explicit and active. */
export async function createMemory(input: MemoryCreateRequest): Promise<MemoryRecord> {
  return recordOf(await request('/memories', { method: 'POST', body: input }));
}

/** Rejects with a version_conflict MemoryApiError when the memory changed since `expectedVersion`. */
export async function updateMemory(id: string, patch: MemoryUpdateRequest): Promise<MemoryRecord> {
  return recordOf(await request(`/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }));
}

/** `apiBase`: the backend that holds the memory (a conversation's, for what a reply was based on); absent: this machine's. */
export async function deleteMemory(id: string, apiBase?: string): Promise<void> {
  await request(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }, apiBase);
}

/** The mode, and the one-time notice's state where the backend has it. */
function settingsOf(body: unknown): MemorySettings {
  if (!isObject(body) || !isMemoryMode(body.mode)) throw unexpected();
  return {
    mode: body.mode,
    ...(typeof body.migratedFromExplicit === 'boolean' ? { migratedFromExplicit: body.migratedFromExplicit } : {}),
    ...(typeof body.noticeSeen === 'boolean' ? { noticeSeen: body.noticeSeen } : {}),
  };
}

/** `apiBase`: another backend's settings (a conversation's), else this machine's. */
export async function fetchMemorySettings(signal?: AbortSignal, apiBase?: string): Promise<MemorySettings> {
  return settingsOf(await request('/memory-settings', { signal }, apiBase));
}

export async function saveMemorySettings(mode: MemoryMode): Promise<MemorySettings> {
  return settingsOf(await request('/memory-settings', { method: 'PUT', body: { mode } }));
}

/** The one-time notice about memory was shown; the backend does not show it again. */
export async function markMemoryNoticeSeen(): Promise<MemorySettings> {
  return settingsOf(await request('/memory-settings', { method: 'PUT', body: { noticeSeen: true } }));
}

/** POST /api/memories/reset: every memory of the owner and their profile go; answers how many memories. Callers confirm with the user first. */
export async function resetMemories(): Promise<{ removed: number }> {
  const body = await request('/memories/reset', { method: 'POST', body: { confirm: true } });
  if (!isObject(body) || typeof body.removed !== 'number') throw unexpected();
  return { removed: body.removed };
}

// ── the profile of the user ("About the user") ─────────────────────────────

/** A line of the profile; `index` is its place in the backend's list, which Remove names. */
export interface MemoryProfileLine {
  index: number;
  topic: string;
  text: string;
  refs: MemoryProfileCitation[];
}

export interface MemoryProfileView extends Omit<MemoryProfileResponse, 'lines'> {
  lines: MemoryProfileLine[];
}

const isCitation = (value: unknown): value is MemoryProfileCitation =>
  isObject(value) && typeof value.ref === 'string' && typeof value.id === 'string' && typeof value.body === 'string';

function profileOf(body: unknown): MemoryProfileView {
  if (!isObject(body) || !Array.isArray(body.lines) || typeof body.version !== 'number'
    || !(body.builtAt === null || typeof body.builtAt === 'number')) throw unexpected();
  // A line of another shape is skipped; the others keep their index.
  const lines = body.lines.flatMap((line, index): MemoryProfileLine[] => {
    if (!isObject(line) || typeof line.text !== 'string' || !Array.isArray(line.refs)) return [];
    return [{ index, topic: typeof line.topic === 'string' ? line.topic : '', text: line.text, refs: line.refs.filter(isCitation) }];
  });
  return { lines, builtAt: body.builtAt, version: body.version, rebuildRequested: body.rebuildRequested === true };
}

/** Null when this backend has no profile yet (404, or an answer of another shape). */
export async function fetchMemoryProfile(signal?: AbortSignal): Promise<MemoryProfileView | null> {
  try {
    return profileOf(await request('/memory-profile', { signal }));
  } catch (error) {
    if (isMemoryUnavailable(error)) return null;
    throw error;
  }
}

/** Asks for a rebuild; automatic memory runs it soon (the answer's rebuildRequested stays true until then). */
export async function rebuildMemoryProfile(): Promise<MemoryProfileView> {
  return profileOf(await request('/memory-profile/rebuild', { method: 'POST', body: {} }));
}

/**
 * Deletes the memories a line cites (the line goes with them) and asks for a
 * rebuild. `version` is the profile's as read: a version_conflict
 * MemoryApiError when it was rebuilt since, not_found when there is no such line.
 */
export async function removeMemoryProfileLine(index: number, version: number): Promise<MemoryProfileView> {
  return profileOf(await request('/memory-profile/remove-line', { method: 'POST', body: { index, version } }));
}

// ── what a reply was based on ──────────────────────────────────────────────

const IMPORT_SOURCES = ['claude', 'codex', 'kiro'];

function isFrom(value: unknown, titleRequired: boolean): boolean {
  return isObject(value) && typeof value.nodeId === 'string' && (value.messageId === null || typeof value.messageId === 'string')
    && (typeof value.title === 'string' || (!titleRequired && value.title === null));
}

function isReplyMemorySource(value: unknown): value is ReplyMemorySource {
  if (!isObject(value) || typeof value.text !== 'string' || typeof value.at !== 'number') return false;
  if (value.kind === 'memory') {
    return typeof value.memoryId === 'string' && (value.savedBy === 'user' || value.savedBy === 'michi' || value.savedBy === 'import')
      && (value.importSource === undefined || IMPORT_SOURCES.includes(value.importSource as string))
      && (value.from === null || isFrom(value.from, true));
  }
  return value.kind === 'conversation' && typeof value.docId === 'number' && isFrom(value.from, false);
}

/**
 * GET /api/nodes/:nodeId/memory-sources on the conversation's backend
 * (`apiBase`): for each of these assistant messages, the memories and past
 * conversations its reply was based on. A message with none is left out. A
 * backend without the route rejects with an unavailable MemoryApiError.
 */
export async function fetchReplyMemorySources(apiBase: string, nodeId: string, messageIds: readonly string[], signal?: AbortSignal): Promise<ReplyMemorySourcesResponse> {
  const query = messageIds.map((id) => encodeURIComponent(id)).join(',');
  const body = await request(`/nodes/${encodeURIComponent(nodeId)}/memory-sources?messages=${query}`, { signal }, apiBase);
  if (!isObject(body) || !Array.isArray(body.messages)) throw unexpected();
  return {
    messages: body.messages.flatMap((message) => (isObject(message) && typeof message.messageId === 'string' && Array.isArray(message.sources)
      ? [{ messageId: message.messageId, sources: message.sources.filter(isReplyMemorySource) }] : [])),
  };
}

/** Don't recall: the conversation's backend stops recalling that past turn; the conversation itself is unchanged. */
export async function hideRecalledTurn(apiBase: string, docId: number): Promise<void> {
  await request('/memory-recall/hide', { method: 'POST', body: { docId } }, apiBase);
}

// ── automatic memory (C5) ──────────────────────────────────────────────────

/** The C5 status fields Settings › Memory shows; `state` is absent from backends older than the full status. */
export interface MemoryExtractionStatus {
  enabled: boolean;
  paused: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  todayTokens: number;
  dailyTokenLimit: number | null;
  state?: MemoryExtractionState;
  stateReason?: string | null;
  supported?: boolean;
}

const EXTRACTION_STATES: readonly MemoryExtractionState[] = [
  'off', 'unsupported', 'paused', 'stopped', 'budget_exhausted', 'running', 'waiting', 'idle',
];

const nullableNumber = (value: unknown) => value === null || value === undefined || (typeof value === 'number' && Number.isFinite(value));

function extractionStatusOf(body: unknown): MemoryExtractionStatus | null {
  if (!isObject(body) || typeof body.enabled !== 'boolean' || typeof body.paused !== 'boolean'
    || !nullableNumber(body.lastRunAt) || !(body.lastError === null || body.lastError === undefined || typeof body.lastError === 'string')
    || !nullableNumber(body.todayTokens) || !nullableNumber(body.dailyTokenLimit)) return null;
  return {
    enabled: body.enabled,
    paused: body.paused,
    lastRunAt: (body.lastRunAt as number | null | undefined) ?? null,
    lastError: (body.lastError as string | null | undefined) || null,
    todayTokens: (body.todayTokens as number | null | undefined) ?? 0,
    dailyTokenLimit: (body.dailyTokenLimit as number | null | undefined) ?? null,
    ...(EXTRACTION_STATES.includes(body.state as MemoryExtractionState) ? { state: body.state as MemoryExtractionState } : {}),
    ...(typeof body.stateReason === 'string' && body.stateReason ? { stateReason: body.stateReason } : {}),
    ...(typeof body.supported === 'boolean' ? { supported: body.supported } : {}),
  };
}

/** Null when this backend has no automatic memory yet (404, or an answer of another shape). */
export async function fetchMemoryExtractionStatus(signal?: AbortSignal): Promise<MemoryExtractionStatus | null> {
  try {
    return extractionStatusOf(await request('/memory-extraction/status', { signal }));
  } catch (error) {
    if (error instanceof MemoryApiError && error.status === 404) return null;
    throw error;
  }
}

/** Pauses or resumes automatic memory; answers the status afterwards (null when unavailable). */
export async function setMemoryExtractionPaused(paused: boolean): Promise<MemoryExtractionStatus | null> {
  const body = await request(`/memory-extraction/${paused ? 'pause' : 'resume'}`, { method: 'POST', body: {} });
  return extractionStatusOf(body) ?? fetchMemoryExtractionStatus();
}

// ── change feed (C4) ───────────────────────────────────────────────────────

export interface MemoryChangeSubscription {
  onEvent: (event: MemoryChangedEvent) => void;
  onOpen?: () => void;
  /** The feed ended or failed; an SseHttpError carries the HTTP status. Not called after unsubscribe. */
  onDisconnect?: (error?: Error) => void;
}

/**
 * GET /api/memories/changes/stream through the shared stream transport:
 * every later change to the caller's memories, whoever made it. Returns
 * unsubscribe.
 */
export function subscribeMemoryChanges(options: MemoryChangeSubscription): () => void {
  return openSseFeed(`${API_BASE_URL}/memories/changes/stream`, {
    label: 'subscribeMemoryChanges',
    silenceMs: sseSilenceTimeoutMs(SSE_HEARTBEAT_MS.memoryChanges),
    onOpen: options.onOpen,
    onDisconnect: options.onDisconnect,
    onFrame: (event, data) => {
      if (event !== 'memory_changed') return;
      let json: unknown;
      try { json = JSON.parse(data); } catch { return; }
      if (isMemoryChangedEvent(json)) options.onEvent({ ...json, supersedesId: json.supersedesId ?? null });
    },
  });
}
