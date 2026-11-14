/**
 * Turn trust: whether a chat turn consumed untrusted content — web pages,
 * shell output, results of an MCP server other than Michi's own — so that
 * work that must not follow instructions planted in such content (a memory
 * write the model starts, memory extraction) can tell.
 *
 * Sources are recorded per (nodeId, turnId) in `turn_trust` (migration
 * 0060) and kept after the turn ends; they go with the node (a purge or a
 * hard delete removes them). They come from two places:
 *
 * - chatHub passes every runtime event of a turn to observeTurnTrust. The
 *   tool_call / tool_call_update events every runtime (Pi included) sends
 *   name the tool (NormalizedEvent toolName / mcpServer / hostTool, which
 *   the adapters set); classifyToolTrust judges them. A subagent's tool
 *   activity counts for the turn that runs the subagent.
 * - A tool executor that fetches outside content itself (fetch_content)
 *   calls recordUntrustedSource with what it read. send_to_thread does the
 *   same when it hands content from one turn to another: a message from a
 *   sending turn that consumed untrusted content (or cannot be identified)
 *   marks the target's turn for it, and a reply (wait, wake) from such a turn
 *   marks the turn that receives it (agents/threadMessageWakes.ts). A reply
 *   read later with read_pane_output carries nothing: that is one of Michi's
 *   own tools, judged trusted whatever turn it reads.
 *
 * Tool executors find the running turn of their chat with
 * activeTurnTrust(nodeId). The MCP server's handlers get the node from the
 * slot binding (`resolveSlotBinding(slot).nodeId`, null for an Agent Run),
 * Pi's from the session owner (`chatNodeOf(opts.owner)` in buildPiTools).
 *
 * Trust is per turn: content a previous turn of the chat read is still in
 * the model's context, but does not make the next turn untrusted.
 *
 * Check-in and collector material (DESIGN-v2 §2.8 T4, T5) is a source whose
 * `detail` is 'checkin' (text a check-in wrote: its posts, notes, cards,
 * goals, Pages blocks and database changes) or 'collector' (what the
 * agent's collectors read: Today items, deep reads). companionTaintOf names
 * it; permissionPolicy.ts makes such a turn ask (chatPermissionMode at its
 * start, resolveChatPolicy on every call) and ignores always-allow grants.
 *
 * Unlike other untrusted content, that material sticks to the chat that took
 * it in (w2-fix D1 for V, the agent's conversation; w3-fix D17 for every
 * other chat): once a turn took it in, every later turn on the same live
 * native session is tainted too (activeCompanionTaint answers for it, and
 * records it on that turn), until the session is rebuilt (a new session
 * object with another native session), cleared or compacted
 * (clearCarriedCompanionTaint), or the backend restarts (it is kept in
 * memory). Only a session takes material in: a source recorded while the
 * chat has no session carries nothing, and neither does one recorded with
 * `carry: false` (a check-in's post, D25: its text never reaches the native
 * session, T2). A check-in's own node carries nothing: its session is thrown
 * away.
 *
 * companionRuntimeGateAuthoritative says on which runtimes a tainted turn's
 * every non-read tool call reaches Michi's approval, whatever the user's own
 * runtime config pre-approves (D15).
 */
import type { DatabaseSync } from 'node:sqlite';
import { COMPANION_TAINT_DETAILS, type CompanionTaintDetail } from 'michi-shared';
import type { NormalizedEvent } from './chatEvents';
import { getDb, openDbOrNull } from './db';
import { log } from './logger';
import { getSession } from '../agents/sessionRegistry';
import type { AgentSession } from '../agents/types';
import { assistantPurposeOf } from '../assistant/identity';
import { PAGE_TOOL_NAMES } from '../agents/pageToolNames';
import { SCHEDULED_JOB_TOOL_NAMES } from '../agents/scheduledJobToolNames';
import { MEMORY_TOOL_NAMES } from '../agents/memoryToolNames';
import { ARTIFACT_TOOL_NAMES } from '../agents/artifactToolNames';
import { AGENT_RUN_TOOL_NAMES } from 'michi-runtime/internal/contract/tools';

export interface TurnRef { nodeId: string; turnId: string }
/** `tool`: the tool's name; `detail`: what it read, or the MCP server it came from (`mcp:<server>`). */
export type TrustSource = { tool: string; runtimeId: string; detail?: string };
export type ToolTrust = 'trusted' | 'untrusted';

export interface ToolTrustInput {
  runtimeId: string;
  /** The tool's own name (NormalizedEvent toolName); '' when the runtime gives none. */
  toolName: string;
  /** The MCP server the tool belongs to, when it is an MCP tool. */
  mcpServer?: string | null;
  /** true: one of Michi's own tools; false: another MCP server's. Absent: unknown, judged by name. */
  hostTool?: boolean;
  /** The call's ACP tool kind (read, execute, fetch, ...), judged when the name is missing or unknown. */
  kind?: string;
}

// ---------------------------------------------------------------------------
// Classification (v1)
// ---------------------------------------------------------------------------

/**
 * Tools whose output is outside content, whoever runs them: web search and
 * fetch, shell and code execution, cloud APIs, and MCP resources. Checked
 * first, so Michi's own web_search / fetch_content and Pi's bash count too.
 */
const UNTRUSTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Michi (Pi in process, or any runtime through Michi's MCP server).
  'web_search', 'fetch_content', 'bash',
  // The agent's deep reads: CR comments, pipeline details and email from outside.
  'companion_cr_detail', 'companion_pipeline_detail', 'companion_email_search',
  // Claude Code.
  'WebFetch', 'WebSearch', 'WebBrowser', 'Bash', 'BashOutput', 'TaskOutput', 'KillShell', 'PowerShell', 'REPL',
  'Monitor', 'RemoteTrigger', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
  // codex (the translator's names for its call kinds).
  'shell',
  // Kiro v2 / v3 and Kiro Crew.
  'execute_bash', 'run_command', 'web_fetch', 'use_aws',
  // ACP tool kinds, as subagent activity reports them.
  'execute', 'fetch',
]);

/**
 * Runtime built-ins that read or change the workspace, plan, ask the user or
 * run a subagent (whose own tools are judged from its activity).
 */
const TRUSTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Michi's file tools (Pi).
  'read', 'ls', 'grep', 'find', 'write', 'edit',
  // Claude Code.
  'Read', 'Glob', 'Grep', 'LS', 'LSP', 'NotebookRead', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  'TodoWrite', 'Task', 'Agent', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'ListAgents',
  'SendMessage', 'SendUserMessage', 'TeamCreate', 'TeamDelete', 'Workflow', 'ReportFindings', 'Brief',
  'StructuredOutput', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'Sleep', 'PushNotification',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'Config', 'Skill',
  'SlashCommand', 'ToolSearch',
  // codex: parsed read-only commands, patches, collaboration.
  'apply_patch', 'spawnAgent', 'wait', 'sendInput', 'closeAgent', 'resumeAgent',
  // Kiro v2 / v3.
  'fs_read', 'fs_write', 'glob', 'todo_list', 'thinking', 'delegate', 'use_subagent', 'subagent', 'summary',
  // Antigravity.
  'view_file', 'read_file', 'list_dir', 'find_by_name', 'grep_search', 'write_file', 'replace_file_content',
  'multi_replace_file_content',
  // ACP tool kinds, as subagent activity reports them.
  'delete', 'move', 'search', 'think', 'switch_mode',
]);

/**
 * Michi's own tools by bare name, for a runtime that reports a host tool
 * without its server. Exported for the drift test against Michi's catalogs.
 */
export const MICHI_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...PAGE_TOOL_NAMES, ...SCHEDULED_JOB_TOOL_NAMES, ...MEMORY_TOOL_NAMES, ...ARTIFACT_TOOL_NAMES, ...AGENT_RUN_TOOL_NAMES,
  'open_url', 'michi_docs', 'michi_skills', 'spawn_branches', 'save_artifact', 'update_artifact', 'show_image',
  'list_threads', 'search_messages', 'read_node', 'read_node_overview', 'read_conversation_updates',
  'report_conversation_no_change', 'inspect_pane', 'read_pane_output', 'list_panes', 'wait_pane', 'send_to_thread',
  'list_ready_models', 'propose_multi_model_plan',
  'ask_user', 'set_follow_ups', 'set_branch_overview', 'set_title',
  'submit_agent_result',
  // The assistant's and the agent's own (assistant/tools.ts, services/companion/tools.ts); what they read
  // of check-in or collector material is recorded by the tools themselves (recordCompanionTaint).
  'list_workspaces', 'layout_rules', 'start_conversation', 'companion_items', 'companion_item', 'companion_read',
  'companion_check_now', 'companion_update_item', 'companion_save_notes', 'companion_goal_progress',
  'companion_edit_goal', 'companion_propose', 'companion_publish_brief', 'companion_set_name',
  'companion_set_notifications', 'companion_headline', 'nothing_to_do',
]);

/** Michi's MCP server as the runtimes name it: Claude and codex `__michi_internal__`, ACP agents `michi`. */
const MICHI_MCP_SERVERS: ReadonlySet<string> = new Set(['__michi_internal__', 'michi']);

/** ACP tool kinds that stay in the workspace; `execute`, `fetch` and `other` do not. */
const LOCAL_ACP_KINDS: ReadonlySet<string> = new Set(['read', 'edit', 'delete', 'move', 'search', 'think', 'switch_mode']);
const ACP_KINDS: ReadonlySet<string> = new Set([...LOCAL_ACP_KINDS, 'execute', 'fetch', 'other']);

/** A raw MCP tool name, for a caller that passes one without its server. */
function mcpServerOfName(name: string): string | undefined {
  if (name.startsWith('mcp____michi_internal____')) return '__michi_internal__';
  if (name.startsWith('mcp_michi_')) return 'michi';
  return /^mcp__(.+?)__./.exec(name)?.[1] ?? /^@([^/\s]+)\/./.exec(name)?.[1] ?? /^mcp_([^_]+)_./.exec(name)?.[1];
}

/**
 * Whether a tool's output can carry instructions nobody in this chat wrote.
 * v1 rules, in order:
 * 1. web search / fetch, shell and code execution, cloud API tools: untrusted
 *    (Michi's own web_search and fetch_content too);
 * 2. any other tool of Michi's (its MCP server's, or Pi's in-process tools): trusted;
 * 3. a tool of any other MCP server: untrusted;
 * 4. known runtime built-ins that read or edit workspace files, plan, ask
 *    the user or run a subagent: trusted;
 * 5. any other name, and a call without one, by its ACP kind: read / edit /
 *    delete / move / search / think / switch_mode are trusted; execute,
 *    fetch, other, no kind or a runtime's own kind (Claude's `tool`) are
 *    untrusted. So a tool Michi does not know is judged as outside content
 *    unless its runtime reports it as a workspace operation; the lists above
 *    keep ordinary coding turns trusted.
 */
export function classifyToolTrust(input: ToolTrustInput): ToolTrust {
  const name = typeof input.toolName === 'string' ? input.toolName.trim() : '';
  const byKind: ToolTrust = input.kind && LOCAL_ACP_KINDS.has(input.kind) ? 'trusted' : 'untrusted';
  if (!name) return byKind;
  if (UNTRUSTED_TOOL_NAMES.has(name)) return 'untrusted';
  const server = input.mcpServer || (input.hostTool === undefined ? mcpServerOfName(name) : undefined);
  const host = input.hostTool ?? (server ? MICHI_MCP_SERVERS.has(server) : MICHI_TOOL_NAMES.has(name));
  if (host) return 'trusted';
  if (server || input.hostTool === false) return 'untrusted';
  return TRUSTED_TOOL_NAMES.has(name) ? 'trusted' : byKind;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Distinct sources kept per turn; one is enough to make it untrusted. */
const MAX_SOURCES_PER_TURN = 50;
const MAX_FIELD_CHARS = 500;
/** Turns whose judged tool calls and recorded sources this process remembers. */
const MAX_TRACKED_TURNS = 256;
const MAX_CALLS_PER_TURN = 4096;

interface TrackedTurn {
  /** Tool calls already judged. */
  calls: Set<string>;
  /** Sources already recorded (keys). */
  recorded: Set<string>;
  /** Sources that did not reach the database (none open, or the write failed): still reported by getTurnTrust. */
  unsaved: Map<string, TrustSource>;
}
const tracked = new Map<string, TrackedTurn>();

const turnKey = (ref: TurnRef): string => `${ref.nodeId}\u0000${ref.turnId}`;
const sourceKey = (source: TrustSource): string => JSON.stringify([source.tool, source.runtimeId, source.detail ?? null]);

function trackedTurn(ref: TurnRef): TrackedTurn {
  const key = turnKey(ref);
  let turn = tracked.get(key);
  if (!turn) {
    turn = { calls: new Set(), recorded: new Set(), unsaved: new Map() };
    tracked.set(key, turn);
    if (tracked.size > MAX_TRACKED_TURNS) tracked.delete(tracked.keys().next().value!);
  }
  return turn;
}

function clip(value: string): string {
  return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
}

function validRef(ref: TurnRef): boolean {
  return typeof ref?.nodeId === 'string' && ref.nodeId.length > 0 && typeof ref.turnId === 'string' && ref.turnId.length > 0;
}

function normalizeSource(source: TrustSource): TrustSource {
  const detail = typeof source.detail === 'string' && source.detail.trim() ? clip(source.detail.trim()) : undefined;
  return {
    tool: clip(String(source.tool ?? '').trim() || 'unknown'),
    runtimeId: clip(String(source.runtimeId ?? '').trim() || 'unknown'),
    ...(detail ? { detail } : {}),
  };
}

const INSERT_SOURCE = `INSERT OR IGNORE INTO turn_trust (node_id, turn_id, source_key, tool, runtime_id, detail, recorded_at)
  SELECT ?, ?, ?, ?, ?, ?, ?
  WHERE (SELECT COUNT(*) FROM turn_trust WHERE node_id = ? AND turn_id = ?) < ?`;

function insertSource(db: DatabaseSync, ref: TurnRef, key: string, source: TrustSource): void {
  db.prepare(INSERT_SOURCE).run(ref.nodeId, ref.turnId, key, source.tool, source.runtimeId, source.detail ?? null,
    Date.now(), ref.nodeId, ref.turnId, MAX_SOURCES_PER_TURN);
}

/**
 * How a source is recorded. `carry` (default true): the chat's live session
 * took the material in, so its later turns hold it too (D1, D17). False for
 * material written into the chat's record that its native session never
 * receives: a check-in's post (w4-fix D25), whose text is replayed only as a
 * fact line (T2); what a later turn reads of it, quotes, replies to or
 * attaches is recorded on that turn and carried from there (T4, T5).
 */
export interface RecordSourceOptions { carry?: boolean }

/** Records the source once per turn; `db` null keeps it in memory only. Throws when the write fails. */
function record(db: DatabaseSync | null, ref: TurnRef, source: TrustSource, options: RecordSourceOptions = {}): void {
  const normalized = normalizeSource(source);
  const key = sourceKey(normalized);
  // Even when the write below fails: the material is in the session either way.
  if (options.carry !== false && db && normalized.detail && TAINT_DETAILS.has(normalized.detail)) {
    carryCompanionTaint(ref, normalized.detail as CompanionTaintDetail);
  }
  const turn = trackedTurn(ref);
  if (turn.recorded.has(key)) return;
  // Past the cap the database's own limit applies; memory stays bounded.
  if (turn.recorded.size < MAX_CALLS_PER_TURN) turn.recorded.add(key);
  const keep = () => { if (turn.unsaved.size < MAX_SOURCES_PER_TURN) turn.unsaved.set(key, normalized); };
  if (!db) return keep();
  try {
    insertSource(db, ref, key, normalized);
  } catch (err) {
    // This process still reports the source; the error is the caller's.
    keep();
    throw err;
  }
}

/** Records that the turn consumed untrusted content. Repeats of a source are ignored. Throws when the write fails. */
export function recordUntrustedSource(ref: TurnRef, source: TrustSource, options?: RecordSourceOptions): void {
  if (!validRef(ref)) throw new Error('recordUntrustedSource needs a nodeId and a turnId');
  record(getDb(), ref, source, options);
}

/** The untrusted sources a turn consumed, during the turn and after it. */
export function getTurnTrust(ref: TurnRef): { untrusted: boolean; sources: TrustSource[] } {
  if (!validRef(ref)) return { untrusted: false, sources: [] };
  const rows = getDb().prepare(
    'SELECT source_key, tool, runtime_id, detail FROM turn_trust WHERE node_id = ? AND turn_id = ? ORDER BY recorded_at, rowid',
  ).all(ref.nodeId, ref.turnId) as Array<{ source_key: string; tool: string; runtime_id: string; detail: string | null }>;
  const sources = new Map<string, TrustSource>();
  for (const row of rows) {
    sources.set(row.source_key, { tool: row.tool, runtimeId: row.runtime_id, ...(row.detail ? { detail: row.detail } : {}) });
  }
  for (const [key, source] of tracked.get(turnKey(ref))?.unsaved ?? []) {
    if (!sources.has(key)) sources.set(key, source);
  }
  const list = [...sources.values()];
  return { untrusted: list.length > 0, sources: list };
}

const TAINT_DETAILS: ReadonlySet<string> = new Set(COMPANION_TAINT_DETAILS);

/** Whether a source is check-in or collector material (§2.8), not other outside content (the web, a command's output, another MCP server). */
export function isCompanionMaterial(source: TrustSource): boolean {
  return !!source.detail && TAINT_DETAILS.has(source.detail);
}

/**
 * The check-in or collector material a turn consumed (§2.8): 'checkin' when
 * any source is check-in material, else 'collector' when any is the
 * collectors', else null. Other untrusted sources (the web, shell output)
 * are not this kind.
 */
export function companionTaintOf(ref: TurnRef): CompanionTaintDetail | null {
  let found: CompanionTaintDetail | null = null;
  for (const source of getTurnTrust(ref).sources) {
    if (!source.detail || !TAINT_DETAILS.has(source.detail)) continue;
    if (source.detail === 'checkin') return 'checkin';
    found = 'collector';
  }
  return found;
}

// ---------------------------------------------------------------------------
// Carried taint (w2-fix D1, w3-fix D17)
// ---------------------------------------------------------------------------

interface CarriedTaint {
  detail: CompanionTaintDetail;
  /** The turn that took it in; the entry holds only while that turn's record does (a purge, a new database). */
  turnId: string;
  /** The chat's live session then (or the one it was carried over to). */
  session: WeakRef<AgentSession>;
  /** That session's native id; null until it has one (a fresh Claude session before system/init), then learned from it (liveCarried). */
  nativeSessionId: string | null;
  /** That session's runtime: a session on another runtime never resumes it. */
  runtimeId: string | null;
}

/** A chat's node id → the strongest material its live session took in. One entry per chat; bounded (boundCarried). */
const carried = new Map<string, CarriedTaint>();
/**
 * Chats whose sticky taint this process remembers at once. Every chat
 * carries it (D17), and an entry for a chat whose session is not live must
 * stay (its next turn may resume that session), so the bound is generous;
 * past it, entries whose session was rebuilt go first (boundCarried).
 */
const MAX_CARRIED = 4096;

const strongest = (a: CompanionTaintDetail | null, b: CompanionTaintDetail | null): CompanionTaintDetail | null =>
  (a === 'checkin' || b === 'checkin' ? 'checkin' : a ?? b);

/**
 * Every chat carries it (D1 for V, D17 for the rest), except a check-in's
 * own node (by prefix or recorded purpose): its session is thrown away, and
 * its entries would only crowd out the chats'.
 */
function carriesTaint(nodeId: string): boolean {
  try {
    return assistantPurposeOf(nodeId) !== 'checkin';
  } catch {
    // Unreadable: carry it, so the next turn asks rather than runs.
    return true;
  }
}

/** Keeps the map within MAX_CARRIED: entries that no longer hold go first, then the oldest. */
function boundCarried(): void {
  if (carried.size <= MAX_CARRIED) return;
  for (const [nodeId, entry] of carried) {
    if (carried.size <= MAX_CARRIED) return;
    if (!liveCarried(nodeId, entry)) carried.delete(nodeId);
  }
  while (carried.size > MAX_CARRIED) {
    const oldest = carried.keys().next().value!;
    carried.delete(oldest);
    log.warn('chat', 'carried companion taint forgotten: too many tainted chats', { nodeId: oldest, max: MAX_CARRIED });
  }
}

/**
 * Remembers that the chat's live session took this in. A weaker or equal
 * taint the session still holds changes nothing; one it no longer holds (its
 * session rebuilt, or the turn that took it in gone from the record: a
 * purge, another database) is replaced. A chat with no session has nothing
 * that took it in, so nothing to carry (w4-fix failure 1: such an entry used
 * to hold forever, since no later session could be told apart from it); every
 * path that hands the material to a session records it while that session
 * is registered (the message route, a steer and a check-in's send open it
 * first; a tool reads it during the session's turn), including a fresh
 * session that has no native id yet (liveCarried learns it). Never throws.
 */
function carryCompanionTaint(ref: TurnRef, detail: CompanionTaintDetail): void {
  try {
    let held: CompanionTaintDetail | null = null;
    // Unreadable: carry this one anew rather than trust an entry that may no longer hold.
    try { held = carriedCompanionTaint(ref.nodeId); } catch { held = null; }
    if (held && strongest(held, detail) === held) return;
    if (!carriesTaint(ref.nodeId)) return;
    const session = getSession(ref.nodeId);
    if (!session) return;
    carried.delete(ref.nodeId);
    carried.set(ref.nodeId, {
      detail, turnId: ref.turnId,
      session: new WeakRef(session),
      nativeSessionId: session.nativeSessionId ?? null,
      runtimeId: session.runtimeId ?? null,
    });
    boundCarried();
  } catch (err) {
    log.warn('chat', 'carried companion taint not noted', { nodeId: ref.nodeId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The entry still describes the chat's live session: the same object, or a new
 * object on the same native session (a resume). The material may have been
 * taken in before its session had a native id (a fresh Claude session before
 * system/init, a reply to a post recorded before the turn): the id is learned
 * here from that session once it has one, on every check, so a later resume
 * of it still carries it. When it was never learned (that session gone before
 * a check saw its id), a new object on the same runtime that is on a native
 * session of its own may be resuming it, so it carries it (fail closed) and
 * the entry follows that object from then on; one with no native session yet
 * is a fresh session (a resume knows the session it resumes, as Pi, which
 * has none, never resumes), and one on another runtime is a rebuild.
 */
function liveCarried(nodeId: string, entry: CarriedTaint): boolean {
  const live = getSession(nodeId);
  if (!live) return true;
  const original = entry.session.deref();
  if (!entry.nativeSessionId && original?.nativeSessionId) entry.nativeSessionId = original.nativeSessionId;
  if (original === live) return true;
  if (entry.nativeSessionId) return live.nativeSessionId === entry.nativeSessionId;
  if (!live.nativeSessionId || live.runtimeId !== entry.runtimeId) return false;
  entry.session = new WeakRef(live);
  entry.nativeSessionId = live.nativeSessionId;
  return true;
}

/** What the chat's live session took in on an earlier turn (D1, D17); null when nothing, or the session was rebuilt since. */
function carriedCompanionTaint(nodeId: string): CompanionTaintDetail | null {
  const entry = carried.get(nodeId);
  if (!entry) return null;
  // A rebuilt session, or a turn whose record is gone (the node purged, another database), carries nothing.
  const detail = liveCarried(nodeId, entry) ? companionTaintOf({ nodeId, turnId: entry.turnId }) : null;
  if (!detail) carried.delete(nodeId);
  return detail;
}

/**
 * The chat's live session no longer holds what earlier turns read: an
 * in-place /clear or a compaction ran on it (routes/michi.ts). A rebuilt
 * session needs no call: a new session object on another native session
 * carries nothing.
 */
export function clearCarriedCompanionTaint(nodeId: string): void {
  carried.delete(nodeId);
}

/** The source a running turn gets for what its session took in earlier (the message route records the same for V). */
const EARLIER_TURN_TOOL = 'companion_earlier_turn';

/**
 * The check-in or collector material the chat's running turn holds, or that
 * the chat's live session took in on an earlier turn (D1, D17); null when
 * neither, and when no database is open. What an earlier turn took in is
 * also recorded on the running turn, once (the message route does it before
 * V's turn starts), so whatever judges that turn's own record (memory
 * extraction, Memory writes, the agent's tools) sees it too; a record that
 * fails is logged and the answer stands. Never throws: a read that fails
 * answers 'checkin', so the turn asks rather than runs (fail closed).
 */
export function activeCompanionTaint(nodeId: string | null | undefined): CompanionTaintDetail | null {
  if (typeof nodeId !== 'string' || !nodeId || !openDbOrNull()) return null;
  try {
    const turn = activeTurnTrust(nodeId);
    const now = turn ? companionTaintOf({ nodeId, turnId: turn.turnId }) : null;
    if (now === 'checkin') return now;
    const earlier = carriedCompanionTaint(nodeId);
    const held = strongest(now, earlier);
    if (turn && earlier && held !== now) noteEarlierTurnTaint({ nodeId, turnId: turn.turnId }, earlier);
    return held;
  } catch (err) {
    log.warn('chat', 'companion taint read failed; the turn asks', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return 'checkin';
  }
}

/** Records on the running turn what its session took in earlier; never throws (the caller's answer already holds it). */
function noteEarlierTurnTaint(ref: TurnRef, detail: CompanionTaintDetail): void {
  try {
    recordCompanionTaint(ref, EARLIER_TURN_TOOL, detail);
  } catch (err) {
    log.warn('chat', 'carried companion taint not recorded on the running turn', {
      nodeId: ref.nodeId, turnId: ref.turnId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * What makes a turn untrusted, for copy that says why (G2-review
 * suggestion 1): 'checkin' or 'collector' when it holds that material (its
 * own record, or, as the chat's running turn, what its live session took in
 * earlier: D1, D17), 'untrusted' when it read only other outside content
 * (the web, a command's output, another MCP server), null when nothing.
 * Never throws: a read that fails answers 'checkin' (fail closed).
 */
export function turnTaintOf(ref: TurnRef): CompanionTaintDetail | 'untrusted' | null {
  if (!validRef(ref) || !openDbOrNull()) return null;
  try {
    const { untrusted, sources } = getTurnTrust(ref);
    let held: CompanionTaintDetail | null = null;
    for (const source of sources) {
      if (source.detail && TAINT_DETAILS.has(source.detail)) held = strongest(held, source.detail as CompanionTaintDetail);
    }
    if (held !== 'checkin' && activeTurnTrust(ref.nodeId)?.turnId === ref.turnId) held = strongest(held, activeCompanionTaint(ref.nodeId));
    return held ?? (untrusted ? 'untrusted' : null);
  } catch (err) {
    log.warn('chat', 'turn taint read failed; counted as check-in material', { nodeId: ref.nodeId, error: err instanceof Error ? err.message : String(err) });
    return 'checkin';
  }
}

/**
 * Runtimes on which every non-read tool call of a turn that holds check-in
 * or collector material reaches Michi's approval, whatever the user's own
 * runtime config pre-approves (w3-fix D15; verified against the adapters):
 *
 * - pi: in process; its SDK settings are in memory, user extensions are off
 *   and its agent dir is the session's own (agents/pi/piSdkHarness.ts
 *   SettingsManager.inMemory, DefaultResourceLoader noExtensions), and
 *   Michi's approval is the last tool_call handler for every tool, extension
 *   tools included; beforeToolCall sends every call but ask_user through
 *   resolveChatPolicy (agents/pi/PiSession.ts beforeToolCall).
 * - claude: its sessions load the user's settings (allow rules, hooks), but
 *   Michi's programmatic PreToolUse hook answers `ask` for every call of
 *   such a turn but local reads and the Michi tools it may run
 *   (michiClaudeOptions.ts claudeCallNeedsMichiApproval, w2-fix D4), which
 *   the CLI resolves through canUseTool, skipping allow rules and the mode.
 *   Not under MICHI_CLAUDE_BARE=1, whose --bare also turns SDK hooks off.
 *   Known residual (DESIGN-v2 §2.8): a PermissionRequest hook in the user's
 *   settings races Michi's prompt and can answer it.
 *
 * Not kiro: ordinary chats run kiro-cli on the user's KIRO_HOME with the
 * user's default agent (no --agent, no host-owned home outside ephemeral
 * workers), whose allowedTools and toolsSettings run tools without a
 * session/request_permission, the only path to Michi's approval. Not codex:
 * the app-server runs on the user's CODEX_HOME, and only command and file
 * approvals reach Michi (CodexRuntime CODEX_APPROVAL_ALIASES): MCP tool
 * calls, Michi's send_to_thread and the user's servers' alike, run without
 * one, and the user's exec rules can allow commands. Any other runtime
 * (Crew, Antigravity, one Michi does not know) is not either.
 */
const GATE_AUTHORITATIVE_RUNTIMES: ReadonlyMap<string, () => boolean> = new Map([
  ['pi', () => true],
  // The bare switch as michiClaudeOptions.ts reads it: exactly 1 turns --bare on, and with it SDK hooks off.
  ['claude', () => process.env.MICHI_CLAUDE_BARE !== '1'],
]);

/** See GATE_AUTHORITATIVE_RUNTIMES: whether a check-in may send straight into a chat on this runtime (D15); false for any other. */
export function companionRuntimeGateAuthoritative(runtimeId: string): boolean {
  const authoritative = typeof runtimeId === 'string' ? GATE_AUTHORITATIVE_RUNTIMES.get(runtimeId) : undefined;
  return authoritative?.() === true;
}

/** The material the chat's live session took in on an earlier turn (D1, D17), for the message route; null as activeCompanionTaint. */
export function carriedCompanionTaintOf(nodeId: string): CompanionTaintDetail | null {
  if (!nodeId || !openDbOrNull()) return null;
  try { return carriedCompanionTaint(nodeId); } catch { return 'checkin'; }
}

/**
 * Records that the turn consumed check-in or collector material (§2.8 T4,
 * T5): `tool` is what read it ('companion_context' for a message that
 * started with it). The runtime is the node's. Throws when the write fails.
 */
export function recordCompanionTaint(ref: TurnRef, tool: string, detail: CompanionTaintDetail): void {
  if (!validRef(ref)) throw new Error('recordCompanionTaint needs a nodeId and a turnId');
  const db = getDb();
  recordUntrustedSource(ref, { tool, runtimeId: nodeRuntimeId(db, ref.nodeId), detail });
}

/**
 * The chat's running turn and what it consumed so far; null when the chat
 * has no running turn (or the node is not a chat). A caller that must not
 * act on untrusted input treats null as untrusted (agents/memoryTools.ts).
 */
export function activeTurnTrust(nodeId: string): { turnId: string; untrusted: boolean; sources: TrustSource[] } | null {
  if (typeof nodeId !== 'string' || !nodeId) return null;
  const row = getDb().prepare(
    "SELECT turn_id FROM turns WHERE node_id = ? AND status = 'active' ORDER BY started_at DESC, rowid DESC LIMIT 1",
  ).get(nodeId) as { turn_id: string } | undefined;
  if (!row) return null;
  return { turnId: row.turn_id, ...getTurnTrust({ nodeId, turnId: row.turn_id }) };
}

// ---------------------------------------------------------------------------
// Runtime events (chatHub)
// ---------------------------------------------------------------------------

/** A title that names the web, for a call with neither name nor web kind. */
const WEB_TITLE = /\b(web|https?:\/\/|url|fetch|browse|internet)\b/i;

interface ObservedCall { id: string; input: Omit<ToolTrustInput, 'runtimeId'>; source: Omit<TrustSource, 'runtimeId'> }

function observedCall(ev: NormalizedEvent): ObservedCall | null {
  if (ev.kind === 'tool_call' || ev.kind === 'tool_call_update') {
    const toolName = ev.toolName?.trim() ?? '';
    const title = typeof ev.title === 'string' ? ev.title : '';
    // An ACP kind whose title names the web is a fetch, whatever the agent called it.
    const kind = ev.kindType && ACP_KINDS.has(ev.kindType) && WEB_TITLE.test(title) ? 'fetch' : ev.kindType;
    if (toolName) {
      return {
        id: ev.toolCallId,
        input: { toolName, mcpServer: ev.mcpServer ?? null, ...(ev.hostTool !== undefined ? { hostTool: ev.hostTool } : {}), ...(kind ? { kind } : {}) },
        source: { tool: toolName, ...(ev.mcpServer ? { detail: `mcp:${ev.mcpServer}` } : {}) },
      };
    }
    // No name: an ACP kind is all there is. Anything else (a later update
    // of a call already judged, a delta) has nothing to judge.
    if (!kind || !ACP_KINDS.has(ev.kindType ?? '')) return null;
    return { id: ev.toolCallId, input: { toolName: '', kind }, source: { tool: kind, ...(title ? { detail: title } : {}) } };
  }
  if (ev.kind === 'subagent_tool_activity') {
    const toolName = ev.toolKind?.trim();
    if (!toolName || ev.activityKind === 'message') return null;
    return {
      id: `subagent\u0000${ev.subagentSessionId}\u0000${ev.toolCallId ?? toolName}`,
      input: { toolName },
      source: { tool: toolName, detail: `subagent:${ev.subagentSessionId}` },
    };
  }
  return null;
}

function nodeRuntimeId(db: DatabaseSync, nodeId: string): string {
  const row = db.prepare('SELECT runtime_id FROM nodes WHERE id = ?').get(nodeId) as { runtime_id: string | null } | undefined;
  return row?.runtime_id || 'unknown';
}

/**
 * chatHub's hook: judges a runtime event of the turn and records an
 * untrusted tool. Each tool call is judged once, when the event first names
 * it. Writes only into an already open database (never opens one) and never
 * throws: trust bookkeeping must not fail a turn.
 */
export function observeTurnTrust(ref: TurnRef, runtimeId: string | undefined, ev: NormalizedEvent): void {
  try {
    const call = observedCall(ev);
    if (!call || !validRef(ref)) return;
    const turn = trackedTurn(ref);
    if (call.id && turn.calls.has(call.id)) return;
    const verdict = classifyToolTrust({ runtimeId: runtimeId ?? 'unknown', ...call.input });
    // A nameless call judged trusted by its kind is judged again once an update names it.
    if (call.id && (call.input.toolName || verdict === 'untrusted') && turn.calls.size < MAX_CALLS_PER_TURN) turn.calls.add(call.id);
    if (verdict === 'trusted') return;
    const db = openDbOrNull();
    const source = { ...call.source, runtimeId: runtimeId ?? (db ? nodeRuntimeId(db, ref.nodeId) : 'unknown') };
    if (db) recordUntrustedSource(ref, source);
    else record(null, ref, source);
  } catch (err) {
    log.warn('chat', 'turn trust record failed', {
      nodeId: ref?.nodeId, turnId: ref?.turnId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
