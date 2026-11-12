import { clearRemoteRecoveryIssue, markRemoteRecoveryRetrying, reportRemoteRecoveryFailure, REMOTE_WORKSPACE_RETRY_EVENT } from './remoteRecovery';
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
  fetchAllWorkspacesMeta,
  fetchTreeMessageSnapshot,
  fetchPersistenceCapabilities,
  fetchWorkspace,
  fetchWorkspaces,
  applyWorkspaceCommands,
  listBackendConnections,
} from '../services/api';
import type { PersistenceCapabilities, WorkspaceCommand } from '../services/api';
import { findTreeIdForNode, storedTreeIdForNode } from './tree';
import {
  hydrateBackendWorkspaces,
  hydrateSavedState,
  applyTreeMessages,
  buildMessagesByNode,
  isNodeFieldDeferred,
  mapContextRow,
  mapEdgeRow,
  mapMessageRow,
  mapNodeRowScalars,
  mapTreeRow,
  STATE_SCHEMA_VERSION,
  type HydratedState,
  type SavedState,
} from './chatHydration';
import { messageForPersistence } from './assistantBlocks';
import { serializeBranchOverviewEntries, spawnOutboxComposerDraft } from 'michi-shared';
import { noteServerAttentionCapabilities } from '../services/serverAttentionStore';
import type { ChatNodeState, Project, ProjectEdge } from './chatTypes';
import {
  NODE_ADOPTED_FIELDS,
  TREE_ADOPTED_FIELDS,
  WORKSPACE_ADOPTED_FIELDS,
  rebaseOnAdoption,
  type AdoptionRebase,
  type NodeGuardField,
  type StructureAdoption,
  type TreeGuardField,
  type WorkspaceGuardField,
} from './structureAdoption';
import type { StructureEditGuards } from './structureMerge';
import { sleep } from '../utils/sleep';
import { serializedEdgeId } from './edgeIds';
import { firstLiveUserWorkspaceId, isSystemWorkspace } from './assistant/systemWorkspace';
import { startupMarkOnce } from '../services/startupTrace';
import { WorkspaceSyncQueue } from './workspaceSyncQueue';
import {
  COMMAND_CONFLICT_NOTICE_AFTER_MS,
  DEFAULT_MAX_COMMANDS_PER_BATCH,
  chunkWorkspaceCommands,
  classifyCommandFailure,
  commandRetryDelay,
  smallerCommandLimit,
} from './workspaceCommandBatches';
import {
  clearWorkspaceSyncNotice,
  requestWorkspaceStructureRead,
  showWorkspaceSyncNotice,
} from './workspaceSyncNotices';
import type { WorkspaceStructureChange } from 'michi-shared';
import { backendEntityId, remoteEntityIdentity, serverEntityId } from '../config/backendIdentity';
import { backendRequestOptions } from '../services/api/backendRequest';
import { supportsArtifactWriteAnswers, workspaceCommandsBody } from '../services/api/persistence';
import {
  BACKEND_CONNECTION_UNAVAILABLE,
  backendConnectionProvisional,
  confirmBackendConnection,
  markBackendConnectionProvisional,
  markBackendConnectionReady,
  markBackendConnectionUnavailable,
  whenBackendConnectionConfirmed,
} from '../config/backendConnectionState';
import type { TreeMessagePage } from '../services/api';
import { fetchRemoteTreeFirstPage, type TreeMessageRequests } from './treeMessageRequests';
import {
  defaultRemoteSnapshotCache,
  type CachedRemoteConnection,
  type CachedRemoteSnapshot,
  type RemoteSnapshotCache,
} from './remoteSnapshotCache';
import { installMatchingPage, mergeFreshOverCached, pageBehindNodes, pageShowable, type CachedOrigin } from './remoteCacheMerge';
import { markRemoteFirstPaint, resetRemoteFirstPaint } from './remoteFirstPaint';
import { rememberedPaneTreeIds } from './paneState';
import {
  isLocalProject,
  LOCAL_BACKEND_CONNECTION_ID,
  projectConnectionId,
  setKnownBackendConnections,
  workspaceBackendApiBase,
  type BackendConnectionSummary,
} from '../config/backendConnections';

// Note: the inbound load path for `Project.aiGlobalContext` lives in
// `chatHydration.ts` (which actually maps backend workspace rows to Project
// shape). This file owns the outbound command-row serialization. The dedicated
// POST /workspaces/:id/ai-global-context endpoint also writes the same field
// directly, so the next load picks it up either way.

/** Prefix for per-user namespaced workspace state keys. */
export const STATE_KEY_PREFIX = 'michi:v1:state:';

/** Legacy shared key used before per-user namespacing. Kept for migration + signOut cleanup. */
export const LEGACY_STATE_KEY = 'michi:v1:state';

/** Key set to '1' after the one-time localStorage-to-SQLite migration completes. */
export const MIGRATED_KEY = 'michi:migrated';

/** Build the per-user localStorage key for workspace state. */
export function buildStateKey(userId: string): string {
  return `${STATE_KEY_PREFIX}${userId}`;
}

// ── Per-project scoped localStorage layout ─────────────────────────────────
// Old layout: a single key (baseKey) holding {version, projects, activeProjectId, nodes}.
// New layout: a small index key + one blob per project, so a dirty tick only
// re-serializes the projects that actually changed.
//   `${baseKey}:index`   -> { version, activeProjectId, projectIds: string[] }
//   `${baseKey}:p:<id>`  -> { project: Project, nodes: Record<nodeId, ChatNodeState> }
// baseKey is `michi:v1:state:<userId>` (per-user) or `michi:v1:state` (legacy),
// so both derived keys start with STATE_KEY_PREFIX and are cleared by signOut.

interface StateIndex {
  version: number;
  activeProjectId: string | null;
  projectIds: string[];
}

/** localStorage key for the per-user/legacy state index. */
export function stateIndexKey(baseKey: string): string {
  return `${baseKey}:index`;
}

/** Remove the legacy durable chat mirror after backend v2 hydration succeeds.
 *  Also vacuums orphaned keys: old schema versions, stale per-window active
 *  project entries, and project blobs not referenced by the current index. */
export function clearDurableLocalStorageMirror(baseKey: string): void {
  try {
    const rawIndex = window.localStorage.getItem(stateIndexKey(baseKey));
    if (rawIndex) {
      const parsed = JSON.parse(rawIndex) as Partial<StateIndex>;
      for (const projectId of parsed.projectIds ?? []) {
        window.localStorage.removeItem(stateProjectKey(baseKey, projectId));
      }
    }
    window.localStorage.removeItem(stateIndexKey(baseKey));
    window.localStorage.removeItem(baseKey);

    // Vacuum: remove orphaned michi:* keys that accumulate over time.
    vacuumOrphanedKeys(baseKey);
  } catch {
    // Storage can be unavailable in private browsing; backend state remains authoritative.
  }
}

/**
 * Remove localStorage keys that are no longer referenced:
 * - Old schema version blobs (any `michi:v1:state*` key not under the current baseKey)
 * - Orphaned per-window active-project keys (keep the 3 most recent)
 * - The legacy shared blob if a per-user key was in use
 */
function vacuumOrphanedKeys(baseKey: string): void {
  const ls = window.localStorage;
  const winKeys: string[] = [];

  for (let i = ls.length - 1; i >= 0; i--) {
    const key = ls.key(i);
    if (!key || !key.startsWith('michi:')) continue;

    // Remove project/index blobs from a DIFFERENT base namespace (old user ids,
    // old schema versions). Current baseKey's children were already cleared above.
    if (
      key.startsWith(STATE_KEY_PREFIX) &&
      !key.startsWith(baseKey) &&
      key !== LEGACY_STATE_KEY &&
      key !== MIGRATED_KEY
    ) {
      ls.removeItem(key);
      continue;
    }

    // Collect per-window keys for pruning.
    if (key.includes(':win:') && key.endsWith(':activeProject')) {
      winKeys.push(key);
    }
  }

  // Keep only the 3 most recently written window keys (they're tiny but unbounded).
  if (winKeys.length > 3) {
    winKeys.sort();
    for (let i = 0; i < winKeys.length - 3; i++) {
      ls.removeItem(winKeys[i]);
    }
  }

  // Legacy shared blob: if a per-user namespace was active, the shared one is stale.
  if (baseKey !== LEGACY_STATE_KEY) {
    ls.removeItem(LEGACY_STATE_KEY);
  }
}

/** localStorage key for a single project's blob. */
export function stateProjectKey(baseKey: string, projectId: string): string {
  return `${baseKey}:p:${projectId}`;
}

/** localStorage key for a single window's active project id. */
export function activeProjectKey(baseKey: string, windowId: string): string {
  const ns = baseKey || LEGACY_STATE_KEY;
  return `${ns}:win:${windowId}:activeProject`;
}

export function readActiveProjectId(
  baseKey: string,
  windowId: string,
  legacy: string | null,
): string | null {
  if (typeof window === 'undefined') return legacy;
  const v = window.localStorage.getItem(activeProjectKey(baseKey, windowId));
  return v !== null ? v : legacy;
}

export function writeActiveProjectId(
  baseKey: string,
  windowId: string,
  projectId: string | null,
): void {
  if (typeof window === 'undefined') return;
  try {
    if (projectId === null) {
      window.localStorage.removeItem(activeProjectKey(baseKey, windowId));
    } else {
      window.localStorage.setItem(activeProjectKey(baseKey, windowId), projectId);
    }
  } catch {
    // Best effort: private browsing / quota errors should not break app state.
  }
}

export function mergeIndexProjectIds(diskIds: string[], memIds: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...diskIds, ...memIds]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const EMPTY_HYDRATED: HydratedState = { projects: [], activeProjectId: null, nodes: {} };

/**
 * The workspace a window opens on: its preference when loaded and not the
 * assistant's hidden system workspace (kept even trashed or archived, as a
 * running window keeps it), else the first live user workspace.
 * A preference not loaded (yet: typically a remote workspace whose snapshot
 * has not landed) comes back as `pendingPreferredId`, to restore once it does.
 */
export function resolveOpenableWorkspace(
  projects: readonly Project[],
  preferred: string | null,
): { activeId: string | null; pendingPreferredId: string | null } {
  const saved = preferred ? projects.find((project) => project.id === preferred) : undefined;
  if (saved && !isSystemWorkspace(saved)) return { activeId: saved.id, pendingPreferredId: null };
  return { activeId: firstLiveUserWorkspaceId(projects), pendingPreferredId: saved ? null : preferred };
}

/**
 * Remote content is never restored from this localStorage mirror. A reload
 * may show a remote workspace from the remote snapshot cache
 * (remoteSnapshotCache.ts, revision-checked), but only read-only: its
 * connection stays provisional, writes to it wait, and it becomes
 * authoritative only once the connection itself answers, whose metadata then
 * replaces the cached copy (remoteCacheMerge.ts).
 */
function localOnlySavedState(state: SavedState): SavedState {
  const projects = state.projects.filter(isLocalProject);
  const ids = new Set(projects.map(project => project.id));
  return {
    ...state, projects,
    activeProjectId: ids.has(state.activeProjectId ?? '') ? state.activeProjectId : null,
    nodes: Object.fromEntries(Object.entries(state.nodes).filter(([, node]) => ids.has(node.projectId))),
  };
}

/**
 * Backoff between hydration reachability retries while the backend is still
 * starting. Short enough that a cold start feels instant once the backend
 * binds; the loop only runs while every probe is rejecting.
 */
export const HYDRATION_RETRY_DELAY_MS = 250;
export const REMOTE_HYDRATION_RETRY_INITIAL_MS = 1_000;
export const REMOTE_HYDRATION_RETRY_MAX_MS = 15_000;
const REMOTE_HYDRATION_TIMEOUT_MS = 8_000;
/**
 * How long the hydration barrier waits for the active tree's message bodies
 * before painting with placeholders. The eager load exists to avoid a
 * placeholder→content flicker on first paint; a local ~5MB tree answers in
 * well under this budget, so the common case still paints real messages. A
 * slow answer (large tree, cold disk) hands the tree to the lazy loader
 * instead of holding the whole UI behind "loading workspaces…".
 */
export const ACTIVE_TREE_EAGER_BUDGET_MS = 750;

/**
 * Read the raw (pre-hydration) SavedState from localStorage. Prefers the new
 * per-project layout (index + per-project blobs) and falls back to the legacy
 * single-key blob. Returns null when nothing is stored. Does NOT run
 * hydrateSavedState — `readLocalStorageState` wraps the result for live state.
 */
export function readLocalStoragePayload(userId?: string): SavedState | null {
  if (typeof window === 'undefined') return null;
  const baseKey = userId ? buildStateKey(userId) : LEGACY_STATE_KEY;

  const rawIndex = window.localStorage.getItem(stateIndexKey(baseKey));
  if (rawIndex) {
    try {
      const index = JSON.parse(rawIndex) as StateIndex;
      const projects: SavedState['projects'] = [];
      const nodes: SavedState['nodes'] = {};
      for (const pid of index.projectIds ?? []) {
        const rawBlob = window.localStorage.getItem(stateProjectKey(baseKey, pid));
        if (!rawBlob) continue; // tolerate a missing / half-written blob
        try {
          const blob = JSON.parse(rawBlob) as { project: SavedState['projects'][number]; nodes: SavedState['nodes'] };
          if (!blob || !blob.project) continue;
          if (!isLocalProject(blob.project)) {
            window.localStorage.removeItem(stateProjectKey(baseKey, pid));
            continue;
          }
          projects.push(blob.project);
          // node ids are unique across projects by invariant, so no key collision
          Object.assign(nodes, blob.nodes ?? {});
        } catch {
          continue; // tolerate a corrupt blob, same as a missing one
        }
      }
      return {
        version: index.version ?? STATE_SCHEMA_VERSION,
        projects,
        activeProjectId: index.activeProjectId ?? null,
        nodes,
      };
    } catch {
      // Malformed index — fall through to the legacy single-key layout.
    }
  }

  // Legacy single-key layout. Per-user falls back to the shared legacy key,
  // matching the prior readLocalStorageState behavior.
  const rawSingle =
    window.localStorage.getItem(baseKey) ??
    (userId ? window.localStorage.getItem(LEGACY_STATE_KEY) : null);
  if (!rawSingle) return null;
  try {
    const state = localOnlySavedState(JSON.parse(rawSingle) as SavedState);
    window.localStorage.setItem(baseKey, JSON.stringify(state));
    if (userId) window.localStorage.removeItem(LEGACY_STATE_KEY);
    return state;
  } catch {
    return null;
  }
}

export function readLocalStorageState(userId?: string): HydratedState {
  const payload = readLocalStoragePayload(userId);
  if (!payload) return EMPTY_HYDRATED;
  return hydrateSavedState(payload);
}

export const readInitialHydrated = readLocalStorageState;

// ── Shared row-mapping helpers ─────────────────────────────────────────────
// Both the full serializer (serializeWorkspaceForSync) and the delta serializer
// (serializeWorkspaceDelta) build their wire rows EXCLUSIVELY through these
// helpers. Keeping the per-entity mapping in one place is what guarantees the
// two paths CONVERGE: a delta of one change produces the exact same row shapes
// (and message-id derivation) a full sync of the post-change snapshot would.
// Do NOT inline divergent mapping logic in either serializer.

/** The workspace row's settings, or null when it has none. */
function workspaceSettings(project: Project): Record<string, unknown> | null {
  // Embed per-workspace flags into the opaque settings JSON. Default ON: only
  // serialize aiGlobalContext when explicitly disabled, so existing rows that
  // never carried this field keep their default-true semantics.
  const settings: Record<string, unknown> = {};
  if (project.aiGlobalContext === false) settings.aiGlobalContext = false;
  // Only emit when non-empty: keeps the settings blob absent for the common
  // case where the user never touched Instructions.
  if (project.instructions && project.instructions.length > 0) {
    settings.instructions = project.instructions;
  }
  // The row upsert replaces the whole settings blob: a system workspace (the
  // assistant's) must keep its flag or it would turn into a user workspace.
  if (project.system) settings.system = project.system;
  return Object.keys(settings).length > 0 ? settings : null;
}

/** Build the single `workspaces` row. Identical for full + delta. */
export function serializeWorkspaceRow(project: Project) {
  const settings = workspaceSettings(project);
  return {
    id: project.id,
    name: project.name,
    cwd: project.cwd || null,
    active_tree_id: project.activeTreeId || null,
    created_at: project.createdAt || Date.now(),
    updated_at: Date.now(),
    // The command handler stores settings in a TEXT column, so pass a
    // serialized JSON string (or null).
    settings: settings ? JSON.stringify(settings) : null,
    // Soft-delete + archive + pin timestamps live on the row so a "deleted"
    // workspace stays in the trash across restarts. Always emit (number or
    // null) so restore clears the column instead of leaving stale state.
    deleted_at: project.deletedAt ?? null,
    archived_at: project.archivedAt ?? null,
    pinned_at: project.pinnedAt ?? null,
    // Multi-folder: persist the full folder array (JSON string or null).
    folders: (project.folders && project.folders.length > 0)
      ? JSON.stringify(project.folders)
      : null,
  };
}

/** Build one `trees` row. */
export function serializeTreeRow(project: Project, t: Project['trees'][number]) {
  return {
    id: t.id,
    workspace_id: project.id,
    root_node_id: t.rootNodeId,
    name: t.name || null,
    archived_at: t.archivedAt || null,
    pinned_at: t.pinnedAt || null,
    last_active_at: t.lastActiveAt || Date.now(),
    created_at: t.createdAt || Date.now(),
  };
}

/**
 * Build one `nodes` row, or null when the node is missing from `nodes`.
 * Callers filter null out of the wire array. A lean field the node deferred
 * (ChatNodeState.deferredNodeFields) is left out: this window holds no value
 * for it, and the backend keeps a column whose key a row leaves out.
 */
export function serializeNodeRow(
  project: Project,
  nodes: Record<string, ChatNodeState>,
  nid: string,
) {
  const n = nodes[nid];
  if (!n) return null;
  // The spawn outbox is this window's own value: it always travels.
  const draftDeferred = !n.pendingSpawnPrompt && isNodeFieldDeferred(n, 'composer_draft');
  return {
    id: nid,
    workspace_id: project.id,
    tree_id: storedTreeIdForNode(nid, project, nodes),
    parent_node_id: n.parentNodeId || null,
    kind: n.kind || 'chat',
    title: n.title || null,
    ...(isNodeFieldDeferred(n, 'branch_overview') ? {} : {
      branch_overview: serializeBranchOverviewEntries(n.branchOverviewEntries ?? []),
    }),
    status: 'idle',
    position_x: n.position?.x ?? null,
    position_y: n.position?.y ?? null,
    minimized: n.minimized ? 1 : 0,
    deleted_at: n.deletedAt ?? null,
    deletion_group_id: n.deletionGroupId ?? null,
    spawned_by_agent: n.spawnedByAgent ? 1 : 0,
    current_mode_id: n.currentModeId ?? null,
    pane_width: n.paneWidth ?? null,
    digest: n.digest ? JSON.stringify({ ...n.digest, status: 'idle', error: undefined, generation: undefined }) : null,
    ...(isNodeFieldDeferred(n, 'follow_ups') ? {} : {
      follow_ups: n.followUps.length > 0 ? JSON.stringify(n.followUps) : null,
      follow_ups_source_message_id: n.followUpsSourceMessageId ?? null,
    }),
    // Runtime session bindings are server-owned. In particular, never write
    // the public node id over Kiro's persisted ACP session id.
    runtime_id: n.runtimeId ?? null,
    provider_id: n.providerId ?? null,
    model_id: n.modelId ?? null,
    reasoning: n.reasoning ?? null,
    resume_fingerprint: n.resumeFingerprint ?? null,
    last_applied_turn_id: n.lastAppliedTurnId ?? null,
    last_applied_seq: n.lastAppliedSeq ?? null,
    // Keep an agent-spawn outbox entry durable until the stream's turn_start
    // arrives. Ordinary composer persistence must not erase it before send.
    ...(draftDeferred ? {} : {
      composer_draft: n.pendingSpawnPrompt
        ? spawnOutboxComposerDraft(n.pendingSpawnPrompt)
        : n.composerDraft ? JSON.stringify(n.composerDraft) : null,
    }),
    trim_snapshot: n.trimSnapshot ? JSON.stringify(n.trimSnapshot) : null,
    pinned_at: n.pinnedAt ?? null,
    created_at: n.messages[0]?.createdAt ?? project.createdAt ?? Date.now(),
  };
}

/** Build one `edges` row. The id derivation is the convergence key. */
export function serializeEdgeRow(project: Project, e: Project['edges'][number]) {
  return {
    id: serializedEdgeId(e),
    workspace_id: project.id,
    source_node_id: e.source,
    target_node_id: e.target,
    kind: e.kind || 'branch',
    anchor_message_id: e.anchorMessageId ?? null,
    created_at: e.createdAt ?? null,
  };
}

/**
 * The graph slice a request carries for a node the backend may not hold yet
 * (the backend's EnsureDurableGraphNodeInput, in camelCase). Built from the
 * row serializers, so it writes what the next sync of those rows would.
 */
export function durableNodePrerequisite(
  project: Project,
  nodes: Record<string, ChatNodeState>,
  node: ChatNodeState,
): Record<string, unknown> {
  const withNode = nodes[node.nodeId] === node ? nodes : { ...nodes, [node.nodeId]: node };
  const workspace = serializeWorkspaceRow(project);
  const row = serializeNodeRow(project, withNode, node.nodeId)!;
  const tree = row.tree_id ? project.trees.find((candidate) => candidate.id === row.tree_id) : undefined;
  const treeRow = tree ? serializeTreeRow(project, tree) : null;
  const existingEdges = project.edges.filter((edge) => edge.target === node.nodeId);
  const graphEdges: ProjectEdge[] = existingEdges.length > 0
    ? existingEdges
    : node.parentNodeId
      ? [{ source: node.parentNodeId, target: node.nodeId, kind: 'branch' as const }]
      : (node.mergeSources ?? []).map((source) => ({ source, target: node.nodeId, kind: 'merge' as const }));
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      cwd: workspace.cwd,
      createdAt: workspace.created_at,
      activeTreeId: workspace.active_tree_id,
      settings: workspaceSettings(project),
    },
    ...(treeRow ? {
      tree: {
        id: treeRow.id,
        rootNodeId: treeRow.root_node_id,
        name: treeRow.name,
        archivedAt: treeRow.archived_at,
        pinnedAt: treeRow.pinned_at,
        lastActiveAt: treeRow.last_active_at,
        createdAt: treeRow.created_at,
      },
    } : {}),
    node: {
      id: row.id,
      treeId: row.tree_id,
      parentNodeId: row.parent_node_id,
      kind: row.kind,
      title: row.title,
      spawnedByAgent: row.spawned_by_agent === 1,
      currentModeId: row.current_mode_id,
      createdAt: row.created_at,
    },
    edges: graphEdges.map((edge) => {
      const edgeRow = serializeEdgeRow(project, edge);
      return {
        id: edgeRow.id,
        sourceNodeId: edgeRow.source_node_id,
        targetNodeId: edgeRow.target_node_id,
        kind: edgeRow.kind,
        anchorMessageId: edgeRow.anchor_message_id,
        createdAt: edgeRow.created_at,
      };
    }),
  };
}

/**
 * Build the FULL message row list for one node (skipping streaming assistant
 * messages, exactly like the full serializer). The per-node message reconcile
 * on the backend treats this list as authoritative for that node, so it MUST be
 * the node's complete current message set. Returns [] when the node is missing.
 */
export function serializeMessageRowsForNode(
  nodes: Record<string, ChatNodeState>,
  nid: string,
) {
  const n = nodes[nid];
  if (!n) return [];
  return (n.messages || []).flatMap((m, i) => {
    if (m.role === 'assistant' && m.streaming) return [];
    const persisted = messageForPersistence(m);
    // Mirror every assistant metadata field the backend projection writes
    // (turnPersistence.recipes durableMessageMetadata): a write-back that
    // omits one silently erases it from the row. A cleared plan (`[]`) counts.
    const metadata = m.role === 'assistant'
      ? (Array.isArray(m.plan) || persisted.steeringReports?.length || persisted.subagents?.length
          ? { plan: m.plan, steeringReports: persisted.steeringReports, subagents: persisted.subagents } : null)
      : (m.steered || m.scheduledJobId || m.quotedText || m.attachments?.length || m.comments?.length
          || m.companionTurn || m.companionRefs?.length
          ? {
              ...(m.steered ? { steered: true } : {}),
              ...(m.scheduledJobId ? { scheduledJobId: m.scheduledJobId } : {}),
              quotedText: m.quotedText,
              quoteSource: m.quoteSource,
              attachments: m.attachments,
              comments: m.comments,
              // What the route decided about a message to the agent, and what it referred to (F1a):
              // the stored row keeps them, so a write-back must not drop them.
              ...(m.companionTurn ? { companionTurn: m.companionTurn } : {}),
              ...(m.companionRefs?.length ? { companionRefs: m.companionRefs } : {}),
            }
          : null);
    return [{
      id: m.id || `${nid}-${i}`,
      node_id: nid,
      role: m.role,
      content: persisted.content,
      blocks: persisted.blocks,
      tool_calls: persisted.toolCalls.length > 0 ? JSON.stringify(persisted.toolCalls) : null,
      metadata: metadata ? JSON.stringify(metadata) : null,
      seq: i,
      created_at: m.createdAt ?? Date.now(),
    }];
  });
}

/** Build one `artifacts` row. `auto_inject` is retired (always 0); the artifact
 *  fields (type/url/origin/kind/pinned_at) round-trip via migration 0008. */
export function serializeContextRow(project: Project, c: NonNullable<Project['artifacts']>[number]) {
  return {
    id: c.id,
    workspace_id: project.id,
    name: c.name,
    file_path: c.filePath ?? '',
    size: c.size ?? null,
    auto_inject: 0,
    source: c.source || 'user',
    type: c.type ?? null,
    url: c.url ?? null,
    origin_node_id: c.origin?.nodeId ?? null,
    origin_message_id: c.origin?.messageId ?? null,
    kind: c.kind ?? null,
    pinned_at: c.pinnedAt ?? null,
    created_at: c.createdAt || Date.now(),
    updated_at: c.updatedAt || Date.now(),
  };
}

// ── Row values ─────────────────────────────────────────────────────────────
// What each serializer writes, minus its Date.now() fallbacks: two entities
// with the same key write the same row. Snapshot installs and re-reads bring
// fresh objects for unchanged rows; comparing these keys (not identities)
// keeps those out of the dirty delta.

function workspaceRowKey(project: Project): string {
  const { updated_at: _updatedAt, created_at: _createdAt, ...row } = serializeWorkspaceRow(project);
  return JSON.stringify({ ...row, created_at: project.createdAt || 0 });
}

function treeRowKey(tree: Project['trees'][number]): string {
  return JSON.stringify([tree.rootNodeId, tree.name || null, tree.archivedAt || null, tree.pinnedAt || null,
    tree.lastActiveAt || 0, tree.createdAt || 0]);
}

/** The serialized edge id carries kind, source and target. */
function edgeRowKey(edge: Project['edges'][number]): string {
  return JSON.stringify([edge.anchorMessageId ?? null, edge.createdAt ?? null]);
}

function contextRowKey(context: NonNullable<Project['artifacts']>[number]): string {
  return JSON.stringify([context.name, context.filePath ?? '', context.size ?? null, context.source || 'user',
    context.type ?? null, context.url ?? null, context.origin?.nodeId ?? null, context.origin?.messageId ?? null,
    context.kind ?? null, context.pinnedAt ?? null, context.createdAt || 0, context.updatedAt || 0]);
}

/** The delta (serialized ids) a command list writes. */
export function commandsDelta(commands: readonly WorkspaceCommand[]): WorkspaceDirtyDelta {
  const delta = emptyWorkspaceDirtyDelta();
  for (const command of commands) {
    const id = typeof command.payload.id === 'string' ? command.payload.id : '';
    switch (command.type) {
      case 'workspace.upsert': delta.workspaceChanged = true; break;
      case 'tree.upsert': delta.treeUpsertIds.add(id); break;
      case 'tree.delete': delta.treeDeleteIds.add(id); break;
      case 'node.upsert':
      case 'node.patch': delta.nodeIds.add(id); break;
      case 'edge.upsert': delta.edgeUpsertIds.add(id); break;
      case 'edge.delete': delta.edgeDeleteIds.add(id); break;
      case 'context.upsert': delta.contextUpsertIds.add(id); break;
      case 'context.delete': delta.contextDeleteIds.add(id); break;
    }
  }
  return delta;
}

function deltaIsEmpty(delta: WorkspaceDirtyDelta): boolean {
  return !delta.workspaceChanged
    && delta.nodeIds.size === 0 && delta.draftNodeIds.size === 0
    && delta.edgeUpsertIds.size === 0 && delta.edgeDeleteIds.size === 0
    && delta.treeUpsertIds.size === 0 && delta.treeDeleteIds.size === 0
    && delta.contextUpsertIds.size === 0 && delta.contextDeleteIds.size === 0;
}

/**
 * `pending` reduced to what `commands` (built from it) write: an id that
 * builds to nothing (a node the backend already holds, an entity gone since)
 * no longer waits, nor shields its entity from a re-read.
 */
export function pendingThatWrites(pending: WorkspaceDirtyDelta, commands: readonly WorkspaceCommand[]): WorkspaceDirtyDelta {
  const written = commandsDelta(commands);
  const keep = (ids: Set<string>, from: Set<string>) => new Set([...ids].filter((id) => from.has(id)));
  return {
    nodeIds: keep(pending.nodeIds, written.nodeIds),
    draftNodeIds: keep(pending.draftNodeIds, written.nodeIds),
    edgeUpsertIds: keep(pending.edgeUpsertIds, written.edgeUpsertIds),
    edgeDeleteIds: keep(pending.edgeDeleteIds, written.edgeDeleteIds),
    treeUpsertIds: keep(pending.treeUpsertIds, written.treeUpsertIds),
    treeDeleteIds: keep(pending.treeDeleteIds, written.treeDeleteIds),
    contextUpsertIds: keep(pending.contextUpsertIds, written.contextUpsertIds),
    contextDeleteIds: keep(pending.contextDeleteIds, written.contextDeleteIds),
    workspaceChanged: pending.workspaceChanged && written.workspaceChanged,
  };
}

export function serializeWorkspaceForSync(
  project: Project,
  nodes: Record<string, ChatNodeState>,
) {
  return {
    workspace: serializeWorkspaceRow(project),
    trees: (project.trees || []).map((t) => serializeTreeRow(project, t)),
    nodes: project.chatIds
      .map((nid) => serializeNodeRow(project, nodes, nid))
      .filter(Boolean),
    edges: (project.edges || []).map((e) => serializeEdgeRow(project, e)),
    messages: project.chatIds.flatMap((nid) => serializeMessageRowsForNode(nodes, nid)),
    artifacts: (project.artifacts || []).map((c) => serializeContextRow(project, c)),
  };
}

export interface ExplicitCommandBatch {
  commands: WorkspaceCommand[];
  nodeProjectionUpdates: Map<string, string>;
  /** View marks this batch writes, by node: what `knownViewedAt` holds once it lands. */
  viewedAtUpdates: Map<string, number>;
  /** Seen completion counts this batch writes: what `knownSeenCompletion` holds once it lands. */
  seenCompletionUpdates: Map<string, number>;
}

/**
 * The node.patch a node's row writes, which is also its projection: what the
 * backend holds of it once written. `withoutDraft` leaves the draft out, as
 * for a node whose draft lean metadata deferred.
 */
function nodeCommandPatch(
  row: NonNullable<ReturnType<typeof serializeNodeRow>>,
  node: ChatNodeState,
  windowId?: string,
  withoutDraft = false,
): Record<string, unknown> {
  return {
    id: row.id,
    tree_id: row.tree_id,
    parent_node_id: row.parent_node_id,
    kind: row.kind,
    spawned_by_agent: row.spawned_by_agent,
    ...(node.titleNeedsPersistence ? { title: row.title } : {}),
    current_mode_id: row.current_mode_id,
    pane_width: row.pane_width,
    position_x: row.position_x,
    position_y: row.position_y,
    minimized: row.minimized,
    digest: row.digest,
    ...('composer_draft' in row && !withoutDraft ? {
      composer_draft: row.composer_draft,
      ...(windowId && !node.pendingSpawnPrompt ? { composer_draft_window_id: windowId } : {}),
    } : {}),
    deleted_at: row.deleted_at,
    deletion_group_id: row.deletion_group_id,
    trim_snapshot: row.trim_snapshot,
    pinned_at: row.pinned_at,
  };
}

function noteDurableViewedAt(known: Map<string, number>, nodeId: string, node: ChatNodeState | undefined): void {
  if (node?.viewedAt !== undefined) known.set(nodeId, node.viewedAt);
}

function noteDurableSeenCompletion(known: Map<string, number>, nodeId: string, node: ChatNodeState | undefined): void {
  if (node?.seenCompletionSeq !== undefined) known.set(nodeId, node.seenCompletionSeq);
}

/** A view mark only counts against a reply (unread, Just done), so a node without one has none to save. */
function hasReply(node: ChatNodeState): boolean {
  return node.lastAssistantAt !== undefined
    || node.messages.some((message) => message.role === 'assistant')
    || (node.messagesLoaded === false && (node.messageCount ?? 0) > 1);
}

/**
 * Convert an entity delta into explicit, message-free domain commands. With
 * `knownViewedAt` (the view mark the backend holds per node), a node viewed
 * since gets a patch carrying only `viewed_at`, after any upsert that creates
 * it, so a view never replays this window's pane or graph fields. A node with
 * no reply yet gets none. With `knownSeenCompletion` too, the mark also carries
 * a seen completion count newer than the backend's (`seen_completion_seq`),
 * only for nodes whose backend sent completion facts.
 */
export function buildExplicitWorkspaceCommands(
  project: Project,
  nodes: Record<string, ChatNodeState>,
  delta: WorkspaceDirtyDelta,
  knownNodeProjections: ReadonlyMap<string, string>,
  windowId?: string,
  knownViewedAt?: ReadonlyMap<string, number>,
  knownSeenCompletion?: ReadonlyMap<string, number>,
): ExplicitCommandBatch {
  const commands: WorkspaceCommand[] = [];
  const nodeProjectionUpdates = new Map<string, string>();
  const viewedAtUpdates = new Map<string, number>();
  const seenCompletionUpdates = new Map<string, number>();
  if (delta.workspaceChanged) {
    commands.push({ type: 'workspace.upsert', payload: serializeWorkspaceRow(project) });
  }

  for (const treeId of delta.treeUpsertIds) {
    const tree = project.trees.find((candidate) => candidate.id === treeId);
    if (tree) commands.push({ type: 'tree.upsert', payload: serializeTreeRow(project, tree) });
  }
  // A node marked here that has since left (a thread moved to another
  // workspace) is not this workspace's to write: the backend refuses it.
  // (A view mark alone is harmless: the backend ignores one for a node elsewhere.)
  const members = new Set(project.chatIds);
  for (const nodeId of delta.nodeIds) {
    if (!members.has(nodeId)) continue;
    const row = serializeNodeRow(project, nodes, nodeId);
    if (!row) continue;
    const patch = nodeCommandPatch(row, nodes[nodeId], windowId);
    const projection = JSON.stringify(patch);
    const known = knownNodeProjections.get(nodeId);
    if (known === projection) continue;
    // Known while the draft was deferred, and the draft since came from the
    // backend's own page: nothing to write. A draft typed since is written
    // by the draft-only patch below.
    if (known !== undefined && 'composer_draft' in patch
      && known === JSON.stringify(nodeCommandPatch(row, nodes[nodeId], windowId, true))) continue;
    const draftWindow = 'composer_draft' in row && windowId && !nodes[nodeId].pendingSpawnPrompt;
    commands.push({ type: 'node.upsert', payload: { ...row, ...(draftWindow ? { composer_draft_window_id: windowId } : {}) } });
    commands.push({ type: 'node.patch', payload: patch });
    nodeProjectionUpdates.set(nodeId, projection);
  }
  // Draft-only writes must not replay stale pane/graph fields from this window.
  // A row written above carries the draft; one skipped as unchanged may not:
  // draft-only writes leave its known projection behind, so a send that empties
  // the draft can match the projection from before it was typed.
  for (const nodeId of delta.draftNodeIds) {
    if (nodeProjectionUpdates.has(nodeId) || !members.has(nodeId)) continue;
    const node = nodes[nodeId];
    // A deferred draft has no value here to write.
    if (!node || node.pendingSpawnPrompt || node.deletedAt || isNodeFieldDeferred(node, 'composer_draft')) continue;
    commands.push({ type: 'node.patch', payload: {
      id: nodeId,
      composer_draft: node.composerDraft ? JSON.stringify(node.composerDraft) : null,
      ...(windowId ? { composer_draft_window_id: windowId } : {}),
    } });
  }
  if (knownViewedAt) {
    for (const nodeId of delta.nodeIds) {
      const node = nodes[nodeId];
      const viewedAt = node?.viewedAt;
      if (viewedAt === undefined || !hasReply(node)) continue;
      const viewAdvanced = viewedAt > (knownViewedAt.get(nodeId) ?? 0);
      const seen = node.completionSeq !== undefined ? node.seenCompletionSeq : undefined;
      const seenAdvanced = seen !== undefined && knownSeenCompletion !== undefined
        && seen > (knownSeenCompletion.get(nodeId) ?? 0);
      if (!viewAdvanced && !seenAdvanced) continue;
      commands.push({ type: 'node.patch', payload: {
        id: nodeId,
        viewed_at: viewedAt,
        ...(seenAdvanced ? { seen_completion_seq: seen } : {}),
      } });
      if (viewAdvanced) viewedAtUpdates.set(nodeId, viewedAt);
      if (seenAdvanced) seenCompletionUpdates.set(nodeId, seen);
    }
  }
  const edgeById = delta.edgeUpsertIds.size > 0
    ? new Map(project.edges.map((edge) => [serializedEdgeId(edge), edge] as const))
    : null;
  for (const edgeId of delta.edgeUpsertIds) {
    const edge = edgeById?.get(edgeId);
    if (edge) commands.push({ type: 'edge.upsert', payload: serializeEdgeRow(project, edge) });
  }
  const contextById = delta.contextUpsertIds.size > 0
    ? new Map((project.artifacts ?? []).map((context) => [context.id, context] as const))
    : null;
  for (const contextId of delta.contextUpsertIds) {
    const context = contextById?.get(contextId);
    if (context) commands.push({ type: 'context.upsert', payload: serializeContextRow(project, context) });
  }
  for (const edgeId of delta.edgeDeleteIds) {
    commands.push({ type: 'edge.delete', payload: { id: edgeId } });
  }
  for (const contextId of delta.contextDeleteIds) {
    commands.push({ type: 'context.delete', payload: { id: contextId } });
  }
  for (const treeId of delta.treeDeleteIds) {
    commands.push({ type: 'tree.delete', payload: { id: treeId } });
  }
  return { commands, nodeProjectionUpdates, viewedAtUpdates, seenCompletionUpdates };
}

/**
 * `base` (older: the pending delta, possibly in flight) and `incoming` (newer:
 * what the tracker saw since) as one delta. For an artifact the later state
 * wins: a newer delete drops an older upsert, which otherwise would build
 * nothing (the artifact is gone from the store) and lose the delete, so an
 * upsert still in flight would leave it on the backend; a newer upsert (a
 * re-create) drops an older delete.
 */
export function mergeWorkspaceDirtyDelta(
  base: WorkspaceDirtyDelta,
  incoming: WorkspaceDirtyDelta,
): WorkspaceDirtyDelta {
  const merged = emptyWorkspaceDirtyDelta();
  for (const key of [
    'nodeIds', 'draftNodeIds', 'edgeUpsertIds', 'edgeDeleteIds',
    'treeUpsertIds', 'treeDeleteIds', 'contextUpsertIds', 'contextDeleteIds',
  ] as const) {
    for (const value of base[key]) merged[key].add(value);
    for (const value of incoming[key]) merged[key].add(value);
  }
  for (const id of merged.edgeUpsertIds) merged.edgeDeleteIds.delete(id);
  for (const id of merged.treeUpsertIds) merged.treeDeleteIds.delete(id);
  for (const id of incoming.contextDeleteIds) if (!incoming.contextUpsertIds.has(id)) merged.contextUpsertIds.delete(id);
  for (const id of merged.contextUpsertIds) merged.contextDeleteIds.delete(id);
  merged.workspaceChanged = base.workspaceChanged || incoming.workspaceChanged;
  return merged;
}

// ── Incremental delta serialization ────────────────────────────────────────

/**
 * Per-project pending delta accumulated by the dirty-tracking effect between
 * flushes. Each set is in terms of the SERIALIZED id of the entity (e.g. edge
 * ids are `${kind}-${source}-${target}`, matching serializeEdgeRow).
 */
export interface WorkspaceDirtyDelta {
  /** Nodes whose row changed → upsert these node rows. */
  nodeIds: Set<string>;
  /** Draft-only edits; save no shared pane or graph fields. */
  draftNodeIds: Set<string>;
  /** Edges added/changed (by serialized edge id). */
  edgeUpsertIds: Set<string>;
  /** Edges removed (by serialized edge id). */
  edgeDeleteIds: Set<string>;
  treeUpsertIds: Set<string>;
  treeDeleteIds: Set<string>;
  contextUpsertIds: Set<string>;
  contextDeleteIds: Set<string>;
  /** The workspace row (workspaceRowKey) changed. */
  workspaceChanged: boolean;
}

/** A fresh, empty dirty delta. */
export function emptyWorkspaceDirtyDelta(): WorkspaceDirtyDelta {
  return {
    nodeIds: new Set<string>(),
    draftNodeIds: new Set<string>(),
    edgeUpsertIds: new Set<string>(),
    edgeDeleteIds: new Set<string>(),
    treeUpsertIds: new Set<string>(),
    treeDeleteIds: new Set<string>(),
    contextUpsertIds: new Set<string>(),
    contextDeleteIds: new Set<string>(),
    workspaceChanged: false,
  };
}

/**
 * Entities a backend snapshot just brought into the store
 * (installWorkspaceSnapshot: the assistant's workspace, a thread made in
 * another window). They are already durable, so the dirty tracker never
 * writes them back; it treats them as loaded, the way hydration does.
 */
export interface BackendInstalledEntities {
  projectId: string;
  /** The whole workspace is new to the store. */
  newProject: boolean;
  nodeIds: readonly string[];
  treeIds: readonly string[];
  /** Serialized edge ids (serializedEdgeId). */
  edgeIds: readonly string[];
  /** Artifacts it brought in (a cached copy replaced by the remote's answer). */
  contextIds?: readonly string[];
  /** The workspace row as rendered is the backend's (that answer, where nothing here changed it). */
  workspaceRow?: boolean;
}

/** True once `project` (as rendered) holds everything a noted install brought in. */
function backendInstallLanded(project: Project, installed: BackendInstalledEntities): boolean {
  const trees = new Set(project.trees.map((tree) => tree.id));
  const edges = new Set(project.edges.map(serializedEdgeId));
  return installed.nodeIds.every((id) => project.chatIds.includes(id))
    && installed.treeIds.every((id) => trees.has(id))
    && installed.edgeIds.every((id) => edges.has(id));
}

/** A noted install that still hasn't landed after this many scans is let go. */
const BACKEND_INSTALL_MAX_MISSES = 20;

/**
 * Trees, edges and artifacts this window removed from a workspace that the
 * backend may not have heard of yet (or only just has): a backend snapshot
 * read earlier must not bring them back.
 */
export interface PendingBackendDeletes {
  treeIds: ReadonlySet<string>;
  /** Serialized edge ids (serializedEdgeId). */
  edgeIds: ReadonlySet<string>;
  /** Only node installs read artifacts back. */
  contextIds?: ReadonlySet<string>;
}

/**
 * Confirmed tree/edge deletes remembered per workspace, newest kept. Only a
 * snapshot read that began before a delete was confirmed needs it (see
 * pendingBackendDeletes); this just bounds the memory.
 */
const CONFIRMED_DELETES_KEPT = 500;

function rememberConfirmedDelete<T>(ids: Map<string, T>, id: string, at: T): void {
  ids.delete(id); // re-set moves it to the newest end
  ids.set(id, at);
  for (const oldest of ids.keys()) {
    if (ids.size <= CONFIRMED_DELETES_KEPT) break;
    ids.delete(oldest);
  }
}

function mergeBackendInstalled(a: BackendInstalledEntities, b: BackendInstalledEntities): BackendInstalledEntities {
  return {
    projectId: a.projectId,
    newProject: a.newProject || b.newProject,
    nodeIds: [...new Set([...a.nodeIds, ...b.nodeIds])],
    treeIds: [...new Set([...a.treeIds, ...b.treeIds])],
    edgeIds: [...new Set([...a.edgeIds, ...b.edgeIds])],
    ...(a.contextIds || b.contextIds ? { contextIds: [...new Set([...(a.contextIds ?? []), ...(b.contextIds ?? [])])] } : {}),
    ...(a.workspaceRow || b.workspaceRow ? { workspaceRow: true } : {}),
  };
}

function rememberBackendInstalled(
  into: Map<string, { installed: BackendInstalledEntities; misses: number }>,
  installed: BackendInstalledEntities,
): void {
  const prev = into.get(installed.projectId);
  into.set(installed.projectId, { installed: prev ? mergeBackendInstalled(prev.installed, installed) : installed, misses: 0 });
}

/** `delta` without the installed entities; null when nothing else is left to write. */
export function withoutBackendInstalled(
  delta: WorkspaceDirtyDelta,
  installed: BackendInstalledEntities,
): WorkspaceDirtyDelta | null {
  if (installed.newProject) return null;
  const without = (ids: Set<string>, drop: readonly string[]) => {
    const next = new Set(ids);
    for (const id of drop) next.delete(id);
    return next;
  };
  const rest: WorkspaceDirtyDelta = {
    ...delta,
    nodeIds: without(delta.nodeIds, installed.nodeIds),
    draftNodeIds: without(delta.draftNodeIds, installed.nodeIds),
    treeUpsertIds: without(delta.treeUpsertIds, installed.treeIds),
    edgeUpsertIds: without(delta.edgeUpsertIds, installed.edgeIds),
    contextUpsertIds: without(delta.contextUpsertIds, installed.contextIds ?? []),
    workspaceChanged: delta.workspaceChanged && !installed.workspaceRow,
  };
  const empty = !rest.workspaceChanged
    && rest.nodeIds.size === 0 && rest.draftNodeIds.size === 0
    && rest.edgeUpsertIds.size === 0 && rest.edgeDeleteIds.size === 0
    && rest.treeUpsertIds.size === 0 && rest.treeDeleteIds.size === 0
    && rest.contextUpsertIds.size === 0 && rest.contextDeleteIds.size === 0;
  return empty ? null : rest;
}

// ── Confirmed structure values ─────────────────────────────────────────────
// The value of each structural field the backend last confirmed to this
// window (hydration, its own writes, adopted re-reads), and when. A store
// value that differs is this window's unconfirmed edit; a re-read must not
// overwrite it, nor anything confirmed after the re-read began.

type FieldConfirmations = Map<string, { value: unknown; at: number }>;

const WORKSPACE_FIELD_COLUMNS = new Map<string, WorkspaceGuardField>(WORKSPACE_ADOPTED_FIELDS);
const TREE_FIELD_COLUMNS = new Map<string, TreeGuardField>(TREE_ADOPTED_FIELDS);
const NODE_FIELD_COLUMNS = new Map<string, NodeGuardField>(NODE_ADOPTED_FIELDS);
const WORKSPACE_GUARD_FIELDS: readonly WorkspaceGuardField[] = [...WORKSPACE_FIELD_COLUMNS.values()];
const TREE_GUARD_FIELDS: readonly TreeGuardField[] = [...TREE_FIELD_COLUMNS.values()];
/** Node projection columns a structure re-read may adopt. */
const NODE_STRUCTURE_COLUMNS = ['tree_id', 'parent_node_id', 'title', 'deleted_at', 'deletion_group_id', 'trim_snapshot', 'pinned_at'] as const;

function confirmFields(
  into: Map<string, FieldConfirmations>,
  id: string,
  row: Record<string, unknown>,
  fields: readonly string[],
  at: number,
): void {
  const confirmations = into.get(id) ?? new Map<string, { value: unknown; at: number }>();
  for (const field of fields) if (field in row) confirmations.set(field, { value: row[field], at });
  into.set(id, confirmations);
}

function fieldEdited(confirmations: FieldConfirmations | undefined, field: string, value: unknown, readStartedAt: number): boolean {
  const confirmed = confirmations?.get(field);
  if (!confirmed) return false;
  return confirmed.value !== value || confirmed.at > readStartedAt;
}

type HeldEntity = 'workspace' | 'tree' | 'node';

/**
 * Note that the backend held an entity at `at` (keeps the earliest): loaded
 * from it, adopted from a read, installed, or saved with a confirmed write.
 * Never what a localStorage fallback restored: the backend may never have had it.
 */
function noteHeld(into: Map<string, number>, entity: HeldEntity, id: string, at: number): void {
  const key = `${entity}:${id}`;
  const since = into.get(key);
  if (since === undefined || at < since) into.set(key, at);
}

function noteProjectHeld(into: Map<string, number>, project: Project, at: number): void {
  noteHeld(into, 'workspace', project.id, at);
  for (const tree of project.trees) noteHeld(into, 'tree', tree.id, at);
  for (const nodeId of project.chatIds) noteHeld(into, 'node', nodeId, at);
}

export { serializedEdgeId };

/**
 * Pure accumulator: diff `cur` (and `curNodes`) against `prev` / `prevNodes`
 * and merge the changes into `existing`, returning a new delta. Called once
 * per dirty project per React render; results fold into `dirtyDeltaByProjectRef`.
 *
 * Invariant maintained after every call: no id appears in BOTH an upsert set
 * and its corresponding delete set. Each entity transition is symmetric:
 *   - added/changed  → add to upsertIds,  remove from deleteIds
 *   - removed        → add to deleteIds,   remove from upsertIds
 * This ensures that a delete-then-re-add or add-then-delete sequence across
 * ticks within one flush window always converges to the LAST observed state.
 *
 * Node removal is intentionally NOT tracked here — node removal is handled by
 * the dedicated trash/purge endpoints, not by the delta path.
 */
export function accumulateWorkspaceDirtyDelta(
  prev: Project | undefined,
  cur: Project,
  prevNodes: Record<string, ChatNodeState>,
  curNodes: Record<string, ChatNodeState>,
  existing: WorkspaceDirtyDelta,
): WorkspaceDirtyDelta {
  // Clone the existing sets so we return a new object (pure function).
  const d: WorkspaceDirtyDelta = {
    nodeIds: new Set(existing.nodeIds),
    draftNodeIds: new Set(existing.draftNodeIds),
    edgeUpsertIds: new Set(existing.edgeUpsertIds),
    edgeDeleteIds: new Set(existing.edgeDeleteIds),
    treeUpsertIds: new Set(existing.treeUpsertIds),
    treeDeleteIds: new Set(existing.treeDeleteIds),
    contextUpsertIds: new Set(existing.contextUpsertIds),
    contextDeleteIds: new Set(existing.contextDeleteIds),
    workspaceChanged: existing.workspaceChanged,
  };

  if (!prev) {
    // Brand-new project: mark every structural entity so the first command
    // batch creates the whole workspace graph.
    d.workspaceChanged = true;
    for (const nid of cur.chatIds) {
      d.nodeIds.add(nid);
    }
    for (const e of cur.edges || []) {
      const id = serializedEdgeId(e);
      d.edgeUpsertIds.add(id);
      d.edgeDeleteIds.delete(id);
    }
    for (const t of cur.trees || []) {
      d.treeUpsertIds.add(t.id);
      d.treeDeleteIds.delete(t.id);
    }
    for (const c of cur.artifacts || []) {
      d.contextUpsertIds.add(c.id);
      d.contextDeleteIds.delete(c.id);
    }
    return d;
  }

  // Compared by row value: a snapshot install brings an equal but fresh
  // folder list.
  if (prev !== cur && workspaceRowKey(prev) !== workspaceRowKey(cur)) d.workspaceChanged = true;

  // Edges: diff by serialized id, then by row value (snapshot installs and
  // re-reads bring fresh objects for edges that did not change).
  // Invariant: upsertIds ∩ deleteIds = ∅ after each branch:
  //   added/changed → upsertIds.add, deleteIds.delete
  //   removed       → deleteIds.add, upsertIds.delete
  if (prev.edges !== cur.edges) {
    const prevEdges = new Map((prev.edges || []).map((e) => [serializedEdgeId(e), e] as const));
    const curEdges = new Map((cur.edges || []).map((e) => [serializedEdgeId(e), e] as const));
    for (const [id, e] of curEdges) {
      const pe = prevEdges.get(id);
      if (!pe || (pe !== e && edgeRowKey(pe) !== edgeRowKey(e))) {
        // Added or changed — the last known state is "present": upsert wins.
        d.edgeUpsertIds.add(id);
        d.edgeDeleteIds.delete(id);
      }
    }
    for (const id of prevEdges.keys()) {
      if (!curEdges.has(id)) {
        // Removed — the last known state is "absent": delete wins.
        d.edgeDeleteIds.add(id);
        d.edgeUpsertIds.delete(id);
      }
    }
  }

  // Trees: diff by id, then by row value.
  if (prev.trees !== cur.trees) {
    const prevTrees = new Map((prev.trees || []).map((t) => [t.id, t] as const));
    const curTrees = new Map((cur.trees || []).map((t) => [t.id, t] as const));
    for (const [id, t] of curTrees) {
      const pt = prevTrees.get(id);
      if (!pt || (pt !== t && treeRowKey(pt) !== treeRowKey(t))) {
        d.treeUpsertIds.add(id);
        d.treeDeleteIds.delete(id);
      }
    }
    for (const id of prevTrees.keys()) {
      if (!curTrees.has(id)) {
        d.treeDeleteIds.add(id);
        d.treeUpsertIds.delete(id);
      }
    }
  }

  // Contexts: diff by id, then by row value.
  if (prev.artifacts !== cur.artifacts) {
    const prevCtx = new Map((prev.artifacts || []).map((c) => [c.id, c] as const));
    const curCtx = new Map((cur.artifacts || []).map((c) => [c.id, c] as const));
    for (const [id, c] of curCtx) {
      const pc = prevCtx.get(id);
      if (!pc || (pc !== c && contextRowKey(pc) !== contextRowKey(c))) {
        d.contextUpsertIds.add(id);
        d.contextDeleteIds.delete(id);
      }
    }
    for (const id of prevCtx.keys()) {
      if (!curCtx.has(id)) {
        d.contextDeleteIds.add(id);
        d.contextUpsertIds.delete(id);
      }
    }
  }

  // Nodes: attribute changes in curNodes to this project's chatIds.
  // Node removal is NOT tracked here — handled by trash/purge endpoints.
  for (const nid of cur.chatIds) {
    const curN = curNodes[nid];
    const prevN = prevNodes[nid];
    if (curN !== prevN) {
      d.nodeIds.add(nid);
    }
  }

  return d;
}

interface ScopedWriteArgs {
  baseKey: string;
  projects: Project[];
  activeProjectId: string | null;
  nodes: Record<string, ChatNodeState>;
  /** Projects whose content changed (and removed-project ids, for cleanup). */
  changedIds: Set<string>;
  /** True when the project list or activeProjectId changed (index needs a rewrite). */
  indexDirty: boolean;
}

/**
 * Write only the changed projects to per-project localStorage keys, plus a small
 * index. Invariants:
 *  - Seed-on-first-write: when no index exists yet, persist EVERY current project
 *    once (so the index never references a missing blob) and drop the legacy
 *    single-key blob. Subsequent writes are scoped to `changedIds`.
 *  - A changed id with no current project = a deleted project -> removeItem.
 *  - Each blob write is isolated; one quota failure does not abort the flush.
 *  - Blobs are written before the index within a single flush.
 */
export function writeScopedLocalStorage({
  baseKey,
  projects,
  activeProjectId,
  nodes,
  changedIds,
  indexDirty,
}: ScopedWriteArgs): void {
  if (typeof window === 'undefined') return;
  const ls = window.localStorage;
  const indexKey = stateIndexKey(baseKey);
  // If the index write below fails (e.g. quota), the next flush re-detects
  // seeding=true and retries — intentional self-healing so a partial seed is
  // always completed before delta writes begin.
  const seeding = ls.getItem(indexKey) == null;

  const remoteProjects = projects.filter(project => !isLocalProject(project));
  projects = projects.filter(isLocalProject);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  for (const project of remoteProjects) ls.removeItem(stateProjectKey(baseKey, project.id));
  // First write seeds all projects; later writes only touch changed ones.
  const idsToWrite = seeding ? new Set(projects.map((p) => p.id)) : changedIds;

  for (const pid of idsToWrite) {
    const project = projectById.get(pid);
    if (!project) {
      // Removed project — drop its blob.
      try {
        ls.removeItem(stateProjectKey(baseKey, pid));
      } catch {
        /* ignore */
      }
      continue;
    }
    const subset: Record<string, ChatNodeState> = {};
    for (const nid of project.chatIds) {
      const n = nodes[nid];
      if (n) subset[nid] = n.digest?.generation
        ? { ...n, digest: { ...n.digest, generation: undefined } }
        : n;
    }
    try {
      ls.setItem(stateProjectKey(baseKey, pid), JSON.stringify({ project, nodes: subset }));
    } catch (err) {
      // Isolated: a quota failure on one project does not abort the others.
      console.warn(`persist project blob failed (${pid}):`, err);
    }
  }

  // Rewrite the index when seeding, when the project set / active changed, or
  // when any project blob was (re)written this flush.
  // Also refresh the index whenever any blob was written, so its version stays current.
  if (seeding || indexDirty || changedIds.size > 0) {
    let diskIds: string[] = [];
    try {
      const rawPrev = ls.getItem(indexKey);
      if (rawPrev) {
        const prev = JSON.parse(rawPrev) as Partial<StateIndex>;
        if (Array.isArray(prev.projectIds)) {
          diskIds = prev.projectIds.filter((x): x is string => typeof x === 'string');
        }
      }
    } catch {
      // Malformed prior index: treat as empty and let this write reseed it.
    }

    const removedThisFlush = new Set<string>();
    for (const pid of changedIds) {
      if (!projectById.has(pid)) removedThisFlush.add(pid);
    }
    const projectIds = mergeIndexProjectIds(
      diskIds,
      projects.map((p) => p.id),
    ).filter((id) => !removedThisFlush.has(id) && !remoteEntityIdentity(id)
      && !remoteProjects.some(project => project.id === id));

    const index: StateIndex = {
      // The index carries the schema version, but per-project blobs are NOT
      // re-written on a version bump (only changed ones are). A future
      // STATE_SCHEMA_VERSION change must therefore force a full re-seed
      // (e.g. bump the key prefix) rather than rely on this field alone.
      version: STATE_SCHEMA_VERSION,
      activeProjectId: projectById.has(activeProjectId ?? '') ? activeProjectId : null,
      projectIds,
    };
    try {
      ls.setItem(indexKey, JSON.stringify(index));
    } catch (err) {
      console.warn('persist index failed:', err);
    }
  }

  // After a successful seed, reclaim the legacy single-key blob for this
  // namespace. Hydration reads via readLocalStoragePayload, so the data is
  // still reachable. LEGACY_STATE_KEY (if different) is left for the
  // legacy-shared→per-user key migration sentinel and is cleared by signOut.
  if (seeding) {
    try {
      ls.removeItem(baseKey);
    } catch {
      /* ignore */
    }
  }
}

/** The artifacts whose upserts a committed batch skipped (applyWorkspaceCommands); none from an older backend. */
interface SkippedArtifactWrites {
  goneContextIds: readonly string[];
  nameTakenContextIds: readonly string[];
}

/** Why a workspace's pending writes are not being sent right now. */
interface WorkspaceSyncState {
  /** Consecutive transient failures (network, 5xx, 408, 429, 409). */
  failures: number;
  /** Not sent again before this (Date.now()). */
  retryAt: number;
  /** When the current run of conflicts (409) began. */
  conflictSince?: number;
  /** The backend refused these writes outright: not sent until the user retries. */
  blocked?: string;
}

/** Artifacts named here and not yet written under that name, kept per workspace (noteArtifactNamed). */
const OWN_ARTIFACT_NAMES_KEPT = 500;
/** Free names one of those tries after its own was answered name-taken (keepOwnArtifactNamed). */
const OWN_ARTIFACT_RENAME_TRIES = 3;
/** Server errors a read's probe meets in the chunks carrying it before it is dropped (dropFailedProbes). */
const PROBE_SERVER_ERRORS_KEPT = 2;

/** Chromium queues at most 64 KiB of beacons per page; leave room for headers. */
const BEACON_BUDGET_BYTES = 60 * 1024;
const BEACON_COMMANDS_PER_CHUNK = 100;

/**
 * A saved connection's target and credential revision. Status updates do not
 * change it; an edit does (updatedAt covers token-only edits). Cached remote
 * copies are stamped with it.
 */
function connectionRevision(connection: BackendConnectionSummary): string {
  return JSON.stringify([
    connection.transport, connection.apiUrl, connection.sshHost, connection.sshUser,
    connection.sshPort, connection.remotePort, connection.hasToken, connection.createdAt, connection.updatedAt,
  ]);
}

/** The connection a remote entity id names, or null (local, or not an entity id). */
function remoteConnectionOf(id: string | null | undefined): string | null {
  if (!id) return null;
  try { return remoteEntityIdentity(id)?.connectionId ?? null; } catch { return null; }
}

/** Run off the boot path: cache writes clone and measure megabytes. */
function runWhenIdle(work: () => void): void {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => work(), { timeout: 2000 });
  } else {
    setTimeout(work, 0);
  }
}

/** The thread to read first for a remote workspace before its metadata answers. */
function bootTreeFor(cached: CachedRemoteConnection | null, workspaceId: string, connectionId: string): string | null {
  const viewed = cached?.activeTrees[workspaceId];
  if (viewed) return viewed;
  for (const raw of cached?.snapshot?.workspaces ?? []) {
    const row = raw as { workspace?: { id?: unknown; active_tree_id?: unknown } } | null;
    const id = typeof row?.workspace?.id === 'string' ? row.workspace.id : null;
    if (!id) continue;
    try {
      if (backendEntityId(connectionId, id) !== workspaceId) continue;
      const tree = row!.workspace!.active_tree_id;
      return typeof tree === 'string' && tree ? backendEntityId(connectionId, tree) : null;
    } catch { continue; }
  }
  // No copy: this window's pane slots name the thread when there was only one.
  const remembered = rememberedPaneTreeIds(workspaceId);
  return remembered.length === 1 ? remembered[0] : null;
}

/** How long boot waits on the (local) connection list to check a cached copy's revision. */
const CACHED_BOOT_DISCOVERY_WAIT_MS = 300;

/** `maxCommandsPerBatch` from /persistence/capabilities; older backends omit it. */
function advertisedBatchLimit(capabilities: unknown): number | undefined {
  const value = (capabilities as { maxCommandsPerBatch?: unknown } | null)?.maxCommandsPerBatch;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * What `connectionId` advertises (GET /persistence/capabilities), into the
 * window's maps: its batch size, and whether it answers skipped artifact writes.
 */
function learnCapabilities(
  batchLimits: Map<string, number>, artifactWriteAnswers: Map<string, boolean>,
  connectionId: string, capabilities: PersistenceCapabilities,
): void {
  const limit = advertisedBatchLimit(capabilities);
  if (limit !== undefined) batchLimits.set(connectionId, limit);
  artifactWriteAnswers.set(connectionId, supportsArtifactWriteAnswers(capabilities));
}

/**
 * Read `connectionId`'s capabilities, one read at a time (`reads`), and
 * `learn` them; undefined when it did not answer. A read dropped from
 * `reads` while in flight (the window forgot the connection's capabilities)
 * is not learned: it may be of the backend that was there before.
 */
function readCapabilities(
  reads: Map<string, Promise<PersistenceCapabilities | undefined>>, connectionId: string,
  learn: (capabilities: PersistenceCapabilities) => void,
): Promise<PersistenceCapabilities | undefined> {
  const asking = reads.get(connectionId);
  if (asking) return asking;
  const ask = async (): Promise<PersistenceCapabilities | undefined> => {
    try {
      return await fetchPersistenceCapabilities(connectionId, { configureTransport: false });
    } catch {
      return undefined;
    }
  };
  const read = ask().then((capabilities) => {
    if (reads.get(connectionId) === read) {
      reads.delete(connectionId);
      if (capabilities) learn(capabilities);
    }
    return capabilities;
  });
  reads.set(connectionId, read);
  return read;
}

function serializedComposerDraft(node: ChatNodeState): string | null {
  return node.composerDraft ? JSON.stringify(node.composerDraft) : null;
}

interface UseWorkspacePersistenceArgs {
  projects: Project[];
  activeProjectId: string | null;
  nodes: Record<string, ChatNodeState>;
  /** Monotonic structural channel version; high-frequency stream events keep it stable. */
  structureVersion: number;
  hydrated: boolean;
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setActiveProjectId: Dispatch<SetStateAction<string | null>>;
  setNodes: Dispatch<SetStateAction<Record<string, ChatNodeState>>>;
  setHydrated: Dispatch<SetStateAction<boolean>>;
  /** Authenticated user ID used to locate a pre-v2 localStorage migration payload. */
  userId?: string;
  /** Stable per-window id used to resolve activeProjectId during async hydration. */
  windowId?: string;
  /**
   * Held true by destructive async actions while they await a backend purge
   * endpoint. The 2s command flush inspects this so structural commands do not
   * race the explicit DELETE.
   * Optional for backwards compat with tests that mount the hook directly.
   */
  syncPausedRef?: MutableRefObject<boolean>;
  /** Draft edits bypass the structural channel; dispatch records changed node IDs here. */
  dirtyDraftNodeIdsRef?: MutableRefObject<Set<string>>;
  /** The provider's tree read pool: boot hands it the visible remote thread's read. Stable. */
  treeMessageRequests?: TreeMessageRequests;
  /** Where remote copies are kept: IndexedDB by default where available; null keeps none. */
  remoteSnapshotCache?: RemoteSnapshotCache | null;
}

export function useWorkspacePersistence({
  projects,
  activeProjectId,
  nodes,
  structureVersion,
  hydrated,
  nodesRef,
  setProjects,
  setActiveProjectId,
  setNodes,
  setHydrated,
  userId,
  windowId,
  syncPausedRef,
  dirtyDraftNodeIdsRef,
  treeMessageRequests,
  remoteSnapshotCache,
}: UseWorkspacePersistenceArgs) {
  // Compute the localStorage key used only for one-time migration and cleanup.
  const storageKey = userId ? buildStateKey(userId) : LEGACY_STATE_KEY;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  const remoteCacheRef = useRef<RemoteSnapshotCache | null>(null);
  remoteCacheRef.current = remoteSnapshotCache === undefined ? defaultRemoteSnapshotCache() : remoteSnapshotCache;
  const treeRequestsRef = useRef(treeMessageRequests);
  treeRequestsRef.current = treeMessageRequests;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  // The saved revision of each remote connection hydration knows (cache stamps).
  const connectionRevisionsRef = useRef(new Map<string, string>());
  const resolveActiveProjectForWindow = (legacy: string | null): string | null =>
    windowId ? readActiveProjectId(storageKeyRef.current, windowId, legacy) : legacy;

  // One-shot migration: if the legacy shared key has data and the per-user key
  // does not, copy the legacy data into the per-user slot (idempotent — guard
  // prevents repeated copies). Then record michi:migrated = '1' so that
  // signOutAndReset() knows to clean it up on the next sign-out.
  useEffect(() => {
    if (!userId) return;
    const perUserKey = buildStateKey(userId);
    const alreadyMigrated = window.localStorage.getItem(MIGRATED_KEY) === '1';
    if (alreadyMigrated) return;
    const legacyRaw = window.localStorage.getItem(LEGACY_STATE_KEY);
    const perUserRaw = window.localStorage.getItem(perUserKey);
    if (legacyRaw && !perUserRaw) {
      try {
        window.localStorage.setItem(perUserKey, legacyRaw);
        window.localStorage.setItem(MIGRATED_KEY, '1');
      } catch {
        // Quota error or private browsing — silently skip.
      }
    }
  }, [userId]);
  const projectsRef = useRef(projects);
  const activeProjectIdRef = useRef(activeProjectId);
  const hydratedRef = useRef(hydrated);
  const dirtyRef = useRef(false);
  const dirtyProjectIdsRef = useRef(new Set<string>());
  // Entity-granular pending delta per dirty project, accumulated across ticks
  // and drained by explicit command batches.
  const dirtyDeltaByProjectRef = useRef(new Map<string, WorkspaceDirtyDelta>());
  // What this window changed and the backend has not committed yet, per
  // workspace. Committed chunks leave it (see sendCommandBatch).
  const pendingCommandDeltaByProjectRef = useRef(new Map<string, WorkspaceDirtyDelta>());
  // Per workspace: why its last write failed and when to try again.
  const syncStateRef = useRef(new Map<string, WorkspaceSyncState>());
  // The chunk last sent per workspace: resending the same chunk reuses its
  // operation id, so one the backend committed without answering is not applied twice.
  const lastSentRef = useRef(new Map<string, { operationId: string; body: string }>());
  // Per connection: the batch size it advertises (capabilities) and one it
  // refused, and the connections whose capabilities were asked for (batchLimitFor).
  const advertisedBatchLimitRef = useRef(new Map<string, number>());
  const learnedBatchLimitRef = useRef(new Map<string, number>());
  const batchLimitProbesRef = useRef(new Set<string>());
  // Per connection: whether it answers the artifact writes it skips
  // (capabilities artifactWriteAnswers), and a read of its capabilities in flight.
  const artifactWriteAnswersRef = useRef(new Map<string, boolean>());
  const capabilityReadsRef = useRef(new Map<string, Promise<PersistenceCapabilities | undefined>>());
  // Workspaces whose notice this hook raised (its actions close over this hook).
  const raisedNoticesRef = useRef(new Set<string>());
  const nodeCommandProjectionRef = useRef(new Map<string, string>());
  // The view mark the backend holds per node, so a focus change writes only a newer one.
  const nodeViewedAtRef = useRef(new Map<string, number>());
  // Likewise the seen completion count it holds (backends with completion facts).
  const nodeSeenCompletionRef = useRef(new Map<string, number>());
  const workspaceSyncQueueRef = useRef<WorkspaceSyncQueue | null>(null);
  if (!workspaceSyncQueueRef.current) {
    workspaceSyncQueueRef.current = new WorkspaceSyncQueue((err, projectId) => {
      console.warn(`workspace persistence queue task failed (${projectId}):`, err);
      dirtyRef.current = true;
    });
  }
  // Guards against scheduling multiple idle flushes before the first one runs.
  const idleScheduledRef = useRef(false);
  const justHydratedRef = useRef(false);
  const prevProjectsRef = useRef<Project[]>(projects);
  const prevNodesRef = useRef<Record<string, ChatNodeState>>(nodes);
  // Backend snapshots installed since the last dirty scan (see noteBackendInstalled).
  const backendInstalledRef = useRef(new Map<string, { installed: BackendInstalledEntities; misses: number }>());
  // Tree/edge/artifact deletes the backend confirmed, per workspace (id → when this window heard).
  const confirmedDeletesRef = useRef(new Map<string, { trees: Map<string, number>; edges: Map<string, number>; contexts: Map<string, number> }>());
  const noteConfirmedDeletes = useCallback((projectId: string, delta: WorkspaceDirtyDelta) => {
    if (delta.treeDeleteIds.size === 0 && delta.edgeDeleteIds.size === 0 && delta.contextDeleteIds.size === 0) return;
    const at = Date.now();
    const confirmed = confirmedDeletesRef.current.get(projectId)
      ?? { trees: new Map<string, number>(), edges: new Map<string, number>(), contexts: new Map<string, number>() };
    for (const id of delta.treeDeleteIds) rememberConfirmedDelete(confirmed.trees, id, at);
    for (const id of delta.edgeDeleteIds) rememberConfirmedDelete(confirmed.edges, id, at);
    for (const id of delta.contextDeleteIds) rememberConfirmedDelete(confirmed.contexts, id, at);
    confirmedDeletesRef.current.set(projectId, confirmed);
  }, []);
  // Artifacts the backend answered gone (goneContextIds), per workspace (id →
  // when this window heard): deleted there, so this window drops them and
  // never has a delete of them to send.
  const goneContextsRef = useRef(new Map<string, Map<string, number>>());
  // A read's probes (probeArtifacts), per workspace: artifacts whose next
  // upsert asks the backend whether they are its (id → the artifact as asked
  // about, and the server errors its chunks met, dropFailedProbes), and
  // every one asked in this window (id → when), which is never asked again.
  const artifactProbesRef = useRef(new Map<string, Map<string, { row: string; serverErrors: number }>>());
  const probedArtifactsRef = useRef(new Map<string, Map<string, number>>());
  // Probes answered name-taken, per workspace: dropped from the store as not
  // the backend's, with no delete of them to send while they stay away.
  const probeDroppedContextsRef = useRef(new Map<string, Map<string, number>>());
  /** `delta` (mutated) without deletes of artifacts the backend answered gone, or a probe answered not its. */
  const dropGoneContextDeletes = (projectId: string, delta: WorkspaceDirtyDelta): void => {
    for (const id of goneContextsRef.current.get(projectId)?.keys() ?? []) delta.contextDeleteIds.delete(id);
    for (const id of probeDroppedContextsRef.current.get(projectId)?.keys() ?? []) delta.contextDeleteIds.delete(id);
  };
  // Artifacts this window made or renamed and the backend has not yet written
  // under that name, per workspace: id → the name given here (null: made
  // here, under the name the reducer gave it). See keepOwnArtifactNamed.
  const ownArtifactNamesRef = useRef(new Map<string, Map<string, string | null>>());
  // Per workspace, the free names tried for one of those (keepOwnArtifactNamed).
  const ownArtifactRenamesRef = useRef(new Map<string, Map<string, { base: string; nextSuffix: number; tries: number }>>());
  /** This window made an artifact (`name` null) or renamed it to `name` (contextActions). */
  const noteArtifactNamed = useCallback((projectId: string, contextId: string, name: string | null) => {
    const named = ownArtifactNamesRef.current.get(projectId) ?? new Map<string, string | null>();
    named.delete(contextId);
    named.set(contextId, name);
    for (const id of named.keys()) {
      if (named.size <= OWN_ARTIFACT_NAMES_KEPT) break;
      named.delete(id);
    }
    ownArtifactNamesRef.current.set(projectId, named);
    // A name the user gives starts the count of free names over.
    ownArtifactRenamesRef.current.get(projectId)?.delete(contextId);
    // And its next write is the user's, no read's probe.
    artifactProbesRef.current.get(projectId)?.delete(contextId);
  }, []);
  // Structure re-reads (structureSync) waiting for the scan that renders them.
  const structureAdoptionsRef = useRef<Array<{ adoption: StructureAdoption; misses: number }>>([]);
  // What the backend last confirmed per workspace / tree field (see confirmFields).
  const confirmedWorkspaceFieldsRef = useRef(new Map<string, FieldConfirmations>());
  const confirmedTreeFieldsRef = useRef(new Map<string, FieldConfirmations>());
  // When each node's command projection was confirmed.
  const nodeProjectionAtRef = useRef(new Map<string, number>());
  // The title the backend last confirmed per node, and when: the projection
  // carries a title only once this window has one to save (titleNeedsPersistence).
  const confirmedNodeTitlesRef = useRef(new Map<string, { value: unknown; at: number }>());
  // When this window first knew the backend held each workspace, tree and
  // node (see noteHeld): a complete re-read may remove only those.
  const heldSinceRef = useRef(new Map<string, number>());
  // Edge upserts the backend confirmed, per workspace (id → when).
  const confirmedEdgeUpsertsRef = useRef(new Map<string, Map<string, number>>());
  /** A command batch landed: what it wrote is what the backend now holds. */
  const noteConfirmedWrites = useCallback((
    projectId: string,
    commands: readonly WorkspaceCommand[],
    delta: WorkspaceDirtyDelta,
    nodeProjectionUpdates: ReadonlyMap<string, string>,
  ) => {
    const at = Date.now();
    for (const command of commands) {
      const id = command.payload.id;
      if (typeof id !== 'string') continue;
      if (command.type === 'workspace.upsert') {
        confirmFields(confirmedWorkspaceFieldsRef.current, id, command.payload, WORKSPACE_GUARD_FIELDS, at);
        noteHeld(heldSinceRef.current, 'workspace', id, at);
      } else if (command.type === 'tree.upsert') {
        confirmFields(confirmedTreeFieldsRef.current, id, command.payload, TREE_GUARD_FIELDS, at);
        noteHeld(heldSinceRef.current, 'tree', id, at);
      } else if (command.type === 'node.upsert') {
        // (A patch alone proves nothing: a view mark for a missing node is ignored.)
        noteHeld(heldSinceRef.current, 'node', id, at);
      } else if (command.type === 'node.patch' && 'title' in command.payload) {
        confirmedNodeTitlesRef.current.set(id, { value: command.payload.title ?? null, at });
      }
    }
    for (const nodeId of nodeProjectionUpdates.keys()) nodeProjectionAtRef.current.set(nodeId, at);
    if (delta.edgeUpsertIds.size > 0) {
      // Bounded the same way as confirmed deletes.
      const edges = confirmedEdgeUpsertsRef.current.get(projectId) ?? new Map<string, number>();
      for (const edgeId of delta.edgeUpsertIds) rememberConfirmedDelete(edges, edgeId, at);
      confirmedEdgeUpsertsRef.current.set(projectId, edges);
    }
  }, []);
  /** The rendered workspace's rows as the backend holds them (hydration, installs). */
  const confirmProjectRows = (project: Project, at: number, treeIds?: readonly string[]) => {
    if (!treeIds) confirmFields(confirmedWorkspaceFieldsRef.current, project.id, serializeWorkspaceRow(project), WORKSPACE_GUARD_FIELDS, at);
    for (const tree of project.trees) {
      if (treeIds && !treeIds.includes(tree.id)) continue;
      confirmFields(confirmedTreeFieldsRef.current, tree.id, serializeTreeRow(project, tree), TREE_GUARD_FIELDS, at);
    }
  };
  /** A node row the backend holds as rendered: what the flush compares with, and its title, view and seen marks. */
  const noteNodeBaseline = (project: Project, nodes: Record<string, ChatNodeState>, nodeId: string, at: number) => {
    const row = serializeNodeRow(project, nodes, nodeId);
    if (!row) return;
    nodeCommandProjectionRef.current.set(nodeId, JSON.stringify(nodeCommandPatch(row, nodes[nodeId], windowId)));
    nodeProjectionAtRef.current.set(nodeId, at);
    confirmedNodeTitlesRef.current.set(nodeId, { value: row.title, at });
    noteDurableViewedAt(nodeViewedAtRef.current, nodeId, nodes[nodeId]);
    noteDurableSeenCompletion(nodeSeenCompletionRef.current, nodeId, nodes[nodeId]);
  };
  /**
   * A rendered adoption holds the backend's values for exactly the fields it
   * took: confirm those (and only those, so a guarded local edit stays an
   * edit), and fold them into the node projections the flush compares with.
   */
  const noteAdoptionLanded = (cur: Project, adoption: StructureAdoption, landed: AdoptionRebase['landed']) => {
    const at = adoption.readStartedAt;
    // The read (or the backend's own move) that brought it held all of this.
    noteHeld(heldSinceRef.current, 'workspace', cur.id, at);
    const workspaceColumns = landed.workspaceFields.flatMap((field) => WORKSPACE_FIELD_COLUMNS.get(field) ?? []);
    if (workspaceColumns.length > 0) {
      confirmFields(confirmedWorkspaceFieldsRef.current, cur.id, serializeWorkspaceRow(cur), workspaceColumns, at);
    }
    for (const { tree, fields, isNew } of landed.trees) {
      noteHeld(heldSinceRef.current, 'tree', tree.id, at);
      const columns = isNew ? TREE_GUARD_FIELDS : fields.flatMap((field) => TREE_FIELD_COLUMNS.get(field) ?? []);
      confirmFields(confirmedTreeFieldsRef.current, tree.id, serializeTreeRow(cur, tree), columns, at);
    }
    for (const { node, fields, isNew } of landed.nodes) {
      noteHeld(heldSinceRef.current, 'node', node.nodeId, at);
      const known = nodeCommandProjectionRef.current.get(node.nodeId);
      const projectionAt = Math.max(nodeProjectionAtRef.current.get(node.nodeId) ?? 0, at);
      if (isNew || !known) {
        noteNodeBaseline(cur, { [node.nodeId]: node }, node.nodeId, at);
      } else {
        const row = serializeNodeRow(cur, { [node.nodeId]: node }, node.nodeId);
        if (!row) continue;
        if (fields.includes('title')) confirmedNodeTitlesRef.current.set(node.nodeId, { value: row.title, at });
        const projection = JSON.parse(known) as Record<string, unknown>;
        const columns = new Set<string>(['tree_id', ...fields.flatMap((field) => NODE_FIELD_COLUMNS.get(field) ?? [])]);
        for (const column of columns) {
          if (column in projection && (NODE_STRUCTURE_COLUMNS as readonly string[]).includes(column)) {
            projection[column] = (row as Record<string, unknown>)[column];
          }
        }
        nodeCommandProjectionRef.current.set(node.nodeId, JSON.stringify(projection));
      }
      nodeProjectionAtRef.current.set(node.nodeId, projectionAt);
    }
  };
  projectsRef.current = projects;
  activeProjectIdRef.current = activeProjectId;
  hydratedRef.current = hydrated;

  // Mark dirty only at structural cadence (and when projects themselves
  // change). `nodes` still refreshes every streamed render, but the structural
  // version deliberately stays fixed for chunk/thought/heartbeat/tool progress
  // actions, so those frames never enter this workspace-wide scan.
  // Skip the first render after hydration to avoid writing back the state
  // that was just loaded from the backend.
  // Tracks which specific projects changed so the interval only syncs those.
  useEffect(() => {
    if (!hydrated) return;
    if (!justHydratedRef.current) {
      justHydratedRef.current = true;
      // The loaded state is the clean baseline, snapshots installed before it included.
      backendInstalledRef.current.clear();
      prevProjectsRef.current = projects;
      prevNodesRef.current = nodes;
      for (const project of projects) {
        confirmProjectRows(project, 0);
        for (const nodeId of project.chatIds) noteNodeBaseline(project, nodes, nodeId, 0);
      }
      return;
    }
    // Structure re-reads already durable on the backend: rebase the baseline
    // onto what this render shows of them, so only later local edits remain.
    if (structureAdoptionsRef.current.length > 0) {
      const waiting: typeof structureAdoptionsRef.current = [];
      for (const entry of structureAdoptionsRef.current) {
        const { adoption } = entry;
        const prevProject = prevProjectsRef.current.find((p) => p.id === adoption.projectId);
        const cur = projects.find((p) => p.id === adoption.projectId);
        const rebase = rebaseOnAdoption(prevProject, prevNodesRef.current, cur, nodes, adoption);
        if (rebase.prevProject && rebase.prevProject !== prevProject) {
          prevProjectsRef.current = prevProject
            ? prevProjectsRef.current.map((p) => (p === prevProject ? rebase.prevProject! : p))
            : [...prevProjectsRef.current, rebase.prevProject];
        }
        prevNodesRef.current = rebase.prevNodes;
        if (cur) noteAdoptionLanded(cur, adoption, rebase.landed);
        if (rebase.remaining && ++entry.misses <= BACKEND_INSTALL_MAX_MISSES) {
          waiting.push({ adoption: rebase.remaining, misses: entry.misses });
        }
      }
      structureAdoptionsRef.current = waiting;
    }
    // Detect which projects changed (content), were added, or were removed.
    // For each dirty project, accumulate entity-granular delta via the pure
    // accumulateWorkspaceDirtyDelta helper (which owns the symmetric upsert/
    // delete invariant and the node-diff logic).
    const changed = new Set<string>();
    const prevProjectById = new Map(prevProjectsRef.current.map((pp) => [pp.id, pp] as const));

    for (const p of projects) {
      const prev = prevProjectById.get(p.id);
      if (!prev) {
        changed.add(p.id);
      } else if (prev !== p) {
        changed.add(p.id); // content changed
      }
      // Accumulate entity-granular delta for every project that is new or
      // changed (accumulateWorkspaceDirtyDelta is a no-op when prev===cur for
      // all fields, so calling it on unchanged projects is safe but skipped
      // here for efficiency via the `changed` guard).
      if (changed.has(p.id)) {
        const existing = dirtyDeltaByProjectRef.current.get(p.id) ?? emptyWorkspaceDirtyDelta();
        dirtyDeltaByProjectRef.current.set(
          p.id,
          accumulateWorkspaceDirtyDelta(prev, p, prevNodesRef.current, nodes, existing),
        );
      }
    }
    for (const pp of prevProjectsRef.current) {
      if (!projects.find((p) => p.id === pp.id)) {
        changed.add(pp.id);
        // Whole project removed. We do NOT attempt entity-level deletes here —
        // workspace deletion goes through dedicated DELETE endpoints. Drop any
        // pending commands for it so we don't write a gone project.
        dirtyDeltaByProjectRef.current.delete(pp.id);
        syncStateRef.current.delete(pp.id);
        goneContextsRef.current.delete(pp.id);
        ownArtifactNamesRef.current.delete(pp.id);
        ownArtifactRenamesRef.current.delete(pp.id);
        artifactProbesRef.current.delete(pp.id);
        probedArtifactsRef.current.delete(pp.id);
        probeDroppedContextsRef.current.delete(pp.id);
        if (raisedNoticesRef.current.delete(pp.id)) clearWorkspaceSyncNotice(pp.id);
      }
    }
    // Node changes that didn't cause a project-reference change (nodes is
    // separate from projects in the state shape). For those projects not yet
    // in `changed`, check if any of their nodes changed and accumulate.
    if (nodes !== prevNodesRef.current) {
      for (const p of projects) {
        if (changed.has(p.id)) continue; // already accumulated above
        let nodeTouched = false;
        for (const nid of p.chatIds) {
          if (nodes[nid] !== prevNodesRef.current[nid]) { nodeTouched = true; break; }
        }
        if (nodeTouched) {
          changed.add(p.id);
          const existing = dirtyDeltaByProjectRef.current.get(p.id) ?? emptyWorkspaceDirtyDelta();
          dirtyDeltaByProjectRef.current.set(
            p.id,
            accumulateWorkspaceDirtyDelta(p, p, prevNodesRef.current, nodes, existing),
          );
        }
      }
    }
    // What a backend snapshot brought in is already durable: it joins the
    // baseline like hydrated state (node projections included) instead of
    // being written back.
    // An install noted after this render's commit (its effects can run
    // later) isn't in `projects` yet: it waits for the scan that sees it.
    for (const [projectId, entry] of backendInstalledRef.current) {
      const { installed } = entry;
      const project = projects.find((p) => p.id === projectId);
      if (!project || !backendInstallLanded(project, installed)) {
        entry.misses += 1;
        if (entry.misses > BACKEND_INSTALL_MAX_MISSES) backendInstalledRef.current.delete(projectId);
        continue;
      }
      backendInstalledRef.current.delete(projectId);
      const installedAt = Date.now();
      if (installed.newProject) noteHeld(heldSinceRef.current, 'workspace', projectId, installedAt);
      for (const treeId of installed.treeIds) noteHeld(heldSinceRef.current, 'tree', treeId, installedAt);
      for (const nodeId of installed.nodeIds) {
        noteHeld(heldSinceRef.current, 'node', nodeId, installedAt);
        noteNodeBaseline(project, nodes, nodeId, installedAt);
      }
      confirmProjectRows(project, installedAt, installed.newProject ? undefined : installed.treeIds);
      const delta = dirtyDeltaByProjectRef.current.get(projectId);
      if (!delta) continue;
      // New to the store only if the last scan didn't hold it either: once
      // a scan has, its delta can carry local edits, and only the installed
      // ids leave it.
      const newProject = installed.newProject && !prevProjectById.has(projectId);
      const rest = withoutBackendInstalled(delta, { ...installed, newProject });
      if (rest) {
        dirtyDeltaByProjectRef.current.set(projectId, rest);
      } else {
        dirtyDeltaByProjectRef.current.delete(projectId);
        dirtyProjectIdsRef.current.delete(projectId);
        changed.delete(projectId);
      }
    }
    // A probe no longer in the store has nothing to ask; one dropped as not the
    // backend's that is back (a read or a report brought it) is an artifact
    // like any other again, which can be deleted.
    const heldArtifactIds = (projectId: string) =>
      new Set((projects.find((p) => p.id === projectId)?.artifacts ?? []).map((artifact) => artifact.id));
    for (const [projectId, ids] of artifactProbesRef.current) {
      const held = heldArtifactIds(projectId);
      for (const id of ids.keys()) if (!held.has(id)) ids.delete(id);
    }
    for (const [projectId, ids] of probeDroppedContextsRef.current) {
      const held = heldArtifactIds(projectId);
      for (const id of ids.keys()) if (held.has(id)) ids.delete(id);
    }
    // An artifact the backend answered gone left the store (dropGoneArtifacts),
    // and so did a probe answered not the backend's (dropProbedArtifacts):
    // there is nothing of either to delete there.
    for (const projectId of new Set([...goneContextsRef.current.keys(), ...probeDroppedContextsRef.current.keys()])) {
      const delta = dirtyDeltaByProjectRef.current.get(projectId);
      if (!delta) continue;
      dropGoneContextDeletes(projectId, delta);
      if (deltaIsEmpty(delta)) {
        dirtyDeltaByProjectRef.current.delete(projectId);
        dirtyProjectIdsRef.current.delete(projectId);
        changed.delete(projectId);
      }
    }
    if (changed.size > 0) {
      dirtyRef.current = true;
      for (const id of Array.from(changed)) dirtyProjectIdsRef.current.add(id);
    }
    prevProjectsRef.current = projects;
    prevNodesRef.current = nodes;
  }, [projects, structureVersion, hydrated]); // eslint-disable-line react-hooks/exhaustive-deps -- nodes are read at the structural boundary; the hydration transition initializes the clean baseline before the first workspace is created

  const collectDirtyDrafts = () => {
    for (const nodeId of dirtyDraftNodeIdsRef?.current ?? []) {
      const node = nodesRef.current[nodeId];
      if (!node || !projectsRef.current.some((project) => project.id === node.projectId && project.chatIds.includes(nodeId))) continue;
      const delta = dirtyDeltaByProjectRef.current.get(node.projectId) ?? emptyWorkspaceDirtyDelta();
      delta.draftNodeIds.add(nodeId);
      dirtyDeltaByProjectRef.current.set(node.projectId, delta);
      dirtyProjectIdsRef.current.add(node.projectId);
      dirtyRef.current = true;
    }
    dirtyDraftNodeIdsRef?.current.clear();
  };

  /**
   * What `connectionId` advertised may no longer hold: it was removed, or its
   * backend may have been replaced (an older build, another checkout, a
   * revert): its feed came back after a disconnect (noteConnectionRecovered),
   * or it failed a probe like an older backend (dropFailedProbes). Whether it
   * answers skipped artifact writes is asked again before the next probe, and
   * its batch size with its next write (batchLimitFor); a read in flight is
   * not learned. A removed one also forgets the sizes it advertised and refused.
   */
  const forgetCapabilities = (connectionId: string, removed = false): void => {
    artifactWriteAnswersRef.current.delete(connectionId);
    capabilityReadsRef.current.delete(connectionId);
    batchLimitProbesRef.current.delete(connectionId);
    if (!removed) return;
    advertisedBatchLimitRef.current.delete(connectionId);
    learnedBatchLimitRef.current.delete(connectionId);
  };

  /** The background feed of `connectionId` came back after a disconnect: another backend may answer there now. */
  const noteConnectionRecovered = useCallback((connectionId: string): void => {
    forgetCapabilities(connectionId);
  }, []);

  /** The batch size for `connectionId`: what it advertises or last refused, else the default. */
  const batchLimitFor = (connectionId: string, probe = true): number => {
    if (probe && !batchLimitProbesRef.current.has(connectionId)) {
      // Hydration reads the local backend's; a remote's are read when first
      // written, and any connection's again after forgetCapabilities.
      batchLimitProbesRef.current.add(connectionId);
      void readCapabilities(capabilityReadsRef.current, connectionId, (capabilities) =>
        learnCapabilities(advertisedBatchLimitRef.current, artifactWriteAnswersRef.current, connectionId, capabilities));
    }
    return Math.min(
      advertisedBatchLimitRef.current.get(connectionId) ?? DEFAULT_MAX_COMMANDS_PER_BATCH,
      learnedBatchLimitRef.current.get(connectionId) ?? Number.POSITIVE_INFINITY,
    );
  };

  /**
   * Whether `connectionId`'s backend answers the artifact writes it skips
   * (capabilities artifactWriteAnswers), asking it when not yet known. An
   * older backend omits the field: false. An unanswered question is false
   * now and asked again next time.
   */
  const whenArtifactWriteAnswers = (connectionId: string): Promise<boolean> => {
    const known = artifactWriteAnswersRef.current.get(connectionId);
    if (known !== undefined) return Promise.resolve(known);
    return readCapabilities(capabilityReadsRef.current, connectionId, (capabilities) =>
      learnCapabilities(advertisedBatchLimitRef.current, artifactWriteAnswersRef.current, connectionId, capabilities))
      .then(() => artifactWriteAnswersRef.current.get(connectionId) === true);
  };

  /**
   * Ask the backend about artifacts a background read kept beside one of its
   * own under the same name (backgroundGapReconcile mergeContexts): only this
   * window holds them, so each is stale there (deleted, or renamed and its
   * name taken since) or live and written after the read began. The window
   * sends each one's upsert once, as it holds it; the answer decides
   * (commitChunk): gone drops it (no delete), name-taken drops it without a
   * delete either (it is not the backend's: nothing of it is deleted or
   * tombstoned, and it is never renamed), written keeps it (it was live).
   *
   * Never asked: this window's own unsaved write of it (dirty, pending, made
   * or renamed here, changed since the last scan), one already asked in this
   * window, or any against a backend that does not advertise
   * artifactWriteAnswers: an older one fails a write under a taken name with
   * a 500 retried forever, holding up the workspace's every write.
   */
  const probeArtifacts = useCallback((projectId: string, contextIds: readonly string[]): void => {
    if (contextIds.length === 0) return;
    const project = projectsRef.current.find((candidate) => candidate.id === projectId);
    if (!project) return;
    const connectionId = projectConnectionId(project);
    if (artifactWriteAnswersRef.current.get(connectionId) !== true) {
      if (artifactWriteAnswersRef.current.get(connectionId) === undefined) {
        void whenArtifactWriteAnswers(connectionId).then((supported) => { if (supported) probeArtifacts(projectId, contextIds); });
      }
      return;
    }
    const scanned = new Map((prevProjectsRef.current.find((candidate) => candidate.id === projectId)?.artifacts ?? [])
      .map((artifact) => [artifact.id, artifact] as const));
    const current = new Map((project.artifacts ?? []).map((artifact) => [artifact.id, artifact] as const));
    const dirty = dirtyDeltaByProjectRef.current.get(projectId);
    const pending = pendingCommandDeltaByProjectRef.current.get(projectId);
    const named = ownArtifactNamesRef.current.get(projectId);
    const asked = probedArtifactsRef.current.get(projectId) ?? new Map<string, number>();
    const at = Date.now();
    const probes: string[] = [];
    for (const id of new Set(contextIds)) {
      const artifact = current.get(id);
      const was = scanned.get(id);
      if (!artifact || asked.has(id) || named?.has(id)
        || dirty?.contextUpsertIds.has(id) || dirty?.contextDeleteIds.has(id)
        || pending?.contextUpsertIds.has(id) || pending?.contextDeleteIds.has(id)
        || !was || (was !== artifact && contextRowKey(was) !== contextRowKey(artifact))) continue;
      probes.push(id);
    }
    if (probes.length === 0) return;
    const asking = artifactProbesRef.current.get(projectId) ?? new Map<string, { row: string; serverErrors: number }>();
    for (const id of probes) {
      rememberConfirmedDelete(asked, id, at);
      rememberConfirmedDelete(asking, id, { row: contextRowKey(current.get(id)!), serverErrors: 0 });
    }
    probedArtifactsRef.current.set(projectId, asked);
    artifactProbesRef.current.set(projectId, asking);
    const delta = dirty ?? emptyWorkspaceDirtyDelta();
    for (const id of probes) delta.contextUpsertIds.add(id);
    dirtyDeltaByProjectRef.current.set(projectId, delta);
    dirtyProjectIdsRef.current.add(projectId);
    dirtyRef.current = true;
  }, []);

  /**
   * Probes the backend answered name-taken: its artifact under that name is
   * another one, and these have no row there. The store drops them, sending
   * no delete (dropGoneContextDeletes, until one comes back).
   */
  const dropProbedArtifacts = (projectId: string, dropped: ReadonlySet<string>) => {
    const at = Date.now();
    const known = probeDroppedContextsRef.current.get(projectId) ?? new Map<string, number>();
    for (const id of dropped) rememberConfirmedDelete(known, id, at);
    probeDroppedContextsRef.current.set(projectId, known);
    setProjects((prev) => {
      let changed = false;
      const next = prev.map((project) => {
        if (project.id !== projectId || !project.artifacts?.some((artifact) => dropped.has(artifact.id))) return project;
        changed = true;
        return { ...project, artifacts: project.artifacts.filter((artifact) => !dropped.has(artifact.id)) };
      });
      return changed ? next : prev;
    });
  };

  /**
   * The backend skipped these artifacts' upserts: they were deleted (by a
   * window or an agent this one did not hear from). The store drops them, as
   * artifact_deleted would, instead of showing an artifact that is gone.
   */
  const dropGoneArtifacts = (projectId: string, gone: ReadonlySet<string>) => {
    const at = Date.now();
    const known = goneContextsRef.current.get(projectId) ?? new Map<string, number>();
    for (const id of gone) rememberConfirmedDelete(known, id, at);
    goneContextsRef.current.set(projectId, known);
    setProjects((prev) => {
      let dropped = false;
      const next = prev.map((project) => {
        if (project.id !== projectId || !project.artifacts?.some((artifact) => gone.has(artifact.id))) return project;
        dropped = true;
        return { ...project, artifacts: project.artifacts.filter((artifact) => !gone.has(artifact.id)) };
      });
      return dropped ? next : prev;
    });
  };

  /**
   * The backend answered name-taken for this window's own write of a name:
   * an artifact made or renamed here (noteArtifactNamed), not yet written
   * under it, whose name another window or an agent this one does not hear
   * took there. Left as it is, the artifact would show here and never be
   * saved. It takes the next free name by the rule a new artifact here takes
   * ("notes-2", chatReducers.ts), and the scan writes it again; after
   * OWN_ARTIFACT_RENAME_TRIES such names it stays as it is. False when the
   * write was not of a name given here (a stale copy of an artifact, or a
   * read's probe): that one is not renamed.
   */
  const keepOwnArtifactNamed = (projectId: string, id: string, sentName: string | undefined): boolean => {
    const named = ownArtifactNamesRef.current.get(projectId);
    if (sentName === undefined || !named?.has(id)) return false;
    const own = named.get(id);
    if (own !== null && own !== sentName) return false;
    const project = projectsRef.current.find((candidate) => candidate.id === projectId);
    const artifacts = project?.artifacts ?? [];
    // Changed since that write was built: the newer write goes as it is.
    if (artifacts.find((artifact) => artifact.id === id)?.name !== sentName) return true;
    const renames = ownArtifactRenamesRef.current.get(projectId) ?? new Map<string, { base: string; nextSuffix: number; tries: number }>();
    ownArtifactRenamesRef.current.set(projectId, renames);
    const attempt = renames.get(id) ?? { base: sentName, nextSuffix: 2, tries: 0 };
    if (attempt.tries >= OWN_ARTIFACT_RENAME_TRIES) {
      console.warn(`workspace ${projectId}: an artifact made or renamed here is not saved: its name and ${attempt.tries} free ones are other artifacts' there`);
      return true;
    }
    const taken = new Set(artifacts.filter((artifact) => artifact.id !== id).map((artifact) => artifact.name.toLowerCase()));
    let suffix = attempt.nextSuffix;
    while (taken.has(`${attempt.base}-${suffix}`.toLowerCase())) suffix += 1;
    const name = `${attempt.base}-${suffix}`;
    renames.set(id, { base: attempt.base, nextSuffix: suffix + 1, tries: attempt.tries + 1 });
    named.set(id, name);
    const at = Date.now();
    setProjects((prev) => {
      let renamed = false;
      const next = prev.map((candidate) => {
        if (candidate.id !== projectId) return candidate;
        const current = candidate.artifacts ?? [];
        if (current.find((artifact) => artifact.id === id)?.name !== sentName
          || current.some((artifact) => artifact.id !== id && artifact.name.toLowerCase() === name.toLowerCase())) return candidate;
        renamed = true;
        return { ...candidate, artifacts: current.map((artifact) => (artifact.id === id ? { ...artifact, name, updatedAt: at } : artifact)) };
      });
      return renamed ? next : prev;
    });
    return true;
  };

  /**
   * `chunk` (from `batch`, built from `sentFrom`) committed: the backend
   * holds what it wrote, and it leaves the pending delta, except what changed
   * again since the batch was built (that change still waits). An artifact
   * the backend answered gone leaves it whatever changed.
   *
   * One answered name-taken (a stale write under a name another artifact
   * holds there) is alive: it stays in the store, and only the write sent
   * leaves the delta, as a committed one does. A change made since is a
   * write of its own and still goes (a rename to a free name lands).
   */
  const commitChunk = (
    projectId: string, sentFrom: Project, batch: ExplicitCommandBatch, chunk: readonly WorkspaceCommand[],
    skipped: SkippedArtifactWrites,
  ) => {
    const written = commandsDelta(chunk);
    const ofChunk = <T,>(updates: ReadonlyMap<string, T>) => new Map([...updates].filter(([nodeId]) => written.nodeIds.has(nodeId)));
    const projections = ofChunk(batch.nodeProjectionUpdates);
    noteConfirmedDeletes(projectId, written);
    noteConfirmedWrites(projectId, chunk, written, projections);
    for (const [nodeId, projection] of projections) nodeCommandProjectionRef.current.set(nodeId, projection);
    for (const [nodeId, viewedAt] of ofChunk(batch.viewedAtUpdates)) nodeViewedAtRef.current.set(nodeId, viewedAt);
    for (const [nodeId, seen] of ofChunk(batch.seenCompletionUpdates)) nodeSeenCompletionRef.current.set(nodeId, seen);
    // Only an artifact this chunk upserted can have been answered gone or name-taken.
    const gone = new Set(skipped.goneContextIds.filter((id) => written.contextUpsertIds.has(id)));
    if (gone.size > 0) dropGoneArtifacts(projectId, gone);
    const nameTaken = new Set(skipped.nameTakenContextIds.filter((id) => written.contextUpsertIds.has(id) && !gone.has(id)));
    // A read's probe this chunk sent is answered (probeArtifacts): gone (dropped
    // above), name-taken (not the backend's: dropped, nothing deleted), or
    // written (live: kept). Either way it is asked no more.
    const probes = artifactProbesRef.current.get(projectId);
    const notTheBackends = new Set<string>();
    if (probes) {
      for (const id of written.contextUpsertIds) {
        if (probes.delete(id) && nameTaken.has(id)) notTheBackends.add(id);
      }
    }
    if (notTheBackends.size > 0) dropProbedArtifacts(projectId, notTheBackends);
    // The name each artifact upsert of this chunk carried.
    const sentNames = new Map<string, string>();
    for (const command of chunk) {
      if (command.type === 'context.upsert' && typeof command.payload.id === 'string') sentNames.set(command.payload.id, String(command.payload.name ?? ''));
    }
    const stale = [...nameTaken].filter((id) => !notTheBackends.has(id) && !keepOwnArtifactNamed(projectId, id, sentNames.get(id)));
    if (stale.length > 0) {
      // This window's copy of them differs from the backend's until a reload.
      console.warn(`workspace ${projectId}: ${stale.length} artifact write(s) skipped, the name is another artifact's there`);
    }
    // Written (or gone): a name given here is no longer this window's alone.
    const named = ownArtifactNamesRef.current.get(projectId);
    if (named) {
      for (const [id, name] of sentNames) {
        if (nameTaken.has(id) || !named.has(id)) continue;
        const own = named.get(id);
        // Renamed here again since: that name is not written yet.
        if (!gone.has(id) && own !== null && own !== name) continue;
        named.delete(id);
        ownArtifactRenamesRef.current.get(projectId)?.delete(id);
      }
    }

    const pending = pendingCommandDeltaByProjectRef.current.get(projectId);
    if (!pending) return;
    const now = projectsRef.current.find((candidate) => candidate.id === projectId);
    const rest = mergeWorkspaceDirtyDelta(pending, emptyWorkspaceDirtyDelta());
    const same = <T,>(sent: T | undefined, current: T | undefined, key: (value: T) => string) =>
      sent !== undefined && current !== undefined && key(sent) === key(current);
    const byId = <T,>(items: readonly T[] | undefined, id: (item: T) => string) => new Map((items ?? []).map((item) => [id(item), item] as const));
    const sentTrees = byId(sentFrom.trees, (tree) => tree.id);
    const nowTrees = byId(now?.trees, (tree) => tree.id);
    const sentEdges = byId(sentFrom.edges, serializedEdgeId);
    const nowEdges = byId(now?.edges, serializedEdgeId);
    const sentContexts = byId(sentFrom.artifacts, (context) => context.id);
    const nowContexts = byId(now?.artifacts, (context) => context.id);
    if (written.workspaceChanged && now && workspaceRowKey(now) === workspaceRowKey(sentFrom)) rest.workspaceChanged = false;
    for (const id of written.treeUpsertIds) if (same(sentTrees.get(id), nowTrees.get(id), treeRowKey)) rest.treeUpsertIds.delete(id);
    for (const id of written.treeDeleteIds) if (!nowTrees.has(id)) rest.treeDeleteIds.delete(id);
    for (const id of written.edgeUpsertIds) if (same(sentEdges.get(id), nowEdges.get(id), edgeRowKey)) rest.edgeUpsertIds.delete(id);
    for (const id of written.edgeDeleteIds) if (!nowEdges.has(id)) rest.edgeDeleteIds.delete(id);
    for (const id of written.contextUpsertIds) if (same(sentContexts.get(id), nowContexts.get(id), contextRowKey)) rest.contextUpsertIds.delete(id);
    for (const id of written.contextDeleteIds) if (!nowContexts.has(id)) rest.contextDeleteIds.delete(id);
    for (const id of [...gone, ...notTheBackends]) {
      rest.contextUpsertIds.delete(id);
      rest.contextDeleteIds.delete(id);
    }
    if (now) {
      // A node still differing from what the backend now holds (its projection, view mark) waits.
      const probe = emptyWorkspaceDirtyDelta();
      for (const nodeId of written.nodeIds) if (rest.nodeIds.has(nodeId)) probe.nodeIds.add(nodeId);
      const still = commandsDelta(buildExplicitWorkspaceCommands(now, nodesRef.current, probe, nodeCommandProjectionRef.current,
        windowId, nodeViewedAtRef.current, nodeSeenCompletionRef.current).commands).nodeIds;
      for (const nodeId of probe.nodeIds) if (!still.has(nodeId)) rest.nodeIds.delete(nodeId);
      for (const command of chunk) {
        const nodeId = command.payload.id;
        if (typeof nodeId !== 'string' || !('composer_draft' in command.payload) || !rest.draftNodeIds.has(nodeId)) continue;
        const node = nodesRef.current[nodeId];
        if (node && serializedComposerDraft(node) === command.payload.composer_draft) rest.draftNodeIds.delete(nodeId);
      }
    }
    if (deltaIsEmpty(rest)) pendingCommandDeltaByProjectRef.current.delete(projectId);
    else pendingCommandDeltaByProjectRef.current.set(projectId, rest);
  };

  /**
   * `chunk` (from `sentFrom`) failed with `error` while carrying a read's
   * probes. A probe is only an optimisation (probeArtifacts) and must never
   * hold up the workspace's writes: one the backend refused (`rejected`: a
   * 4xx other than a conflict or a size refusal) or answered with a server
   * error PROBE_SERVER_ERRORS_KEPT times is dropped. It is asked no more, its
   * artifact stays as this window holds it, and its write leaves the pending
   * delta unless the artifact changed since the chunk was built (that change
   * still goes). A first server error, a conflict, a timeout or throttling,
   * and no answer at all are retried as before: the backend may be busy, or
   * was not reached. So is a probe sent other than as it was asked about: it
   * carries a write of this window's own, retried as any write is.
   *
   * Server errors also make the window ask the connection's capabilities
   * again: an older backend fails such a write (UNIQUE) with a 500. Returns
   * the probes dropped; the caller sends the rest again at once.
   */
  const dropFailedProbes = (projectId: string, sentFrom: Project, chunk: readonly WorkspaceCommand[], error: unknown): ReadonlySet<string> => {
    const dropped = new Set<string>();
    const probes = artifactProbesRef.current.get(projectId);
    if (!probes?.size) return dropped;
    const failure = classifyCommandFailure(error);
    const status = (error as { status?: unknown } | null)?.status;
    const serverError = failure.kind === 'retry' && typeof status === 'number' && status >= 500;
    if (!serverError && failure.kind !== 'rejected') return dropped;
    const sent = new Map((sentFrom.artifacts ?? []).map((artifact) => [artifact.id, artifact] as const));
    for (const command of chunk) {
      const id = command.payload.id;
      if (command.type !== 'context.upsert' || typeof id !== 'string') continue;
      const probe = probes.get(id);
      const artifact = sent.get(id);
      if (!probe || !artifact || contextRowKey(artifact) !== probe.row) continue;
      if (serverError && (probe.serverErrors += 1) < PROBE_SERVER_ERRORS_KEPT) continue;
      dropped.add(id);
    }
    if (dropped.size === 0) return dropped;
    const pending = pendingCommandDeltaByProjectRef.current.get(projectId);
    const now = new Map((projectsRef.current.find((candidate) => candidate.id === projectId)?.artifacts ?? [])
      .map((artifact) => [artifact.id, artifact] as const));
    for (const id of dropped) {
      probes.delete(id);
      const current = now.get(id);
      if (current && contextRowKey(current) === contextRowKey(sent.get(id)!)) pending?.contextUpsertIds.delete(id);
    }
    if (pending && deltaIsEmpty(pending)) pendingCommandDeltaByProjectRef.current.delete(projectId);
    if (serverError) forgetCapabilities(projectConnectionId(sentFrom));
    console.warn(`workspace ${projectId}: ${dropped.size} artifact probe(s) dropped, the backend failed their write (HTTP ${String(status)})`);
    return dropped;
  };

  /**
   * Send `batch` (built from `sentFrom`) in dependency-ordered chunks the
   * backend accepts, one after another, each under its own operation id.
   * Each chunk that commits leaves the pending delta; a failure throws with
   * the rest still pending. A chunk refused as too large is split again,
   * and one that failed on a read's probe goes again without it (dropFailedProbes).
   */
  const sendCommandBatch = async (projectId: string, sentFrom: Project, batch: ExplicitCommandBatch): Promise<void> => {
    const connectionId = projectConnectionId(sentFrom);
    let remaining: readonly WorkspaceCommand[] = batch.commands;
    while (remaining.length > 0) {
      const limit = batchLimitFor(connectionId);
      const chunks = chunkWorkspaceCommands(remaining, limit);
      remaining = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const body = JSON.stringify(chunk);
        const last = lastSentRef.current.get(projectId);
        const operationId = last?.body === body
          ? last.operationId
          : `cmd-${projectId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        lastSentRef.current.set(projectId, { operationId, body });
        let skipped: SkippedArtifactWrites;
        try {
          const answer = await applyWorkspaceCommands(projectId, operationId, chunk);
          skipped = { goneContextIds: answer?.goneContextIds ?? [], nameTakenContextIds: answer?.nameTakenContextIds ?? [] };
        } catch (error) {
          const failure = classifyCommandFailure(error);
          // Only a transient failure may have committed unanswered; anything else was not applied.
          if (failure.kind !== 'retry' && failure.kind !== 'conflict') lastSentRef.current.delete(projectId);
          const dropped = failure.kind === 'too_many' ? undefined : dropFailedProbes(projectId, sentFrom, chunk, error);
          if (dropped?.size) {
            remaining = chunks.slice(index).flat()
              .filter((command) => command.type !== 'context.upsert' || !dropped.has(command.payload.id as string));
            break;
          }
          if (failure.kind !== 'too_many') throw error;
          const smaller = smallerCommandLimit(chunk.length, limit, failure.maxCommands);
          if (smaller >= chunk.length) throw error;
          learnedBatchLimitRef.current.set(connectionId, smaller);
          remaining = chunks.slice(index).flat();
          break;
        }
        lastSentRef.current.delete(projectId);
        commitChunk(projectId, sentFrom, batch, chunk, skipped);
      }
    }
  };

  const dropNotice = (projectId: string) => {
    if (raisedNoticesRef.current.delete(projectId)) clearWorkspaceSyncNotice(projectId);
  };

  const syncSucceeded = (projectId: string) => {
    syncStateRef.current.delete(projectId);
    dropNotice(projectId);
  };

  const retryWorkspaceSync = (projectId: string) => {
    syncStateRef.current.delete(projectId);
    dropNotice(projectId);
    dirtyRef.current = true;
  };

  /**
   * Drop this window's unsaved changes to a workspace and take the backend's
   * state back: what the store shows stops being an edit to write or to keep
   * through a re-read, and a re-read replaces it. Trees and threads made here
   * that the backend never got are reported removed, so the re-read drops them.
   */
  const discardWorkspaceChanges = (projectId: string) => {
    const discarded = mergeWorkspaceDirtyDelta(
      pendingCommandDeltaByProjectRef.current.get(projectId) ?? emptyWorkspaceDirtyDelta(),
      dirtyDeltaByProjectRef.current.get(projectId) ?? emptyWorkspaceDirtyDelta(),
    );
    pendingCommandDeltaByProjectRef.current.delete(projectId);
    dirtyDeltaByProjectRef.current.delete(projectId);
    dirtyProjectIdsRef.current.delete(projectId);
    lastSentRef.current.delete(projectId);
    syncStateRef.current.delete(projectId);
    // Names given here go with the changes that carried them, and so do the probes waiting.
    ownArtifactNamesRef.current.delete(projectId);
    ownArtifactRenamesRef.current.delete(projectId);
    artifactProbesRef.current.delete(projectId);
    dropNotice(projectId);
    const project = projectsRef.current.find((candidate) => candidate.id === projectId);
    if (!project) return;
    const nodes = nodesRef.current;
    const prevNodes = { ...prevNodesRef.current };
    prevProjectsRef.current = prevProjectsRef.current.some((candidate) => candidate.id === projectId)
      ? prevProjectsRef.current.map((candidate) => (candidate.id === projectId ? project : candidate))
      : [...prevProjectsRef.current, project];
    confirmProjectRows(project, 0);
    for (const nodeId of project.chatIds) {
      dirtyDraftNodeIdsRef?.current.delete(nodeId);
      const node = nodes[nodeId];
      if (!node) continue;
      prevNodes[nodeId] = node;
      noteNodeBaseline(project, nodes, nodeId, 0);
    }
    prevNodesRef.current = prevNodes;
    const changes: WorkspaceStructureChange[] = [{ entity: 'workspace', op: 'renamed', workspaceId: projectId }];
    for (const treeId of discarded.treeUpsertIds) changes.push({ entity: 'tree', op: 'deleted', workspaceId: projectId, treeId });
    for (const nodeId of discarded.nodeIds) changes.push({ entity: 'node', op: 'purged', workspaceId: projectId, nodeId });
    requestWorkspaceStructureRead({ connectionId: projectConnectionId(project), changes });
  };

  const raiseNotice = (projectId: string, kind: 'rejected' | 'conflict', message: string) => {
    const project = projectsRef.current.find((candidate) => candidate.id === projectId);
    raisedNoticesRef.current.add(projectId);
    showWorkspaceSyncNotice({
      workspaceId: projectId,
      workspaceName: project?.name || 'Untitled workspace',
      message,
      kind,
      retry: () => retryWorkspaceSync(projectId),
      discard: () => discardWorkspaceChanges(projectId),
    });
  };

  /**
   * A write failed. Transient failures back off (2 s doubling to a minute);
   * a conflict also re-reads the workspace to rebase and is shown only once
   * it has kept failing for a while; a refusal stops this workspace's writes
   * until the user retries or discards them.
   */
  const syncFailed = (projectId: string, error: unknown) => {
    const failure = classifyCommandFailure(error);
    const now = Date.now();
    const state = syncStateRef.current.get(projectId) ?? { failures: 0, retryAt: 0 };
    syncStateRef.current.set(projectId, state);
    if (failure.kind === 'rejected') {
      state.blocked = failure.message;
      console.warn(`workspace ${projectId}: the backend refused its unsaved changes (HTTP ${failure.status}${failure.code ? ` ${failure.code}` : ''}): ${failure.message}`);
      raiseNotice(projectId, 'rejected', failure.message);
      return;
    }
    state.failures += 1;
    state.retryAt = now + commandRetryDelay(state.failures);
    if (state.failures === 1) console.warn(`workspace persistence write failed (${projectId}); retrying:`, error);
    if (failure.kind !== 'conflict') return;
    state.conflictSince ??= now;
    const project = projectsRef.current.find((candidate) => candidate.id === projectId);
    if (project) {
      requestWorkspaceStructureRead({
        connectionId: projectConnectionId(project),
        changes: [{ entity: 'workspace', op: 'renamed', workspaceId: projectId }],
      });
    }
    if (now - state.conflictSince >= COMMAND_CONFLICT_NOTICE_AFTER_MS) raiseNotice(projectId, 'conflict', failure.message);
  };

  // A notice's actions belong to this hook: they go with it.
  useEffect(() => () => {
    for (const projectId of raisedNoticesRef.current) clearWorkspaceSyncNotice(projectId);
    raisedNoticesRef.current.clear();
  }, []);

  // Structural mutations must see new branches and must not race an older
  // queued graph write. The callback installs the server result before sync resumes.
  const runWorkspaceMutation = useCallback(async (projectId: string, mutation: () => Promise<void>) => {
    if (!hydratedRef.current) throw new Error('Workspace is still loading');
    // Shown from the local cache: the mutation waits for the remote's own data.
    const shown = projectsRef.current.find(p => p.id === projectId);
    const connectionId = shown ? projectConnectionId(shown) : LOCAL_BACKEND_CONNECTION_ID;
    if (backendConnectionProvisional(connectionId) && !await whenBackendConnectionConfirmed(connectionId)) {
      throw new Error('This remote workspace is still loading. Try again in a moment.');
    }
    if (!syncPausedRef || syncPausedRef.current) throw new Error('Another workspace operation is in progress');
    syncPausedRef.current = true;
    try {
      await workspaceSyncQueueRef.current!.whenIdle(projectId);
      const project = projectsRef.current.find(p => p.id === projectId);
      if (!project) throw new Error('Workspace not found');
      const pendingDelta = pendingCommandDeltaByProjectRef.current.get(projectId);
      const dirtyDelta = dirtyDeltaByProjectRef.current.get(projectId);
      let delta = mergeWorkspaceDirtyDelta(
        pendingDelta ?? emptyWorkspaceDirtyDelta(),
        dirtyDelta ?? emptyWorkspaceDirtyDelta(),
      );
      delta = accumulateWorkspaceDirtyDelta(prevProjectsRef.current.find(p => p.id === projectId), project,
        prevNodesRef.current, nodesRef.current, delta);
      dropGoneContextDeletes(projectId, delta);
      const batch = buildExplicitWorkspaceCommands(project, nodesRef.current, delta, nodeCommandProjectionRef.current, windowId,
        nodeViewedAtRef.current, nodeSeenCompletionRef.current);
      // Every unsaved change goes ahead of the mutation; what does not commit stays pending.
      const writing = pendingThatWrites(delta, batch.commands);
      if (deltaIsEmpty(writing)) pendingCommandDeltaByProjectRef.current.delete(projectId);
      else pendingCommandDeltaByProjectRef.current.set(projectId, writing);
      if (dirtyDelta) {
        dirtyDeltaByProjectRef.current.delete(projectId);
        dirtyProjectIdsRef.current.delete(projectId);
      }
      await sendCommandBatch(projectId, project, batch);
      syncSucceeded(projectId);
      await mutation();
    } finally {
      syncPausedRef.current = false;
    }
  }, [nodesRef, syncPausedRef, windowId]); // eslint-disable-line react-hooks/exhaustive-deps -- the send helpers read refs only

  // Periodically turn structural state and explicit draft edits into v2 commands.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const intervalId = window.setInterval(() => {
      if (
        (!dirtyRef.current
          && !dirtyDraftNodeIdsRef?.current.size
          && pendingCommandDeltaByProjectRef.current.size === 0)
        || !hydratedRef.current
      ) return;
      // Skip while a destructive async action is mid-flight (see syncPausedRef).
      if (syncPausedRef?.current) return;
      // A flush is already queued — let it drain the (possibly grown) dirty set.
      if (idleScheduledRef.current) return;

      const flush = () => {
        idleScheduledRef.current = false;
        if (!hydratedRef.current || syncPausedRef?.current) return;
        collectDirtyDrafts();
        const deltaSnapshot = new Map(dirtyDeltaByProjectRef.current);

        for (const [projectId, delta] of deltaSnapshot) {
          // A delete scanned before the backend answered that artifact gone
          // has nothing left to delete (the scan after that answer may not run).
          dropGoneContextDeletes(projectId, delta);
          if (deltaIsEmpty(delta)) continue;
          const existing = pendingCommandDeltaByProjectRef.current.get(projectId) ?? emptyWorkspaceDirtyDelta();
          pendingCommandDeltaByProjectRef.current.set(
            projectId,
            mergeWorkspaceDirtyDelta(existing, delta),
          );
        }

        dirtyRef.current = false;
        dirtyProjectIdsRef.current.clear();
        dirtyDeltaByProjectRef.current.clear();

        // Refused outright (until the user acts), or waiting out a backoff, or
        // shown from the local cache: kept pending, sent once the remote's own
        // data replaced the copy (built then, from what the store holds).
        const held = (projectId: string) => {
          const sync = syncStateRef.current.get(projectId);
          if (sync && (sync.blocked !== undefined || Date.now() < sync.retryAt)) return true;
          const project = projectsRef.current.find((candidate) => candidate.id === projectId);
          return !!project && backendConnectionProvisional(projectConnectionId(project));
        };
        for (const project of projectsRef.current) {
          if (!pendingCommandDeltaByProjectRef.current.has(project.id)) continue;
          const projectId = project.id;
          if (held(projectId)) continue;
          const queue = workspaceSyncQueueRef.current!;
          queue.enqueue(projectId, async () => {
            // A task queued behind one that failed waits out the same backoff.
            if (syncPausedRef?.current || held(projectId)) return;
            const latestProject = projectsRef.current.find((candidate) => candidate.id === projectId);
            const pending = pendingCommandDeltaByProjectRef.current.get(projectId);
            if (!latestProject || !pending) return;
            const batch = buildExplicitWorkspaceCommands(
              latestProject,
              nodesRef.current,
              pending,
              nodeCommandProjectionRef.current,
              windowId,
              nodeViewedAtRef.current,
              nodeSeenCompletionRef.current,
            );
            // What builds to nothing has nothing left to wait for.
            const writing = pendingThatWrites(pending, batch.commands);
            if (deltaIsEmpty(writing)) pendingCommandDeltaByProjectRef.current.delete(projectId);
            else pendingCommandDeltaByProjectRef.current.set(projectId, writing);
            if (batch.commands.length === 0) return;
            try {
              await sendCommandBatch(projectId, latestProject, batch);
            } catch (error) {
              syncFailed(projectId, error);
              return;
            }
            syncSucceeded(projectId);
          });
        }
      };

      idleScheduledRef.current = true;
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(flush, { timeout: 2000 });
      } else {
        flush(); // jsdom / older Safari: run synchronously.
      }
    }, 2000);
    return () => window.clearInterval(intervalId);
  }, [nodesRef]); // eslint-disable-line react-hooks/exhaustive-deps -- syncPausedRef is a stable MutableRefObject; .current is read at call time

  // Best effort during unload: unsent structural commands go by sendBeacon.
  // Chromium queues at most ~64 KiB of beacons per page, so the active
  // workspace goes first, each workspace's chunks go in dependency order, and
  // the first that does not fit ends that workspace's (the next load reads
  // the backend again; nothing relies on this).
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!hydratedRef.current || syncPausedRef?.current) return;
      if (typeof navigator.sendBeacon !== 'function') return;
      collectDirtyDrafts();
      const deltas = new Map(pendingCommandDeltaByProjectRef.current);
      for (const [projectId, delta] of dirtyDeltaByProjectRef.current) {
        deltas.set(
          projectId,
          mergeWorkspaceDirtyDelta(deltas.get(projectId) ?? emptyWorkspaceDirtyDelta(), delta),
        );
      }
      const active = activeProjectIdRef.current;
      const order = [...deltas.keys()].sort((a, b) => Number(b === active) - Number(a === active));
      let budget = BEACON_BUDGET_BYTES;
      for (const projectId of order) {
        if (syncStateRef.current.get(projectId)?.blocked !== undefined) continue;
        const project = projectsRef.current.find((candidate) => candidate.id === projectId);
        // Built on a cached copy the remote never confirmed: nothing to send.
        if (!project || backendConnectionProvisional(projectConnectionId(project))) continue;
        const batch = buildExplicitWorkspaceCommands(
          project,
          nodesRef.current,
          deltas.get(projectId)!,
          nodeCommandProjectionRef.current,
          windowId,
          nodeViewedAtRef.current,
          nodeSeenCompletionRef.current,
        );
        if (batch.commands.length === 0) continue;
        const url = `${workspaceBackendApiBase(projectId)}/workspaces/${encodeURIComponent(serverEntityId(projectId))}/commands`;
        const limit = Math.min(BEACON_COMMANDS_PER_CHUNK, batchLimitFor(projectConnectionId(project), false));
        const stamp = Date.now();
        for (const [index, commands] of chunkWorkspaceCommands(batch.commands, limit).entries()) {
          const payload = workspaceCommandsBody(`unload-${projectId}-${stamp}-${index}`, commands);
          const blob = new Blob([backendRequestOptions(url, { body: payload }).body as string], { type: 'application/json' });
          if (blob.size > budget || !navigator.sendBeacon(url, blob)) break;
          budget -= blob.size;
        }
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [nodesRef]);

  const initialActiveProjectIdRef = useRef(activeProjectId);

  /** Keep a remote thread's first page for the next boot, stamped with its connection's revision. */
  const noteRemoteTreePageNow = (connectionId: string | undefined, workspaceId: string, treeId: string, page: TreeMessagePage) => {
    const cache = remoteCacheRef.current;
    if (!cache || !connectionId || connectionId === LOCAL_BACKEND_CONNECTION_ID) return;
    const revision = connectionRevisionsRef.current.get(connectionId);
    if (!revision) return;
    const user = userIdRef.current;
    runWhenIdle(() => {
      if (connectionRevisionsRef.current.get(connectionId) !== revision) return;
      void cache.writePage(user, connectionId, revision, workspaceId, treeId, page);
    });
  };
  const noteRemoteTreePageRef = useRef(noteRemoteTreePageNow);
  noteRemoteTreePageRef.current = noteRemoteTreePageNow;

  useEffect(() => {
    let cancelled = false;
    const activeRemoteIds = new Set<string>();
    // Keep our own saved revision: settings may publish the new list globally
    // before its change event arrives. Status updates do not change updatedAt.
    const connectionRecords = new Map<string, BackendConnectionSummary>();
    const recordConnection = (connection: BackendConnectionSummary) => {
      connectionRecords.set(connection.id, connection);
      connectionRevisionsRef.current.set(connection.id, connectionRevision(connection));
    };
    const isCurrentConnection = (connection: BackendConnectionSummary) => !cancelled
      && activeRemoteIds.has(connection.id) && connectionRecords.get(connection.id) === connection;
    const cache = remoteCacheRef.current;
    const cacheUser = userId;
    // Cache-sourced workspaces per provisional connection, as installed: what
    // the remote's own metadata is merged against (remoteCacheMerge).
    const cachedOrigins = new Map<string, CachedOrigin>();
    const keepRemoteCopy = (connection: BackendConnectionSummary, snapshot: BackendSnapshot) => {
      if (!cache) return;
      const { connectionId: _connectionId, ...received } = snapshot;
      const revision = connectionRevision(connection);
      runWhenIdle(() => {
        if (cancelled || connectionRevisionsRef.current.get(connection.id) !== revision) return;
        void cache.writeSnapshot(cacheUser, connection.id, revision, received as CachedRemoteSnapshot);
      });
    };

    // ── The visible remote thread, read alongside its metadata ─────────────
    // A window last on a remote workspace names its connection in the id: its
    // thread's first page starts as soon as the local backend (the proxy)
    // answers, instead of after local metadata → connection list → remote
    // metadata. Its result goes in with the metadata (bounded, like the local
    // eager load) or to the tree read pool, never read twice.
    const preferredAtBoot = resolveActiveProjectForWindow(initialActiveProjectIdRef.current);
    const bootConnectionId = remoteConnectionOf(preferredAtBoot);
    let resolveLocalReachable: () => void = () => {};
    const localReachable = new Promise<void>((resolve) => { resolveLocalReachable = resolve; });
    // The connection list is local too: start it then, to check a cached copy's revision.
    const earlyConnections: Promise<BackendConnectionSummary[] | null> | null = bootConnectionId && typeof listBackendConnections === 'function'
      ? localReachable.then(() => listBackendConnections()).catch(() => null)
      : null;
    const cachedConnection: Promise<CachedRemoteConnection | null> = bootConnectionId && cache
      ? cache.readConnection(cacheUser, bootConnectionId)
      : Promise.resolve(null);
    type BootRead = {
      connectionId: string; workspaceId: string; treeId: string;
      controller: AbortController; promise: Promise<TreeMessagePage>;
      page: TreeMessagePage | null; done: boolean; claimed: boolean;
    };
    let bootRead: BootRead | null = null;
    const bootReadReady: Promise<BootRead | null> = bootConnectionId && preferredAtBoot ? (async () => {
      const treeId = bootTreeFor(await cachedConnection, preferredAtBoot, bootConnectionId);
      if (!treeId || cancelled) return null;
      await localReachable;
      if (cancelled) return null;
      const controller = new AbortController();
      const read: BootRead = {
        connectionId: bootConnectionId, workspaceId: preferredAtBoot, treeId, controller,
        promise: fetchRemoteTreeFirstPage(preferredAtBoot, treeId, bootConnectionId, controller.signal),
        page: null, done: false, claimed: false,
      };
      read.promise.then((page) => {
        read.page = page;
        read.done = true;
        noteRemoteTreePageRef.current(bootConnectionId, preferredAtBoot, treeId, page);
      }, () => { read.done = true; });
      bootRead = read;
      return read;
    })().catch(() => null) : Promise.resolve(null);
    /**
     * Put the boot read in with `connectionId`'s workspaces in `state` (about
     * to be installed): the visible thread's placeholders it fits get their
     * messages now; the rest (a running turn, a page the metadata outran, one
     * still on its way) go to the read pool, checked against the metadata.
     * Over a cached copy (`fromCache`) it is fresher than what it is checked
     * against, so it is taken as is, and kept for the metadata when the copy
     * already shows the whole thread. Returns whether the visible thread has
     * nothing left to load.
     */
    const claimBootRead = (connectionId: string, state: HydratedState,
      { rereadNodeIds = new Set<string>(), fromCache = false }: { rereadNodeIds?: ReadonlySet<string>; fromCache?: boolean } = {},
    ): boolean => {
      const read = bootRead;
      const visible = state.projects.find((project) => project.id === state.activeProjectId);
      const waiting = (project: Project | undefined, treeId: string | null | undefined) => (project && treeId
        ? project.chatIds.filter((nodeId) => {
          const node = state.nodes[nodeId];
          return !!node && !node.deletedAt && node.messagesLoaded === false && !node.historyBefore
            && (node.messages.length === 0 || rereadNodeIds.has(nodeId))
            && findTreeIdForNode(nodeId, project) === treeId;
        })
        : []);
      const project = read && read.connectionId === connectionId && !read.claimed
        ? state.projects.find((candidate) => candidate.id === read.workspaceId) : undefined;
      if (read && project?.trees.some((candidate) => candidate.id === read.treeId)) {
        let candidates = waiting(project, read.treeId);
        if (!fromCache || candidates.length > 0) {
          read.claimed = true;
          if (read.page && candidates.length > 0) {
            const page = read.page;
            const result = installMatchingPage(state.nodes, page, candidates,
              fromCache ? (nodeId, node) => pageShowable(page, nodeId, node) : undefined);
            state.nodes = result.nodes;
            candidates = candidates.filter((nodeId) => !result.installed.includes(nodeId));
          }
          if (candidates.length > 0 && treeRequestsRef.current) {
            const known = new Map(candidates.map((nodeId) => [nodeId, state.nodes[nodeId]] as const));
            const checked = fromCache ? read.promise : read.promise.then((page) => {
              if (pageBehindNodes(page, known)) throw new Error('The thread moved on while it was read');
              return page;
            });
            void checked.catch(() => {});
            treeRequestsRef.current.seed(connectionId, read.workspaceId, read.treeId, checked, read.controller);
          }
        }
      }
      return !visible || projectConnectionId(visible) !== connectionId || waiting(visible, visible.activeTreeId).length === 0;
    };
    const remoteControllers = new Map<string, AbortController>();
    const retryingRemoteIds = new Map<string, BackendConnectionSummary>();
    const retryWaiters = new Map<string, () => void>();
    const retryRequested = new Set<string>();
    const onRetryRemote = (event: Event) => {
      const id = (event as CustomEvent<{ connectionId: string }>).detail?.connectionId;
      if (!activeRemoteIds.has(id)) return;
      const wake = retryWaiters.get(id);
      // Tell the caller whether a load acted on this; after hydration the gateway owns recovery.
      if (wake || remoteControllers.has(id)) event.preventDefault();
      if (wake) wake(); else retryRequested.add(id);
    };
    window.addEventListener(REMOTE_WORKSPACE_RETRY_EVENT, onRetryRemote);
    const waitForRemoteRetry = (id: string, delay: number) => new Promise<void>(resolve => {
      if (retryRequested.delete(id)) { resolve(); return; }
      const done = () => { retryWaiters.delete(id); resolve(); };
      const timer = window.setTimeout(done, delay);
      retryWaiters.set(id, () => { window.clearTimeout(timer); done(); });
    });
    const installNodes = (next: Record<string, ChatNodeState>) => {
      nodesRef.current = next;
      setNodes(next);
    };
    const finishHydration = (hydrateSource: string) => {
      startupMarkOnce('state_hydrate_done', { hydrateSource });
      setHydrated(true);
    };
    startupMarkOnce('state_hydrate_start');
    // The hydration barrier: never finalize hydration until the backend has
    // actually answered. On cold start the renderer runs before the backend is
    // listening, so the first fetch rejects (ECONNREFUSED). A REJECTED fetch is
    // "not ready yet" → wait and retry; it is NEVER interpreted as an empty
    // database. A RESOLVED value (even []) means the backend answered → proceed
    // and finalize. This is what keeps a startup race from wiping the UI to
    // empty over a DB that holds every workspace.
    type BackendSnapshot = { connectionId: string; workspaces: unknown[] };
    const appendBackendSnapshot = (state: HydratedState, snapshot: BackendSnapshot): number => {
      const rawBackend = snapshot.workspaces.filter(
        (workspace): workspace is Record<string, unknown> => !!workspace && typeof workspace === 'object',
      );
      const hydratedSnapshot = hydrateBackendWorkspaces(rawBackend, null, snapshot.connectionId);
      const seenProjectIds = new Set(state.projects.map((project) => project.id));
      const seenNodeIds = new Set(Object.keys(state.nodes));
      let addedProjects = 0;

      for (const project of hydratedSnapshot.projects) {
        if (seenProjectIds.has(project.id)) {
          console.warn(`workspace id collision across backends; skipping ${project.id} from ${snapshot.connectionId}`);
          continue;
        }
        const duplicateNode = project.chatIds.find((nodeId) => seenNodeIds.has(nodeId));
        if (duplicateNode) {
          console.warn(`node id collision across backends; skipping workspace ${project.id} (${duplicateNode})`);
          continue;
        }
        const taggedProject = snapshot.connectionId === LOCAL_BACKEND_CONNECTION_ID
          ? project
          : { ...project, backendConnectionId: snapshot.connectionId };
        state.projects.push(taggedProject);
        addedProjects += 1;
        seenProjectIds.add(project.id);
        for (const nodeId of project.chatIds) {
          seenNodeIds.add(nodeId);
          const node = hydratedSnapshot.nodes[nodeId];
          if (node) state.nodes[nodeId] = node;
        }
      }
      return addedProjects;
    };
    const replaceBackendSnapshot = (state: HydratedState, snapshot: BackendSnapshot): number => {
      const cachedProjects = new Map(state.projects.filter(project => project.backendConnectionId === snapshot.connectionId)
        .map(project => [project.id, project]));
      const cachedNodes = { ...state.nodes };
      const retainedProjects: Project[] = [];
      let removedProjects = 0;
      for (const project of state.projects) {
        const connectionId = projectConnectionId(project);
        if (connectionId !== snapshot.connectionId) {
          retainedProjects.push(project);
          continue;
        }
        removedProjects += 1;
        for (const nodeId of project.chatIds) delete state.nodes[nodeId];
      }
      state.projects = retainedProjects;
      const changed = removedProjects + appendBackendSnapshot(state, snapshot);
      // A metadata refresh cannot replace already-loaded history, unsent work
      // or replay watermarks. The durable event feeds reconcile missed output;
      // server removals still win because absent entities are not reintroduced.
      state.projects = state.projects.map(project => {
        const cached = cachedProjects.get(project.id);
        if (!cached) return project;
        for (const id of project.chatIds) {
          const node = state.nodes[id], held = cachedNodes[id];
          if (!node || !held) continue;
          state.nodes[id] = { ...node, ...held,
            messageCount: Math.max(node.messageCount ?? 0, held.messageCount ?? held.messages.length),
          };
        }
        return { ...project, activeTreeId: project.trees.some(tree => tree.id === cached.activeTreeId) ? cached.activeTreeId : project.activeTreeId };
      });
      return changed;
    };
    /**
     * The remote answered for a connection shown from the local cache. Unlike
     * a live refresh (above), cached nodes are not current, so they never win:
     * the answer replaces them except where this window changed something
     * since the copy went in (remoteCacheMerge). Mutates `state`.
     */
    const mergeCachedSnapshot = (state: HydratedState, snapshot: BackendSnapshot, origin: CachedOrigin) => {
      const ofConnection = (project: Project) => projectConnectionId(project) === snapshot.connectionId;
      const held = state.projects.filter(ofConnection);
      const retained = state.projects.filter((project) => !ofConnection(project));
      const heldNodeIds = new Set(held.flatMap((project) => project.chatIds));
      const freshState: HydratedState = {
        projects: [...retained], activeProjectId: null,
        nodes: Object.fromEntries(Object.entries(state.nodes).filter(([nodeId]) => !heldNodeIds.has(nodeId))),
      };
      appendBackendSnapshot(freshState, snapshot);
      const freshProjects = freshState.projects.slice(retained.length);
      const freshNodes: Record<string, ChatNodeState> = {};
      for (const project of freshProjects) {
        for (const nodeId of project.chatIds) if (freshState.nodes[nodeId]) freshNodes[nodeId] = freshState.nodes[nodeId];
      }
      const merge = mergeFreshOverCached(origin, { projects: held, nodes: state.nodes }, { projects: freshProjects, nodes: freshNodes });
      for (const nodeId of heldNodeIds) delete state.nodes[nodeId];
      state.projects = [...retained, ...merge.projects];
      Object.assign(state.nodes, merge.nodes);
      return merge;
    };
    type CachedBoot = {
      connection: BackendConnectionSummary; snapshot: CachedRemoteSnapshot;
      activeTrees: Record<string, string>; page: TreeMessagePage | null; treeId: string | null;
    };
    /**
     * Put a valid cached copy of the boot connection into `state`, read-only
     * (the connection is provisional until it answers), with this user's last
     * thread per workspace and the visible thread's cached first page.
     */
    const installCachedBoot = (state: HydratedState, cached: CachedBoot): void => {
      const connectionId = cached.connection.id;
      const before = state.projects.length;
      appendBackendSnapshot(state, { ...cached.snapshot, connectionId });
      const installedIds = new Set(state.projects.slice(before).map((project) => project.id));
      if (installedIds.size === 0) return;
      state.projects = state.projects.map((project) => {
        const treeId = installedIds.has(project.id) ? cached.activeTrees[project.id] : undefined;
        return treeId && treeId !== project.activeTreeId && project.trees.some((tree) => tree.id === treeId)
          ? { ...project, activeTreeId: treeId } : project;
      });
      const visible = state.projects.find((project) => project.id === preferredAtBoot && installedIds.has(project.id));
      if (cached.page && visible?.activeTreeId && visible.activeTreeId === cached.treeId) {
        const page = cached.page;
        const candidates = visible.chatIds.filter((nodeId) => {
          const node = state.nodes[nodeId];
          return !!node && !node.deletedAt && node.messagesLoaded === false && node.messages.length === 0
            && findTreeIdForNode(nodeId, visible) === visible.activeTreeId;
        });
        state.nodes = installMatchingPage(state.nodes, page, candidates, (nodeId, node) => pageShowable(page, nodeId, node)).nodes;
      }
      markBackendConnectionProvisional(connectionId);
      // What the remote's answer is merged against: the copy as shown now.
      const origin = { projects: new Map<string, Project>(), nodes: new Map<string, ChatNodeState>() };
      for (const project of state.projects) {
        if (!installedIds.has(project.id)) continue;
        origin.projects.set(project.id, project);
        for (const nodeId of project.chatIds) if (state.nodes[nodeId]) origin.nodes.set(nodeId, state.nodes[nodeId]);
      }
      cachedOrigins.set(connectionId, origin);
      // The live read takes the thread's remaining placeholders (it is newer than the copy).
      const view: HydratedState = { ...state, activeProjectId: visible?.id ?? state.activeProjectId };
      const settled = claimBootRead(connectionId, view, { fromCache: true });
      state.nodes = view.nodes;
      if (visible && settled) markRemoteFirstPaint(connectionId);
      console.info(`remote workspaces shown from the local copy (${cached.connection.name}) until it answers`);
    };
    /** A cached copy of the boot connection that its saved revision still vouches for. */
    const validCachedBoot = async (): Promise<CachedBoot | null> => {
      if (!bootConnectionId || !preferredAtBoot || !cache || !earlyConnections) return null;
      const cached = await cachedConnection;
      if (!cached?.snapshot || cancelled) return null;
      let timer: number | undefined;
      const connections = await Promise.race([
        earlyConnections,
        new Promise<undefined>((resolve) => { timer = window.setTimeout(() => resolve(undefined), CACHED_BOOT_DISCOVERY_WAIT_MS); }),
      ]);
      window.clearTimeout(timer);
      // Unknown (slow or failed list): no copy, the remote loads as it always has.
      if (!connections || cancelled) return null;
      const connection = connections.find((candidate) => candidate.id === bootConnectionId);
      if (!connection || connectionRevision(connection) !== cached.revision) {
        void cache.clearConnection(cacheUser, bootConnectionId);
        return null;
      }
      const treeId = bootTreeFor(cached, preferredAtBoot, bootConnectionId);
      const page = treeId ? await cache.readPage(cacheUser, bootConnectionId, cached.revision, preferredAtBoot, treeId) : null;
      return { connection, snapshot: cached.snapshot, activeTrees: cached.activeTrees, page, treeId };
    };
    const fetchRemoteSnapshot = async (
      connection: BackendConnectionSummary,
      logFailure = true,
    ): Promise<BackendSnapshot | null> => {
      if (!isCurrentConnection(connection)) return null;
      const controller = new AbortController();
      remoteControllers.set(connection.id, controller);
      let timedOut = false;
      const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, REMOTE_HYDRATION_TIMEOUT_MS);
      markRemoteRecoveryRetrying(connection.id);
      try {
        const workspaces = await fetchAllWorkspacesMeta(connection.id, controller.signal);
        if (!isCurrentConnection(connection) || controller.signal.aborted) return null;
        retryRequested.delete(connection.id);
        clearRemoteRecoveryIssue(connection.id);
        const snapshot: BackendSnapshot = { connectionId: connection.id, workspaces };
        keepRemoteCopy(connection, snapshot);
        return snapshot;
      } catch (err) {
        if (!isCurrentConnection(connection)) return null;
        const failure = timedOut ? new Error('The remote connection timed out while loading workspaces.') : err;
        reportRemoteRecoveryFailure(connection, failure);
        if (logFailure) console.warn(`remote backend unavailable (${connection.name}):`, failure);
        return null;
      } finally {
        window.clearTimeout(timer);
        if (remoteControllers.get(connection.id) === controller) remoteControllers.delete(connection.id);
      }
    };
    type RemoteFetchResult = { connection: BackendConnectionSummary; snapshot: BackendSnapshot | null };
    type RemoteDiscovery = { connections: BackendConnectionSummary[]; remoteFetches: Promise<RemoteFetchResult>[] };
    let remoteDiscovery: Promise<RemoteDiscovery> | null = null;
    const discoverRemotes = (): Promise<RemoteDiscovery> => remoteDiscovery ??= Promise.resolve().then(async () => {
      // A list taken early (boot on a remote workspace) is reused; a failed one is asked again.
      const connections = (earlyConnections && await earlyConnections)
        ?? (typeof listBackendConnections === 'function' ? await listBackendConnections().catch(() => []) : []);
      if (cancelled) return { connections: [], remoteFetches: [] };
      setKnownBackendConnections(connections);
      for (const connection of connections) {
        activeRemoteIds.add(connection.id);
        recordConnection(connection);
      }
      return { connections, remoteFetches: connections.map(async (connection): Promise<RemoteFetchResult> => ({
        connection, snapshot: await fetchRemoteSnapshot(connection),
      })) };
    });
    /**
     * Wait for the LOCAL backend only. Remote discovery and snapshot fetches start after local metadata
     * confirms the backend is ready (and overlap local state installation) but returned as pending promises: the
     * caller decides whether to block on them. In the measured real launch the
     * remote SSH tunnel spent the full 8s timeout before the retry succeeded in
     * 0.5s — holding the whole UI behind it turned a ~0.5s boot into ~8.5s.
     */
    const awaitLocalSnapshot = async (): Promise<{
      localWorkspaces: unknown[];
      remotes: Promise<RemoteDiscovery>;
    } | null> => {
      for (;;) {
        if (cancelled) return null;
        try {
          // Capability probe is advisory: we log a v2 mismatch but do not gate
          // on it. Sharing the same attempt as the workspace fetch keeps the
          // readiness signal single-sourced — if the backend is up enough to
          // answer /workspaces/all, we proceed.
          try {
            // Read here for this machine, so writes need not ask (batchLimitFor).
            batchLimitProbesRef.current.add(LOCAL_BACKEND_CONNECTION_ID);
            const capabilitiesPromise = fetchPersistenceCapabilities();
            void capabilitiesPromise.then((capabilities) => {
              // The local backend (and with it every remote's proxy) is up.
              resolveLocalReachable();
              // Server attention (and with it completion facts, completionFacts.ts).
              noteServerAttentionCapabilities(LOCAL_BACKEND_CONNECTION_ID, capabilities);
              learnCapabilities(advertisedBatchLimitRef.current, artifactWriteAnswersRef.current, LOCAL_BACKEND_CONNECTION_ID, capabilities);
              const v2Available =
                capabilities.protocolVersion >= 2
                && capabilities.authoritativeTurnPersistence
                && capabilities.durableNodePrerequisite
                && capabilities.explicitCommands
                && capabilities.backgroundWorkspaceSync === false;
              if (!v2Available) {
                console.warn('backend does not advertise the required persistence v2 capabilities');
              }
            }).catch(() => {
              // Advisory only. The meta request below is the readiness gate.
            });
          } catch {
            // A synchronous probe failure is advisory too. The workspace meta
            // request below remains the sole readiness signal.
          }
          // Meta mode: structure + per-node counts, NO message bodies. Bodies
          // for the active tree are eager-loaded below; other trees load on
          // demand when opened. This is what shrinks the boot payload from the
          // whole-forest 13MB to a ~structural fraction.
          const localWorkspaces = await fetchAllWorkspacesMeta(LOCAL_BACKEND_CONNECTION_ID);
          resolveLocalReachable();
          if (cancelled) return null;
          return { localWorkspaces, remotes: discoverRemotes() };
        } catch {
          if (cancelled) return null;
          // Connection-level failure: the backend is still starting. Wait and
          // retry — do NOT finalize as empty.
          await new Promise<void>((resolve) => window.setTimeout(resolve, HYDRATION_RETRY_DELAY_MS));
        }
      }
    };
    // Which project the window wanted on boot, and which one we auto-selected
    // in its place because it was not in the local snapshot (typically: the
    // window was last on a remote workspace). When that remote snapshot lands
    // and the user has not navigated away from the auto-selection, restore the
    // preference.
    let pendingPreferredActiveId: string | null = null;
    let autoSelectedActiveId: string | null = null;
    const openOnWorkspace = (projects: readonly Project[], preferred: string | null): string | null => {
      const { activeId, pendingPreferredId } = resolveOpenableWorkspace(projects, preferred);
      if (pendingPreferredId !== null) {
        pendingPreferredActiveId = pendingPreferredId;
        autoSelectedActiveId = activeId;
      }
      return activeId;
    };
    /** Hold `connectionId`'s metadata briefly for the boot read, as the local eager load holds first paint. */
    const waitForBootRead = async (connectionId: string): Promise<void> => {
      const read = await bootReadReady;
      if (!read || read.connectionId !== connectionId || read.done || read.claimed
        || pendingPreferredActiveId !== read.workspaceId || cachedOrigins.has(connectionId)) return;
      let timer: number | undefined;
      await Promise.race([
        read.promise.catch(() => {}),
        new Promise<void>((resolve) => { timer = window.setTimeout(resolve, ACTIVE_TREE_EAGER_BUDGET_MS); }),
      ]);
      window.clearTimeout(timer);
    };
    // Remote snapshots may resolve before the local state is installed. Merging
    // into projectsRef before that would be overwritten by the local install, so
    // remote merges wait on this barrier.
    let resolveLocalInstalled: () => void = () => {};
    const localInstalled = new Promise<void>((resolve) => { resolveLocalInstalled = resolve; });
    const applyRemoteSnapshot = (connection: BackendConnectionSummary, snapshot: BackendSnapshot, replace = true): void => {
      if (!isCurrentConnection(connection)) return;
      markBackendConnectionReady(connection.id);
      const projectsBefore = new Map(projectsRef.current.map((project) => [project.id, project] as const));
      const nodesBefore = nodesRef.current;
      const nextState: HydratedState = {
        projects: [...projectsRef.current],
        activeProjectId: activeProjectIdRef.current,
        nodes: { ...nodesRef.current },
      };
      // Shown from the local cache until now: the remote's answer replaces the
      // copy outright, keeping only what this window changed meanwhile.
      const origin = cachedOrigins.get(connection.id);
      const merge = origin ? mergeCachedSnapshot(nextState, snapshot, origin) : null;
      const changedProjects = merge
        ? merge.projects.length + origin!.projects.size
        : replace ? replaceBackendSnapshot(nextState, snapshot) : appendBackendSnapshot(nextState, snapshot);
      if (changedProjects > 0) {
        // The backend holds what the snapshot installs: the dirty scan takes
        // it as loaded, as hydration does, instead of writing it all back. A
        // workspace already in the store keeps its nodes' live state (and
        // with it any unsaved edit, which the node projections still see);
        // its trees and edges are the snapshot's now.
        const freshById = merge ? new Map(merge.fresh.projects.map((project) => [project.id, project] as const)) : null;
        for (const project of nextState.projects) {
          if (projectConnectionId(project) !== connection.id) continue;
          const before = projectsBefore.get(project.id);
          if (before === project) continue;
          if (merge) {
            const fresh = freshById!.get(project.id);
            if (!fresh) continue; // made here meanwhile: still to be written
            const nodeIds = new Set(project.chatIds);
            const treeIds = new Set(project.trees.map((tree) => tree.id));
            const edgeIds = new Set(project.edges.map(serializedEdgeId));
            // Everything the remote answered, except what this window changed:
            // that keeps being measured against the remote's row, so it is written.
            const base = origin!.projects.get(project.id);
            rememberBackendInstalled(backendInstalledRef.current, {
              projectId: project.id,
              newProject: !before,
              nodeIds: fresh.chatIds.filter((nodeId) => nodeIds.has(nodeId) && !merge.editedNodeIds.has(nodeId)),
              treeIds: fresh.trees.map((tree) => tree.id).filter((id) => treeIds.has(id) && !merge.localTreeIds.has(id)),
              edgeIds: fresh.edges.map(serializedEdgeId).filter((id) => edgeIds.has(id) && !merge.localEdgeIds.has(id)),
              contextIds: (fresh.artifacts ?? []).map((artifact) => artifact.id).filter((id) => !merge.localArtifactIds.has(id)),
              // Unchanged here (the thread on screen aside, unless picked meanwhile): the remote's row.
              workspaceRow: !!before && (!base || before.activeTreeId === base.activeTreeId)
                && workspaceRowKey({ ...project, activeTreeId: fresh.activeTreeId }) === workspaceRowKey(fresh),
            });
            const at = Date.now();
            for (const nodeId of fresh.chatIds) {
              if (merge.editedNodeIds.has(nodeId)) noteNodeBaseline(fresh, merge.fresh.nodes, nodeId, at);
            }
            continue;
          }
          rememberBackendInstalled(backendInstalledRef.current, {
            projectId: project.id,
            newProject: !before,
            nodeIds: before ? project.chatIds.filter((nodeId) => !nodesBefore[nodeId]) : project.chatIds,
            treeIds: project.trees.map((tree) => tree.id),
            edgeIds: project.edges.map(serializedEdgeId),
          });
        }
        const activeStillExists = nextState.projects.some(
          (project) => project.id === nextState.activeProjectId,
        );
        if (!activeStillExists) {
          nextState.activeProjectId = resolveOpenableWorkspace(nextState.projects, initialActiveProjectIdRef.current).activeId;
        } else if (
          pendingPreferredActiveId !== null
          && nextState.activeProjectId === autoSelectedActiveId
          && nextState.projects.some((project) => project.id === pendingPreferredActiveId)
        ) {
          nextState.activeProjectId = pendingPreferredActiveId;
          pendingPreferredActiveId = null;
          autoSelectedActiveId = null;
        }
        // The visible thread's first page, read alongside this metadata.
        const visibleSettled = claimBootRead(connection.id, nextState, { rereadNodeIds: merge?.rereadNodeIds });
        if (origin) {
          cachedOrigins.delete(connection.id);
          // Writes held for the copy go now, built from what the store holds.
          confirmBackendConnection(connection.id);
          dirtyRef.current = true;
        }
        projectsRef.current = nextState.projects;
        activeProjectIdRef.current = nextState.activeProjectId;
        setProjects(nextState.projects);
        setActiveProjectId(nextState.activeProjectId);
        installNodes(nextState.nodes);
        if (visibleSettled) markRemoteFirstPaint(connection.id);
        // Its workspace and tree rows are the backend's again.
        const loadedAt = Date.now();
        for (const project of nextState.projects) {
          if (projectConnectionId(project) !== connection.id) continue;
          // A kept edit is not the backend's yet: confirm what the remote answered.
          const confirmed = freshById ? freshById.get(project.id) : project;
          if (confirmed) confirmProjectRows(confirmed, loadedAt);
        }
        // Exactly what the snapshot holds (an appended snapshot keeps local work beside it).
        for (const project of merge ? merge.fresh.projects : hydrateBackendWorkspaces(snapshot.workspaces, null, connection.id).projects) {
          noteProjectHeld(heldSinceRef.current, project, loadedAt);
        }
      } else {
        if (origin) {
          cachedOrigins.delete(connection.id);
          confirmBackendConnection(connection.id);
        }
        // Nothing of it to show.
        markRemoteFirstPaint(connection.id);
      }
      console.info(`remote backend hydrated (${connection.name}); reconciled ${changedProjects} workspace(s)`);
    };
    const retryRemoteHydration = async (connection: BackendConnectionSummary, replace = true): Promise<void> => {
      if (!isCurrentConnection(connection) || retryingRemoteIds.get(connection.id) === connection) return;
      retryingRemoteIds.set(connection.id, connection);
      try {
        let retryDelay = REMOTE_HYDRATION_RETRY_INITIAL_MS;
        while (isCurrentConnection(connection)) {
          await waitForRemoteRetry(connection.id, retryDelay);
          if (!isCurrentConnection(connection)) return;

          const snapshot = await fetchRemoteSnapshot(connection, false);
          if (!isCurrentConnection(connection)) return;
          if (!snapshot) {
            retryDelay = Math.min(retryDelay * 2, REMOTE_HYDRATION_RETRY_MAX_MS);
            continue;
          }
          applyRemoteSnapshot(connection, snapshot, replace);
          return;
        }
      } finally {
        if (retryingRemoteIds.get(connection.id) === connection) retryingRemoteIds.delete(connection.id);
      }
    };
    const removeRemoteSnapshot = (connectionId: string): void => {
      // A cached copy goes with it; writes held for it are released (the connection refuses them now).
      cachedOrigins.delete(connectionId);
      confirmBackendConnection(connectionId);
      // What it advertised goes too, whether or not a workspace of it is shown:
      // an edited connection may point at another (older) machine.
      forgetCapabilities(connectionId, true);
      const removed = projectsRef.current.filter(project => project.backendConnectionId === connectionId
        || remoteEntityIdentity(project.id)?.connectionId === connectionId);
      if (removed.length === 0) return;
      const removedIds = new Set(removed.map(project => project.id));
      const nextProjects = projectsRef.current.filter(project => !removedIds.has(project.id));
      const nextNodes = { ...nodesRef.current };
      for (const project of removed) {
        dirtyDeltaByProjectRef.current.delete(project.id);
        pendingCommandDeltaByProjectRef.current.delete(project.id);
        dirtyProjectIdsRef.current.delete(project.id);
        syncStateRef.current.delete(project.id);
        lastSentRef.current.delete(project.id);
        dropNotice(project.id);
        for (const nodeId of project.chatIds) {
          delete nextNodes[nodeId];
          nodeCommandProjectionRef.current.delete(nodeId);
          confirmedNodeTitlesRef.current.delete(nodeId);
          nodeViewedAtRef.current.delete(nodeId);
          nodeSeenCompletionRef.current.delete(nodeId);
          dirtyDraftNodeIdsRef?.current.delete(nodeId);
        }
      }
      if (removedIds.has(activeProjectIdRef.current ?? '')) {
        pendingPreferredActiveId = activeProjectIdRef.current;
        // Never the assistant's hidden system workspace (see the boot resolution below).
        const nextActive = firstLiveUserWorkspaceId(nextProjects);
        autoSelectedActiveId = nextActive;
        activeProjectIdRef.current = nextActive;
        setActiveProjectId(nextActive);
      }
      projectsRef.current = nextProjects;
      setProjects(nextProjects);
      installNodes(nextNodes);
    };
    const onRemoteUnavailable = (event: Event) => {
      const connectionId = (event as CustomEvent<{ connectionId: string }>).detail?.connectionId;
      if (!activeRemoteIds.has(connectionId)) return;
      // Keep the visible snapshot and its pane identity while offline. The
      // connection-state barrier rejects writes until metadata answers again.
      // Only explicit connection removal clears these cached entities below.
      const connection = connectionRecords.get(connectionId);
      if (connection) void retryRemoteHydration(connection);
    };
    window.addEventListener(BACKEND_CONNECTION_UNAVAILABLE, onRemoteUnavailable);
    const mergeRemoteWhenReady = async (fetch: Promise<RemoteFetchResult>, replace = true): Promise<void> => {
      const { connection, snapshot } = await fetch;
      await localInstalled;
      if (snapshot) await waitForBootRead(connection.id);
      if (!isCurrentConnection(connection)) return;
      if (snapshot) {
        applyRemoteSnapshot(connection, snapshot, replace);
        return;
      }
      // Nothing visible comes from it unless the window waits for one of its workspaces.
      const active = projectsRef.current.find((project) => project.id === activeProjectIdRef.current);
      if ((!active || projectConnectionId(active) !== connection.id) && remoteConnectionOf(pendingPreferredActiveId) !== connection.id) {
        markRemoteFirstPaint(connection.id);
      }
      void retryRemoteHydration(connection, replace);
    };
    // New or edited connections load immediately. Unchanged saved records keep
    // their live history; a new target/credential revision gets a fresh cache.
    const knownConnectionIds = new Set<string>();
    let refreshingConnections = false;
    const onConnectionsChanged = async () => {
      if (refreshingConnections) return;
      refreshingConnections = true;
      try {
        await localInstalled;
        await discoverRemotes(); // A late initial list must not restore a removed connection.
        if (cancelled) return;
        const connections = await listBackendConnections();
        if (cancelled) return;
        setKnownBackendConnections(connections);
        const currentIds = new Set(connections.map(connection => connection.id));
        for (const id of activeRemoteIds) {
          const next = connections.find(connection => connection.id === id);
          const previous = connectionRecords.get(id);
          if (currentIds.has(id) && previous && next && connectionRevision(previous) === connectionRevision(next)) continue;
          activeRemoteIds.delete(id); knownConnectionIds.delete(id); retryRequested.delete(id);
          connectionRecords.delete(id);
          connectionRevisionsRef.current.delete(id);
          // Invalidate even when already offline: an old HTTP response or SSE
          // frame must not land in the replacement machine's identical IDs.
          markBackendConnectionUnavailable(id, true);
          remoteControllers.get(id)?.abort(); retryWaiters.get(id)?.(); clearRemoteRecoveryIssue(id);
          if (bootRead?.connectionId === id) bootRead.controller.abort();
          removeRemoteSnapshot(id);
          // Nothing kept or painted for the old target carries over.
          resetRemoteFirstPaint(id);
          void cache?.clearConnection(cacheUser, id);
        }
        for (const connection of connections) {
          activeRemoteIds.add(connection.id);
          if (knownConnectionIds.has(connection.id)) continue;
          knownConnectionIds.add(connection.id);
          recordConnection(connection);
          void mergeRemoteWhenReady((async () => ({ connection, snapshot: await fetchRemoteSnapshot(connection) }))(), false);
        }
      } catch { /* keep current workspaces when a connection refresh fails */ }
      finally { refreshingConnections = false; }
    };
    window.addEventListener('michi:backend-connections-changed', onConnectionsChanged);
    (async () => {
      try {
        const localResult = await awaitLocalSnapshot();
        if (cancelled || localResult === null) return;
        const { localWorkspaces, remotes } = localResult;
        // A window last on a remote workspace opens on its cached copy (read-only)
        // rather than on a local workspace while the remote is asked.
        const cachedBoot = await validCachedBoot();
        if (cancelled) return;
        const snapshots: BackendSnapshot[] = [
          { connectionId: LOCAL_BACKEND_CONNECTION_ID, workspaces: localWorkspaces },
        ];
        const unavailableConnections: BackendConnectionSummary[] = [];
        if (localWorkspaces.length === 0 && !cachedBoot) {
          const { connections, remoteFetches } = await remotes;
          for (const connection of connections) knownConnectionIds.add(connection.id);
          // Remote-only setup: the local DB has nothing to paint, so finishing
          // now would flash the empty-DB "create a workspace" state and then
          // pop the remote workspaces in. Block on the remotes (bounded by
          // REMOTE_HYDRATION_TIMEOUT_MS each) exactly as before.
          for (const result of await Promise.all(remoteFetches)) {
            if (result.snapshot) snapshots.push(result.snapshot);
            else unavailableConnections.push(result.connection);
          }
        } else {
          // Local-first: paint as soon as the local backend answers. Each remote
          // snapshot merges in when it lands (or enters the retry loop).
          void remotes.then(({ connections, remoteFetches }) => {
            if (cancelled) return;
            for (const connection of connections) knownConnectionIds.add(connection.id);
            for (const fetch of remoteFetches) void mergeRemoteWhenReady(fetch);
          });
        }
        if (cancelled) return;
        const backendState: HydratedState = { projects: [], activeProjectId: null, nodes: {} };
        for (const snapshot of snapshots) {
          appendBackendSnapshot(backendState, snapshot);
          markBackendConnectionReady(snapshot.connectionId);
        }
        if (cachedBoot) installCachedBoot(backendState, cachedBoot);
        if (backendState.projects.length > 0) {
            const resolvedActiveId = openOnWorkspace(backendState.projects, resolveActiveProjectForWindow(initialActiveProjectIdRef.current));
            backendState.activeProjectId = resolvedActiveId;
            // Eager-load the active workspace's active tree so first paint shows
            // real messages, not placeholders — but only within a bounded budget.
            // Past the budget, the tree stays placeholder and the lazy loader
            // fills it in; a slow tree must not hold the whole UI. Best-effort: a
            // failure here likewise falls through to the on-demand path.
            const activeProject = backendState.projects.find((p) => p.id === resolvedActiveId);
            const activeConnection = activeProject ? projectConnectionId(activeProject) : LOCAL_BACKEND_CONNECTION_ID;
            const remoteActive = activeConnection !== LOCAL_BACKEND_CONNECTION_ID;
            let nodes = backendState.nodes;
            // A cached copy already shows what it has (installCachedBoot).
            if (activeProject?.activeTreeId && !backendConnectionProvisional(activeConnection)) {
              let budgetTimer: number | undefined;
              const budget = new Promise<null>((resolve) => {
                budgetTimer = window.setTimeout(() => resolve(null), ACTIVE_TREE_EAGER_BUDGET_MS);
              });
              const boot = remoteActive ? await bootReadReady : null;
              try {
                if (boot && boot.connectionId === activeConnection && !boot.claimed) {
                  // Read since boot: in with the metadata, or handed to the read pool.
                  await Promise.race([boot.promise.catch(() => null), budget]);
                  if (cancelled) return;
                  if (claimBootRead(activeConnection, backendState)) markRemoteFirstPaint(activeConnection);
                  nodes = backendState.nodes;
                } else {
                  const rows = await Promise.race([
                    remoteActive
                      ? fetchRemoteTreeFirstPage(activeProject.id, activeProject.activeTreeId, activeConnection)
                      : fetchTreeMessageSnapshot(activeProject.id, activeProject.activeTreeId, activeProject.backendConnectionId),
                    budget,
                  ]);
                  if (cancelled) return;
                  if (rows !== null) {
                    const byNode = buildMessagesByNode(rows.messages);
                    nodes = applyTreeMessages(nodes, byNode, rows.pages, rows.turns);
                    if (remoteActive) markRemoteFirstPaint(activeConnection);
                  } else {
                    console.info('active tree eager-load exceeded budget; deferring to lazy loader');
                  }
                }
              } catch {
                // active tree stays placeholder → loads on first open.
              } finally {
                if (budgetTimer !== undefined) window.clearTimeout(budgetTimer);
              }
            }
            setProjects(backendState.projects);
            projectsRef.current = backendState.projects;
            setActiveProjectId(resolvedActiveId);
            activeProjectIdRef.current = resolvedActiveId;
            installNodes(nodes);
            // Loaded from the backend (unlike the localStorage fallbacks
            // below, and a cached copy, which the backend has not confirmed).
            for (const project of backendState.projects) {
              if (!backendConnectionProvisional(projectConnectionId(project))) noteProjectHeld(heldSinceRef.current, project, 0);
            }
            clearDurableLocalStorageMirror(storageKeyRef.current);
            finishHydration('backend');
        } else {
          // Backend has no workspaces for this user. Michi has always shipped
          // with the SQLite backend, so there is no pre-SQLite localStorage
          // corpus to migrate — this path just hydrates from whatever local
          // payload exists (offline/fresh-install fallback) or lands empty.
          const payload = readLocalStoragePayload(userId);
          const lsState = payload ? hydrateSavedState(payload) : EMPTY_HYDRATED;
          if (lsState.projects.length > 0) {
            if (cancelled) return;
            setProjects(lsState.projects);
            projectsRef.current = lsState.projects;
            const resolvedActiveId = openOnWorkspace(lsState.projects, resolveActiveProjectForWindow(lsState.activeProjectId));
            setActiveProjectId(resolvedActiveId);
            activeProjectIdRef.current = resolvedActiveId;
            installNodes(lsState.nodes);
          }
          if (!cancelled) finishHydration(lsState.projects.length > 0 ? 'localStorage' : 'empty');
        }
        resolveLocalInstalled();
        for (const connection of unavailableConnections) {
          void retryRemoteHydration(connection);
        }
      } catch {
        if (!cancelled) {
          const lsState = readLocalStorageState(userId);
          setProjects(lsState.projects);
          projectsRef.current = lsState.projects;
          const resolvedActiveId = openOnWorkspace(lsState.projects, resolveActiveProjectForWindow(lsState.activeProjectId));
          setActiveProjectId(resolvedActiveId);
          activeProjectIdRef.current = resolvedActiveId;
          installNodes(lsState.nodes);
          finishHydration('fallbackLocalStorage');
        }
        resolveLocalInstalled();
      }
    })();
    return () => {
      cancelled = true;
      resolveLocalInstalled();
      if (bootRead && !bootRead.claimed) bootRead.controller.abort();
      // Nothing is left waiting on a copy this run showed.
      for (const connectionId of cachedOrigins.keys()) confirmBackendConnection(connectionId);
      cachedOrigins.clear();
      for (const controller of remoteControllers.values()) controller.abort();
      for (const wake of retryWaiters.values()) wake();
      for (const id of activeRemoteIds) clearRemoteRecoveryIssue(id);
      window.removeEventListener(REMOTE_WORKSPACE_RETRY_EVENT, onRetryRemote);
      window.removeEventListener(BACKEND_CONNECTION_UNAVAILABLE, onRemoteUnavailable);
      window.removeEventListener('michi:backend-connections-changed', onConnectionsChanged);
    };
  }, [nodesRef, setActiveProjectId, setHydrated, setNodes, setProjects, userId]);

  // This user's thread per remote workspace: the next boot reads it first.
  const activeProjectNow = projects.find((project) => project.id === activeProjectId);
  const activeRemoteTreeId = hydrated && activeProjectNow && projectConnectionId(activeProjectNow) !== LOCAL_BACKEND_CONNECTION_ID
    ? activeProjectNow.activeTreeId : null;
  useEffect(() => {
    const cache = remoteCacheRef.current;
    const project = projectsRef.current.find((candidate) => candidate.id === activeProjectId);
    if (!cache || !project || !activeRemoteTreeId) return;
    const connectionId = projectConnectionId(project);
    const revision = connectionRevisionsRef.current.get(connectionId);
    if (revision) void cache.noteActiveTree(userIdRef.current, connectionId, revision, project.id, activeRemoteTreeId);
  }, [activeProjectId, activeRemoteTreeId]);

  // A remote in the store whose workspace is not the one on screen has no
  // visible conversation to wait for: its boot barrier opens.
  const remoteConnectionKey = useMemo(() => [...new Set(projects.map(projectConnectionId))]
    .filter((id) => id !== LOCAL_BACKEND_CONNECTION_ID).sort().join('|'), [projects]);
  useEffect(() => {
    if (!hydrated || !remoteConnectionKey) return;
    const active = projectsRef.current.find((project) => project.id === activeProjectId);
    const visible = active ? projectConnectionId(active) : null;
    for (const connectionId of remoteConnectionKey.split('|')) {
      if (connectionId !== visible) markRemoteFirstPaint(connectionId);
    }
  }, [hydrated, activeProjectId, remoteConnectionKey]);

  /** A remote tree's first page was read (the tree read pool reports each): kept for the next boot. */
  const noteRemoteTreePage = useCallback((project: Project, treeId: string, page: TreeMessagePage) => {
    noteRemoteTreePageRef.current(project.backendConnectionId, project.id, treeId, page);
  }, []);

  /**
   * Call right before putting a backend snapshot into the store: the next
   * dirty scan takes these entities as loaded rather than as local edits.
   */
  const noteBackendInstalled = useCallback((installed: BackendInstalledEntities) => {
    rememberBackendInstalled(backendInstalledRef.current, installed);
  }, []);

  /**
   * Trees, edges and artifacts removed from `current` (the store's workspace
   * as it is now) that a backend snapshot whose read began at `readStartedAt`
   * may still hold: removed since the last scan, waiting in a command batch,
   * or confirmed by the backend at or after that start (a read begun later
   * already saw the delete, so what it holds is back for real). An unknown
   * start counts every confirmed delete still remembered. Artifacts count
   * only until confirmed (PendingBackendDeletes.contextIds).
   */
  const pendingBackendDeletes = useCallback((current: Project, readStartedAt?: number): PendingBackendDeletes => {
    const treeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const contextIds = new Set<string>();
    for (const delta of [dirtyDeltaByProjectRef.current.get(current.id), pendingCommandDeltaByProjectRef.current.get(current.id)]) {
      delta?.treeDeleteIds.forEach((id) => treeIds.add(id));
      delta?.edgeDeleteIds.forEach((id) => edgeIds.add(id));
      delta?.contextDeleteIds.forEach((id) => contextIds.add(id));
    }
    const scanned = prevProjectsRef.current.find((p) => p.id === current.id);
    if (scanned && scanned !== current) {
      const trees = new Set(current.trees.map((tree) => tree.id));
      for (const tree of scanned.trees) if (!trees.has(tree.id)) treeIds.add(tree.id);
      const edges = new Set(current.edges.map(serializedEdgeId));
      for (const edge of scanned.edges) {
        const id = serializedEdgeId(edge);
        if (!edges.has(id)) edgeIds.add(id);
      }
      const contexts = new Set((current.artifacts ?? []).map((context) => context.id));
      for (const context of scanned.artifacts ?? []) if (!contexts.has(context.id)) contextIds.add(context.id);
    }
    const confirmed = confirmedDeletesRef.current.get(current.id);
    if (confirmed) {
      for (const [ids, into] of [[confirmed.trees, treeIds], [confirmed.edges, edgeIds], [confirmed.contexts, contextIds]] as const) {
        for (const [id, at] of ids) if (readStartedAt === undefined || at >= readStartedAt) into.add(id);
      }
    }
    return { treeIds, edgeIds, contextIds };
  }, []);

  /**
   * Call right before putting a structure re-read into the store (see
   * structureSync): the scan that renders it rebases the dirty baseline onto
   * it, so it is never written back.
   */
  const adoptBackendStructure = useCallback((adoption: StructureAdoption) => {
    structureAdoptionsRef.current.push({ adoption, misses: 0 });
  }, []);

  /** What a structure re-read may overwrite (see StructureEditGuards). */
  const structureGuards = useMemo<StructureEditGuards>(() => ({
    workspaceFieldEdited: (project, field, readStartedAt) => fieldEdited(
      confirmedWorkspaceFieldsRef.current.get(project.id), field, serializeWorkspaceRow(project)[field], readStartedAt,
    ),
    treeFieldEdited: (project, tree, field, readStartedAt) => fieldEdited(
      confirmedTreeFieldsRef.current.get(tree.id), field, serializeTreeRow(project, tree)[field], readStartedAt,
    ),
    nodeFieldEdited: (project, nodes, nodeId, field, readStartedAt) => {
      const row = serializeNodeRow(project, nodes, nodeId);
      if (!row) return false;
      const value = (row as Record<string, unknown>)[field];
      // A title this window set (a rename, a derived or digest title) is its
      // edit until the backend confirms that value, as in a replay-gap
      // reconcile; saves trail the edit by seconds, a re-read by 150ms.
      if (field === 'title' && nodes[nodeId]?.titleNeedsPersistence) {
        const confirmed = confirmedNodeTitlesRef.current.get(nodeId);
        return !confirmed || confirmed.value !== value || confirmed.at > readStartedAt;
      }
      const known = nodeCommandProjectionRef.current.get(nodeId);
      // Made here and never confirmed (not saved yet): every field is this window's.
      if (!known) return true;
      const projection = JSON.parse(known) as Record<string, unknown>;
      // A field this window never writes (a title it did not rename) is never its edit.
      if (!(field in projection)) return false;
      return value !== projection[field]
        || (nodeProjectionAtRef.current.get(nodeId) ?? 0) > readStartedAt;
    },
    pendingDeletes: (project, readStartedAt) => pendingBackendDeletes(project, readStartedAt),
    pendingEdgeUpserts: (project, readStartedAt) => {
      const ids = new Set<string>();
      for (const delta of [dirtyDeltaByProjectRef.current.get(project.id), pendingCommandDeltaByProjectRef.current.get(project.id)]) {
        delta?.edgeUpsertIds.forEach((id) => ids.add(id));
      }
      const scanned = prevProjectsRef.current.find((p) => p.id === project.id);
      if (scanned !== project) {
        const before = new Set((scanned?.edges ?? []).map(serializedEdgeId));
        for (const edge of project.edges) {
          const id = serializedEdgeId(edge);
          if (!before.has(id)) ids.add(id);
        }
      }
      for (const [id, at] of confirmedEdgeUpsertsRef.current.get(project.id) ?? []) if (at >= readStartedAt) ids.add(id);
      return ids;
    },
    heldByBackendBefore: (entity, id, readStartedAt) => {
      const since = heldSinceRef.current.get(`${entity}:${id}`);
      return since !== undefined && since <= readStartedAt;
    },
  }), [pendingBackendDeletes]);

  /** True while this window may have a write to these workspaces in flight. */
  const workspacesBusy = useCallback((projectIds: Iterable<string>): boolean => {
    if (syncPausedRef?.current) return true;
    const queue = workspaceSyncQueueRef.current!;
    for (const id of projectIds) if (queue.isInFlight(id)) return true;
    return false;
  }, [syncPausedRef]);

  /** Resolve once no write of this window to these workspaces is in flight. */
  const whenWorkspacesSettled = useCallback(async (projectIds: Iterable<string>, signal?: AbortSignal): Promise<void> => {
    const ids = [...projectIds];
    const queue = workspaceSyncQueueRef.current!;
    while (workspacesBusy(ids)) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (syncPausedRef?.current) await sleep(50);
      else await Promise.all(ids.map((id) => queue.whenIdle(id)));
    }
  }, [syncPausedRef, workspacesBusy]);

  return {
    runWorkspaceMutation,
    noteRemoteTreePage,
    noteBackendInstalled,
    pendingBackendDeletes,
    noteArtifactNamed,
    probeArtifacts,
    noteConnectionRecovered,
    adoptBackendStructure,
    structureGuards,
    workspacesBusy,
    whenWorkspacesSettled,
  };
}
