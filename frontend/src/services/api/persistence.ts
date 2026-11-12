import { serverEntityId } from '../../config/backendIdentity';
import { backendFetch } from './backendRequest';
import { isWorkspaceStructureCursor, parseLeanNodeFields, redactRemoteLog, type WorkspaceStructureCursor } from 'michi-shared';
import {
  activeBackendApiBase,
  backendApiBase,
  isLocalConnectionId,
  LOCAL_BACKEND_CONNECTION_ID,
  nodeBackendApiBase,
  workspaceBackendApiBase,
} from '../../config/backendConnections';
import { configureStreamTransport } from './streamTransport';
import { STREAM_TRANSPORT_PROTOCOL } from 'michi-shared';
import { RemoteServiceRecoveryError } from './remoteRecovery';

// ── Persistence API ──

export interface ProfileActivityDay {
  dateKey: string;
  nodes: number;
  branches: number;
  messages: number;
}

export interface ProfileActivitySnapshot {
  totalNodes: number;
  totalThreads: number;
  totalBranches: number;
  totalMessages: number;
  days: ProfileActivityDay[];
}

function isActivityCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isProfileActivityDay(value: unknown): value is ProfileActivityDay {
  if (!value || typeof value !== 'object') return false;
  const day = value as Record<string, unknown>;
  return typeof day.dateKey === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(day.dateKey)
    && isActivityCount(day.nodes)
    && isActivityCount(day.branches)
    && isActivityCount(day.messages);
}

function isProfileActivitySnapshot(value: unknown): value is ProfileActivitySnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Record<string, unknown>;
  return isActivityCount(snapshot.totalNodes)
    && isActivityCount(snapshot.totalThreads)
    && isActivityCount(snapshot.totalBranches)
    && isActivityCount(snapshot.totalMessages)
    && Array.isArray(snapshot.days)
    && snapshot.days.every(isProfileActivityDay);
}

export interface FetchProfileActivityOptions {
  connectionId?: string;
  signal?: AbortSignal;
}

export async function fetchProfileActivity(
  timeZone: string,
  options: FetchProfileActivityOptions = {},
): Promise<ProfileActivitySnapshot> {
  const query = new URLSearchParams({ timeZone });
  const base = options.connectionId === undefined
    ? activeBackendApiBase()
    : backendApiBase(options.connectionId);
  const res = await backendFetch(`${base}/profile/activity?${query}`, { signal: options.signal });
  if (!res.ok) throw new Error(`fetchProfileActivity failed: ${res.status}`);
  const body: unknown = await res.json();
  if (!isProfileActivitySnapshot(body)) {
    throw new Error('fetchProfileActivity returned a malformed snapshot');
  }
  return body;
}

export async function fetchWorkspaces(connectionId?: string): Promise<unknown[]> {
  const res = await backendFetch(`${backendApiBase(connectionId)}/workspaces`);
  if (!res.ok) throw new Error(`fetchWorkspaces failed: ${res.status}`);
  const body = await res.json();
  return body.workspaces ?? body;
}

// The structure-feed cursor each hydration read was taken at, per connection:
// the background feed's opening cursor tells whether that read missed a change.
const hydrationStructureCursors = new Map<string, WorkspaceStructureCursor>();

/** The cursor the last hydration read of `connectionId` was taken at; read once. */
export function takeHydrationStructureCursor(connectionId: string): WorkspaceStructureCursor | undefined {
  const cursor = hydrationStructureCursors.get(connectionId);
  hydrationStructureCursors.delete(connectionId);
  return cursor;
}

/**
 * One workspace's structure (no message bodies), for a re-read after a
 * workspace_structure_changed frame. Null when the backend no longer has it;
 * throws when the backend cannot answer (unreachable is not deleted).
 */
export async function fetchWorkspaceStructure(id: string, signal?: AbortSignal): Promise<unknown | null> {
  const res = await backendFetch(`${workspaceBackendApiBase(id)}/workspaces/${encodeURIComponent(id)}?meta=1`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchWorkspaceStructure failed: ${res.status}`);
  return res.json();
}

/**
 * The workspaces of a `/workspaces/all` body, each stamped with the lean node
 * fields the response names (shared/leanNodeFields), so a workspace payload
 * held on its own still says which fields its rows deferred. A body without
 * the marker (an older backend, a local read) comes back as it is.
 */
export function workspacesFromMetaBody(body: unknown): unknown[] {
  const { workspaces, leanNodeFields } = (body ?? {}) as { workspaces?: unknown; leanNodeFields?: unknown };
  if (!Array.isArray(workspaces)) return [];
  const lean = parseLeanNodeFields(leanNodeFields);
  if (lean.length === 0) return workspaces;
  return workspaces.map((workspace) => (workspace && typeof workspace === 'object'
    ? { ...workspace, leanNodeFields: lean } : workspace));
}

/**
 * Lazy-load hydration payload: every workspace's structure + per-node
 * message_count, with NO message bodies. Bodies are fetched per-tree on demand
 * via {@link fetchTreeMessages}. Throws on unreachability so the hydration
 * barrier can retry. A remote connection asks for lean rows: the heavy node
 * fields come with each tree's page.
 */
export async function fetchAllWorkspacesMeta(connectionId?: string, signal?: AbortSignal): Promise<unknown[]> {
  const lean = !isLocalConnectionId(connectionId) ? '&lean=1' : '';
  const res = await backendFetch(`${backendApiBase(connectionId)}/workspaces/all?meta=1${lean}`, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = typeof body?.error === 'string' ? ': ' + redactRemoteLog(body.error).slice(0, 2000) : '';
    const message = `Could not load workspaces (HTTP ${res.status})${detail}`;
    const recovery = body?.recovery;
    if (recovery?.connectionId === connectionId && ['starting', 'error'].includes(recovery.phase) && typeof recovery.message === 'string') {
      throw new RemoteServiceRecoveryError(message, recovery);
    }
    throw new Error(message);
  }
  const body = await res.json();
  if (isWorkspaceStructureCursor(body?.structureCursor)) {
    hydrationStructureCursors.set(connectionId ?? LOCAL_BACKEND_CONNECTION_ID, body.structureCursor);
  }
  return workspacesFromMetaBody(body);
}

/** Lazy-load: all message-body rows for one tree. Backend orders by (node, seq). */
export async function fetchTreeMessages(workspaceId: string, treeId: string, connectionId?: string, signal?: AbortSignal): Promise<unknown[]> {
  return (await fetchTreeMessageSnapshot(workspaceId, treeId, connectionId, signal)).messages;
}

/** All message-body rows for one tree, with each node's latest turn read alongside. */
export async function fetchTreeMessageSnapshot(workspaceId: string, treeId: string, connectionId?: string,
  signal?: AbortSignal,
): Promise<TreeMessagePage> {
  const res = await backendFetch(
    `${connectionId ? backendApiBase(connectionId) : workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(serverEntityId(workspaceId, connectionId))}/trees/${encodeURIComponent(treeId)}/messages`,
    { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]) },
  );
  if (!res.ok) throw new Error(`fetchTreeMessages failed: ${res.status}`);
  const body = await res.json();
  return { messages: body.messages ?? [], ...(Array.isArray(body.turns) ? { turns: body.turns } : {}) };
}

export interface MessagePageCursor { seq: number; id: string }
/** One node's place in a page. */
export interface TreeMessagePageEntry {
  nodeId: string;
  total: number;
  before: MessagePageCursor | null;
  /**
   * On a node's latest page from a current gateway: its lean node fields as
   * stored (shared/leanNodeFields), which lean metadata may have left out.
   */
  node?: Record<string, unknown>;
}
export interface TreeMessagePage {
  messages: unknown[];
  // Missing on older gateways, which answer this endpoint with full history.
  pages?: TreeMessagePageEntry[];
  // Each node's latest turn row, read in the same transaction as `messages`.
  // Missing on older gateways.
  turns?: unknown[];
}

export async function fetchTreeMessagePage(workspaceId: string, treeId: string, connectionId?: string,
  signal?: AbortSignal, page?: { nodeId?: string; before?: MessagePageCursor; limit?: number },
): Promise<TreeMessagePage> {
  // One node's latest page when `before` is absent; the server caps limit at 200.
  // Without a node, every node's latest `limit` messages.
  const query = new URLSearchParams({ limit: String(Math.min(200, Math.max(1, page?.limit ?? 50))) });
  if (page?.nodeId) {
    query.set('nodeId', serverEntityId(page.nodeId, connectionId));
    if (page.before) {
      query.set('beforeSeq', String(page.before.seq));
      query.set('beforeId', page.before.id);
    }
  }
  const res = await backendFetch(
    `${connectionId ? backendApiBase(connectionId) : workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(serverEntityId(workspaceId, connectionId))}/trees/${encodeURIComponent(treeId)}/messages?${query}`,
    { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]) },
  );
  if (!res.ok) throw new Error(`fetchTreeMessagePage failed: ${res.status}`);
  const body = await res.json() as TreeMessagePage;
  if (!Array.isArray(body.messages) || (body.pages !== undefined && (!Array.isArray(body.pages)
    || body.pages.some(item => !item || typeof item.nodeId !== 'string' || !Number.isSafeInteger(item.total) || item.total < 0
      || (item.before !== null && (!item.before || !Number.isSafeInteger(item.before.seq) || item.before.seq < 0
        || typeof item.before.id !== 'string' || !item.before.id)))))
    || (body.turns !== undefined && !Array.isArray(body.turns))) {
    throw new Error('Invalid message page');
  }
  return body;
}

/**
 * Which workspace and thread hold a live node, asked of the backend that owns
 * it (a `remote:` id goes to its connection; the answer comes back in that
 * connection's scope). Null when there is none (deleted, in a deleted
 * workspace, unknown); throws when the backend can't be asked.
 */
export async function fetchNodeWorkspace(
  nodeId: string,
  signal?: AbortSignal,
): Promise<{ workspaceId: string; treeId: string | null } | null> {
  const res = await backendFetch(`${nodeBackendApiBase(nodeId)}/nodes/${encodeURIComponent(nodeId)}/workspace`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchNodeWorkspace failed: ${res.status}`);
  const body = await res.json() as { workspaceId?: unknown; treeId?: unknown };
  if (typeof body.workspaceId !== 'string' || !body.workspaceId) throw new Error('fetchNodeWorkspace: unexpected answer');
  return { workspaceId: body.workspaceId, treeId: typeof body.treeId === 'string' ? body.treeId : null };
}

export async function fetchWorkspace(id: string, signal?: AbortSignal): Promise<unknown> {
  const res = await backendFetch(`${workspaceBackendApiBase(id)}/workspaces/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`fetchWorkspace failed: ${res.status}`);
  return res.json();
}

export interface PersistenceCapabilities {
  protocolVersion: number;
  authoritativeTurnPersistence: boolean;
  durableNodePrerequisite: boolean;
  explicitCommands: boolean;
  backgroundWorkspaceSync: boolean;
  legacySyncAccepted: boolean;
  streamTransport?: string;
  /**
   * Pane Inspection API capability version (design doc §11). Optional
   * because an old gateway that predates this feature omits the field
   * entirely. Use {@link supportsPaneInspection} rather than truthiness —
   * absent/unknown/malformed values must all mean "unsupported", never be
   * treated as "supported with an empty pane list".
   */
  paneInspection?: unknown;
  /** Server attention ('v1'): see supportsServerAttention in services/serverAttention.ts. */
  attention?: unknown;
  /** Agent artifact tools ('v1'): see {@link supportsArtifactTools}. */
  artifactTools?: unknown;
  /** Skipped artifact writes answered, not a failed batch ('v1'): see {@link supportsArtifactWriteAnswers}. */
  artifactWriteAnswers?: unknown;
}

/**
 * The backend skips an artifact upsert of a deleted artifact or under a name
 * another one holds, names it in the batch's answer (goneContextIds,
 * nameTakenContextIds) and commits the rest. True ONLY for `'v1'`: an older
 * backend omits the field, and fails such a batch with a 500 that its sender
 * retries, holding up every later write of the workspace.
 */
export function supportsArtifactWriteAnswers(capabilities: Pick<PersistenceCapabilities, 'artifactWriteAnswers'> | null | undefined): boolean {
  return capabilities?.artifactWriteAnswers === 'v1';
}

/**
 * The backend's chat agents have list_artifacts / search_artifacts and its
 * ensure-session reads artifactCount, so a first message may name only the
 * pinned artifacts. True ONLY for `'v1'`: an older backend omits the field,
 * and it must get the full artifact list.
 */
export function supportsArtifactTools(capabilities: Pick<PersistenceCapabilities, 'artifactTools'> | null | undefined): boolean {
  return capabilities?.artifactTools === 'v1';
}

/**
 * Defensive predicate for the `paneInspection` capability. Returns true ONLY
 * for the exact string `'v1'`. Any other value — absent, `undefined`, a
 * future version string, a boolean, an object, `null` — means unsupported.
 * Callers must gate all Pane Inspection API usage (list/inspect/subscribe)
 * behind this check and show "unsupported", never silently render an empty
 * pane list for a gateway that never advertised the capability at all.
 */
export function supportsPaneInspection(capabilities: Pick<PersistenceCapabilities, 'paneInspection'> | null | undefined): boolean {
  return capabilities?.paneInspection === 'v1';
}

export function fetchPersistenceCapabilities(connectionId?: string, options: { configureTransport?: boolean } = {}): Promise<PersistenceCapabilities> {
  const base = backendApiBase(connectionId);
  const probe = () => backendFetch(`${base}/persistence/capabilities`, { signal: AbortSignal.timeout(10_000), cache: 'no-store' }).then(async (res) => {
    if (!res.ok) throw new Error(`fetchPersistenceCapabilities failed: ${res.status}`);
    return res.json() as Promise<PersistenceCapabilities>;
  });
  const result = probe();
  if (options.configureTransport !== false && isLocalConnectionId(connectionId)) {
    const available = (capabilities: PersistenceCapabilities) => capabilities.streamTransport === STREAM_TRANSPORT_PROTOCOL;
    configureStreamTransport(base, result.then(available), () => probe().then(available));
  }
  return result;
}

export interface WorkspaceCommand {
  type: 'workspace.upsert' | 'tree.upsert' | 'tree.delete' | 'node.upsert' | 'node.patch'
    | 'edge.upsert' | 'edge.delete' | 'context.upsert' | 'context.delete';
  payload: Record<string, unknown>;
}

/**
 * A command batch the backend answered with an error status. Older backends
 * send only `error`; newer ones add the DomainError `code` and, when known,
 * the batch limit and the command that failed.
 */
export class WorkspaceCommandsError extends Error {
  readonly name = 'WorkspaceCommandsError';
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly detail: {
      maxCommands?: number;
      commandIndex?: number;
      commandType?: string;
      entityId?: string;
    } = {},
  ) {
    super(message);
  }
}

/**
 * What a committed batch says of the artifacts it upserted and skipped:
 * - goneContextIds: deleted (the id is tombstoned), so the sender drops them;
 * - nameTakenContextIds: written under a name another artifact holds, a
 *   stale write; they are alive, so only that write is dropped.
 * Only lists of ids are taken; an older backend sends neither (and failed a
 * batch with a taken name instead, a 500).
 */
interface WorkspaceCommandsAnswer {
  goneContextIds: string[];
  nameTakenContextIds: string[];
}

function contextIdsOf(body: unknown, field: keyof WorkspaceCommandsAnswer): string[] {
  const ids = body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 160);
}

/**
 * The body of POST /workspaces/:id/commands. `artifactIdentity: 'id'` tells
 * the backend this window matches artifacts by id only (state/chatReducers.ts
 * never gives one another's id by name), so it never mistakes one of its
 * deletes for an older window's id takeover and skips it (backend
 * domainCommands.ts). A backend without that check reads only operationId
 * and commands and ignores the field.
 */
export function workspaceCommandsBody(operationId: string, commands: readonly WorkspaceCommand[]): string {
  return JSON.stringify({ operationId, commands, artifactIdentity: 'id' });
}

/** Commits `commands`; answers which of the artifacts they upserted the backend skipped (WorkspaceCommandsAnswer). */
export async function applyWorkspaceCommands(
  workspaceId: string,
  operationId: string,
  commands: readonly WorkspaceCommand[],
): Promise<WorkspaceCommandsAnswer> {
  if (commands.length === 0) return { goneContextIds: [], nameTakenContextIds: [] };
  const res = await backendFetch(`${workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(serverEntityId(workspaceId))}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: workspaceCommandsBody(operationId, commands),
  });
  if (!res.ok) {
    const body: Record<string, unknown> = await res.json().catch(() => ({}));
    const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined);
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    throw new WorkspaceCommandsError(
      text(body.error) ?? `applyWorkspaceCommands failed: ${res.status}`,
      res.status,
      text(body.code),
      {
        maxCommands: count(body.maxCommands),
        commandIndex: count(body.commandIndex),
        commandType: text(body.commandType),
        entityId: text(body.entityId),
      },
    );
  }
  // The batch committed whatever its body says: an unreadable one answers nothing skipped.
  let body: unknown = null;
  try { body = await res.json(); } catch { /* As above. */ }
  return { goneContextIds: contextIdsOf(body, 'goneContextIds'), nameTakenContextIds: contextIdsOf(body, 'nameTakenContextIds') };
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await backendFetch(`${workspaceBackendApiBase(id)}/workspaces/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteWorkspace failed: ${res.status}`);
}

/**
 * Physically purge every soft-deleted node in a workspace. Called from the
 * Empty Trash UI BEFORE clearing local state. Returns the count of rows
 * actually removed.
 */
export async function emptyWorkspaceTrash(workspaceId: string): Promise<{ ok: boolean; purged: number }> {
  const res = await backendFetch(`${workspaceBackendApiBase(workspaceId)}/workspaces/${serverEntityId(workspaceId)}/trash/empty`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`emptyWorkspaceTrash failed: ${res.status}`);
  return res.json();
}

/**
 * Physically purge a specific set of nodes from a workspace. Used for the
 * "delete permanently" action on a single trash group. Empty list is a no-op.
 */
export async function purgeWorkspaceNodes(
  workspaceId: string,
  nodeIds: string[],
): Promise<{ ok: boolean; purged: number }> {
  const res = await backendFetch(`${workspaceBackendApiBase(workspaceId)}/workspaces/${serverEntityId(workspaceId)}/nodes`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeIds }),
  });
  if (!res.ok) throw new Error(`purgeWorkspaceNodes failed: ${res.status}`);
  return res.json();
}

export async function moveTreeToWorkspace(
  treeId: string,
  fromWorkspaceId: string,
  toWorkspaceId: string,
): Promise<{ movedNodes: number; movedEdges: number; droppedEdges: number }> {
  const res = await backendFetch(`${workspaceBackendApiBase(fromWorkspaceId)}/trees/${encodeURIComponent(treeId)}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromWorkspaceId, toWorkspaceId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(err.error || `moveTreeToWorkspace failed: ${res.status}`);
  }
  const body = await res.json();
  return {
    movedNodes: body.movedNodes ?? 0,
    movedEdges: body.movedEdges ?? 0,
    droppedEdges: body.droppedEdges ?? 0,
  };
}

export interface ExtractNodeTreeResult {
  tree: { id: string; workspace_id: string; root_node_id: string; name?: string | null; created_at: number; last_active_at: number };
  nodeIds: string[];
  messages: unknown[];
  /** Fork provenance written by the backend (migration 0030). */
  forkedFromNodeId?: string | null;
  forkBoundaryMessageId?: string | null;
  inheritedMessageCount?: number;
}

export async function extractNodeTree(workspaceId: string, nodeId: string, treeId: string): Promise<ExtractNodeTreeResult> {
  const res = await backendFetch(`${workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(serverEntityId(workspaceId))}/nodes/${encodeURIComponent(nodeId)}/extract-tree`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ treeId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Extraction failed: ${res.status}`);
  }
  return res.json();
}
