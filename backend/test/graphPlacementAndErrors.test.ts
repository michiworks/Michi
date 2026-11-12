import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeDb, getDb, getDbPath, initDb } from '../src/services/db';
import { getNode, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { applyWorkspaceCommands, type WorkspaceCommand } from '../src/services/domainCommands';
import { DomainError, type DomainErrorKind } from '../src/services/domainErrors';
import { dbWorker, initDbWorker, shutdownDbWorker } from '../src/services/dbWorkerClient';
import type { EnsureDurableGraphNodeInput } from '../src/services/graphCommands';
import { setupPersistenceRoutes } from '../src/routes/persistence';
import { setupMichiRoutes } from '../src/routes/michi';
import { domainErrorResponse } from '../src/routes/domainErrorResponse';
import { log } from '../src/services/logger';
import { structureEvents } from '../src/services/structureEvents';
import { WINDOW_ID_HEADER, type WorkspaceStructureChangedEvent } from 'michi-shared';
import type { ChatManager } from '../src/services/chatManager';

const originalDataDir = process.env.MICHI_DATA_DIR;
const originalCloud = process.env.MICHI_CLOUD;
const originalRequireAuth = process.env.MICHI_REQUIRE_AUTH;

// `commandTree`: workspace commands sync a window's whole graph, so they store
// a child in its parent's tree instead of refusing the tree the window derived.
const placements = [
  { label: 'same tree', treeId: 'a', parentId: 'root-a', ok: true },
  { label: 'different tree without edges', treeId: 'b', parentId: 'root-a', ok: false, commandTree: 'a' },
  { label: 'legacy parent and child both null', treeId: null, parentId: 'legacy', ok: true },
  { label: 'legacy parent and explicit tree', treeId: 'a', parentId: 'legacy', ok: false, commandTree: null },
  { label: 'explicit parent tree and legacy child', treeId: null, parentId: 'root-a', ok: false, commandTree: 'a' },
  { label: 'tree root without parent', treeId: 'a', parentId: null, ok: true },
  { label: 'legacy root without parent', treeId: null, parentId: null, ok: true },
  { label: 'foreign workspace parent', treeId: null, parentId: 'foreign', ok: false },
  { label: 'missing parent', treeId: 'a', parentId: 'absent', ok: false },
  { label: 'purged legacy parent', treeId: null, parentId: 'purged', ok: false },
  { label: 'foreign workspace tree', treeId: 'foreign-tree', parentId: null, ok: false },
  { label: 'missing tree', treeId: 'absent-tree', parentId: null, ok: false },
] as const;

function seed(): void {
  for (const id of ['ws', 'other']) saveWorkspace({ id, name: id, created_at: 1, updated_at: 1 });
  for (const [id, workspaceId, root] of [['a', 'ws', 'root-a'], ['b', 'ws', 'root-b'], ['foreign-tree', 'other', 'foreign-root']]) {
    saveTree({ id, workspace_id: workspaceId, root_node_id: root, last_active_at: 1, created_at: 1 });
    saveNode({ id: root, workspace_id: workspaceId, tree_id: id, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
  }
  for (const [id, workspaceId] of [['legacy', 'ws'], ['foreign', 'other'], ['purged', 'ws']]) {
    saveNode({ id, workspace_id: workspaceId, tree_id: null, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
  }
  getDb().prepare('UPDATE nodes SET purged_at = 3 WHERE id = ?').run('purged');
}

function snapshot(): string {
  return JSON.stringify(['workspaces', 'trees', 'nodes', 'edges', 'command_receipts'].map(table =>
    getDb().prepare(`SELECT * FROM ${table} ORDER BY ${table === 'command_receipts' ? 'operation_id' : 'id'}`).all()));
}

function graphInput(nodeId: string, treeId: string | null, parentId: string | null): EnsureDurableGraphNodeInput {
  return {
    workspace: { id: 'ws', name: `changed by ${nodeId}`, createdAt: 1 },
    node: { id: nodeId, treeId, parentNodeId: parentId, createdAt: 2 },
    edges: [],
  };
}

function commands(nodeId: string, treeId: string | null, parentId: string | null, patch = false): WorkspaceCommand[] {
  return [
    { type: 'workspace.upsert', payload: { id: 'ws', name: `changed by ${nodeId}` } },
    { type: patch ? 'node.patch' : 'node.upsert', payload: { id: nodeId, workspace_id: 'ws', tree_id: treeId, parent_node_id: parentId, created_at: 2 } },
  ];
}

describe('graph placement and typed HTTP errors', () => {
  let dir: string;
  let server: Server;
  let base: string;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-placement-errors-'));
    process.env.MICHI_DATA_DIR = dir;
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_REQUIRE_AUTH;
    closeDb(); initDb(); seed();
    const app = express(); app.use(express.json());
    app.use('/api', setupPersistenceRoutes());
    app.use('/api', setupMichiRoutes({} as ChatManager));
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterEach(async () => {
    await shutdownDbWorker();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb(); fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries({ MICHI_DATA_DIR: originalDataDir, MICHI_CLOUD: originalCloud, MICHI_REQUIRE_AUTH: originalRequireAuth })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  async function post(route: string, body: unknown, method = 'POST'): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  for (const entry of ['HTTP ensure', 'HTTP commands', 'domain upsert', 'domain patch', 'worker ensure'] as const) {
    test(`${entry} follows the placement matrix and rolls back rejected writes`, async () => {
      if (entry === 'worker ensure') await initDbWorker(getDbPath());
      const viaCommands = !entry.endsWith('ensure');
      for (const [index, placement] of placements.entries()) {
        const nodeId = `child-${index}`;
        if (entry === 'domain patch') {
          saveNode({ id: nodeId, workspace_id: 'ws', tree_id: null, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
        }
        const ok = placement.ok || (viaCommands && 'commandTree' in placement);
        const before = snapshot();
        const input = graphInput(nodeId, placement.treeId, placement.parentId);
        const commandInput = { operationId: `matrix-${index}`, commands: commands(nodeId, placement.treeId, placement.parentId, entry === 'domain patch') };
        if (entry.startsWith('HTTP')) {
          const result = await post(entry === 'HTTP ensure' ? '/workspaces/ws/graph/nodes/ensure' : '/workspaces/ws/commands', entry === 'HTTP ensure' ? input : commandInput);
          assert.equal(result.status, ok ? 200 : 409, placement.label);
        } else {
          const run = async () => {
            if (entry === 'worker ensure') await dbWorker.ensureDurableGraphNode(input);
            else applyWorkspaceCommands('ws', commandInput);
          };
          if (ok) await run();
          else await assert.rejects(run, (error: unknown) => error instanceof DomainError && error.kind === 'conflict', placement.label);
        }
        if (!ok) assert.equal(snapshot(), before, `${placement.label}: no workspace/node/edge/receipt writes`);
        else if (viaCommands) {
          const stored = 'commandTree' in placement ? placement.commandTree : placement.treeId;
          assert.equal(getDb().prepare('SELECT tree_id FROM nodes WHERE id = ?').get(nodeId)?.tree_id ?? null, stored, placement.label);
        }
      }
    });
  }

  test('a rejected new graph rolls back the workspace, new tree, node and command receipt', async () => {
    for (const entry of ['ensure', 'commands'] as const) {
      const before = snapshot();
      const result = await post(`/workspaces/new-ws/${entry === 'ensure' ? 'graph/nodes/ensure' : 'commands'}`, entry === 'ensure' ? {
        workspace: { id: 'new-ws', name: 'new', createdAt: 1, activeTreeId: 'new-tree' },
        tree: { id: 'new-tree', rootNodeId: 'new-child', createdAt: 1, lastActiveAt: 1 },
        node: { id: 'new-child', treeId: 'new-tree', parentNodeId: 'root-a', createdAt: 1 }, edges: [],
      } : {
        operationId: 'atomic', commands: [
          { type: 'workspace.upsert', payload: { id: 'new-ws' } },
          { type: 'tree.upsert', payload: { id: 'new-tree', workspace_id: 'new-ws', root_node_id: 'new-child' } },
          { type: 'node.upsert', payload: { id: 'new-child', workspace_id: 'new-ws', tree_id: 'new-tree', parent_node_id: 'root-a' } },
        ],
      });
      assert.equal(result.status, 409);
      assert.equal(snapshot(), before);
    }
  });

  test('HTTP classifies unsupported/malformed input, missing node and operation reuse', async () => {
    assert.equal((await post('/workspaces/ws/commands', { operationId: 'unsupported', commands: [{ type: 'future.command', payload: { id: 'x' } }] })).status, 400);
    for (const body of [{ operationId: 'x' }, { operationId: 7, commands: [] }, { operationId: 'x', commands: [null] }]) {
      assert.equal((await post('/workspaces/ws/commands', body)).status, 400);
    }
    for (const input of [
      { ...graphInput('x', null, null), edges: undefined },
      { ...graphInput('x', null, null), node: {} },
      { ...graphInput('x', null, null), workspace: { id: 'ws', name: 4, createdAt: 1 } },
    ]) assert.equal((await post('/workspaces/ws/graph/nodes/ensure', input)).status, 400);
    assert.equal((await post('/workspaces/ws/commands', { operationId: 'missing-node', commands: [{ type: 'node.patch', payload: { id: 'absent' } }] })).status, 404);
    const operation = { operationId: 'reused', commands: [{ type: 'workspace.upsert', payload: { id: 'ws', name: 'one' } }] };
    assert.equal((await post('/workspaces/ws/commands', operation)).status, 200);
    assert.equal((await post('/workspaces/ws/commands', operation)).status, 200);
    assert.equal((await post('/workspaces/ws/commands', { ...operation, commands: [{ type: 'workspace.upsert', payload: { id: 'ws', name: 'two' } }] })).status, 409);
  });

  test('HTTP commands answer an upsert of a deleted artifact in goneContextIds, a retry the same', async () => {
    const notes = { id: 'ctx-notes', workspace_id: 'ws', name: 'notes', file_path: '.contexts/notes.md', created_at: 1, updated_at: 1 };
    const created = await post('/workspaces/ws/commands', { operationId: 'create', commands: [{ type: 'context.upsert', payload: notes }] });
    assert.deepEqual(created, { status: 200, body: { ok: true, operationId: 'create', applied: [{ type: 'context.upsert', id: 'ctx-notes' }] } });
    assert.equal((await post('/workspaces/ws/commands', { operationId: 'delete', commands: [{ type: 'context.delete', payload: { id: 'ctx-notes' } }] })).status, 200);
    const stale = { operationId: 'stale-pin', commands: [{ type: 'context.upsert', payload: { ...notes, pinned_at: 5 } }] };
    const answer = { status: 200, body: { ok: true, operationId: 'stale-pin', applied: [], goneContextIds: ['ctx-notes'] } };
    assert.deepEqual(await post('/workspaces/ws/commands', stale), answer);
    assert.deepEqual(await post('/workspaces/ws/commands', stale), answer);
  });

  test('HTTP commands answer a stale write under a name another artifact holds with 200 and nameTakenContextIds, not a 500', async () => {
    const artifact = (id: string, name: string) => ({ type: 'context.upsert', payload: { id, workspace_id: 'ws', name, file_path: `.contexts/${id}.md` } });
    assert.equal((await post('/workspaces/ws/commands', { operationId: 'seed', commands: [artifact('ctx-c', 'foo')] })).status, 200);
    assert.equal((await post('/workspaces/ws/commands', { operationId: 'window-1', commands: [artifact('ctx-c', 'bar'), artifact('ctx-d', 'foo')] })).status, 200);
    assert.deepEqual(await post('/workspaces/ws/commands', { operationId: 'stale', commands: [artifact('ctx-c', 'foo')] }),
      { status: 200, body: { ok: true, operationId: 'stale', applied: [], nameTakenContextIds: ['ctx-c'] } });
  });

  test('HTTP commands take artifactIdentity "id": that window\'s delete beside a write under the same name is not checked as a takeover', async () => {
    const artifact = (id: string, name: string) => ({ type: 'context.upsert', payload: { id, workspace_id: 'ws', name, file_path: `.contexts/${id}.md` } });
    const replace = [artifact('ctx-new', 'notes'), { type: 'context.delete', payload: { id: 'ctx-c' } }];
    assert.equal((await post('/workspaces/ws/commands', { operationId: 'seed', commands: [artifact('ctx-c', 'notes')] })).status, 200);
    // Unmarked, as an older window sends it: kept, and the new one is named.
    assert.deepEqual(await post('/workspaces/ws/commands', { operationId: 'older', commands: replace }),
      { status: 200, body: { ok: true, operationId: 'older', applied: [], nameTakenContextIds: ['ctx-new'] } });
    // Any other value is no marker.
    assert.deepEqual((await post('/workspaces/ws/commands', { operationId: 'other-value', commands: replace, artifactIdentity: 'name' })).body.applied, []);
    assert.deepEqual(await post('/workspaces/ws/commands', { operationId: 'current', commands: replace, artifactIdentity: 'id' }),
      { status: 200, body: { ok: true, operationId: 'current', applied: [{ type: 'context.delete', id: 'ctx-c' }, { type: 'context.upsert', id: 'ctx-new' }] } });
  });

  test('HTTP command errors carry a stable code, name the failing command and log only the batch shape', async (t) => {
    const warn = t.mock.method(log, 'warn', () => {});
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ type: 'node.patch', payload: { id: `secret-${i}`, viewed_at: 1 } }));
    const big = await post('/workspaces/ws/commands', { operationId: 'big', commands: tooMany });
    assert.equal(big.status, 400);
    assert.deepEqual(big.body, { maxCommands: 500, error: 'commands must be an array of at most 500 items', code: 'too_many_commands' });
    assert.deepEqual(warn.mock.calls.at(-1)?.arguments, ['workspace', 'workspace commands rejected',
      { status: 400, code: 'too_many_commands', commandIndex: undefined, commandCount: 501, operationIdLength: 3 }]);
    assert.equal((await post('/workspaces/ws/commands', { operationId: 'x' })).body.code, 'invalid_commands');

    const before = snapshot();
    const unsupported = await post('/workspaces/ws/commands', { operationId: 'unsupported-2', commands: [
      { type: 'workspace.upsert', payload: { id: 'ws', name: 'renamed' } }, { type: 'future.command', payload: { id: 'x' } },
    ] });
    assert.equal(unsupported.status, 400);
    assert.deepEqual(unsupported.body, { commandIndex: 1, commandType: 'future.command', entityId: 'x',
      error: 'unsupported workspace command future.command', code: 'unsupported_workspace_command' });
    assert.equal(snapshot(), before, 'the batch still rolls back as a whole');
    assert.deepEqual((await post('/workspaces/ws/commands', { operationId: 'missing', commands: [{ type: 'node.patch', payload: { id: 'absent' } }] })).body,
      { commandIndex: 0, commandType: 'node.patch', entityId: 'absent', error: 'node not found', code: 'node_not_found' });
    assert.deepEqual((await post('/workspaces/ws/commands', { operationId: 'malformed', commands: [{ type: 'node.patch', payload: { id: 'a' } }, null] })).body,
      { commandIndex: 1, error: 'each command must have a type and object payload', code: 'invalid_command' });
    const badId = await post('/workspaces/ws/commands', { operationId: 'bad-id', commands: [{ type: 'node.patch', payload: { id: '' } }] });
    assert.deepEqual(badId.body, { commandIndex: 0, commandType: 'node.patch', error: 'node.patch.id must be a non-empty string <=160 chars', code: 'invalid_entity_id' });
    const conflict = await post('/workspaces/ws/commands', { operationId: 'mismatch', commands: [{ type: 'workspace.upsert', payload: { id: 'other' } }] });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'workspace_id_mismatch');
    assert.equal(warn.mock.calls.length, 7);
    assert.equal(JSON.stringify(warn.mock.calls.map(call => call.arguments)).includes('secret-'), false);
  });

  test('HTTP graph identity replay is 409 and never mutates the existing node', async () => {
    const input = graphInput('replay', 'a', 'root-a');
    assert.equal((await post('/workspaces/ws/graph/nodes/ensure', input)).status, 200);
    const before = snapshot();
    assert.equal((await post('/workspaces/ws/graph/nodes/ensure', graphInput('replay', 'b', 'root-b'))).status, 409);
    assert.equal(snapshot(), before);
  });

  test('real SQL failures remain 500 at commands, ensure and session prerequisite routes', async () => {
    getDb().exec("CREATE TRIGGER fail_workspace BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'must be different same tree not found'); END");
    for (const [route, body] of [
      ['/workspaces/ws/commands', { operationId: 'sql', commands: [{ type: 'workspace.upsert', payload: { id: 'ws' } }] }],
      ['/workspaces/ws/graph/nodes/ensure', graphInput('sql-node', null, null)],
      ['/nodes/sql-node/ensure-session', { workspaceId: 'ws', graphPrerequisite: graphInput('sql-node', null, null) }],
    ] as const) {
      const before = snapshot();
      const result = await post(route, body);
      assert.equal(result.status, 500, route);
      assert.equal(result.body.error, 'Internal server error');
      assert.equal(snapshot(), before);
    }
  });

  test('worker preserves domain classification and unexpected SQL failures through the real session route', async () => {
    await initDbWorker(getDbPath());
    await assert.rejects(dbWorker.ensureDurableGraphNode(graphInput('worker-code', 'b', 'root-a')),
      (error: unknown) => error instanceof DomainError && error.kind === 'conflict' && error.code === 'node_parent_tree_mismatch');
    for (const [nodeId, input, status] of [
      ['worker-conflict', graphInput('worker-conflict', 'b', 'root-a'), 409],
      ['worker-invalid', { ...graphInput('worker-invalid', null, null), edges: undefined }, 400],
    ] as const) {
      const result = await post(`/nodes/${nodeId}/ensure-session`, { workspaceId: 'ws', graphPrerequisite: input });
      assert.equal(result.status, status);
      assert.equal(result.body.code, 'NODE_PREREQUISITE_FAILED');
    }
    getDb().exec("CREATE TRIGGER fail_workspace BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'not found must be different'); END");
    const result = await post('/nodes/worker-sql/ensure-session', { workspaceId: 'ws', graphPrerequisite: graphInput('worker-sql', null, null) });
    assert.equal(result.status, 500);
    assert.equal(result.body.error, 'Internal server error');
  });

  test('node permissions uses the same prerequisite error mapping', async () => {
    const put = (nodeId: string, input: unknown) => post(`/nodes/${nodeId}/permissions`, { mode: 'ask', graphPrerequisite: input }, 'PUT');
    assert.equal((await put('permission-conflict', graphInput('permission-conflict', 'b', 'root-a'))).status, 409);
    assert.equal((await put('permission-invalid', { ...graphInput('permission-invalid', null, null), edges: undefined })).status, 400);
    getDb().exec("CREATE TRIGGER fail_workspace BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'not found must be different'); END");
    assert.equal((await put('permission-sql', graphInput('permission-sql', null, null))).status, 500);
  });

  for (const route of ['permissions', 'ultracode'] as const) {
    test(`node ${route} writes a new node's graph slice as ensure-session does`, async () => {
      const put = async (nodeId: string, input: unknown, headers: Record<string, string> = {}) => {
        const body = route === 'permissions' ? { mode: 'ask', graphPrerequisite: input } : { enabled: true, graphPrerequisite: input };
        const response = await fetch(`${base}/nodes/${nodeId}/${route}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };
      for (const [nodeId, input, status, code] of [
        [`${route}-missing`, undefined, 409, 'NODE_NOT_PERSISTED'],
        [`${route}-foreign`, graphInput('another-node', null, null), 409, 'NODE_PREREQUISITE_FAILED'],
        [`${route}-conflict`, graphInput(`${route}-conflict`, 'b', 'root-a'), 409, 'NODE_PREREQUISITE_FAILED'],
        [`${route}-invalid`, { ...graphInput(`${route}-invalid`, null, null), edges: undefined }, 400, 'NODE_PREREQUISITE_FAILED'],
      ] as const) {
        const result = await put(nodeId, input);
        assert.deepEqual([result.status, result.body.code], [status, code], nodeId);
        assert.equal(getNode(nodeId), null);
      }

      const frames: WorkspaceStructureChangedEvent[] = [];
      const unsubscribe = structureEvents.subscribe({ send: (event) => frames.push(event) });
      try {
        await initDbWorker(getDbPath());
        const created = await put(`${route}-new`, graphInput(`${route}-new`, 'a', 'root-a'), { [WINDOW_ID_HEADER]: 'window-1' });
        assert.equal(created.status, 200);
        assert.equal(getNode(`${route}-new`)?.tree_id, 'a');
        structureEvents.flush();
        const nodeCreated = frames.flatMap((frame) => frame.changes).find((change) => change.entity === 'node' && change.nodeId === `${route}-new`);
        assert.equal(nodeCreated?.originWindowId, 'window-1', 'the requesting window is not told about its own node');
      } finally { unsubscribe(); }
    });
  }

  test('HTTP classification uses kind regardless of message wording', () => {
    for (const [kind, status] of [['invalid_argument', 400], ['not_found', 404], ['conflict', 409]] as const) {
      for (const message of ['Opaque wording', 'not found must be different same tree']) {
        assert.deepEqual(domainErrorResponse(new DomainError(kind as DomainErrorKind, 'stable_code', message)), { status, error: message });
      }
    }
    assert.equal(domainErrorResponse(new Error('not found must be different same tree')).status, 500);
  });
});
