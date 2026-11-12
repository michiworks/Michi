import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRunStatus,
  applyTurnEvent,
  createDurableTurn,
  encodePaneId,
  type AgentRunDtoV1,
  type AgentRunWatchDtoV1,
  type ChatStreamEvent,
  type PaneTarget,
  type WatchConditionV1,
  type WorkflowRunDtoV1,
} from 'michi-shared';
import { createClaudeWorkflowTap } from 'michi-runtime/internal/core/workflows/claudeWorkflowTap';
import { closeDb, getDb, initDb } from '../src/services/db';
import { beginTurn, finalizeTurn } from '../src/services/dbRepository';
import { applyWorkspaceCommands } from '../src/services/domainCommands';
import { AttentionFeed } from '../src/services/attention/attentionFeed';
import { AttentionRepository } from '../src/services/attention/attentionRepository';
import {
  AttentionService,
  DESKTOP_NOTIFIER_WINDOW_ID,
  type AttentionClock,
  type AttentionPresence,
} from '../src/services/attention/attentionService';
import { subscribeNodeCompletionSeen } from '../src/services/attentionSignals';
import { AgentRunWatchCoordinator } from '../src/agents/runs/agentRunWatchCoordinator';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { WorkflowRunHub } from '../src/services/workflowRunHub';
import type { WorkflowRunStore } from '../src/services/workflowRunsRepository';
import { workflowSink } from './helpers/hostSinks';
import { chatOwner } from './helpers/owners';

// The attention decision matrix: delay and revalidation, presence
// suppression, one active record per key, resolution, claims, owner scoping,
// expiry, restart reconciliation and the Agent Run notifier.

const LOCAL = 'local-user';
let dir: string;
let previousData: string | undefined;
let previousCloud: string | undefined;

interface Timer { at: number; fn: () => void; every?: number }

function manualClock(start = 1_000_000): AttentionClock & { advance(ms: number): void } {
  let now = start;
  let next = 0;
  const timers = new Map<number, Timer>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { timers.set(++next, { at: now + ms, fn }); return next; },
    clearTimeout: (handle) => { timers.delete(handle as number); },
    setInterval: (fn, ms) => { timers.set(++next, { at: now + ms, fn, every: ms }); return next; },
    clearInterval: (handle) => { timers.delete(handle as number); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every) timer.at += timer.every; else timers.delete(id);
        timer.fn();
      }
      now = target;
    },
  };
}

interface Frame { event: string; data: any }

function collect(feed: AttentionFeed, owner: string): { frames: Frame[]; stop(): void; of(event: string): any[] } {
  const frames: Frame[] = [];
  const stop = feed.subscribe(owner, {
    send(frame) {
      const [eventLine, dataLine] = frame.trimEnd().split('\n');
      frames.push({ event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) });
    },
  });
  return { frames, stop, of: (event) => frames.filter((frame) => frame.event === event).map((frame) => frame.data) };
}

function visibility() {
  const shown = new Set<string>();
  return {
    shown,
    show: (owner: string, target: PaneTarget) => shown.add(`${owner}|${encodePaneId(target)}`),
    hide: (owner: string, target: PaneTarget) => shown.delete(`${owner}|${encodePaneId(target)}`),
    presence: { isTargetVisibleInFocusedWindow: (owner: string, target: PaneTarget) => shown.has(`${owner}|${encodePaneId(target)}`) },
  };
}

function ev(name: ChatStreamEvent['event'], data: Record<string, unknown>): ChatStreamEvent {
  return { event: name, data } as ChatStreamEvent;
}

let turnSeq = 0;
/** Persists a turn that completed with an answer, as ChatHub would before broadcasting `done`. */
function completeTurn(nodeId: string, workspaceId: string, turnId: string, userMetadata?: Record<string, unknown>): void {
  let snapshot = createDurableTurn({
    turnId, assistantId: `a-${turnId}-${++turnSeq}`, nodeId, workspaceId, displayUserText: 'Go', startedAt: 1,
    ...(userMetadata ? { userMetadata } : {}),
  });
  beginTurn(snapshot);
  snapshot = applyTurnEvent(snapshot, ev('chunk', { seq: 1, text: 'All done.' }));
  snapshot = applyTurnEvent(snapshot, ev('done', { seq: 2, stopReason: 'end_turn', completedAt: 5 }));
  finalizeTurn(snapshot);
}

const turnStart = (nodeId: string, turnId: string) => ev('turn_start', { nodeId, chatId: nodeId, turnId, assistantId: `a-${turnId}`, userText: 'Go' });
const done = (nodeId: string, turnId: string, stopReason = 'end_turn') => ev('done', { nodeId, chatId: nodeId, turnId, stopReason, persisted: true });
const permission = (nodeId: string, turnId: string, requestId: number) =>
  ev('permission_request', { nodeId, chatId: nodeId, turnId, requestId, title: 'Run npm test', options: [] });
const question = (nodeId: string, turnId: string, requestId: number) =>
  ev('user_input_request', { nodeId, chatId: nodeId, turnId, requestId, questions: [{ id: 'q', question: 'Which branch?', options: [] }] });

function setup(options: {
  presence?: ReturnType<typeof visibility>;
  /** Replaces the visibility helper's presence. */
  presenceStub?: AttentionPresence;
  getRun?: (owner: string, id: string) => AgentRunDtoV1 | null;
  repository?: AttentionRepository;
  isHandOffTurn?: (turnId: string) => boolean;
  assistantName?: () => string;
} = {}) {
  const clock = manualClock();
  const feed = new AttentionFeed();
  const shown = options.presence ?? visibility();
  const errors: unknown[] = [];
  const service = new AttentionService({
    presence: options.presenceStub ?? shown.presence, feed, clock, getRun: options.getRun, repository: options.repository,
    isHandOffTurn: options.isHandOffTurn, assistantName: options.assistantName, onError: (_message, error) => errors.push(error),
  });
  service.start();
  return { clock, feed, shown, service, errors };
}

function records() {
  return (getDb().prepare('SELECT id, key, fact, kind, reason, status, resolve_reason, owner_user_id FROM attention_notifications ORDER BY created_at, rowid')
    .all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
}

/** Who holds each record's claim, oldest first. */
function claimants() {
  return (getDb().prepare('SELECT fact, claimed_by_window_id AS claimant FROM attention_notifications ORDER BY created_at, rowid')
    .all() as Array<{ fact: string; claimant: string | null }>).map((row) => [row.fact, row.claimant]);
}

beforeEach(() => {
  previousData = process.env.MICHI_DATA_DIR;
  previousCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-attention-service-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  const workspace = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  workspace.run('ws-a', 'Alice', 'alice');
  workspace.run('ws-b', 'Bob', 'bob');
  const node = getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,title,created_at) VALUES (?,?,'chat','idle',?,1)");
  node.run('n-1', 'ws-a', 'Fix the build');
  node.run('n-2', 'ws-a', null);
  node.run('n-b', 'ws-b', 'Bob thread');
});

afterEach(() => {
  closeDb();
  if (previousData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousData;
  if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deciding', () => {
  test('a completion becomes a record only after the delay, and every window hears it', () => {
    const { clock, feed, service } = setup();
    const window = collect(feed, LOCAL);
    assert.deepEqual(window.of('attention_snapshot'), [{ protocol: 'v1', notifications: [] }]);
    service.observeChatEvent(turnStart('n-1', 't1'));
    completeTurn('n-1', 'ws-a', 't1');
    service.observeChatEvent(done('n-1', 't1'));
    clock.advance(999);
    assert.equal(records().length, 0, 'nothing before the decision delay');
    clock.advance(1);
    assert.deepEqual(records().map((row) => [row.key, row.fact, row.kind, row.reason, row.status]),
      [['node:n-1', 'completion:1', 'finished', 'completed', 'active']]);
    const [notification] = window.of('attention_notification');
    assert.equal(notification.title, 'Fix the build');
    assert.deepEqual(notification.target, { type: 'node', nodeId: 'n-1', workspaceId: 'ws-a' });
    assert.equal(notification.claimedByWindowId, null);
    const late = collect(feed, LOCAL);
    assert.deepEqual(late.of('attention_snapshot')[0].notifications.map((item: { id: string }) => item.id), [notification.id],
      'a window that connects later gets it in its snapshot');
  });

  test("a renamed thread's root is announced by the thread's name; a branch keeps its own title", () => {
    getDb().prepare("INSERT INTO trees(id,workspace_id,root_node_id,name,last_active_at,created_at) VALUES ('t-1','ws-a','n-1','Memory workflow',1,1)").run();
    getDb().prepare("UPDATE nodes SET tree_id = 't-1', title = CASE id WHEN 'n-2' THEN 'A branch' ELSE title END WHERE id IN ('n-1','n-2')").run();
    const { clock, feed, service } = setup();
    const window = collect(feed, LOCAL);
    for (const [nodeId, turnId] of [['n-1', 't1'], ['n-2', 't2']]) {
      service.observeChatEvent(turnStart(nodeId, turnId));
      completeTurn(nodeId, 'ws-a', turnId);
      service.observeChatEvent(done(nodeId, turnId));
    }
    clock.advance(1_000);
    assert.deepEqual(window.of('attention_notification').map((item: { target: { nodeId: string }; title: string }) => [item.target.nodeId, item.title]),
      [['n-1', 'Memory workflow'], ['n-2', 'A branch']]);
  });

  test('an untitled conversation is announced by its first message, as the sidebar names it', () => {
    const { clock, feed, service } = setup();
    const window = collect(feed, LOCAL);
    let snapshot = createDurableTurn({ turnId: 't1', assistantId: 'a-t1', nodeId: 'n-2', workspaceId: 'ws-a', displayUserText: '/btw   background\nwork', startedAt: 1 });
    beginTurn(snapshot);
    snapshot = applyTurnEvent(snapshot, ev('chunk', { seq: 1, text: 'All done.' }));
    finalizeTurn(applyTurnEvent(snapshot, ev('done', { seq: 2, stopReason: 'end_turn', completedAt: 5 })));
    service.observeChatEvent(turnStart('n-2', 't1'));
    service.observeChatEvent(done('n-2', 't1'));
    clock.advance(1_000);
    service.observeChatEvent(turnStart('n-2', 't2'));
    service.observeChatEvent(ev('error', { nodeId: 'n-2', chatId: 'n-2', turnId: 't2', message: 'Model unavailable', code: 'generic' }));
    clock.advance(1_000);
    assert.deepEqual(window.of('attention_notification').map((item: { kind: string; title: string }) => [item.kind, item.title]),
      [['finished', 'background work'], ['failed', 'background work']]);
  });

  test("a multi-model branch's answer notifies nobody; its approvals and failures still do", () => {
    const { clock, service } = setup({ isHandOffTurn: (turnId) => turnId.startsWith('mm-') });
    service.observeChatEvent(turnStart('n-1', 'mm-run-t1-g0-s0-a1'));
    completeTurn('n-1', 'ws-a', 'mm-run-t1-g0-s0-a1');
    service.observeChatEvent(done('n-1', 'mm-run-t1-g0-s0-a1'));
    clock.advance(1_000);
    assert.equal(records().length, 0);
    service.observeChatEvent(turnStart('n-2', 'mm-run-t2-g0-s0-a1'));
    service.observeChatEvent(permission('n-2', 'mm-run-t2-g0-s0-a1', 3));
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => [row.key, row.kind]), [['node:n-2', 'needs_input']]);
    service.observeChatEvent(turnStart('n-1', 'mm-run-t1-g0-s1-a1'));
    service.observeChatEvent(done('n-1', 'mm-run-t1-g0-s1-a1', 'error'));
    clock.advance(1_000);
    assert.equal(records().at(-1)?.key, 'node:n-1', 'the failure is reported');
  });

  test("a multi-model synthesis, labelled as a message from its own caller, notifies as the caller's completion", () => {
    const { clock, service } = setup({ isHandOffTurn: (turnId) => /-s\d+-a\d+$/.test(turnId) });
    const userMetadata = { threadMessage: { fromNodeId: 'n-1', fromTitle: 'Fix the build', hop: 2, plan: { runId: 'mm_x', step: 'synthesis', branches: 2 } } };
    service.observeChatEvent(ev('turn_start', { nodeId: 'n-1', chatId: 'n-1', turnId: 'mm-x-syn-a1', assistantId: 'a-syn', userText: 'Results', userMetadata }));
    completeTurn('n-1', 'ws-a', 'mm-x-syn-a1', userMetadata);
    service.observeChatEvent(done('n-1', 'mm-x-syn-a1'));
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => [row.key, row.kind]), [['node:n-1', 'finished']]);
  });

  test('a focused window showing the target suppresses it; a background slot or an unfocused window does not', () => {
    const { clock, shown, service } = setup();
    shown.show(LOCAL, { kind: 'node', nodeId: 'n-1' });
    completeTurn('n-1', 'ws-a', 't1');
    service.observeChatEvent(done('n-1', 't1'));
    clock.advance(1_000);
    assert.equal(records().length, 0, 'the user is looking at it');
    shown.hide(LOCAL, { kind: 'node', nodeId: 'n-1' });
    shown.show(LOCAL, { kind: 'node', nodeId: 'n-2' });
    completeTurn('n-1', 'ws-a', 't2');
    service.observeChatEvent(turnStart('n-1', 't2'));
    service.observeChatEvent(done('n-1', 't2'));
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => row.fact), ['completion:2'], 'another target on screen does not hide this one');
  });

  test('a fact that goes stale within the delay is dropped', () => {
    const { clock, service } = setup();
    service.observeChatEvent(permission('n-1', 't1', 7));
    service.observeChatEvent(ev('permission_resolved', { nodeId: 'n-1', chatId: 'n-1', turnId: 't1', requestId: 7 }));
    clock.advance(1_000);
    completeTurn('n-1', 'ws-a', 't2');
    service.observeChatEvent(turnStart('n-1', 't2'));
    service.observeChatEvent(done('n-1', 't2'));
    applyWorkspaceCommands('ws-a', { operationId: 'seen', commands: [{ type: 'node.patch', payload: { id: 'n-1', viewed_at: 9, seen_completion_seq: 1 } }] });
    clock.advance(1_000);
    service.observeChatEvent(question('n-2', 't3', 1));
    service.observeChatEvent(turnStart('n-2', 't4'));
    service.observeChatEvent(ev('error', { nodeId: 'n-2', chatId: 'n-2', turnId: 't3', message: 'late' }));
    clock.advance(1_000);
    assert.deepEqual(records(), [], 'answered, seen (the domain command row), and superseded by a newer turn');
  });

  test('cancellation and a backend restart are not failures; a genuine error is', () => {
    const { clock, service } = setup();
    service.observeChatEvent(done('n-1', 't1', 'cancelled'));
    service.observeChatEvent(ev('error', { nodeId: 'n-1', chatId: 'n-1', turnId: 't2', message: 'Michi restarted', code: 'backend_restarted' }));
    clock.advance(1_000);
    assert.deepEqual(records(), []);
    service.observeChatEvent(ev('error', { nodeId: 'n-1', chatId: 'n-1', turnId: 't3', message: 'Model unavailable', code: 'generic' }));
    service.observeChatEvent(done('n-2', 't4', 'error'));
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => [row.key, row.kind, row.reason]),
      [['node:n-1', 'failed', 'error'], ['node:n-2', 'failed', 'error']]);
    const body = (getDb().prepare("SELECT body FROM attention_notifications WHERE key = 'node:n-1'").get() as { body: string }).body;
    assert.equal(body, 'Failed: Model unavailable');
  });

  test('a completion with no answer of this turn, a scheduled turn and a trashed node are not reported', () => {
    const { clock, service } = setup();
    service.observeChatEvent(done('n-1', 't-no-answer'));
    completeTurn('n-2', 'ws-a', 't-scheduled', { scheduledJobId: 'job-1' });
    service.observeChatEvent(done('n-2', 't-scheduled'));
    clock.advance(1_000);
    assert.deepEqual(records(), [], 'the scheduler reports its own runs');
    const repository = new AttentionRepository();
    assert.deepEqual([repository.turnIsScheduled('t-scheduled'), repository.nodeFacts('n-2')?.lastCompletedTurnId],
      [true, 't-scheduled'], 'it was a counted completion, left out only for being scheduled');
    service.observeChatEvent(permission('n-2', 't-scheduled', 1));
    getDb().prepare("UPDATE nodes SET deleted_at = 5 WHERE id = 'n-b'").run();
    service.observeChatEvent(permission('n-b', 't-trash', 1));
    clock.advance(1_000);
    assert.deepEqual(records(), []);
  });

  test('the same fact twice is one record', () => {
    const { clock, service } = setup();
    completeTurn('n-1', 'ws-a', 't1');
    service.observeChatEvent(done('n-1', 't1'));
    clock.advance(1_000);
    service.observeChatEvent(done('n-1', 't1'));
    clock.advance(1_000);
    assert.equal(records().length, 1);
  });
});

describe('through a real ChatHub, subscribed as server.ts does', () => {
  function hubFor(service: AttentionService): ChatHub {
    const hub = new ChatHub({
      retentionMs: 100,
      workspaceIdForNode: () => 'ws-a',
      titleGenerator: null,
      memoryInjector: null,
      persistence: { begin: (snapshot) => { beginTurn(snapshot); }, checkpoint: () => {}, finalize: (snapshot) => { finalizeTurn(snapshot); } },
    });
    hub.subscribeBackground({ includeForeground: true, send: (_chatId, event) => service.observeChatEvent(event), close: () => {} });
    return hub;
  }

  function session(events: () => AsyncIterableIterator<NormalizedEvent>): AgentSession {
    return { id: 'n-1', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined, send: events, cancel: () => {} };
  }

  test('a turn that answers becomes a finished record; an approval it waits on, a needs_input one', async () => {
    const { clock, service } = setup();
    const hub = hubFor(service);
    const answered = await hub.startTurn({
      chatId: 'n-1', nodeId: 'n-1', text: 'Go',
      session: session(async function* () {
        yield { kind: 'chunk', text: 'All done.' };
        yield { kind: 'turn_end', stopReason: 'end_turn' };
      }),
    });
    await answered.done;
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => [row.key, row.fact, row.kind]), [['node:n-1', 'completion:1', 'finished']]);

    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const waiting = await hub.startTurn({
      chatId: 'n-1', nodeId: 'n-1', text: 'Run the tests',
      session: session(async function* () {
        yield { kind: 'permission_request', requestId: 3, title: 'npm test', options: [] } as NormalizedEvent;
        await released;
        yield { kind: 'turn_end', stopReason: 'end_turn' };
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => [row.reason, row.status, row.resolve_reason]),
      [['completed', 'resolved', 'stale'], ['approval', 'active', null]], 'the new turn made the old outcome stale');
    release();
    await waiting.done;
    assert.deepEqual(records().map((row) => row.status), ['resolved', 'resolved'], 'the turn ended: nothing left to approve');
  });
});

describe('one active record per key', () => {
  test('a newer fact supersedes the older record, and windows are told both', () => {
    const { clock, feed, service } = setup();
    const window = collect(feed, LOCAL);
    service.observeChatEvent(permission('n-1', 't1', 1));
    clock.advance(1_000);
    service.observeChatEvent(question('n-1', 't1', 2));
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => [row.reason, row.status, row.resolve_reason]),
      [['approval', 'resolved', 'superseded'], ['question', 'active', null]]);
    const [first, second] = window.of('attention_notification');
    assert.deepEqual(window.frames.slice(1).map((frame) => frame.event),
      ['attention_notification', 'attention_resolved', 'attention_notification']);
    assert.equal(window.of('attention_resolved')[0].id, first.id);
    assert.equal(window.of('attention_resolved')[0].reason, 'superseded');
    assert.equal(second.body, 'Which branch?');
  });

  test('within the delay only the latest fact for a key is decided', () => {
    const { clock, service } = setup();
    service.observeChatEvent(permission('n-1', 't1', 1));
    clock.advance(500);
    service.observeChatEvent(permission('n-1', 't1', 2));
    clock.advance(999);
    assert.equal(records().length, 0, 'the delay restarts with the newer fact');
    clock.advance(1);
    assert.deepEqual(records().map((row) => row.fact), ['permission:t1:2']);
  });
});

describe('resolving', () => {
  test('answering resolves the request; the turn ending resolves what it still waited for', () => {
    const { clock, feed, service } = setup();
    const window = collect(feed, LOCAL);
    service.observeChatEvent(permission('n-1', 't1', 1));
    service.observeChatEvent(question('n-2', 't2', 1));
    clock.advance(1_000);
    service.observeChatEvent(ev('permission_resolved', { nodeId: 'n-1', chatId: 'n-1', turnId: 't1', requestId: 1 }));
    service.observeChatEvent(ev('error', { nodeId: 'n-2', chatId: 'n-2', turnId: 't2', message: 'x', code: 'backend_restarted' }));
    assert.deepEqual(window.of('attention_resolved').map((resolved) => [resolved.key, resolved.reason]),
      [['node:n-1', 'answered'], ['node:n-2', 'stale']]);
    assert.deepEqual(records().map((row) => row.status), ['resolved', 'resolved']);
  });

  test('an approval answered through the route resolves it, matched within its own node', () => {
    const { clock, feed, service } = setup();
    const window = collect(feed, LOCAL);
    service.observeChatEvent(turnStart('n-1', 't1'));
    service.observeChatEvent(permission('n-1', 't1', 1));
    service.observeChatEvent(turnStart('n-2', 't2'));
    service.observeChatEvent(permission('n-2', 't2', 1));
    clock.advance(1_000);
    service.permissionAnswered({ nodeId: 'n-1', requestId: 1 });
    assert.deepEqual(window.of('attention_resolved').map((resolved) => [resolved.target.nodeId, resolved.reason]),
      [['n-1', 'answered']], 'the same request id of another node is untouched');
    service.permissionAnswered({ nodeId: 'n-2', turnId: 't2', requestId: 1 });
    service.permissionAnswered({ nodeId: 'n-2', turnId: 't2', requestId: 1 });
    assert.deepEqual(records().map((row) => [row.key, row.resolve_reason]), [['node:n-1', 'answered'], ['node:n-2', 'answered']]);
    assert.equal(window.of('attention_resolved').length, 2, 'resolved once');
    service.observeChatEvent(permission('n-1', 't1', 2));
    service.permissionAnswered({ nodeId: 'n-1', turnId: 't1', requestId: 2 });
    clock.advance(1_000);
    assert.equal(records().length, 2, 'answered before the decision: never recorded');
  });

  test('a seen view mark resolves the node; a new turn makes the old outcome stale', () => {
    const { clock, feed, service } = setup();
    const window = collect(feed, LOCAL);
    completeTurn('n-1', 'ws-a', 't1');
    service.observeChatEvent(done('n-1', 't1'));
    completeTurn('n-2', 'ws-a', 't2');
    service.observeChatEvent(done('n-2', 't2'));
    clock.advance(1_000);
    service.nodeCompletionSeen({ workspaceId: 'ws-a', nodeId: 'n-1', seenCompletionSeq: 1 });
    service.observeChatEvent(turnStart('n-2', 't3'));
    assert.deepEqual(window.of('attention_resolved').map((resolved) => [resolved.target.nodeId, resolved.reason]),
      [['n-1', 'seen'], ['n-2', 'stale']]);
  });

  test('a focused window bringing the target on screen resolves it as seen', () => {
    const { clock, feed, shown, service } = setup();
    const window = collect(feed, LOCAL);
    service.observeChatEvent(permission('n-1', 't1', 1));
    clock.advance(1_000);
    service.presenceChanged(LOCAL);
    assert.equal(window.of('attention_resolved').length, 0);
    shown.show(LOCAL, { kind: 'node', nodeId: 'n-1' });
    service.presenceChanged('someone-else');
    assert.equal(window.of('attention_resolved').length, 0, 'another owner\'s presence is not this owner\'s');
    service.presenceChanged(LOCAL);
    assert.deepEqual(window.of('attention_resolved').map((resolved) => resolved.reason), ['seen']);
  });

  test('records expire after the retention window and are pruned later', () => {
    const { clock, feed, service } = setup();
    const window = collect(feed, LOCAL);
    service.observeChatEvent(permission('n-1', 't1', 1));
    clock.advance(1_000);
    clock.advance(24 * 60 * 60_000 - 10 * 60_000);
    assert.deepEqual(records().map((row) => row.status), ['active'], 'younger than a day');
    clock.advance(20 * 60_000);
    assert.deepEqual(records().map((row) => [row.status, row.resolve_reason]), [['expired', 'expired']]);
    assert.deepEqual(window.of('attention_resolved').map((resolved) => resolved.reason), ['expired']);
    assert.deepEqual(collect(feed, LOCAL).of('attention_snapshot')[0].notifications, []);
    clock.advance(7 * 24 * 60 * 60_000 + 10 * 60_000);
    assert.deepEqual(records(), [], 'pruned');
  });

  test('a restart drops unanswerable requests and seen completions, and keeps the rest', () => {
    const first = setup();
    first.service.observeChatEvent(permission('n-1', 't1', 1));
    completeTurn('n-2', 'ws-a', 't2');
    first.service.observeChatEvent(done('n-2', 't2'));
    first.clock.advance(1_000);
    first.service.stop();
    getDb().prepare("UPDATE nodes SET seen_completion_seq = 0 WHERE id = 'n-2'").run();
    const second = setup();
    assert.deepEqual(records().map((row) => [row.key, row.status, row.resolve_reason]),
      [['node:n-1', 'resolved', 'stale'], ['node:n-2', 'active', null]]);
    second.service.stop();
    getDb().prepare("UPDATE nodes SET seen_completion_seq = 1 WHERE id = 'n-2'").run();
    setup();
    assert.deepEqual(records().map((row) => [row.key, row.status, row.resolve_reason]),
      [['node:n-1', 'resolved', 'stale'], ['node:n-2', 'resolved', 'seen']]);
  });

  test('stopping decides what is pending at once and ignores teardown', () => {
    const { service } = setup();
    service.observeChatEvent(permission('n-1', 't1', 1));
    service.stop();
    assert.deepEqual(records().map((row) => row.reason), ['approval']);
    service.observeChatEvent(permission('n-2', 't2', 1));
    assert.equal(records().length, 1);
  });
});

describe('seen marks that arrive late', () => {
  // A window batches its view marks, so a mark reaches the server seconds
  // after the completion it saw (workspacePersistence.ts). By then a queued
  // follow-up may have completed again, or a new turn asked for something.
  let markOp = 0;
  const markSeen = (seen: number) => applyWorkspaceCommands('ws-a', {
    operationId: `seen-${++markOp}`,
    commands: [{ type: 'node.patch', payload: { id: 'n-1', viewed_at: 9, seen_completion_seq: seen } }],
  });
  /** Subscribed to the view mark channel as server.ts does. */
  function setupWithMarks(t: { after(fn: () => void): void }) {
    const harness = setup();
    t.after(subscribeNodeCompletionSeen((mark) => harness.service.nodeCompletionSeen(mark)));
    return harness;
  }

  test('a mark for completion 1 does not keep completion 2 from being recorded', (t) => {
    const { clock, service } = setupWithMarks(t);
    service.observeChatEvent(turnStart('n-1', 't1'));
    completeTurn('n-1', 'ws-a', 't1');
    service.observeChatEvent(turnStart('n-1', 't2'));
    completeTurn('n-1', 'ws-a', 't2');
    service.observeChatEvent(done('n-1', 't2'));
    clock.advance(500);
    markSeen(1);
    clock.advance(500);
    assert.deepEqual(records().map((row) => [row.fact, row.status]), [['completion:2', 'active']]);
  });

  test('a mark for completion 1 does not withdraw completion 2; one for completion 2 does', (t) => {
    const { clock, feed, service } = setupWithMarks(t);
    const window = collect(feed, LOCAL);
    completeTurn('n-1', 'ws-a', 't1');
    service.observeChatEvent(turnStart('n-1', 't2'));
    completeTurn('n-1', 'ws-a', 't2');
    service.observeChatEvent(done('n-1', 't2'));
    clock.advance(1_000);
    markSeen(1);
    assert.deepEqual(records().map((row) => [row.fact, row.status]), [['completion:2', 'active']]);
    assert.equal(window.of('attention_resolved').length, 0);
    markSeen(2);
    assert.deepEqual(records().map((row) => [row.fact, row.status, row.resolve_reason]), [['completion:2', 'resolved', 'seen']]);
  });

  test('a mark for the previous completion leaves the next turn\'s approval and question', (t) => {
    const { clock, service } = setupWithMarks(t);
    completeTurn('n-1', 'ws-a', 't1');
    service.observeChatEvent(turnStart('n-1', 't2'));
    service.observeChatEvent(permission('n-1', 't2', 3));
    clock.advance(1_000);
    markSeen(1);
    assert.deepEqual(records().map((row) => [row.reason, row.status]), [['approval', 'active']]);
    service.observeChatEvent(question('n-1', 't2', 4));
    clock.advance(1_000);
    service.nodeCompletionSeen({ workspaceId: 'ws-a', nodeId: 'n-1', seenCompletionSeq: 99 });
    assert.deepEqual(records().map((row) => [row.reason, row.status]), [['approval', 'resolved'], ['question', 'active']],
      'a mark never resolves anything but a completion it covers');
  });
});

describe('resolving while the store is busy', () => {
  class BusyRepository extends AttentionRepository {
    busy = 0;
    override resolve(...args: Parameters<AttentionRepository['resolve']>): ReturnType<AttentionRepository['resolve']> {
      if (this.busy > 0) {
        this.busy -= 1;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return super.resolve(...args);
    }
  }

  test('a resolution whose write fails stays active, and the next resolution writes it', () => {
    const repository = new BusyRepository();
    const { clock, feed, service, errors } = setup({ repository });
    const window = collect(feed, LOCAL);
    service.observeChatEvent(turnStart('n-1', 't1'));
    service.observeChatEvent(permission('n-1', 't1', 1));
    clock.advance(1_000);
    repository.busy = 1;
    service.permissionAnswered({ nodeId: 'n-1', turnId: 't1', requestId: 1 });
    assert.equal(errors.length, 1, 'the failed write is reported');
    assert.deepEqual(records().map((row) => row.status), ['active']);
    assert.equal(window.of('attention_resolved').length, 0, 'windows were told nothing');
    service.observeChatEvent(turnStart('n-1', 't2'));
    assert.deepEqual(records().map((row) => [row.status, row.resolve_reason]), [['resolved', 'stale']],
      'the record was still known as active, so the new turn resolved it');
    assert.deepEqual(window.of('attention_resolved').map((resolved) => resolved.reason), ['stale']);
    assert.deepEqual(service.snapshot(LOCAL), []);
  });
});

describe('questions and presence', () => {
  test('a question is recorded with its pane in front of the user, and showing it does not resolve it', () => {
    const { clock, shown, service } = setup();
    shown.show(LOCAL, { kind: 'node', nodeId: 'n-1' });
    service.observeChatEvent(turnStart('n-1', 't1'));
    service.observeChatEvent(question('n-1', 't1', 1));
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => [row.reason, row.status]), [['question', 'active']],
      'its card can be scrolled out of a visible pane: windows decide whether to show it');
    service.presenceChanged(LOCAL, [{ kind: 'node', nodeId: 'n-1' }]);
    service.presenceChanged(LOCAL);
    assert.deepEqual(records().map((row) => row.status), ['active'], 'only an answer or the turn ending resolves it');
    service.observeChatEvent(permission('n-1', 't1', 2));
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => [row.reason, row.status]), [['question', 'active']],
      'an approval on screen is still suppressed, and does not take the question with it');
    service.observeChatEvent(ev('user_input_resolved', { nodeId: 'n-1', chatId: 'n-1', turnId: 't1', requestId: 1, answers: [] }));
    assert.deepEqual(records().map((row) => [row.status, row.resolve_reason]), [['resolved', 'answered']]);
  });
});

describe('presence changes', () => {
  test('only what the changed window shows is checked', () => {
    const asked: string[] = [];
    let visible = false;
    const presenceStub: AttentionPresence = {
      isTargetVisibleInFocusedWindow: (_owner, target) => { asked.push(encodePaneId(target)); return visible; },
    };
    const { clock, service } = setup({ presenceStub });
    service.observeChatEvent(permission('n-1', 't1', 1));
    service.observeChatEvent(permission('n-2', 't2', 1));
    clock.advance(1_000);
    asked.length = 0;
    visible = true;
    service.presenceChanged(LOCAL, [
      { kind: 'node', nodeId: 'n-2' }, { kind: 'node', nodeId: 'n-no-record' }, { kind: 'surface', registrationId: 'reg-1' },
    ]);
    assert.deepEqual(asked, [encodePaneId({ kind: 'node', nodeId: 'n-2' })], 'one check, for the one record shown');
    assert.deepEqual(records().map((row) => [row.key, row.status]), [['node:n-1', 'active'], ['node:n-2', 'resolved']]);
    service.presenceChanged(LOCAL, []);
    service.presenceChanged('someone-else', [{ kind: 'node', nodeId: 'n-1' }]);
    assert.equal(asked.length, 1, 'an unfocused window shows nothing; another owner\'s window is not looked at');
    assert.equal(records()[0].status, 'active');
  });
});

describe('claims and owners', () => {
  test('the first window to claim wins, once', () => {
    const { clock, feed, service } = setup();
    const window = collect(feed, LOCAL);
    service.observeChatEvent(permission('n-1', 't1', 1));
    clock.advance(1_000);
    const id = window.of('attention_notification')[0].id as string;
    assert.deepEqual(service.claim(LOCAL, id, 'w-1'), { claimed: true, claimedByWindowId: 'w-1', status: 'active' });
    assert.deepEqual(service.claim(LOCAL, id, 'w-2'), { claimed: false, claimedByWindowId: 'w-1', status: 'active' });
    assert.deepEqual(service.claim(LOCAL, id, 'w-1'), { claimed: true, claimedByWindowId: 'w-1', status: 'active' });
    assert.equal(service.claim('someone-else', id, 'w-3'), null, 'another owner cannot see it');
    assert.equal(collect(feed, LOCAL).of('attention_snapshot')[0].notifications[0].claimedByWindowId, 'w-1');
    service.observeChatEvent(ev('permission_resolved', { nodeId: 'n-1', chatId: 'n-1', turnId: 't1', requestId: 1 }));
    assert.deepEqual(service.claim(LOCAL, id, 'w-1'), { claimed: false, claimedByWindowId: 'w-1', status: 'resolved' });
    service.observeChatEvent(question('n-2', 't2', 1));
    clock.advance(1_000);
    const late = window.of('attention_notification')[1].id as string;
    service.observeChatEvent(ev('user_input_resolved', { nodeId: 'n-2', chatId: 'n-2', turnId: 't2', requestId: 1, answers: [] }));
    assert.deepEqual(service.claim(LOCAL, late, 'w-2'), { claimed: false, claimedByWindowId: null, status: 'resolved' },
      'a resolved record cannot be claimed');
  });

  test('in the cloud records, frames and claims stay with the workspace owner', () => {
    process.env.MICHI_CLOUD = '1';
    const { clock, feed, service } = setup();
    const alice = collect(feed, 'alice');
    const bob = collect(feed, 'bob');
    service.observeChatEvent(permission('n-1', 't1', 1));
    service.observeChatEvent(permission('n-b', 't2', 1));
    clock.advance(1_000);
    assert.deepEqual(alice.of('attention_notification').map((item) => item.target.nodeId), ['n-1']);
    assert.deepEqual(bob.of('attention_notification').map((item) => item.target.nodeId), ['n-b']);
    const aliceId = alice.of('attention_notification')[0].id as string;
    assert.equal(service.claim('bob', aliceId, 'w-bob'), null);
    assert.deepEqual(service.snapshot('bob').map((item) => item.target.type === 'node' ? item.target.nodeId : null), ['n-b']);
    assert.deepEqual(records().map((row) => row.owner_user_id), ['alice', 'bob']);
  });
});

describe("the agent's own conversation and Michi's posts into it", () => {
  // V as assistant/store.ts makes it: a node titled Assistant in the assistant's system workspace.
  beforeEach(() => {
    getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,settings,created_at,updated_at) VALUES ('ws-v','Michi',NULL,?,1,1)")
      .run(JSON.stringify({ system: 'assistant' }));
    getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,title,created_at) VALUES ('n-v','ws-v','chat','idle','Assistant',1)").run();
  });

  /** A post as chatHub.postSelfMessage broadcasts it: no user message, complete at once. */
  const post = (turnId: string) => [
    ev('turn_start', { nodeId: 'n-v', chatId: 'n-v', turnId, assistantId: turnId, userText: '', selfInitiated: true }),
    ev('chunk', { nodeId: 'n-v', chatId: 'n-v', turnId, text: 'Your CR is approved.' }),
    ev('done', { nodeId: 'n-v', chatId: 'n-v', turnId, stopReason: 'end_turn', persisted: true }),
  ];

  test("a post neither makes a record nor leaves the reply's stale, also when it lands while the reply is being decided", () => {
    const { clock, feed, service } = setup({ assistantName: () => 'Robin' });
    const window = collect(feed, LOCAL);
    service.observeChatEvent(turnStart('n-v', 't1'));
    completeTurn('n-v', 'ws-v', 't1');
    service.observeChatEvent(done('n-v', 't1'));
    // A check-in's post queued behind the reply lands at once.
    for (const frame of post('cmp-post-run1')) service.observeChatEvent(frame);
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => [row.key, row.fact, row.kind, row.status]), [['node:n-v', 'completion:1', 'finished', 'active']]);
    assert.equal(window.of('attention_notification')[0].title, 'Robin replied');
    for (const frame of post('mna-start-5')) service.observeChatEvent(frame);
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => [row.fact, row.status]), [['completion:1', 'active']], 'first-run narration leaves it too');
    assert.equal(window.of('attention_notification').length, 1);
    // A turn the agent starts itself is the conversation's own, as is the user's next message.
    service.observeChatEvent(ev('turn_start', { nodeId: 'n-v', chatId: 'n-v', turnId: 'self-wake-1', assistantId: 'a', userText: '', selfInitiated: true }));
    assert.deepEqual(records().map((row) => [row.fact, row.status, row.resolve_reason]), [['completion:1', 'resolved', 'stale']]);
  });

  test("its approvals, questions, replies and failures speak under the agent's name; another conversation keeps its titles", () => {
    let name = 'Robin';
    const { clock, feed, service } = setup({ assistantName: () => name });
    const window = collect(feed, LOCAL);
    service.observeChatEvent(permission('n-v', 't1', 1));
    clock.advance(1_000);
    service.observeChatEvent(question('n-v', 't1', 2));
    clock.advance(1_000);
    service.observeChatEvent(ev('error', { nodeId: 'n-v', chatId: 'n-v', turnId: 't1', message: 'boom' }));
    clock.advance(1_000);
    name = '  ';
    service.observeChatEvent(turnStart('n-v', 't2'));
    completeTurn('n-v', 'ws-v', 't2');
    service.observeChatEvent(done('n-v', 't2'));
    service.observeChatEvent(permission('n-1', 't3', 1));
    clock.advance(1_000);
    assert.deepEqual(window.of('attention_notification').map((item) => [item.target.nodeId, item.title, item.body]), [
      ['n-v', 'Robin: needs your approval', 'Run npm test'],
      ['n-v', 'Robin: has a question', 'Which branch?'],
      ['n-v', 'Robin', 'Failed: boom'],
      ['n-v', 'Michi replied', 'Streaming finished'],
      ['n-1', 'Tool approval needed', 'Run npm test'],
    ]);
  });
});

describe('the desktop notifier (services/companion/chatNotices.ts)', () => {
  test('an event it raised before the decision is claimed for it: windows list it, and none raises it again', () => {
    const { clock, feed, service } = setup();
    const window = collect(feed, LOCAL);
    service.observeChatEvent(permission('n-1', 't1', 3));
    service.shownByDesktop({ nodeId: 'n-1', turnId: 't1', kind: 'approval', requestId: 3 });
    clock.advance(1_000);
    const [notification] = window.of('attention_notification');
    assert.equal(notification.claimedByWindowId, DESKTOP_NOTIFIER_WINDOW_ID);
    assert.equal(collect(feed, LOCAL).of('attention_snapshot')[0].notifications[0].claimedByWindowId, DESKTOP_NOTIFIER_WINDOW_ID,
      'a window that opens later finds it claimed: it lists it without an OS notification');
    assert.deepEqual(service.claim(LOCAL, notification.id, 'w-1'), { claimed: false, claimedByWindowId: DESKTOP_NOTIFIER_WINDOW_ID, status: 'active' });
    assert.equal(service.shownInWindow({ nodeId: 'n-1', turnId: 't1', kind: 'approval', requestId: 3 }), false, 'the notifier holds it, not a window');

    // A reply is the turn's own completion.
    service.observeChatEvent(turnStart('n-2', 't2'));
    completeTurn('n-2', 'ws-a', 't2');
    service.observeChatEvent(done('n-2', 't2'));
    service.shownByDesktop({ nodeId: 'n-2', turnId: 't2', kind: 'reply' });
    clock.advance(1_000);
    assert.deepEqual(claimants(), [['permission:t1:3', DESKTOP_NOTIFIER_WINDOW_ID], ['completion:1', DESKTOP_NOTIFIER_WINDOW_ID]]);
  });

  test('an event it raised after the decision is claimed then; one a window raised first stays the window\'s', () => {
    const { clock, service } = setup();
    service.observeChatEvent(question('n-1', 't1', 1));
    clock.advance(1_000);
    const asked = { nodeId: 'n-1', turnId: 't1', kind: 'question', requestId: 1 } as const;
    assert.equal(service.shownInWindow(asked), false);
    service.shownByDesktop(asked);
    assert.deepEqual(claimants(), [['input:t1:1', DESKTOP_NOTIFIER_WINDOW_ID]]);

    service.observeChatEvent(permission('n-2', 't2', 4));
    clock.advance(1_000);
    const id = (getDb().prepare("SELECT id FROM attention_notifications WHERE fact = 'permission:t2:4'").get() as { id: string }).id;
    service.claim(LOCAL, id, 'w-1');
    const approval = { nodeId: 'n-2', turnId: 't2', kind: 'approval', requestId: 4 } as const;
    assert.equal(service.shownInWindow(approval), true, 'a window raised it: the notifier stays quiet');
    assert.equal(service.shownInWindow({ ...approval, requestId: 5 }), false, 'another request is another event');
    service.shownByDesktop(approval);
    assert.deepEqual(claimants().at(-1), ['permission:t2:4', 'w-1'], 'the window keeps its claim');
  });

  test('a reply names its turn: a notice of an older reply claims no newer completion', () => {
    const { clock, service } = setup();
    for (const turnId of ['t1', 't2']) {
      service.observeChatEvent(turnStart('n-1', turnId));
      completeTurn('n-1', 'ws-a', turnId);
      service.observeChatEvent(done('n-1', turnId));
      clock.advance(1_000);
    }
    service.shownByDesktop({ nodeId: 'n-1', turnId: 't1', kind: 'reply' });
    assert.deepEqual(claimants(), [['completion:1', null], ['completion:2', null]]);
    service.shownByDesktop({ nodeId: 'n-1', turnId: 't2', kind: 'reply' });
    assert.deepEqual(claimants(), [['completion:1', null], ['completion:2', DESKTOP_NOTIFIER_WINDOW_ID]]);
  });
});

describe('Agent Run notifier', () => {
  const runOf = (status: AgentRunStatus, overrides: Partial<AgentRunDtoV1> = {}): AgentRunDtoV1 => ({
    id: 'run-1', status, workspaceId: 'ws-a', task: 'Refactor the parser', resultBundle: null,
    effectiveDefinition: { name: 'Reviewer' }, ...overrides,
  } as AgentRunDtoV1);

  test('a completed or failed Run becomes one record for the Run, once its decision settles', async () => {
    let current = runOf(AgentRunStatus.Completed, {
      resultBundle: { handoff: { conclusion: 'Two issues found', artifactsOrChanges: '', unresolvedIssues: '' } } as AgentRunDtoV1['resultBundle'],
    });
    const { clock, feed, service } = setup({ getRun: () => current });
    const window = collect(feed, LOCAL);
    let settled = false;
    const notified = service.agentRunNotifier.notify(LOCAL, current).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'a watch is marked delivered only after the record is decided');
    clock.advance(1_000);
    await notified;
    const [notification] = window.of('attention_notification');
    assert.deepEqual([notification.kind, notification.reason, notification.title, notification.body],
      ['finished', 'run_completed', 'Reviewer completed', 'Two issues found']);
    assert.deepEqual(notification.target, { type: 'agent_run', runId: 'run-1', workspaceId: 'ws-a' });
    const redelivered = service.agentRunNotifier.notify(LOCAL, current);
    clock.advance(1_000);
    await redelivered;
    assert.equal(records().length, 1, 'a redelivered watch does not notify twice');
    current = runOf(AgentRunStatus.Failed, { id: 'run-2' });
    const failed = service.agentRunNotifier.notify(LOCAL, current);
    clock.advance(1_000);
    await failed;
    assert.deepEqual(records().map((row) => [row.key, row.kind, row.reason]),
      [['agent_run:run-1', 'finished', 'run_completed'], ['agent_run:run-2', 'failed', 'run_failed']]);
  });

  test('running, cancelled, changed and on-screen Runs are not reported', async () => {
    const shown = visibility();
    let stored: AgentRunDtoV1 | null = runOf(AgentRunStatus.Running);
    const { clock, service } = setup({ presence: shown, getRun: () => stored });
    await service.agentRunNotifier.notify(LOCAL, runOf(AgentRunStatus.Running));
    await service.agentRunNotifier.notify(LOCAL, runOf(AgentRunStatus.Cancelled));
    const changed = service.agentRunNotifier.notify(LOCAL, runOf(AgentRunStatus.Completed));
    clock.advance(1_000);
    await changed;
    stored = runOf(AgentRunStatus.Completed);
    shown.show(LOCAL, { kind: 'agent_run', runId: 'run-1' });
    const onScreen = service.agentRunNotifier.notify(LOCAL, stored);
    clock.advance(1_000);
    await onScreen;
    assert.deepEqual(records(), []);
  });

  test('a notify-mode watch delivers through the attention service', async () => {
    const runs = new Map<string, AgentRunDtoV1>([['run-1', runOf(AgentRunStatus.Completed)], ['run-2', runOf(AgentRunStatus.Failed, { id: 'run-2' })]]);
    const watches = new Map<string, AgentRunWatchDtoV1>();
    const delivered = new Map<string, string>();
    const repository = {
      getRun: (_owner: string, id: string) => runs.get(id) ?? null,
      createWatch: (ownerUserId: string, workspaceId: string, runIds: readonly string[], condition: WatchConditionV1,
        completionMode: 'notify' | 'wake') => {
        const watch = { version: 1 as const, id: 'watch-1', ownerUserId, workspaceId, runIds: [...runIds], condition, completionMode,
          status: 'active' as const, deliveryId: 'd-1', requestedTurnId: 'turn-1', parentRunId: null, parentNodeId: null,
          parentTurnId: null, createdAt: 1, firedAt: null };
        watches.set(watch.id, watch);
        return watch;
      },
      getWatch: (_owner: string, id: string) => watches.get(id) ?? null,
      fireWatch: (_owner: string, id: string) => {
        const watch = watches.get(id);
        if (!watch || watch.status !== 'active') return false;
        watches.set(id, { ...watch, status: 'fired', firedAt: 2 });
        return true;
      },
      markWatchDelivery: (_owner: string, id: string, status: string) => { delivered.set(id, status); return true; },
    };
    const { clock, service } = setup({ getRun: (_owner, id) => runs.get(id) ?? null });
    const coordinator = new AgentRunWatchCoordinator(repository as never, service.agentRunNotifier, { deliver: async () => 'delivered' });
    const watch = coordinator.create(LOCAL, 'ws-a', ['run-1', 'run-2'], { version: 1, kind: 'all' }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'op-1');
    const evaluation = coordinator.evaluate(LOCAL, watch.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delivered.get(watch.id), undefined, 'not delivered before the records exist');
    clock.advance(1_000);
    assert.equal(await evaluation, true);
    assert.equal(delivered.get(watch.id), 'delivered');
    assert.deepEqual(records().map((row) => row.key), ['agent_run:run-1', 'agent_run:run-2']);
  });
});

describe('workflow approvals', () => {
  // Between turns a Claude workflow agent's tool approval, and every Kiro
  // workflow step's, waits only on the workflow run (WorkflowRunHub), never
  // as a chat permission_request.
  const PORT_CONTEXT = { ownerUserId: 'owner-a', workspaceId: 'ws-a', owner: chatOwner('n-1') };
  const ALLOW = [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' as const }];

  function memoryStore(): WorkflowRunStore {
    const rows = new Map<string, { ownerUserId: string; run: WorkflowRunDtoV1 }>();
    return {
      upsert(ownerUserId, run) { rows.set(run.id, { ownerUserId, run }); },
      get(ownerUserId, id) { const row = rows.get(id); return row && row.ownerUserId === ownerUserId ? row.run : null; },
      list(ownerUserId, workspaceId) { return [...rows.values()].filter((row) => row.ownerUserId === ownerUserId && row.run.workspaceId === workspaceId).map((row) => row.run); },
      listOpen: () => [],
      workspaceOwnedBy: () => true,
      workspaceOfNode: () => 'ws-a',
    };
  }

  /** Subscribed as server.ts does. */
  function workflowHub(service: AttentionService, now: () => number): WorkflowRunHub {
    const hub = new WorkflowRunHub(memoryStore(), now);
    hub.subscribe((_ownerUserId, run) => service.observeWorkflowRun(run));
    return hub;
  }

  function claudeTap(hub: WorkflowRunHub) {
    const tap = createClaudeWorkflowTap({ hub: workflowSink(hub), context: () => PORT_CONTEXT, stopTask: async () => {} });
    return {
      tap,
      start: (taskId: string) => tap.observe({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `t-${taskId}`, task_type: 'local_workflow', workflow_name: taskId }),
      ask: (timeoutMs = 60_000) => tap.requestApproval({ title: 'Approve Bash?', detail: 'Command: npm test', options: ALLOW }, timeoutMs)!,
    };
  }

  test('an approval a Claude workflow asks between turns is one needs-input record for its chat, however many runs show it', async () => {
    const { clock, feed, service } = setup();
    const window = collect(feed, LOCAL);
    const hub = workflowHub(service, clock.now);
    const claude = claudeTap(hub);
    claude.start('wf-A');
    claude.start('wf-B');
    const answer = claude.ask();
    assert.equal(hub.list('owner-a', 'ws-a').filter((run) => run.approvals?.length).length, 2, 'shown on every running workflow');
    clock.advance(999);
    assert.equal(records().length, 0, 'decided after the delay, as chat approvals are');
    clock.advance(1);
    assert.deepEqual(records().map((row) => [row.kind, row.reason, row.status]), [['needs_input', 'approval', 'active']]);
    const [notification] = window.of('attention_notification');
    assert.deepEqual(notification.target, { type: 'node', nodeId: 'n-1', workspaceId: 'ws-a' });
    assert.deepEqual([notification.title, notification.body], ['Workflow approval needed', 'Approve Bash?']);
    const [run] = hub.list('owner-a', 'ws-a');
    await hub.answerApproval('owner-a', run.id, run.approvals![0].id, 'allow_once');
    assert.deepEqual(await answer, { kind: 'answered', optionId: 'allow_once' });
    assert.deepEqual(records().map((row) => row.status), ['resolved'], 'answered on one card, gone from every run');
    assert.deepEqual(window.of('attention_resolved').map((resolved) => resolved.id), [notification.id]);
  });

  test('it outlives chat turns and a pane on screen, and lapses as stale', async () => {
    const { clock, shown, service } = setup();
    shown.show(LOCAL, { kind: 'node', nodeId: 'n-1' });
    const claude = claudeTap(workflowHub(service, clock.now));
    claude.start('wf-A');
    const lapsing = claude.ask(20);
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => row.status), ['active'], 'its card can be off screen in a visible pane');
    service.presenceChanged(LOCAL, [{ kind: 'node', nodeId: 'n-1' }]);
    service.presenceChanged(LOCAL);
    service.observeChatEvent(turnStart('n-1', 't1'));
    service.observeChatEvent(permission('n-1', 't1', 1));
    service.observeChatEvent(done('n-1', 't1', 'cancelled'));
    assert.deepEqual(records().map((row) => row.status), ['active'], 'the workflow still waits whatever the chat does');
    // The tap's lapse timer is unref'd: hold the event loop until it fires.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await lapsing, { kind: 'lapsed' });
    assert.deepEqual(records().map((row) => [row.status, row.resolve_reason]), [['resolved', 'stale']]);
  });

  test('a later session asking under the same approval id notifies again', async () => {
    const { clock, service } = setup();
    const hub = workflowHub(service, clock.now);
    for (const taskId of ['wf-A', 'wf-B']) {
      const claude = claudeTap(hub);
      claude.start(taskId);
      const answer = claude.ask();
      clock.advance(1_000);
      const run = hub.list('owner-a', 'ws-a').find((item) => item.approvals?.length)!;
      await hub.answerApproval('owner-a', run.id, run.approvals![0].id, 'allow_once');
      await answer;
    }
    assert.deepEqual(records().map((row) => [row.reason, row.status]), [['approval', 'resolved'], ['approval', 'resolved']]);
  });

  test("a Kiro step's approval notifies until its run ends; a multi-model run's mirror of a chat approval does not", () => {
    const { clock, service } = setup();
    const hub = workflowHub(service, clock.now);
    const kiro = { ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'n-2' };
    hub.update(kiro, 'kiro', 'wf_1', (run) => run);
    hub.requestApproval('owner-a', 'kiro', 'wf_1', { id: 'kiro-s1-1', nodeId: 'step', title: 'Approve write?', options: ALLOW }, () => {});
    hub.requestApproval('owner-a', 'kiro', 'wf_1', { id: 'kiro-s1-2', nodeId: 'step', title: 'Approve shell?', options: ALLOW }, () => {});
    hub.update({ ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'n-1' }, 'michi', 'mm_1', (run) => run);
    hub.requestApproval('owner-a', 'michi', 'mm_1', { id: 'mm-1', title: 'Approve Bash?', options: ALLOW }, () => {});
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => [row.reason, row.status, (row.key as string).includes('n-2')]),
      [['approval', 'active', true], ['approval', 'active', true]], 'one record per approval, none for the mirror');
    hub.update(kiro, 'kiro', 'wf_1', (run) => ({ ...run, status: 'failed' }));
    assert.deepEqual(records().map((row) => [row.status, row.resolve_reason]), [['resolved', 'stale'], ['resolved', 'stale']]);
  });
});
