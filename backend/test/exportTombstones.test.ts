/**
 * Admin and backup exports carry only live data: a deleted workspace and a
 * purged node keep tombstone rows (purged_at) until GC, and neither export may
 * include them. Owner scoping must not treat an empty user id as "no owner
 * check".
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import { setupAdminRoutes } from '../src/routes/admin';
import { setupBackupRoutes } from '../src/routes/backup';
import { setupPersistenceRoutes } from '../src/routes/persistence';
import { closeAuditDb, closeDb, getDb, initDb, runInTransaction } from '../src/services/db';
import {
  deleteWorkspace, purgeWorkspaceInTransaction, purgeWorkspaceNodes, saveMessage, saveNode, saveWorkspace,
} from '../src/services/dbRepository';
import { createMemory } from '../src/services/memory/memoryService';
import { createPage } from '../src/services/pages/repository';
import { structureEvents } from '../src/services/structureEvents';
import { createAuthUser } from './helpers/authUsers';

let dataDir: string;
let server: ReturnType<typeof express.application.listen> | undefined;
let baseUrl: string;

function seedWorkspace(id: string, owner: string): void {
  saveWorkspace({ id, name: id, cwd: null, created_at: 1, updated_at: 1, settings: null, owner_user_id: owner });
}

/** Nodes without a Tree keep their tombstone row after deleteWorkspace (no Tree FK cascade). */
function seedNode(workspaceId: string, id: string): void {
  saveNode({ id, workspace_id: workspaceId, kind: 'chat', title: id, status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
  saveMessage({ id: `m-${id}`, node_id: id, role: 'user', content: `body of ${id}`, seq: 1, created_at: 1 });
}

function seedOwnerWithTombstones(): void {
  seedWorkspace('ws-keep', 'owner-a');
  seedWorkspace('ws-gone', 'owner-a');
  seedWorkspace('ws-other', 'owner-b');
  seedNode('ws-keep', 'n-keep');
  seedNode('ws-keep', 'n-keep-purged');
  seedNode('ws-gone', 'n-gone');
  seedNode('ws-other', 'n-other');
  deleteWorkspace('ws-gone', 'owner-a');
  purgeWorkspaceNodes('ws-keep', ['n-keep-purged']);
  const tombstones = getDb().prepare('SELECT id FROM nodes WHERE purged_at IS NOT NULL ORDER BY id').all() as Array<{ id: string }>;
  assert.deepEqual(tombstones.map((row) => row.id), ['n-gone', 'n-keep-purged']);
}

/** A workspace with rows in every table a workspace purge clears. */
function seedPurgeable(workspaceId: string): void {
  seedWorkspace(workspaceId, 'owner-a');
  seedNode(workspaceId, `n-${workspaceId}`);
  createMemory({ ownerUserId: 'owner-a' }, { scope: { kind: 'workspace', workspaceId }, kind: 'fact',
    body: `remember ${workspaceId}`, status: 'active', origin: 'explicit' });
  getDb().prepare(`INSERT INTO memory_extraction_cursors (workspace_id, owner_user_id, completion_cursor, created_at, updated_at)
    VALUES (?, 'owner-a', 0, 1, 1)`).run(workspaceId);
  createPage({ workspaceId, ownerUserId: 'owner-a', title: 'Notes', now: 1 });
  getDb().prepare(`INSERT INTO scheduled_jobs (id, owner_user_id, workspace_id, name, prompt, schedule, created_at, updated_at)
    VALUES (?, 'owner-a', ?, 'Job', 'Prompt', '{"kind":"every","everySeconds":3600}', 1, 1)`).run(`job-${workspaceId}`, workspaceId);
}

function purgeableRows(workspaceId: string): Record<string, number> {
  const count = (table: string, where = 'workspace_id = ?') =>
    (getDb().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(workspaceId) as { count: number }).count;
  return {
    workspaces: count('workspaces', 'id = ? AND purged_at IS NULL'),
    nodes: count('nodes', 'workspace_id = ? AND purged_at IS NULL'),
    memories: count('memories'),
    memory_scope_versions: count('memory_scope_versions'),
    memory_extraction_cursors: count('memory_extraction_cursors'),
    pages: count('pages'),
    scheduled_jobs: count('scheduled_jobs'),
  };
}

async function startApp(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: req.header('x-test-user') ?? 'owner-a', email: 'admin@example.com', emailVerified: true };
    next();
  });
  app.use('/api', setupBackupRoutes());
  app.use('/api', setupPersistenceRoutes());
  app.use('/api/admin', setupAdminRoutes());
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function request(method: string, route: string, body?: unknown, user = 'owner-a') {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() as any };
}

describe('exports and tombstones', () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-export-tombstones-'));
    process.env.MICHI_DATA_DIR = dataDir;
    process.env.MICHI_CLOUD = '1';
    process.env.MICHI_REQUIRE_AUTH = 'true';
    process.env.MICHI_ADMIN_EMAILS = 'admin@example.com';
    closeDb(); closeAuditDb(); initDb();
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    closeDb(); closeAuditDb();
    delete process.env.MICHI_DATA_DIR;
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_REQUIRE_AUTH;
    delete process.env.MICHI_ADMIN_EMAILS;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('admin export leaves out deleted workspaces and purged nodes, scoped to the owner', async () => {
    createAuthUser(dataDir, 'owner-a');
    seedOwnerWithTombstones();
    await startApp();
    const exported = await request('POST', '/api/admin/users/owner-a/export');
    assert.equal(exported.response.status, 200, JSON.stringify(exported.body));
    assert.deepEqual(exported.body.workspaces.map((row: any) => row.id), ['ws-keep']);
    assert.deepEqual(exported.body.nodes.map((row: any) => row.id), ['n-keep']);
    assert.deepEqual(exported.body.messages.map((row: any) => row.node_id), ['n-keep']);
  });

  test('backup export leaves out deleted workspaces and purged nodes, scoped to the owner', async () => {
    seedOwnerWithTombstones();
    await startApp();
    const exported = await request('GET', '/api/backup/export');
    assert.equal(exported.response.status, 200, JSON.stringify(exported.body));
    assert.deepEqual(exported.body.workspaces.map((entry: any) => entry.workspace.id), ['ws-keep']);
    assert.deepEqual(exported.body.workspaces[0].nodes.map((row: any) => row.id), ['n-keep']);
  });

  test('replace import does not treat an empty user id as unscoped', async () => {
    seedWorkspace('ws-victim', 'owner-b');
    seedNode('ws-victim', 'n-victim');
    runInTransaction(() => purgeWorkspaceInTransaction('ws-victim', ''));
    const victim = getDb().prepare('SELECT purged_at FROM workspaces WHERE id = ?').get('ws-victim') as { purged_at: number | null };
    assert.equal(victim.purged_at, null);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE node_id = ?').get('n-victim') as { count: number }).count, 1);

    await startApp();
    const imported = await request('POST', '/api/backup/import?mode=replace',
      { version: 1, exportedAt: 1, app: 'michi', workspaces: [] }, '');
    assert.equal(imported.response.status, 401);
  });

  test('replace import purges the replaced workspace as deleting it does', async () => {
    seedPurgeable('ws-deleted');
    seedPurgeable('ws-replaced');
    const seeded = { workspaces: 1, nodes: 1, memories: 1, memory_scope_versions: 1, memory_extraction_cursors: 1,
      pages: 1, scheduled_jobs: 1 };
    assert.deepEqual(purgeableRows('ws-replaced'), seeded);
    structureEvents.flush();
    const purged: string[] = [];
    const unsubscribe = structureEvents.subscribe({ ownerUserId: 'owner-a', send: (event) => {
      for (const change of event.changes) if (change.entity === 'workspace' && change.op === 'purged') purged.push(change.workspaceId);
    } });
    try {
      deleteWorkspace('ws-deleted', 'owner-a');
      await startApp();
      const imported = await request('POST', '/api/backup/import?mode=replace', { version: 1, exportedAt: 1, app: 'michi',
        workspaces: [{ workspace: { id: 'ws-replaced', name: 'Restored', created_at: 1, updated_at: 1 },
          trees: [], nodes: [], edges: [], messages: [], contexts: [] }] });
      assert.equal(imported.response.status, 200, JSON.stringify(imported.body));
      structureEvents.flush();
    } finally {
      unsubscribe();
    }
    const cleared = Object.fromEntries(Object.keys(seeded).map((table) => [table, 0]));
    assert.deepEqual(purgeableRows('ws-deleted'), cleared);
    assert.deepEqual(purgeableRows('ws-replaced'), cleared);
    assert.deepEqual(purged, ['ws-deleted', 'ws-replaced']);
  });

  test('node PATCH does not write to a purged node', async () => {
    seedOwnerWithTombstones();
    await startApp();
    const patched = await request('PATCH', '/api/nodes/n-keep-purged', { title: 'revived' });
    assert.equal(patched.response.status, 200, JSON.stringify(patched.body));
    const row = getDb().prepare('SELECT title FROM nodes WHERE id = ?').get('n-keep-purged') as { title: string };
    assert.equal(row.title, 'n-keep-purged');
    const live = await request('PATCH', '/api/nodes/n-keep', { title: 'renamed' });
    assert.equal(live.response.status, 200);
    assert.equal((getDb().prepare('SELECT title FROM nodes WHERE id = ?').get('n-keep') as { title: string }).title, 'renamed');
  });
});
