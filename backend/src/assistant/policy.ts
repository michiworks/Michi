import { claudeSpawnPolicy as runtimeClaudeSpawnPolicy, type ClaudeSpawnPolicyInput } from 'michi-runtime/internal/adapters/claude/claudeRestrictedProfile';
/** Assistant identity and Michi tools are independent of runtime restrictions.
 * The user's conversation with the agent (V) uses ordinary native tools, MCP
 * configuration and approvals. Background maintenance retains its closed
 * tool profile, and so does every check-in (DESIGN-v2 §2): it runs
 * unattended over untrusted collector material, so it gets the closed 'chat'
 * toolset with its own allow-list (assistantToolProfile('checkin')) on every
 * runtime.
 */

import { MICHI_AGENT_RUNTIMES } from 'michi-shared';
import { createHash } from 'node:crypto';
import type { RuntimeToolProfile } from '../agents/types';
import { PAGE_TOOL_NAMES } from '../agents/pageToolNames';
import { SCHEDULED_JOB_TOOL_NAMES } from '../agents/scheduledJobToolNames';
import { MEMORY_TOOL_NAMES } from '../agents/memoryToolNames';
import { isMetaAgentProfile, metaAgentRuntimeAvailability } from '../agents/metaAgentGuard';
import { AGENT_RUN_TOOL_NAMES } from 'michi-runtime/internal/contract/tools';
import { companionCheckinInstructions, companionMainInstructions } from '../services/companion/prompts';

/**
 * What one assistant conversation is for (DESIGN-v2 §2.2): `main` is V, the
 * user's one visible conversation with the agent, on the open profile;
 * `checkin` is a check-in's throwaway node S, on the closed one. The two
 * never share a node or a session. identity.ts assistantPurposeOf decides,
 * from the node id first (CHECKIN_NODE_PREFIX), so no meta row can open S.
 */
export type AssistantPurpose = 'main' | 'checkin';

/** The assistant's capabilities. Each one enforces its own rules. */
export const ASSISTANT_TOOL_NAMES = [
  'michi_docs',
  'michi_skills',
  'open_url',
  'show_image',
  'list_workspaces',
  'list_threads',
  'search_messages',
  'read_node',
  'read_node_overview',
  'list_panes',
  'inspect_pane',
  'read_pane_output',
  'wait_pane',
  'send_to_thread',
] as const;

export type AssistantToolName = typeof ASSISTANT_TOOL_NAMES[number];

/** Michi's user channel on MCP runtimes: structured questions. */
export const ASSISTANT_CHANNEL_TOOL_NAMES = ['ask_user'] as const;

/**
 * Ordinary chat metadata tools. The assistant has a fixed identity and
 * answers directly, so its catalog and runtime hooks omit these tools.
 */
export const TURN_METADATA_TOOL_NAMES = [
  'set_follow_ups',
  'set_branch_overview',
] as const;

/** Reserved: starts an ordinary conversation with the user's global settings. */
export const START_CONVERSATION_TOOL = 'start_conversation';

/** Lists, adds and removes a page's layout rules. */
export const LAYOUT_RULES_TOOL = 'layout_rules';

/**
 * ⌘J's Michi tools (34 with preview_page): the assistant's without
 * send_to_thread (continuing a thread is the user's own send), the
 * conversation-updates reader, the Page tools, layout rules, starting a
 * conversation and ask_user.
 */
export const META_AGENT_CHAT_TOOL_NAMES: readonly string[] = Object.freeze([
  ...ASSISTANT_TOOL_NAMES.filter((name) => name !== 'send_to_thread'),
  'read_conversation_updates',
  ...PAGE_TOOL_NAMES,
  LAYOUT_RULES_TOOL,
  START_CONVERSATION_TOOL,
  ...ASSISTANT_CHANNEL_TOOL_NAMES,
]);

/**
 * The agent's own tools (services/companion/tools.ts COMPANION_OWN_TOOLS):
 * its feed, a fresh check, item, name and notification level changes, notes,
 * goal readings and edits, cards, today's brief, the allow-listed deep reads, reading what its
 * check-ins wrote (companion_read), follow-ups into the conversations it
 * started (companion_session_send, §4: V only, asking the user for the exact
 * text itself) and the quiet end of a check-in. Every one enforces its own
 * rules, so none asks for a runtime approval (permissionPolicy.ts).
 */
export const COMPANION_OWN_TOOL_NAMES = Object.freeze([
  'companion_items',
  'companion_item',
  'companion_check_now',
  'companion_update_item',
  'companion_save_notes',
  'companion_goal_progress',
  'companion_edit_goal',
  'companion_propose',
  'companion_publish_brief',
  'companion_set_name',
  'companion_set_notifications',
  'companion_read',
  'companion_session_send',
  'companion_headline',
  'nothing_to_do',
] as const);

export type CompanionOwnToolName = typeof COMPANION_OWN_TOOL_NAMES[number];

/**
 * V's Michi tools (§2.3, 59 with preview_page and companion_set_notifications): everything ⌘J had, the
 * Scheduled window's job tools (updating, running or deleting a job on its
 * own approval card, creating too when the user's setting asks for it or the
 * turn read outside content: agents/scheduledJobTools.ts), Michi Memory's four
 * tools with the user scope as V's own (assistant/tools.ts), and the agent's
 * own tools but nothing_to_do and companion_headline, which only a check-in uses
 * (companion_session_send included: V's only). Native and user MCP tools come
 * on top, under the user's permission mode and §2.8.
 */
export const MAIN_TOOL_NAMES: readonly string[] = Object.freeze([
  ...META_AGENT_CHAT_TOOL_NAMES,
  ...SCHEDULED_JOB_TOOL_NAMES,
  ...MEMORY_TOOL_NAMES,
  ...COMPANION_OWN_TOOL_NAMES.filter((name) => name !== 'nothing_to_do' && name !== 'companion_headline'),
]);

/**
 * A check-in's whole catalog and its closed profile's allow-list (§2.3, 32
 * tools): Michi's reads (no wait_pane: a check-in has 3 minutes), the Page
 * tools a check-in may use behind checkinPageGuard.ts (no Home, components,
 * layout rules or custom views), the agent's own tools it may use in a
 * hidden turn, its three deep reads and nothing_to_do. No native tool, user
 * MCP, start_conversation, job, Memory tool (a check-in only reads the
 * memory notes it starts with), ask_user, companion_read (V's only), check
 * now, rename or companion_session_send: a check-in's follow-up is a
 * session.send card through companion_propose, which sends it itself only
 * into a conversation that runs in Ask (§4, Q1). toolEffects.ts keeps it to
 * read, deep-read and Michi-write effects, plus the cards it proposes.
 */
export const CHECKIN_TOOL_NAMES: readonly string[] = Object.freeze([
  'michi_docs',
  'list_workspaces',
  'list_threads',
  'search_messages',
  'read_node',
  'read_node_overview',
  'list_panes',
  'inspect_pane',
  'read_pane_output',
  'read_conversation_updates',
  'list_tasks',
  'list_pages',
  'read_page',
  'read_database',
  'edit_page',
  'create_page',
  'edit_database',
  'create_database',
  'configure_database',
  'open_task_database',
  'companion_items',
  'companion_item',
  'companion_update_item',
  'companion_save_notes',
  'companion_goal_progress',
  'companion_edit_goal',
  'companion_propose',
  'companion_publish_brief',
  'companion_headline',
  'nothing_to_do',
]);

/**
 * Pi only: the builtins ⌘J had on Pi beside its catalog, which V keeps
 * (§2.3, piTools.ts): artifacts, branches, Agent Runs and Michi's web tools
 * (images and links are in its catalog on every runtime). Nothing else
 * ordinary chats have (send_to_thread, turn metadata) reaches V; its Memory
 * tools are its catalog's. Pi's native file and command tools are the
 * runtime's own (PI_NATIVE_TOOL_NAMES).
 */
export const PI_MAIN_EXTRA: readonly string[] = Object.freeze([
  'save_artifact',
  'update_artifact',
  'spawn_branches',
  'web_search',
  'fetch_content',
  ...AGENT_RUN_TOOL_NAMES,
]);

/** Pi's own file and command tools: the runtime's native tools, V's on Pi as on every runtime. */
export const PI_NATIVE_TOOL_NAMES: readonly string[] = Object.freeze(['read', 'ls', 'grep', 'find', 'write', 'edit', 'bash']);

/** The Michi tools an assistant conversation of this purpose has. */
export function assistantToolNamesFor(purpose: AssistantPurpose): readonly string[] {
  return purpose === 'checkin' ? CHECKIN_TOOL_NAMES : MAIN_TOOL_NAMES;
}

/**
 * A Michi tool a closed assistant session may run without a prompt: one on
 * this session's own allow-list (§2.5). Each tool gates itself, and the
 * runtime checks the catalog against the profile at launch; a call to
 * anything else, start_conversation and ask_user included, is refused.
 * Without an allow-list nothing passes.
 */
export function restrictedAssistantToolAllowed(name: string | null | undefined, profile: RuntimeToolProfile | null | undefined): boolean {
  if (!name || profile?.restricted !== true) return false;
  return (profile.allowedToolNames ?? []).includes(name);
}

/** V's instructions (companionMainInstructions) or a check-in's (companionCheckinInstructions), both opening with the marker. */
export function assistantInstructionsFor(purpose: AssistantPurpose): string {
  return purpose === 'checkin' ? companionCheckinInstructions() : companionMainInstructions();
}

/**
 * The tool profile an assistant session of this purpose runs with (§2.2).
 * V's is open: the runtime's own tools, the user's MCP servers and
 * permission mode. A check-in's is closed: the 'chat' toolset restricted to
 * CHECKIN_TOOL_NAMES, so Claude runs with no built-in tools, no MCP server
 * but Michi's, no user settings and never bypasses permissions; Codex
 * read-only and offline with every approval declined; Pi and Kiro with that
 * catalog only. Each runtime checks the catalog it exposes at launch and
 * fails the session (MetaAgentGuardError) on anything else.
 */
export function assistantToolProfile(purpose: AssistantPurpose = 'main'): RuntimeToolProfile {
  return purpose === 'checkin'
    ? { assistant: true, restricted: true, metaAgentToolset: 'chat', allowedToolNames: CHECKIN_TOOL_NAMES }
    : { assistant: true };
}

export function isAssistantProfile(profile: RuntimeToolProfile | null | undefined): boolean {
  return profile?.assistant === true;
}

/**
 * A check-in's closed profile (assistantToolProfile('checkin')): an
 * assistant profile whose allow-list ends a turn with nothing_to_do, which
 * no other profile has. Its sessions get the check-in head, not V's
 * (agents/preamble.ts).
 */
export function isCompanionProfile(profile: RuntimeToolProfile | null | undefined): boolean {
  return isAssistantProfile(profile) && profile!.restricted === true
    && (profile!.allowedToolNames ?? []).includes('nothing_to_do');
}

/**
 * A chat's first-message prefix: the context Michi adds (workspace
 * instructions, artifacts, ancestors, history carried over) and the chat's own
 * bootstrap (a primary Agent's or the assistant's instructions). The
 * assistant's instructions open it, ahead of any context: how its first
 * message opens (MICHI_ASSISTANT_MARKER) stays stable across rebuilt sessions.
 */
export function chatFirstTurnPrefix(contextPrefix: string, bootstrap: string | undefined, profile: RuntimeToolProfile | null | undefined): string {
  const parts = isAssistantProfile(profile) ? [bootstrap, contextPrefix] : [contextPrefix, bootstrap];
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Changes whenever the assistant's instructions or tools change, so live
 * sessions are rebuilt (§2.2): version 3, so every live V session is rebuilt
 * once, history included, and a session that ran on one profile is never
 * resumed on the other.
 */
export function assistantProfileHash(runtimeProfile: unknown, purpose: AssistantPurpose = 'main'): string {
  return createHash('sha256').update(JSON.stringify({
    assistant: 3,
    purpose,
    restricted: assistantToolProfile(purpose).restricted === true,
    instructions: assistantInstructionsFor(purpose),
    tools: assistantToolNamesFor(purpose),
    runtimeProfile,
  })).digest('hex');
}

// ── Runtimes ────────────────────────────────────────────────────────────────

/** Runtimes that can host the assistant, in default-preference order: Michi's one list. */
export const ASSISTANT_RUNTIMES = MICHI_AGENT_RUNTIMES;

export function isAssistantRuntime(runtimeId: string): boolean {
  return (ASSISTANT_RUNTIMES as readonly string[]).includes(runtimeId);
}

/** Why a runtime cannot host the assistant; null when it can. */
export function assistantRuntimeRefusal(runtimeId: string): string | null {
  if (isAssistantRuntime(runtimeId)) return null;
  return metaAgentRuntimeAvailability(runtimeId).reason ?? `The ${runtimeId} runtime cannot host the Michi assistant.`;
}

/** Thrown by runtimes that cannot host the Meta agent's chat toolset (Crew). */
export class AssistantRuntimeUnsupportedError extends Error {
  constructor(runtimeId: string) {
    super(assistantRuntimeRefusal(runtimeId) ?? `The ${runtimeId} runtime cannot host the Michi assistant.`);
    this.name = 'AssistantRuntimeUnsupportedError';
  }
}

// ── Claude ──────────────────────────────────────────────────────────────────

/**
 * Every built-in tool as a deny rule: all those Claude Code 2.1.305 lists in
 * an ordinary session's init, plus older, renamed, platform and feature-gated
 * ones. Deny rules hold in every permission mode and override allow rules in
 * the user's settings; they back up `--tools ""`, which already removes
 * these, so that even a CLI ignoring --tools cannot read files, search,
 * run commands or reach the network.
 */
export { CLAUDE_RESTRICTED_DISALLOWED_TOOLS as CLAUDE_ASSISTANT_DISALLOWED_TOOLS } from 'michi-runtime/internal/adapters/claude/claudeRestrictedProfile';
export type { ClaudeSpawnPolicy } from 'michi-runtime/internal/adapters/claude/claudeRestrictedProfile';

/** The app selects the restricted profile; the runtime owns the native flags. */
export function claudeSpawnPolicy(input: ClaudeSpawnPolicyInput) {
  return runtimeClaudeSpawnPolicy(input.toolProfile?.restricted === true || isMetaAgentProfile(input.toolProfile), input);
}

/**
 * The approve gate's verdict for a restricted assistant session (a
 * check-in), in every permission mode (§2.5): 'allow' only for a Michi tool
 * on this session's own allow-list (they gate themselves, and a hidden turn
 * never waits on a prompt), 'deny' for anything else, native and other MCP
 * tools included. `michiToolName` is the bare name when the call is to
 * Michi's MCP server; ClaudeSession passes the session's profile.
 */
export function claudeAssistantApproval(michiToolName: string | null, profile?: RuntimeToolProfile | null): 'allow' | 'deny' {
  return restrictedAssistantToolAllowed(michiToolName, profile) ? 'allow' : 'deny';
}

// ── Codex ───────────────────────────────────────────────────────────────────

export type { CodexTurnPolicy, CodexRestrictedMcpCheck as CodexAssistantMcpCheck } from 'michi-runtime/internal/adapters/codex/codexRestrictedProfile';
export {
  CODEX_RESTRICTED_TURN_POLICY as CODEX_ASSISTANT_TURN_POLICY,
  CODEX_RESTRICTED_FEATURES_OFF as CODEX_ASSISTANT_FEATURES_OFF,
  codexRestrictedThreadConfig as codexAssistantThreadConfig,
  codexRestrictedMcpCheck as codexAssistantMcpCheck,
} from 'michi-runtime/internal/adapters/codex/codexRestrictedProfile';
export { CODEX_HOST_MCP_SERVER as CODEX_MICHI_MCP_SERVER } from 'michi-runtime/internal/adapters/codex/codexProtocol';
export { CODEX_META_AGENT_UNREMOVABLE_TOOLS, codexMetaAgentCatalog } from 'michi-runtime/internal/adapters/codex/codexToolCatalog';

/** thread/start and thread/resume sandbox chosen by the host's profile. */
export function codexThreadSandbox(toolProfile: RuntimeToolProfile | null | undefined): 'read-only' | 'workspace-write' {
  return isMetaAgentProfile(toolProfile) || toolProfile?.restricted === true ? 'read-only' : 'workspace-write';
}

/** An assistant never approves a command, file change, extra permission or MCP elicitation. */
export function codexAssistantApproval(): 'decline' {
  return 'decline';
}

// ── Pi ──────────────────────────────────────────────────────────────────────

/**
 * Pi's beforeToolCall verdict for a restricted assistant session (a
 * check-in), in every permission mode (§2.5): a tool outside this session's
 * own allow-list is blocked; the session's own tools run without a chat
 * prompt because each one enforces its own rules and a hidden turn never asks.
 */
export function piAssistantToolDecision(toolName: string, profile: RuntimeToolProfile | null | undefined): 'allow' | 'block' {
  return restrictedAssistantToolAllowed(toolName, profile) ? 'allow' : 'block';
}
