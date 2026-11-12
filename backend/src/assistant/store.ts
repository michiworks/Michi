/**
 * The Michi assistant's home: one hidden system workspace (`settings.system
 * = 'assistant'`) whose current conversation is V, the user's one visible
 * conversation with the agent (DESIGN-v2 §0.2). Check-ins run in their own
 * throwaway nodes S there (W2-G1a createCheckinNode), never in V.
 *
 * Provisioning is synchronous end to end (SQLite and mkdir), so concurrent
 * requests in this process cannot interleave and create a second workspace
 * or node. The workspace row holds V's node id:
 *
 *   { "system": "assistant", "assistant": { "nodeId": "n-…" } }
 *
 * Before v2 it also held the Scheduled window's and the MVP Companion's
 * (`scheduleNodeId`, `companionNodeId`); migrateAssistantV2 archives those
 * conversations and drops the pointers, once (§7). History and activation
 * know every 'main' conversation, the old Scheduled ones included.
 *
 * The runtime is the global runtime settings, read whenever a session is
 * bound, until the user picks a runtime, model or reasoning in a
 * conversation's composer: from then on that conversation keeps its pick
 * (`meta`, one key per conversation). Without a pick its reasoning is the
 * agent's (Settings › <name> › Reasoning), by default the lower of the
 * global level and COMPANION_DEFAULT_REASONING_MAX (§6). A check-in runs on
 * V's runtime and model, its pick included, at the agent's reasoning, never
 * the chip's. Workspaces from before the Meta agent record may still carry
 * runtimeId/modelId/reasoning here; that record's first read folds them in once.
 *
 * Only this module writes these keys, with its own UPDATE: every other
 * workspace write keeps the stored ones (mergeServerOwnedSettings), so no
 * client can mark, unmark or retarget the assistant's workspace.
 * Every node in that workspace runs as the assistant (identity.ts, binding.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_WORKSPACE_SYSTEM,
  CHECKIN_NODE_PREFIX,
  REASONING_LEVELS,
  isAssistantWorkspaceSettings,
  isReasoningLevel,
  parseWorkspaceSettings,
  type MetaAgentResolvedRuntime,
  type MichiAssistantInfo,
  type MichiAssistantSettings,
  type MichiAssistantConversations,
  type MichiAssistantRuntimeSwitch,
  type MichiAssistantSettingsPatch,
  type RuntimeReasoning,
} from 'michi-shared';
import { getRuntime, listRuntimes } from '../agents/registry';
import { getProviderInfo, selectDefaultModelId } from '../agents/pi/piProviders';
import { getAgentConfig, resolveModel, resolveProvider, resolveRuntimeProfile } from '../services/agentConfig';
import { getMichiDataDir } from '../services/dataDir';
import { getDb, runInTransaction } from '../services/db';
import { getNode, getWorkspace, isTreeArchived, listWorkspaces, saveWorkspace, type NodeRow, type WorkspaceRow } from '../services/dbRepository';
import { ensureDurableGraphNode } from '../services/graphCommands';
import { getMetaAgentSettings } from '../services/metaAgent/settings';
import { getCompanionSettings, migrateCompanionSettingsV2 } from '../services/companion/settings';
import { setCompanionNotesOrigin } from '../services/companion/repository';
import { ASSISTANT_RUNTIMES, isAssistantRuntime } from './policy';
import { assistantJobCreated, assistantPurposeKey, assistantPurposeOf } from './identity';

export type { AssistantPurpose } from './policy';

export const ASSISTANT_WORKSPACE_NAME = 'Michi assistant';
export const ASSISTANT_CONVERSATION_TITLE = 'Assistant';

export class AssistantSettingsError extends Error {}

/**
 * A model id as runtimes spell them (claude-sonnet-4-5, provider/model, Bedrock
 * ARNs, names[1m]). It reaches CLI argv, so it never starts with `-`.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]{0,199}$/;

interface StoredAssistant {
  /** V: the current conversation. */
  nodeId?: unknown;
  /** Before v2: the Scheduled window's conversation (migrateAssistantV2 archives it and drops this). */
  scheduleNodeId?: unknown;
  /** Before v2: the MVP Companion's conversation (migrateAssistantV2 archives it and drops this). */
  companionNodeId?: unknown;
}

/** The pointers before v2, kept until migrateAssistantV2 has read them. */
const LEGACY_POINTERS = ['scheduleNodeId', 'companionNodeId'] as const;

function storedOf(workspace: WorkspaceRow): StoredAssistant {
  const value = parseWorkspaceSettings(workspace.settings)?.assistant;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as StoredAssistant : {};
}

export { assistantPurposeOf, isAssistantNode, isAssistantWorkspace } from './identity';

// ── Runtimes and settings ───────────────────────────────────────────────────

/**
 * Registered runtimes the assistant policy lists, in preference order. The
 * settings accept any registered runtime; whether one can host the assistant
 * is decided when its session starts.
 */
export function assistantSupportedRuntimes(): string[] {
  return ASSISTANT_RUNTIMES.filter((id) => !!getRuntime(id));
}

/**
 * Runtime (global), or, when that runtime cannot host the assistant (Crew),
 * the first one that can.
 */
function globalAssistantRuntimeId(): string {
  const configured = getAgentConfig().runtime;
  if (isAssistantRuntime(configured) && getRuntime(configured)) return configured;
  return assistantSupportedRuntimes()[0] ?? configured;
}

/** The global settings for `runtimeId`, each field as a new conversation there would use it. */
function globalSettingsFor(runtimeId: string): Required<MichiAssistantSettings> {
  const usesProviders = getRuntime(runtimeId)?.capabilities.providerModels === true;
  return { runtimeId, ...resolveRuntimeProfile(runtimeId, usesProviders) };
}

/**
 * The most reasoning the agent runs at by default (DESIGN-v2 §6, user
 * decision 8): a user turn at the global xhigh took 69 s, and check-ins stop
 * after 3 minutes. Settings › <name> › Reasoning (CompanionSettings.reasoning)
 * replaces the default; the composer chip still changes one conversation.
 */
export const COMPANION_DEFAULT_REASONING_MAX: RuntimeReasoning = 'high';

/** The lower of `level` and COMPANION_DEFAULT_REASONING_MAX; none stays none (the runtime's own default). */
function companionDefaultReasoning(level: RuntimeReasoning | null): RuntimeReasoning | null {
  if (!level) return level;
  return REASONING_LEVELS.indexOf(level) > REASONING_LEVELS.indexOf(COMPANION_DEFAULT_REASONING_MAX) ? COMPANION_DEFAULT_REASONING_MAX : level;
}

/** Settings › <name> › Reasoning; null (the default, or unreadable settings) is min(global, high). */
function agentReasoningSetting(): RuntimeReasoning | null {
  try {
    const level = getCompanionSettings().reasoning;
    return isReasoningLevel(level) ? level : null;
  } catch {
    return null;
  }
}

/**
 * The agent's reasoning on `runtimeId` (§6): Settings › <name> › Reasoning,
 * else the lower of that runtime's global level and high. A level the model
 * cannot use is dropped when the session is bound (binding.ts).
 */
export function agentReasoningFor(runtimeId: string): RuntimeReasoning | null {
  return agentReasoningSetting() ?? companionDefaultReasoning(globalSettingsFor(runtimeId).reasoning);
}

/** The global settings for `runtimeId` as a conversation with the agent starts on them: its reasoning, not the global one. */
function globalSettingsForAgent(runtimeId: string): Required<MichiAssistantSettings> {
  return { ...globalSettingsFor(runtimeId), reasoning: agentReasoningFor(runtimeId) };
}

/** A provider's model: the global one for the global provider, else that provider's own default. */
function providerModel(runtimeId: string, providerId: string | null): string | null {
  if (!providerId) return null;
  if (providerId === (resolveProvider(runtimeId) || null)) return resolveModel(runtimeId) || null;
  const info = getProviderInfo(providerId);
  return info ? selectDefaultModelId(info) : null;
}

const choiceKey = (nodeId: string) => `assistant_conversation_runtime:${nodeId}`;

/** What the user picked in one conversation's composer; null while it follows the global settings. */
function readConversationChoice(nodeId: string): Required<MichiAssistantSettings> | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(choiceKey(nodeId)) as { value: string } | undefined;
  if (!row) return null;
  let stored: unknown;
  try { stored = JSON.parse(row.value); } catch { return null; }
  if (!stored || typeof stored !== 'object') return null;
  const { runtimeId, providerId, modelId, reasoning } = stored as Record<string, unknown>;
  if (typeof runtimeId !== 'string' || !getRuntime(runtimeId)) return null;
  const id = (value: unknown) => (typeof value === 'string' && MODEL_ID.test(value) ? value : null);
  return { runtimeId, providerId: id(providerId), modelId: id(modelId), reasoning: isReasoningLevel(reasoning) ? reasoning : null };
}

/**
 * The workspace's settings with V's pointer moved. The pointers from before
 * v2 are kept until migrateAssistantV2 has read them (`dropLegacy`); nothing
 * else is (older keys such as the runtime fields the Meta agent record took
 * over are dropped).
 */
function settingsJson(workspace: WorkspaceRow | null, nodeId: string, dropLegacy = false): Record<string, unknown> {
  const current = parseWorkspaceSettings(workspace?.settings) ?? {};
  const stored = workspace ? storedOf(workspace) : {};
  const kept = dropLegacy ? {} : Object.fromEntries(LEGACY_POINTERS
    .filter((key) => typeof stored[key] === 'string')
    .map((key) => [key, stored[key]]));
  return { ...current, system: ASSISTANT_WORKSPACE_SYSTEM, assistant: { ...kept, nodeId } };
}

function writeSettings(workspaceId: string, settings: Record<string, unknown>): void {
  getDb().prepare('UPDATE workspaces SET settings = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(settings), Date.now(), workspaceId);
}

// ── Provisioning ────────────────────────────────────────────────────────────

/** Private working directory; retain its existing path so bound sessions can resume. */
export function assistantCwdFor(dataDir: string): string {
  const dir = path.join(path.resolve(dataDir), 'assistant');
  return dir.split(path.sep).includes('.michi') ? dir : path.join(dir, '.michi');
}

/** Makes `dir` and every directory from `top` down to it, private (0700); the data directory keeps its own mode. */
function privateDir(top: string, dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let each = dir;
  const chain: string[] = [];
  while (each.startsWith(top) && each !== path.dirname(top)) {
    chain.push(each);
    if (each === top) break;
    each = path.dirname(each);
  }
  for (const entry of chain) {
    try { fs.chmodSync(entry, 0o700); } catch { /* best effort on filesystems without modes */ }
  }
  return dir;
}

/** V's working directory: empty, private, per Michi data directory, never a project. */
export function assistantCwd(): string {
  const dataDir = getMichiDataDir();
  return privateDir(path.join(path.resolve(dataDir), 'assistant'), assistantCwdFor(dataDir));
}

/**
 * A check-in's working directory (DESIGN-v2 §2.2): `<data>/companion/checkin/.michi`,
 * empty and private, apart from V's, so a runtime's per-directory records
 * (Claude's `projects/<slug>`) never mix and discarding a check-in's native
 * record can never reach V's.
 */
export function checkinCwdFor(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'companion', 'checkin', '.michi');
}

export function checkinCwd(): string {
  const dataDir = getMichiDataDir();
  return privateDir(path.join(path.resolve(dataDir), 'companion'), checkinCwdFor(dataDir));
}

/** The newest live assistant workspace. */
export function findAssistantWorkspace(): WorkspaceRow | null {
  const candidates = listWorkspaces()
    .filter((ws) => ws.deleted_at == null && isAssistantWorkspaceSettings(ws.settings))
    .sort((a, b) => b.created_at - a.created_at);
  return candidates[0] ?? null;
}

/** A conversation outside a thread cannot be the assistant's. */
function usableConversation(node: NodeRow | null, workspaceId: string): node is NodeRow {
  return !!node
    && node.workspace_id === workspaceId
    && node.kind === 'chat'
    && node.deleted_at == null
    && node.status !== 'archived'
    && !!node.tree_id && !isTreeArchived(node.tree_id);
}

/** A new V: a fresh conversation, which becomes the workspace's active tree and its pointer. */
function newConversation(workspace: WorkspaceRow | null, cwd: string): { workspace: WorkspaceRow; node: NodeRow } {
  const now = Date.now();
  const workspaceId = workspace?.id ?? `p-assistant-${randomUUID()}`;
  const treeId = `t-${randomUUID()}`;
  const nodeId = `n-${randomUUID()}`;
  const title = ASSISTANT_CONVERSATION_TITLE;
  if (!workspace) {
    // Workspace writes never carry the server-owned marker (saveWorkspace),
    // so it goes on here, before the conversation exists: an interrupted
    // provisioning leaves an assistant workspace the next call completes,
    // never an ordinary workspace in the user's list.
    runInTransaction(() => {
      saveWorkspace({ id: workspaceId, name: ASSISTANT_WORKSPACE_NAME, cwd, created_at: now, updated_at: now, settings: null });
      writeSettings(workspaceId, { system: ASSISTANT_WORKSPACE_SYSTEM, assistant: { nodeId: null } });
    });
  }
  const result = ensureDurableGraphNode({
    // settings omitted: the stored blob, marker included, is kept.
    workspace: {
      id: workspaceId,
      name: workspace?.name ?? ASSISTANT_WORKSPACE_NAME,
      cwd: workspace?.cwd ?? cwd,
      createdAt: workspace?.created_at ?? now,
      activeTreeId: treeId,
    },
    tree: { id: treeId, rootNodeId: nodeId, name: title, lastActiveAt: now, createdAt: now },
    node: { id: nodeId, treeId, kind: 'chat', title, createdAt: now },
    edges: [],
    ownerUserId: null,
  });
  writeSettings(workspaceId, settingsJson(getWorkspace(workspaceId), nodeId));
  return { workspace: getWorkspace(workspaceId) ?? result.workspace, node: result.node };
}

/**
 * What an assistant conversation's next message runs on: what the user picked
 * in it, else the global settings resolved now (`followsGlobal`) with the
 * agent's reasoning (§6). Without `nodeId`, the global settings as they are.
 * A check-in node runs on V's runtime, provider and model, V's pick
 * included, always at the agent's reasoning: a one-off chip level never
 * drags a check-in past its 3 minutes. A pick stored under a check-in node's
 * own key is never read (no route writes one; E-review #14). A conversation is not pinned to the
 * runtime it ran on; when this names another runtime than its bound session,
 * the session paths open a new native session there and pass the visible
 * history as prior context (assistant_runtime_switches records where that
 * happened).
 */
export function assistantConversationRuntime(nodeId?: string | null): MetaAgentResolvedRuntime {
  if (nodeId && assistantPurposeOf(nodeId) === 'checkin') {
    // currentAssistantNodeId is a 'main' conversation, so this never comes back here.
    const v = currentAssistantNodeId();
    const runs = v ? assistantConversationRuntime(v) : { ...globalSettingsForAgent(globalAssistantRuntimeId()), followsGlobal: true };
    return { ...runs, reasoning: agentReasoningFor(runs.runtimeId) };
  }
  const choice = nodeId ? readConversationChoice(nodeId) : null;
  if (choice) return { ...choice, followsGlobal: false };
  const runtimeId = globalAssistantRuntimeId();
  return { ...(nodeId ? globalSettingsForAgent(runtimeId) : globalSettingsFor(runtimeId)), followsGlobal: true };
}

/** Where the conversation moved to another runtime; a switch undone before the next message is not shown. */
function runtimeSwitchesOf(nodeId: string): MichiAssistantRuntimeSwitch[] {
  const rows = getDb().prepare(`
    SELECT s.after_message_id, s.previous_runtime_id, s.runtime_id, s.switched_at
      FROM assistant_runtime_switches s
      JOIN messages m ON m.id = s.after_message_id AND m.node_id = s.node_id
     WHERE s.node_id = ?
     ORDER BY m.seq, s.id
  `).all(nodeId) as Array<{ after_message_id: string; previous_runtime_id: string; runtime_id: string; switched_at: number }>;
  const byAnchor = new Map<string, MichiAssistantRuntimeSwitch>();
  for (const row of rows) {
    const earlier = byAnchor.get(row.after_message_id);
    byAnchor.set(row.after_message_id, {
      afterMessageId: row.after_message_id,
      previousRuntimeId: earlier?.previousRuntimeId ?? row.previous_runtime_id,
      runtimeId: row.runtime_id,
      switchedAt: row.switched_at,
    });
  }
  return [...byAnchor.values()].filter((change) => change.runtimeId !== change.previousRuntimeId);
}

/**
 * What GET /api/assistant (and every answer naming V) sends: MichiAssistantInfo
 * plus `hadMessagesBeforeMerge` (W2 fix decision D7): the user wrote in V
 * before the v2 merge, so the panel shows its one-time upgrade note. Always
 * set here; optional in the shared type for older backends.
 */
export type AssistantInfo = MichiAssistantInfo & { hadMessagesBeforeMerge: boolean };

function info(workspace: WorkspaceRow, node: NodeRow, supported: string[]): AssistantInfo {
  const { followsGlobal: _global, ...global } = assistantConversationRuntime();
  const { followsGlobal, ...runs } = assistantConversationRuntime(node.id);
  return {
    nodeId: node.id,
    workspaceId: workspace.id,
    treeId: node.tree_id as string,
    settings: global,
    conversation: runs,
    conversationFollowsGlobal: followsGlobal,
    supportedRuntimes: supported,
    runtimeSwitches: runtimeSwitchesOf(node.id),
    jobCreated: assistantJobCreated(node.id),
    hadMessagesBeforeMerge: hadMessagesBeforeMerge(node.id),
  };
}

/** V's node id, without creating anything; null before the assistant first exists. */
export function currentAssistantNodeId(): string | null {
  const workspace = findAssistantWorkspace();
  const stored = workspace ? storedOf(workspace) : {};
  const node = workspace && typeof stored.nodeId === 'string' ? getNode(stored.nodeId) : null;
  return workspace && usableConversation(node, workspace.id) && assistantPurposeOf(node.id) === 'main' ? node.id : null;
}

/** V, creating the workspace and conversation when there is none. Idempotent. */
function ensureV(): AssistantInfo {
  // Its native sessions are recorded as they are bound (db/migrations/0032_assistant_sessions.sql).
  // The settings are read before this rewrites the workspace's stored keys: the first read folds them in.
  getMetaAgentSettings();
  const supported = assistantSupportedRuntimes();
  const cwd = assistantCwd();
  const workspace = findAssistantWorkspace();
  const stored = workspace ? storedOf(workspace).nodeId : undefined;
  const current = workspace && typeof stored === 'string' ? getNode(stored) : null;
  if (workspace && usableConversation(current, workspace.id) && assistantPurposeOf(current.id) === 'main') {
    return info(workspace, current, supported);
  }
  const created = newConversation(workspace, cwd);
  return info(created.workspace, created.node, supported);
}

/**
 * V, the user's one conversation with the agent, creating its workspace and
 * conversation on first use. Idempotent.
 *
 * Departure from DESIGN-v2 §7 (E-review #14): §7 has ensure only assert
 * that the v2 merge ran. Boot does run migrateAssistantV2 before any route
 * opens (server.ts, W2-G1a), but a caller that comes before boot (a test, a
 * tool or script outside it) would then fail; so instead of asserting, this
 * runs the merge itself when `assistant:v2_merged_at` is not written yet.
 * It is the same function: one transaction, guarded by that key, a no-op
 * once it ran, so no second V and no second archive can come of it.
 */
export function ensureAssistant(): AssistantInfo {
  if (assistantV2MergedAt() === null) migrateAssistantV2();
  return ensureV();
}

// ── The v2 merge (DESIGN-v2 §7, §8.1(c)) ────────────────────────────────────

/** Meta key: when migrateAssistantV2 ran. noticeUserMet and welcome.wanted count user messages after it. */
export const ASSISTANT_V2_MERGED_AT_KEY = 'assistant:v2_merged_at';

/** When the v2 merge ran; null before it has. */
export function assistantV2MergedAt(): number | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(ASSISTANT_V2_MERGED_AT_KEY) as { value: string } | undefined;
  const value = row ? Number(row.value) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Meta key ('1' or '0'): whether V, as the v2 merge found it, held messages the user wrote (D7). */
const ASSISTANT_V2_HAD_MESSAGES_KEY = 'assistant:v2_had_messages';

/** The user's own messages only: narration and posted check-ins are the assistant's (as welcome.wanted counts them). */
function userWroteBefore(nodeId: string, before: number): boolean {
  return !!getDb().prepare("SELECT 1 FROM messages WHERE node_id = ? AND role = 'user' AND created_at < ? LIMIT 1").get(nodeId, before);
}

/**
 * AssistantInfo.hadMessagesBeforeMerge (D7): the user talked to ⌘J
 * before v2, so the panel shows its one-time upgrade note. Decided once, in
 * the merge's transaction, from the V the merge kept, so a New conversation
 * or a History switch afterwards does not change it; false before the merge.
 * A merge an earlier build ran recorded nothing: `nodeId` (V now) decides
 * then, by the user's messages from before the merge.
 */
function hadMessagesBeforeMerge(nodeId: string): boolean {
  const mergedAt = assistantV2MergedAt();
  if (mergedAt === null) return false;
  const recorded = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(ASSISTANT_V2_HAD_MESSAGES_KEY) as { value: string } | undefined;
  return recorded ? recorded.value === '1' : userWroteBefore(nodeId, mergedAt);
}

/** What the merge calls in the agent's modules (§8.1(c), (e)); tests pass fakes. */
export interface AssistantV2MigrationHooks {
  /** §8.1(c): settings.ts migrateCompanionSettingsV2, in the merge's transaction. */
  migrateCompanionSettings(now: number): void;
  /** §7 step 5: the MVP's notes may be a hidden turn's, so they are not inlined into V until the user writes or keeps them. */
  setNotesOrigin(origin: 'checkin'): void;
}

const DEFAULT_MIGRATION_HOOKS: AssistantV2MigrationHooks = {
  migrateCompanionSettings: () => migrateCompanionSettingsV2(),
  setNotesOrigin: (origin) => setCompanionNotesOrigin(origin),
};

function hasMessages(nodeId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM messages WHERE node_id = ? LIMIT 1').get(nodeId);
}

/** Archives the tree a conversation of the assistant's workspace roots (it stays readable; History lists the 'main' ones). */
function archiveConversationTree(workspaceId: string, nodeId: string, now: number): void {
  const node = getNode(nodeId);
  if (!node || node.workspace_id !== workspaceId || !node.tree_id) return;
  getDb().prepare('UPDATE trees SET archived_at = ?, last_active_at = ? WHERE id = ? AND workspace_id = ? AND archived_at IS NULL')
    .run(now, now, node.tree_id, workspaceId);
}

/**
 * The one-time v2 merge (DESIGN-v2 §7), at boot before any route opens:
 * 1. V is the Spaces window's current conversation, kept as it is (made only
 *    when there is none);
 * 2. the Scheduled window's conversation, when it has messages, is archived
 *    (History lists it; it can be activated again);
 * 3. the MVP Companion's conversation is archived; it reads as 'checkin'
 *    (its meta says 'companion'), so History never lists it and it cannot be
 *    activated; boot cleanup discards the native sessions it recorded (§3.7);
 * 4. both pointers go;
 * 5. the agent's settings migrate (reasoning, and the MVP's default name
 *    becomes 'Michi', §8.1(c)), and its notes count as a check-in's until the
 *    user writes or keeps them;
 * 6. `assistant:v2_merged_at` is written, and `assistant:v2_had_messages`:
 *    whether the user had written in V (the upgrade note, D7).
 * Steps 2-6 are one transaction, guarded by that key: a second run changes
 * nothing. Step 1 runs first (making V takes its own transaction) and keeps
 * the old pointers, so a crash between them leaves the next run all it needs.
 */
export function migrateAssistantV2(hooks: AssistantV2MigrationHooks = DEFAULT_MIGRATION_HOOKS, now: number = Date.now()): { vNodeId: string; mergedAt: number } {
  const done = assistantV2MergedAt();
  if (done !== null) return { vNodeId: ensureV().nodeId, mergedAt: done };
  const v = ensureV();
  const mergedAt = Math.max(1, Math.trunc(now));
  const result = runInTransaction(() => {
    const already = assistantV2MergedAt();
    if (already !== null) return already;
    const workspace = getWorkspace(v.workspaceId);
    if (workspace) {
      const stored = storedOf(workspace);
      const legacy = (key: typeof LEGACY_POINTERS[number]) => {
        const id = stored[key];
        return typeof id === 'string' && id !== v.nodeId ? id : null;
      };
      const schedule = legacy('scheduleNodeId');
      if (schedule && hasMessages(schedule)) archiveConversationTree(workspace.id, schedule, mergedAt);
      const companion = legacy('companionNodeId');
      if (companion) {
        // Closed whatever its row says: it was the MVP's hidden-turn conversation.
        getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey(companion), 'companion');
        archiveConversationTree(workspace.id, companion, mergedAt);
      }
      writeSettings(workspace.id, settingsJson(getWorkspace(workspace.id), v.nodeId, true));
    }
    hooks.migrateCompanionSettings(mergedAt);
    hooks.setNotesOrigin('checkin');
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(ASSISTANT_V2_HAD_MESSAGES_KEY, userWroteBefore(v.nodeId, mergedAt) ? '1' : '0');
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(ASSISTANT_V2_MERGED_AT_KEY, String(mergedAt));
    return mergedAt;
  });
  return { vNodeId: v.nodeId, mergedAt: result };
}

function patchId(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !MODEL_ID.test(value.trim())) {
    throw new AssistantSettingsError(`${field} must be an id (letters, digits and . _ : / @ [ ] + -, starting with a letter or digit) or null`);
  }
  return value.trim();
}

/**
 * What the user picked in a conversation's composer (the current one unless
 * `nodeId` names another of the assistant's conversations). From then on that
 * conversation keeps all of runtime, provider, model and reasoning as they
 * resolve now with the patch applied; a new conversation follows the global
 * settings again. A patch naming a runtime (the composer's runtime pick)
 * starts from the global settings for that runtime, except for the non-null
 * fields it names, whatever the conversation ran on; without one, null is the
 * runtime's own default. Another provider without a model named starts on
 * its own model.
 */
export function updateAssistantSettings(patch: MichiAssistantSettingsPatch): AssistantInfo {
  if (patch.runtimeId !== undefined && (typeof patch.runtimeId !== 'string' || !getRuntime(patch.runtimeId))) {
    const registered = listRuntimes().map((runtime) => runtime.id);
    throw new AssistantSettingsError(`runtimeId must be one of: ${registered.join(', ') || '(none available)'}`);
  }
  const providerId = patch.providerId === undefined ? undefined : patchId(patch.providerId, 'providerId');
  const modelId = patch.modelId === undefined ? undefined : patchId(patch.modelId, 'modelId');
  if (patch.reasoning !== undefined && patch.reasoning !== null && !isReasoningLevel(patch.reasoning)) {
    throw new AssistantSettingsError('reasoning must be minimal, low, medium, high, xhigh, max or null');
  }
  const current = ensureAssistant();
  const nodeId = patch.nodeId ?? current.nodeId;
  const node = getNode(nodeId);
  // Only a conversation the user talks in: a check-in runs on V's settings (routes answer 409 first).
  if (!node || node.workspace_id !== current.workspaceId || node.kind !== 'chat' || node.deleted_at != null || assistantPurposeOf(nodeId) !== 'main') {
    throw new AssistantSettingsError('Assistant conversation not found');
  }
  if (patch.runtimeId === undefined && providerId === undefined && modelId === undefined && patch.reasoning === undefined) return current;
  // The composer's chips can trail the global settings, so a runtime pick
  // never depends on what the conversation resolves to now.
  const runtimePicked = patch.runtimeId !== undefined;
  const { followsGlobal: _global, ...now } = assistantConversationRuntime(nodeId);
  // A runtime pick is no reasoning pick: the agent's reasoning holds there too.
  const base = runtimePicked ? globalSettingsForAgent(patch.runtimeId as string) : now;
  const next: Required<MichiAssistantSettings> = {
    runtimeId: base.runtimeId,
    providerId: base.providerId,
    modelId: base.modelId,
    reasoning: base.reasoning,
  };
  const usesProviders = getRuntime(next.runtimeId)?.capabilities.providerModels === true;
  if (providerId !== undefined && (!runtimePicked || providerId !== null)) next.providerId = usesProviders ? providerId : null;
  if (modelId !== undefined && (!runtimePicked || modelId !== null)) next.modelId = modelId;
  if (next.providerId !== base.providerId && !modelId) next.modelId = providerModel(next.runtimeId, next.providerId);
  if (patch.reasoning !== undefined && (!runtimePicked || patch.reasoning !== null)) next.reasoning = patch.reasoning;
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(choiceKey(nodeId), JSON.stringify(next));
  return ensureAssistant();
}

/**
 * New conversation: archives V (History keeps it) and starts a fresh V with
 * the current settings. Callers check first that V is idle (no turn, no
 * runtime cleanup, no pending self-turn or post).
 */
export function resetAssistant(): { info: AssistantInfo; previousNodeId: string } {
  const current = ensureAssistant();
  const now = Date.now();
  getDb().prepare('UPDATE trees SET archived_at = ?, last_active_at = ? WHERE id = ? AND archived_at IS NULL')
    .run(now, now, current.treeId);
  const workspace = getWorkspace(current.workspaceId);
  const created = newConversation(workspace, assistantCwd());
  return {
    info: info(created.workspace, created.node, current.supportedRuntimes),
    previousNodeId: current.nodeId,
  };
}

/**
 * History (DESIGN-v2 §7): every 'main' conversation of the assistant's
 * workspace, archived by New conversation or by the v2 merge (the old
 * Scheduled ones too), but never deleted nodes, another workspace, a
 * check-in node or the MVP Companion's conversation (any purpose 'checkin').
 */
export function listAssistantConversations(limit = 5, cursor?: string): MichiAssistantConversations {
  const workspace = findAssistantWorkspace();
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AssistantSettingsError('limit must be between 1 and 50');
  let before: { updatedAt: number; nodeId: string } | null = null;
  if (cursor) {
    try {
      before = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!before || !Number.isSafeInteger(before.updatedAt) || typeof before.nodeId !== 'string' || before.nodeId.length > 160) throw new Error();
    } catch { throw new AssistantSettingsError('Invalid conversation cursor'); }
  }
  if (!workspace) return { items: [], nextCursor: null };
  const rows = getDb().prepare(`
    WITH history AS (
      SELECT n.id AS nodeId,
        COALESCE(NULLIF(n.title, 'Assistant'),
          (SELECT substr(m.content, 1, 160) FROM messages m WHERE m.node_id = n.id AND m.role = 'user' ORDER BY m.seq LIMIT 1),
          n.title, 'Assistant') AS title,
        COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.node_id = n.id), n.created_at) AS updatedAt
      FROM nodes n JOIN trees t ON t.id = n.tree_id AND t.workspace_id = n.workspace_id AND t.root_node_id = n.id
      WHERE n.workspace_id = ? AND n.kind = 'chat' AND n.deleted_at IS NULL AND n.purged_at IS NULL
        AND EXISTS (SELECT 1 FROM messages m WHERE m.node_id = n.id)
        AND substr(n.id, 1, length(?)) <> ?
        AND NOT EXISTS (SELECT 1 FROM meta p WHERE p.key = 'assistant:purpose:' || n.id AND p.value IN ('checkin', 'companion'))
    )
    SELECT * FROM history WHERE (? IS NULL OR updatedAt < ? OR (updatedAt = ? AND nodeId < ?))
    ORDER BY updatedAt DESC, nodeId DESC LIMIT ?
  `).all(workspace.id, CHECKIN_NODE_PREFIX, CHECKIN_NODE_PREFIX, before?.updatedAt ?? null, before?.updatedAt ?? null, before?.updatedAt ?? null, before?.nodeId ?? null, limit + 1) as Array<{ nodeId: string; title: string; updatedAt: number }>;
  const items = rows.slice(0, limit).map(row => ({ ...row, title: row.title.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Assistant' }));
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, nodeId: last.nodeId })).toString('base64url') : null };
}

/** Resume a saved 'main' conversation as V without cloning or losing its transcript; a check-in is never one. */
export function activateAssistantConversation(nodeId: string): AssistantInfo {
  const workspace = findAssistantWorkspace();
  const node = getNode(nodeId);
  if (!workspace || !node || node.workspace_id !== workspace.id || node.kind !== 'chat' || node.deleted_at != null || node.purged_at != null || !node.tree_id
    || assistantPurposeOf(node.id) !== 'main') {
    throw new AssistantSettingsError('Assistant conversation not found');
  }
  const tree = getDb().prepare('SELECT root_node_id FROM trees WHERE id = ? AND workspace_id = ?').get(node.tree_id, workspace.id) as { root_node_id: string } | undefined;
  if (tree?.root_node_id !== node.id) throw new AssistantSettingsError('Assistant conversation not found');
  const treeId = node.tree_id;
  const current = currentAssistantNodeId();
  if (current === nodeId) return ensureAssistant();
  runInTransaction(() => {
    const now = Date.now();
    const previous = current ? getNode(current) : null;
    if (previous?.tree_id) getDb().prepare('UPDATE trees SET archived_at = ? WHERE id = ?').run(now, previous.tree_id);
    getDb().prepare('UPDATE trees SET archived_at = NULL, last_active_at = ? WHERE id = ?').run(now, treeId);
    getDb().prepare("UPDATE nodes SET status = 'idle' WHERE id = ? AND status = 'archived'").run(node.id);
    getDb().prepare('UPDATE workspaces SET active_tree_id = ? WHERE id = ?').run(treeId, workspace.id);
    writeSettings(workspace.id, settingsJson(workspace, nodeId));
  });
  return ensureAssistant();
}
