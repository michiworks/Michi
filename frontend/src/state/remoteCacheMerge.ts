import type { LeanNodeField } from 'michi-shared';
import type { TreeMessagePage } from '../services/api';
import { applyTreeMessages, buildMessagesByNode, isNodeFieldDeferred } from './chatHydration';
import type { ChatNodeState, Project } from './chatTypes';
import { serializedEdgeId } from './edgeIds';

/**
 * Replacing a remote's cached copy (shown read-only at boot) with what the
 * remote itself answered.
 *
 * Three versions meet: the copy as the cache installed it (`origin`), the
 * store now (`held`: the copy plus what this window did since) and the fresh
 * metadata (`fresh`). The fresh metadata wins everywhere this window did not
 * change anything since the install, so nothing cached survives it; what this
 * window changed (a draft, a rename, a navigation, a send, a page the loader
 * read) is kept, and is written once the connection is confirmed.
 *
 * A node's messages and turn state move as one group: kept whole when any of
 * it changed here, else taken from the remote. Cached messages that still
 * match the remote's count and latest turn stay on screen; ones that do not
 * are marked to be read again (shown meanwhile unless a turn is running).
 *
 * Lean fields the remote's answer leaves to the thread's page
 * (shared/leanNodeFields) follow the same rule: one set here is this
 * window's, written like any edit; one the copy filled from its cached page
 * stays deferred (never written), its value (overview entries aside) on
 * screen until the page, read again for it, brings the remote's.
 *
 * Trees, edges and artifacts keep what this window changed field by field:
 * a tree touched here takes the remote's name and archive state with it.
 */

/** Node fields a page, a turn or a send sets: they travel together. */
const MESSAGE_STATE_KEYS = new Set<string>([
  'messages', 'messagesLoaded', 'historyBefore', 'olderMessageCount', 'messageCount',
  'status', 'activeTurnId', 'cancelPhase', 'compacting', 'runtimeActivity', 'streamingStartedAt', 'streamingIdleMs',
  'visibleResponseComplete', 'backgroundTurnAssistantId',
  'error', 'errorKind', 'errorTurnId', 'errorRecovery', 'errorRecoverable', 'errorCompletedAt',
  'lastAppliedTurnId', 'lastAppliedSeq', 'lastAppliedBackgroundTurnId', 'lastAppliedBackgroundSeq',
  'completionSeq', 'lastCompletedAt', 'lastCompletedTurnId',
  'pendingPermission', 'pendingUserInput', 'subagents', 'usageSummary', 'contextUsagePercentage', 'lastAssistantAt',
]);

/** The node state each lean field sets (chatHydration leanFieldState). */
const LEAN_FIELD_STATE_KEYS: Readonly<Record<LeanNodeField, readonly string[]>> = {
  branch_overview: ['branchOverview', 'branchOverviewEntries'],
  follow_ups: ['followUps', 'followUpsSourceMessageId'],
  composer_draft: ['composerDraft', 'pendingSpawnPrompt'],
};

/**
 * What the copy shows of a lean field the remote deferred, until the page
 * lands. Not the spawn outbox: the remote keeps a pending one in its rows, so
 * a deferred draft has none. Not overview entries: ones a deferred node holds
 * join the stored ones when the page lands, as entries that streamed in.
 */
const LEAN_FIELD_SHOWN_KEYS: Readonly<Record<LeanNodeField, readonly string[]>> = {
  branch_overview: [],
  follow_ups: ['followUps', 'followUpsSourceMessageId'],
  composer_draft: ['composerDraft'],
};

/** Project fields merged by entity rather than taken whole. */
const PROJECT_COLLECTIONS = new Set<string>(['chatIds', 'trees', 'edges', 'artifacts', 'activeTreeId', 'id', 'backendConnectionId']);

export interface CachedOrigin {
  projects: ReadonlyMap<string, Project>;
  nodes: ReadonlyMap<string, ChatNodeState>;
}

export interface CacheMergeResult {
  projects: Project[];
  nodes: Record<string, ChatNodeState>;
  /** The connection's projects and nodes exactly as the remote answered (the saved baseline). */
  fresh: { projects: Project[]; nodes: Record<string, ChatNodeState> };
  /** Nodes keeping a change made here since the install (their saved baseline is the fresh row). */
  editedNodeIds: Set<string>;
  /** Trees, edges (serialized ids) and artifacts this window created or changed since the install. */
  localTreeIds: Set<string>;
  localEdgeIds: Set<string>;
  localArtifactIds: Set<string>;
  /** Nodes whose cached messages no longer match the remote: read them again. */
  rereadNodeIds: Set<string>;
}

type Keyed = Record<string, unknown>;

/**
 * Fresh items, minus what this window removed, with what it added. One it
 * changed takes the fields it changed over the fresh item, never the copy's
 * other fields (a touch would otherwise write a stale name back).
 */
function mergeById<T>(base: readonly T[], mine: readonly T[], fresh: readonly T[], id: (item: T) => string, local: Set<string>): T[] {
  const baseById = new Map(base.map((item) => [id(item), item] as const));
  const mineById = new Map(mine.map((item) => [id(item), item] as const));
  const freshIds = new Set(fresh.map(id));
  const out: T[] = [];
  for (const item of fresh) {
    const key = id(item);
    const kept = mineById.get(key);
    const was = baseById.get(key);
    if (was && !kept) continue; // removed here; that delete is still to be written
    const changed = kept && was && kept !== was ? changedKeys(was as Keyed, kept as Keyed) : [];
    if (changed.length > 0) {
      const merged = { ...item } as Keyed;
      for (const field of changed) merged[field] = (kept as Keyed)[field];
      out.push(merged as T);
      local.add(key);
    } else {
      out.push(item);
    }
  }
  for (const item of mine) {
    const key = id(item);
    if (!baseById.has(key) && !freshIds.has(key)) {
      out.push(item);
      local.add(key);
    }
  }
  return out;
}

function mergeIds(base: readonly string[], mine: readonly string[], fresh: readonly string[]): string[] {
  const baseIds = new Set(base);
  const mineIds = new Set(mine);
  const freshIds = new Set(fresh);
  return [
    ...fresh.filter((id) => !(baseIds.has(id) && !mineIds.has(id))),
    ...mine.filter((id) => !baseIds.has(id) && !freshIds.has(id)),
  ];
}

function changedKeys(base: Keyed, mine: Keyed): string[] {
  return [...new Set([...Object.keys(base), ...Object.keys(mine)])].filter((key) => base[key] !== mine[key]);
}

/** The cached messages answer for the remote's node: same count, same latest turn, no turn running. */
function cachedMessagesMatch(cached: ChatNodeState, fresh: ChatNodeState): boolean {
  return cached.status !== 'streaming' && fresh.status !== 'streaming'
    && (cached.messageCount ?? cached.messages.length) === (fresh.messageCount ?? 0)
    && (cached.lastAppliedTurnId ?? null) === (fresh.lastAppliedTurnId ?? null);
}

function mergeNode(base: ChatNodeState, mine: ChatNodeState, fresh: ChatNodeState): {
  node: ChatNodeState; edited: boolean; reread: boolean;
} {
  const changed = changedKeys(base as unknown as Keyed, mine as unknown as Keyed);
  const out = { ...fresh } as unknown as Keyed;
  const own = mine as unknown as Keyed;
  let edited = false;
  for (const key of changed) {
    if (MESSAGE_STATE_KEYS.has(key) || key === 'deferredNodeFields') continue;
    out[key] = own[key];
    edited = true;
  }
  // Lean fields the remote's answer left out. One set here over the copy (a
  // draft typed) is this window's now: no longer deferred, so it is written.
  // One still deferred here stays so (overview entries that streamed in join
  // the stored ones when the page lands). One the copy filled from its cached
  // page waits for the page again: shown, never written.
  const deferred = (fresh.deferredNodeFields ?? []).filter((field) => isNodeFieldDeferred(mine, field)
    || !LEAN_FIELD_STATE_KEYS[field].some((key) => changed.includes(key)));
  if (deferred.length > 0) out.deferredNodeFields = deferred;
  else delete out.deferredNodeFields;
  const owed = deferred.filter((field) => !isNodeFieldDeferred(mine, field));
  for (const field of owed) for (const key of LEAN_FIELD_SHOWN_KEYS[field]) out[key] = own[key];
  if (changed.some((key) => MESSAGE_STATE_KEYS.has(key))) {
    // A send, a stream or a page read here: the window's messages are live.
    for (const key of MESSAGE_STATE_KEYS) out[key] = own[key];
    out.messageCount = Math.max(fresh.messageCount ?? 0, mine.messageCount ?? mine.messages.length);
    return { node: out as unknown as ChatNodeState, edited, reread: false };
  }
  if (mine.messages.length === 0) return { node: out as unknown as ChatNodeState, edited, reread: false };
  if (cachedMessagesMatch(mine, fresh) && owed.length === 0) {
    for (const key of MESSAGE_STATE_KEYS) out[key] = own[key];
    return { node: out as unknown as ChatNodeState, edited, reread: false };
  }
  // The remote moved on, or its answer leaves fields to the page the copy
  // filled them from. A running turn reloads from its checkpoint (and
  // reattaches); otherwise the cached messages stay up until the re-read lands.
  if (fresh.status !== 'streaming') {
    out.messages = mine.messages;
    out.messagesLoaded = false;
    out.historyBefore = undefined;
    out.olderMessageCount = undefined;
  }
  return { node: out as unknown as ChatNodeState, edited, reread: true };
}

/**
 * Merge `fresh` (the connection's projects and nodes as just answered) over
 * `held` (the store's projects and nodes for that connection) given the
 * cached `origin`. Projects the remote no longer has are gone; ones this
 * window created meanwhile stay.
 */
export function mergeFreshOverCached(
  origin: CachedOrigin,
  held: { projects: readonly Project[]; nodes: Readonly<Record<string, ChatNodeState>> },
  fresh: { projects: readonly Project[]; nodes: Readonly<Record<string, ChatNodeState>> },
): CacheMergeResult {
  const result: CacheMergeResult = {
    projects: [], nodes: {}, fresh: { projects: [...fresh.projects], nodes: { ...fresh.nodes } },
    editedNodeIds: new Set(), localTreeIds: new Set(), localEdgeIds: new Set(), localArtifactIds: new Set(), rereadNodeIds: new Set(),
  };
  const heldById = new Map(held.projects.map((project) => [project.id, project] as const));
  const freshIds = new Set(fresh.projects.map((project) => project.id));
  const placeNode = (nodeId: string) => {
    const freshNode = fresh.nodes[nodeId];
    const mine = held.nodes[nodeId];
    const base = origin.nodes.get(nodeId);
    if (!freshNode) {
      // Made here meanwhile (the remote has not heard of it yet).
      if (mine && !base) result.nodes[nodeId] = mine;
      return;
    }
    if (!mine || !base) {
      result.nodes[nodeId] = freshNode;
      return;
    }
    const merged = mergeNode(base, mine, freshNode);
    result.nodes[nodeId] = merged.node;
    if (merged.edited) result.editedNodeIds.add(nodeId);
    if (merged.reread) result.rereadNodeIds.add(nodeId);
  };

  for (const freshProject of fresh.projects) {
    const mine = heldById.get(freshProject.id);
    const base = origin.projects.get(freshProject.id);
    let project = freshProject;
    if (mine && base) {
      const out = { ...freshProject } as unknown as Keyed;
      const own = mine as unknown as Keyed;
      for (const key of changedKeys(base as unknown as Keyed, own)) {
        if (!PROJECT_COLLECTIONS.has(key)) out[key] = own[key];
      }
      const merged = out as unknown as Project;
      merged.trees = mergeById(base.trees, mine.trees, freshProject.trees, (tree) => tree.id, result.localTreeIds);
      merged.edges = mergeById(base.edges, mine.edges, freshProject.edges, serializedEdgeId, result.localEdgeIds);
      merged.artifacts = mergeById(base.artifacts ?? [], mine.artifacts ?? [], freshProject.artifacts ?? [],
        (artifact) => artifact.id, result.localArtifactIds);
      merged.chatIds = mergeIds(base.chatIds, mine.chatIds, freshProject.chatIds);
      // The thread on screen stays on screen while it still exists.
      merged.activeTreeId = merged.trees.some((tree) => tree.id === mine.activeTreeId)
        ? mine.activeTreeId : freshProject.activeTreeId;
      project = merged;
    }
    result.projects.push(project);
    for (const nodeId of project.chatIds) placeNode(nodeId);
  }
  // A workspace made here meanwhile, on this connection.
  for (const mine of held.projects) {
    if (freshIds.has(mine.id) || origin.projects.has(mine.id)) continue;
    result.projects.push(mine);
    for (const nodeId of mine.chatIds) if (held.nodes[nodeId]) result.nodes[nodeId] = held.nodes[nodeId];
  }
  return result;
}

function turnRowFor(page: TreeMessagePage, nodeId: string): Record<string, unknown> | undefined {
  return page.turns?.find((row): row is Record<string, unknown> =>
    !!row && typeof row === 'object' && (row as Record<string, unknown>).node_id === nodeId);
}

/** A first page that matches the node the remote's metadata describes, with no turn running. */
export function pageMatchesNode(page: TreeMessagePage, nodeId: string, node: ChatNodeState | undefined): boolean {
  const bounds = page.pages?.find((item) => item.nodeId === nodeId);
  if (!bounds || !node || node.status === 'streaming') return false;
  const turn = turnRowFor(page, nodeId);
  if (turn?.status === 'active') return false;
  if (turn && (node.lastAppliedTurnId ?? null) !== (turn.turn_id ?? null)) return false;
  return bounds.total === (node.messageCount ?? 0);
}

/**
 * A page worth showing on a node whatever its count says (a cached copy, or a
 * read newer than the copy): it covers the node and no turn is running in
 * either (a running turn reloads from its checkpoint and reattaches).
 */
export function pageShowable(page: TreeMessagePage, nodeId: string, node: ChatNodeState | undefined): boolean {
  if (!node || node.status === 'streaming' || !page.pages?.some((item) => item.nodeId === nodeId)) return false;
  return turnRowFor(page, nodeId)?.status !== 'active';
}

/** A page read before the metadata that misses what the metadata already counts. */
export function pageBehindNodes(page: TreeMessagePage, nodes: ReadonlyMap<string, Pick<ChatNodeState, 'messageCount' | 'lastAppliedTurnId'>>): boolean {
  if (!page.pages) return true;
  return page.pages.some((bounds) => {
    const node = nodes.get(bounds.nodeId);
    if (!node) return false;
    const turn = turnRowFor(page, bounds.nodeId);
    return bounds.total < (node.messageCount ?? 0)
      || (!!turn && !!node.lastAppliedTurnId && turn.turn_id !== node.lastAppliedTurnId);
  });
}

/**
 * Install `page`'s messages on the candidates it matches (pageMatchesNode),
 * the way a lazy tree load would. Returns the nodes and which were installed.
 */
export function installMatchingPage(
  nodes: Record<string, ChatNodeState>,
  page: TreeMessagePage,
  candidateIds: readonly string[],
  matches: (nodeId: string, node: ChatNodeState) => boolean = (nodeId, node) => pageMatchesNode(page, nodeId, node),
): { nodes: Record<string, ChatNodeState>; installed: string[] } {
  const byNode = buildMessagesByNode(page.messages);
  const installed = candidateIds.filter((nodeId) => {
    const node = nodes[nodeId];
    if (!node || !matches(nodeId, node)) return false;
    const total = page.pages?.find((item) => item.nodeId === nodeId)?.total;
    // Never an empty thread for a node with history the page left out.
    return (byNode[nodeId]?.length ?? 0) > 0 || (node.messageCount ?? 0) === 0 || total === 0;
  });
  if (installed.length === 0) return { nodes, installed };
  const ids = new Set(installed);
  return {
    nodes: applyTreeMessages(nodes, Object.fromEntries(installed.map((nodeId) => [nodeId, byNode[nodeId] ?? []])),
      page.pages?.filter((item) => ids.has(item.nodeId)),
      page.turns?.filter((row) => ids.has(String((row as Record<string, unknown> | null)?.node_id ?? '')))),
    installed,
  };
}
