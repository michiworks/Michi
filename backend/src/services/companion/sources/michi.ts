/**
 * Michi itself as a Companion source (DESIGN §5, R2.2, R2.4): which of the
 * user's conversations wait on them (an approval or a question in a running
 * turn, a failed or interrupted last turn, a reply that ends in a question),
 * which have waited for days (stalled), which finished since the user last
 * had them on screen (done, by `nodes.viewed_at`), and which scheduled jobs'
 * latest run failed.
 *
 * Read straight from Michi's own tables with the Spaces Home's
 * classification (pages/homeSections.ts) but none of its presentation: no
 * per-section cap, no layout rules, no Spaces Home reminder filter (the
 * Companion's item states are its own) and no "since the last look at the
 * Spaces Home". The owner is the local agent owner, which matches desktop
 * workspaces stored with a NULL owner.
 *
 * Left out, as everywhere an agent reads Michi: hidden system workspaces (the
 * Companion's own conversation is in one), workspaces whose "Let AI navigate
 * this workspace" is off, archived and deleted conversations and workspaces,
 * background maintenance chats, temporary chats (memory/temporaryChat.ts), and
 * scheduled-job runs (their job's item says when one failed). A conversation
 * waiting longer than a month is abandoned,
 * not stalled. A conversation the Companion delegated is not "done" while
 * its worker report covers it (SYNTHESIS D5).
 *
 * Versions encode the state only (R2.7): waiting / stalled / done, the turn,
 * its reply and what it waits for. Entering stalled is a new version, so it
 * is news (R2.8); a stalled item's age is a display field. michi_waiting is
 * digest: Michi already notifies approvals and questions itself, and the
 * delivery gate adds one reminder after 30 unanswered minutes.
 *
 * Also here, for the coordinator: focusSnapshot (what the user is working
 * in, a turn's [CURRENT FOCUS]) and workerStates (how delegated
 * conversations stand, for worker reports).
 */

import { COMPANION_LIMITS, isAssistantWorkspaceSettings, isSystemWorkspaceSettings, type CompanionSettings, type CompanionTarget } from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../../agentOwner';
import { getDb } from '../../db';
import { notTemporaryChatSql } from '../../memory/temporaryChat';
import { lastQuestion, serverLiveWait, STALLED_AFTER_MS, type HomeLiveWaitReader } from '../../pages/homeSections';
import { stableHash } from '../observations';
import { listDelegationsSince } from '../repository';
import type {
  CompanionDraftInput,
  CompanionFocusEntry,
  CompanionPollContext,
  CompanionSource,
  ItemDraft,
  Observation,
  SourcePollResult,
} from '../types';
import { DAY_MS, HOUR_MS, MINUTE_MS, isRecord, listObservation, oneLine, plural } from './common';

const SOURCE = 'michi' as const;
const POLL_MS = MINUTE_MS;
/** A finished conversation the user does not open stays "done" this long. */
export const MICHI_DONE_WINDOW_MS = 3 * DAY_MS;
/** A conversation that has waited on the user longer than this is abandoned: no item. */
export const MICHI_ABANDONED_AFTER_MS = 30 * DAY_MS;
/** Most conversations one poll reports, newest first; more makes the poll incomplete (no absence counts). */
const MAX_CONVERSATIONS = 500;
const MAX_JOBS = 200;
const FOCUS_WINDOW_MS = 3 * HOUR_MS;
const FOCUS_LIMIT = 5;
const LIST_KEY = 'michi:list';
const TITLE_MAX = 120;
const SUMMARY_MAX = 200;

/** Turns that completed without finishing their work (as the Spaces Home words them). */
const ENDED_EARLY: Record<string, string> = {
  max_tokens: 'Stopped early: it reached its output limit',
  max_turn_requests: 'Stopped early: it reached its step limit',
  refusal: 'Stopped: the agent declined to continue',
};

// ── Reading conversations ───────────────────────────────────────────────────

interface ConversationRow {
  turn_id: string;
  node_id: string;
  workspace_id: string;
  title: string | null;
  first_user: string | null;
  node_created_at: number;
  viewed_at: number | null;
  workspace_name: string;
  workspace_settings: string | null;
  turn_status: string;
  stop_reason: string | null;
  error: string | null;
  started_at: number;
  updated_at: number | null;
  completed_at: number | null;
  reply_id: string | null;
  reply_head: string | null;
  reply_tail: string | null;
  asks: number;
  replied: number;
}

/** The workspace is the owner's (on a local backend, the local user owns them all). Params: owner, owner, MICHI_CLOUD. */
const OWNER_SQL = "(w.owner_user_id=? OR (?='local-user' AND ?<>'1'))";
const ownerParams = (owner: string) => [owner, owner, process.env.MICHI_CLOUD ?? ''];
const TRAILING_QUESTION_SQL = "substr(rtrim(COALESCE(a.content,''),' '||char(9)||char(10)||char(13)),-1) IN ('?','？')";
const SCHEDULED_SQL = "COALESCE(json_extract(CASE WHEN json_valid(um.metadata) THEN um.metadata ELSE '{}' END,'$.scheduledJobId'),'')";
const LIVE_SQL = `n.kind='chat' AND n.deleted_at IS NULL AND n.purged_at IS NULL AND n.status<>'archived' AND n.maintenance_job_id IS NULL
    AND ${notTemporaryChatSql('n')}
    AND tr.archived_at IS NULL AND w.deleted_at IS NULL AND w.purged_at IS NULL AND w.archived_at IS NULL`;

const CONVERSATION_SELECT = `SELECT t.turn_id,n.id AS node_id,n.workspace_id,n.title,n.created_at AS node_created_at,n.viewed_at,
      CASE WHEN trim(COALESCE(n.title,''))='' THEN (SELECT substr(f.content,1,400) FROM messages f WHERE f.node_id=n.id AND f.role='user'
        AND trim(f.content)<>'' ORDER BY f.seq LIMIT 1) END AS first_user,
      w.name AS workspace_name,w.settings AS workspace_settings,
      t.status AS turn_status,t.stop_reason,substr(t.error,1,400) AS error,t.started_at,t.updated_at,t.completed_at,
      a.id AS reply_id,substr(a.content,1,400) AS reply_head,substr(rtrim(COALESCE(a.content,'')),-800) AS reply_tail,
      ${TRAILING_QUESTION_SQL} AS asks,
      EXISTS(SELECT 1 FROM messages r WHERE r.node_id=n.id AND r.role='user' AND r.id IS NOT t.user_message_id
        AND r.created_at>COALESCE(t.completed_at,t.updated_at)) AS replied
    FROM nodes n JOIN workspaces w ON w.id=n.workspace_id
    LEFT JOIN trees tr ON tr.id=n.tree_id
    JOIN turns t ON t.turn_id=(SELECT l.turn_id FROM turns l WHERE l.node_id=n.id ORDER BY l.started_at DESC,l.rowid DESC LIMIT 1)
    LEFT JOIN messages a ON a.id=t.assistant_message_id AND a.node_id=n.id
    LEFT JOIN messages um ON um.id=t.user_message_id AND um.node_id=n.id
    WHERE ${LIVE_SQL} AND ${OWNER_SQL} AND ${SCHEDULED_SQL}=''`;

/**
 * Conversations that can be in a section now: a running or failed latest
 * turn, a reply ending in a question, or one that completed in the done
 * window; none whose latest turn is older than the abandoned cut-off.
 */
function candidateRows(owner: string, now: number): ConversationRow[] {
  const sql = `${CONVERSATION_SELECT}
      AND COALESCE(t.completed_at,t.updated_at,t.started_at)>=?
      AND (t.status IN ('active','error') OR (t.status='completed' AND (${TRAILING_QUESTION_SQL} OR t.completed_at>?)))`;
  return getDb().prepare(sql).all(...ownerParams(owner), now - MICHI_ABANDONED_AFTER_MS, now - MICHI_DONE_WINDOW_MS) as unknown as ConversationRow[];
}

function rowsForNodes(owner: string, nodeIds: readonly string[]): ConversationRow[] {
  if (nodeIds.length === 0) return [];
  return getDb().prepare(`${CONVERSATION_SELECT} AND n.id IN (${nodeIds.map(() => '?').join(',')})`)
    .all(...ownerParams(owner), ...nodeIds) as unknown as ConversationRow[];
}

/** Settings JSON of a workspace an agent may read: not a hidden system one, "Let AI navigate this workspace" not off. */
function readableWorkspace(settings: string | null): boolean {
  if (isSystemWorkspaceSettings(settings)) return false;
  if (!settings) return true;
  try {
    const parsed = JSON.parse(settings) as unknown;
    return !(isRecord(parsed) && parsed.aiGlobalContext === false);
  } catch {
    return true;
  }
}

function firstLine(text: string | null): string {
  return oneLine((text ?? '').split('\n').find((line) => line.trim()) ?? '', SUMMARY_MAX);
}

function conversationTitle(row: Pick<ConversationRow, 'title' | 'first_user'>): string {
  const title = row.title?.trim();
  if (title) return oneLine(title, TITLE_MAX);
  const line = firstLine(row.first_user);
  return line ? oneLine(line, TITLE_MAX) : 'Untitled conversation';
}

type WaitKind = 'approval' | 'question' | 'asked' | 'failed' | 'interrupted';

/** Why a conversation waits on the user, and since when; null when it does not. */
function waitOf(row: ConversationRow, live: HomeLiveWaitReader): { kind: WaitKind; summary: string; at: number } | null {
  if (row.turn_status === 'active') {
    const wait = live(row.node_id);
    if (!wait) return null;
    const at = row.updated_at ?? row.started_at ?? row.node_created_at;
    const text = oneLine(wait.text, SUMMARY_MAX - 30);
    if (wait.kind === 'approval') return { kind: 'approval', summary: text ? `Waiting for your approval: ${text}` : 'Waiting for your approval', at };
    return { kind: 'question', summary: text ? `Asked: ${text}` : 'Waiting for your answer', at };
  }
  if (row.replied) return null;
  const at = row.completed_at ?? row.updated_at ?? row.started_at ?? row.node_created_at;
  if (row.turn_status === 'error') {
    if (row.error === 'backend_restarted') return { kind: 'interrupted', summary: 'Interrupted: Michi stopped while it was running', at };
    const line = firstLine(row.error);
    return { kind: 'failed', summary: line ? oneLine(`Failed: ${line}`, SUMMARY_MAX) : 'Failed', at };
  }
  if (row.turn_status === 'completed' && row.asks) {
    const question = lastQuestion(row.reply_tail ?? '');
    return { kind: 'asked', summary: oneLine(question ? `Asked: ${question}` : 'Asked you a question', SUMMARY_MAX), at };
  }
  return null;
}

// ── Observation states ──────────────────────────────────────────────────────

type ConversationSection = 'waiting' | 'stalled' | 'done';

interface ConversationState {
  kind: 'conversation';
  section: ConversationSection;
  nodeId: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  summary: string;
  /** Since when it waits (waiting, stalled) or when it finished (done). */
  at: number;
  wait: WaitKind | null;
  turnId: string;
  replyId: string | null;
  /** A conversation the Companion delegated whose reply a worker report covers. */
  delegated: boolean;
}

interface JobState {
  kind: 'job';
  jobId: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  runId: string;
  status: 'failed' | 'timed_out';
  error: string;
  finishedAt: number | null;
  nodeId: string | null;
}

const str = (value: unknown): value is string => typeof value === 'string';
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readConversation(state: Record<string, unknown>): ConversationState | null {
  if (state.kind !== 'conversation' || !str(state.nodeId) || !str(state.workspaceId) || !str(state.turnId) || !num(state.at)) return null;
  if (state.section !== 'waiting' && state.section !== 'stalled' && state.section !== 'done') return null;
  return {
    kind: 'conversation',
    section: state.section,
    nodeId: state.nodeId,
    workspaceId: state.workspaceId,
    workspaceName: str(state.workspaceName) ? state.workspaceName : '',
    title: str(state.title) && state.title ? state.title : 'Untitled conversation',
    summary: str(state.summary) ? state.summary : '',
    at: state.at,
    wait: str(state.wait) ? state.wait as WaitKind : null,
    turnId: state.turnId,
    replyId: str(state.replyId) ? state.replyId : null,
    delegated: state.delegated === true,
  };
}

function readJob(state: Record<string, unknown>): JobState | null {
  if (state.kind !== 'job' || !str(state.jobId) || !str(state.runId) || !str(state.workspaceId)) return null;
  return {
    kind: 'job',
    jobId: state.jobId,
    name: str(state.name) && state.name ? state.name : 'Scheduled job',
    workspaceId: state.workspaceId,
    workspaceName: str(state.workspaceName) ? state.workspaceName : '',
    runId: state.runId,
    status: state.status === 'timed_out' ? 'timed_out' : 'failed',
    error: str(state.error) ? state.error : '',
    finishedAt: num(state.finishedAt) ? state.finishedAt : null,
    nodeId: str(state.nodeId) ? state.nodeId : null,
  };
}

/** What makes a conversation's state a new version (counts and ages never do). */
const conversationVersion = (state: ConversationState) =>
  stableHash({ section: state.section, wait: state.wait, turnId: state.turnId, replyId: state.replyId, summary: state.summary });

function observe(objectKey: string, state: ConversationState | JobState, version: string, now: number): Observation {
  return { source: SOURCE, objectKey, fingerprint: version, state: state as unknown as Record<string, unknown>, observedAt: now };
}

const nodeTarget = (workspaceId: string, nodeId: string): CompanionTarget => ({ kind: 'node', workspaceId, nodeId });

function draftConversation(objectKey: string, state: ConversationState, now: number): ItemDraft | null {
  const base = {
    source: SOURCE,
    itemKey: objectKey,
    version: conversationVersion(state),
    title: state.title,
    target: nodeTarget(state.workspaceId, state.nodeId),
    observedAt: now,
  };
  const facts = { nodeId: state.nodeId, workspaceId: state.workspaceId, workspace: state.workspaceName, wait: state.wait };
  switch (state.section) {
    case 'waiting':
      return { ...base, subtype: 'michi_waiting', bucket: 'needs_you', severity: 'digest', summary: state.summary, facts: { ...facts, waitingSince: state.at } };
    case 'stalled': {
      const days = Math.max(3, Math.floor((now - state.at) / DAY_MS));
      return {
        ...base, subtype: 'michi_stalled', bucket: 'stalled', severity: 'digest',
        summary: state.summary ? `Waiting on you for ${days} days · ${state.summary}` : `Waiting on you for ${days} days`,
        facts: { ...facts, waitingSince: state.at, waitingDays: days },
      };
    }
    case 'done':
      if (state.delegated) return null;
      return {
        ...base, subtype: 'michi_done', bucket: 'update', severity: 'digest', summary: state.summary || 'Finished',
        facts: { nodeId: state.nodeId, workspaceId: state.workspaceId, workspace: state.workspaceName, finishedAt: state.at },
      };
    default:
      return null;
  }
}

function draftJob(objectKey: string, state: JobState, now: number): ItemDraft {
  const verb = state.status === 'timed_out' ? 'timed out' : 'failed';
  return {
    source: SOURCE,
    subtype: 'michi_scheduled_failed',
    itemKey: objectKey,
    version: state.runId,
    bucket: 'needs_you',
    severity: 'digest',
    title: oneLine(`Scheduled job "${state.name}" ${verb}`, 200),
    summary: state.error || null,
    target: state.nodeId ? nodeTarget(state.workspaceId, state.nodeId) : null,
    facts: { jobId: state.jobId, runId: state.runId, workspaceId: state.workspaceId, workspace: state.workspaceName, status: state.status, finishedAt: state.finishedAt },
    observedAt: now,
  };
}

// ── Scheduled jobs ──────────────────────────────────────────────────────────

interface JobRow {
  job_id: string;
  name: string;
  workspace_id: string;
  workspace_name: string;
  workspace_settings: string | null;
  run_id: string;
  status: string;
  error: string | null;
  finished_at: number | null;
  node_id: string | null;
}

/** The user's enabled jobs (not the Meta agent's maintenance) whose latest finished run failed or timed out. */
function failedJobRows(owner: string): JobRow[] {
  return getDb().prepare(`SELECT j.id AS job_id,j.name,j.workspace_id,w.name AS workspace_name,w.settings AS workspace_settings,
        r.id AS run_id,r.status,substr(r.error,1,400) AS error,r.finished_at,r.node_id
      FROM scheduled_jobs j JOIN workspaces w ON w.id=j.workspace_id
      JOIN scheduled_job_runs r ON r.id=(SELECT l.id FROM scheduled_job_runs l WHERE l.job_id=j.id AND l.status<>'running'
        ORDER BY l.started_at DESC,l.rowid DESC LIMIT 1)
      WHERE j.enabled=1 AND j.execution_kind='scheduled'
        AND w.deleted_at IS NULL AND w.purged_at IS NULL AND w.archived_at IS NULL AND ${OWNER_SQL}
        AND r.status IN ('failed','timed_out')
      ORDER BY r.started_at DESC LIMIT ?`).all(...ownerParams(owner), MAX_JOBS) as unknown as JobRow[];
}

// ── Workers and focus ───────────────────────────────────────────────────────

/** How a conversation the Companion delegated stands. */
export interface CompanionWorkerState {
  nodeId: string;
  /** The conversation is still there (not deleted). */
  exists: boolean;
  workspaceName: string;
  title: string;
  turnStatus: 'active' | 'completed' | 'error' | 'cancelled' | null;
  stopReason: string | null;
  error: string | null;
  /** The latest turn's reply. */
  messageId: string | null;
  /** When the latest turn ended. */
  endedAt: number | null;
  /** The reply, capped at COMPANION_LIMITS.maxReportChars. */
  reply: string;
  viewedAt: number | null;
  /**
   * The user wrote in it themselves (DESIGN-v2 §4): a user message besides
   * the brief that started it and the follow-ups the agent sent
   * (`companionSend`, or a thread message from one of the agent's own
   * conversations), which never count.
   */
  userTookOver: boolean;
}

interface WorkerRow {
  node_id: string;
  title: string | null;
  deleted_at: number | null;
  purged_at: number | null;
  viewed_at: number | null;
  workspace_name: string | null;
  turn_status: string | null;
  stop_reason: string | null;
  error: string | null;
  completed_at: number | null;
  updated_at: number | null;
  reply_id: string | null;
  reply: string | null;
  user_messages: number;
}

/**
 * A user message nobody but the user wrote, as SQL on `u` (DESIGN-v2 §4):
 * not one of the agent's follow-ups (`companionSend`) and not a thread
 * message from a conversation in the agent's own workspace (`?` is that
 * workspace list as JSON; the MVP's assistant sent those).
 */
const HUMAN_MESSAGE_SQL = `(u.metadata IS NULL OR NOT json_valid(u.metadata) OR (json_extract(u.metadata,'$.companionSend') IS NULL
  AND (json_extract(u.metadata,'$.threadMessage.fromNodeId') IS NULL OR json_extract(u.metadata,'$.threadMessage.fromNodeId') NOT IN
    (SELECT f.id FROM nodes f WHERE f.workspace_id IN (SELECT value FROM json_each(?))))))`;

/** The agent's own workspaces (`settings.system = 'assistant'`), whose conversations' thread messages are never the user's. */
function assistantWorkspaceIdsJson(): string {
  const rows = getDb().prepare('SELECT id, settings FROM workspaces WHERE settings IS NOT NULL').all() as Array<{ id: string; settings: string | null }>;
  return JSON.stringify(rows.filter((row) => isAssistantWorkspaceSettings(row.settings)).map((row) => row.id));
}

function workerStates(nodeIds: readonly string[]): Map<string, CompanionWorkerState> {
  const states = new Map<string, CompanionWorkerState>();
  if (nodeIds.length === 0) return states;
  const rows = getDb().prepare(`SELECT n.id AS node_id,n.title,n.deleted_at,n.purged_at,n.viewed_at,w.name AS workspace_name,
        t.status AS turn_status,t.stop_reason,substr(t.error,1,400) AS error,t.completed_at,t.updated_at,
        a.id AS reply_id,substr(a.content,1,?) AS reply,
        (SELECT COUNT(*) FROM messages u WHERE u.node_id=n.id AND u.role='user' AND ${HUMAN_MESSAGE_SQL}) AS user_messages
      FROM nodes n LEFT JOIN workspaces w ON w.id=n.workspace_id
      LEFT JOIN turns t ON t.turn_id=(SELECT l.turn_id FROM turns l WHERE l.node_id=n.id ORDER BY l.started_at DESC,l.rowid DESC LIMIT 1)
      LEFT JOIN messages a ON a.id=t.assistant_message_id AND a.node_id=n.id
      WHERE n.id IN (${nodeIds.map(() => '?').join(',')})`)
    .all(COMPANION_LIMITS.maxReportChars, assistantWorkspaceIdsJson(), ...nodeIds) as unknown as WorkerRow[];
  for (const row of rows) {
    const status = row.turn_status;
    states.set(row.node_id, {
      nodeId: row.node_id,
      exists: row.deleted_at === null && row.purged_at === null,
      workspaceName: row.workspace_name ?? '',
      title: row.title?.trim() ? oneLine(row.title, TITLE_MAX) : 'Conversation',
      turnStatus: status === 'active' || status === 'completed' || status === 'error' || status === 'cancelled' ? status : null,
      stopReason: row.stop_reason,
      error: row.error,
      messageId: row.reply_id,
      endedAt: status === 'active' ? null : row.completed_at ?? row.updated_at,
      reply: row.reply ?? '',
      viewedAt: row.viewed_at,
      userTookOver: Number(row.user_messages) > 1,
    });
  }
  return states;
}

/** How one delegated conversation stands right now (session_send's checks, DESIGN-v2 §4); null when it has no node row. */
export function michiWorkerState(nodeId: string): CompanionWorkerState | null {
  return workerStates([nodeId]).get(nodeId) ?? null;
}

interface FocusRow {
  node_id: string;
  last_user_at: number;
}

/** Conversations the user wrote in during the last three hours, newest first (≤ 5): a turn's [CURRENT FOCUS]. */
function focusSnapshot(owner: string, live: HomeLiveWaitReader, now: number): CompanionFocusEntry[] {
  const recent = getDb().prepare(`SELECT n.id AS node_id,MAX(t.started_at) AS last_user_at
      FROM turns t JOIN messages um ON um.id=t.user_message_id AND um.node_id=t.node_id
      JOIN nodes n ON n.id=t.node_id JOIN workspaces w ON w.id=n.workspace_id LEFT JOIN trees tr ON tr.id=n.tree_id
      WHERE t.started_at>=? AND ${LIVE_SQL} AND ${OWNER_SQL} AND ${SCHEDULED_SQL}=''
      GROUP BY n.id ORDER BY last_user_at DESC LIMIT 25`).all(now - FOCUS_WINDOW_MS, ...ownerParams(owner)) as unknown as FocusRow[];
  const lastUser = new Map(recent.map((row) => [row.node_id, Number(row.last_user_at)]));
  const rows = rowsForNodes(owner, recent.map((row) => row.node_id)).filter((row) => readableWorkspace(row.workspace_settings));
  return rows
    .map((row): CompanionFocusEntry => {
      const wait = waitOf(row, live);
      const state: CompanionFocusEntry['state'] = wait ? 'waiting' : row.turn_status === 'active' ? 'running' : 'idle';
      return {
        workspaceId: row.workspace_id,
        workspaceName: oneLine(row.workspace_name, 80),
        nodeId: row.node_id,
        title: conversationTitle(row),
        state,
        lastActiveAt: Math.max(lastUser.get(row.node_id) ?? 0, row.completed_at ?? 0, row.updated_at ?? 0),
      };
    })
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, FOCUS_LIMIT);
}

// ── The source ──────────────────────────────────────────────────────────────

export interface CompanionMichiSourceOptions {
  /** Approvals and questions of running turns (default: the server's ChatHub reader, configureHomeLiveWait). */
  live?: HomeLiveWaitReader;
  /** Whose workspaces (default: the local agent owner). */
  ownerUserId?: string;
}

export interface CompanionMichiSource extends CompanionSource {
  readonly kind: 'michi';
  /** What the user works in now (CompanionMaterial.focus). */
  focusSnapshot(now: number): CompanionFocusEntry[];
  /** How these delegated conversations stand (worker reports). */
  workerStates(nodeIds: readonly string[]): Map<string, CompanionWorkerState>;
}

class MichiSource implements CompanionMichiSource {
  readonly kind = SOURCE;
  private readonly live: HomeLiveWaitReader;
  private readonly owner: string;

  constructor(options: CompanionMichiSourceOptions) {
    this.live = options.live ?? serverLiveWait;
    this.owner = options.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
  }

  intervalMs(_settings: CompanionSettings): number {
    return POLL_MS;
  }

  async poll(ctx: CompanionPollContext): Promise<SourcePollResult> {
    if (!ctx.settings.sources.michi.enabled) {
      return { source: SOURCE, ok: false, complete: false, observations: [], error: 'disabled', detail: 'Off in Companion settings' };
    }
    try {
      return this.collect(ctx.now);
    } catch {
      return { source: SOURCE, ok: false, complete: false, observations: [], error: 'tool_error', detail: 'Could not read your Michi conversations' };
    }
  }

  private collect(now: number): SourcePollResult {
    const delegations = new Map(listDelegationsSince(now - MICHI_DONE_WINDOW_MS - DAY_MS).map((delegation) => [delegation.nodeId, delegation]));
    const conversations: Observation[] = [];
    const counts = { waiting: 0, stalled: 0, done: 0 };
    for (const row of candidateRows(this.owner, now)) {
      if (!readableWorkspace(row.workspace_settings)) continue;
      const state = this.classify(row, now);
      if (!state) continue;
      if (state.section === 'done') {
        const delegation = delegations.get(row.node_id);
        state.delegated = !!delegation && (delegation.state === 'following' || delegation.lastReportedMessageId === state.replyId);
      }
      counts[state.section] += 1;
      conversations.push(observe(`michi:node:${state.nodeId}`, state, conversationVersion(state), now));
    }
    conversations.sort((a, b) => (b.state.at as number) - (a.state.at as number));
    const complete = conversations.length <= MAX_CONVERSATIONS;
    const kept = conversations.slice(0, MAX_CONVERSATIONS);
    const jobs = failedJobRows(this.owner)
      .filter((row) => readableWorkspace(row.workspace_settings))
      .map((row) => {
        const state: JobState = {
          kind: 'job', jobId: row.job_id, name: oneLine(row.name, TITLE_MAX) || 'Scheduled job', workspaceId: row.workspace_id,
          workspaceName: oneLine(row.workspace_name, 80), runId: row.run_id, status: row.status === 'timed_out' ? 'timed_out' : 'failed',
          error: firstLine(row.error), finishedAt: row.finished_at, nodeId: row.node_id,
        };
        return observe(`michi:job:${row.job_id}`, state, row.run_id, now);
      });
    const observations = [
      ...kept,
      ...jobs,
      listObservation(SOURCE, LIST_KEY, { ...counts, jobs: jobs.length, truncated: !complete }, now),
    ];
    const detail = [
      `${counts.waiting} waiting on you`,
      `${counts.stalled} stalled`,
      `${counts.done} done`,
      jobs.length > 0 ? `${plural(jobs.length, 'failed scheduled job')}` : null,
    ].filter((part): part is string => part !== null).join(' · ');
    return { source: SOURCE, ok: true, complete, observations, detail };
  }

  private classify(row: ConversationRow, now: number): ConversationState | null {
    const base = {
      kind: 'conversation' as const,
      nodeId: row.node_id,
      workspaceId: row.workspace_id,
      workspaceName: oneLine(row.workspace_name, 80),
      title: conversationTitle(row),
      turnId: row.turn_id,
      replyId: row.reply_id,
      delegated: false,
    };
    const wait = waitOf(row, this.live);
    if (wait) {
      if (now - wait.at > MICHI_ABANDONED_AFTER_MS) return null;
      return { ...base, section: now - wait.at >= STALLED_AFTER_MS ? 'stalled' : 'waiting', summary: wait.summary, at: wait.at, wait: wait.kind };
    }
    // Done: completed in the window, not answered since, and not on screen since it finished.
    if (row.turn_status !== 'completed' || row.replied || row.completed_at === null) return null;
    if (now - row.completed_at > MICHI_DONE_WINDOW_MS) return null;
    if (row.viewed_at !== null && row.viewed_at >= row.completed_at) return null;
    const early = row.stop_reason ? ENDED_EARLY[row.stop_reason] : undefined;
    return { ...base, section: 'done', summary: early ?? firstLine(row.reply_head), at: row.completed_at, wait: null };
  }

  draft(input: CompanionDraftInput): ItemDraft[] {
    const drafts: ItemDraft[] = [];
    for (const observation of input.observations) {
      if (observation.source !== SOURCE) continue;
      const conversation = readConversation(observation.state);
      if (conversation) {
        const made = draftConversation(observation.objectKey, conversation, input.now);
        if (made) drafts.push(made);
        continue;
      }
      const job = readJob(observation.state);
      if (job) drafts.push(draftJob(observation.objectKey, job, input.now));
    }
    return drafts;
  }

  focusSnapshot(now: number): CompanionFocusEntry[] {
    return focusSnapshot(this.owner, this.live, now);
  }

  workerStates(nodeIds: readonly string[]): Map<string, CompanionWorkerState> {
    return workerStates(nodeIds);
  }
}

export function createMichiSource(options: CompanionMichiSourceOptions = {}): CompanionMichiSource {
  return new MichiSource(options);
}
