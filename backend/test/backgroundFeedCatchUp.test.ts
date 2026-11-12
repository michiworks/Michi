import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { NO_APPLIED_TURN_CURSOR } from 'michi-shared';
import { chatHub } from '../src/agents/chatHub';
import { setupMichiRoutes } from '../src/routes/michi';
import type { ChatManager } from '../src/services/chatManager';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';

async function listen(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', setupMichiRoutes({} as ChatManager));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

/** Read SSE frames until `done` holds or the stream ends; resolves the frames read. */
async function readFrames(response: Response, done: (frames: string[]) => boolean): Promise<{ frames: string[]; ended: boolean }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: string[] = [];
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch {
      return { frames, ended: true };
    }
    if (chunk.done) return { frames, ended: true };
    buffer += decoder.decode(chunk.value, { stream: true });
    let split = buffer.indexOf('\n\n');
    while (split >= 0) {
      frames.push(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf('\n\n');
    }
    if (done(frames)) {
      await reader.cancel();
      return { frames, ended: false };
    }
  }
}

// 2026-11-09: the feed's opening replay (one ~54 KB session_state per live
// Claude session) passed 1 MiB in one tick; the old limit destroyed every
// subscription ~100 ms in, so self-turns never reached a window.
test('the background feed keeps a multi-megabyte opening replay over a real socket', async (t) => {
  const text = 'x'.repeat(52_000);
  const subscribe = t.mock.method(chatHub, 'subscribeBackground', (sub: Parameters<typeof chatHub.subscribeBackground>[0]) => {
    for (let seq = 0; seq < 100; seq += 1) {
      sub.send('n-burst', { event: 'chunk', data: { chatId: 'n-burst', nodeId: 'n-burst', turnId: 'self-burst', assistantId: 'a', seq, text } }, true);
    }
    return () => {};
  });
  t.after(() => subscribe.mock.restore());
  const base = await listen(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/chats/background/subscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursors: {}, includeForeground: true }), signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const chunks = (frames: string[]) => frames.filter((frame) => frame.startsWith('event: chunk\n')).length;
  const { frames, ended } = await readFrames(response, (read) => chunks(read) === 100);
  assert.equal(ended, false, 'the subscription is still open');
  assert.equal(chunks(frames), 100, 'every replayed frame arrived');
});

test('a no-applied-turn cursor is answered with a gap when SQLite holds a turn', () => {
  const gaps: Array<[string, { turnId: string; seq: number }]> = [];
  const detach = chatHub.subscribeBackground({
    includeForeground: true,
    send: () => {},
    gap: (chatId, cursor) => { gaps.push([chatId, cursor]); },
    close: () => {},
  }, {
    cursors: { 'chat-ran-away': { ...NO_APPLIED_TURN_CURSOR }, 'chat-never-ran': { ...NO_APPLIED_TURN_CURSOR } },
    durableCursors: { 'chat-ran-away': { turnId: 'turn-1', seq: 7 } },
  });
  detach();
  assert.deepEqual(gaps, [['chat-ran-away', { turnId: 'turn-1', seq: 7 }]]);
});

describe('durable cursors over HTTP', () => {
  let dir = '';
  const previousDataDir = process.env.MICHI_DATA_DIR;
  const previousCloud = process.env.MICHI_CLOUD;

  before(() => {
    delete process.env.MICHI_CLOUD;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-feed-catch-up-'));
    process.env.MICHI_DATA_DIR = dir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws', name: 'Workspace', created_at: 1, updated_at: 1 });
    saveTree({ id: 'tree', workspace_id: 'ws', root_node_id: 'n-ran', created_at: 1, last_active_at: 1 });
    saveNode({ id: 'n-ran', workspace_id: 'ws', tree_id: 'tree', parent_node_id: null, kind: 'chat', title: 'ran',
      status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1, last_applied_turn_id: 'turn-9', last_applied_seq: 12 });
    saveNode({ id: 'n-new', workspace_id: 'ws', tree_id: 'tree', parent_node_id: 'n-ran', kind: 'chat', title: 'new',
      status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 2 });
  });

  after(() => {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousDataDir;
    if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud;
  });

  test('POST /chats/background/cursors answers what SQLite applied, for known chats only', async (t) => {
    const base = await listen(t);
    const response = await fetch(`${base}/chats/background/cursors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatIds: ['n-ran', 'n-new', 'n-missing', 42, ''] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cursors: { 'n-ran': { turnId: 'turn-9', seq: 12, nodeId: 'n-ran' } } });

    const invalid = await fetch(`${base}/chats/background/cursors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatIds: 'n-ran' }),
    });
    assert.equal(invalid.status, 400);
  });

  test('cloud mode answers only an authenticated owner', async (t) => {
    process.env.MICHI_CLOUD = '1';
    t.after(() => { delete process.env.MICHI_CLOUD; });
    const base = await listen(t);
    const response = await fetch(`${base}/chats/background/cursors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatIds: ['n-ran'] }),
    });
    assert.equal(response.status, 401);
  });

  test('a window that knows a chat without its turn gets a replay gap on subscribe', async (t) => {
    const base = await listen(t);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(`${base}/chats/background/subscribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursors: { 'n-ran': NO_APPLIED_TURN_CURSOR, 'n-new': NO_APPLIED_TURN_CURSOR }, includeForeground: true }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const isGap = (frame: string) => frame.startsWith('event: background_sync_required\n');
    const { frames } = await readFrames(response, (read) => read.some(isGap));
    const gaps = frames.filter(isGap).map((frame) => JSON.parse(frame.split('\ndata: ')[1]));
    assert.deepEqual(gaps, [{ chatId: 'n-ran', nodeId: 'n-ran', turnId: 'turn-9', seq: 12 }]);
  });
});
