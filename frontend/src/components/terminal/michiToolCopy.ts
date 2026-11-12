import { michiBareToolName } from 'michi-shared';
import type { PhraseVerb } from './toolCallGrouping';

/**
 * What the tools Michi knows say they do, written per tool rather than inferred
 * (VS Code's invocationMessage/pastTenseMessage idea): a verb from Michi's
 * vocabulary (VERB_PAST gives its past) and an object. A step says "Save
 * @plan", a run's sentence "Saved @plan". Michi's own tools, and the agent
 * CLIs' built-ins that have no purpose of their own (WebFetch, Skill…).
 * A tool missing here falls back to "Use <tool>".
 */
interface MichiToolCopy {
  verb: PhraseVerb;
  /** What it acts on when the input names nothing specific: "a thread". */
  object: string;
  /** A count of calls: `#` is the number ("panes # times"), else it leads ("3 threads"). */
  many: string;
  /** The object the input names, when it names one a reader would recognize. IDs never qualify. */
  from?: (input: ToolInput) => string | undefined;
}

type ToolInput = Readonly<Record<string, unknown>>;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const text = (input: ToolInput, key: string): string | undefined => {
  const v = input[key];
  return typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : undefined;
};
const quoted = (input: ToolInput, key: string, before: string) => {
  const v = text(input, key);
  return v ? `${before} “${clip(v, 40)}”` : undefined;
};
const host = (input: ToolInput, key: string) => {
  try { const v = text(input, key); return v ? new URL(v).host : undefined; } catch { return undefined; }
};
const file = (input: ToolInput, key: string) => text(input, key)?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
/** How many items an array field holds ("questions", "topics"), 0 when absent. */
const countOf = (input: ToolInput, key: string) => (Array.isArray(input[key]) ? (input[key] as unknown[]).length : 0);

const MICHI_TOOL_COPY: Readonly<Record<string, MichiToolCopy>> = {
  // Threads and panes
  list_threads: { verb: 'list', object: 'threads', many: 'threads # times' },
  search_messages: { verb: 'search', object: 'messages', many: 'messages # times', from: (i) => quoted(i, 'query', 'messages for') },
  read_node: { verb: 'read', object: 'a thread', many: 'threads' },
  read_node_overview: { verb: 'read', object: 'a thread overview', many: 'thread overviews' },
  read_conversation_updates: { verb: 'read', object: 'conversation updates', many: 'conversation updates # times' },
  report_conversation_no_change: { verb: 'report', object: 'no change', many: 'no change # times' },
  inspect_pane: { verb: 'inspect', object: 'a pane', many: 'panes' },
  read_pane_output: { verb: 'read', object: 'pane output', many: 'pane outputs' },
  list_panes: { verb: 'list', object: 'panes', many: 'panes # times' },
  wait_pane: { verb: 'wait', object: 'for a pane', many: 'for panes # times' },
  send_to_thread: { verb: 'send', object: 'a message to a thread', many: 'messages to threads' },
  spawn_branches: { verb: 'start', object: 'branches', many: 'branches # times', from: (i) => (countOf(i, 'topics') > 1 ? `${countOf(i, 'topics')} branches` : countOf(i, 'topics') === 1 ? 'a branch' : undefined) },
  ask_user: { verb: 'ask', object: 'you a question', many: 'you # times', from: (i) => (countOf(i, 'questions') > 1 ? `you ${countOf(i, 'questions')} questions` : undefined) },
  // Multi-model plans
  propose_multi_model_plan: { verb: 'create', object: 'a multi-model plan', many: 'multi-model plans' },
  list_ready_models: { verb: 'list', object: 'ready models', many: 'ready models # times' },
  // Artifacts, media and the web
  save_artifact: { verb: 'save', object: 'an artifact', many: 'artifacts', from: (i) => (text(i, 'name') ? `@${text(i, 'name')}` : file(i, 'path')) },
  update_artifact: { verb: 'update', object: 'an artifact', many: 'artifacts', from: (i) => (text(i, 'name') ? `@${text(i, 'name')}` : undefined) },
  list_artifacts: { verb: 'list', object: 'artifacts', many: 'artifacts # times' },
  search_artifacts: { verb: 'search', object: 'artifacts', many: 'artifacts # times', from: (i) => quoted(i, 'query', 'artifacts for') },
  delete_artifact: { verb: 'delete', object: 'an artifact', many: 'artifacts', from: (i) => (text(i, 'name') ? `@${text(i, 'name')!.replace(/^@/, '')}` : undefined) },
  show_image: { verb: 'show', object: 'an image', many: 'images', from: (i) => file(i, 'path') },
  open_url: { verb: 'open', object: 'a link', many: 'links', from: (i) => host(i, 'url') },
  michi_docs: { verb: 'read', object: 'Michi docs', many: 'Michi docs # times', from: (i) => quoted(i, 'query', 'Michi docs about') ?? (text(i, 'docId') ? `Michi doc ${text(i, 'docId')}` : undefined) },
  michi_skills: { verb: 'read', object: 'Michi skills', many: 'Michi skills # times', from: (i) => (text(i, 'name') ? `skill ${text(i, 'name')}` : undefined) },
  web_search: { verb: 'search', object: 'the web', many: 'the web # times', from: (i) => quoted(i, 'query', 'the web for') },
  fetch_content: { verb: 'fetch', object: 'a page', many: 'pages', from: (i) => host(i, 'url') },
  // Memory
  memory_search: { verb: 'search', object: 'memory', many: 'memory # times', from: (i) => quoted(i, 'query', 'memory for') },
  memory_save: { verb: 'save', object: 'a memory', many: 'memories' },
  memory_update: { verb: 'update', object: 'a memory', many: 'memories' },
  memory_delete: { verb: 'delete', object: 'a memory', many: 'memories' },
  // Scheduled jobs
  list_scheduled_jobs: { verb: 'list', object: 'scheduled jobs', many: 'scheduled jobs # times' },
  create_scheduled_job: { verb: 'create', object: 'a scheduled job', many: 'scheduled jobs', from: (i) => quoted(i, 'name', 'scheduled job') },
  update_scheduled_job: { verb: 'update', object: 'a scheduled job', many: 'scheduled jobs', from: (i) => quoted(i, 'name', 'scheduled job') },
  run_scheduled_job: { verb: 'run', object: 'a scheduled job', many: 'scheduled jobs' },
  delete_scheduled_job: { verb: 'delete', object: 'a scheduled job', many: 'scheduled jobs' },
  // Pages, databases and tasks
  read_home: { verb: 'read', object: 'Home', many: 'Home # times' },
  edit_home: { verb: 'edit', object: 'Home', many: 'Home # times' },
  list_pages: { verb: 'list', object: 'pages', many: 'pages # times' },
  read_page: { verb: 'read', object: 'a page', many: 'pages' },
  edit_page: { verb: 'edit', object: 'a page', many: 'pages' },
  create_page: { verb: 'create', object: 'a page', many: 'pages', from: (i) => quoted(i, 'title', 'page') },
  create_database: { verb: 'create', object: 'a database', many: 'databases', from: (i) => quoted(i, 'title', 'database') },
  configure_database: { verb: 'configure', object: 'a database', many: 'databases' },
  read_database: { verb: 'read', object: 'a database', many: 'databases' },
  edit_database: { verb: 'edit', object: 'a database', many: 'databases' },
  configure_database_view: { verb: 'configure', object: 'a database view', many: 'database views' },
  preview_page: { verb: 'open', object: 'a page preview', many: 'page previews' },
  list_page_components: { verb: 'list', object: 'page components', many: 'page components # times' },
  read_page_component: { verb: 'read', object: 'a page component', many: 'page components' },
  save_page_component: { verb: 'save', object: 'a page component', many: 'page components' },
  open_task_database: { verb: 'open', object: 'the task database', many: 'the task database # times' },
  list_tasks: { verb: 'list', object: 'tasks', many: 'tasks # times' },
  list_workspaces: { verb: 'list', object: 'workspaces', many: 'workspaces # times' },
  // Workspace upkeep (the meta agent)
  maintenance_read_workspace_home: { verb: 'read', object: 'workspace Home', many: 'workspace Home # times' },
  maintenance_read_page: { verb: 'read', object: 'a page', many: 'pages' },
  maintenance_read_source: { verb: 'read', object: 'the source conversation', many: 'the source conversation # times' },
  maintenance_write_page: { verb: 'update', object: 'a page', many: 'pages' },
  maintenance_list_resources: { verb: 'list', object: 'pages and databases', many: 'pages and databases # times' },
  maintenance_route_source: { verb: 'route', object: 'the conversation', many: 'conversations' },
  maintenance_no_change: { verb: 'report', object: 'no change', many: 'no change # times' },
  maintenance_list_tasks: { verb: 'list', object: 'tasks', many: 'tasks # times' },
  maintenance_read_database: { verb: 'read', object: 'a database', many: 'databases' },
  maintenance_write_database: { verb: 'update', object: 'a database', many: 'databases' },
  maintenance_list_tools: { verb: 'list', object: 'tools', many: 'tools # times' },
  maintenance_call_tool: { verb: 'run', object: 'a tool', many: 'tools', from: (i) => (text(i, 'tool') ? text(i, 'tool') : undefined) },
  // Claude's own tools
  WebFetch: { verb: 'fetch', object: 'a page', many: 'pages', from: (i) => host(i, 'url') },
  WebSearch: { verb: 'search', object: 'the web', many: 'the web # times', from: (i) => quoted(i, 'query', 'the web for') },
  TaskStop: { verb: 'stop', object: 'a background task', many: 'background tasks' },
  Skill: { verb: 'load', object: 'a skill', many: 'skills', from: (i) => (text(i, 'skill') ? `skill ${text(i, 'skill')!.split(':').pop()}` : undefined) },
  ToolSearch: { verb: 'load', object: 'tools', many: 'tools # times', from: (i) => { const q = text(i, 'query'); const n = q?.startsWith('select:') ? q.slice(7).split(',').length : 0; return n > 1 ? `${n} tools` : n === 1 ? 'a tool' : undefined; } },
  TodoWrite: { verb: 'update', object: 'the plan', many: 'the plan # times' },
  // Kiro's own: a docs lookup ("Introspecting")
  KiroIntrospect: { verb: 'search', object: 'Kiro docs', many: 'Kiro docs # times', from: (i) => quoted(i, 'query', 'Kiro docs for') },
  // Agent runs
  list_agents: { verb: 'list', object: 'agents', many: 'agents # times' },
  spawn_agent: { verb: 'start', object: 'an agent', many: 'agents' },
  check_agent: { verb: 'check', object: 'an agent', many: 'agents' },
  wait_agent: { verb: 'wait', object: 'for an agent', many: 'for agents # times' },
  send_agent_input: { verb: 'send', object: 'input to an agent', many: 'inputs to agents' },
  cancel_agent: { verb: 'cancel', object: 'an agent', many: 'agents' },
  watch_agent_runs: { verb: 'watch', object: 'agent runs', many: 'agent runs # times' },
  update_agent_watch: { verb: 'update', object: 'an agent watch', many: 'agent watches' },
};

/** The tool's name when it is one of Michi's own (or a runtime built-in above), in any runtime's spelling. */
export function michiToolName(title: string): string | undefined {
  const name = michiBareToolName(title);
  return name !== undefined && Object.hasOwn(MICHI_TOOL_COPY, name) ? name : undefined;
}

/** A call's copy: verb and object, `generic` when the input named nothing specific. */
export function michiToolPhrase(name: string, input: ToolInput | null): { verb: PhraseVerb; object: string; many: string; generic: boolean } | undefined {
  const copy = MICHI_TOOL_COPY[name];
  if (!copy) return undefined;
  const specific = input ? copy.from?.(input) : undefined;
  return { verb: copy.verb, object: specific ?? copy.object, many: copy.many, generic: !specific };
}
