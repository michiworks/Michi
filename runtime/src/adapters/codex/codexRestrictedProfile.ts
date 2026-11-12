import { CODEX_HOST_MCP_SERVER, codexDisableMcpServers, codexOpenUserMcpServers } from './codexProtocol';

/**
 * How a Codex session enforces the host's restricted profile
 * (SessionProfilePort.isRestricted): a restricted session may call only the
 * host's own tools. Its turns run read-only and offline, its thread starts
 * read-only with Codex's shell, plugins and other tools off and every MCP
 * server but the host's disabled, every approval or elicitation is declined,
 * and a question gets no answer and never reaches the chat (CodexRuntime):
 * no turn waits on a user who may not be watching. Codex refuses its
 * sub-agent spawns (CODEX_RESTRICTED_FEATURES_OFF), and CodexSession stops
 * the turn if a child starts anyway. The thread config and MCP check below
 * are Michi's assistant lockdown (assistant/policy.ts re-exports them).
 */

export interface CodexTurnPolicy {
  approvalPolicy: string;
  sandboxPolicy: Record<string, unknown>;
}

/** turn/start policy of a restricted session: read-only, offline; approvals are declined. */
export const CODEX_RESTRICTED_TURN_POLICY: CodexTurnPolicy = Object.freeze({
  approvalPolicy: 'on-request',
  sandboxPolicy: Object.freeze({ type: 'readOnly', networkAccess: false }),
}) as CodexTurnPolicy;

/** thread/start and thread/resume `sandbox` of a session, from the host's restricted verdict. */
export function codexThreadSandbox(restricted: boolean): 'read-only' | 'workspace-write' {
  return restricted ? 'read-only' : 'workspace-write';
}

/**
 * Codex feature flags an assistant thread runs with off (keys as codex
 * 0.156.1 lists them in `codex features list`): the shell and exec tools,
 * the JavaScript REPL and code mode (code execution a user may have turned
 * on), the node REPL host, freeform apply_patch, plugins and apps (which
 * bring their own MCP servers), browser / computer use, sub-agents, tool
 * suggestions, goals (which every Michi thread turns off), image generation
 * and view_image (which read local images outside the sandbox). The rest
 * remove the tools a user's config can turn on: request_user_input in
 * Codex's default mode, request_permissions, send_message_to_user_async,
 * wait_for_environment (deferred_executor), new_context and
 * get_context_remaining (token_budget), clock.curr_time
 * (current_time_reminder), clock.sleep (sleep_tool), and on codex 0.166
 * multi_env_copy_file and the skills.* tools
 * (executor_capability_discovery_v2); a version without one of these keys
 * only warns. shell_snapshot (stable, on by default in 0.156.1) and its v2
 * are off too: a snapshot runs the user's login shell, rc files included,
 * for a new thread (P3 saw `shell_snapshots/` written with the shell tools
 * off). codex 0.165 still offers the multi-agent v2
 * `collaboration.*` tools with both multi_agent flags off, so multi_agent_v2
 * is the table form: off, and with a limit of one thread per session, which
 * the root thread already uses. spawn_agent then fails with "agent thread
 * limit reached" before any child thread exists (probed on codex 0.165.0).
 *
 * With these and CODEX_RESTRICTED_TOOLS_OFF, a thread of codex 0.156.1 or
 * 0.166.0-alpha.5 offers the model one built-in tool: apply_patch, which has
 * no switch and which the read-only sandbox and declined approvals keep from
 * writing (probed offline with every user feature on, ChatGPT login or none).
 * A model whose catalog entry asks for experimental tools still gets them
 * (gpt-6's request_user_input_async and clock.curr_time); such models run in
 * code mode, which is off here, so they get no built-in tool at all.
 */
export const CODEX_RESTRICTED_MULTI_AGENT_V2 = Object.freeze({ enabled: false, max_concurrent_threads_per_session: 1 });

export const CODEX_RESTRICTED_FEATURES_OFF: Readonly<Record<string, false | Readonly<Record<string, unknown>>>> = Object.freeze({
  shell_tool: false,
  unified_exec: false,
  js_repl: false,
  js_repl_tools_only: false,
  code_mode: false,
  code_mode_only: false,
  code_mode_host: false,
  apply_patch_freeform: false,
  plugins: false,
  apps: false,
  browser_use: false,
  browser_use_external: false,
  computer_use: false,
  in_app_browser: false,
  image_generation: false,
  view_image: false,
  multi_agent: false,
  multi_agent_v2: CODEX_RESTRICTED_MULTI_AGENT_V2,
  tool_suggest: false,
  skill_mcp_dependency_install: false,
  goals: false,
  default_mode_request_user_input: false,
  request_permissions_tool: false,
  send_message_to_user_async: false,
  deferred_executor: false,
  token_budget: false,
  current_time_reminder: false,
  sleep_tool: false,
  multi_env_copy_file: false,
  executor_capability_discovery_v2: false,
  shell_snapshot: false,
  shell_snapshot_v2: false,
});

/**
 * Codex's `[tools]` switches an assistant thread runs with off: the
 * request_user_input question tool, which Codex offers by default, and
 * update_plan, which a user's config can turn on. Codex's own read-only
 * structured threads turn off the same two keys.
 */
export const CODEX_RESTRICTED_TOOLS_OFF: Readonly<Record<string, Readonly<{ enabled: false }>>> = Object.freeze({
  experimental_request_user_input: Object.freeze({ enabled: false }),
  update_plan: Object.freeze({ enabled: false }),
});

/**
 * An assistant thread's config: `base` (Michi's MCP slot and hooks) with the
 * features and tools above off, web search off, and the named MCP servers
 * (the user's, from config/read) disabled. Michi's own server is never
 * disabled. Only a server the effective config defines can be named: an
 * entry without a transport fails the whole config.
 */
export function codexRestrictedThreadConfig(
  base: Record<string, unknown>,
  configuredMcpServers: readonly string[],
): Record<string, unknown> {
  const baseServers = isPlainObject(base.mcp_servers) ? base.mcp_servers : {};
  const baseFeatures = isPlainObject(base.features) ? base.features : {};
  const baseTools = isPlainObject(base.tools) ? base.tools : {};
  return {
    ...base,
    features: { ...baseFeatures, ...CODEX_RESTRICTED_FEATURES_OFF },
    tools: { ...baseTools, ...CODEX_RESTRICTED_TOOLS_OFF },
    web_search: 'disabled',
    mcp_servers: codexDisableMcpServers({ mcp_servers: baseServers }, configuredMcpServers).mcp_servers,
  };
}

export type CodexRestrictedMcpCheck =
  | { ok: true }
  /** `open`: servers still enabled. `fatal`: no retry can help (no list, or Michi's server missing). */
  | { ok: false; open: string[]; fatal: boolean; reason: string };

/**
 * Whether an assistant thread is locked down, from its mcpServerStatus/list
 * (null when Codex answered without a list): Michi's server must be listed
 * and every other server disabled. Fails closed on anything else.
 */
export function codexRestrictedMcpCheck(
  statuses: ReadonlyArray<{ name?: unknown; runtimeStatus?: unknown }> | null,
): CodexRestrictedMcpCheck {
  if (!statuses) return { ok: false, open: [], fatal: true, reason: 'Codex did not list the thread\'s MCP servers' };
  if (!statuses.some((status) => status.name === CODEX_HOST_MCP_SERVER)) {
    return { ok: false, open: [], fatal: true, reason: 'Michi\'s own MCP server is missing from the thread' };
  }
  const open = codexOpenUserMcpServers(statuses);
  if (open.length === 0) return { ok: true };
  return { ok: false, open, fatal: false, reason: `MCP servers Michi could not turn off: ${open.join(', ')}` };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
