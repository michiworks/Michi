/**
 * services/autoContinue.ts over a real ChatHub and SQLite: which finished
 * turns Michi carries on by itself, when, how many in a row and at once,
 * when it withdraws, and that the continued turn keeps the conversation's
 * approval rules. The runtime is a scripted session; the clock and the
 * interval are the test's.
 */

import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKEND_RESTARTED_ERROR, parseAutoContinueSource } from 'michi-shared';
import { ChatHub, type TurnFinalizedEvent } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import { AUTO_CONTINUE_LIMITS, AutoContinue, autoContinueReasonOf, autoContinueTurnId, type AutoContinueDeps } from '../src/services/autoContinue';
import { michiWorkerState } from '../src/services/companion/sources/michi';
import { closeDb, getDb, initDb } from '../src/services/db';
import { isGuarded, turnGuard, type TurnGuard } from '../src/services/turnGuard';
import { chatOwner } from './helpers/owners';

const { WORK_WAIT_MS, USER_WAIT_MS, FRESHNESS_MS } = AUTO_CONTINUE_LIMITS;

/** What the scripted runtime does with a prompt: end with a stop reason, fail with a message, or wait for `release`. */
type Step = { stop: string } | { fail: string } | { stop: string; gate: Promise<void> };

let tmpDir: string;
let hub: ChatHub;
let now: number;
let chatsOn: boolean;
let paused: boolean;
let pendingPermission: boolean;
let lockGate: Promise<void> | null;
let auto: AutoContinue;
const scripts = new Map<string, Step[]>();
const sent = new Map<string, string[]>();
const guards = new Map<string, TurnGuard>();
let turnCount = 0;

function seedChat(nodeId: string): void {
  getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,created_at) VALUES (?, 'ws', 'chat', 'idle', 1)").run(nodeId);
  scripts.set(nodeId, []);
  sent.set(nodeId, []);
}

/** A conversation Michi started (start_conversation) and follows. */
function makeWorkConversation(nodeId: string): void {
  getDb().prepare(`INSERT INTO companion_delegations (id, workspace_id, node_id, title, created_at, state, origin)
    VALUES (?, 'ws', ?, 'Work', 1, 'following', 'start_conversation')`).run(`d-${nodeId}`, nodeId);
}

function script(nodeId: string, ...steps: Step[]): void {
  scripts.get(nodeId)!.push(...steps);
}

const sessions = new Map<string, AgentSession>();
function sessionFor(nodeId: string): AgentSession {
  const existing = sessions.get(nodeId);
  if (existing) return existing;
  let stop: (() => void) | null = null;
  const session: AgentSession = {
    id: nodeId, nativeSessionId: `native-${nodeId}`, runtimeId: 'codex', currentModelId: 'test-model',
    owner: chatOwner(nodeId),
    getHistory: () => [], getPendingAssistant: () => undefined,
    cancel() { stop?.(); },
    async *send(text) {
      sent.get(nodeId)!.push(text);
      guards.set(`${nodeId}:${sent.get(nodeId)!.length}`, turnGuard(nodeId));
      const step = scripts.get(nodeId)!.shift() ?? { stop: 'end_turn' };
      yield { kind: 'chunk', text: 'Working on it.' };
      if ('gate' in step) {
        const stopped = new Promise<'stopped'>((resolve) => { stop = () => resolve('stopped'); });
        const ended = await Promise.race([step.gate, stopped]);
        stop = null;
        if (ended === 'stopped') {
          yield { kind: 'turn_end', stopReason: 'cancelled' };
          return;
        }
      }
      if ('fail' in step) throw new Error(step.fail);
      yield { kind: 'turn_end', stopReason: step.stop };
    },
  };
  sessions.set(nodeId, session);
  return session;
}

/** The user's own turn, finished. */
async function userTurn(nodeId: string, step: Step, text = 'Do the task'): Promise<string> {
  script(nodeId, step);
  const turnId = `user-${++turnCount}`;
  const started = await hub.startTurn({ chatId: nodeId, nodeId, turnId, text, session: sessionFor(nodeId), humanOrigin: true });
  await started.done;
  return turnId;
}

/** Advances the clock and runs what is due, then waits for the turns it started to finish. */
async function advance(ms: number): Promise<void> {
  now += ms;
  auto.tick();
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    const active = [...sessions.keys()].some((nodeId) => hub.isBusy(nodeId));
    if (!active && i > 3) return;
  }
}

function userMessages(nodeId: string): Array<{ content: string; metadata: Record<string, unknown> | null }> {
  return (getDb().prepare("SELECT content, metadata FROM messages WHERE node_id = ? AND role = 'user' ORDER BY seq").all(nodeId) as Array<{ content: string; metadata: string | null }>)
    .map((row) => ({ content: row.content, metadata: row.metadata ? JSON.parse(row.metadata) : null }));
}

function continuations(nodeId: string): string[] {
  return (sent.get(nodeId) ?? []).filter((text) => text.startsWith('[auto-continue'));
}

function makeAuto(overrides: Partial<AutoContinueDeps> = {}): AutoContinue {
  const realHub = hub;
  const instance = new AutoContinue({
    hub: {
      onTurnFinalized: (listener) => realHub.onTurnFinalized(listener),
      onCancel: (listener) => realHub.onCancel(listener),
      startRequestedSelfTurn: (args) => realHub.startRequestedSelfTurn(args),
      isBusy: (chatId) => realHub.isBusy(chatId),
      getPendingPermission: (chatId) => (pendingPermission ? { requestId: 1, title: 'Run it?' } as never : realHub.getPendingPermission(chatId)),
      getPendingUserInput: (chatId) => realHub.getPendingUserInput(chatId),
      isShuttingDown: () => realHub.isShuttingDown(),
    },
    ensureSession: async ({ nodeId }) => sessionFor(nodeId),
    acquireRestoreLock: async () => {
      if (lockGate) await lockGate;
      return () => {};
    },
    userChatsOn: () => chatsOn,
    michiPaused: () => paused,
    now: () => now,
    every: () => () => {},
    ...overrides,
  });
  instance.start();
  return instance;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-auto-continue-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  closeDb();
  initDb();
  getDb().prepare("INSERT INTO workspaces (id,name,cwd,created_at,updated_at) VALUES ('ws','Workspace',?,1,1)").run(tmpDir);
  hub = new ChatHub({ retentionMs: 10, titleGenerator: null, memoryInjector: null, pageManifestBuilder: () => '' });
  now = 1_000_000;
  chatsOn = false;
  paused = false;
  pendingPermission = false;
  lockGate = null;
  scripts.clear();
  sent.clear();
  sessions.clear();
  guards.clear();
  auto = makeAuto();
});

afterEach(() => {
  auto.stop();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('which finished turns continue', () => {
  const finished = (over: Partial<TurnFinalizedEvent>) => ({
    outcome: 'completed' as const, persisted: true, stopReason: 'end_turn', error: null, errorCode: null, ...over,
  });

  test('a limit, or a failure that clears up by itself', () => {
    assert.equal(autoContinueReasonOf(finished({ stopReason: 'max_tokens' })), 'max_tokens');
    assert.equal(autoContinueReasonOf(finished({ stopReason: 'max_turn_requests' })), 'max_turn_requests');
    assert.equal(autoContinueReasonOf(finished({ outcome: 'error', stopReason: null, error: 'InternalServerException: try again' })), 'transient');
    assert.equal(autoContinueReasonOf(finished({ outcome: 'error', stopReason: null, error: 'dispatch failure: io error' })), 'connection');
    assert.equal(autoContinueReasonOf(finished({ outcome: 'error', stopReason: null, error: 'Kiro dropped', errorCode: 'connection' })), 'connection');
    assert.equal(autoContinueReasonOf(finished({ outcome: 'error', stopReason: null, error: 'You have reached your usage limit' })), 'quota');
  });

  test('never a finished, stopped or declined turn, a sign-in failure, a restart or an unknown failure', () => {
    assert.equal(autoContinueReasonOf(finished({})), null);
    assert.equal(autoContinueReasonOf(finished({ outcome: 'cancelled', stopReason: 'cancelled' })), null);
    assert.equal(autoContinueReasonOf(finished({ stopReason: 'refusal' })), null);
    assert.equal(autoContinueReasonOf(finished({ outcome: 'error', error: 'ExpiredTokenException: the SSO session expired' })), null);
    assert.equal(autoContinueReasonOf(finished({ outcome: 'error', error: 'Not logged in. Please run /login' })), null);
    assert.equal(autoContinueReasonOf(finished({ outcome: 'error', error: 'request failed', errorCode: 'auth' })), null);
    assert.equal(autoContinueReasonOf(finished({ outcome: 'error', error: BACKEND_RESTARTED_ERROR, errorCode: BACKEND_RESTARTED_ERROR })), null);
    assert.equal(autoContinueReasonOf(finished({ outcome: 'error', error: 'Unexpected token in JSON' })), null);
    assert.equal(autoContinueReasonOf(finished({ stopReason: 'max_tokens', persisted: false })), null, 'a turn whose end was not saved');
  });
});

describe('work conversations', () => {
  beforeEach(() => {
    seedChat('w1');
    makeWorkConversation('w1');
  });

  test('a turn stopped at its step limit continues after a minute idle, as a visible numbered message', async () => {
    const from = await userTurn('w1', { stop: 'max_turn_requests' });
    assert.equal(auto.pending().length, 1);
    await advance(WORK_WAIT_MS - 1);
    assert.deepEqual(continuations('w1'), [], 'not before the wait');
    await advance(1);
    assert.equal(continuations('w1').length, 1);
    const [continuation] = continuations('w1');
    assert.match(continuation, /^\[auto-continue 1\/3 · max_turn_requests\]\n\n/);
    assert.match(continuation, /stopped before it finished: it reached its step limit\. Michi continued it automatically\./);
    const messages = userMessages('w1');
    assert.equal(messages.length, 2);
    assert.equal(messages[1].content, '[auto-continue 1/3 · max_turn_requests] Continue from where you stopped.');
    assert.deepEqual(parseAutoContinueSource(messages[1].metadata?.autoContinue), { n: 1, of: 3, reason: 'max_turn_requests', fromTurnId: from });
    const turn = getDb().prepare('SELECT status, assistant_message_id FROM turns WHERE turn_id = ?').get(autoContinueTurnId(from)) as { status: string; assistant_message_id: string };
    assert.equal(turn.status, 'completed');
  });

  test('three in a row at most; a user message or a finished continuation starts the count over', async () => {
    await userTurn('w1', { stop: 'max_turn_requests' });
    script('w1', { stop: 'max_tokens' }, { stop: 'max_turn_requests' }, { stop: 'max_turn_requests' });
    for (let i = 0; i < 4; i++) await advance(WORK_WAIT_MS);
    assert.deepEqual(continuations('w1').map((text) => text.split('\n')[0]), [
      '[auto-continue 1/3 · max_turn_requests]',
      '[auto-continue 2/3 · max_tokens]',
      '[auto-continue 3/3 · max_turn_requests]',
    ]);
    assert.equal(auto.pending().length, 0, 'the third stopped again: nothing more');

    // The user writes (the conversation is theirs now, so their setting decides): the count starts over.
    chatsOn = true;
    await userTurn('w1', { stop: 'max_tokens' }, 'Keep going please');
    script('w1', { stop: 'end_turn' });
    await advance(USER_WAIT_MS);
    assert.equal(continuations('w1').at(-1)?.split('\n')[0], '[auto-continue 1/3 · max_tokens]');
    assert.equal(auto.pending().length, 0, 'a continued turn that finished leaves nothing');
  });

  test('a failed turn continues with its request and partial output restored', async () => {
    await userTurn('w1', { fail: 'dispatch failure: connection reset by peer' }, 'Refactor the parser');
    await advance(WORK_WAIT_MS);
    const [continuation] = continuations('w1');
    assert.match(continuation, /^\[auto-continue 1\/3 · connection\]/);
    assert.match(continuation, /\[INTERRUPTED TURN — context restore\]/);
    assert.match(continuation, /Interrupted request:\nRefactor the parser/);
    assert.match(continuation, /Partial response before the interruption:\nWorking on it\./);
    assert.match(continuation, /Michi continued it automatically\./);
  });

  test('a chain of continuations restores the request that started it, not the continuation', async () => {
    await userTurn('w1', { stop: 'max_turn_requests' }, 'Write the migration');
    script('w1', { fail: 'InternalServerException' });
    await advance(WORK_WAIT_MS);
    await advance(WORK_WAIT_MS);
    const second = continuations('w1')[1];
    assert.match(second, /^\[auto-continue 2\/3 · transient\]/);
    assert.match(second, /Interrupted request:\nWrite the migration/);
  });

  test('the continued turn keeps the work conversation\'s rules, and the user has not taken it over', async () => {
    await userTurn('w1', { stop: 'max_turn_requests' });
    const before = guards.get('w1:1');
    assert.equal(before?.michiDriven, true, 'a followed work conversation is Michi-driven');
    await advance(WORK_WAIT_MS);
    assert.equal(guards.get('w1:2')?.michiDriven, true, 'its continuation is too');
    assert.equal(michiWorkerState('w1')?.userTookOver, false);
    // The user writing in it makes it theirs: their turns follow their own setting.
    chatsOn = true;
    await userTurn('w1', { stop: 'max_turn_requests' }, 'Let me take over');
    assert.equal(michiWorkerState('w1')?.userTookOver, true);
    assert.equal(auto.pending()[0]?.work, false);
  });

  test('nothing continues while Michi is paused', async () => {
    paused = true;
    await userTurn('w1', { stop: 'max_turn_requests' });
    assert.equal(auto.pending().length, 0);
    paused = false;
    await userTurn('w1', { stop: 'max_turn_requests' });
    paused = true;
    await advance(WORK_WAIT_MS);
    assert.deepEqual(continuations('w1'), [], 'paused before it was due');
    assert.equal(auto.pending().length, 0);
  });

  test('past the freshness window nothing starts (a laptop that slept)', async () => {
    await userTurn('w1', { stop: 'max_turn_requests' });
    await advance(WORK_WAIT_MS + FRESHNESS_MS + 1);
    assert.deepEqual(continuations('w1'), []);
    assert.equal(auto.pending().length, 0);
  });

  test('an approval or question still waiting holds it until answered', async () => {
    await userTurn('w1', { stop: 'max_turn_requests' });
    pendingPermission = true;
    await advance(WORK_WAIT_MS);
    assert.deepEqual(continuations('w1'), []);
    assert.equal(auto.pending().length, 1);
    pendingPermission = false;
    await advance(1_000);
    assert.equal(continuations('w1').length, 1);
  });

  test('a message the user sent meanwhile withdraws it', async () => {
    await userTurn('w1', { stop: 'max_turn_requests' });
    await userTurn('w1', { stop: 'end_turn' }, 'Actually, stop there');
    await advance(WORK_WAIT_MS);
    assert.deepEqual(continuations('w1'), []);
  });

  test('shouldStart withdraws a continuation still queued when the user sent something first', async () => {
    await userTurn('w1', { stop: 'max_turn_requests' });
    let release!: () => void;
    lockGate = new Promise((resolve) => { release = resolve; });
    await advance(WORK_WAIT_MS);
    // It is opening: the user's message gets there first.
    lockGate = null;
    await userTurn('w1', { stop: 'end_turn' }, 'Never mind');
    release();
    await settle();
    assert.deepEqual(continuations('w1'), []);
    assert.equal(userMessages('w1').some((message) => message.metadata?.autoContinue), false, 'nothing was saved or shown');
  });

  test('a turn the user stopped never continues', async () => {
    script('w1', { stop: 'max_turn_requests', gate: new Promise(() => {}) });
    const started = await hub.startTurn({ chatId: 'w1', nodeId: 'w1', turnId: 'stopped-turn', text: 'Do it', session: sessionFor('w1'), humanOrigin: true });
    hub.cancel('w1', 'stopped-turn');
    await started.done;
    await advance(WORK_WAIT_MS);
    assert.deepEqual(continuations('w1'), []);
  });

  test('a process that starts after the turn ended picks nothing up (nothing runs after a restart)', async () => {
    auto.stop();
    await userTurn('w1', { stop: 'max_turn_requests' });
    auto = makeAuto();
    await advance(WORK_WAIT_MS);
    assert.deepEqual(continuations('w1'), []);
    assert.equal(auto.pending().length, 0);
  });
});

describe('the user\'s own conversations', () => {
  beforeEach(() => seedChat('u1'));

  test('continue only when the setting is on, after five minutes', async () => {
    await userTurn('u1', { stop: 'max_tokens' });
    assert.equal(auto.pending().length, 0, 'off by default');
    chatsOn = true;
    await userTurn('u1', { stop: 'max_tokens' });
    await advance(WORK_WAIT_MS);
    assert.deepEqual(continuations('u1'), [], 'a minute is a work conversation\'s wait');
    await advance(USER_WAIT_MS - WORK_WAIT_MS);
    assert.equal(continuations('u1').length, 1);
  });

  test('turning the setting off before it is due drops it', async () => {
    chatsOn = true;
    await userTurn('u1', { stop: 'max_tokens' });
    chatsOn = false;
    await advance(USER_WAIT_MS);
    assert.deepEqual(continuations('u1'), []);
  });

  test('the continued turn follows the conversation\'s own mode: it is not a Michi-driven turn', async () => {
    chatsOn = true;
    await userTurn('u1', { stop: 'max_turn_requests' });
    await advance(USER_WAIT_MS);
    const guard = guards.get('u1:2');
    assert.ok(guard);
    assert.equal(guard.michiDriven, false);
    assert.equal(isGuarded(guard), false, 'the chat\'s mode decides, as for the user\'s "continue"');
  });

  test('a sign-in failure is left to the Interrupted notice', async () => {
    chatsOn = true;
    await userTurn('u1', { fail: 'ExpiredTokenException: the token expired' });
    assert.equal(auto.pending().length, 0);
  });
});

describe('across conversations', () => {
  test('at most three run at once; the rest wait for a slot', async () => {
    const gates: Array<() => void> = [];
    for (const id of ['a', 'b', 'c', 'd']) {
      seedChat(id);
      makeWorkConversation(id);
      await userTurn(id, { stop: 'max_turn_requests' });
      script(id, { stop: 'end_turn', gate: new Promise<void>((resolve) => { gates.push(resolve); }) });
    }
    now += WORK_WAIT_MS;
    auto.tick();
    await settle();
    const running = () => ['a', 'b', 'c', 'd'].filter((id) => continuations(id).length > 0);
    assert.equal(running().length, 3);
    assert.equal(auto.pending().length, 1);
    gates[0]();
    await settle();
    auto.tick();
    await settle();
    assert.equal(running().length, 4);
    for (const open of gates) open();
    await settle();
  });

  test('check-in, assistant and maintenance conversations never continue', async () => {
    getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,maintenance_job_id,created_at) VALUES ('m1','ws','chat','idle','job-1',1)").run();
    scripts.set('m1', []);
    sent.set('m1', []);
    makeWorkConversation('m1');
    await userTurn('m1', { stop: 'max_turn_requests' });
    assert.equal(auto.pending().length, 0);
  });
});
