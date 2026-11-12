/**
 * Storage for multi-model runs (migration 0067): one multi_model_runs row per
 * run with its plan and state, one multi_model_turns row per turn the run
 * requested, and the server-owned branch markers on nodes. The orchestrator
 * (services/multiModel/orchestrator.ts) owns every transition; this module
 * only reads and writes.
 *
 * plan_json and state_json are whitelisted on read like parseWorkflowRunDto:
 * a row that does not parse is logged and skipped.
 */
import {
  isChatPermissionMode,
  MULTI_MODEL_PHASES,
  MULTI_MODEL_STEP_STATUSES,
  MULTI_MODEL_SYNTHESIS_STATUSES,
  usageSummaryTotalTokens,
  type MultiModelContext,
  type MultiModelPhase,
  type MultiModelStepStatus,
  type MultiModelSynthesisStatus,
} from 'michi-shared';
import { getDb } from '../db';
import { log } from '../logger';
import type {
  MultiModelAddendumState,
  MultiModelPlan,
  MultiModelRunState,
  MultiModelStepState,
  MultiModelSynthesisState,
  MultiModelThreadPlan,
  MultiModelThreadState,
} from './types';

export interface MultiModelRunRecord {
  id: string;
  nativeId: string;
  ownerUserId: string;
  workspaceId: string;
  callerNodeId: string;
  callerTurnId: string | null;
  callerMessageId: string | null;
  askMessageId: string | null;
  status: MultiModelPhase;
  plan: MultiModelPlan;
  state: MultiModelRunState;
  revision: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
}

export type MultiModelTurnRole = 'answer' | 'review' | 'synthesis' | 'addendum';
export type MultiModelTurnOutcome = 'completed' | 'failed' | 'cancelled' | 'stopped' | 'interrupted' | 'withdrawn';

export interface MultiModelTurnRecord {
  turnId: string;
  runId: string;
  nodeId: string;
  threadKey: string | null;
  role: MultiModelTurnRole;
  round: number;
  attempt: number;
  outcome: MultiModelTurnOutcome | null;
  error: string | null;
  createdAt: number;
  endedAt: number | null;
}

export interface MultiModelStore {
  insertRun(record: Omit<MultiModelRunRecord, 'revision' | 'updatedAt'>, at: number): void;
  /** Owner-scoped: null for another owner's run. */
  getRun(ownerUserId: string, runId: string): MultiModelRunRecord | null;
  /** Unscoped: recovery and internal resolvers only. */
  getRunById(runId: string): MultiModelRunRecord | null;
  /**
   * UPDATE … WHERE id = ? AND revision = ?; false when another write won.
   * Bumps revision and updated_at, in the row and on `record`.
   */
  saveRun(record: MultiModelRunRecord, expectedRevision: number, at: number): boolean;
  /** status IN ('proposed', 'running'). */
  listOpenRuns(): MultiModelRunRecord[];
  /** The caller's runs in these statuses, newest first. */
  listRunsForCaller(callerNodeId: string, statuses: readonly MultiModelPhase[]): MultiModelRunRecord[];
  /** INSERT OR IGNORE: recording the same turn id again keeps the first row. */
  recordTurn(turn: Omit<MultiModelTurnRecord, 'outcome' | 'error' | 'endedAt'>): void;
  /** Settles an open turn; a turn that already has an outcome keeps it. */
  settleTurn(turnId: string, outcome: MultiModelTurnOutcome, error: string | null, at: number): void;
  turn(turnId: string): MultiModelTurnRecord | null;
  /** outcome IS NULL. */
  openTurns(runId: string): MultiModelTurnRecord[];
  /** Child markers, written in the same tick as the node insert. */
  markChild(nodeId: string, runId: string, fresh: boolean): void;
  /** nodes.multi_model_run_id of a node (null for ordinary chats). */
  runOfNode(nodeId: string): string | null;
  /** The runs with a branch in the tree. */
  runsInTree(treeId: string): string[];
  /** The nearest node on the parent_node_id chain (the node itself first, at most 32 hops, same workspace)
   *  that has multi_model_run_id; null when none. One-level enforcement (propose). */
  runOfNodeOrAncestor(nodeId: string): string | null;
  /** Every node carrying multi_model_run_id = runId (idx_nodes_multi_model_run), for recovery's orphan check. */
  childNodesOfRun(runId: string): Array<{ nodeId: string; deleted: boolean }>;
  /** Whether any multi_model_turns row exists for this node and run (a child that got a turn). */
  hasTurnOnNode(runId: string, nodeId: string): boolean;
  /** The assistant message the turn's durable receipt (turns.assistant_message_id) names: its id, content and usage. */
  readAnswer(nodeId: string, turnId: string): { messageId: string; content: string; totalTokens?: number } | null;
  /** turns.user_message_id of the caller's turn; else the latest caller message created before that turn began. */
  askMessageIdFor(callerNodeId: string, callerTurnId: string | null): string | null;
}

/** Ancestor hops runOfNodeOrAncestor walks past the node itself. */
const ANCESTOR_HOPS = 32;

// Unlike the wire parser (shared parseMultiModelRunView), a stored value outside these makes the run unreadable.
const PHASES: ReadonlySet<MultiModelPhase> = new Set(MULTI_MODEL_PHASES);
const STEP_STATUSES: ReadonlySet<MultiModelStepStatus> = new Set(MULTI_MODEL_STEP_STATUSES);
const SYNTHESIS_STATUSES: ReadonlySet<MultiModelSynthesisStatus> = new Set(MULTI_MODEL_SYNTHESIS_STATUSES);
const TURN_ROLES = new Set<MultiModelTurnRole>(['answer', 'review', 'synthesis', 'addendum']);
const TURN_OUTCOMES = new Set<MultiModelTurnOutcome>(['completed', 'failed', 'cancelled', 'stopped', 'interrupted', 'withdrawn']);

// ---- plan_json / state_json whitelists -----------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function context(value: unknown): MultiModelContext {
  return value === 'fork' ? 'fork' : 'fresh';
}

function reviewRounds(value: unknown): 0 | 1 | 2 {
  return value === 1 || value === 2 ? value : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function parseThreadPlan(value: unknown): MultiModelThreadPlan | null {
  const raw = record(value);
  if (!raw || typeof raw.key !== 'string' || !raw.key || typeof raw.runtimeId !== 'string' || !raw.runtimeId) return null;
  return {
    key: raw.key,
    runtimeId: raw.runtimeId,
    providerId: strOrNull(raw.providerId),
    modelId: strOrNull(raw.modelId),
    reasoning: strOrNull(raw.reasoning),
    runtimeLabel: strOrNull(raw.runtimeLabel) ?? raw.runtimeId,
    modelLabel: strOrNull(raw.modelLabel) ?? 'Default model',
    context: context(raw.context),
    prompt: strOrNull(raw.prompt) ?? '',
    removed: raw.removed === true,
    addedByUser: raw.addedByUser === true,
  };
}

function parsePlan(value: unknown): MultiModelPlan | null {
  const raw = record(value);
  const caller = record(raw?.caller);
  if (!raw || raw.version !== 1 || !Array.isArray(raw.threads) || !caller) return null;
  const threads = raw.threads.map(parseThreadPlan);
  if (threads.some((thread) => thread === null)) return null;
  return {
    version: 1,
    title: strOrNull(raw.title) ?? '',
    askPreview: strOrNull(raw.askPreview) ?? '',
    reviewRounds: reviewRounds(raw.reviewRounds),
    sharedPrompt: strOrNull(raw.sharedPrompt) ?? '',
    sharedContext: context(raw.sharedContext),
    threads: threads as MultiModelThreadPlan[],
    nextAddedKey: count(raw.nextAddedKey, 1),
    caller: {
      runtimeId: strOrNull(caller.runtimeId) ?? '',
      runtimeLabel: strOrNull(caller.runtimeLabel) ?? '',
      modelLabel: strOrNull(caller.modelLabel) ?? '',
    },
  };
}

function parseStepState(value: unknown): MultiModelStepState | null {
  const raw = record(value);
  if (!raw || !STEP_STATUSES.has(raw.status as MultiModelStepStatus)) return null;
  return {
    status: raw.status as MultiModelStepStatus,
    turnId: strOrNull(raw.turnId),
    attempt: count(raw.attempt, 0),
    startedAt: numOrNull(raw.startedAt),
    endedAt: numOrNull(raw.endedAt),
    summary: strOrNull(raw.summary),
    excerpt: strOrNull(raw.excerpt),
    error: strOrNull(raw.error),
    totalTokens: numOrNull(raw.totalTokens),
    notice: strOrNull(raw.notice),
  };
}

function parseThreadState(key: string, value: unknown): MultiModelThreadState | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.steps)) return null;
  const steps = raw.steps.map(parseStepState);
  if (steps.some((step) => step === null)) return null;
  return {
    key,
    childNodeId: strOrNull(raw.childNodeId),
    previousChildNodeIds: strings(raw.previousChildNodeIds),
    generation: count(raw.generation, 0),
    steps: steps as MultiModelStepState[],
    stopRequested: raw.stopRequested === true,
    late: raw.late === true,
    addendumTurnId: strOrNull(raw.addendumTurnId),
  };
}

function parseSynthesisState(value: unknown): MultiModelSynthesisState | null {
  const raw = record(value);
  if (!raw || !SYNTHESIS_STATUSES.has(raw.status as MultiModelSynthesisStatus)) return null;
  return {
    status: raw.status as MultiModelSynthesisStatus,
    turnId: strOrNull(raw.turnId),
    attempt: count(raw.attempt, 0),
    startedAt: numOrNull(raw.startedAt),
    endedAt: numOrNull(raw.endedAt),
    summary: strOrNull(raw.summary),
    error: strOrNull(raw.error),
    messageId: strOrNull(raw.messageId),
    totalTokens: numOrNull(raw.totalTokens),
  };
}

function parseAddendum(value: unknown): MultiModelAddendumState | null {
  const raw = record(value);
  if (!raw || typeof raw.turnId !== 'string' || !raw.turnId || !SYNTHESIS_STATUSES.has(raw.status as MultiModelSynthesisStatus)) return null;
  return {
    turnId: raw.turnId,
    keys: strings(raw.keys),
    status: raw.status as MultiModelSynthesisStatus,
    attempt: count(raw.attempt, 1),
    error: strOrNull(raw.error),
    messageId: strOrNull(raw.messageId),
  };
}

function parseState(value: unknown): MultiModelRunState | null {
  const raw = record(value);
  const rawThreads = record(raw?.threads);
  const synthesis = parseSynthesisState(raw?.synthesis);
  if (!raw || raw.version !== 1 || !rawThreads || !synthesis || !Array.isArray(raw.addenda)) return null;
  const threads: Record<string, MultiModelThreadState> = {};
  for (const [key, item] of Object.entries(rawThreads)) {
    const thread = parseThreadState(key, item);
    if (!thread) return null;
    threads[key] = thread;
  }
  const addenda = raw.addenda.map(parseAddendum);
  if (addenda.some((addendum) => addendum === null)) return null;
  return {
    version: 1,
    currentStep: count(raw.currentStep, 0),
    permissionMode: isChatPermissionMode(raw.permissionMode) ? raw.permissionMode : 'ask',
    approveForMe: raw.approveForMe === true,
    threads,
    synthesis,
    addenda: addenda as MultiModelAddendumState[],
    cancelRequested: raw.cancelRequested === true,
    statusDetail: strOrNull(raw.statusDetail),
  };
}

// ---- Rows ------------------------------------------------------------------

interface RunRow {
  id: string;
  native_id: string;
  owner_user_id: string;
  workspace_id: string;
  caller_node_id: string;
  caller_turn_id: string | null;
  caller_message_id: string | null;
  ask_message_id: string | null;
  status: string;
  plan_json: string;
  state_json: string;
  revision: number;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number;
}

interface TurnRow {
  turn_id: string;
  run_id: string;
  node_id: string;
  thread_key: string | null;
  role: string;
  round: number;
  attempt: number;
  outcome: string | null;
  error: string | null;
  created_at: number;
  ended_at: number | null;
}

function toRunRecord(row: RunRow | undefined): MultiModelRunRecord | null {
  if (!row) return null;
  let plan: MultiModelPlan | null = null;
  let state: MultiModelRunState | null = null;
  try {
    plan = parsePlan(JSON.parse(row.plan_json));
    state = parseState(JSON.parse(row.state_json));
  } catch { /* logged below */ }
  if (!plan || !state || !PHASES.has(row.status as MultiModelPhase)) {
    log.warn('chat', 'multi-model run is unreadable; skipped', { runId: row.id, status: row.status });
    return null;
  }
  return {
    id: row.id,
    nativeId: row.native_id,
    ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id,
    callerNodeId: row.caller_node_id,
    callerTurnId: row.caller_turn_id,
    callerMessageId: row.caller_message_id,
    askMessageId: row.ask_message_id,
    status: row.status as MultiModelPhase,
    plan,
    state,
    revision: row.revision,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
  };
}

function toRunRecords(rows: RunRow[]): MultiModelRunRecord[] {
  return rows.flatMap((row) => { const run = toRunRecord(row); return run ? [run] : []; });
}

function toTurnRecord(row: TurnRow | undefined): MultiModelTurnRecord | null {
  if (!row || !TURN_ROLES.has(row.role as MultiModelTurnRole)) return null;
  return {
    turnId: row.turn_id,
    runId: row.run_id,
    nodeId: row.node_id,
    threadKey: row.thread_key,
    role: row.role as MultiModelTurnRole,
    round: row.round,
    attempt: row.attempt,
    outcome: TURN_OUTCOMES.has(row.outcome as MultiModelTurnOutcome) ? row.outcome as MultiModelTurnOutcome : null,
    error: row.error,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

function usageTokens(metadata: string | null): number | undefined {
  if (!metadata) return undefined;
  try {
    return usageSummaryTotalTokens((JSON.parse(metadata) as { usageSummary?: unknown } | null)?.usageSummary);
  } catch {
    return undefined;
  }
}

export class SqliteMultiModelStore implements MultiModelStore {
  insertRun(run: Omit<MultiModelRunRecord, 'revision' | 'updatedAt'>, at: number): void {
    getDb().prepare(`INSERT INTO multi_model_runs (id, native_id, owner_user_id, workspace_id, caller_node_id, caller_turn_id,
        caller_message_id, ask_message_id, status, plan_json, state_json, revision, created_at, started_at, ended_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(
      run.id, run.nativeId, run.ownerUserId, run.workspaceId, run.callerNodeId, run.callerTurnId,
      run.callerMessageId, run.askMessageId, run.status, JSON.stringify(run.plan), JSON.stringify(run.state),
      run.createdAt, run.startedAt, run.endedAt, at,
    );
  }

  getRun(ownerUserId: string, runId: string): MultiModelRunRecord | null {
    return toRunRecord(getDb().prepare('SELECT * FROM multi_model_runs WHERE id = ? AND owner_user_id = ?')
      .get(runId, ownerUserId) as RunRow | undefined);
  }

  getRunById(runId: string): MultiModelRunRecord | null {
    return toRunRecord(getDb().prepare('SELECT * FROM multi_model_runs WHERE id = ?').get(runId) as RunRow | undefined);
  }

  saveRun(run: MultiModelRunRecord, expectedRevision: number, at: number): boolean {
    const saved = getDb().prepare(`UPDATE multi_model_runs
      SET caller_turn_id = ?, caller_message_id = ?, ask_message_id = ?, status = ?, plan_json = ?, state_json = ?,
          started_at = ?, ended_at = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?`).run(
      run.callerTurnId, run.callerMessageId, run.askMessageId, run.status, JSON.stringify(run.plan), JSON.stringify(run.state),
      run.startedAt, run.endedAt, at, run.id, expectedRevision,
    ).changes === 1;
    if (saved) {
      run.revision = expectedRevision + 1;
      run.updatedAt = at;
    }
    return saved;
  }

  listOpenRuns(): MultiModelRunRecord[] {
    return toRunRecords(getDb().prepare(`SELECT * FROM multi_model_runs WHERE status IN ('proposed', 'running')
      ORDER BY created_at`).all() as unknown as RunRow[]);
  }

  listRunsForCaller(callerNodeId: string, statuses: readonly MultiModelPhase[]): MultiModelRunRecord[] {
    if (statuses.length === 0) return [];
    return toRunRecords(getDb().prepare(`SELECT * FROM multi_model_runs
      WHERE caller_node_id = ? AND status IN (SELECT value FROM json_each(?))
      ORDER BY created_at DESC`).all(callerNodeId, JSON.stringify(statuses)) as unknown as RunRow[]);
  }

  recordTurn(turn: Omit<MultiModelTurnRecord, 'outcome' | 'error' | 'endedAt'>): void {
    getDb().prepare(`INSERT OR IGNORE INTO multi_model_turns (turn_id, run_id, node_id, thread_key, role, round, attempt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      turn.turnId, turn.runId, turn.nodeId, turn.threadKey, turn.role, turn.round, turn.attempt, turn.createdAt,
    );
  }

  settleTurn(turnId: string, outcome: MultiModelTurnOutcome, error: string | null, at: number): void {
    getDb().prepare('UPDATE multi_model_turns SET outcome = ?, error = ?, ended_at = ? WHERE turn_id = ? AND outcome IS NULL')
      .run(outcome, error, at, turnId);
  }

  turn(turnId: string): MultiModelTurnRecord | null {
    return toTurnRecord(getDb().prepare('SELECT * FROM multi_model_turns WHERE turn_id = ?').get(turnId) as TurnRow | undefined);
  }

  openTurns(runId: string): MultiModelTurnRecord[] {
    return (getDb().prepare('SELECT * FROM multi_model_turns WHERE run_id = ? AND outcome IS NULL ORDER BY created_at, rowid')
      .all(runId) as unknown as TurnRow[]).flatMap((row) => { const turn = toTurnRecord(row); return turn ? [turn] : []; });
  }

  markChild(nodeId: string, runId: string, fresh: boolean): void {
    getDb().prepare('UPDATE nodes SET multi_model_run_id = ?, fresh_context = ? WHERE id = ?').run(runId, fresh ? 1 : 0, nodeId);
  }

  runOfNode(nodeId: string): string | null {
    const row = getDb().prepare('SELECT multi_model_run_id FROM nodes WHERE id = ?').get(nodeId) as
      { multi_model_run_id: string | null } | undefined;
    return row?.multi_model_run_id ?? null;
  }

  runsInTree(treeId: string): string[] {
    return (getDb().prepare('SELECT DISTINCT multi_model_run_id AS id FROM nodes WHERE tree_id = ? AND multi_model_run_id IS NOT NULL')
      .all(treeId) as Array<{ id: string }>).map((row) => row.id);
  }

  runOfNodeOrAncestor(nodeId: string): string | null {
    const row = getDb().prepare(`WITH RECURSIVE chain(id, parent_node_id, workspace_id, multi_model_run_id, depth) AS (
        SELECT id, parent_node_id, workspace_id, multi_model_run_id, 0 FROM nodes WHERE id = ?
        UNION ALL
        SELECT n.id, n.parent_node_id, n.workspace_id, n.multi_model_run_id, chain.depth + 1
        FROM nodes n JOIN chain ON n.id = chain.parent_node_id
        WHERE chain.depth < ? AND n.workspace_id = chain.workspace_id
      )
      SELECT multi_model_run_id FROM chain WHERE multi_model_run_id IS NOT NULL ORDER BY depth LIMIT 1`)
      .get(nodeId, ANCESTOR_HOPS) as { multi_model_run_id: string } | undefined;
    return row?.multi_model_run_id ?? null;
  }

  childNodesOfRun(runId: string): Array<{ nodeId: string; deleted: boolean }> {
    return (getDb().prepare('SELECT id, deleted_at, purged_at FROM nodes WHERE multi_model_run_id = ? ORDER BY created_at, id')
      .all(runId) as Array<{ id: string; deleted_at: number | null; purged_at: number | null }>)
      .map((row) => ({ nodeId: row.id, deleted: row.deleted_at != null || row.purged_at != null }));
  }

  hasTurnOnNode(runId: string, nodeId: string): boolean {
    return !!getDb().prepare('SELECT 1 FROM multi_model_turns WHERE run_id = ? AND node_id = ? LIMIT 1').get(runId, nodeId);
  }

  readAnswer(nodeId: string, turnId: string): { messageId: string; content: string; totalTokens?: number } | null {
    const row = getDb().prepare(`SELECT m.id, m.content, m.metadata FROM turns t
        JOIN messages m ON m.id = t.assistant_message_id AND m.node_id = t.node_id
       WHERE t.turn_id = ? AND t.node_id = ?`)
      .get(turnId, nodeId) as { id: string; content: string; metadata: string | null } | undefined;
    if (!row) return null;
    const totalTokens = usageTokens(row.metadata);
    return { messageId: row.id, content: row.content, ...(totalTokens !== undefined ? { totalTokens } : {}) };
  }

  askMessageIdFor(callerNodeId: string, callerTurnId: string | null): string | null {
    const db = getDb();
    const turn = callerTurnId
      ? db.prepare('SELECT user_message_id, started_at FROM turns WHERE turn_id = ? AND node_id = ?').get(callerTurnId, callerNodeId) as
        { user_message_id: string | null; started_at: number } | undefined
      : undefined;
    if (turn?.user_message_id) return turn.user_message_id;
    const row = db.prepare(`SELECT id FROM messages WHERE node_id = ? AND role = 'user' AND created_at <= ?
      ORDER BY created_at DESC, seq DESC LIMIT 1`).get(callerNodeId, turn?.started_at ?? Number.MAX_SAFE_INTEGER) as { id: string } | undefined;
    return row?.id ?? null;
  }
}

/**
 * For attention (server.ts): a child step turn, whose completion notifies
 * nobody. Every turn a run requests has an `mm-` id, so other turns never
 * reach the database here.
 */
export function isMultiModelStepTurn(turnId: string): boolean {
  if (!turnId.startsWith('mm-')) return false;
  return !!getDb().prepare("SELECT 1 FROM multi_model_turns WHERE turn_id = ? AND role IN ('answer', 'review')").get(turnId);
}
