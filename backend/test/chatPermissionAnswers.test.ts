import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatStreamEvent, DurableTurnSnapshot } from 'michi-shared';
import { ChatHub, chatHub } from '../src/agents/chatHub';
import { clearAllSessions, registerSession } from '../src/agents/sessionRegistry';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { answerChatPermission } from '../src/services/chatPermissionAnswers';
import { subscribePermissionAnswered, type PermissionAnswered } from '../src/services/attentionSignals';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace } from '../src/services/dbRepository';

// isolateUserDirs (the test preload) points MICHI_DATA_DIR at a temporary directory for this file.

describe('answerChatPermission', () => {
  const responses: unknown[][] = [];
  const cancels: number[] = [];
  const answered: PermissionAnswered[] = [];
  let unsubscribe = () => {};

  before(() => {
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws', name: 'Approvals', created_at: 1, updated_at: 1 });
    saveNode({ id: 'a', workspace_id: 'ws', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
    unsubscribe = subscribePermissionAnswered((event) => answered.push(event));
  });
  afterEach(() => { clearAllSessions(); responses.length = 0; cancels.length = 0; answered.length = 0; });
  after(() => { unsubscribe(); closeDb(); });

  function register(respond = true): void {
    registerSession({
      id: 'a', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
      send: async function* () {}, cancel: () => {},
      ...(respond ? { respondToPermission: (...args: unknown[]) => { responses.push(args); } } : {}),
      cancelPermission: (requestId: number) => { cancels.push(requestId); },
    }, null);
  }

  function pendingOf(t: { mock: { method: typeof import('node:test').mock.method } }) {
    let pending: Record<string, unknown> | null = { requestId: 7, turnId: 'turn-1', title: 'shell', options: [
      { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
      { optionId: 'always', kind: 'allow_always', name: 'Always', disabled: true },
    ] };
    const resolved: number[] = [];
    t.mock.method(chatHub, 'getPendingPermission', () => pending);
    t.mock.method(chatHub, 'resolvePermission', (_chatId: string, requestId: number) => { resolved.push(requestId); pending = null; });
    return resolved;
  }

  test('an unknown chat is 404 and a stale request 409', (t) => {
    pendingOf(t);
    assert.deepEqual(answerChatPermission('a', null, { requestId: 7, optionId: 'allow' }), { ok: false, status: 404, error: 'unknown chat' });
    register();
    assert.deepEqual(answerChatPermission('a', null, { requestId: 8, optionId: 'allow' }),
      { ok: false, status: 409, error: 'Permission request is no longer pending' });
    assert.deepEqual(responses, []);
  });

  test('an option not offered, or disabled, is 400', (t) => {
    pendingOf(t);
    register();
    assert.equal(answerChatPermission('a', null, { requestId: 7, optionId: 'forged' }).ok, false);
    const disabled = answerChatPermission('a', null, { requestId: 7, optionId: 'always' });
    assert.deepEqual(disabled, { ok: false, status: 400, error: 'Invalid permission option' });
    assert.deepEqual(responses, []);
  });

  test('allow answers the session, clears the hub and publishes the answer', (t) => {
    const resolved = pendingOf(t);
    register();
    assert.deepEqual(answerChatPermission('a', null, { requestId: 7, optionId: 'allow' }), { ok: true, nodeId: 'a' });
    assert.deepEqual(responses, [[7, 'allow']]);
    assert.deepEqual(resolved, [7]);
    assert.deepEqual(answered, [{ nodeId: 'a', turnId: 'turn-1', requestId: 7 }]);
    assert.equal(answerChatPermission('a', null, { requestId: 7, optionId: 'allow' }).ok, false, 'answered once');
  });

  test('cancel cancels the request', (t) => {
    const resolved = pendingOf(t);
    register(false);
    assert.deepEqual(answerChatPermission('a', null, { requestId: 7, cancel: true }), { ok: true, nodeId: 'a' });
    assert.deepEqual(cancels, [7]);
    assert.deepEqual(resolved, [7]);
    assert.equal(answered.length, 1);
  });

  test('a session that cannot answer permissions is 400', (t) => {
    pendingOf(t);
    register(false);
    assert.deepEqual(answerChatPermission('a', null, { requestId: 7, optionId: 'allow' }),
      { ok: false, status: 400, error: 'Session does not support permissions' });
  });
});

describe('ChatHub.resolvePermission', () => {
  test('appends permission_resolved once, when it clears the pending request', async () => {
    const noop = (_snapshot: DurableTurnSnapshot) => {};
    const hub = new ChatHub({ retentionMs: 1_000, workspaceIdForNode: () => 'ws', persistence: { begin: noop, checkpoint: noop, finalize: noop } });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    async function* events(): AsyncIterableIterator<NormalizedEvent> {
      yield { kind: 'permission_request', requestId: 42, title: 'Run', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] };
      await blocked;
      yield { kind: 'turn_end', stopReason: 'end_turn' };
    }
    const seen: ChatStreamEvent[] = [];
    hub.subscribeBackground({ send: (_chatId, event) => seen.push(event), close: () => {} });
    hub.startSelfTurn({ chatId: 'c', nodeId: 'n', events: events() });
    while (!hub.getPendingPermission('c')) await new Promise((resolve) => setTimeout(resolve, 1));

    hub.resolvePermission('c', 41);
    assert.ok(hub.getPendingPermission('c'), 'another request id leaves it pending');
    hub.resolvePermission('c', 42);
    hub.resolvePermission('c', 42);
    const resolved = seen.filter((event) => event.event === 'permission_resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].data.requestId, 42);
    assert.equal(typeof resolved[0].data.turnId, 'string');
    assert.equal(hub.getPendingPermission('c'), null);
    release();
  });
});
