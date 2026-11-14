/**
 * What every Michi tool does to the world (DESIGN-v2 §2.9): the one register
 * the agent's catalogs, the check-in allow-list and the taint rule (§2.8 T5)
 * read. A tool that is not classified here gets into no catalog: the
 * ratchet (backend/test/toolEffects.test.ts) fails on every registered name
 * without a class, and on a check-in catalog that holds anything but reads,
 * its three deep reads, Michi-internal writes, cards and nothing_to_do.
 *
 * - read: reads Michi's own data or the session's workspace, nothing leaves the machine;
 * - outside_read: reads a source outside Michi (the web, reviews.example.com, Outlook, pipelines);
 * - michi_write: changes Michi's own state (Pages, tasks, Today, goals, notes, turn metadata);
 * - indirect: makes another agent turn run later, with its own tools (a new conversation,
 *   a message into one, a scheduled job, a branch, an Agent Run);
 * - local_write: writes files on this machine (artifacts, Pi's write and edit);
 * - command: runs a shell command, judged by what the command does (agents/callConsequence.ts);
 * - egress: sends or opens something outside this machine (a page in the user's browser);
 * - channel: speaks to the user or ends the turn (a question, a card the user applies, the quiet end).
 */

import { AGENT_RUN_TOOL_NAMES } from 'michi-runtime/internal/contract/tools';

export type MichiToolEffect = 'read' | 'outside_read' | 'michi_write' | 'indirect' | 'local_write' | 'command' | 'egress' | 'channel';

const of = (effect: MichiToolEffect, names: readonly string[]): Array<[string, MichiToolEffect]> => names.map((name) => [name, effect]);

const AGENT_RUN_EFFECTS: Record<typeof AGENT_RUN_TOOL_NAMES[number], MichiToolEffect> = {
  list_agents: 'read',
  spawn_agent: 'indirect',
  check_agent: 'read',
  wait_agent: 'read',
  send_agent_input: 'indirect',
  cancel_agent: 'michi_write',
  watch_agent_runs: 'read',
  update_agent_watch: 'michi_write',
};

/** Every Michi tool by its bare name: builtin, assistant, the agent's own, maintenance and Agent Run tools. */
export const MICHI_TOOL_EFFECTS: Readonly<Record<string, MichiToolEffect>> = Object.freeze(Object.fromEntries([
  // Conversations, panes, docs and the skill library; Kiro Crew's relay listing of Michi's tools.
  ...of('read', [
    'michi_docs', 'michi_skills', 'list_workspaces', 'list_threads', 'search_messages', 'read_node', 'read_node_overview',
    'list_panes', 'inspect_pane', 'read_pane_output', 'wait_pane', 'read_conversation_updates', 'show_image', 'michi_list_tools',
  ]),
  // Pages, databases, tasks, Home and components; preview_page hands out a read-only loopback link.
  ...of('read', [
    'list_pages', 'read_page', 'preview_page', 'read_database', 'read_home', 'list_page_components', 'read_page_component', 'list_tasks',
  ]),
  ...of('michi_write', [
    'edit_page', 'create_page', 'create_database', 'configure_database', 'edit_database', 'edit_home',
    'save_page_component', 'configure_database_view', 'open_task_database', 'layout_rules',
  ]),
  // Scheduled jobs: each runs a prompt later on the user's runtime.
  ...of('read', ['list_scheduled_jobs']),
  ...of('indirect', ['create_scheduled_job', 'update_scheduled_job', 'run_scheduled_job', 'delete_scheduled_job']),
  // New and continued conversations, branches.
  ...of('indirect', ['start_conversation', 'send_to_thread', 'spawn_branches', 'companion_session_send']),
  // Multi-model plans: the ready models are a read; a plan runs only from its card, which the user applies.
  ...of('read', ['list_ready_models']),
  ...of('channel', ['propose_multi_model_plan']),
  // The agent's own tools (services/companion/tools.ts).
  ...of('read', ['companion_items', 'companion_item', 'companion_read']),
  ...of('outside_read', ['companion_check_now']),
  ...of('michi_write', [
    'companion_update_item', 'companion_save_notes', 'companion_goal_progress', 'companion_edit_goal',
    'companion_publish_brief', 'companion_set_name', 'companion_set_notifications',
  ]),
  ...of('channel', ['companion_propose', 'companion_headline', 'nothing_to_do', 'ask_user', 'submit_agent_result']),
  // Michi Memory: the user's own memories.
  ...of('read', ['memory_search']),
  ...of('michi_write', ['memory_save', 'memory_update', 'memory_delete']),
  // Turn metadata.
  ...of('michi_write', [
    'set_follow_ups', 'set_branch_overview', 'set_title', 'validate_follow_ups', 'validate_turn_metadata',
    'report_conversation_no_change',
  ]),
  // Michi's web tools.
  ...of('outside_read', ['web_search', 'fetch_content']),
  // Artifacts are files; open_url opens a page in the user's browser. Removing an artifact keeps its file.
  ...of('read', ['list_artifacts', 'search_artifacts']),
  ...of('michi_write', ['delete_artifact']),
  ...of('local_write', ['save_artifact', 'update_artifact']),
  ...of('egress', ['open_url']),
  // Pi's native tools.
  ...of('read', ['read', 'ls', 'grep', 'find']),
  ...of('local_write', ['write', 'edit']),
  ...of('command', ['bash']),
  // Background Pages maintenance.
  ...of('read', [
    'maintenance_read_source', 'maintenance_list_resources', 'maintenance_read_page', 'maintenance_read_database',
    'maintenance_list_tasks', 'maintenance_read_workspace_home', 'maintenance_list_tools',
  ]),
  ...of('michi_write', ['maintenance_route_source', 'maintenance_write_page', 'maintenance_write_database', 'maintenance_no_change']),
  ...of('indirect', ['maintenance_call_tool']),
  // Agent Runs.
  ...Object.entries(AGENT_RUN_EFFECTS),
]));

/** A tool's class, or null for a name this register does not know (it reaches no catalog). */
export function michiToolEffect(name: string): MichiToolEffect | null {
  return Object.prototype.hasOwnProperty.call(MICHI_TOOL_EFFECTS, name) ? MICHI_TOOL_EFFECTS[name] : null;
}

/**
 * A Michi tool by its runtime name: Pi's bare one, Claude's and Codex's
 * `mcp____michi_internal____`, Kiro's `@michi/`; null for anything not in the
 * register, prefixed or not.
 */
export function michiBareToolName(runtimeName: string): string | null {
  const prefix = ['mcp____michi_internal____', '@michi/', 'mcp_michi_'].find((candidate) => runtimeName.startsWith(candidate));
  const bare = prefix ? runtimeName.slice(prefix.length) : runtimeName;
  return bare && michiToolEffect(bare) ? bare : null;
}
