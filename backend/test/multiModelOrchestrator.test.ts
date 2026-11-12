import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatStreamEvent, WorkflowRunDtoV1 } from 'michi-shared';
import type { BackgroundSubscriber, StartRequestedSelfTurnArgs } from '../src/agents/chatHub';
import { MultiModelError, type MultiModelToolCaller } from '../src/agents/multiModelTool';
import type { AgentRuntime, AgentSession } from '../src/agents/types';
import type { PermissionAnswered } from '../src/services/attentionSignals';
import { readNodePermissionSetting, writeChatPermissionSettings } from '../src/services/chatPermissions';
import { closeDb, getDb, initDb } from '../src/services/db';
import type { CreateChildInput, OpenedChild } from '../src/services/multiModel/childThreads';
import { MultiModelOrchestrator } from '../src/services/multiModel/orchestrator';
import { ReadyModelsService } from '../src/services/multiModel/readyModels';
import { SqliteMultiModelStore, type MultiModelRunRecord } from '../src/services/multiModel/store';
import { WorkflowRunHub } from '../src/services/workflowRunHub';
import { SqliteWorkflowRunStore, type WorkflowRunStore } from '../src/services/workflowRunsRepository';

// isolateUserDirs (the test preload) points MICHI_DATA_DIR at a temporary directory for this file.
// Unref'd timers alone would let node:test drain the file while turns are still settling.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));

const OWNER = 'local-user';
const store = new SqliteMultiModelStore();

function memoryWorkflowStore(): WorkflowRunStore {
  const rows = new Map<string, { ownerUserId: string; run: WorkflowRunDtoV1 }>();
  return {
    upsert(ownerUserId, run) { rows.set(run.id, { ownerUserId, run }); },
    get(ownerUserId, id) { const row = rows.get(id); return row && row.ownerUserId === ownerUserId ? row.run : null; },
    list(ownerUserId, workspaceId) { return [...rows.values()].filter((row) => row.ownerUserId === ownerUserId && row.run.workspaceId === workspaceId).map((row) => row.run); },
    listOpen() { return [...rows.values()].filter((row) => row.run.status === 'running' || row.run.status === 'paused'); },
    workspaceOwnedBy: () => true,
    workspaceOfNode: () => null,
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

let messageSeq = 0;
function insertMessage(nodeId: string, id: string, role: 'user' | 'assistant', content: string, metadata: string | null = null): void {
  getDb().prepare('INSERT INTO messages (id, node_id, role, content, seq, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, nodeId, role, content, ++messageSeq, Date.now(), metadata);
}

/** The assistant message id ChatHub returns for a requested turn: deliberately not ChatHub's own format,
 * so the orchestrator must use the id it is given and the turn's receipt, never predict one. */
const replyId = (nodeId: string, turnId: string) => `reply-${nodeId}-${turnId}`;

interface FakeTurn {
  args: StartRequestedSelfTurnArgs;
  status: 'active' | 'completed' | 'cancelled' | 'error';
  finish: () => void;
}

/** ChatHub's surface the orchestrator drives; turns begin at once unless their node is gated. */
class FakeChat {
  readonly turns = new Map<string, FakeTurn>();
  readonly began: string[] = [];
  readonly cancels: Array<[string, string]> = [];
  readonly gates = new Map<string, Promise<void>>();
  readonly pending = new Map<string, Record<string, unknown>>();
  readonly subs: BackgroundSubscriber[] = [];
  readonly cancelListeners = new Set<(request: { chatId: string; turnId: string }) => void>();
  readonly errors = new Map<string, string>();
  shuttingDown = false;

  async startRequestedSelfTurn(args: StartRequestedSelfTurnArgs) {
    const gate = this.gates.get(args.nodeId);
    if (gate) await gate;
    if (args.shouldStart && !args.shouldStart()) throw new Error(`requested turn ${args.turnId} was withdrawn before it started`);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.turns.set(args.turnId, { args, status: 'active', finish });
    this.began.push(args.turnId);
    const assistantId = replyId(args.nodeId, args.turnId);
    getDb().prepare(`INSERT OR REPLACE INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, last_seq, started_at, updated_at)
      VALUES (?, ?, NULL, ?, 'active', 0, ?, ?)`).run(args.turnId, args.nodeId, assistantId, Date.now(), Date.now());
    return { turnId: args.turnId, assistantId, done, existing: false };
  }
  requestedTurnStatus(turnId: string) { return this.turns.get(turnId)?.status ?? null; }
  cancel(chatId: string, turnId?: string) {
    this.cancels.push([chatId, turnId!]);
    for (const listener of this.cancelListeners) listener({ chatId, turnId: turnId! });
    return true;
  }
  holdsSession() { return false; }
  getPendingPermission(chatId: string) { return this.pending.get(chatId) ?? null; }
  subscribeBackground(sub: BackgroundSubscriber) { this.subs.push(sub); return () => {}; }
  onCancel(listener: (request: { chatId: string; turnId: string }) => void) { this.cancelListeners.add(listener); return () => {}; }
  isShuttingDown() { return this.shuttingDown; }
  resolveActiveInvocationAnchor() { return null; }

  emit(event: Record<string, unknown> & { event: string; data: Record<string, unknown> }) {
    for (const sub of this.subs) sub.send(String(event.data.nodeId), event as unknown as ChatStreamEvent);
  }
  /** The turn of `key`'s step `step`, attempt `attempt` (newest run first when several match). */
  turnOf(key: string, step: number, attempt = 1): string | undefined {
    return [...this.turns.keys()].reverse().find((id) => id.endsWith(`-${key}-g${id.match(/-g(\d+)-/)?.[1]}-s${step}-a${attempt}`));
  }
  synthesis(attempt = 1): string | undefined {
    return [...this.turns.keys()].reverse().find((id) => id.endsWith(`-syn-a${attempt}`));
  }
  addendum(n: number, attempt = 1): string | undefined {
    return [...this.turns.keys()].reverse().find((id) => id.endsWith(`-add${n}-a${attempt}`));
  }
  answer(turnId: string | undefined, text: string, metadata: string | null = null): void {
    const turn = this.turns.get(turnId!);
    assert.ok(turn, `turn ${turnId} exists`);
    insertMessage(turn.args.nodeId, replyId(turn.args.nodeId, turnId!), 'assistant', text, metadata);
    turn.status = 'completed';
    turn.finish();
  }
  end(turnId: string | undefined, status: 'cancelled' | 'error', error?: string): void {
    const turn = this.turns.get(turnId!);
    assert.ok(turn, `turn ${turnId} exists`);
    turn.status = status;
    if (error) this.errors.set(turnId!, error);
    turn.finish();
  }
}

function fakeRuntime(id: string, label: string, models: string[]): AgentRuntime {
  return {
    id, label, capabilities: {}, checkAvailability: () => ({ available: true }),
    listModels: async () => models.map((model) => ({ id: model, label: model.toUpperCase() })),
  } as unknown as AgentRuntime;
}

const RUNTIMES = [fakeRuntime('alpha', 'Alpha (cli)', ['a1', 'a2']), fakeRuntime('beta', 'Beta', ['b1']), fakeRuntime('gamma', 'Gamma', ['g1'])];

let seeds = 0;
interface Harness {
  ws: string; tree: string; caller: string;
  chat: FakeChat;
  hub: WorkflowRunHub;
  workflowStore: WorkflowRunStore;
  orchestrator: MultiModelOrchestrator;
  created: CreateChildInput[];
  createGates: Map<string, Promise<void>>;
  createFailures: Set<string>;
  answers: Array<[string, string | null, unknown]>;
  permissionListeners: Array<(event: PermissionAnswered) => void>;
  hubUpdates: number;
  toolCaller(extra?: Partial<MultiModelToolCaller>): MultiModelToolCaller;
  propose(args?: Record<string, unknown>, extra?: Partial<MultiModelToolCaller>): Promise<string>;
  view(runId: string): NonNullable<WorkflowRunDtoV1['multiModel']>;
  run(runId: string): WorkflowRunDtoV1;
  record(runId: string): MultiModelRunRecord;
}

function seedCaller(permission = 'ask'): { ws: string; tree: string; caller: string } {
  const n = ++seeds;
  const ws = `ws-${n}`;
  const tree = `tree-${n}`;
  const caller = `n-caller-${n}`;
  const db = getDb();
  db.prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)').run(ws, `W${n}`);
  db.prepare('INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES (?, ?, ?, 1, 1)').run(tree, ws, caller);
  db.prepare(`INSERT INTO nodes (id, workspace_id, tree_id, kind, title, runtime_id, model_id, permission_mode, created_at)
    VALUES (?, ?, ?, 'chat', 'Cache design', 'alpha', 'a1', ?, 1)`).run(caller, ws, tree, permission);
  insertMessage(caller, `m-ask-${n}`, 'user', 'Which cache should we use? Also ask Beta and Gamma.');
  return { ws, tree, caller };
}

const TWO_THREADS = {
  title: 'Caches',
  threads: [
    { runtime: 'beta', model: 'b1', context: 'fork', prompt: 'Which cache?' },
    { runtime: 'gamma', context: 'fresh', prompt: 'Which cache, given LRU and LFU?' },
  ],
  reviewRounds: 1,
};

const THREE_THREADS = {
  ...TWO_THREADS,
  threads: [...TWO_THREADS.threads, { runtime: 'alpha', model: 'a2', context: 'fresh', prompt: 'Which cache?' }],
};

function harness(opts: { permission?: string; seed?: { ws: string; tree: string; caller: string }; workflowStore?: WorkflowRunStore; chat?: FakeChat } = {}): Harness {
  const seed = opts.seed ?? seedCaller(opts.permission);
  const chat = opts.chat ?? new FakeChat();
  const workflowStore = opts.workflowStore ?? memoryWorkflowStore();
  const hub = new WorkflowRunHub(workflowStore);
  const created: CreateChildInput[] = [];
  const createGates = new Map<string, Promise<void>>();
  const createFailures = new Set<string>();
  const answers: Harness['answers'] = [];
  const permissionListeners: Harness['permissionListeners'] = [];
  let uuid = 0;
  const h = {} as Harness;
  hub.subscribe(() => { h.hubUpdates += 1; });
  const orchestrator = new MultiModelOrchestrator({
    hub,
    store,
    chat: chat as never,
    ensureSession: async ({ nodeId }) => ({ id: nodeId, runtimeId: 'alpha' }) as AgentSession,
    acquireRestoreLock: async () => () => {},
    hasLiveSession: () => true,
    createChild: async (input): Promise<OpenedChild> => {
      created.push(input);
      const gate = createGates.get(input.choice.runtimeId);
      if (gate) await gate;
      if (createFailures.has(input.choice.runtimeId)) throw new Error('boom');
      getDb().prepare(`INSERT INTO nodes (id, workspace_id, tree_id, parent_node_id, kind, title, spawned_by_agent, permission_mode, created_at)
        VALUES (?, ?, ?, ?, 'chat', ?, 1, ?, 2)`).run(input.childNodeId, seed.ws, seed.tree, input.callerNodeId, input.title, input.permissionMode);
      store.markChild(input.childNodeId, input.runId, input.context === 'fresh');
      return { childNodeId: input.childNodeId, session: { id: input.childNodeId, runtimeId: input.choice.runtimeId } as AgentSession,
        forkKind: input.context === 'fresh' ? 'fresh' : 'text', release: () => {} };
    },
    answerPermission: (chatId, userId, answer) => { answers.push([chatId, userId, answer]); return { ok: true, nodeId: chatId }; },
    subscribePermissionAnswered: (listener) => { permissionListeners.push(listener); return () => {}; },
    turnError: (turnId) => chat.errors.get(turnId) ?? null,
    readyModels: new ReadyModelsService({ catalogCache: null, runtimes: () => RUNTIMES }),
    newUuid: () => `u${seeds}x${++uuid}`,
    liveCommitMs: 40,
  });
  Object.assign(h, {
    ...seed, chat, hub, workflowStore, orchestrator, created, createGates, createFailures, answers, permissionListeners, hubUpdates: 0,
    toolCaller: (extra: Partial<MultiModelToolCaller> = {}) => ({
      ownerUserId: null, workspaceId: seed.ws, nodeId: seed.caller, runtimeSessionId: null,
      turn: { turnId: `turn-caller-${seed.caller}`, assistantId: `m-assistant-${seed.caller}` },
      isAgentRun: false, assistant: false, maintenance: false, ...extra,
    }),
    propose: async (args: Record<string, unknown> = TWO_THREADS, extra: Partial<MultiModelToolCaller> = {}) =>
      (await orchestrator.propose(h.toolCaller(extra), args)).runId,
    run: (runId: string) => hub.get(OWNER, runId)!,
    view: (runId: string) => hub.get(OWNER, runId)!.multiModel!,
    record: (runId: string) => store.getRunById(runId)!,
  });
  orchestrator.start();
  return h;
}

async function rejectsWith(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MultiModelError, String(error));
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

/** Start a two-row run and let both answers begin. */
async function started(h: Harness, args: Record<string, unknown> = TWO_THREADS): Promise<string> {
  const runId = await h.propose(args);
  await h.orchestrator.startRun(OWNER, runId);
  const rows = (args.threads as unknown[]).length;
  await until(() => h.chat.began.filter((id) => id.includes('-s0-')).length === rows, 'every answer began');
  return runId;
}

describe('MultiModelOrchestrator', () => {
  before(() => { closeDb(); initDb(); });
  after(() => closeDb());

  test('propose: a paused run with Start/Cancel controls and a compact result', async () => {
    const h = harness();
    const result = await h.orchestrator.propose(h.toolCaller(), TWO_THREADS);
    assert.ok(JSON.stringify(result).length < 1_500);
    assert.deepEqual(result.threads, [
      { key: 't1', label: 'Beta · B1', context: 'fork' },
      { key: 't2', label: 'Gamma · Default model', context: 'fresh' },
    ]);
    assert.match(result.nativeId, /^mm_/);
    const run = h.run(result.runId);
    assert.equal(run.status, 'paused');
    assert.deepEqual([...run.actions].sort(), ['resume', 'stop']);
    assert.equal(run.multiModel?.phase, 'proposed');
    assert.equal(run.multiModel?.askPreview, 'Which cache should we use? Also ask Beta and Gamma.');
    assert.equal(run.multiModel?.callerMessageId, `m-assistant-${h.caller}`);
    assert.equal(run.multiModel?.callerRuntimeLabel, 'Alpha');
    assert.equal(h.record(result.runId).askMessageId, `m-ask-${seeds}`);
  });

  test('propose without the user\'s request makes every fork fresh: the plan, the result, added rows and the branches', async () => {
    const h = harness();
    getDb().prepare('DELETE FROM messages WHERE node_id = ?').run(h.caller);
    const result = await h.orchestrator.propose(h.toolCaller(), { ...TWO_THREADS, sharedContext: 'fork' });
    assert.deepEqual(result.threads.map((thread) => thread.context), ['fresh', 'fresh']);
    const record = h.record(result.runId);
    assert.equal(record.askMessageId, null);
    assert.deepEqual([record.plan.sharedContext, ...record.plan.threads.map((thread) => thread.context)], ['fresh', 'fresh', 'fresh']);
    const added = (await h.orchestrator.editPlan(OWNER, result.runId, { op: 'add', pick: { runtimeId: 'alpha', modelId: 'a2' } })).multiModel!;
    assert.deepEqual(added.threads.map((thread) => thread.context), ['fresh', 'fresh', 'fresh']);
    await h.orchestrator.startRun(OWNER, result.runId);
    await until(() => h.chat.began.length === 3, 'every answer began');
    assert.deepEqual(h.created.map((input) => input.context), ['fresh', 'fresh', 'fresh']);
    assert.equal(h.chat.turns.get(h.chat.turnOf('t1', 0)!)!.args.userMetadata?.threadMessage?.plan?.context, 'fresh', 'the caption says Fresh');
  });

  test('propose refuses Agent Runs, assistants, maintenance, branches, grandchildren, archived trees and synthesis turns', async () => {
    const h = harness();
    for (const extra of [{ isAgentRun: true }, { assistant: true }, { maintenance: true }, { nodeId: null }]) {
      await rejectsWith(h.orchestrator.propose(h.toolCaller(extra), TWO_THREADS), 'refused');
    }
    const runId = await started(h);
    await rejectsWith(h.propose(), 'refused', /already running/);
    const child = h.record(runId).state.threads.t1.childNodeId!;
    await rejectsWith(h.orchestrator.propose(h.toolCaller({ nodeId: child }), TWO_THREADS), 'refused', /branch of a multi-model plan/);
    getDb().prepare(`INSERT INTO nodes (id, workspace_id, tree_id, parent_node_id, kind, created_at) VALUES (?, ?, ?, ?, 'chat', 3)`)
      .run(`${child}-grand`, h.ws, h.tree, child);
    await rejectsWith(h.orchestrator.propose(h.toolCaller({ nodeId: `${child}-grand` }), TWO_THREADS), 'refused', /branch of a multi-model plan/);
    const synthesisTurn = `mm-synthesis-of-${h.caller}`;
    store.recordTurn({ turnId: synthesisTurn, runId, nodeId: h.caller, threadKey: null, role: 'synthesis', round: 0, attempt: 1, createdAt: 1 });

    const other = harness();
    store.recordTurn({ turnId: `${synthesisTurn}-2`, runId, nodeId: other.caller, threadKey: null, role: 'synthesis', round: 0, attempt: 1, createdAt: 1 });
    await rejectsWith(other.orchestrator.propose(other.toolCaller({ turn: { turnId: `${synthesisTurn}-2`, assistantId: 'm' } }), TWO_THREADS),
      'refused', /Write the synthesis/);
    getDb().prepare('UPDATE trees SET archived_at = 5 WHERE id = ?').run(other.tree);
    await rejectsWith(other.propose(), 'refused', /not available/);
  });

  test('propose validates the plan and lists the ready models on an error', async () => {
    const h = harness();
    await rejectsWith(h.propose({ threads: [] }), 'invalid', /threads must list 1-5/);
    const six = Array.from({ length: 6 }, () => ({ runtime: 'beta', prompt: 'p' }));
    await rejectsWith(h.propose({ threads: six }), 'invalid', /threads must list 1-5/);
    await rejectsWith(h.propose({ ...TWO_THREADS, reviewRounds: 3 }), 'invalid', /reviewRounds/);
    await rejectsWith(h.propose({ threads: [{ runtime: 'nope', prompt: 'p' }] }), 'model_unavailable', /Ready: alpha \(a1, a2\) \| beta \(b1\)/);
    await rejectsWith(h.propose({ threads: [{ runtime: 'beta', model: 'b1', prompt: 'p' }, { runtime: 'beta', model: 'b1', prompt: 'q' }] }), 'duplicate_model');
  });

  test('a newer proposal cancels the older one; parallel proposals leave one plan', async () => {
    const h = harness();
    const first = await h.propose();
    const second = await h.propose();
    assert.equal(h.record(first).status, 'cancelled');
    assert.equal(h.view(first).phase, 'cancelled');
    assert.equal(h.run(first).statusDetail, 'Replaced by a newer plan');
    assert.equal(h.record(second).status, 'proposed');
    const [a, b] = await Promise.all([h.propose(), h.propose()]);
    const proposed = [a, b, second].filter((id) => h.record(id).status === 'proposed');
    assert.equal(proposed.length, 1);
  });

  test('propose writes nothing when the turn was stopped', async () => {
    const h = harness();
    const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM multi_model_runs').get() as { n: number }).n;
    const before = count();
    const controller = new AbortController();
    controller.abort();
    await rejectsWith(h.orchestrator.propose(h.toolCaller(), TWO_THREADS, { signal: controller.signal }), 'refused', /stopped before the plan was shown/);
    assert.equal(count(), before);
  });

  test('editPlan removes, restores, replaces and adds rows within the limits', async () => {
    const h = harness();
    const runId = await h.propose({ ...TWO_THREADS, sharedPrompt: 'Shared?', sharedContext: 'fork' });
    let view = (await h.orchestrator.editPlan(OWNER, runId, { op: 'remove', key: 't1' })).multiModel!;
    assert.equal(view.threads[0].removed, true);
    view = (await h.orchestrator.editPlan(OWNER, runId, { op: 'restore', key: 't1' })).multiModel!;
    assert.equal(view.threads[0].removed, undefined);
    view = (await h.orchestrator.editPlan(OWNER, runId, { op: 'replace', key: 't2', pick: { runtimeId: 'alpha', modelId: 'a2' } })).multiModel!;
    assert.deepEqual([view.threads[1].runtimeId, view.threads[1].modelId, view.threads[1].context], ['alpha', 'a2', 'fresh']);
    assert.equal(h.record(runId).plan.threads[1].prompt, 'Which cache, given LRU and LFU?', 'replace keeps the prompt');
    await rejectsWith(h.orchestrator.editPlan(OWNER, runId, { op: 'replace', key: 't2', pick: { runtimeId: 'beta', modelId: 'b1' } }), 'duplicate_model');
    view = (await h.orchestrator.editPlan(OWNER, runId, { op: 'add', pick: { runtimeId: 'gamma' } })).multiModel!;
    assert.deepEqual([view.threads[2].key, view.threads[2].context, view.threads[2].addedByUser], ['a1', 'fork', true]);
    assert.equal(h.record(runId).plan.threads[2].prompt, 'Shared?');
    await h.orchestrator.editPlan(OWNER, runId, { op: 'add', pick: { runtimeId: 'alpha', modelId: 'a1' } });
    await h.orchestrator.editPlan(OWNER, runId, { op: 'add', pick: { runtimeId: 'gamma', modelId: 'g1' } });
    await rejectsWith(h.orchestrator.editPlan(OWNER, runId, { op: 'add', pick: { runtimeId: 'beta' } }), 'limit');
    await rejectsWith(h.orchestrator.editPlan('someone-else', runId, { op: 'remove', key: 't1' }), 'not_found');
    await h.orchestrator.startRun(OWNER, runId);
    await rejectsWith(h.orchestrator.editPlan(OWNER, runId, { op: 'remove', key: 't1' }), 'not_proposed');
  });

  test('Start creates branches one at a time, each after the previous turn began and before it ended', async () => {
    const h = harness({ permission: 'trust' });
    const runId = await h.propose(THREE_THREADS);
    const log: string[] = [];
    const create = h.orchestrator['deps'].createChild;
    h.orchestrator['deps'].createChild = async (input) => {
      const record = h.record(runId);
      assert.equal(record.state.threads[input.choice.runtimeId === 'beta' ? 't1' : input.choice.runtimeId === 'gamma' ? 't2' : 't3'].childNodeId, input.childNodeId,
        'the child id is persisted before createChild');
      assert.ok(Object.values(record.state.threads).every((thread) => thread.steps[0].status !== 'pending'), 'every row is queued');
      log.push(`create ${input.choice.runtimeId} after ${h.chat.began.length} began`);
      return create(input);
    };
    const run = await h.orchestrator.startRun(OWNER, runId);
    assert.equal(run.status, 'running');
    assert.deepEqual(run.multiModel!.threads.map((thread) => thread.steps.map((step) => step.status)), [['queued', 'pending'], ['queued', 'pending'], ['queued', 'pending']]);
    await until(() => h.chat.began.length === 3, 'three answers began');
    assert.deepEqual(log, ['create beta after 0 began', 'create gamma after 1 began', 'create alpha after 2 began']);
    assert.ok([...h.chat.turns.values()].every((turn) => turn.status === 'active'), 'no turn ended');
    assert.deepEqual(h.created.map((input) => [input.permissionMode, input.approveForMe]), [['trust', false], ['trust', false], ['trust', false]]);
    const first = h.chat.turns.get(h.chat.turnOf('t1', 0)!)!;
    assert.match(first.args.text, /^\[Multi-model plan\] Step 1 of a plan the user started from "Cache design"/);
    assert.equal(first.args.displayText, first.args.text);
    assert.deepEqual(first.args.userMetadata?.threadMessage, {
      fromNodeId: h.caller, fromTitle: 'Cache design', hop: 1, plan: { runId, step: 'answer', context: 'fork', fromLabel: 'Alpha' },
    });
    assert.equal(h.view(runId).threads[0].steps[0].status, 'running');
    assert.deepEqual(h.run(runId).actions, ['stop']);
    assert.equal(await h.orchestrator.startRun(OWNER, runId).then((again) => again.status), 'running', 'Start again returns the run');
  });

  test('the barrier waits for rows not yet created, and for a failed open', async () => {
    const h = harness();
    let release!: () => void;
    h.createGates.set('gamma', new Promise<void>((resolve) => { release = resolve; }));
    h.createFailures.add('beta');
    const runId = await h.propose(THREE_THREADS);
    await h.orchestrator.startRun(OWNER, runId);
    await until(() => h.created.length === 2, 'gamma is being created');
    assert.equal(h.view(runId).threads[0].steps[0].status, 'failed');
    assert.equal(h.view(runId).threads[0].steps[0].error, 'Could not open Beta · B1: boom');
    assert.equal(h.view(runId).threads[0].childNodeId, null);
    release();
    await until(() => h.chat.began.length === 2, 'gamma and alpha began');
    h.chat.answer(h.chat.turnOf('t3', 0), 'Alpha says LRU.');
    await until(() => h.view(runId).threads[2].steps[0].status === 'completed', 'alpha answered');
    assert.equal(h.chat.turnOf('t3', 1), undefined, 'the review waits for gamma');
    assert.equal(h.view(runId).phase, 'running');
    h.chat.answer(h.chat.turnOf('t2', 0), 'Gamma says LFU.');
    await until(() => !!h.chat.turnOf('t2', 1) && !!h.chat.turnOf('t3', 1), 'both reviews began');
    const review = h.chat.turns.get(h.chat.turnOf('t2', 1)!)!;
    assert.match(review.args.text, /Below is the answer from Alpha · A2 \(Beta · B1 did not take part\)/);
    assert.match(review.args.text, /### Alpha · A2 \(Fresh\)\nAlpha says LRU\./);
    assert.doesNotMatch(review.args.text, /Gamma says LFU/);
    assert.deepEqual(review.args.userMetadata?.threadMessage?.plan, { runId, step: 'review', round: 1, rounds: 1, fromLabel: 'Alpha' });
    assert.equal(h.view(runId).threads[0].steps[1].status, 'skipped');
  });

  test('Stop all and Stop thread during the sequential launch create no child for unlaunched rows', async () => {
    const h = harness();
    let release!: () => void;
    h.createGates.set('beta', new Promise<void>((resolve) => { release = resolve; }));
    const runId = await h.propose();
    await h.orchestrator.startRun(OWNER, runId);
    await until(() => h.created.length === 1, 'beta is being created');
    await h.orchestrator.stopAll(OWNER, runId);
    release();
    await until(() => h.view(runId).threads[0].steps[0].status === 'cancelled', 'beta settles');
    assert.equal(h.created.length, 1, 'gamma never got a child');
    assert.deepEqual(h.view(runId).threads.map((thread) => thread.steps[0].status), ['cancelled', 'cancelled']);
    assert.equal(h.view(runId).threads[1].childNodeId, null);
    assert.equal(h.chat.began.length, 0);
    assert.deepEqual(h.run(runId).actions, []);

    const g = harness();
    let releaseG!: () => void;
    g.createGates.set('beta', new Promise<void>((resolve) => { releaseG = resolve; }));
    const second = await g.propose();
    await g.orchestrator.startRun(OWNER, second);
    await until(() => g.created.length === 1, 'beta is being created');
    await g.orchestrator.stopThread(OWNER, second, 't2');
    assert.equal(g.view(second).threads[1].steps[0].status, 'stopped');
    releaseG();
    await until(() => g.chat.began.length === 1, 'beta began');
    assert.equal(g.created.length, 1);
  });

  test('Replace reads the caller permission mode again', async () => {
    const h = harness({ permission: 'yolo' });
    const runId = await started(h);
    h.chat.end(h.chat.turnOf('t1', 0), 'error', 'quota');
    await until(() => h.view(runId).threads[0].steps[0].status === 'failed', 'beta failed');
    getDb().prepare("UPDATE nodes SET permission_mode = 'ask' WHERE id = ?").run(h.caller);
    const oldChild = h.record(runId).state.threads.t1.childNodeId;
    await h.orchestrator.replaceThread(OWNER, runId, 't1', { runtimeId: 'alpha', modelId: 'a2' });
    await until(() => h.created.length === 3, 'the replacement was created');
    assert.equal(h.created[0].permissionMode, 'yolo');
    assert.equal(h.created[2].permissionMode, 'ask');
    const thread = h.record(runId).state.threads.t1;
    assert.deepEqual(thread.previousChildNodeIds, [oldChild]);
    assert.equal(thread.generation, 1);
    await until(() => !!h.chat.turns.get(thread.childNodeId ? h.chat.began.at(-1)! : '')?.args, 'the replacement turn began');
    const turnId = h.chat.began.at(-1)!;
    assert.match(turnId, /-t1-g1-s0-a1$/);
    assert.equal(store.turn(turnId)?.nodeId, thread.childNodeId);
    assert.equal(h.view(runId).threads[0].runtimeId, 'alpha');
  });

  test('a branch copies the caller\'s own permission setting, not the global one; the card shows the effective mode', async () => {
    // Global off: the caller's own setting is also its effective mode.
    const off = harness({ permission: 'ask' });
    getDb().prepare('UPDATE nodes SET permission_approve_for_me = 1 WHERE id = ?').run(off.caller);
    const offRun = await started(off);
    assert.deepEqual(off.created.map((input) => [input.permissionMode, input.approveForMe]), [['ask', true], ['ask', true]]);
    assert.deepEqual([off.view(offRun).permissionMode, off.view(offRun).approveForMe], ['ask', true]);

    // Global Trust over a caller left on Ask: turning the global setting off later puts both back on Ask.
    writeChatPermissionSettings({ global: true, mode: 'trust' });
    try {
      const on = harness({ permission: 'ask' });
      getDb().prepare('UPDATE nodes SET permission_approve_for_me = 1 WHERE id = ?').run(on.caller);
      const onRun = await started(on);
      assert.deepEqual(on.created.map((input) => [input.permissionMode, input.approveForMe]), [['ask', true], ['ask', true]]);
      assert.deepEqual([on.view(onRun).permissionMode, on.view(onRun).approveForMe], ['trust', undefined]);
    } finally {
      writeChatPermissionSettings({ global: false, mode: 'ask' });
    }

    // Cloud: only the workspace owner reads the caller's own setting.
    const cloud = harness({ permission: 'yolo' });
    getDb().prepare("UPDATE workspaces SET owner_user_id = 'alice' WHERE id = ?").run(cloud.ws);
    const priorCloud = process.env.MICHI_CLOUD;
    process.env.MICHI_CLOUD = '1';
    try {
      assert.deepEqual(readNodePermissionSetting(cloud.caller, 'alice'), { mode: 'yolo', approveForMe: false });
      assert.deepEqual(readNodePermissionSetting(cloud.caller, 'mallory'), { mode: 'ask', approveForMe: false });
      assert.deepEqual(readNodePermissionSetting(cloud.caller, null), { mode: 'ask', approveForMe: false });
    } finally {
      if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
    }
  });

  test('Start of two runs of one caller at once starts one', async () => {
    const h = harness();
    const a = await h.propose();
    const record = h.record(a);
    const b = 'wfr_parallel_b';
    store.insertRun({ ...record, id: b, nativeId: `${record.nativeId}b`, status: 'proposed' }, 1);
    const results = await Promise.allSettled([h.orchestrator.startRun(OWNER, a), h.orchestrator.startRun(OWNER, b)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal((rejected.reason as MultiModelError).code, 'already_running');
  });

  test('a full run: answers, one review round, the synthesis', async () => {
    const h = harness();
    const runId = await started(h, THREE_THREADS);
    h.chat.answer(h.chat.turnOf('t1', 0), 'Beta: LRU.', JSON.stringify({ usageSummary: { totalTokens: 100 } }));
    h.chat.answer(h.chat.turnOf('t2', 0), 'Gamma: LFU.');
    h.chat.end(h.chat.turnOf('t3', 0), 'error', 'Codex quota');
    await until(() => !!h.chat.turnOf('t1', 1) && !!h.chat.turnOf('t2', 1), 'reviews began');
    assert.equal(h.chat.turnOf('t3', 1), undefined);
    const review = h.chat.turns.get(h.chat.turnOf('t1', 1)!)!.args.text;
    assert.match(review, /Below is the answer from Gamma · Default model \(Alpha · A2 did not take part\)/);
    assert.doesNotMatch(review, /Beta: LRU/);
    assert.equal(h.view(runId).threads[0].steps[0].summary, 'Beta: LRU.');
    h.chat.answer(h.chat.turnOf('t1', 1), 'Beta, revised: LFU.');
    h.chat.answer(h.chat.turnOf('t2', 1), 'Gamma keeps LFU.');
    await until(() => !!h.chat.synthesis(), 'the synthesis began');
    const synthesis = h.chat.turns.get(h.chat.synthesis()!)!;
    assert.equal(synthesis.args.nodeId, h.caller);
    assert.match(synthesis.args.text, /Results from 3 branches \(2 answered, 1 did not take part\), 1 review round\./);
    assert.match(synthesis.args.text, /### Beta · B1 \(Fork\) — final answer after review\nFirst answer, in short: Beta: LRU\.\nBeta, revised: LFU\./);
    assert.match(synthesis.args.text, /### Alpha · A2 — did not take part\nFailed in step 1: Codex quota/);
    assert.deepEqual(synthesis.args.userMetadata?.threadMessage, {
      fromNodeId: h.caller, fromTitle: 'Cache design', hop: 2, plan: { runId, step: 'synthesis', branches: 3 },
    });
    assert.equal(h.view(runId).synthesis.status, 'running');
    h.chat.answer(h.chat.synthesis(), 'Use LFU.');
    await until(() => h.view(runId).phase === 'completed', 'the run completed');
    const run = h.run(runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.result, 'Use LFU.');
    assert.equal(run.usage?.totalTokens, 100);
    assert.equal(run.multiModel?.lastMessageId, replyId(h.caller, h.chat.synthesis()!));
    assert.deepEqual(run.nodes.filter((node) => node.kind === 'phase').map((node) => [node.id, node.status]),
      [['answer', 'completed'], ['review-1', 'completed'], ['synthesis', 'completed']]);
    assert.ok(run.nodes.some((node) => node.id === 't1@1' && node.status === 'completed'));
    assert.equal(store.openTurns(runId).length, 0);
    assert.equal(h.orchestrator['records'].has(runId), false, 'an ended, settled run leaves the in-memory maps');
    assert.equal(h.orchestrator['controls'].has(runId), false);
    assert.equal((await h.orchestrator.retryThread(OWNER, runId, 't3')).status, 'running', 'it reopens from the store');
  });

  test('two review rounds read the previous round', async () => {
    const h = harness();
    const runId = await started(h, { ...TWO_THREADS, reviewRounds: 2 });
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.answer(h.chat.turnOf('t2', 0), 'G0');
    await until(() => !!h.chat.turnOf('t1', 1) && !!h.chat.turnOf('t2', 1), 'round 1');
    h.chat.answer(h.chat.turnOf('t1', 1), 'B1');
    h.chat.answer(h.chat.turnOf('t2', 1), 'G1');
    await until(() => !!h.chat.turnOf('t1', 2), 'round 2');
    const text = h.chat.turns.get(h.chat.turnOf('t1', 2)!)!.args.text;
    assert.match(text, /^\[Multi-model plan\] Review round 2 of 2/);
    assert.match(text, /\nG1$/);
    assert.equal(h.view(runId).threads[0].steps.length, 3);
  });

  test('no answer: the run fails without a synthesis; one survivor skips the reviews', async () => {
    const h = harness();
    const runId = await started(h);
    h.chat.end(h.chat.turnOf('t1', 0), 'error', 'x');
    h.chat.end(h.chat.turnOf('t2', 0), 'error', 'y');
    await until(() => h.view(runId).phase === 'failed', 'failed');
    assert.equal(h.run(runId).statusDetail, 'No branch produced an answer');
    assert.equal(h.chat.synthesis(), undefined);

    const g = harness();
    const second = await started(g);
    g.chat.answer(g.chat.turnOf('t1', 0), 'only');
    g.chat.end(g.chat.turnOf('t2', 0), 'error', 'y');
    await until(() => !!g.chat.synthesis(), 'synthesis');
    assert.equal(g.view(second).threads[0].steps[1].status, 'skipped');
    assert.equal(g.view(second).threads[0].steps[1].error, 'Only one answer, nothing to review');
    assert.equal(g.view(second).threads[1].steps[1].error, 'Failed in step 1: y', 'a failed row keeps its own reason');
    assert.match(g.chat.turns.get(g.chat.synthesis()!)!.args.text, /— did not take part\nFailed in step 1: y/);
  });

  test('a failed answer whose review was skipped can still be retried', async () => {
    const h = harness();
    const runId = await started(h, THREE_THREADS);
    h.chat.end(h.chat.turnOf('t3', 0), 'error', 'quota');
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.answer(h.chat.turnOf('t2', 0), 'G0');
    await until(() => !!h.chat.turnOf('t1', 1) && !!h.chat.turnOf('t2', 1), 'reviews began');
    assert.deepEqual(h.view(runId).threads[2].steps.map((step) => step.status), ['failed', 'skipped']);
    assert.equal(h.view(runId).threads[2].steps[1].error, 'Failed in step 1: quota');
    await h.orchestrator.retryThread(OWNER, runId, 't3');
    await until(() => !!h.chat.turnOf('t3', 0, 2) && h.view(runId).threads[2].steps[0].status === 'running', 'the answer re-ran');
    assert.equal(h.view(runId).threads[2].late, true);
    assert.deepEqual(h.view(runId).threads[2].steps.map((step) => step.status), ['running', 'skipped']);
    h.chat.answer(h.chat.turnOf('t1', 1), 'B1');
    h.chat.answer(h.chat.turnOf('t2', 1), 'G1');
    h.chat.answer(h.chat.turnOf('t3', 0, 2), 'A late');
    await until(() => !!h.chat.synthesis(), 'the synthesis began');
    assert.match(h.chat.turns.get(h.chat.synthesis()!)!.args.text, /### Alpha · A2 \(Fresh\)\nA late/);
  });

  test('a finished run: a failed answer whose review was skipped is retried late and gets an addendum', async () => {
    const h = harness();
    const runId = await started(h, THREE_THREADS);
    h.chat.end(h.chat.turnOf('t3', 0), 'error', 'quota');
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.answer(h.chat.turnOf('t2', 0), 'G0');
    await until(() => !!h.chat.turnOf('t1', 1) && !!h.chat.turnOf('t2', 1), 'reviews began');
    h.chat.answer(h.chat.turnOf('t1', 1), 'B1');
    h.chat.answer(h.chat.turnOf('t2', 1), 'G1');
    await until(() => !!h.chat.synthesis(), 'synthesis');
    h.chat.answer(h.chat.synthesis(), 'Synthesis.');
    await until(() => h.view(runId).phase === 'completed', 'completed');
    assert.deepEqual(h.view(runId).threads[2].steps.map((step) => step.status), ['failed', 'skipped']);
    await h.orchestrator.retryThread(OWNER, runId, 't3');
    assert.equal(h.view(runId).phase, 'running');
    assert.equal(h.view(runId).threads[2].late, true);
    await until(() => !!h.chat.turnOf('t3', 0, 2), 'late attempt began');
    h.chat.answer(h.chat.turnOf('t3', 0, 2), 'A late');
    await until(() => !!h.chat.addendum(1), 'addendum began');
    assert.match(h.chat.turns.get(h.chat.addendum(1)!)!.args.text, /A late/);
    assert.deepEqual(h.view(runId).threads[2].steps.map((step) => step.status), ['completed', 'skipped'], 'the skipped review stays skipped');
    h.chat.answer(h.chat.addendum(1), 'Addendum.');
    await until(() => h.view(runId).phase === 'completed', 'completed again');
  });

  test('run Retry of a run whose every answer failed re-runs the answers', async () => {
    const h = harness();
    const runId = await started(h);
    h.chat.end(h.chat.turnOf('t1', 0), 'error', 'x');
    h.chat.end(h.chat.turnOf('t2', 0), 'error', 'y');
    await until(() => h.view(runId).phase === 'failed', 'failed');
    assert.deepEqual(h.view(runId).threads.map((thread) => thread.steps[1].status), ['skipped', 'skipped']);
    await h.orchestrator.retryRun(OWNER, runId);
    await until(() => !!h.chat.turnOf('t1', 0, 2) && !!h.chat.turnOf('t2', 0, 2), 'attempt 2 began');
    assert.equal(h.view(runId).phase, 'running');
    h.chat.answer(h.chat.turnOf('t1', 0, 2), 'B0');
    h.chat.answer(h.chat.turnOf('t2', 0, 2), 'G0');
    await until(() => !!h.chat.synthesis(), 'the synthesis began');
  });

  test('Stop thread: queued behind a foreground turn (withdrawn) and running (cancelled) both end stopped; Retry rejoins', async () => {
    const h = harness();
    const runId = await started(h);
    const t2Child = h.record(runId).state.threads.t2.childNodeId!;
    let releaseForeground!: () => void;
    h.chat.gates.set(t2Child, new Promise<void>((resolve) => { releaseForeground = resolve; }));
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.answer(h.chat.turnOf('t2', 0), 'G0');
    await until(() => !!h.chat.turnOf('t1', 1), 't1 review began');
    assert.equal(h.view(runId).threads[1].steps[1].status, 'queued');
    await h.orchestrator.stopThread(OWNER, runId, 't2');
    releaseForeground();
    await until(() => h.view(runId).threads[1].steps[1].status === 'stopped', 'queued review stopped');
    assert.equal(h.chat.turnOf('t2', 1), undefined, 'never began');

    const t1Review = h.chat.turnOf('t1', 1)!;
    await h.orchestrator.stopThread(OWNER, runId, 't1');
    assert.deepEqual(h.chat.cancels.at(-1), [h.record(runId).state.threads.t1.childNodeId, t1Review]);
    h.chat.end(t1Review, 'cancelled');
    await until(() => h.view(runId).threads[0].steps[1].status === 'stopped', 'running review stopped');
    await until(() => !!h.chat.synthesis(), 'the synthesis went ahead with the first answers');
    assert.match(h.chat.turns.get(h.chat.synthesis()!)!.args.text, /— review failed; first answer/);
  });

  test('Retry of a stopped thread clears the stop and joins the next round', async () => {
    const h = harness();
    const runId = await started(h, { ...TWO_THREADS, reviewRounds: 1 });
    await h.orchestrator.stopThread(OWNER, runId, 't1');
    h.chat.end(h.chat.turnOf('t1', 0), 'cancelled');
    await until(() => h.view(runId).threads[0].steps[0].status === 'stopped', 'stopped');
    await h.orchestrator.retryThread(OWNER, runId, 't1');
    await until(() => !!h.chat.turnOf('t1', 0, 2), 'attempt 2 began');
    assert.equal(h.record(runId).state.threads.t1.stopRequested, false);
    h.chat.answer(h.chat.turnOf('t1', 0, 2), 'B0');
    h.chat.answer(h.chat.turnOf('t2', 0), 'G0');
    await until(() => !!h.chat.turnOf('t1', 1) && !!h.chat.turnOf('t2', 1), 'both reviews');
  });

  test('a Stop from the branch pane ends the step stopped', async () => {
    const h = harness();
    const runId = await started(h);
    const turnId = h.chat.turnOf('t1', 0)!;
    h.chat.cancel(h.record(runId).state.threads.t1.childNodeId!, turnId);
    h.chat.end(turnId, 'cancelled');
    await until(() => h.view(runId).threads[0].steps[0].status === 'stopped', 'stopped');
    assert.equal(store.turn(turnId)?.outcome, 'stopped');
  });

  test('Stop all cancels (not stops) the running steps; Retry waits for them, then re-runs with attempt 2', async () => {
    const h = harness();
    const runId = await started(h);
    await h.orchestrator.stopAll(OWNER, runId);
    assert.equal(h.chat.cancels.length, 2);
    assert.equal(h.view(runId).phase, 'cancelled');
    assert.equal(h.run(runId).statusDetail, 'Stopped');
    assert.equal(h.view(runId).settling, true);
    await rejectsWith(h.orchestrator.retryRun(OWNER, runId), 'thread_busy', /Still stopping/);
    h.chat.end(h.chat.turnOf('t1', 0), 'cancelled');
    h.chat.end(h.chat.turnOf('t2', 0), 'cancelled');
    await until(() => h.view(runId).threads.every((thread) => thread.steps[0].status === 'cancelled') && !h.view(runId).settling, 'settled');
    assert.equal(h.chat.synthesis(), undefined);
    assert.equal(h.run(runId).nodes.find((node) => node.id === 'answer')?.status, 'cancelled', 'a stop is not a failure');
    await h.orchestrator.retryRun(OWNER, runId);
    await until(() => !!h.chat.turnOf('t1', 0, 2) && !!h.chat.turnOf('t2', 0, 2), 'attempt 2 began');
    assert.equal(h.view(runId).phase, 'running');
  });

  test('a late retry after the synthesis gets one addendum; a failed addendum is not restarted, Retry re-arms it', async () => {
    const h = harness();
    const runId = await started(h, { ...TWO_THREADS, reviewRounds: 0 });
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.end(h.chat.turnOf('t2', 0), 'error', 'boom');
    await until(() => !!h.chat.synthesis(), 'synthesis');
    h.chat.answer(h.chat.synthesis(), 'Synthesis.');
    await until(() => h.view(runId).phase === 'completed', 'completed');
    await h.orchestrator.retryThread(OWNER, runId, 't2');
    assert.equal(h.view(runId).phase, 'running');
    assert.equal(h.view(runId).threads[1].late, true);
    await until(() => !!h.chat.turnOf('t2', 0, 2), 'late attempt began');
    h.chat.answer(h.chat.turnOf('t2', 0, 2), 'G late');
    await until(() => !!h.chat.addendum(1), 'addendum began');
    assert.match(h.chat.turns.get(h.chat.addendum(1)!)!.args.text, /Late result from Gamma · Default model\.\n\n### Gamma · Default model \(Fresh\)\nG late/);
    h.chat.end(h.chat.addendum(1), 'error', 'no quota');
    await until(() => h.view(runId).phase === 'completed', 'completed again');
    assert.equal(h.run(runId).statusDetail, "Couldn't add the late answers: no quota");
    assert.equal([...h.chat.turns.keys()].filter((id) => id.includes('-add')).length, 1);
    await h.orchestrator.retryRun(OWNER, runId);
    await until(() => !!h.chat.addendum(1, 2), 'addendum attempt 2');
    h.chat.cancel(h.caller, h.chat.addendum(1, 2));
    h.chat.end(h.chat.addendum(1, 2), 'cancelled');
    await until(() => h.view(runId).phase === 'completed' && h.run(runId).statusDetail === 'Addendum stopped', 'addendum stopped');
  });

  test('run Retry of a completed run re-runs its failed branches late, with an addendum; a branch the user stopped stays', async () => {
    const h = harness();
    const runId = await started(h, { ...THREE_THREADS, reviewRounds: 0 });
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.end(h.chat.turnOf('t2', 0), 'error', 'quota');
    await h.orchestrator.stopThread(OWNER, runId, 't3');
    h.chat.end(h.chat.turnOf('t3', 0), 'cancelled');
    await until(() => !!h.chat.synthesis(), 'synthesis');
    h.chat.answer(h.chat.synthesis(), 'Synthesis.');
    await until(() => h.view(runId).phase === 'completed', 'completed');
    assert.deepEqual(h.view(runId).threads.map((thread) => thread.steps[0].status), ['completed', 'failed', 'stopped']);
    assert.equal((await h.orchestrator.retryRun(OWNER, runId)).status, 'running');
    await until(() => !!h.chat.turnOf('t2', 0, 2), 'the failed branch re-ran');
    assert.equal(h.view(runId).threads[1].late, true);
    assert.equal(h.chat.turnOf('t3', 0, 2), undefined, 'the stopped branch stays stopped');
    assert.equal(h.chat.turnOf('t1', 0, 2), undefined);
    h.chat.answer(h.chat.turnOf('t2', 0, 2), 'G late');
    await until(() => !!h.chat.addendum(1), 'addendum began');
    assert.match(h.chat.turns.get(h.chat.addendum(1)!)!.args.text, /G late/);
    h.chat.answer(h.chat.addendum(1), 'Addendum.');
    await until(() => h.view(runId).phase === 'completed', 'completed again');
    await rejectsWith(h.orchestrator.retryRun(OWNER, runId), 'not_running', /Nothing in this run needs a retry/);
  });

  test('run Retry of a completed run with a failed addendum and a failed branch re-arms the addendum for both', async () => {
    const h = harness();
    const runId = await started(h, { ...THREE_THREADS, reviewRounds: 0 });
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.end(h.chat.turnOf('t2', 0), 'error', 'quota');
    h.chat.end(h.chat.turnOf('t3', 0), 'error', 'quota');
    await until(() => !!h.chat.synthesis(), 'synthesis');
    h.chat.answer(h.chat.synthesis(), 'Synthesis.');
    await until(() => h.view(runId).phase === 'completed', 'completed');
    await h.orchestrator.retryThread(OWNER, runId, 't2');
    await until(() => !!h.chat.turnOf('t2', 0, 2), 'the row retry began');
    h.chat.answer(h.chat.turnOf('t2', 0, 2), 'G late');
    await until(() => !!h.chat.addendum(1), 'addendum began');
    h.chat.end(h.chat.addendum(1), 'error', 'no quota');
    await until(() => h.view(runId).phase === 'completed', 'completed with a failed addendum');
    await h.orchestrator.retryRun(OWNER, runId);
    await until(() => !!h.chat.turnOf('t3', 0, 2), 'the failed branch re-ran');
    assert.equal(h.chat.addendum(1, 2), undefined, 'the addendum waits for the branch');
    h.chat.answer(h.chat.turnOf('t3', 0, 2), 'A late');
    await until(() => !!h.chat.addendum(1, 2), 'addendum attempt 2');
    const text = h.chat.turns.get(h.chat.addendum(1, 2)!)!.args.text;
    assert.match(text, /G late/);
    assert.match(text, /A late/);
    assert.deepEqual(h.record(runId).state.addenda.map((addendum) => addendum.keys), [['t2', 't3']]);
  });

  test('Replace and Retry refuse the only answer, whose review was skipped; a failed row can still be replaced', async () => {
    const h = harness();
    const runId = await started(h);
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.end(h.chat.turnOf('t2', 0), 'error', 'quota');
    await until(() => !!h.chat.synthesis(), 'synthesis');
    assert.deepEqual(h.view(runId).threads[0].steps.map((step) => [step.status, step.error]),
      [['completed', undefined], ['skipped', 'Only one answer, nothing to review']]);
    const pick = { runtimeId: 'alpha', modelId: 'a2' };
    await rejectsWith(h.orchestrator.replaceThread(OWNER, runId, 't1', pick), 'thread_not_retryable');
    await rejectsWith(h.orchestrator.retryThread(OWNER, runId, 't1'), 'thread_not_retryable');
    h.chat.answer(h.chat.synthesis(), 'Synthesis.');
    await until(() => h.view(runId).phase === 'completed', 'completed');
    await rejectsWith(h.orchestrator.replaceThread(OWNER, runId, 't1', pick), 'thread_not_retryable');
    assert.equal(h.record(runId).state.threads.t1.generation, 0, 'the answer is kept');
    await h.orchestrator.replaceThread(OWNER, runId, 't2', pick);
    await until(() => h.chat.began.some((id) => id.endsWith('-t2-g1-s0-a1')), 'the failed row was replaced');
  });

  test('a retry in the current step holds the barrier', async () => {
    const h = harness();
    const runId = await started(h);
    h.chat.end(h.chat.turnOf('t1', 0), 'error', 'flaky');
    await until(() => h.view(runId).threads[0].steps[0].status === 'failed', 'failed');
    await h.orchestrator.retryThread(OWNER, runId, 't1');
    assert.equal(h.view(runId).threads[0].late, undefined);
    h.chat.answer(h.chat.turnOf('t2', 0), 'G0');
    await until(() => !!h.chat.turnOf('t1', 0, 2), 'retry began');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.chat.turnOf('t2', 1), undefined, 'the review waits for the retry');
    h.chat.answer(h.chat.turnOf('t1', 0, 2), 'B0');
    await until(() => !!h.chat.turnOf('t2', 1), 'the review began');
  });

  test('a row replaced while a review runs is late: the review finishes without it and the synthesis waits for it', async () => {
    const h = harness();
    const runId = await started(h, THREE_THREADS);
    h.chat.end(h.chat.turnOf('t3', 0), 'error', 'quota');
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.answer(h.chat.turnOf('t2', 0), 'G0');
    await until(() => !!h.chat.turnOf('t1', 1) && !!h.chat.turnOf('t2', 1), 'reviews began');
    await h.orchestrator.replaceThread(OWNER, runId, 't3', { runtimeId: 'alpha', modelId: 'a1' });
    assert.equal(h.view(runId).threads[2].late, true);
    assert.deepEqual(h.view(runId).threads[2].steps.map((step) => [step.status, step.error]),
      [['queued', undefined], ['skipped', 'Replaced after this round started']], 'it never joins the round that started');
    await until(() => h.chat.began.some((id) => id.endsWith('-t3-g1-s0-a1')), 'the replacement began');
    h.chat.answer(h.chat.turnOf('t1', 1), 'B1');
    h.chat.answer(h.chat.turnOf('t2', 1), 'G1');
    await until(() => h.view(runId).threads.slice(0, 2).every((thread) => thread.steps[1].status === 'completed'), 'reviews done');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.chat.synthesis(), undefined, 'the synthesis waits for the late row');
    h.chat.answer(h.chat.began.find((id) => id.endsWith('-t3-g1-s0-a1')), 'A late');
    await until(() => !!h.chat.synthesis(), 'the synthesis began');
    assert.match(h.chat.turns.get(h.chat.synthesis()!)!.args.text, /### Alpha · A1 \(Fresh\)\nA late/);
  });

  test('Retry of a "Could not open" step creates the child through the open queue', async () => {
    const h = harness();
    h.createFailures.add('beta');
    const runId = await h.propose();
    await h.orchestrator.startRun(OWNER, runId);
    await until(() => h.view(runId).threads[0].steps[0].status === 'failed', 'open failed');
    h.createFailures.delete('beta');
    await h.orchestrator.retryThread(OWNER, runId, 't1');
    await until(() => !!h.chat.turnOf('t1', 0, 2), 'created and began');
    assert.equal(h.created.filter((input) => input.choice.runtimeId === 'beta').length, 2);
  });

  test('frames of another turn in a branch never touch the step', async () => {
    const h = harness();
    const runId = await started(h);
    const child = h.record(runId).state.threads.t1.childNodeId!;
    h.chat.emit({ event: 'tool_call', data: { nodeId: child, turnId: 'user-own-turn', title: 'rg', toolCallId: 'x', status: 'running' } });
    h.chat.emit({ event: 'permission_request', data: { nodeId: child, turnId: 'user-own-turn', requestId: 1, title: 't', options: [] } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(h.view(runId).threads[0].steps[0].status, 'running');
    assert.equal(h.view(runId).threads[0].steps[0].now, undefined);
  });

  test('live activity: tool lines and the answer tail, committed at most once per interval', async () => {
    const h = harness();
    const runId = await started(h);
    const child = h.record(runId).state.threads.t1.childNodeId!;
    const turnId = h.chat.turnOf('t1', 0)!;
    const before = h.hubUpdates;
    h.chat.emit({ event: 'tool_call', data: { nodeId: child, turnId, title: 'rg -n cache', toolCallId: 'x', status: 'running' } });
    await until(() => h.view(runId).threads[0].steps[0].now === 'Running rg -n cache', 'tool line');
    for (let index = 0; index < 5; index += 1) h.chat.emit({ event: 'chunk', data: { nodeId: child, turnId, text: `part ${index}. ` } });
    await until(() => h.view(runId).threads[0].steps[0].now === 'Writing the answer', 'writing line');
    assert.ok(h.hubUpdates - before <= 2, `throttled (${h.hubUpdates - before} commits)`);
    assert.equal(h.view(runId).threads[0].steps[0].excerpt, 'part 0. part 1. part 2. part 3. part 4.');
  });

  test('approvals of the step turn are mirrored on the run and withdrawn when answered elsewhere', async () => {
    const h = harness();
    const runId = await started(h);
    const child = h.record(runId).state.threads.t1.childNodeId!;
    const turnId = h.chat.turnOf('t1', 0)!;
    const request = { requestId: 5, turnId, title: 'Approve Bash?', detail: 'rm -rf build', options: [
      { optionId: 'deny', kind: 'reject_once', name: 'Deny' }, { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
      { optionId: 'always', kind: 'allow_always', name: 'Always' },
    ] };
    h.chat.pending.set(child, { ...request, turnId: 'other-turn' });
    h.chat.emit({ event: 'permission_request', data: { nodeId: child, ...request, turnId: 'other-turn' } });
    h.chat.emit({ event: 'permission_request', data: { nodeId: child, ...request } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.run(runId).approvals, undefined, 'a request of another turn is not mirrored');
    h.chat.pending.set(child, request);
    h.chat.emit({ event: 'permission_request', data: { nodeId: child, ...request } });
    await until(() => (h.run(runId).approvals?.length ?? 0) === 1, 'mirrored');
    const [approval] = h.run(runId).approvals!;
    assert.deepEqual([approval.id, approval.nodeId, approval.title, approval.detail], [`t1:${turnId}:5`, 't1@0', 'Approve Bash?', 'rm -rf build']);
    assert.deepEqual(approval.options.map((option) => [option.optionId, option.name]), [['yes', 'Allow once'], ['deny', 'Deny']]);
    assert.equal(h.view(runId).threads[0].steps[0].status, 'waiting');
    await h.hub.answerApproval(OWNER, runId, approval.id, 'yes');
    assert.deepEqual(h.answers, [[child, null, { requestId: 5, optionId: 'yes' }]]);

    const next = { ...request, requestId: 6 };
    h.chat.pending.set(child, next);
    h.chat.emit({ event: 'permission_request', data: { nodeId: child, ...next } });
    await until(() => h.run(runId).approvals?.[0]?.id === `t1:${turnId}:6`, 'a new request supersedes');
    for (const listener of h.permissionListeners) listener({ nodeId: child, turnId, requestId: 6 });
    await until(() => h.run(runId).approvals === undefined && h.view(runId).threads[0].steps[0].status === 'running', 'withdrawn, running');

    const timedOut = { ...request, requestId: 7 };
    h.chat.pending.set(child, timedOut);
    h.chat.emit({ event: 'permission_request', data: { nodeId: child, ...timedOut } });
    await until(() => (h.run(runId).approvals?.length ?? 0) === 1, 'mirrored again');
    h.chat.emit({ event: 'permission_resolved', data: { nodeId: child, turnId, requestId: 7 } });
    await until(() => h.run(runId).approvals === undefined && h.view(runId).threads[0].steps[0].status === 'running', 'resolved');

    // Two requests of the turn at once: the older one timing out leaves the newer one hosted.
    for (const requestId of [8, 9]) {
      h.chat.pending.set(child, { ...request, requestId });
      h.chat.emit({ event: 'permission_request', data: { nodeId: child, ...request, requestId } });
      await until(() => h.run(runId).approvals?.[0]?.id === `t1:${turnId}:${requestId}`, `request ${requestId} mirrored`);
    }
    h.chat.emit({ event: 'permission_resolved', data: { nodeId: child, turnId, requestId: 8 } });
    for (const listener of h.permissionListeners) listener({ nodeId: child, turnId, requestId: 8 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.run(runId).approvals?.[0]?.id, `t1:${turnId}:9`);
    assert.equal(h.view(runId).threads[0].steps[0].status, 'waiting');
  });

  test('an approval that resolves without the user is a step notice, kept once answered and told to the synthesis', async () => {
    const h = harness();
    const runId = await started(h, { ...TWO_THREADS, reviewRounds: 0 });
    const options = [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Deny' }];
    const ask = (key: string, requestId: number, title: string) => {
      const child = h.record(runId).state.threads[key].childNodeId!;
      const turnId = h.chat.turnOf(key, 0)!;
      const request = { requestId, turnId, title, options };
      h.chat.pending.set(child, request);
      h.chat.emit({ event: 'permission_request', data: { nodeId: child, ...request } });
      return { child, turnId };
    };
    const resolve = ({ child, turnId }: { child: string; turnId: string }, requestId: number) => {
      h.chat.pending.delete(child);
      h.chat.emit({ event: 'permission_resolved', data: { nodeId: child, turnId, requestId } });
    };

    // Codex's timeout: the runtime resolves the request itself.
    const t1 = ask('t1', 3, 'Run: wc -l README.md');
    await until(() => h.view(runId).threads[0].steps[0].status === 'waiting', 't1 waiting');
    resolve(t1, 3);
    await until(() => h.view(runId).threads[0].steps[0].status === 'running', 't1 running');
    assert.equal(h.view(runId).threads[0].steps[0].notice, 'Approval timed out and was denied: Run: wc -l README.md');

    // Answered from the branch pane (the answer service resolves, then publishes): no notice.
    const t2 = ask('t2', 4, 'Approve bash?');
    await until(() => h.view(runId).threads[1].steps[0].status === 'waiting', 't2 waiting');
    resolve(t2, 4);
    for (const listener of h.permissionListeners) listener({ nodeId: t2.child, turnId: t2.turnId, requestId: 4 });
    await until(() => h.view(runId).threads[1].steps[0].status === 'running', 't2 running');
    // ACP echoes the answer later; that is no timeout either.
    resolve(t2, 4);
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(h.view(runId).threads[1].steps[0].notice, undefined);

    h.chat.answer(t1.turnId, 'The command was denied, so I could not count the lines.');
    h.chat.answer(t2.turnId, 'README.md has 12 lines.');
    await until(() => !!h.chat.synthesis(), 'synthesis');
    assert.equal(h.view(runId).threads[0].steps[0].status, 'completed');
    assert.equal(h.view(runId).threads[0].steps[0].notice, 'Approval timed out and was denied: Run: wc -l README.md', 'kept once answered');
    const text = h.chat.turns.get(h.chat.synthesis()!)!.args.text;
    assert.equal(text.match(/Michi note: Approval timed out and was denied/g)?.length, 1);
    assert.match(text, /### Beta · B1 \(Fork\)\nMichi note: Approval timed out and was denied: Run: wc -l README\.md\./);

    // A request cut off by a Stop is no timeout.
    const g = harness();
    const second = await started(g, { ...TWO_THREADS, reviewRounds: 0 });
    const child = g.record(second).state.threads.t1.childNodeId!;
    const turnId = g.chat.turnOf('t1', 0)!;
    g.chat.pending.set(child, { requestId: 1, turnId, title: 'Approve bash?', options });
    g.chat.emit({ event: 'permission_request', data: { nodeId: child, requestId: 1, turnId, title: 'Approve bash?', options } });
    await until(() => g.view(second).threads[0].steps[0].status === 'waiting', 'waiting');
    await g.orchestrator.stopThread(OWNER, second, 't1');
    g.chat.pending.delete(child);
    g.chat.emit({ event: 'permission_resolved', data: { nodeId: child, turnId, requestId: 1 } });
    g.chat.end(turnId, 'cancelled');
    await until(() => g.view(second).threads[0].steps[0].status === 'stopped', 'stopped');
    assert.equal(g.view(second).threads[0].steps[0].notice, undefined);
  });

  test('the caller going away cancels the run; a deleted branch is stopped and left out of the review', async () => {
    const h = harness();
    const runId = await started(h);
    getDb().prepare('UPDATE nodes SET deleted_at = 9 WHERE id = ?').run(h.caller);
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    await until(() => h.view(runId).phase === 'cancelled', 'cancelled');
    assert.equal(h.run(runId).statusDetail, 'The conversation that started this was removed');

    const g = harness();
    const second = await started(g);
    getDb().prepare('UPDATE workspaces SET archived_at = 9 WHERE id = ?').run(g.ws);
    g.chat.answer(g.chat.turnOf('t1', 0), 'B0');
    await until(() => g.view(second).phase === 'cancelled', 'cancelled (archived)');

    const m = harness();
    const third = await started(m);
    getDb().prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)').run(`${m.ws}-moved`, 'Moved');
    getDb().prepare('UPDATE nodes SET workspace_id = ? WHERE id = ?').run(`${m.ws}-moved`, m.caller);
    m.chat.answer(m.chat.turnOf('t1', 0), 'B0');
    await until(() => m.view(third).phase === 'cancelled', 'cancelled (moved)');
    assert.equal(m.run(third).statusDetail, 'The conversation that started this moved to another workspace');

    const d = harness();
    const fourth = await started(d, THREE_THREADS);
    d.chat.answer(d.chat.turnOf('t1', 0), 'B0');
    d.chat.answer(d.chat.turnOf('t2', 0), 'G0');
    await until(() => d.view(fourth).threads[1].steps[0].status === 'completed', 'gamma answered');
    getDb().prepare('UPDATE nodes SET deleted_at = 9 WHERE id = ?').run(d.record(fourth).state.threads.t2.childNodeId);
    d.chat.answer(d.chat.turnOf('t3', 0), 'A0');
    await until(() => !!d.chat.turnOf('t1', 1), 'review began');
    assert.equal(d.view(fourth).threads[1].steps[1].status, 'stopped');
    assert.equal(d.view(fourth).threads[1].steps[1].error, 'Branch was deleted');
    assert.equal(d.chat.turnOf('t2', 1), undefined);
    assert.doesNotMatch(d.chat.turns.get(d.chat.turnOf('t1', 1)!)!.args.text, /G0/);
  });

  test('a deleted branch is published on its row, also when it goes after the run ended, and Retry of its review is refused', async () => {
    const d = harness();
    const runId = await started(d, THREE_THREADS);
    d.chat.answer(d.chat.turnOf('t1', 0), 'B0');
    d.chat.answer(d.chat.turnOf('t2', 0), 'G0');
    await until(() => d.view(runId).threads[1].steps[0].status === 'completed', 'gamma answered');
    getDb().prepare('UPDATE nodes SET deleted_at = 9 WHERE id = ?').run(d.record(runId).state.threads.t2.childNodeId);
    d.chat.answer(d.chat.turnOf('t3', 0), 'A0');
    await until(() => !!d.chat.turnOf('t1', 1), 'review began');
    assert.deepEqual(d.view(runId).threads.map((thread) => thread.branchGone), [undefined, true, undefined]);
    await rejectsWith(d.orchestrator.retryThread(OWNER, runId, 't2'), 'thread_not_retryable', /deleted/);

    const h = harness();
    const ended = await started(h, { ...TWO_THREADS, reviewRounds: 0 });
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.end(h.chat.turnOf('t2', 0), 'error', 'quota');
    await until(() => !!h.chat.synthesis(), 'synthesis');
    h.chat.answer(h.chat.synthesis(), 'Synthesis.');
    await until(() => h.view(ended).phase === 'completed' && !h.view(ended).settling, 'completed');
    const child = h.record(ended).state.threads.t2.childNodeId!;
    const changed = (op: 'deleted' | 'restored') => h.orchestrator.structureChanged({
      epoch: 'e', seq: 1, changes: [{ entity: 'node', op, workspaceId: h.ws, nodeId: child }],
    });
    getDb().prepare('UPDATE nodes SET deleted_at = 9 WHERE id = ?').run(child);
    changed('deleted');
    await until(() => h.view(ended).threads[1].branchGone === true, 'published after the run ended');
    getDb().prepare('UPDATE nodes SET deleted_at = NULL WHERE id = ?').run(child);
    changed('restored');
    await until(() => h.view(ended).threads[1].branchGone === undefined, 'restored');
  });

  test('a deleted branch: its open turn still settles after Replace, and Retry runs it on a new branch', async () => {
    const h = harness();
    const runId = await started(h, { ...TWO_THREADS, reviewRounds: 0 });
    const oldChild = h.record(runId).state.threads.t2.childNodeId!;
    const oldTurn = h.chat.turnOf('t2', 0)!;
    getDb().prepare('UPDATE nodes SET deleted_at = 9 WHERE id = ?').run(oldChild);
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    await until(() => h.view(runId).threads[1].steps[0].error === 'Branch was deleted', 'stopped as deleted');
    await h.orchestrator.replaceThread(OWNER, runId, 't2', { runtimeId: 'alpha', modelId: 'a2' });
    await until(() => h.chat.began.some((id) => id.endsWith('-t2-g1-s0-a1')), 'the replacement began');
    h.chat.end(oldTurn, 'cancelled');
    await until(() => store.turn(oldTurn)?.outcome !== null, 'the old turn settled');
    assert.ok(!store.openTurns(runId).some((turn) => turn.turnId === oldTurn));
    assert.equal(h.view(runId).threads[1].steps[0].status, 'running', 'the old outcome leaves the new branch alone');

    const g = harness();
    const second = await started(g, { ...TWO_THREADS, reviewRounds: 0 });
    const deleted = g.record(second).state.threads.t2.childNodeId!;
    getDb().prepare('UPDATE nodes SET deleted_at = 9 WHERE id = ?').run(deleted);
    g.chat.answer(g.chat.turnOf('t1', 0), 'B0');
    await until(() => g.view(second).threads[1].steps[0].error === 'Branch was deleted', 'stopped as deleted');
    const deletedTurn = g.chat.turnOf('t2', 0)!;
    g.chat.end(deletedTurn, 'cancelled');
    await until(() => store.turn(deletedTurn)?.outcome !== null, 'settled');
    await g.orchestrator.retryThread(OWNER, second, 't2');
    await until(() => g.chat.began.some((id) => id.endsWith('-t2-g1-s0-a2')), 'the retry began on a new branch');
    const thread = g.record(second).state.threads.t2;
    assert.deepEqual(thread.previousChildNodeIds, [deleted]);
    assert.notEqual(thread.childNodeId, deleted);
    assert.equal(g.created.filter((input) => input.choice.runtimeId === 'gamma').length, 2);
    assert.equal(g.view(second).threads[1].steps[0].status, 'running');
  });

  test('relaunching a kept branch does not hold the open queue while its turn waits', async () => {
    const h = harness();
    const create = h.orchestrator['deps'].createChild;
    let kept = false;
    h.orchestrator['deps'].createChild = async (input) => {
      const child = await create(input);
      if (input.choice.runtimeId !== 'beta' || kept) return child;
      kept = true;
      throw new Error('the session was bound before the open failed');
    };
    const runId = await h.propose();
    await h.orchestrator.startRun(OWNER, runId);
    await until(() => h.view(runId).threads[0].steps[0].status === 'failed' && h.chat.began.length === 1, 'beta failed, gamma began');
    const keptChild = h.record(runId).state.threads.t1.childNodeId!;
    assert.ok(keptChild, 'the node is kept for Retry');
    h.chat.end(h.chat.turnOf('t2', 0), 'error', 'quota');
    await until(() => h.view(runId).threads[1].steps[0].status === 'failed', 'gamma failed');
    // The user runs a turn in the kept branch: the retry waits behind it.
    h.chat.gates.set(keptChild, new Promise<void>(() => {}));
    await h.orchestrator.retryThread(OWNER, runId, 't1');
    await h.orchestrator.replaceThread(OWNER, runId, 't2', { runtimeId: 'alpha', modelId: 'a2' });
    await until(() => h.chat.began.some((id) => id.endsWith('-t2-g1-s0-a1')), 'the replacement was created and began');
    assert.equal(h.created.filter((input) => input.choice.runtimeId === 'beta').length, 1, 'the kept branch was reused');
    assert.equal(h.view(runId).threads[0].steps[0].status, 'queued');
  });

  test('reviews begin independently: a busy branch delays only its own', async () => {
    const h = harness();
    const runId = await started(h);
    h.chat.gates.set(h.record(runId).state.threads.t1.childNodeId!, new Promise<void>(() => {}));
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.answer(h.chat.turnOf('t2', 0), 'G0');
    await until(() => !!h.chat.turnOf('t2', 1), "gamma's review began");
    assert.equal(h.chat.turnOf('t1', 1), undefined);
  });

  test('a row replaced after the run finished: its review is skipped, so the finished run shows no queued step', async () => {
    const h = harness();
    const runId = await started(h, THREE_THREADS);
    h.chat.end(h.chat.turnOf('t3', 0), 'error', 'quota');
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.answer(h.chat.turnOf('t2', 0), 'G0');
    await until(() => !!h.chat.turnOf('t1', 1) && !!h.chat.turnOf('t2', 1), 'reviews began');
    h.chat.answer(h.chat.turnOf('t1', 1), 'B1');
    h.chat.answer(h.chat.turnOf('t2', 1), 'G1');
    await until(() => !!h.chat.synthesis(), 'synthesis');
    h.chat.answer(h.chat.synthesis(), 'Synthesis.');
    await until(() => h.view(runId).phase === 'completed', 'completed');
    await h.orchestrator.replaceThread(OWNER, runId, 't3', { runtimeId: 'alpha', modelId: 'a1' });
    await until(() => h.chat.began.some((id) => id.endsWith('-t3-g1-s0-a1')), 'the replacement began');
    h.chat.answer(h.chat.began.find((id) => id.endsWith('-t3-g1-s0-a1')), 'A late');
    await until(() => !!h.chat.addendum(1), 'addendum began');
    h.chat.answer(h.chat.addendum(1), 'Addendum.');
    await until(() => h.view(runId).phase === 'completed', 'completed again');
    assert.deepEqual(h.view(runId).threads[2].steps.map((step) => step.status), ['completed', 'skipped']);
    assert.deepEqual(h.run(runId).nodes.filter((node) => node.status === 'queued').map((node) => node.id), []);
  });

  test('row Retry and Replace wait out Stop all and refuse while another run of the caller runs', async () => {
    const h = harness();
    const runId = await started(h, { ...TWO_THREADS, reviewRounds: 0 });
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.end(h.chat.turnOf('t2', 0), 'error', 'quota');
    await until(() => !!h.chat.synthesis(), 'synthesis');
    await h.orchestrator.stopAll(OWNER, runId);
    await rejectsWith(h.orchestrator.retryThread(OWNER, runId, 't2'), 'thread_busy', /Still stopping/);
    await rejectsWith(h.orchestrator.replaceThread(OWNER, runId, 't2', { runtimeId: 'alpha', modelId: 'a2' }), 'thread_busy', /Still stopping/);
    h.chat.end(h.chat.synthesis(), 'cancelled');
    await until(() => !h.view(runId).settling, 'settled');
    assert.equal(h.run(runId).statusDetail, 'Stopped');

    const other = await h.propose();
    await h.orchestrator.startRun(OWNER, other);
    await rejectsWith(h.orchestrator.retryThread(OWNER, runId, 't2'), 'already_running');
    await rejectsWith(h.orchestrator.replaceThread(OWNER, runId, 't2', { runtimeId: 'alpha', modelId: 'a2' }), 'already_running');
    assert.equal(h.record(runId).status, 'cancelled');
  });

  test('Retry of a branch that was deleted and purged runs it on a new branch, with a new generation', async () => {
    const h = harness();
    const runId = await started(h, { ...TWO_THREADS, reviewRounds: 0 });
    const purged = h.record(runId).state.threads.t2.childNodeId!;
    h.chat.end(h.chat.turnOf('t2', 0), 'error', 'quota');
    await until(() => h.view(runId).threads[1].steps[0].status === 'failed', 'gamma failed');
    getDb().prepare('UPDATE nodes SET deleted_at = 9, purged_at = 9 WHERE id = ?').run(purged);
    await h.orchestrator.retryThread(OWNER, runId, 't2');
    await until(() => h.chat.began.some((id) => id.endsWith('-t2-g1-s0-a2')), 'the retry began on a new branch');
    const thread = h.record(runId).state.threads.t2;
    assert.deepEqual(thread.previousChildNodeIds, [purged]);
    assert.notEqual(thread.childNodeId, purged);
    assert.equal(thread.generation, 1);
  });

  test('shutdown: branch turns killed as backend_restarted leave the run running; recovery interrupts it and Retry keeps the reviews', async () => {
    const workflowStore = memoryWorkflowStore();
    const h = harness({ workflowStore });
    const runId = await started(h);
    h.chat.shuttingDown = true;
    h.chat.end(h.chat.turnOf('t1', 0), 'error', 'backend_restarted');
    h.chat.end(h.chat.turnOf('t2', 0), 'error', 'backend_restarted');
    await until(() => h.record(runId).state.threads.t2.steps[0].status === 'interrupted'
      && h.record(runId).state.threads.t1.steps[0].status === 'interrupted', 'both interrupted');
    assert.equal(h.record(runId).status, 'running', 'no answer is not a failure while shutting down');
    assert.deepEqual(Object.values(h.record(runId).state.threads).map((thread) => thread.steps[1].status), ['pending', 'pending']);

    const g = harness({ workflowStore });
    const second = await started(g);
    g.chat.answer(g.chat.turnOf('t1', 0), 'B0');
    await until(() => g.record(second).state.threads.t1.steps[0].status === 'completed', 'beta answered');
    g.chat.shuttingDown = true;
    g.chat.end(g.chat.turnOf('t2', 0), 'error', 'backend_restarted');
    await until(() => g.record(second).state.threads.t2.steps[0].status === 'interrupted', 'gamma interrupted');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(g.record(second).state.synthesis.status, 'pending', 'no synthesis is queued during shutdown');
    assert.equal(g.record(second).state.threads.t1.steps[1].status, 'pending', 'the review is not skipped');
    assert.equal(g.chat.synthesis(), undefined);

    const restarted = harness({ seed: h, workflowStore });
    assert.equal(restarted.record(runId).status, 'interrupted');
    assert.equal(restarted.record(second).status, 'interrupted');
    await restarted.orchestrator.retryRun(OWNER, runId);
    await until(() => !!restarted.chat.turnOf('t1', 0, 2) && !!restarted.chat.turnOf('t2', 0, 2), 'the answers re-ran');
    restarted.chat.answer(restarted.chat.turnOf('t1', 0, 2), 'B0');
    restarted.chat.answer(restarted.chat.turnOf('t2', 0, 2), 'G0');
    await until(() => !!restarted.chat.turnOf('t1', 1) && !!restarted.chat.turnOf('t2', 1), 'the reviews began');
  });

  test('shutdown: turns the runtimes finalize completed or cancelled while shutting down are interrupted; Retry re-runs them', async () => {
    const workflowStore = memoryWorkflowStore();
    const h = harness({ workflowStore });
    const runId = await started(h, { ...TWO_THREADS, reviewRounds: 0 });
    const cut = h.chat.turnOf('t1', 0)!;
    const killed = h.chat.turnOf('t2', 0)!;
    // A branch pane's Stop just before: shutdown's cancel is still not the user's stop.
    h.chat.cancel(h.record(runId).state.threads.t2.childNodeId!, killed);
    h.chat.shuttingDown = true;
    h.chat.answer(cut, 'I will write ten scenes.');
    h.chat.end(killed, 'cancelled');
    await until(() => Object.values(h.record(runId).state.threads).every((thread) => thread.steps[0].status === 'interrupted'), 'both interrupted');
    assert.equal(h.record(runId).state.threads.t1.steps[0].summary, null, 'the preamble is not an answer');
    assert.deepEqual([store.turn(cut)?.outcome, store.turn(killed)?.outcome], ['interrupted', 'interrupted']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.record(runId).status, 'running', 'not failed for want of an answer');
    assert.equal(h.chat.synthesis(), undefined);

    // A synthesis cut off and finalized completed, and an addendum cancelled at shutdown.
    const g = harness({ workflowStore });
    const second = await started(g, { ...TWO_THREADS, reviewRounds: 0 });
    g.chat.answer(g.chat.turnOf('t1', 0), 'B0');
    g.chat.end(g.chat.turnOf('t2', 0), 'error', 'quota');
    await until(() => !!g.chat.synthesis(), 'synthesis');
    g.chat.shuttingDown = true;
    g.chat.answer(g.chat.synthesis(), 'Here is my plan for the');
    await until(() => g.record(second).state.synthesis.status === 'interrupted', 'synthesis interrupted');
    assert.equal(g.record(second).status, 'running');

    const a = harness({ workflowStore });
    const third = await started(a, { ...TWO_THREADS, reviewRounds: 0 });
    a.chat.answer(a.chat.turnOf('t1', 0), 'B0');
    a.chat.end(a.chat.turnOf('t2', 0), 'error', 'quota');
    await until(() => !!a.chat.synthesis(), 'synthesis');
    a.chat.answer(a.chat.synthesis(), 'Synthesis.');
    await until(() => a.view(third).phase === 'completed', 'completed');
    await a.orchestrator.retryThread(OWNER, third, 't2');
    await until(() => !!a.chat.turnOf('t2', 0, 2), 'the late retry began');
    a.chat.answer(a.chat.turnOf('t2', 0, 2), 'G late');
    await until(() => !!a.chat.addendum(1), 'addendum');
    a.chat.shuttingDown = true;
    a.chat.end(a.chat.addendum(1), 'cancelled');
    await until(() => a.record(third).state.addenda[0]?.status === 'interrupted', 'addendum interrupted');
    assert.equal(a.record(third).status, 'running');

    const restarted = harness({ seed: h, workflowStore });
    for (const id of [runId, second, third]) {
      assert.equal(restarted.record(id).status, 'interrupted', id);
      assert.equal(restarted.run(id).statusDetail, 'Interrupted: Michi restarted while this ran. Retry continues it.');
    }
    await restarted.orchestrator.retryRun(OWNER, runId);
    await until(() => !!restarted.chat.turnOf('t1', 0, 2) && !!restarted.chat.turnOf('t2', 0, 2), 'both answers re-ran');
    await restarted.orchestrator.retryRun(OWNER, second);
    // Run Retry re-runs the failed answer too; the synthesis follows it.
    await until(() => restarted.chat.began.some((id) => id.startsWith(`mm-${g.record(second).nativeId.slice(3)}-t2-`) && id.endsWith('-s0-a2')), 'the failed answer re-ran');
    restarted.chat.answer(restarted.chat.began.find((id) => id.startsWith(`mm-${g.record(second).nativeId.slice(3)}-t2-`)), 'G0');
    await until(() => !!restarted.chat.synthesis(2), 'the synthesis re-ran');
  });

  test('shutdown: a withdrawn synthesis is interrupted and restart recovery interrupts the run', async () => {
    const workflowStore = memoryWorkflowStore();
    const h = harness({ workflowStore });
    const runId = await started(h);
    h.chat.gates.set(h.caller, new Promise<void>((resolve) => setTimeout(resolve, 30)));
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.answer(h.chat.turnOf('t2', 0), 'G0');
    await until(() => h.chat.turnOf('t1', 1) !== undefined && h.chat.turnOf('t2', 1) !== undefined, 'reviews');
    h.chat.answer(h.chat.turnOf('t1', 1), 'B1');
    h.chat.answer(h.chat.turnOf('t2', 1), 'G1');
    await until(() => h.record(runId).state.synthesis.status === 'queued', 'synthesis queued');
    h.chat.shuttingDown = true;
    await until(() => h.record(runId).state.synthesis.status === 'interrupted', 'interrupted');
    assert.equal(h.record(runId).status, 'running');

    const restarted = harness({ seed: h, workflowStore });
    assert.equal(restarted.record(runId).status, 'interrupted');
    assert.equal(restarted.run(runId).statusDetail, 'Interrupted: Michi restarted while this ran. Retry continues it.');
    assert.equal(restarted.chat.began.length, 0, 'recovery starts nothing');
  });

  test('recovery: a proposed plan is re-attached; a running run settles its receipts and is interrupted', async () => {
    // The real store: hub.recover() writes the proposal back as cancelled, and both round-trip through run_json.
    const workflowStore = new SqliteWorkflowRunStore();
    const h = harness({ workflowStore });
    const proposed = await h.propose();
    const other = harness({ workflowStore });
    const runId = await started(other);
    other.chat.answer(other.chat.turnOf('t1', 0), 'B0');
    await until(() => other.view(runId).threads[0].steps[0].status === 'completed', 'beta answered');
    // Gamma's answer completed but the crash came before the settle.
    const gammaTurn = other.chat.turnOf('t2', 0)!;
    insertMessage(other.record(runId).state.threads.t2.childNodeId!, replyId(other.record(runId).state.threads.t2.childNodeId!, gammaTurn), 'assistant', 'G0');

    const chat = new FakeChat();
    chat.turns.set(gammaTurn, { args: {} as StartRequestedSelfTurnArgs, status: 'completed', finish: () => {} });
    const restarted = harness({ seed: h, workflowStore, chat });
    const reattached = restarted.run(proposed);
    assert.equal(reattached.status, 'paused');
    assert.equal(reattached.statusDetail, undefined);
    assert.equal(reattached.endedAt, undefined);
    assert.deepEqual([...reattached.actions].sort(), ['resume', 'stop']);
    assert.equal(reattached.runtime, 'michi');
    assert.equal(reattached.multiModel?.phase, 'proposed');
    assert.deepEqual(workflowStore.get(OWNER, proposed)?.multiModel, reattached.multiModel, 'the view round-trips through the store');
    const recovered = restarted.record(runId);
    assert.equal(recovered.state.threads.t2.steps[0].status, 'completed');
    assert.equal(recovered.state.threads.t2.steps[0].summary, 'G0');
    assert.equal(recovered.status, 'interrupted', 'the review never started');
    assert.equal(chat.began.length, 0);

    await restarted.orchestrator.retryRun(OWNER, runId);
    await until(() => !!chat.turnOf('t1', 1) && !!chat.turnOf('t2', 1), 'retry resumed with the reviews');
    await rejectsWith(restarted.orchestrator.retryRun(OWNER, (await restarted.orchestrator.cancelProposal(OWNER, proposed)).id), 'not_running');
  });

  test('recovery: a completed synthesis receipt finishes the run completed', async () => {
    const workflowStore = memoryWorkflowStore();
    const h = harness({ workflowStore });
    const runId = await started(h);
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    h.chat.answer(h.chat.turnOf('t2', 0), 'G0');
    await until(() => !!h.chat.turnOf('t1', 1) && !!h.chat.turnOf('t2', 1), 'reviews');
    h.chat.answer(h.chat.turnOf('t1', 1), 'B1');
    h.chat.answer(h.chat.turnOf('t2', 1), 'G1');
    await until(() => !!h.chat.synthesis(), 'synthesis');
    const synthesis = h.chat.synthesis()!;
    insertMessage(h.caller, replyId(h.caller, synthesis), 'assistant', 'Final synthesis.');
    const chat = new FakeChat();
    chat.turns.set(synthesis, { args: {} as StartRequestedSelfTurnArgs, status: 'completed', finish: () => {} });
    const restarted = harness({ seed: h, workflowStore, chat });
    assert.equal(restarted.record(runId).status, 'completed');
    assert.equal(restarted.run(runId).result, 'Final synthesis.');
  });

  test('recovery: a branch created without a recorded turn is rolled back, and Retry creates one child', async () => {
    const workflowStore = memoryWorkflowStore();
    const h = harness({ workflowStore });
    const runId = await h.propose();
    // A crash right after the child was created: the node exists, no turn was recorded.
    h.orchestrator['launchChild'] = async () => {};
    await h.orchestrator.startRun(OWNER, runId);
    const record = h.record(runId);
    record.state.threads.t1.childNodeId = 'n-orphan';
    assert.ok(store.saveRun(record, record.revision, 5));
    getDb().prepare(`INSERT INTO nodes (id, workspace_id, tree_id, parent_node_id, kind, title, spawned_by_agent, created_at)
      VALUES ('n-orphan', ?, ?, ?, 'chat', 'Beta · B1', 1, 2), ('n-stray', ?, ?, ?, 'chat', 'Gamma · Default model', 1, 2)`)
      .run(h.ws, h.tree, h.caller, h.ws, h.tree, h.caller);
    getDb().prepare("UPDATE nodes SET acp_session_id = 'bound' WHERE id = 'n-stray'").run();
    store.markChild('n-orphan', runId, false);
    store.markChild('n-stray', runId, true);

    const restarted = harness({ seed: h, workflowStore });
    const recovered = restarted.record(runId);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.state.threads.t1.childNodeId, null);
    assert.equal(getDb().prepare("SELECT 1 FROM nodes WHERE id = 'n-orphan'").get(), undefined, 'rolled back');
    assert.deepEqual(recovered.state.threads.t2.previousChildNodeIds, ['n-stray'], 'a bound stray is kept on its row');
    await restarted.orchestrator.retryRun(OWNER, runId);
    await until(() => restarted.chat.began.length === 2, 'both rows relaunched');
    assert.equal(restarted.created.length, 2);
  });

  test('stopThread and retryThread refuse illegal states', async () => {
    const h = harness();
    const runId = await started(h);
    await rejectsWith(h.orchestrator.retryThread(OWNER, runId, 't1'), 'thread_busy');
    h.chat.answer(h.chat.turnOf('t1', 0), 'B0');
    await until(() => h.view(runId).threads[0].steps[0].status === 'completed', 'answered');
    await rejectsWith(h.orchestrator.stopThread(OWNER, runId, 't1'), 'not_running');
    await rejectsWith(h.orchestrator.retryThread(OWNER, runId, 't1'), 'thread_not_retryable');
    await rejectsWith(h.orchestrator.stopThread(OWNER, runId, 't9'), 'not_found');
  });
});
