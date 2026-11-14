/** Ordinary chats resolve Ask / Trust / YOLO on the backend for each turn.
 * Native approval requests are gated by mode; Pi also checks tools before
 * execution. Always-allow grants belong to one chat and are revocable.
 *
 * On top of the mode, Michi asks by consequence (design D19, Q26; lane D,
 * 2026-11-12), the same on every runtime that brings the call here:
 * - in a turn Michi drove (a work conversation) or that holds outside
 *   content (services/turnGuard.ts), whatever leaves the machine, or that
 *   Michi cannot read, asks, whatever the mode, grants or session trust say
 *   (forcedChatDecision); a Michi-driven conversation that started from
 *   content someone else wrote asks for network and credential reads too;
 * - in a Michi-driven turn everything else runs without asking: the work
 *   conversation's local, undoable work, in its own worktree;
 * - in a turn that only holds outside content, everything else follows the
 *   chat's mode, as in any other turn.
 * Reading outside content no longer sends the whole turn to Ask.
 */

import { getRuntimeDeps } from "./runtimeDeps";
import type { RuntimeDeps } from './runtimeDeps';
import type { RuntimeSessionOwner } from './types';
import type { ChatPermissionMode } from 'michi-shared';
import { chatNodeOf } from './ownerMapping';
import { isGuarded, turnGuard, type TurnGuard } from '../services/turnGuard';
import { callConsequence, type CallAnnotations, type CallVerdict } from './callConsequence';
import { ARTIFACT_READ_TOOL_NAMES } from './artifactToolNames';
import { noteRuntimeToolApproval } from './taintedToolGate';

/**
 * The chat node whose modes, grants and reset token apply to an owner;
 * undefined for an Agent Run owner (or none), which has no chat permissions.
 */
export function permissionNodeId(owner: RuntimeSessionOwner | undefined): string | undefined {
    return chatNodeOf(owner);
}

/**
 * The chat's permission mode for the turn now starting: the stored one. A
 * turn that holds outside content keeps it (D19: by consequence, not by
 * what it read); what must ask in such a turn asks through
 * forcedChatDecision, whatever the mode.
 */
export function chatPermissionMode(owner: RuntimeSessionOwner | undefined, ownerUserId?: string | null): ChatPermissionMode {
    const nodeId = permissionNodeId(owner);
    if (nodeId === undefined) return 'ask';
    const deps = permissionDeps();
    if (!deps?.chatPermissions) return 'ask';
    const userId = permissionOwnerUserId(owner!, ownerUserId);
    return deps.chatPermissions?.getMode(nodeId, userId) ?? 'ask';
}

/**
 * Approve for me is on for this chat's turn: Ask, with the runtime's trust
 * classifier; never in a guarded turn (services/turnGuard.ts: Michi drove
 * it, or it holds outside content), whose classifier would approve calls
 * before they reach Michi's consequence rules, so Kiro reopens the session
 * without the classifier preset before such a turn's prompt
 * (AcpAgentSession reconcilePolicyPresets, K-review #4).
 */
export function chatApproveForMe(owner: RuntimeSessionOwner | undefined, ownerUserId?: string | null): boolean {
    const nodeId = permissionNodeId(owner);
    if (nodeId === undefined) return false;
    if (isGuarded(turnGuard(nodeId))) return false;
    const deps = permissionDeps();
    if (!deps?.chatPermissions?.getApproveForMe) return false;
    return deps.chatPermissions.getApproveForMe(nodeId, permissionOwnerUserId(owner!, ownerUserId)) === true;
}

export function permissionOwnerUserId(owner: RuntimeSessionOwner, ownerUserId?: string | null): string | null | undefined {
    const nodeId = permissionNodeId(owner);
    if (ownerUserId || nodeId === undefined) return ownerUserId;
    const deps = permissionDeps();
    const node = deps?.chatPermissions ? deps.historyStore.getNode(nodeId) : null;
    return node?.workspace_id ? deps?.historyStore.getWorkspace(node.workspace_id)?.owner_user_id : null;
}

/**
 * The rules of the chat's running turn (services/turnGuard.ts); unguarded
 * for an Agent Run owner, which has its own broker.
 */
export function chatTurnGuard(owner: RuntimeSessionOwner | undefined): TurnGuard | null {
    const nodeId = permissionNodeId(owner);
    if (nodeId === undefined) return null;
    const guard = turnGuard(nodeId);
    return isGuarded(guard) ? guard : null;
}

/** Embedders without the optional chat permission port keep Ask semantics. */
function permissionDeps(): RuntimeDeps | undefined {
    try { return getRuntimeDeps(); } catch { return undefined; }
}

/** Allowed in Ask when Michi checks a tool before it runs (Pi). A runtime's
 * own request for one of these asks. */
const READ_TOOLS = new Set(['read', 'ls', 'grep', 'find', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    // Showing a workspace image to the user, and Pi's web reads (behind the user's web search setting).
    'show_image', 'web_search', 'fetch_content',
    'spawn_branches', 'save_artifact', 'update_artifact',
    // Pi's session-local todo list: no file, command, network or workspace effect.
    'todo']);

/**
 * A Michi tool under each runtime's name for it: its own (Pi's, and Claude's
 * once ClaudeSession strips Michi's MCP prefix), Claude's and Codex's MCP
 * name, and Kiro's `@michi/<tool>`, which also names a Kiro Crew call through
 * Michi's relay (crewRelayTools). Codex runs Michi's MCP tools without asking.
 */
function michiToolNames(names: readonly string[]): Set<string> {
    return new Set(names.flatMap((name) => [name, `mcp____michi_internal____${name}`, `@michi/${name}`]));
}

// The tool enforces its workspace/owner scope and optional requestApproval.
// Do not add a second runtime prompt, including for the known native MCP names.
// A message from a turn that holds outside content carries that to the turn
// it starts (threadMessageWakes.ts), whose own rules then hold (D19).
const THREAD_MESSAGE_TOOLS = michiToolNames(['send_to_thread']);

// Michi's question card, which the user answers or skips: no permission card
// in front of it, as on Pi.
const QUESTION_TOOLS = michiToolNames(['ask_user']);

// Michi Memory reads, writes and deletes (agents/memoryTools.ts) under every
// runtime's name for them: Pi's, Claude's and Codex's MCP name, Kiro's; in
// ordinary chats and in the assistant's conversation (V) alike. They reach
// only the user's own memories and the thread's workspace (V has none), a
// write from a turn that read untrusted content records that as its
// sourceRisk, one from a turn that holds check-in material is made only when
// the user's own words back it, the user can undo or delete a save, and in
// such a turn memory_delete deletes nothing. None of them asks.
const MEMORY_SELF_SCOPED_TOOLS = michiToolNames(['memory_search', 'memory_save', 'memory_update', 'memory_delete']);

// Michi's reads: its bundled docs and skill library, and the threads, messages, panes, pages,
// tasks, scheduled jobs and Agent Runs of the session's own user, which each
// tool scopes itself whatever the model passes. They change nothing.
// michi_list_tools is Kiro Crew's relay listing Michi's tools.
const MICHI_READ_ONLY_TOOLS = michiToolNames([
    'michi_docs', 'michi_skills', 'list_workspaces', 'list_threads', 'search_messages', 'read_node', 'read_node_overview',
    'read_conversation_updates', 'list_panes', 'inspect_pane', 'read_pane_output', 'wait_pane',
    'read_home', 'list_pages', 'read_page', 'read_database', 'list_page_components', 'read_page_component', 'list_tasks',
    'list_scheduled_jobs', 'list_agents', 'check_agent', 'wait_agent', 'michi_list_tools',
]);

// What Michi records about the running turn and its thread: the branch
// overview journal, follow-ups, and a scheduled batch's no-change receipt
// for that batch's own turns. Only Michi's metadata of this thread changes.
const TURN_METADATA_TOOLS = michiToolNames([
    'set_branch_overview', 'set_follow_ups', 'report_conversation_no_change',
]);

/** Michi's own tools a chat runs without a prompt in every mode, guarded
 * turns included. Tools that write pages, artifacts or files, reach the web,
 * show images, open links or start branches, Agent Runs or scheduled jobs
 * are not here; nor are the Artifacts tools, which are matched as Michi's
 * own only (isMichiTool). */
const CHAT_SELF_SCOPED_TOOLS: ReadonlySet<string> = new Set([
    ...THREAD_MESSAGE_TOOLS, ...QUESTION_TOOLS, ...MEMORY_SELF_SCOPED_TOOLS, ...MICHI_READ_ONLY_TOOLS, ...TURN_METADATA_TOOLS,
]);

/**
 * Whether toolName is Michi's own tool of one of these names, as the
 * runtimes report it, and only then: with the Michi server's prefix
 * (`mcp____michi_internal____`, Kiro's and Crew's `@michi/`), or bare where a
 * bare name can only be Michi's: Pi's pre-execution check of its built-in
 * tools (not a native request; any other tool there is
 * `mcp__<server>__<tool>`), and an adapter that took the name from Michi's
 * server and dropped the prefix (hostTool: Claude). A bare name in any other
 * native request may be another MCP server's tool.
 */
function isMichiTool(names: ReadonlySet<string>, toolName: string, nativeRequest: boolean, hostTool: boolean): boolean {
    for (const prefix of ['mcp____michi_internal____', '@michi/']) {
        if (toolName.startsWith(prefix)) return names.has(toolName.slice(prefix.length));
    }
    return (!nativeRequest || hostTool) && names.has(toolName);
}

// Reading the workspace's Artifacts (agents/artifactTools.ts), Michi's own
// only (isMichiTool): list_artifacts and search_artifacts change nothing,
// reach only the thread's own workspace and owner, and read file text only
// from the workspace's .contexts/ documents, within fixed budgets. They are
// how an agent finds the artifacts the first-turn manifest no longer names
// (it lists only pinned ones), which it used to read without a card.
const ARTIFACT_READ_TOOLS: ReadonlySet<string> = new Set<string>(ARTIFACT_READ_TOOL_NAMES);

// Tools that decide themselves whether to ask the user, in every mode,
// through their own single-use card (agents/hostApproval.ts): delete_artifact
// for every deletion; start_conversation outside a turn the user sent (in
// the user's own turn it starts without a card, 2026-11-12). A runtime prompt
// in front would be a second card for the same call, and Trust, YOLO or a
// grant must not stand in for the card, so the runtime lets them through and
// the tool decides. Michi's own only (isMichiTool): another server's tool of
// the same name asks as any tool does.
const OWN_APPROVAL_TOOLS: ReadonlySet<string> = new Set<string>(['delete_artifact', 'start_conversation']);

// The plan card is the consent: proposing runs nothing, and the list is read-only.
const MULTI_MODEL_TOOLS = new Set(['propose_multi_model_plan', 'list_ready_models']
    .flatMap((name) => [name, `mcp____michi_internal____${name}`, `@michi/${name}`]));

// Michi's reply metadata (mcpServer.ts): the host asks for it every turn, and it only
// records the branch's overview, title and follow-ups. Asking for it would stop every turn.
const HOST_METADATA_TOOLS = new Set(['set_branch_overview', 'set_follow_ups', 'set_title']
    .flatMap((name) => [name, `mcp____michi_internal____${name}`, `@michi/${name}`]));

// The agent's own tools (assistant/policy.ts COMPANION_OWN_TOOL_NAMES) under
// every runtime's name: each scopes itself and asks for its own approval
// where it needs one (companion_session_send asks for the exact text), so
// no runtime prompt is added on top, as for scoped thread messaging above.
const COMPANION_SELF_GATED_TOOLS = new Set(['companion_items', 'companion_item', 'companion_check_now',
    'companion_update_item', 'companion_save_notes', 'companion_goal_progress', 'companion_edit_goal', 'companion_propose',
    'companion_publish_brief', 'companion_set_name', 'companion_set_notifications', 'companion_read', 'companion_pipeline_detail',
    'companion_session_send', 'companion_headline', 'nothing_to_do']
    .flatMap((name) => [name, `mcp____michi_internal____${name}`, `@michi/${name}`]));

/** What a call carries beyond its name, for its consequence (agents/callConsequence.ts). */
export interface ChatCallDetail {
    input?: unknown;
    /** The call's ACP tool kind, when the runtime gives one. */
    kind?: string;
    annotations?: CallAnnotations;
}

/** Michi's own tools that gate themselves or only record, ask or read: no consequence rule stands in front of them. */
function selfGated(owner: RuntimeSessionOwner, toolName: string, nativeRequest: boolean, hostTool: boolean): boolean {
    if (permissionNodeId(owner) === undefined) return false;
    return COMPANION_SELF_GATED_TOOLS.has(toolName) || CHAT_SELF_SCOPED_TOOLS.has(toolName)
        || isMichiTool(ARTIFACT_READ_TOOLS, toolName, nativeRequest, hostTool)
        || isMichiTool(OWN_APPROVAL_TOOLS, toolName, nativeRequest, hostTool)
        || MULTI_MODEL_TOOLS.has(toolName) || HOST_METADATA_TOOLS.has(toolName);
}

/** Why a forced ask asks, in the card the user sees. */
export interface ForcedAsk { decision: 'ask'; reason: string; verdict: CallVerdict }

const WHY_DRIVEN = 'Michi is doing this work for you';
const WHY_OUTSIDE = 'this conversation read content from outside';
const WHY_SOURCED = 'this work started from content someone else wrote';

/**
 * A decision no mode, always-allow grant or session trust overrides (D19,
 * Q26): in a guarded turn (services/turnGuard.ts), a call that leaves the
 * machine, or that Michi cannot read, asks; in a Michi-driven conversation
 * that started from content someone else wrote, network and credential
 * reads ask too. Null otherwise: the mode decides. Michi's self-gated tools
 * are never forced (their own rules hold).
 */
export function forcedChatDecision(owner: RuntimeSessionOwner, toolName: string, detail: ChatCallDetail = {}, nativeRequest = false,
    hostTool = false): ForcedAsk | null {
    if (selfGated(owner, toolName, nativeRequest, hostTool)) return null;
    const guard = chatTurnGuard(owner);
    // A check-in's own turn has nobody to ask: backgroundRefusal refuses instead.
    if (!guard || guard.background) return null;
    const verdict = callConsequence({ toolName, input: detail.input, hostTool, kind: detail.kind, annotations: detail.annotations });
    const because = guard.outsideSourced ? WHY_SOURCED : guard.michiDriven ? WHY_DRIVEN : WHY_OUTSIDE;
    const what = verdict.why ?? toolName;
    if (verdict.consequence === 'egress') return { decision: 'ask', reason: `Leaves this machine (${what}), and ${because}.`, verdict };
    if (verdict.consequence === 'unclear') return { decision: 'ask', reason: `Michi cannot tell whether this leaves the machine (${what}), and ${because}.`, verdict };
    if (guard.outsideSourced && (verdict.consequence === 'network_read' || verdict.consequence === 'credential_read')) {
        const reads = verdict.consequence === 'network_read' ? 'Reaches the network' : 'Reads credentials';
        return { decision: 'ask', reason: `${reads} (${what}), and ${because}.`, verdict };
    }
    return null;
}

/**
 * Why a call from a check-in's own turn (services/turnGuard.ts background:
 * check-ins and the work heartbeat, however the scheduler started them) is
 * refused, or null: nobody is there to answer, so anything but a read or a
 * local, Michi-internal change is refused rather than asked. Its closed
 * toolset holds no such tool; this is the backstop. Michi's self-gated tools
 * (the agent's own, whose deep reads a check-in keeps) hold their own rules.
 */
export function backgroundRefusal(owner: RuntimeSessionOwner, toolName: string, detail: ChatCallDetail = {}, nativeRequest = false,
    hostTool = false): string | null {
    if (selfGated(owner, toolName, nativeRequest, hostTool)) return null;
    if (!chatTurnGuard(owner)?.background) return null;
    const verdict = callConsequence({ toolName, input: detail.input, hostTool, kind: detail.kind, annotations: detail.annotations });
    if (verdict.consequence === 'read' || verdict.consequence === 'local') return null;
    return `A check-in runs with nobody to ask, so Michi refuses this (${verdict.why ?? toolName}).`;
}

/** Ordinary chat approvals ignore legacy workspace-wide grants. Apart from
 * Michi's own self-scoped tools, its Artifact reads, tools that ask the user
 * themselves, the agent's own tools, multi-model plans and Michi's reply
 * metadata, native requests ask in Ask mode; Pi also gates unknown/MCP tools
 * before execution. In a guarded turn (D19, Q26), forcedChatDecision asks
 * first; what it lets through runs without asking in a Michi-driven turn (a
 * work conversation), and by the chat's mode in a turn that only holds
 * outside content. `hostTool`: PermissionDecisionRequest.hostTool. */
export function resolveChatPolicy(owner: RuntimeSessionOwner, ownerUserId: string | null, toolName: string, nativeRequest = false,
    mode = chatPermissionMode(owner, ownerUserId), hostTool = false, detail: ChatCallDetail = {}): PermissionDecision {
    const nodeId = permissionNodeId(owner);
    if (selfGated(owner, toolName, nativeRequest, hostTool)) return 'allow';
    if (backgroundRefusal(owner, toolName, detail, nativeRequest, hostTool)) return 'deny';
    if (forcedChatDecision(owner, toolName, detail, nativeRequest, hostTool)) return 'ask';
    if (chatTurnGuard(owner)?.michiDriven) return 'allow';
    return modePolicy(owner, ownerUserId, toolName, nativeRequest, mode, nodeId);
}

function modePolicy(owner: RuntimeSessionOwner, ownerUserId: string | null, toolName: string, nativeRequest: boolean,
    mode: ChatPermissionMode, nodeId: string | undefined): PermissionDecision {
    if (mode !== 'ask') return 'allow';
    if (nodeId !== undefined && permissionDeps()?.chatPermissions?.hasGrant(nodeId, michiGrantKey(toolName), permissionOwnerUserId(owner, ownerUserId))) return 'allow';
    return !nativeRequest && READ_TOOLS.has(toolName) ? 'allow' : 'ask';
}

/**
 * The permission port's note that the user approved this one call through
 * Michi's prompt (ApprovalCoordinator.accept): Michi's own tool, when the
 * call reaches its MCP dispatch from a guarded turn, does not ask a second
 * time (agents/taintedToolGate.ts, w3-fix D23).
 */
export function noteChatToolApproval(owner: RuntimeSessionOwner, toolName: string): void {
    const nodeId = permissionNodeId(owner);
    if (nodeId !== undefined) noteRuntimeToolApproval(nodeId, toolName);
}

export function grantChatPermission(owner: RuntimeSessionOwner, toolName: string, ownerUserId?: string | null): void {
    const nodeId = permissionNodeId(owner);
    if (nodeId !== undefined) permissionDeps()?.chatPermissions?.grant(nodeId, michiGrantKey(toolName), permissionOwnerUserId(owner, ownerUserId));
}

// Moved to the Codex adapter; re-exported for existing importers.
export { codexChatTurnPolicy } from 'michi-runtime/internal/adapters/codex/codexTurnPolicy';

export type PermissionDecision = "allow" | "ask" | "deny";

/**
 * PascalCase write and exec tool names (Claude reports them) and the
 * canonical tool whose grant key they share. Read-only names (Read, Glob,
 * Grep) are not here: their grants were always stored under the name itself.
 */
const GRANT_KEY_ALIASES = new Map([
    ['Bash', 'bash'],
    ['Edit', 'edit'],
    ['Write', 'write'],
    ['MultiEdit', 'edit'],
    ['NotebookEdit', 'edit'],
]);

/**
 * The key a chat always-allow grant is stored under, whichever runtime asks:
 * the name itself, or for the aliases above the canonical tool's, so one
 * grant answers both. Adapters read it through the permission port's
 * grantKey. Saved grants are looked up by this key: never change it.
 */
export function michiGrantKey(toolName: string): string {
    return GRANT_KEY_ALIASES.get(toolName) ?? toolName;
}
