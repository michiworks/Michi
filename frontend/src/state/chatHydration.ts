import { isChatPermissionMode, parseWorkspaceSettings, selectWindowComposerDraft, workspaceSystemOf } from 'michi-shared';
import { WINDOW_ID } from '../config/windowIdentity';
import { backendEntityId, mapBackendPayload, serverEntityId } from '../config/backendIdentity';
import { finalizeAssistantBlocks, migrateAssistantToBlocks, parseAssistantBlocks } from './assistantBlocks';
import type {
  ChatMessage,
  ChatNodeState,
  ComposerDraft,
  ArtifactEntry,
  FolderEntry,
  NarrationOption,
  NodeKind,
  Project,
  SubagentInfo,
  ToolCallState,
  Tree,
  TrimSnapshot,
} from './chatTypes';
import type { DigestState } from './digest';
import { firstLiveUserWorkspaceId, isLiveUserWorkspace } from './assistant/systemWorkspace';
import { BACKEND_RESTARTED_KIND, BACKEND_RESTARTED_MESSAGE, classifiedErrorKind } from './turnInterruption';
import { noteCompletionFactsBackend } from './completionFacts';
import { isVisibleConversationNode, pickLandingTreeId } from './conversationVisibility';
import {
  appendBranchOverviewEntry, LEAN_NODE_FIELD_COLUMNS, parseBranchOverviewEntries, parseCompanionPostMetadata,
  parseCompanionSendSource, parseCompanionTurnMetadata, parseCompanionTurnRefs, parseLeanNodeFields, parseSteeringReports,
  parseSubagentRoster, parseThreadMessageSource, threadMessageBody, type BranchOverviewEntry, type CompanionTurnRef,
  type LeanNodeField,
} from 'michi-shared';
import type { TreeMessagePageEntry } from '../services/api/persistence';
import { LOCAL_BACKEND_CONNECTION_ID } from '../config/backendConnections';

/** `userMetadata.companionRefs` (what a message to the agent referred to, F1a-review #1); nothing when malformed. */
function parseStoredCompanionRefs(value: unknown): CompanionTurnRef[] | undefined {
  if (value === undefined) return undefined;
  try {
    const refs = parseCompanionTurnRefs(value);
    return refs.length ? refs : undefined;
  } catch {
    return undefined;
  }
}

/** The first run's closing question's options (`metaAgentNarration`, kind `end`); undefined for any other message. */
function parseNarrationOptions(value: unknown): NarrationOption[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const narration = value as { kind?: unknown; options?: unknown };
  if (narration.kind !== 'end' || !Array.isArray(narration.options)) return undefined;
  const options = narration.options.flatMap((entry): NarrationOption[] => {
    if (!entry || typeof entry !== 'object' || typeof (entry as NarrationOption).label !== 'string') return [];
    const { label, open } = entry as NarrationOption;
    const valid = !!open && typeof open.nodeId === 'string' && typeof open.workspaceId === 'string' && typeof open.draft === 'string';
    return [valid ? { label, open: { nodeId: open.nodeId, workspaceId: open.workspaceId, draft: open.draft } } : { label }];
  });
  return options.length ? options : undefined;
}

export const STATE_SCHEMA_VERSION = 6;

export interface SavedState {
  version: number;
  projects: Project[];
  activeProjectId: string | null;
  nodes: Record<string, Partial<ChatNodeState> & { nodeId: string; projectId: string; messages?: ChatMessage[] }>;
}

export interface HydratedState {
  projects: Project[];
  activeProjectId: string | null;
  nodes: Record<string, ChatNodeState>;
}

function emptyHydrated(): HydratedState {
  return { projects: [], activeProjectId: null, nodes: {} };
}

type BackendEdgeKind = NonNullable<Project['edges'][number]['kind']>;

interface BackendFullWorkspace {
  workspace?: Record<string, unknown>;
  trees?: Array<Record<string, unknown>>;
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
  // Backend bulk loaders (`loadFullWorkspace`/`loadWorkspaceMeta`) emit artifact
  // rows under the wire key `contexts`. `artifacts` is accepted as a fallback in
  // case a caller ever aligns the wire key to the domain model.
  contexts?: Array<Record<string, unknown>>;
  artifacts?: Array<Record<string, unknown>>;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function inferRuntimeId(row: Record<string, unknown>, nodeId: string): string | undefined {
  const explicit = asString(row.runtime_id);
  if (explicit) return explicit;
  const sessionId = asString(row.acp_session_id);
  if (!sessionId) return undefined;
  return sessionId === serverEntityId(nodeId) ? 'pi' : 'kiro';
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Parse `workspace.folders` JSON with fallback to legacy `cwd`. */
function hydrateFolders(workspace: Record<string, unknown>): FolderEntry[] {
  const raw = workspace.folders;
  if (raw && typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) return arr as FolderEntry[];
    } catch { /* fall through */ }
  }
  // Legacy fallback: synthesize from cwd
  const cwd = asString(workspace.cwd);
  if (cwd) {
    return [{ id: 'legacy-cwd', path: cwd, addedAt: asNumber(workspace.created_at, 0) }];
  }
  return [];
}

function parseJsonStringArray(v: unknown): string[] {
  if (!v || typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeEdgeKind(v: unknown): BackendEdgeKind {
  return v === 'merge' || v === 'link' || v === 'digest-source' ? v : 'branch';
}

function parseToolCalls(raw: unknown): ToolCallState[] {
  let value = raw;
  if (typeof value === 'string' && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ToolCallState[] => {
    if (!item || typeof item !== 'object') return [];
    const t = item as Record<string, unknown>;
    const id = asString(t.id) ?? asString(t.toolCallId);
    if (!id) return [];
    return [{
      id,
      title: asString(t.title) ?? '',
      status: asString(t.status) ?? '',
      kind: asString(t.kind),
      detail: asString(t.detail),
      inputJson: asString(t.inputJson),
      output: asString(t.output),
      textOffset: asOptionalNumber(t.textOffset),
      startedAt: asOptionalNumber(t.startedAt),
      endedAt: asOptionalNumber(t.endedAt),
    }];
  });
}

function parseMessageMetadata(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string' && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** The skill a user message ran (DurableMessageMetadata.skill), as the backend recorded it. */
function parseMessageSkill(raw: unknown): ChatMessage['skill'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const skill = raw as Record<string, unknown>;
  const id = asString(skill.id);
  const name = asString(skill.name);
  if (!id || !name || (skill.origin !== 'library' && skill.origin !== 'builtin' && skill.origin !== 'runtime')) return undefined;
  const runtimeId = asString(skill.runtimeId);
  return { id, name, origin: skill.origin, ...(runtimeId ? { runtimeId } : {}), args: asString(skill.args) ?? '' };
}

function parseComposerDraft(raw: unknown): ComposerDraft | undefined {
  if (typeof raw === 'string') raw = selectWindowComposerDraft(raw, WINDOW_ID);
  let value = raw;
  if (typeof value === 'string' && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const d = value as Record<string, unknown>;
  const text = typeof d.value === 'string' ? d.value : '';
  const mentions = Array.isArray(d.mentions)
    ? d.mentions.flatMap((item): ComposerDraft['mentions'] => {
        if (!item || typeof item !== 'object') return [];
        const m = item as Record<string, unknown>;
        if (
          typeof m.start !== 'number' ||
          typeof m.end !== 'number' ||
          (m.kind !== 'context' && m.kind !== 'node') ||
          typeof m.refId !== 'string' ||
          typeof m.label !== 'string'
        ) {
          return [];
        }
        return [{
          start: m.start,
          end: m.end,
          kind: m.kind,
          refId: m.refId,
          label: m.label,
        }];
      })
    : [];
  const quotedText = typeof d.quotedText === 'string' && d.quotedText.trim()
    ? d.quotedText
    : undefined;
  if (!text && mentions.length === 0 && !quotedText) return undefined;
  const source = d.quoteSource as ComposerDraft['quoteSource'];
  const quoteSource = source && (source.type === 'attached' || (source.type === 'artifact' && typeof source.filePath === 'string')) ? source : undefined;
  return { value: text, mentions, quotedText, ...(quotedText && quoteSource ? { quoteSource } : {}) };
}

// ── Lean node fields (shared/leanNodeFields) ──────────────────────────────

function branchOverviewState(entries: BranchOverviewEntry[]): Pick<ChatNodeState, 'branchOverviewEntries' | 'branchOverview'> {
  return {
    branchOverviewEntries: entries.length > 0 ? entries : undefined,
    branchOverview: entries.length > 0 ? entries[entries.length - 1].text : undefined,
  };
}

/** The node state one lean field of a row maps to. */
function leanFieldState(field: LeanNodeField, row: Record<string, unknown>): Partial<ChatNodeState> {
  switch (field) {
    case 'branch_overview':
      return branchOverviewState(parseBranchOverviewEntries(row.branch_overview));
    case 'follow_ups':
      return {
        followUps: parseJsonStringArray(row.follow_ups),
        followUpsSourceMessageId: asString(row.follow_ups_source_message_id) || undefined,
      };
    case 'composer_draft':
      return { composerDraft: parseComposerDraft(row.composer_draft) };
  }
}

/** The lean fields a lean row left out: named by its workspace's marker, absent from the row. */
function deferredFieldsOf(row: Record<string, unknown>, lean: readonly LeanNodeField[]): LeanNodeField[] {
  return lean.filter((field) => !(LEAN_NODE_FIELD_COLUMNS[field][0] in row));
}

export function isNodeFieldDeferred(node: Pick<ChatNodeState, 'deferredNodeFields'> | undefined, field: LeanNodeField): boolean {
  return !!node?.deferredNodeFields?.includes(field);
}

/**
 * The marker update that settles `fields` on `node`: spread it into the next
 * node. Empty when none of them was deferred.
 */
export function settleDeferredNodeFields(node: ChatNodeState, ...fields: LeanNodeField[]): Pick<ChatNodeState, 'deferredNodeFields'> | Record<string, never> {
  const deferred = node.deferredNodeFields;
  if (!deferred?.some((field) => fields.includes(field))) return {};
  const rest = deferred.filter((field) => !fields.includes(field));
  return { deferredNodeFields: rest.length > 0 ? rest : undefined };
}

/**
 * Fill the node's deferred fields from a row that carries them (a tree page's
 * `node`, a full structure read); the rest stay deferred. Overview entries
 * that streamed in while deferred join the stored ones. Returns `node` itself
 * when nothing applies.
 */
export function mergeDeferredNodeFields(node: ChatNodeState, row: Record<string, unknown> | null | undefined): ChatNodeState {
  const deferred = node.deferredNodeFields;
  if (!deferred?.length || !row || typeof row !== 'object') return node;
  const present = deferred.filter((field) => LEAN_NODE_FIELD_COLUMNS[field][0] in row);
  if (present.length === 0) return node;
  let next: ChatNodeState = { ...node, ...settleDeferredNodeFields(node, ...present) };
  for (const field of present) {
    if (field === 'branch_overview') {
      let entries = parseBranchOverviewEntries(row.branch_overview);
      for (const entry of node.branchOverviewEntries ?? []) entries = appendBranchOverviewEntry(entries, entry.text, entry.at);
      next = { ...next, ...branchOverviewState(entries) };
    } else {
      next = { ...next, ...leanFieldState(field, row) };
    }
  }
  if (next.deferredNodeFields === undefined) delete next.deferredNodeFields;
  return next;
}

function parseTrimSnapshot(raw: unknown): TrimSnapshot | undefined {
  let value = raw;
  if (typeof value === 'string' && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const d = value as Record<string, unknown>;
  if (
    !(d.parentId === null || typeof d.parentId === 'string') ||
    !Array.isArray(d.childrenIds) ||
    !d.childrenIds.every((c) => typeof c === 'string')
  ) {
    return undefined;
  }
  let wasTreeRoot: TrimSnapshot['wasTreeRoot'] = null;
  if (d.wasTreeRoot && typeof d.wasTreeRoot === 'object') {
    const w = d.wasTreeRoot as Record<string, unknown>;
    if (typeof w.treeId === 'string') wasTreeRoot = { treeId: w.treeId };
  }
  return {
    parentId: d.parentId as string | null,
    childrenIds: d.childrenIds as string[],
    wasTreeRoot,
  };
}

function parseDigest(raw: unknown): DigestState | undefined {
  let value = raw;
  if (typeof value === 'string' && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const d = value as Record<string, unknown>;
  const sources = Array.isArray(d.sources) ? d.sources.filter((x): x is string => typeof x === 'string') : [];
  const rawFingerprints = d.sourceFingerprints;
  const sourceFingerprints: Record<string, string> = {};
  if (rawFingerprints && typeof rawFingerprints === 'object') {
    for (const [k, v] of Object.entries(rawFingerprints)) {
      if (typeof v === 'string') sourceFingerprints[k] = v;
    }
  }
  return {
    sources,
    sourceFingerprints,
    content: typeof d.content === 'string' ? d.content : '',
    generatedAt: asNumber(d.generatedAt, 0),
    viewedAt: asNumber(d.viewedAt, 0),
    status: 'idle',
    customPrompt: asString(d.customPrompt),
  };
}

// ── Single-row → entity mappers ────────────────────────────────────────────
// These pure helpers map ONE backend row (the `SELECT *` shape) into the
// corresponding live-state entity (or the row-owned fields of one). They are
// the same mapping `hydrateBackendWorkspaces` performs inline; factoring them
// out lets the conflict-adoption path (workspacePersistence.ts) converge a
// single conflicted row to the server's value without re-pulling the whole
// workspace. Cross-row derived data (a node's messages / mergeSources / digest,
// an edge's reverse index) is NOT owned by a single row, so the node mapper
// only returns that row's own scalar fields — callers preserve local derived
// state (messages are append-only and reconciled separately).

/** Map one `edges` row → ProjectEdge, or null when source/target is missing. */
export function mapEdgeRow(row: Record<string, unknown>): Project['edges'][number] | null {
  const source = asString(row.source_node_id);
  const target = asString(row.target_node_id);
  if (!source || !target) return null;
  const anchorMessageId = asString(row.anchor_message_id) || undefined;
  const createdAt = asOptionalNumber(row.created_at);
  return { source, target, kind: normalizeEdgeKind(row.kind), anchorMessageId, createdAt };
}

/** Map one `trees` row → Tree, or null when id/root_node_id is missing. */
export function mapTreeRow(row: Record<string, unknown>): Tree | null {
  const id = asString(row.id);
  const rootNodeId = asString(row.root_node_id);
  if (!id || !rootNodeId) return null;
  return {
    id,
    rootNodeId,
    name: asString(row.name),
    createdAt: asNumber(row.created_at, Date.now()),
    lastActiveAt: asNumber(row.last_active_at, Date.now()),
    archivedAt: asOptionalNumber(row.archived_at),
    pinnedAt: asOptionalNumber(row.pinned_at),
  };
}

/** Map one `artifacts` row → ArtifactEntry (artifact), or null when required
 *  fields missing. A `link` artifact has a `url` and no file_path; every other
 *  type has a file_path. Require at least one so links survive reload. */
export function mapContextRow(row: Record<string, unknown>): ArtifactEntry | null {
  const id = asString(row.id);
  const name = asString(row.name);
  const filePath = asString(row.file_path) ?? '';
  const url = asString(row.url);
  if (!id || !name || (!filePath && !url)) return null;
  const rawType = asString(row.type);
  const type: ArtifactEntry['type'] =
    rawType === 'file' || rawType === 'image' || rawType === 'link' || rawType === 'doc'
      ? rawType
      : url
        ? 'link'
        : 'doc';
  const rawKind = asString(row.kind);
  const kind: ArtifactEntry['kind'] =
    rawKind === 'embedded' || rawKind === 'reference' || rawKind === 'symlink'
      ? rawKind
      : undefined;
  const originNodeId = asString(row.origin_node_id);
  const originMessageId = asString(row.origin_message_id);
  return {
    id,
    name,
    filePath,
    url: url ?? undefined,
    type,
    kind,
    origin: originNodeId ? { nodeId: originNodeId, messageId: originMessageId ?? undefined } : undefined,
    size: asOptionalNumber(row.size),
    pinnedAt: asOptionalNumber(row.pinned_at),
    source: row.source === 'agent' ? 'agent' : 'user',
    createdAt: asNumber(row.created_at, Date.now()),
    updatedAt: asNumber(row.updated_at, Date.now()),
  };
}

/** Map one `messages` row → ChatMessage. `fallbackSeq` derives the id when the
 *  row carries no explicit id (mirrors the inline hydration default). */
/**
 * Group raw backend message rows into a { nodeId → ordered ChatMessage[] } map.
 * Used by the lazy-load path: the per-tree message fetch returns a flat row
 * list (ordered by node, then seq), which this folds into the per-node shape
 * the `messages-loaded` action and the hydration eager-load both consume.
 * Rows already arrive ordered, so we preserve arrival order per node.
 */
export function buildMessagesByNode(rawRows: unknown[]): Record<string, ChatMessage[]> {
  const byNode: Record<string, ChatMessage[]> = {};
  if (!Array.isArray(rawRows)) return byNode;
  for (const raw of rawRows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const nodeId = asString(row.node_id);
    if (!nodeId) continue;
    const list = byNode[nodeId] ?? (byNode[nodeId] = []);
    list.push(mapMessageRow(row, list.length));
  }
  return byNode;
}

/**
 * Server rows replacing a node's messages keep the `clientKey` of the row
 * with the same id, so a realigned message stays mounted (keeps its expanded
 * blocks and edit text, and does not replay its entrance). Returns `next`
 * itself when nothing carries over.
 */
export function carryClientKeys(previous: readonly ChatMessage[] | undefined, next: ChatMessage[]): ChatMessage[] {
  let keys: Map<string, string> | undefined;
  for (const message of previous ?? []) {
    if (message.clientKey) (keys ??= new Map()).set(message.id, message.clientKey);
  }
  if (!keys) return next;
  let changed = false;
  const carried = next.map((message) => {
    const clientKey = keys.get(message.id);
    if (!clientKey || message.clientKey) return message;
    changed = true;
    return { ...message, clientKey };
  });
  return changed ? carried : next;
}

/**
 * Install fetched message bodies onto placeholder nodes. Pure: returns a new
 * nodes map (only touched nodes get new object identities). Each node in
 * `messagesByNode` gets its messages replaced. Page metadata keeps partial
 * history marked incomplete and retains its total count. Nodes absent from the
 * map are returned by reference (untouched). Shared by the hydration
 * eager-load and the `messages-loaded` reducer action so both converge.
 * A node's latest turn row, read with its bodies, sets its turn state.
 * A page's lean node fields (`pages[i].node`) fill what lean metadata
 * deferred, on any node the page lists, bodies or not.
 */
export function applyTreeMessages(
  nodes: Record<string, ChatNodeState>,
  messagesByNode: Record<string, ChatMessage[]>,
  pages?: TreeMessagePageEntry[],
  turns?: unknown[],
): Record<string, ChatNodeState> {
  const ids = Object.keys(messagesByNode);
  const fieldPages = pages?.filter((page) => page.node && nodes[page.nodeId]?.deferredNodeFields?.length) ?? [];
  if (ids.length === 0 && fieldPages.length === 0) return nodes;
  const next = { ...nodes };
  for (const nodeId of ids) {
    const prev = next[nodeId];
    if (!prev) continue; // node not present locally (e.g. trimmed) — skip
    const messages = carryClientKeys(prev.messages, messagesByNode[nodeId]);
    const page = pages?.find(item => item.nodeId === nodeId);
    const turn = turns?.find((row): row is Record<string, unknown> =>
      !!row && typeof row === 'object' && (row as Record<string, unknown>).node_id === nodeId);
    next[nodeId] = recoverRunningTurn({
      ...prev,
      ...(turn ? latestTurnState(turn) : {}),
      messages,
      messagesLoaded: !page?.before,
      historyBefore: page?.before ?? undefined,
      olderMessageCount: page?.before ? Math.max(0, page.total - messages.length) : undefined,
      messageCount: page?.total ?? messages.length,
    });
  }
  for (const page of fieldPages) next[page.nodeId] = mergeDeferredNodeFields(next[page.nodeId], page.node);
  return next;
}

/**
 * Bodies are stored together with their turn's replay cursor, and installing
 * a running turn's body reattaches its stream from the node's cursor. The
 * cursor hydration read came earlier than the bodies: replaying from it would
 * append output they already hold, and a turn that has ended since must not
 * reattach at all.
 */
function latestTurnState(row: Record<string, unknown>): Partial<ChatNodeState> {
  const turnId = asString(row.turn_id);
  const seq = asOptionalNumber(row.last_seq);
  if (!turnId || seq === undefined) return {};
  const cursor = {
    lastAppliedTurnId: turnId, lastAppliedSeq: seq,
    lastAppliedBackgroundTurnId: turnId, lastAppliedBackgroundSeq: seq,
  };
  if (row.status === 'active') return { ...cursor, status: 'streaming', activeTurnId: turnId };
  return {
    ...cursor,
    status: row.status === 'error' ? 'error' : 'idle',
    activeTurnId: undefined,
    error: undefined, errorKind: undefined, errorTurnId: undefined,
    errorCompletedAt: undefined, errorRecovery: undefined, errorRecoverable: undefined,
    ...(row.status === 'error' ? persistedErrorState({
      last_turn_id: turnId, last_turn_status: 'error',
      last_turn_error: row.error, last_turn_completed_at: row.completed_at,
    }) : {}),
  };
}

/**
 * Stored rows always map to finished messages, and a renderer that opens a
 * running turn (a reload, another window, a lazily loaded thread) replays
 * from a cursor past `turn_start`, so nothing marks the turn's assistant
 * message live again. Without the flag its agent block cannot report
 * Working… during tool calls and the activity row defers to it, leaving only
 * the tool spinner. The turn's begin transaction writes the node's streaming
 * status together with its assistant row, so the last assistant message is
 * the running one; the foreground reattach path relies on the same fact.
 */
function recoverStreamingAssistant(node: ChatNodeState): ChatNodeState {
  if (node.status !== 'streaming' || node.visibleResponseComplete) return node;
  const index = node.messages.findLastIndex((message) => message.role === 'assistant');
  if (index < 0 || node.messages[index].streaming) return node;
  const messages = node.messages.slice();
  messages[index] = { ...messages[index], streaming: true };
  return { ...node, messages };
}

/** Restore the live state a running turn's stored rows cannot carry. */
function recoverRunningTurn(node: ChatNodeState): ChatNodeState {
  return recoverPendingUserInput(recoverStreamingAssistant(node));
}

/**
 * A renderer that opens a running turn after its question was persisted
 * (another window asked it, a reload, a reconnect) replays from a cursor past
 * the `user_input_request` event, so only the stored block knows the question
 * is open. Restore it as the node's pending request so it can be answered.
 */
export function recoverPendingUserInput(node: ChatNodeState): ChatNodeState {
  if (node.status !== 'streaming' || node.pendingUserInput) return node;
  const last = node.messages[node.messages.length - 1];
  if (last?.role !== 'assistant') return node;
  const block = last.blocks?.findLast((candidate) => candidate.kind === 'user-input');
  const interaction = block?.kind === 'user-input' ? block.interaction : undefined;
  if (interaction?.status !== 'pending') return node;
  return {
    ...node,
    pendingUserInput: {
      requestId: interaction.requestId,
      interactionId: interaction.interactionId,
      questions: interaction.questions,
      answers: [],
    },
  };
}

/** Claude tools whose frames belong to an agent: the spawners, and SendMessage, which resumes one. */
const CLAUDE_AGENT_TOOLS = new Set(['task', 'agent', 'sendmessage']);

/**
 * The roster without the entries an older Claude runtime made from a plain
 * tool's own frames (a long-running Bash, an MCP call): a placeholder name,
 * no task or steps, and a parent tool call in the same message that neither
 * starts nor resumes an agent. They are not agents; without them the
 * Background work drawer does not list them and the tool's chip does not
 * read as a delegation.
 */
function withoutToolStandIns(roster: SubagentInfo[], toolCalls: readonly ToolCallState[]): SubagentInfo[] {
  if (toolCalls.length === 0) return roster;
  const kept = roster.filter((entry) => {
    if (entry.source !== 'claude' || entry.description || entry.prompt || entry.activity?.length) return true;
    if (entry.agentName.trim().toLowerCase() !== 'subagent') return true;
    const parent = toolCalls.find((tool) => tool.id === entry.parentToolCallId);
    return !parent || CLAUDE_AGENT_TOOLS.has(parent.title.trim().split(/\s+/)[0]?.toLowerCase() ?? '');
  });
  return kept.length === roster.length ? roster : kept;
}

export function mapMessageRow(row: Record<string, unknown>, fallbackSeq = 0): ChatMessage {
  const nodeId = asString(row.node_id) ?? '';
  const role = row.role === 'assistant' ? 'assistant' : 'user';
  const rawContent = typeof row.content === 'string' ? row.content : '';
  const metadata = parseMessageMetadata(row.metadata);
  // The stored content of a relayed message is what the receiving runtime
  // got (attribution header + body); the bubble shows the body.
  const threadMessage = role === 'user' ? parseThreadMessageSource(metadata.threadMessage) : undefined;
  const skill = role === 'user' ? parseMessageSkill(metadata.skill) : undefined;
  const toolCalls = parseToolCalls(row.tool_calls);
  // DESIGN-v2 §4: a follow-up the agent sent into a conversation it started, stored as its
  // header + body like a relayed message (live rows come through here too, from observer-turn-start).
  const companionSend = role === 'user' ? parseCompanionSendSource(metadata.companionSend) : undefined;
  // DESIGN-v2 §3.3 / §1.3: a check-in's post (assistant rows) and what the route decided about a user message.
  const companionPost = role === 'assistant' ? parseCompanionPostMetadata(metadata.companionPost) : undefined;
  const companionTurn = role === 'user' ? parseCompanionTurnMetadata(metadata.companionTurn) : undefined;
  const companionRefs = role === 'user' ? parseStoredCompanionRefs(metadata.companionRefs) : undefined;
  const narrationOptions = role === 'assistant' ? parseNarrationOptions(metadata.metaAgentNarration) : undefined;
  const baseMsg: ChatMessage = {
    id: asString(row.id) ?? `${nodeId}-${asNumber(row.seq, fallbackSeq)}`,
    role,
    text: threadMessage || companionSend ? threadMessageBody(rawContent) : rawContent,
    ...(threadMessage ? { threadMessage } : {}),
    ...(skill ? { skill } : {}),
    ...(companionSend ? { companionSend } : {}),
    ...(companionPost ? { companionPost } : {}),
    ...(companionTurn ? { companionTurn } : {}),
    ...(companionRefs ? { companionRefs } : {}),
    ...(narrationOptions ? { narrationOptions } : {}),
    ...(role === 'user' && metadata.steered === true ? { steered: true } : {}),
    ...(role === 'user' && typeof metadata.scheduledJobId === 'string' && metadata.scheduledJobId
      ? { scheduledJobId: metadata.scheduledJobId } : {}),
    toolCalls,
    blocks: role === 'assistant' ? parseAssistantBlocks(row.blocks) : undefined,
    streaming: false,
    createdAt: asOptionalNumber(row.created_at),
    quotedText: asString(metadata.quotedText),
    ...(metadata.quoteSource && typeof metadata.quoteSource === 'object' ? { quoteSource: metadata.quoteSource as ChatMessage['quoteSource'] } : {}),
    attachments: Array.isArray(metadata.attachments)
      ? metadata.attachments.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const attachment = item as Record<string, unknown>;
          const name = asString(attachment.name);
          const absPath = asString(attachment.absPath);
          const relPath = asString(attachment.relPath);
          return name && absPath ? [{ name, absPath, ...(relPath ? { relPath } : {}) }] : [];
        })
      : undefined,
    comments: Array.isArray(metadata.comments)
      ? metadata.comments as ChatMessage['comments']
      : undefined,
    plan: Array.isArray(metadata.plan)
      ? metadata.plan as ChatMessage['plan']
      : undefined,
    ...(role === 'assistant' && metadata.usageSummary && typeof metadata.usageSummary === 'object' ? { usageSummary: metadata.usageSummary as ChatMessage['usageSummary'] } : {}),
    ...(role === 'assistant' && Array.isArray(metadata.warnings) ? { warnings: metadata.warnings as ChatMessage['warnings'] } : {}),
    ...(role === 'assistant' && Array.isArray(metadata.steeringReports)
      ? { steeringReports: parseSteeringReports(metadata.steeringReports) } : {}),
    ...(role === 'assistant' && Array.isArray(metadata.subagents)
      ? { subagents: withoutToolStandIns(parseSubagentRoster(metadata.subagents), toolCalls) } : {}),
  };
  return role === 'assistant' ? finalizeAssistantBlocks(migrateAssistantToBlocks(baseMsg)) : baseMsg;
}

/**
 * Classify a persisted error node from its latest turn receipt.
 *
 * The node row alone does not retain a trusted failure classification: its
 * `last_applied_turn_id` is a replay watermark a client may sync back, so it
 * must never authorize execution. The hydration payload therefore carries the
 * node's latest `turns` row (`last_turn_*`), written only by the backend's
 * finalization or startup recovery. A restart marker becomes the resumable
 * kind, and so does a failure whose message says the agent's credentials
 * expired; any other finalized failure keeps its own message with an
 * ordinary retry, the same offer the live stream made. Without a receipt the outcome
 * stays unknown and only a read-only check is offered.
 */
function persistedErrorState(row: Record<string, unknown>): Partial<ChatNodeState> {
  const turnId = asString(row.last_turn_id);
  if (turnId && row.last_turn_status === 'error') {
    const reason = asString(row.last_turn_error);
    const completedAt = asOptionalNumber(row.last_turn_completed_at);
    if (reason === BACKEND_RESTARTED_KIND) {
      return { errorKind: BACKEND_RESTARTED_KIND, errorTurnId: turnId, error: BACKEND_RESTARTED_MESSAGE, errorCompletedAt: completedAt };
    }
    if (reason) {
      const errorKind = classifiedErrorKind(undefined, reason);
      return { ...(errorKind ? { errorKind } : {}), errorTurnId: turnId, error: reason, errorCompletedAt: completedAt };
    }
  }
  return { errorKind: 'turn_outcome_unknown', error: 'The previous turn outcome could not be confirmed.' };
}

/**
 * The server's completion facts (migration 0064). A row without them comes
 * from an older backend, whose nodes keep the lastAssistantAt/viewedAt rule.
 */
function completionFactsOf(row: Record<string, unknown>): Pick<ChatNodeState, 'completionSeq' | 'seenCompletionSeq' | 'lastCompletedAt' | 'lastCompletedTurnId'> {
  const completionSeq = asOptionalNumber(row.completion_seq);
  if (completionSeq === undefined) return {};
  const lastCompletedTurnId = asString(row.last_completed_turn_id);
  return {
    completionSeq,
    seenCompletionSeq: Math.min(asNumber(row.seen_completion_seq, 0), completionSeq),
    lastCompletedAt: asOptionalNumber(row.last_completed_at),
    // A replayed done of that turn is already counted.
    ...(lastCompletedTurnId ? { lastCompletedTurnId } : {}),
  };
}

/**
 * Map the row-owned scalar fields of one `nodes` row → a partial ChatNodeState.
 * Excludes cross-row derived fields (`messages`, `mergeSources`, `digest`)
 * which depend on the message/edge rows; callers merge those separately.
 * Used by conflict adoption to converge a single node's scalars to the server
 * value while preserving the locally-reconciled message list.
 */
export function mapNodeRowScalars(row: Record<string, unknown>): Partial<ChatNodeState> {
  const nodeId = asString(row.id)!;
  const kind: NodeKind = row.kind === 'digest' ? 'digest' : 'chat';
  const hasRuntimeBinding = !!asString(row.acp_session_id) || !!asString(row.external_session_id);
  const posX = asOptionalNumber(row.position_x);
  const posY = asOptionalNumber(row.position_y);
  return {
    nodeId,
    kind,
    // Native page helper binding is authoritative backend metadata. It is
    // intentionally read-only in the renderer and omitted from sync writes.
    pageId: asString(row.page_id) ?? null,
    maintenanceJobId: asString(row.maintenance_job_id) ?? null,
    scheduledOnlyJobId: asString(row.scheduled_only_job_id) ?? null,
    // A temporary chat: memory off, set once when its first session was made.
    // Read-only here like pageId; serializeNodeRow never writes it back.
    temporary: row.memory_mode === 'off' ? true : undefined,
    // Compatibility marker only: a bound node always uses its nodeId on the
    // public API. Runtime-native ids remain in SQLite/backend adapters.
    chatId: hasRuntimeBinding ? nodeId : null,
    runtimeId: inferRuntimeId(row, nodeId),
    providerId: asString(row.provider_id) ?? null,
    modelId: asString(row.model_id) ?? null,
    reasoning: asString(row.reasoning) as ChatNodeState['reasoning'] ?? null,
    resumeFingerprint: asString(row.resume_fingerprint) ?? null,
    parentNodeId: asString(row.parent_node_id),
    forkedFromNodeId: asString(row.forked_from_node_id),
    forkBoundaryMessageId: asString(row.fork_boundary_message_id),
    inheritedMessageCount: asOptionalNumber(row.inherited_message_count),
    ...leanFieldState('follow_ups', row),
    title: asString(row.title),
    ...leanFieldState('branch_overview', row),
    status: row.status === 'streaming' ? 'streaming' : row.status === 'error' ? 'error' : 'idle',
    ...(row.status === 'error' ? persistedErrorState(row) : {}),
    activeTurnId: row.status === 'streaming' ? asString(row.last_applied_turn_id) : undefined,
    lastAppliedTurnId: asString(row.last_applied_turn_id),
    lastAppliedSeq: asOptionalNumber(row.last_applied_seq),
    lastAppliedBackgroundTurnId: asString(row.last_applied_turn_id),
    lastAppliedBackgroundSeq: asOptionalNumber(row.last_applied_seq),
    minimized: row.minimized === 1 || row.minimized === true || undefined,
    position: posX !== undefined && posY !== undefined ? { x: posX, y: posY } : undefined,
    spawnedByAgent: row.spawned_by_agent === 1 || row.spawned_by_agent === true || undefined,
    multiModelRunId: asString(row.multi_model_run_id),
    freshContext: row.fresh_context === 1 || row.fresh_context === true ? true : undefined,
    ...leanFieldState('composer_draft', row),
    deletedAt: asOptionalNumber(row.deleted_at),
    deletionGroupId: asString(row.deletion_group_id),
    trimSnapshot: parseTrimSnapshot(row.trim_snapshot),
    pinnedAt: asOptionalNumber(row.pinned_at),
    viewedAt: asOptionalNumber(row.viewed_at),
    ...completionFactsOf(row),
    currentModeId: asString(row.current_mode_id) ?? null,
    permissionMode: isChatPermissionMode(row.permission_mode) ? row.permission_mode : undefined,
    permissionApproveForMe: row.permission_mode === 'ask' && (row.permission_approve_for_me === 1 || row.permission_approve_for_me === true) ? true : undefined,
    ultracode: row.ultracode === 1 || row.ultracode === true ? true : undefined,
    paneWidth: asOptionalNumber(row.pane_width),
  };
}

/**
 * Convert the SQLite REST shape back into the frontend's live state shape.
 * Backend sessions still cannot survive a restart, so every restored node is
 * deliberately chatId=null/status=idle, matching localStorage hydration.
 */
export function hydrateBackendWorkspaces(
  rawWorkspaces: unknown[],
  preferredActiveProjectId?: string | null,
  connectionId = LOCAL_BACKEND_CONNECTION_ID,
): HydratedState {
  if (!Array.isArray(rawWorkspaces) || rawWorkspaces.length === 0) return emptyHydrated();

  const projects: Project[] = [];
  const nodes: Record<string, ChatNodeState> = {};

  for (const raw of rawWorkspaces) {
    if (!raw || typeof raw !== 'object') continue;
    const full = mapBackendPayload(raw, connectionId, 'renderer') as BackendFullWorkspace;
    const workspace = full.workspace;
    const projectId = workspace ? asString(workspace.id) : undefined;
    if (!workspace || !projectId) continue;

    const edgeRows = Array.isArray(full.edges) ? full.edges : [];
    const edges: Project['edges'] = edgeRows.flatMap((row) => {
      const edge = mapEdgeRow(row);
      return edge ? [edge] : [];
    });

    const mergeSourcesByTarget = new Map<string, string[]>();
    const digestSourcesByTarget = new Map<string, string[]>();
    for (const e of edges) {
      if (e.kind === 'merge') {
        mergeSourcesByTarget.set(e.target, [...(mergeSourcesByTarget.get(e.target) ?? []), e.source]);
      } else if (e.kind === 'digest-source') {
        digestSourcesByTarget.set(e.target, [...(digestSourcesByTarget.get(e.target) ?? []), e.source]);
      }
    }

    const messageRows = Array.isArray(full.messages) ? full.messages : [];
    const messageRowsByNode = new Map<string, Array<Record<string, unknown>>>();
    for (const row of messageRows) {
      const nodeId = asString(row.node_id);
      if (!nodeId) continue;
      const arr = messageRowsByNode.get(nodeId) ?? [];
      arr.push(row as Record<string, unknown>);
      messageRowsByNode.set(nodeId, arr);
    }
    const messagesByNode = new Map<string, ChatMessage[]>();
    messageRowsByNode.forEach((rows, nodeId) => {
      // Sort by seq (monotonic insert order); fall back to createdAt for legacy data without seq.
      rows.sort((a, b) => {
        const seqA = asOptionalNumber(a.seq);
        const seqB = asOptionalNumber(b.seq);
        if (seqA != null && seqB != null) return seqA - seqB;
        return (asNumber(a.created_at, 0)) - (asNumber(b.created_at, 0));
      });
      messagesByNode.set(nodeId, rows.map((row, i) => mapMessageRow(row, i)));
    });

    const nodeRows = (Array.isArray(full.nodes) ? full.nodes : [])
      .filter((row) => !!asString(row.id))
      .sort((a, b) => asNumber(a.created_at, 0) - asNumber(b.created_at, 0));
    const chatIds = nodeRows.map((row) => asString(row.id)!).filter(Boolean);

    const treeRows = Array.isArray(full.trees) ? full.trees : [];
    let trees: Tree[] = treeRows.flatMap((row) => {
      const tree = mapTreeRow(row);
      return tree ? [tree] : [];
    });
    if (trees.length === 0 && chatIds[0]) {
      const createdAt = asNumber(workspace.created_at, Date.now());
      trees = [{ id: backendEntityId(connectionId, `t-${serverEntityId(projectId)}-root`), rootNodeId: chatIds[0], createdAt, lastActiveAt: createdAt }];
    }

    // Lean metadata names the fields its rows may leave out (stamped on each
    // workspace by fetchAllWorkspacesMeta); a row without one defers it.
    const leanFields = parseLeanNodeFields((full as { leanNodeFields?: unknown }).leanNodeFields);
    for (const row of nodeRows) {
      const nodeId = asString(row.id)!;
      const scalars = mapNodeRowScalars(row);
      const deferredNodeFields = leanFields.length > 0 ? deferredFieldsOf(row, leanFields) : [];
      if (deferredNodeFields.length > 0) scalars.deferredNodeFields = deferredNodeFields;
      if (scalars.completionSeq !== undefined) noteCompletionFactsBackend(connectionId);
      let digest = parseDigest(row.digest);
      if (scalars.kind === 'digest' && !digest) {
        digest = {
          sources: digestSourcesByTarget.get(nodeId) ?? [],
          sourceFingerprints: {},
          content: '',
          generatedAt: 0,
          viewedAt: 0,
          status: 'idle',
        };
      }
      // Lazy-load markers. The meta payload carries `message_count` on each row
      // and NO bodies; the full payload carries bodies and no count. A node is a
      // placeholder (messagesLoaded:false) only in meta mode — i.e. when the row
      // reports a count but no bodies were assembled for it. In full mode every
      // node is authoritative (messagesLoaded:true), including genuinely-empty
      // ones. This is the placeholder-vs-empty distinction the write-back guard
      // and the lazy trigger both key off of.
      const assembled = messagesByNode.get(nodeId) ?? [];
      const rawCount = asOptionalNumber(row.message_count);
      const isMetaRow = rawCount !== undefined && assembled.length === 0;
      nodes[nodeId] = recoverRunningTurn({
        ...scalars,
        // Cross-row derived fields the single-row scalar mapper cannot know:
        projectId,
        mergeSources: mergeSourcesByTarget.get(nodeId),
        messages: assembled,
        messagesLoaded: !isMetaRow,
        messageCount: rawCount ?? assembled.length,
        digest,
      } as ChatNodeState);
    }

    // A page helper's, maintenance run's or Scheduled-only run's tree is newest
    // the moment it is created, but it is not a conversation the shell should land on: panes
    // opened "beside chat" would join the hidden tree instead of the user's thread.
    // Nor is one in Trash. An archived thread stays open: the archive opens one.
    const requestedActiveTreeId = asString(workspace.active_tree_id);
    const requestedTree = requestedActiveTreeId ? trees.find((t) => t.id === requestedActiveTreeId) : undefined;
    const requestedRoot = requestedTree && nodes[requestedTree.rootNodeId];
    const activeTreeId = requestedTree && requestedRoot && !requestedRoot.deletedAt && isVisibleConversationNode(requestedRoot)
      ? requestedTree.id
      : pickLandingTreeId(trees, nodes);

    // Backend bulk loaders return artifact rows under the `contexts` wire key;
    // accept `artifacts` too so a later key alignment can't silently drop them.
    const rawArtifacts = Array.isArray(full.contexts)
      ? full.contexts
      : Array.isArray(full.artifacts)
        ? full.artifacts
        : [];
    const artifacts: ArtifactEntry[] = rawArtifacts.flatMap((row) => {
      const ctx = mapContextRow(row);
      return ctx ? [ctx] : [];
    });

    // The window writes aiGlobalContext and instructions; the backend's
    // assistant store owns system (shared SERVER_OWNED_WORKSPACE_SETTINGS).
    const settings = parseWorkspaceSettings(asString(workspace.settings));
    const instructions = typeof settings?.instructions === 'string' ? settings.instructions : undefined;
    const aiGlobalContext = settings?.aiGlobalContext === false ? false : undefined;
    const system = workspaceSystemOf(settings);

    const project: Project = {
      id: projectId,
      ...(connectionId !== LOCAL_BACKEND_CONNECTION_ID ? { backendConnectionId: connectionId } : {}),
      name: asString(workspace.name) ?? 'Untitled',
      cwd: asString(workspace.cwd),
      folders: hydrateFolders(workspace),
      chatIds,
      edges,
      createdAt: asNumber(workspace.created_at, Date.now()),
      trees,
      activeTreeId,
      artifacts,
      deletedAt: asOptionalNumber(workspace.deleted_at),
      archivedAt: asOptionalNumber(workspace.archived_at),
      pinnedAt: asOptionalNumber(workspace.pinned_at),
      aiGlobalContext,
      instructions,
      ...(system ? { system } : {}),
    };
    projects.push(project);
  }

  // A system workspace (the assistant's) never becomes the active one on load.
  const preferredIsLive =
    preferredActiveProjectId &&
    isLiveUserWorkspace(projects.find((p) => p.id === preferredActiveProjectId));
  const activeProjectId = preferredIsLive
    ? preferredActiveProjectId!
    : firstLiveUserWorkspaceId(projects);

  return { projects, activeProjectId, nodes };
}

/**
 * Convert a saved snapshot back into live state. A legacy runtime binding is
 * retained only as the public node-id marker; runtime-native ids never return
 * to frontend state. Status is forced idle and lingering `streaming` flags on
 * assistant messages are cleared. Malformed or wrong-version input yields an
 * empty state.
 */
export function hydrateSavedState(saved: unknown): HydratedState {
  if (!saved || typeof saved !== 'object') return emptyHydrated();
  const s = saved as Partial<SavedState>;
  if (![1, 2, 3, 4, 5, 6].includes(s.version ?? 0)) return emptyHydrated();
  if (!Array.isArray(s.projects) || !s.nodes || typeof s.nodes !== 'object') {
    return emptyHydrated();
  }

  const nodes: Record<string, ChatNodeState> = {};
  for (const [id, raw] of Object.entries(s.nodes)) {
    const msgs = (raw.messages ?? []).map((m) => {
      const isAssistant = m.role === 'assistant';
      const hydrated: ChatMessage = {
        ...m,
        streaming: false,
        blocks: isAssistant ? parseAssistantBlocks((m as any).blocks) : undefined,
        text: typeof m.text === 'string' ? m.text : '',
      };
      // Drop legacy parts-pipeline fields if a persisted dump still carries
      // them (parts / pendingParts / pendingAfterTextPartId / pendingAfterOffset).
      const hydratedAny = hydrated as unknown as Record<string, unknown>;
      delete hydratedAny.parts;
      delete hydratedAny.pendingParts;
      delete hydratedAny.pendingAfterTextPartId;
      delete hydratedAny.pendingAfterOffset;
      return isAssistant ? migrateAssistantToBlocks(hydrated) : hydrated;
    });
    const pos = raw.position;
    const validPos =
      pos && typeof pos === 'object' && typeof pos.x === 'number' && typeof pos.y === 'number'
        ? { x: pos.x, y: pos.y }
        : undefined;
    nodes[id] = {
      nodeId: raw.nodeId,
      kind: raw.kind === 'digest' ? 'digest' : 'chat',
      chatId: (typeof raw.chatId === 'string' && raw.chatId) ? raw.nodeId : null,
      runtimeId:
        typeof (raw as any).runtimeId === 'string' && (raw as any).runtimeId
          ? (raw as any).runtimeId
          : (typeof raw.chatId === 'string' && raw.chatId && raw.chatId !== raw.nodeId ? 'kiro' : undefined),
      providerId:
        typeof (raw as any).providerId === 'string' ? (raw as any).providerId : null,
      modelId:
        typeof (raw as any).modelId === 'string' ? (raw as any).modelId : null,
      reasoning:
        typeof (raw as any).reasoning === 'string' ? (raw as any).reasoning : null,
      resumeFingerprint:
        typeof (raw as any).resumeFingerprint === 'string' ? (raw as any).resumeFingerprint : null,
      lastAppliedTurnId:
        typeof (raw as any).lastAppliedTurnId === 'string' ? (raw as any).lastAppliedTurnId : undefined,
      lastAppliedSeq:
        typeof (raw as any).lastAppliedSeq === 'number' ? (raw as any).lastAppliedSeq : undefined,
      lastAppliedBackgroundTurnId:
        typeof (raw as any).lastAppliedBackgroundTurnId === 'string'
          ? (raw as any).lastAppliedBackgroundTurnId
          : typeof (raw as any).lastAppliedTurnId === 'string' ? (raw as any).lastAppliedTurnId : undefined,
      lastAppliedBackgroundSeq:
        typeof (raw as any).lastAppliedBackgroundSeq === 'number'
          ? (raw as any).lastAppliedBackgroundSeq
          : typeof (raw as any).lastAppliedSeq === 'number' ? (raw as any).lastAppliedSeq : undefined,
      projectId: raw.projectId,
      parentNodeId: raw.parentNodeId,
      mergeSources: raw.mergeSources,
      messages: msgs,
      followUps: raw.followUps ?? [],
      title: raw.title,
      branchOverviewEntries: (() => {
        if (Array.isArray((raw as any).branchOverviewEntries) && (raw as any).branchOverviewEntries.length > 0) {
          return parseBranchOverviewEntries((raw as any).branchOverviewEntries);
        }
        const legacy = (raw as any).branchOverview;
        if (typeof legacy === 'string' && legacy.trim().length > 0) {
          return parseBranchOverviewEntries(legacy);
        }
        return undefined;
      })(),
      branchOverview: (() => {
        if (Array.isArray((raw as any).branchOverviewEntries) && (raw as any).branchOverviewEntries.length > 0) {
          const entries = parseBranchOverviewEntries((raw as any).branchOverviewEntries);
          return entries.length > 0 ? entries[entries.length - 1].text : undefined;
        }
        const legacy = (raw as any).branchOverview;
        return typeof legacy === 'string' && legacy.trim().length > 0 ? legacy : undefined;
      })(),
      status: (raw as any).status === 'error' ? 'error' : 'idle',
      ...((raw as any).status === 'error' ? { errorKind: 'turn_outcome_unknown', error: 'The previous turn outcome could not be confirmed.' } : {}),
      minimized: raw.minimized,
      position: validPos,
      viewedAt: typeof (raw as any).viewedAt === 'number' ? (raw as any).viewedAt : undefined,
      lastAssistantAt: typeof (raw as any).lastAssistantAt === 'number' ? (raw as any).lastAssistantAt : undefined,
      // Persist digest state across reloads; force status idle so a stuck
      // 'streaming' flag from a crashed generation doesn't look live.
      digest: (raw as any).digest
        ? { ...(raw as any).digest, status: 'idle', error: undefined, generation: undefined }
        : undefined,
      // Preserve chatId from saved state so session/load can restore the ACP
      // session without re-sending PREAMBLE. Falls back to null if missing.
      // on next send — drop consumedLinks too so the fresh session gets fresh
      // peer context.
      consumedLinks: undefined,
      spawnedByAgent: (raw as any).spawnedByAgent === true || undefined,
      deletedAt:
        typeof (raw as any).deletedAt === 'number' ? (raw as any).deletedAt : undefined,
      deletionGroupId:
        typeof (raw as any).deletionGroupId === 'string'
          ? (raw as any).deletionGroupId
          : undefined,
      trimSnapshot: parseTrimSnapshot((raw as any).trimSnapshot),
      composerDraft: parseComposerDraft((raw as any).composerDraft),
    };
  }

  const now = Date.now();
  const projects: Project[] = (s.projects ?? []).flatMap((p) => {
    const proj = p as Project;
    if (Array.isArray(proj.trees) && proj.trees.length > 0) {
      return [proj];
    }
    const rootId = proj.chatIds?.[0];
    if (!rootId) {
      // Legacy project with no nodes — drop it rather than synthesize a
      // tree pointing at undefined. Users only see this if a snapshot was
      // corrupted; losing a rootless workspace is safer than crashing
      // downstream renderers that assume rootNodeId resolves to a node.
      return [];
    }
    const tree: Tree = {
      id: `t-${p.id}-root`,
      rootNodeId: rootId,
      createdAt: proj.createdAt ?? now,
      lastActiveAt: now,
    };
    return [{ ...proj, trees: [tree], activeTreeId: tree.id }];
  });

  // v2->v3: add artifacts array to projects that lack it.
  // v3->v4: old text-body artifacts were replaced by file-based artifacts. Drop
  // only entries that do not have a filePath; preserve valid v4 file artifacts.
  for (const p of projects) {
    const rawContexts = Array.isArray((p as any).artifacts) ? (p as any).artifacts : [];
    p.artifacts = rawContexts
      // Keep any artifact with a name plus at least one payload: a filePath
      // (doc/file/image) OR a url (link). Pre-artifact rows always had filePath.
      .filter(
        (c: any) =>
          typeof c?.name === 'string' &&
          ((typeof c?.filePath === 'string' && c.filePath) || typeof c?.url === 'string'),
      )
      .map((c: any) => {
        const url = typeof c.url === 'string' ? c.url : undefined;
        const filePath = typeof c.filePath === 'string' ? c.filePath : '';
        const type: ArtifactEntry['type'] =
          c.type === 'file' || c.type === 'image' || c.type === 'link' || c.type === 'doc'
            ? c.type
            : url
              ? 'link'
              : 'doc';
        const kind: ArtifactEntry['kind'] =
          c.kind === 'embedded' || c.kind === 'reference' || c.kind === 'symlink'
            ? c.kind
            : undefined;
        const originNodeId =
          c.origin && typeof c.origin.nodeId === 'string' ? c.origin.nodeId : undefined;
        return {
          id: typeof c.id === 'string' ? c.id : `ctx-${now}-${Math.random().toString(36).slice(2, 6)}`,
          name: c.name,
          filePath,
          url,
          type,
          kind,
          origin: originNodeId
            ? {
                nodeId: originNodeId,
                messageId:
                  c.origin && typeof c.origin.messageId === 'string' ? c.origin.messageId : undefined,
              }
            : undefined,
          size: typeof c.size === 'number' && Number.isFinite(c.size) ? c.size : undefined,
          pinnedAt: typeof c.pinnedAt === 'number' && Number.isFinite(c.pinnedAt) ? c.pinnedAt : undefined,
          source: c.source === 'agent' ? 'agent' : 'user',
          createdAt: typeof c.createdAt === 'number' ? c.createdAt : now,
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : now,
        };
      });
  }

  return {
    projects,
    activeProjectId: s.activeProjectId ?? null,
    nodes,
  };
}
