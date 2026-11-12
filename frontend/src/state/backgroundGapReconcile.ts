import { applyTreeMessages, buildMessagesByNode, carryClientKeys, hydrateBackendWorkspaces, isNodeFieldDeferred, recoverPendingUserInput } from './chatHydration';
import { mergeCompletionFacts } from './completionFacts';
import { backendEntityId } from '../config/backendIdentity';
import { LOCAL_BACKEND_CONNECTION_ID, projectConnectionId } from '../config/backendConnections';
import type { TreeMessagePage } from '../services/api/persistence';
import type { ReplayGapInstall } from '../services/api/stream';
import type { ChatMessage, ChatNodeState, ArtifactEntry, Project, Tree } from './chatTypes';
import { isSystemWorkspace } from './assistant/systemWorkspace';
import { backendInstalledEntities, mergeWorkspaceSnapshot } from './assistant/workspaceSnapshot';
import { NODE_ADOPTED_FIELDS, type StructureAdoption } from './structureAdoption';
import { reconcileWorkspaceStructure, type StructureEditGuards } from './structureMerge';
import type { BackendInstalledEntities } from './workspacePersistence';

export interface BackgroundReplayGap {
  chatId: string;
  nodeId?: string;
  turnId: string;
  seq: number;
}

interface NodeInstallInput {
  currentProjects: Project[];
  currentNodes: Record<string, ChatNodeState>;
  /** The workspace's structure (`?meta=1`), or a full snapshot whose rows carry every body. */
  rawWorkspace: unknown;
  /**
   * The node's latest message page, read after `rawWorkspace`. Absent, the
   * node's body comes from `rawWorkspace` itself (a full snapshot).
   */
  page?: TreeMessagePage;
  /** When the read of `rawWorkspace` began (Date.now()). */
  readStartedAt: number;
  /** This window's edits the backend may not have had when the read began. */
  guards: StructureEditGuards;
}

export interface BackgroundGapReconcileInput extends NodeInstallInput {
  gap: BackgroundReplayGap;
}

export interface BackendNodeInstallResult {
  artifactProbes?: ArtifactProbes;
  projects: Project[];
  nodes: Record<string, ChatNodeState>;
  /** What the read put into the store's workspace, for adoptBackendStructure. */
  adoptions: StructureAdoption[];
  /** What else it brought in that the backend already holds, for noteBackendInstalled. */
  installed: BackendInstalledEntities | null;
}

export interface BackgroundGapReconcileResult extends BackendNodeInstallResult {
  nodeId: string;
  /** The background cursor the node now holds; replay after it is new output. */
  cursor: ReplayGapInstall;
}

/**
 * Artifacts a merge kept that the window should ask the backend about
 * (workspacePersistence probeArtifacts): ones only this window holds, under
 * the exact name one of the read's holds.
 */
export interface ArtifactProbes {
  projectId: string;
  contextIds: string[];
}

/**
 * The backend's artifacts with this window's, matched by id only. One both
 * hold keeps the newer copy (an edit not synced yet wins). One this window
 * removed and the backend has not confirmed removing stays out: the read
 * began before the delete reached it. One only this window holds stays, even
 * under a name one of the backend's holds: it may be a write still on its way
 * (made after a delete or a rename of that one here), and dropping it would
 * make persistence, diffing by id, delete it for good. Stale there instead
 * (deleted or renamed elsewhere), it would show beside the backend's under
 * the same name with nothing to tell them apart, so those are named in
 * `probes`: unless it is this window's own write, the window asks the
 * backend which it is (probeArtifacts). A case variant is another artifact
 * there and is not asked about.
 */
function mergeContexts(
  server: ArtifactEntry[] = [],
  local: ArtifactEntry[] = [],
  pendingDeletes?: ReadonlySet<string>,
): { artifacts: ArtifactEntry[]; probes: string[] } {
  const result = pendingDeletes?.size ? server.filter((context) => !pendingDeletes.has(context.id)) : server.slice();
  const indexById = new Map(result.map((context, index) => [context.id, index] as const));
  const serverNames = new Set(result.map((context) => context.name));
  const probes: string[] = [];
  for (const context of local) {
    const index = indexById.get(context.id);
    if (index !== undefined) {
      if (context.updatedAt >= result[index].updatedAt) result[index] = { ...result[index], ...context };
      continue;
    }
    if (serverNames.has(context.name)) probes.push(context.id);
    indexById.set(context.id, result.length);
    result.push(context);
  }
  return { artifacts: result, probes };
}

const NO_REMOVALS = { workspaceIds: new Set<string>(), treeIds: new Set<string>(), nodeIds: new Set<string>() };

/**
 * Put one node the backend holds into its workspace. The workspace merges as
 * a structure re-read does (structureMerge): the read may predate this
 * window's unsaved edits (an archive, a rename, a removed tree or edge),
 * which it leaves alone, and what it brings in is adopted rather than sent
 * back. The assistant's system workspace, which that merge leaves to its own
 * flows, merges as its snapshots do. Artifacts the window removed stay
 * removed; others the backend holds (an agent saved them) come in. Null when
 * the merge leaves the node out (its tree was just removed here, or this
 * window holds it in another workspace).
 */
function installNode(
  { currentProjects, currentNodes, rawWorkspace, readStartedAt, guards }: NodeInstallInput,
  local: Project,
  server: Project,
  connectionId: string,
  nodeId: string,
  gapNode: () => ChatNodeState,
): BackendNodeInstallResult | null {
  const system = isSystemWorkspace(local);
  let projects = currentProjects;
  let nodes = currentNodes;
  let adoptions: StructureAdoption[] = [];
  let installed: BackendInstalledEntities | null = null;
  if (system) {
    const merged = mergeWorkspaceSnapshot(currentProjects, currentNodes, rawWorkspace, {
      pendingDeletes: (project) => guards.pendingDeletes(project, readStartedAt),
      readStartedAt,
    });
    if (!merged) return null;
    ({ projects, nodes } = merged);
    installed = backendInstalledEntities(currentProjects, currentNodes, merged);
  } else {
    const merged = reconcileWorkspaceStructure({
      currentProjects, currentNodes, snapshots: [{ workspaceId: local.id, raw: rawWorkspace }],
      connectionId, removals: NO_REMOVALS, readStartedAt, guards,
    });
    if (merged) ({ projects, nodes, adoptions } = merged);
    if (!currentNodes[nodeId]) installed = { projectId: local.id, newProject: false, nodeIds: [nodeId], treeIds: [], edgeIds: [] };
  }
  const project = projects.find((candidate) => candidate.id === local.id);
  const placed = nodes[nodeId];
  if (!project?.chatIds.includes(nodeId) || !placed) return null;

  // The page's node, with the structural fields the guarded merge settled on.
  const settled: Partial<ChatNodeState> = system ? {} : Object.fromEntries(NODE_ADOPTED_FIELDS.map(([field]) => [field, placed[field]]));
  const node: ChatNodeState = { ...gapNode(), ...settled };
  nodes = { ...nodes, [nodeId]: node };
  adoptions = adoptions.map((adoption) => (adoption.nodes?.some((entry) => entry.node.nodeId === nodeId)
    ? { ...adoption, nodes: adoption.nodes.map((entry) => (entry.node.nodeId === nodeId ? { ...entry, node } : entry)) }
    : adoption));

  const removed = guards.pendingDeletes(local, readStartedAt).contextIds;
  const held = new Set((project.artifacts ?? []).map((artifact) => artifact.id));
  const { artifacts, probes } = mergeContexts(server.artifacts, project.artifacts, removed);
  projects = projects.map((candidate) => (candidate === project ? { ...project, artifacts } : candidate));
  const contextIds = artifacts.filter((artifact) => !held.has(artifact.id)).map((artifact) => artifact.id);
  if (contextIds.length > 0) {
    installed = { ...(installed ?? { projectId: local.id, newProject: false, nodeIds: [], treeIds: [], edgeIds: [] }), contextIds };
  }
  return { projects, nodes, adoptions, installed, ...(probes.length ? { artifactProbes: { projectId: local.id, contextIds: probes } } : {}) };
}

function markLastAssistantStreaming(messages: ChatMessage[]): ChatMessage[] {
  const index = messages.findLastIndex((message) => message.role === 'assistant');
  if (index < 0) return messages;
  const next = messages.slice();
  const message = next[index];
  next[index] = {
    ...message,
    streaming: true,
    blocks: message.blocks?.map((block, blockIndex, blocks) => {
      if (block.kind !== 'answer' && block.kind !== 'thinking') return block;
      const laterTextBlock = blocks.slice(blockIndex + 1).some(
        (candidate) => candidate.kind === 'answer' || candidate.kind === 'thinking',
      );
      return laterTextBlock ? block : { ...block, streaming: true };
    }),
  };
  return next;
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    : [];
}

/** The page's latest turn row for the node, when it names a usable cursor. */
function pageTurn(page: TreeMessagePage, nodeId: string): Record<string, unknown> | undefined {
  const turn = recordsOf(page.turns).find((row) => row.node_id === nodeId);
  return turn && typeof turn.turn_id === 'string' && turn.turn_id
    && typeof turn.last_seq === 'number' && Number.isFinite(turn.last_seq) ? turn : undefined;
}

/**
 * The node as the backend holds it: its structure row, then the page's
 * bodies with the page's history bounds, then (current backends) the turn row
 * read in the same transaction as those bodies. That row, not the structure
 * row read earlier, says whether the turn still runs and how far its output
 * reaches. Without a page the bodies are already in the full snapshot.
 */
function serverPageNode(
  structureNode: ChatNodeState,
  nodeId: string,
  page: TreeMessagePage | undefined,
): { node: ChatNodeState; fromTurn: boolean } {
  if (!page) return { node: structureNode, fromTurn: false };
  // A gateway that predates pages answers with every body of the tree.
  const rows = page.messages.filter((row) =>
    !!row && typeof row === 'object' && (row as { node_id?: unknown }).node_id === nodeId);
  const messages = buildMessagesByNode(rows)[nodeId] ?? [];
  const bounds = page.pages?.find((item) => item.nodeId === nodeId);
  const turn = pageTurn(page, nodeId);
  const node = applyTreeMessages({ [nodeId]: structureNode }, { [nodeId]: messages },
    bounds ? [bounds] : undefined, turn ? [turn] : undefined)[nodeId];
  return { node, fromTurn: !!turn };
}

function mergeGapNode(
  server: ChatNodeState,
  local: ChatNodeState | undefined,
  chatId: string,
  backgroundCursor: { turnId: string; seq: number },
): ChatNodeState {
  const status = server.status;
  const sameRuntime = local?.runtimeId === server.runtimeId;
  const serverMessages = carryClientKeys(local?.messages, server.messages);
  const messages = status === 'streaming'
    ? markLastAssistantStreaming(serverMessages)
    : serverMessages;
  // A draft this window deferred (lean metadata) is not unsent work: take the
  // read's. The draft's deferral follows whichever value is kept.
  const draftFromLocal = !!local && !isNodeFieldDeferred(local, 'composer_draft');
  const deferredNodeFields = (server.deferredNodeFields ?? []).filter((field) => field !== 'composer_draft'
    || (!draftFromLocal && isNodeFieldDeferred(server, 'composer_draft')));
  return recoverPendingUserInput({
    ...server,
    deferredNodeFields: deferredNodeFields.length > 0 ? deferredNodeFields : undefined,
    chatId: server.chatId ?? local?.chatId ?? chatId,
    status,
    pendingUserInput: status === 'streaming' ? server.pendingUserInput : undefined,
    messages,
    // A page names its own bounds: older rows stay on the server until asked for.
    messagesLoaded: server.messagesLoaded !== false,
    historyBefore: server.historyBefore,
    messageCount: server.messageCount ?? messages.length,
    lastAppliedBackgroundTurnId: backgroundCursor.turnId,
    lastAppliedBackgroundSeq: backgroundCursor.seq,
    // A direct foreground replay may have advanced while the shared feed was
    // disconnected. Its durable cursor is a separate authority and must not
    // be rolled back by this background-only snapshot.
    lastAppliedTurnId: local?.lastAppliedTurnId ?? server.lastAppliedTurnId,
    lastAppliedSeq: local?.lastAppliedSeq ?? server.lastAppliedSeq,
    title: local?.titleNeedsPersistence ? local.title : server.title,
    titleNeedsPersistence: local?.titleNeedsPersistence,
    deletedAt: local?.deletedAt ?? server.deletedAt,
    deletionGroupId: local?.deletionGroupId ?? server.deletionGroupId,
    // The workspace snapshot is canonical for turn output and graph state,
    // but these fields may contain unsent user work newer than the server.
    composerDraft: draftFromLocal ? local.composerDraft : server.composerDraft,
    pendingComments: local?.pendingComments,
    pendingQueued: local?.pendingQueued,
    queueErrored: local?.queueErrored,
    viewedAt: local?.viewedAt ?? server.viewedAt,
    lastAssistantAt: Math.max(local?.lastAssistantAt ?? 0, server.lastAssistantAt ?? 0) || undefined,
    // A seen mark may not have reached the server yet; both counts only grow.
    ...mergeCompletionFacts(server, local),
    // Workspace rows do not include the native session catalog or the result
    // of a host command. Retain the session's commands and state while the
    // binding still uses that runtime: another runtime's commands would fill
    // this one's / menu.
    agentCommands: sameRuntime ? local?.agentCommands : undefined,
    sessionState: sameRuntime ? local?.sessionState : undefined,
    commandResult: local?.commandResult,
  });
}

/**
 * Where a workspace structure read keeps one node: its tree (the server's
 * `nodes.tree_id`, not this window's edge-derived guess) and its message count.
 * Null when the read no longer lists the node in a tree.
 */
export function structureNodeRow(
  rawWorkspace: unknown,
  nodeId: string,
  connectionId = LOCAL_BACKEND_CONNECTION_ID,
): { treeId: string; messageCount?: number } | null {
  const scoped = (id: unknown): string | undefined => {
    if (typeof id !== 'string' || !id) return undefined;
    try { return backendEntityId(connectionId, id); } catch { return undefined; }
  };
  const rows = recordsOf((rawWorkspace as { nodes?: unknown } | null)?.nodes);
  const row = rows.find((candidate) => scoped(candidate.id) === nodeId);
  const treeId = scoped(row?.tree_id);
  if (!row || !treeId) return null;
  const count = row.message_count;
  return { treeId, ...(typeof count === 'number' && Number.isFinite(count) ? { messageCount: count } : {}) };
}

/** One node page: at least the messages this window already shows, within the server's cap. */
export function nodePageLimit(node: ChatNodeState | undefined): number {
  return Math.min(200, Math.max(50, node?.messages.length ?? 0));
}

/**
 * Whether one node's page can be installed over its structure read. A page
 * that leaves the node out (it moved trees between the two reads), or comes
 * back empty for a node the structure counts messages for, describes another
 * moment than the structure: read the structure again instead.
 */
export function nodePageInstallable(page: TreeMessagePage, nodeId: string, messageCount?: number): boolean {
  const rows = page.messages.filter((row) =>
    !!row && typeof row === 'object' && (row as { node_id?: unknown }).node_id === nodeId).length;
  if (page.pages) {
    const bounds = page.pages.find((item) => item.nodeId === nodeId);
    if (!bounds) return false;
    return rows > 0 || (bounds.total === 0 && !messageCount);
  }
  // A gateway without pages answers with the whole tree's bodies.
  return rows > 0 || !messageCount;
}

// Fields the install takes from this window's node as it is when the install
// lands, so a change to them while the read is in flight is carried over and
// needs no second read. Typing in the thread's composer must not keep a
// replay barrier reading the backend again.
const INSTALL_TIME_LOCAL_FIELDS = new Set<keyof ChatNodeState>([
  'viewedAt', 'seenCompletionSeq', 'composerDraft', 'pendingComments', 'pendingQueued',
  'queueErrored', 'agentCommands', 'commandResult',
  // Typing settles a deferred draft (chatReducers set-composer-draft).
  'deferredNodeFields',
]);

/**
 * Whether the node an install targets is the one it was when the read began.
 * Only this node and its project's structure matter: output streaming into
 * any other node renews the whole nodes map without touching what the read
 * replaces.
 */
export function sameGapTargetNode(before: ChatNodeState | undefined, after: ChatNodeState | undefined): boolean {
  if (before === after) return true;
  if (!before || !after) return false;
  return (Object.keys({ ...before, ...after }) as Array<keyof ChatNodeState>)
    .every((key) => INSTALL_TIME_LOCAL_FIELDS.has(key) || before[key] === after[key]);
}

/** Same project structure; a tree's activity time (every turn's end renews it) is not structure. */
export function sameProjectStructure(before: Project | undefined, after: Project | undefined): boolean {
  if (before === after) return true;
  if (!before || !after) return false;
  return (Object.keys({ ...before, ...after }) as Array<keyof Project>).every((key) => {
    if (before[key] === after[key]) return true;
    if (key !== 'trees') return false;
    return before.trees.length === after.trees.length && before.trees.every((tree, index) => {
      const other = after.trees[index];
      if (tree === other) return true;
      return (Object.keys({ ...tree, ...other }) as Array<keyof Tree>)
        .every((field) => field === 'lastActiveAt' || tree[field] === other[field]);
    });
  });
}

export interface NodeInstallRead {
  structure: unknown;
  page: TreeMessagePage;
  /** When the structure read began. */
  readStartedAt: number;
  /** The connection that served both reads. */
  connectionId: string;
}

export interface NodeInstallReadOptions<T> {
  workspaceId: string;
  nodeId: string;
  /** Reads before giving up on a node that keeps changing under them. */
  attempts: number;
  signal: AbortSignal;
  /** Bound on each structure read. */
  readTimeoutMs: number;
  /** The workspace as the store holds it now; undefined: nothing to install. */
  project(): Project | undefined;
  /** The node as the store holds it now. */
  node(): ChatNodeState | undefined;
  /** Install only a node the store already holds (a gap's), never a new one. */
  nodeHeld: boolean;
  /** A foreground turn or host command owns the node's live state. */
  busy(): boolean;
  /** Called while busy: resolves true once the node is not, false when it stopped waiting. */
  idle(): Promise<boolean>;
  fetchStructure(workspaceId: string, signal: AbortSignal): Promise<unknown | null>;
  fetchPage(workspaceId: string, treeId: string, connectionId: string | undefined, signal: AbortSignal,
    page: { nodeId: string; limit: number }): Promise<TreeMessagePage>;
  /** Runs synchronously once the reads still answer for the store, so nothing changes it in between. */
  install(read: NodeInstallRead): T;
}

/**
 * Read a node's workspace structure, then one page of the node (never the
 * workspace's other bodies), and install them. A page that disagrees with
 * its structure read, or a local change to the node or its project during
 * the reads, reads again. 'gone' when there is nothing to install (the
 * workspace, node or thread is not there, or `idle` stopped waiting);
 * 'exhausted' when every attempt raced. Rejects with an AbortError once
 * `signal` aborts.
 */
export async function readAndInstallNode<T>(options: NodeInstallReadOptions<T>): Promise<{ installed: T } | 'gone' | 'exhausted'> {
  const { workspaceId, nodeId, signal } = options;
  const throwIfAborted = () => { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); };
  // Set once a page disagreed with its structure read: the node must still
  // be in that thread when the structure is read again.
  let pageTreeId: string | undefined;
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    // An idle node is read at once, before anything else can change it.
    if (options.busy() && !await options.idle()) return 'gone';
    throwIfAborted();
    const projectBefore = options.project();
    const nodeBefore = options.node();
    if (!projectBefore || (options.nodeHeld && !nodeBefore)) return 'gone';
    const connectionId = projectBefore.backendConnectionId;
    const readStartedAt = Date.now();
    const structure = await options.fetchStructure(workspaceId,
      AbortSignal.any([signal, AbortSignal.timeout(options.readTimeoutMs)]));
    throwIfAborted();
    if (structure === null) return 'gone';
    const located = structureNodeRow(structure, nodeId, connectionId ?? LOCAL_BACKEND_CONNECTION_ID);
    if (!located || (pageTreeId && located.treeId !== pageTreeId)) return 'gone';
    const page = await options.fetchPage(workspaceId, located.treeId, connectionId, signal,
      { nodeId, limit: nodePageLimit(options.node()) });
    throwIfAborted();
    if (!nodePageInstallable(page, nodeId, located.messageCount)) {
      pageTreeId = located.treeId;
      continue;
    }
    // A local edit (rename, delete, a send) can land while the reads are in
    // flight: read again across a stable node and project structure.
    if (options.busy() || !sameGapTargetNode(nodeBefore, options.node())
      || !sameProjectStructure(projectBefore, options.project())) continue;
    return { installed: options.install({ structure, page, readStartedAt, connectionId: connectionId ?? LOCAL_BACKEND_CONNECTION_ID }) };
  }
  return 'exhausted';
}

/**
 * The cursor the background feed reopens a node from. This window's own
 * foreground stream drives the node's running turn: that turn is the node's
 * newest, so its foreground cursor is at or after the durable one, and the
 * feed drops the turn's frames as this window's own anyway. The background
 * cursor still names an earlier turn, and once that turn leaves the server's
 * replay ring it would raise a gap whose reconcile has to wait for the local
 * turn to end, holding every other chat's frames behind it.
 */
export function backgroundReplayCursor(
  node: ChatNodeState,
  foregroundActive: boolean,
): { turnId: string; seq: number } | null {
  if (foregroundActive && node.status === 'streaming' && node.activeTurnId
    && node.lastAppliedTurnId === node.activeTurnId
    && node.lastAppliedBackgroundTurnId !== node.activeTurnId
    && typeof node.lastAppliedSeq === 'number') {
    return { turnId: node.activeTurnId, seq: node.lastAppliedSeq };
  }
  const turnId = node.lastAppliedBackgroundTurnId ?? node.lastAppliedTurnId;
  const seq = node.lastAppliedBackgroundTurnId ? node.lastAppliedBackgroundSeq : node.lastAppliedSeq;
  return turnId && typeof seq === 'number' ? { turnId, seq } : null;
}

/**
 * Spacing for a chat whose replay gap failed to reconcile. Each reconnect of
 * the feed re-sends that chat's gap (its cursor never moved, and a running
 * turn's durable seq advances with every checkpoint), so the hold is per chat.
 */
export class BackgroundGapRetries {
  private readonly failures = new Map<string, { count: number; retryAt: number }>();

  constructor(
    private readonly baseMs = 1_000,
    private readonly maxMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** How long the gap waits before it is read again. */
  delay(gap: BackgroundReplayGap): number {
    const entry = this.failures.get(gap.chatId);
    return entry ? Math.max(0, entry.retryAt - this.now()) : 0;
  }

  failed(gap: BackgroundReplayGap): void {
    const count = (this.failures.get(gap.chatId)?.count ?? 0) + 1;
    this.failures.set(gap.chatId, {
      count,
      retryAt: this.now() + Math.min(this.maxMs, this.baseMs * 2 ** (count - 1)),
    });
  }

  settled(gap: BackgroundReplayGap): void {
    this.failures.delete(gap.chatId);
  }
}

export interface BackendNodeInstallInput extends NodeInstallInput {
  nodeId: string;
  /** Backend connection that served `rawWorkspace` (default: this machine). */
  connectionId?: string;
}

/**
 * Install or refresh a thread the backend created without this renderer (a
 * scheduled run, or a conversation started on another device). Unknown
 * trees/nodes are added (other nodes as placeholders when `rawWorkspace` is a
 * structure read); the target node takes the server's messages and durable
 * cursor, so later background frames continue from there.
 * Local-only fields (drafts, queue, view state) are kept.
 */
export function installBackendWorkspaceNode(input: BackendNodeInstallInput): BackendNodeInstallResult | null {
  const { currentProjects, currentNodes, rawWorkspace, page, nodeId, connectionId = LOCAL_BACKEND_CONNECTION_ID } = input;
  const hydrated = hydrateBackendWorkspaces([rawWorkspace], null, connectionId);
  const serverProject = hydrated.projects[0];
  if (!serverProject) return null;
  const localProject = currentProjects.find((project) => project.id === serverProject.id);
  if (!localProject) return null;
  const structureNode = hydrated.nodes[nodeId];
  if (!structureNode) return null;
  const { node: serverNode } = serverPageNode(structureNode, nodeId, page);
  // The turn row read with the bodies when the backend sends one; otherwise
  // the node row, as a full snapshot read it together with its bodies.
  return installNode(input, localProject, serverProject, connectionId, nodeId, () => mergeGapNode(serverNode, currentNodes[nodeId],
    serverNode.chatId ?? currentNodes[nodeId]?.chatId ?? nodeId, {
      turnId: serverNode.lastAppliedBackgroundTurnId ?? '',
      seq: serverNode.lastAppliedBackgroundSeq ?? -1,
    }));
}

/**
 * Install one node's authoritative state after its background replay cursor
 * falls out of the in-memory ring: the workspace's structure plus that node's
 * latest page (or one full-workspace snapshot). Existing nodes outside the
 * affected workspace are untouched. Existing sibling nodes are kept live (a
 * foreground turn may be streaming on them); newly discovered server nodes
 * are added.
 *
 * The background cursor comes from the page's turn row when the backend sends
 * one: it was read with the bodies, so replay frames the bodies already hold
 * are dropped. Without it (an older backend) the cursor is the gap's own,
 * which replays any output checkpointed after it a second time.
 */
export function reconcileBackgroundWorkspaceSnapshot(input: BackgroundGapReconcileInput): BackgroundGapReconcileResult | null {
  const { currentProjects, currentNodes, rawWorkspace, page, gap } = input;
  const owner = currentProjects.find(project => project.chatIds.includes(gap.nodeId ?? gap.chatId));
  const connectionId = owner ? projectConnectionId(owner) : LOCAL_BACKEND_CONNECTION_ID;
  const hydrated = hydrateBackendWorkspaces([rawWorkspace], null, connectionId);
  const serverProject = hydrated.projects[0];
  if (!serverProject) return null;
  const localProject = currentProjects.find((project) => project.id === serverProject.id);
  if (!localProject) return null;

  const nodeId = gap.nodeId
    ?? Object.values(hydrated.nodes).find((node) => node.chatId === gap.chatId)?.nodeId
    ?? Object.values(currentNodes).find((node) => node.chatId === gap.chatId)?.nodeId;
  if (!nodeId) return null;
  const structureNode = hydrated.nodes[nodeId];
  if (!structureNode) return null;
  const { node: serverGapNode, fromTurn } = serverPageNode(structureNode, nodeId, page);
  const cursor = fromTurn
    ? { turnId: serverGapNode.lastAppliedBackgroundTurnId!, seq: serverGapNode.lastAppliedBackgroundSeq! }
    : { turnId: gap.turnId, seq: gap.seq };
  const installed = installNode(input, localProject, serverProject, connectionId, nodeId,
    () => mergeGapNode(serverGapNode, currentNodes[nodeId], gap.chatId, cursor));
  return installed && { ...installed, nodeId, cursor };
}
