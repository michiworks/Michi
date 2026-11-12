import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import type { AttentionNotificationV1 } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { setupAttentionRoutes } from '../src/routes/attention';
import { setupMichiRoutes } from '../src/routes/michi';
import { setupPersistenceRoutes } from '../src/routes/persistence';
import { AttentionFeed, attentionFeed } from '../src/services/attention/attentionFeed';
import { AttentionService } from '../src/services/attention/attentionService';
import { subscribeNodeCompletionSeen, subscribePermissionAnswered, type PermissionAnswered } from '../src/services/attentionSignals';
import { completeTurn, done, manualClock, records, turnStart } from './helpers/attentionHarness';
import { chatHub } from '../src/agents/chatHub';
import { clearAllSessions, registerSession } from '../src/agents/sessionRegistry';
import type { ChatManager } from '../src/services/chatManager';

// The HTTP surface of server attention, driven in-process through the Express
// routers (no listening socket): the claim route, the attention frames on the
// background feed, and the capability.

let dir: string;
const saved: Record<string, string | undefined> = {};

class FakeResponse extends EventEmitter {
  statusCode = 200;
  body: unknown = undefined;
  chunks: string[] = [];
  headers: Record<string, string> = {};
  writableEnded = false;
  destroyed = false;
  writableLength = 0;
  status(code: number) { this.statusCode = code; return this; }
  json(body: unknown) { this.body = body; this.end(); return this; }
  setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; }
  flushHeaders() {}
  write(chunk: string) { this.chunks.push(String(chunk)); return true; }
  end() { this.writableEnded = true; this.emit('finish'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  /** The client went away. */
  hangUp() { this.emit('close'); }
  frames(): Array<{ event: string; data: any }> {
    return this.chunks.join('').split('\n\n').filter((frame) => frame.startsWith('event: ')).map((frame) => {
      const [eventLine, dataLine] = frame.split('\n');
      return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) };
    });
  }
}

/** Runs one request through a router; resolves when it answered, or on the next turn for a stream. */
async function invoke(router: express.Router, method: string, url: string, options: { body?: unknown; user?: string } = {}) {
  const req = Object.assign(new EventEmitter(), {
    method, url, originalUrl: url, headers: { 'content-type': 'application/json' }, body: options.body ?? {},
    ...(options.user ? { user: { id: options.user } } : {}),
  });
  const res = new FakeResponse();
  await new Promise<void>((resolve, reject) => {
    res.once('finish', () => resolve());
    (router as unknown as (rq: unknown, rs: unknown, next: (error?: unknown) => void) => void)(req, res, (error?: unknown) => {
      if (error) reject(error); else { res.statusCode = 404; resolve(); }
    });
    setImmediate(resolve);
  });
  return res;
}

function seedRecord(id: string, ownerUserId: string): void {
  getDb().prepare(`INSERT INTO attention_notifications
    (id, owner_user_id, workspace_id, target_type, target_id, key, fact, kind, reason, title, body, created_at)
    VALUES (?, ?, 'ws-1', 'node', 'n-1', ?, 'permission:t:1', 'needs_input', 'approval', 'Tool approval needed', 'ls', 1)`)
    .run(id, ownerUserId, `node:n-1:${id}`);
}

const service = () => new AttentionService({ presence: { isTargetVisibleInFocusedWindow: () => false } });

beforeEach(() => {
  for (const key of ['MICHI_DATA_DIR', 'MICHI_CLOUD', 'MICHI_REQUIRE_AUTH']) saved[key] = process.env[key];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-attention-routes-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  delete process.env.MICHI_REQUIRE_AUTH;
  closeDb();
  initDb();
  getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES ('ws-1','W','alice',1,1)").run();
});

afterEach(() => {
  attentionFeed.disconnect();
  closeDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /attention/notifications/:id/claim', () => {
  test('the first window wins and later claimers are told who did', async () => {
    seedRecord('attn-1', 'local-user');
    const router = setupAttentionRoutes(service());
    const first = await invoke(router, 'POST', '/attention/notifications/attn-1/claim', { body: { windowId: 'w-1' } });
    assert.deepEqual([first.statusCode, first.body], [200, { claimed: true, claimedByWindowId: 'w-1', status: 'active' }]);
    const second = await invoke(router, 'POST', '/attention/notifications/attn-1/claim', { body: { windowId: 'w-2' } });
    assert.deepEqual([second.statusCode, second.body], [200, { claimed: false, claimedByWindowId: 'w-1', status: 'active' }]);
    const missing = await invoke(router, 'POST', '/attention/notifications/attn-404/claim', { body: { windowId: 'w-1' } });
    assert.equal(missing.statusCode, 404);
    for (const body of [{}, { windowId: '' }, { windowId: 7 }, { windowId: 'x'.repeat(201) }]) {
      assert.equal((await invoke(router, 'POST', '/attention/notifications/attn-1/claim', { body })).statusCode, 400);
    }
  });

  test('in the cloud a claim needs the signed-in owner of the record', async () => {
    process.env.MICHI_CLOUD = '1';
    seedRecord('attn-alice', 'alice');
    const router = setupAttentionRoutes(service());
    const anonymous = await invoke(router, 'POST', '/attention/notifications/attn-alice/claim', { body: { windowId: 'w-1' } });
    assert.equal(anonymous.statusCode, 401);
    const bob = await invoke(router, 'POST', '/attention/notifications/attn-alice/claim', { body: { windowId: 'w-1' }, user: 'bob' });
    assert.equal(bob.statusCode, 404, 'another account\'s record looks like no record');
    const alice = await invoke(router, 'POST', '/attention/notifications/attn-alice/claim', { body: { windowId: 'w-1' }, user: 'alice' });
    assert.deepEqual([alice.statusCode, (alice.body as { claimed: boolean }).claimed], [200, true]);
  });
});

describe('attention frames on the background feed', () => {
  // The feed also carries other control frames (e.g. the structure cursor it opens with).
  const attentionFrames = (frames: Array<{ event: string; data: any }>) => frames.filter((frame) => frame.event.startsWith('attention_'));
  const record: AttentionNotificationV1 = {
    id: 'attn-1', key: 'node:n-1', kind: 'needs_input', reason: 'approval', title: 'Tool approval needed', body: 'ls',
    target: { type: 'node', nodeId: 'n-1', workspaceId: 'ws-1' }, createdAt: 1, claimedByWindowId: null, claimedAt: null,
  };

  test('a subscription gets the owner\'s snapshot, then live frames, until the client goes away', async () => {
    const owners: string[] = [];
    attentionFeed.connect((owner) => { owners.push(owner); return [record]; });
    const router = setupMichiRoutes({} as ChatManager);
    const res = await invoke(router, 'POST', '/chats/background/subscribe', { body: { cursors: {}, includeForeground: true } });
    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.deepEqual(owners, ['local-user'], 'the desktop owner');
    assert.deepEqual(attentionFrames(res.frames()), [{ event: 'attention_snapshot', data: { protocol: 'v1', notifications: [record] } }]);
    attentionFeed.publishResolved('local-user', { id: 'attn-1', key: 'node:n-1', target: record.target, reason: 'answered', resolvedAt: 2 });
    attentionFeed.publishNotification('someone-else', { ...record, id: 'attn-other' });
    assert.deepEqual(attentionFrames(res.frames()).slice(1).map((frame) => [frame.event, frame.data.id]), [['attention_resolved', 'attn-1']]);
    assert.equal(attentionFeed.subscriberCount('local-user'), 1);
    res.hangUp();
    assert.equal(attentionFeed.subscriberCount('local-user'), 0, 'res close detaches the subscription');
  });

  test('in the cloud the feed is the signed-in account\'s', async () => {
    process.env.MICHI_CLOUD = '1';
    const owners: string[] = [];
    attentionFeed.connect((owner) => { owners.push(owner); return []; });
    const router = setupMichiRoutes({} as ChatManager);
    const res = await invoke(router, 'POST', '/chats/background/subscribe', { body: { cursors: {} }, user: 'alice' });
    assert.deepEqual(owners, ['alice']);
    res.hangUp();
    const anonymous = await invoke(router, 'POST', '/chats/background/subscribe', { body: { cursors: {} } });
    assert.equal(anonymous.statusCode, 401);
  });

  test('without a connected attention service the feed carries no attention frame', async () => {
    const router = setupMichiRoutes({} as ChatManager);
    const res = await invoke(router, 'POST', '/chats/background/subscribe', { body: { cursors: {} } });
    assert.deepEqual(attentionFrames(res.frames()), []);
    res.hangUp();
  });
});

test('answering an approval through the permission route signals the attention service', async (t) => {
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES ('n-1','ws-1','chat','idle',1)").run();
  registerSession({
    id: 'n-1', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
    send: async function* () {}, cancel: () => {}, respondToPermission: () => {}, cancelPermission: () => {},
  });
  t.after(() => clearAllSessions());
  let pending: unknown = { requestId: 4, turnId: 't-1', title: 'shell', options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }] };
  t.mock.method(chatHub, 'getPendingPermission', () => pending);
  t.mock.method(chatHub, 'resolvePermission', () => { pending = null; });
  const answered: PermissionAnswered[] = [];
  t.after(subscribePermissionAnswered((event) => answered.push(event)));
  const router = setupMichiRoutes({} as ChatManager);
  const approve = await invoke(router, 'POST', '/chats/n-1/permission-response', { body: { requestId: 4, optionId: 'allow_once' } });
  assert.equal(approve.statusCode, 200);
  pending = { requestId: 5, turnId: 't-1', title: 'shell', options: [] };
  const deny = await invoke(router, 'POST', '/chats/n-1/permission-response', { body: { requestId: 5, cancel: true } });
  assert.equal(deny.statusCode, 200);
  const stale = await invoke(router, 'POST', '/chats/n-1/permission-response', { body: { requestId: 5, cancel: true } });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(answered, [{ nodeId: 'n-1', turnId: 't-1', requestId: 4 }, { nodeId: 'n-1', turnId: 't-1', requestId: 5 }]);
});

test('a seen mark for a Michi assistant conversation (the ⌘J panel) is accepted and resolves its reply', async (t) => {
  // The assistant's hidden system workspace, as backend/src/assistant/store.ts provisions it.
  getDb().prepare("INSERT INTO workspaces(id,name,settings,created_at,updated_at) VALUES ('ws-assistant','Michi assistant',?,1,1)")
    .run(JSON.stringify({ system: 'assistant', assistant: { nodeId: 'n-assistant' } }));
  getDb().prepare(`INSERT INTO trees(id,workspace_id,root_node_id,last_active_at,created_at)
    VALUES ('t-assistant','ws-assistant','n-assistant',1,1)`).run();
  getDb().prepare(`INSERT INTO nodes(id,workspace_id,tree_id,kind,status,title,created_at)
    VALUES ('n-assistant','ws-assistant','t-assistant','chat','idle','Assistant',1)`).run();
  const clock = manualClock();
  const attention = new AttentionService({ presence: { isTargetVisibleInFocusedWindow: () => false }, feed: new AttentionFeed(), clock });
  attention.start();
  t.after(() => attention.stop());
  t.after(subscribeNodeCompletionSeen((mark) => attention.nodeCompletionSeen(mark)));
  attention.observeChatEvent(turnStart('n-assistant', 't-1'));
  completeTurn('n-assistant', 'ws-assistant', 't-1');
  attention.observeChatEvent(done('n-assistant', 't-1'));
  clock.advance(1_000);
  assert.deepEqual(records().map((row) => [row.key, row.status]), [['node:n-assistant', 'active']]);
  const res = await invoke(setupPersistenceRoutes(), 'POST', '/workspaces/ws-assistant/commands', { body: {
    operationId: 'view-assistant',
    commands: [{ type: 'node.patch', payload: { id: 'n-assistant', viewed_at: 9, seen_completion_seq: 1 } }],
  } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(records().map((row) => [row.status, row.resolve_reason]), [['resolved', 'seen']]);
});

test('the capability is advertised next to the existing ones', async () => {
  const res = await invoke(setupPersistenceRoutes(), 'GET', '/persistence/capabilities');
  const body = res.body as Record<string, unknown>;
  assert.equal(body.attention, 'v1');
  assert.equal(body.paneInspection, 'v1');
  assert.equal(body.streamTransport, 'websocket-v1');
});
