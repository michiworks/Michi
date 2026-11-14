/**
 * E-review #6: a check-in node id (`n-cmph-…`, DESIGN-v2 §2.5) is the
 * backend's alone, so the routes that write a node or its tree refuse one
 * (400 `reserved_node_id`) before anything reads it: a permission mode, an
 * Ultracode choice, the durable prerequisite either call may create,
 * extract-tree, trim, restore-trim, a tree move, a purge and a memory
 * setting. The same routes still work for an ordinary node, and the
 * background feed's cursors never name a check-in node (w2-fix D13). Temp
 * MICHI_DATA_DIR per test.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ensureAssistant } from '../src/assistant/store';
import type { ChatManager } from '../src/services/chatManager';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import { setupMemoryRoutes } from '../src/routes/memories';
import { setupMichiRoutes } from '../src/routes/michi';
import { setupPersistenceRoutes } from '../src/routes/persistence';
import { makeCheckinNode } from './helpers/checkinNodes';

describe('the routes that write a node refuse a check-in node id (E-review #6)', () => {
  let tmpDir: string;
  let server: ReturnType<typeof express.application.listen>;
  let base: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-reserved-routes-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api', setupPersistenceRoutes());
    app.use('/api', setupMemoryRoutes());
    app.use('/api', setupMichiRoutes({} as ChatManager));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: response.status, body: json };
  };

  const node = (id: string) => getDb().prepare('SELECT workspace_id, deleted_at, permission_mode, ultracode, memory_mode FROM nodes WHERE id = ?').get(id) as
    { workspace_id: string; deleted_at: number | null; permission_mode: string | null; ultracode: number; memory_mode: string | null } | undefined;

  /** An ordinary chat in workspace ws-a, its own tree. */
  function plainChat(id: string): void {
    getDb().prepare('INSERT INTO trees (id, workspace_id, root_node_id, name, last_active_at, created_at) VALUES (?, ?, ?, NULL, 1, 1)').run(`t-${id}`, 'ws-a', id);
    getDb().prepare("INSERT INTO nodes (id, workspace_id, tree_id, kind, status, created_at) VALUES (?, 'ws-a', ?, 'chat', 'idle', 1)").run(id, `t-${id}`);
  }

  test('no route writes a check-in node or its tree; an ordinary node still goes through', async () => {
    const v = ensureAssistant();
    const s = makeCheckinNode(v.workspaceId, 'run-6');
    saveWorkspace({ id: 'ws-a', name: 'A', cwd: tmpDir, created_at: 1, updated_at: 1, settings: null });
    plainChat('n-plain');
    const forged = 'n-cmph-forged';
    const prerequisite = (nodeId: string, extra: Record<string, unknown> = {}) => ({
      workspace: { id: 'ws-a', name: 'A' }, tree: { id: `t-${nodeId}`, rootNodeId: nodeId }, node: { id: nodeId, kind: 'chat', ...extra },
    });
    const refusals: Array<[string, string, unknown]> = [
      ['PUT', `/nodes/${s}/permissions`, { mode: 'yolo' }],
      ['PUT', `/nodes/${forged}/permissions`, { mode: 'trust', graphPrerequisite: prerequisite(forged) }],
      ['PUT', '/nodes/n-new/permissions', { mode: 'trust', graphPrerequisite: prerequisite('n-new', { parentNodeId: s }) }],
      ['PUT', `/nodes/${s}/ultracode`, { enabled: true }],
      ['PUT', `/nodes/${forged}/ultracode`, { enabled: true, graphPrerequisite: prerequisite(forged) }],
      ['PUT', '/nodes/n-new/ultracode', { enabled: true, graphPrerequisite: prerequisite('n-new', { parentNodeId: s }) }],
      ['PUT', `/nodes/${s}/memory-mode`, { mode: 'off' }],
      ['PUT', `/nodes/${forged}/memory-mode`, { mode: 'off' }],
      ['POST', `/workspaces/${v.workspaceId}/nodes/${s}/extract-tree`, { treeId: 't-extracted' }],
      ['POST', `/workspaces/${v.workspaceId}/nodes/${s}/trim`, { deletedAt: 5, groupId: 'g-1' }],
      ['POST', `/workspaces/${v.workspaceId}/nodes/${s}/restore-trim`, {}],
      ['POST', '/trees/t-cmph-run-6/move', { fromWorkspaceId: v.workspaceId, toWorkspaceId: 'ws-a' }],
      ['DELETE', `/workspaces/${v.workspaceId}/nodes`, { nodeIds: ['n-plain', s] }],
    ];
    for (const [method, route, body] of refusals) {
      const response = await call(method, route, body);
      assert.equal(response.status, 400, `${method} ${route} ${JSON.stringify(response.body)}`);
      assert.equal(response.body.code, 'reserved_node_id', `${method} ${route}`);
    }
    assert.deepEqual({ ...node(s) }, { workspace_id: v.workspaceId, deleted_at: null, permission_mode: null, ultracode: 0, memory_mode: null },
      'S is as the backend made it');
    assert.equal(node(forged), undefined, 'no prerequisite made one');
    assert.equal(node('n-new'), undefined);
    assert.equal((getDb().prepare('SELECT workspace_id FROM trees WHERE id = ?').get('t-cmph-run-6') as { workspace_id: string }).workspace_id, v.workspaceId);
    assert.equal(getDb().prepare('SELECT 1 FROM trees WHERE id = ?').get('t-extracted'), undefined);
    assert.ok(node('n-plain'), 'a purge naming S purges nothing');

    // Control: the same routes for an ordinary chat.
    assert.equal((await call('PUT', '/nodes/n-plain/permissions', { mode: 'trust' })).status, 200);
    assert.equal(node('n-plain')!.permission_mode, 'trust');
    assert.equal((await call('PUT', '/nodes/n-plain/ultracode', { enabled: true })).status, 200);
    assert.equal(node('n-plain')!.ultracode, 1);
    assert.equal((await call('PUT', '/nodes/n-plain/memory-mode', { mode: 'off' })).status, 200);
    assert.equal(node('n-plain')!.memory_mode, 'off');

    // Michi's own conversation V always learns and uses memory: its setting is not the user's to change.
    const fixed = await call('PUT', `/nodes/${v.nodeId}/memory-mode`, { mode: 'use_only' });
    assert.deepEqual([fixed.status, fixed.body.code], [409, 'invalid_state']);
    assert.equal(node(v.nodeId)!.memory_mode, null);
    assert.deepEqual((await call('GET', `/nodes/${v.nodeId}/memory-mode`)).body, { mode: 'learn' });
    assert.equal((await call('POST', '/workspaces/ws-a/nodes/n-plain/trim', { deletedAt: 5, groupId: 'g-2' })).status, 200);
    assert.equal(node('n-plain')!.deleted_at, 5);
    assert.equal((await call('POST', '/workspaces/ws-a/nodes/n-plain/restore-trim', {})).status, 200);
  });

  test('the background feed\'s cursors name no check-in node, even one with applied turns (w2-fix D13)', async () => {
    const v = ensureAssistant();
    const s = makeCheckinNode(v.workspaceId, 'run-7');
    saveWorkspace({ id: 'ws-a', name: 'A', cwd: tmpDir, created_at: 1, updated_at: 1, settings: null });
    plainChat('n-plain');
    const applied = getDb().prepare('UPDATE nodes SET last_applied_turn_id = ?, last_applied_seq = ? WHERE id = ?');
    applied.run('cmp-run-7', 4, s);
    applied.run('turn-1', 2, 'n-plain');
    const response = await call('POST', '/chats/background/cursors', { chatIds: [s, 'n-cmph-forged', 'n-plain'] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { cursors: { 'n-plain': { turnId: 'turn-1', seq: 2, nodeId: 'n-plain' } } });
  });
});
