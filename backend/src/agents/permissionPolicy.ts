/** Ordinary chats resolve Ask / Trust / YOLO on the backend for each turn.
 * Native approval requests are gated by mode; Pi also checks tools before
 * execution. Always-allow grants belong to one chat and are revocable.
 */

import { randomUUID } from 'node:crypto';
import { getRuntimeDeps } from "./runtimeDeps";
import type { RuntimeDeps } from './runtimeDeps';
import type { RuntimeSessionOwner } from './types';
import type { ChatPermissionMode } from 'michi-shared';
import { chatNodeOf } from './ownerMapping';
import { activeCompanionTaint } from '../services/turnTrust';
import { michiBareToolName, michiToolEffect } from '../assistant/toolEffects';
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
 * The chat's permission mode for the turn now starting. A turn that started
 * with check-in or collector material (DESIGN-v2 §2.8 T4: the route records
 * it before the turn begins; a check-in's direct send records it on its
 * `cms-` turn, w3-fix D15), or that runs on the chat's live session after an
 * earlier turn took some in (sticky: w2-fix D1 for V, w3-fix D17 for every
 * chat; turnTrust.ts activeCompanionTaint), runs in Ask, on every runtime,
 * since each one reads this when its turn starts; the stored mode is left as
 * it is. A taint that cannot be read counts as one.
 */
export function chatPermissionMode(owner: RuntimeSessionOwner | undefined, ownerUserId?: string | null): ChatPermissionMode {
    const nodeId = permissionNodeId(owner);
    if (nodeId === undefined) return 'ask';
    const deps = permissionDeps();
    if (!deps?.chatPermissions) return 'ask';
    if (activeCompanionTaint(nodeId)) return 'ask';
    const userId = permissionOwnerUserId(owner!, ownerUserId);
    return deps.chatPermissions?.getMode(nodeId, userId) ?? 'ask';
}

/**
 * Approve for me is on for this chat's turn: Ask, with the runtime's trust
 * classifier; never while the turn holds check-in material, its own or what
 * its live session took in on an earlier turn (D17), so Kiro reopens the
 * session without the classifier preset before such a turn's prompt
 * (AcpAgentSession reconcilePolicyPresets, K-review #4).
 */
export function chatApproveForMe(owner: RuntimeSessionOwner | undefined, ownerUserId?: string | null): boolean {
    const nodeId = permissionNodeId(owner);
    if (nodeId === undefined) return false;
    if (activeCompanionTaint(nodeId)) return false;
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
 * The permission port's reset token while the chat holds check-in or
 * collector material (DESIGN-v2 §2.8: its turn read some, or its live
 * session did earlier, w2-fix D1 / w3-fix D17): a new one on every read, so "Trust all
 * tools for this session", given before or during it, never matches and
 * each call goes to the policy, which asks. Undefined otherwise: the chat
 * permission store's token applies (chatApprovalState.ts).
 */
export function companionTaintResetToken(nodeId: string): string | undefined {
    return activeCompanionTaint(nodeId) ? `checkin-material:${randomUUID()}` : undefined;
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
// Do not add a second runtime prompt, including for the known native MCP names,
// except in a turn that holds check-in material, where it asks (resolveChatPolicy, D15).
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

/** Michi's own tools a chat runs without a prompt in every mode; a turn that
 * holds check-in material runs only the reads and Michi-internal writes among
 * them without one (resolveChatPolicy). Tools that write pages, artifacts or
 * files, reach the web, show images, open links or start branches, Agent Runs
 * or scheduled jobs are not here; nor are the Artifacts tools, which are
 * matched as Michi's own only (isMichiTool). */
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

// Tools that ask the user themselves, every time and in every mode, through
// their own single-use card (agents/hostApproval.ts): delete_artifact. A
// runtime prompt in front would be a second card for the same call, and
// Trust, YOLO or a grant must not stand in for the card, so the runtime
// lets them through and the tool's card decides. Michi's own only
// (isMichiTool): another server's delete_artifact asks as any tool does.
const OWN_APPROVAL_TOOLS: ReadonlySet<string> = new Set<string>(['delete_artifact']);

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
    'companion_publish_brief', 'companion_set_name', 'companion_read', 'companion_pipeline_detail',
    'companion_session_send', 'nothing_to_do']
    .flatMap((name) => [name, `mcp____michi_internal____${name}`, `@michi/${name}`]));

/** Native tools that only read the session's own folder: they may run in a turn that holds check-in material. */
const LOCAL_READ_TOOLS = new Set(['read', 'ls', 'grep', 'find', 'Read', 'Glob', 'Grep']);

/**
 * What a turn that holds check-in or collector material may still run
 * (§2.8 T5): local read-only native tools, and Michi's own tools the effect
 * register (assistant/toolEffects.ts) classes as reads or Michi-internal
 * writes. The web, commands, file writes, other MCP servers and anything that
 * starts other work ask.
 */
function runsWithCheckinMaterial(toolName: string): boolean {
    if (LOCAL_READ_TOOLS.has(toolName)) return true;
    const bare = michiBareToolName(toolName);
    const effect = bare ? michiToolEffect(bare) : null;
    return effect === 'read' || effect === 'michi_write';
}

/** Ordinary chat approvals ignore legacy workspace-wide grants. Apart from
 * Michi's own self-scoped tools, its Artifact reads, tools that ask the user
 * themselves, the agent's own tools, multi-model plans and Michi's reply
 * metadata, native requests ask in Ask mode; Pi also gates unknown/MCP tools
 * before execution. A turn that holds check-in or collector
 * material (§2.8 T5; a check-in's direct send, D15; sticky, D1 / D17) is never
 * wider than Ask, whatever mode it started in: always-allow grants are
 * ignored, session trust never matches (companionTaintResetToken), and a tool
 * that would otherwise run without asking does so only if
 * runsWithCheckinMaterial. So send_to_thread, start_conversation,
 * spawn_branches, scheduled jobs and Agent Runs (the register's `indirect`
 * tools: they make another turn run) ask, on every runtime that brings the
 * call here; of the self-scoped tools, Michi's reads, Memory and reply
 * metadata still run, and the question card and multi-model plans ask.
 * `hostTool`: PermissionDecisionRequest.hostTool. */
export function resolveChatPolicy(owner: RuntimeSessionOwner, ownerUserId: string | null, toolName: string, nativeRequest = false,
    mode = chatPermissionMode(owner, ownerUserId), hostTool = false): PermissionDecision {
    const nodeId = permissionNodeId(owner);
    if (nodeId !== undefined && COMPANION_SELF_GATED_TOOLS.has(toolName)) return 'allow';
    const tainted = nodeId !== undefined && activeCompanionTaint(nodeId) !== null;
    const decision = untaintedChatPolicy(owner, ownerUserId, toolName, nativeRequest, hostTool, mode, nodeId, !tainted);
    return tainted && decision === 'allow' && !runsWithCheckinMaterial(toolName) ? 'ask' : decision;
}

function untaintedChatPolicy(owner: RuntimeSessionOwner, ownerUserId: string | null, toolName: string, nativeRequest: boolean,
    hostTool: boolean, mode: ChatPermissionMode, nodeId: string | undefined, grants: boolean): PermissionDecision {
    if (nodeId !== undefined && (CHAT_SELF_SCOPED_TOOLS.has(toolName)
        || isMichiTool(ARTIFACT_READ_TOOLS, toolName, nativeRequest, hostTool)
        || isMichiTool(OWN_APPROVAL_TOOLS, toolName, nativeRequest, hostTool)
        || MULTI_MODEL_TOOLS.has(toolName) || HOST_METADATA_TOOLS.has(toolName))) return 'allow';
    if (mode !== 'ask') return 'allow';
    if (grants && nodeId !== undefined && permissionDeps()?.chatPermissions?.hasGrant(nodeId, michiGrantKey(toolName), permissionOwnerUserId(owner, ownerUserId))) return 'allow';
    return !nativeRequest && READ_TOOLS.has(toolName) ? 'allow' : 'ask';
}

/**
 * The permission port's note that the user approved this one call through
 * Michi's prompt (ApprovalCoordinator.accept): Michi's own tool, when the
 * call reaches its MCP dispatch from a turn that holds check-in material,
 * does not ask a second time (agents/taintedToolGate.ts, w3-fix D23).
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
