import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace } from '../src/services/dbRepository';
import { resolveChatServiceTier, writeNodeServiceTier } from '../src/services/chatServiceTier';
import { setupPersistenceRoutes } from '../src/routes/persistence';
import { createMichiRuntimeHost } from '../src/agents/michiRuntimeHost';
import { chatOwner, runOwner } from './helpers/owners';

const originalCloud = process.env.MICHI_CLOUD;
const originalDataDir = process.env.MICHI_DATA_DIR;
let dir: string;
const chat = (id: string, extra: Record<string, unknown> = {}) => saveNode({
  id, workspace_id: 'ws', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1, ...extra,
} as Parameters<typeof saveNode>[0]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-chat-service-tier-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  saveWorkspace({ id: 'ws', name: 'Test', owner_user_id: 'alice', created_at: 1, updated_at: 1 });
  chat('a'); chat('b');
});
afterEach(() => {
  closeDb(); fs.rmSync(dir, { recursive: true, force: true });
  if (originalCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = originalCloud;
  if (originalDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = originalDataDir;
});

test('the speed tier is a per-chat choice, standard by default, that graph snapshots cannot write', () => {
  assert.equal(resolveChatServiceTier('a'), null, 'a new chat starts at standard');
  writeNodeServiceTier('a', 'ultrafast');
  assert.equal(resolveChatServiceTier('a'), 'ultrafast');
  assert.equal(resolveChatServiceTier('b'), null, 'per chat');
  // A delayed graph snapshot carries the column (or an older value): ignored.
  chat('a', { service_tier: null });
  assert.equal(resolveChatServiceTier('a'), 'ultrafast');
  writeNodeServiceTier('a', null);
  assert.equal(resolveChatServiceTier('a'), null);
  assert.throws(() => writeNodeServiceTier('a', 'Ultra Fast!'), { kind: 'invalid_argument' });
});

test('only an existing chat of the owner has one', () => {
  assert.throws(() => writeNodeServiceTier('missing', 'ultrafast'), { name: 'DomainError', kind: 'not_found' });
  assert.equal(resolveChatServiceTier('missing'), undefined);
  getDb().prepare('UPDATE nodes SET deleted_at = 5 WHERE id = ?').run('a');
  assert.throws(() => writeNodeServiceTier('a', 'ultrafast'), { kind: 'not_found' });
  process.env.MICHI_CLOUD = '1';
  chat('c');
  assert.throws(() => writeNodeServiceTier('c', 'ultrafast', 'bob'), { kind: 'not_found' });
  writeNodeServiceTier('c', 'ultrafast', 'alice');
  assert.equal(resolveChatServiceTier('c', 'alice'), 'ultrafast');
  assert.equal(resolveChatServiceTier('c', 'bob'), undefined, 'another user reads no choice');
});

test("the runtime host reads a chat node's tier; an Agent Run has none", () => {
  writeNodeServiceTier('a', 'ultrafast');
  const features = createMichiRuntimeHost().config.features;
  assert.equal(features.serviceTier?.(chatOwner('a'), null), 'ultrafast');
  assert.equal(features.serviceTier?.(chatOwner('b'), null), null);
  assert.equal(features.serviceTier?.(runOwner('run-1', 'attempt-1'), null), undefined);
  assert.equal(features.serviceTier?.(undefined, null), undefined);
});

test('PUT /nodes/:nodeId/service-tier saves the tier', async () => {
  const app = express(); app.use(express.json());
  app.use('/api', setupPersistenceRoutes());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const put = (nodeId: string, body: unknown) => fetch(`${base}/nodes/${nodeId}/service-tier`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await put('a', { serviceTier: 42 })).status, 400);
    assert.equal((await put('a', {})).status, 400, 'standard is an explicit null');
    const on = await put('a', { serviceTier: 'ultrafast' });
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { serviceTier: 'ultrafast' });
    assert.equal(resolveChatServiceTier('a'), 'ultrafast');
    assert.deepEqual(await (await put('a', { serviceTier: null })).json(), { serviceTier: null });
    assert.equal(resolveChatServiceTier('a'), null);
    // An unsaved chat needs its graph prerequisite, as Ultracode does.
    assert.equal((await put('new-chat', { serviceTier: 'ultrafast' })).status, 409);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
