import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode, saveNode, saveWorkspace } from '../src/services/dbRepository';
import { resolveChatUltracode, writeNodeUltracode } from '../src/services/chatUltracode';
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-chat-ultracode-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  saveWorkspace({ id: 'ws', name: 'Test', owner_user_id: 'alice', created_at: 1, updated_at: 1 });
  chat('a'); chat('b');
});
afterEach(() => {
  mock.restoreAll();
  closeDb(); fs.rmSync(dir, { recursive: true, force: true });
  if (originalCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = originalCloud;
  if (originalDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = originalDataDir;
});

test('Ultracode is a per-chat choice, off by default, that graph snapshots cannot write', () => {
  assert.equal(getNode('a')?.ultracode, 0, 'a new chat starts with it off');
  assert.equal(resolveChatUltracode('a'), false);
  writeNodeUltracode('a', true);
  assert.equal(resolveChatUltracode('a'), true);
  assert.equal(resolveChatUltracode('b'), false, 'per chat');
  // A delayed graph snapshot carries the column (or an older value): ignored.
  chat('a', { ultracode: 0 });
  assert.equal(resolveChatUltracode('a'), true);
  writeNodeUltracode('a', false);
  assert.equal(resolveChatUltracode('a'), false);
});

test('only an existing chat of the owner takes it; a maintenance transcript never does', () => {
  assert.throws(() => writeNodeUltracode('missing', true), { name: 'DomainError', kind: 'not_found' });
  saveNode({ id: 'doc', workspace_id: 'ws', kind: 'digest', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 } as Parameters<typeof saveNode>[0]);
  assert.throws(() => writeNodeUltracode('doc', true), { kind: 'not_found' });
  getDb().prepare('UPDATE nodes SET maintenance_job_id = ? WHERE id = ?').run('job-1', 'b');
  assert.throws(() => writeNodeUltracode('b', true), { kind: 'invalid_argument' });
  assert.equal(resolveChatUltracode('b'), false);
  getDb().prepare('UPDATE nodes SET deleted_at = 5 WHERE id = ?').run('a');
  assert.throws(() => writeNodeUltracode('a', true), { kind: 'not_found' });
  process.env.MICHI_CLOUD = '1';
  chat('c');
  assert.throws(() => writeNodeUltracode('c', true, 'bob'), { kind: 'not_found' });
  writeNodeUltracode('c', true, 'alice');
  assert.equal(resolveChatUltracode('c', 'alice'), true);
  assert.equal(resolveChatUltracode('c', 'bob'), false, 'another user reads it as off');
});

test("the runtime host reads a chat node's choice; an Agent Run has none", () => {
  writeNodeUltracode('a', true);
  const features = createMichiRuntimeHost().config.features;
  assert.equal(features.ultracode?.(chatOwner('a'), null), true);
  assert.equal(features.ultracode?.(chatOwner('b'), null), false);
  assert.equal(features.ultracode?.(runOwner('run-1', 'attempt-1'), null), false);
  assert.equal(features.ultracode?.(undefined, null), false);
});

test('PUT /nodes/:nodeId/ultracode saves the choice, then applies it to the live session', async () => {
  const applied: boolean[] = [];
  let failApply = false;
  const live = {
    setUltracode: async (enabled: boolean) => {
      if (failApply) throw new Error('control timed out');
      applied.push(enabled);
    },
    getSessionState: () => ({ runtimeId: 'claude', ultracode: { requested: applied.at(-1) ?? false, active: applied.at(-1) ?? false, available: true } }),
  };
  const registry = require('../src/agents/sessionRegistry');
  mock.method(registry, 'getSessionForOwner', (nodeId: string) => (nodeId === 'a' ? live : null));
  const warnings: unknown[][] = [];
  mock.method(require('../src/services/logger').log, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const app = express(); app.use(express.json());
  app.use('/api', setupPersistenceRoutes());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const put = (nodeId: string, body: unknown) => fetch(`${base}/nodes/${nodeId}/ultracode`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await put('a', { enabled: 'yes' })).status, 400);
    assert.equal(resolveChatUltracode('a'), false);
    const on = await put('a', { enabled: true });
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { enabled: true, sessionState: { runtimeId: 'claude', ultracode: { requested: true, active: true, available: true } } });
    assert.deepEqual(applied, [true]);
    assert.equal(resolveChatUltracode('a'), true);
    // No live session: saved, and the next spawn reads it.
    const idle = await put('b', { enabled: true });
    assert.deepEqual(await idle.json(), { enabled: true });
    assert.equal(resolveChatUltracode('b'), true);
    // The live session failing to take it does not undo the saved choice.
    failApply = true;
    const off = await put('a', { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(resolveChatUltracode('a'), false);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][1]), /ultracode could not be applied/);
    // An unsaved chat needs its graph prerequisite, as permissions do.
    assert.equal((await put('new-chat', { enabled: true })).status, 409);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
