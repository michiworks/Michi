import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AgentRunDtoV1, WorkspaceStructureChange, WorkspaceStructureChangedEvent } from 'michi-shared';

import { closeDb, getDbPath, initDb, runInTransaction } from '../src/services/db';
import { applyWorkspaceCommands } from '../src/services/domainCommands';
import {
  deleteWorkspace,
  moveTreeToWorkspace,
  purgeWorkspaceNodes,
  restoreTrimmedNode,
  saveWorkspace,
  trimNode,
} from '../src/services/dbRepository';
import {
  WorkspaceStructureEventBus,
  recordStructureChange,
  runWithStructureOrigin,
  structureEvents,
  structureOriginOf,
} from '../src/services/structureEvents';
import { setupPersistenceRoutes } from '../src/routes/persistence';
import { mountAgentRunActionRoutes } from '../src/routes/agentRunActions';
import { AgentRunActionsService } from '../src/services/agentRunActions';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { dbWorker, initDbWorker, shutdownDbWorker } from '../src/services/dbWorkerClient';

type Handler = (req: unknown, res: unknown) => unknown;

/** A route's own handler (after its guards), called without a server. */
function routeHandler(router: unknown, method: 'post' | 'put' | 'patch', routePath: string): Handler {
  const stack = (router as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }> }).stack;
  const layer = stack.find((candidate) => candidate.route?.path === routePath && candidate.route.methods[method]);
  assert.ok(layer?.route, `${method} ${routePath} exists`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res;
}

function collect(bus: WorkspaceStructureEventBus, ownerUserId?: string) {
  const frames: WorkspaceStructureChangedEvent[] = [];
  const unsubscribe = bus.subscribe({ ...(ownerUserId !== undefined ? { ownerUserId } : {}), send: (event) => frames.push(event) });
  return { frames, unsubscribe };
}

const change = (overrides: Partial<WorkspaceStructureChange> = {}) => ({
  entity: 'workspace' as const, op: 'renamed' as const, workspaceId: 'ws-1', ...overrides,
});

describe('structure event bus', () => {
  test('opens every subscription with the current cursor and numbers frames per scope', () => {
    const bus = new WorkspaceStructureEventBus({ epoch: 'e1', coalesceMs: 10_000, ownerScoped: () => false });
    const first = collect(bus);
    assert.deepEqual(first.frames, [{ epoch: 'e1', seq: 0, changes: [] }]);

    bus.record(change());
    bus.flush();
    bus.record(change({ op: 'archived' }));
    bus.flush();
    assert.deepEqual(first.frames.map((frame) => frame.seq), [0, 1, 2]);
    assert.deepEqual(first.frames[2].changes, [change({ op: 'archived' })]);

    // A later subscriber starts from where the scope is now.
    const second = collect(bus);
    assert.deepEqual(second.frames, [{ epoch: 'e1', seq: 2, changes: [] }]);
    assert.deepEqual(bus.cursor(), { epoch: 'e1', seq: 2 });
    first.unsubscribe();
    second.unsubscribe();
  });

  test('coalesces a burst into one frame with duplicates removed', async () => {
    const bus = new WorkspaceStructureEventBus({ epoch: 'e', coalesceMs: 15, ownerScoped: () => false });
    const { frames, unsubscribe } = collect(bus);
    bus.record(change({ entity: 'node', op: 'deleted', nodeId: 'a' }));
    bus.record(change({ entity: 'node', op: 'deleted', nodeId: 'b' }));
    bus.record(change({ entity: 'node', op: 'deleted', nodeId: 'a' }));
    assert.equal(frames.length, 1, 'nothing is sent before the coalescing window closes');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[1], {
      epoch: 'e',
      seq: 1,
      changes: [
        change({ entity: 'node', op: 'deleted', nodeId: 'a' }),
        change({ entity: 'node', op: 'deleted', nodeId: 'b' }),
      ],
    });
    unsubscribe();
    bus.record(change());
    bus.flush();
    assert.equal(frames.length, 2, 'an unsubscribed stream receives nothing more');
  });

  test('scopes frames and their sequence to the workspace owner', () => {
    const owners: Record<string, string> = { 'ws-a': 'alice', 'ws-b': 'bob' };
    const bus = new WorkspaceStructureEventBus({
      epoch: 'e', coalesceMs: 10_000, ownerScoped: () => true, resolveOwner: (id) => owners[id] ?? null,
    });
    const alice = collect(bus, 'alice');
    const bob = collect(bus, 'bob');
    bus.record(change({ workspaceId: 'ws-a' }));
    bus.record(change({ workspaceId: 'ws-b' }));
    bus.flush();
    bus.record(change({ workspaceId: 'ws-a', op: 'archived' }));
    bus.flush();
    // An explicit owner wins over the lookup.
    bus.record(change({ workspaceId: 'ws-b', op: 'deleted', ownerUserId: 'alice' } as never));
    bus.flush();

    assert.deepEqual(alice.frames.map((frame) => [frame.seq, frame.changes.map((c) => `${c.workspaceId}:${c.op}`)]), [
      [0, []], [1, ['ws-a:renamed']], [2, ['ws-a:archived']], [3, ['ws-b:deleted']],
    ]);
    assert.deepEqual(bob.frames.map((frame) => [frame.seq, frame.changes.map((c) => `${c.workspaceId}:${c.op}`)]), [
      [0, []], [1, ['ws-b:renamed']],
    ]);
    assert.deepEqual(bus.cursor('bob'), { epoch: 'e', seq: 1 });
    assert.deepEqual(bus.cursor('carol'), { epoch: 'e', seq: 0 });
  });

  test('asks for a full re-read instead of sending an oversized frame', () => {
    const bus = new WorkspaceStructureEventBus({ epoch: 'e', coalesceMs: 10_000, maxChangesPerFrame: 2, ownerScoped: () => false });
    const { frames } = collect(bus);
    for (const nodeId of ['a', 'b', 'c']) bus.record(change({ entity: 'node', op: 'created', nodeId }));
    bus.flush();
    assert.deepEqual(frames[1], { epoch: 'e', seq: 1, changes: [], resync: true });
  });

  test('tags only what a scope records synchronously, and only with a well-formed window id', async () => {
    const bus = new WorkspaceStructureEventBus({ epoch: 'e', coalesceMs: 10_000, ownerScoped: () => false });
    const { frames } = collect(bus);
    let continuation: Promise<void> = Promise.resolve();
    let timer: Promise<void> = Promise.resolve();
    runWithStructureOrigin('window-1', () => {
      bus.record(change());
      // Work the scope starts runs after it ends: a turn, a run, a child process.
      continuation = Promise.resolve().then(() => bus.record(change({ op: 'archived' })));
      timer = new Promise((resolve) => setTimeout(() => { bus.record(change({ op: 'deleted' })); resolve(); }, 0));
      runWithStructureOrigin(undefined, () => bus.record(change({ op: 'unarchived' })));
      bus.record(change({ op: 'renamed', workspaceId: 'ws-2' }));
    });
    runWithStructureOrigin('bad id with spaces', () => bus.record(change({ op: 'restored' })));
    bus.record(change({ op: 'purged' }));
    await continuation;
    await timer;
    bus.flush();
    assert.deepEqual(frames[1].changes, [
      change({ originWindowId: 'window-1' }),
      change({ op: 'unarchived' }),
      change({ workspaceId: 'ws-2', originWindowId: 'window-1' }),
      change({ op: 'restored' }),
      change({ op: 'purged' }),
      change({ op: 'archived' }),
      change({ op: 'deleted' }),
    ]);

    assert.equal(structureOriginOf({ headers: { 'x-michi-window-id': 'window-2' } }), 'window-2');
    assert.equal(structureOriginOf({ headers: { 'x-michi-window-id': 'bad id with spaces' } }), undefined);
    assert.equal(structureOriginOf({ headers: { 'x-michi-window-id': ['window-2', 'window-3'] } }), undefined);
    assert.equal(structureOriginOf({ headers: {} }), undefined);
  });

  test('one failing subscriber does not stop delivery to the others', () => {
    const bus = new WorkspaceStructureEventBus({ epoch: 'e', coalesceMs: 10_000, ownerScoped: () => false });
    bus.subscribe({ send: (event) => { if (event.seq > 0) throw new Error('broken stream'); } });
    const { frames } = collect(bus);
    bus.record(change());
    bus.flush();
    assert.equal(frames.length, 2);
  });
});

describe('structure changes recorded by writes', () => {
  let tmpDir: string;
  let frames: WorkspaceStructureChangedEvent[];
  let unsubscribe: () => void;
  const previousCloud = process.env.MICHI_CLOUD;

  const delivered = (): string[] => {
    structureEvents.flush();
    const changes = frames.flatMap((frame) => frame.changes);
    frames.length = 0;
    return changes.map((c) => [c.entity, c.op, c.workspaceId, c.treeId ?? '-', c.nodeId ?? '-', c.fromWorkspaceId ?? '-']
      .join(' '));
  };

  const seed = () => applyWorkspaceCommands('ws-1', {
    operationId: `seed-${Math.random()}`,
    commands: [
      { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'One', created_at: 1, updated_at: 1, active_tree_id: 'tree-1' } },
      { type: 'tree.upsert', payload: { id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'root', last_active_at: 1, created_at: 1 } },
      { type: 'node.upsert', payload: { id: 'root', workspace_id: 'ws-1', tree_id: 'tree-1', kind: 'chat', created_at: 1 } },
      { type: 'node.upsert', payload: { id: 'child', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: 'root', kind: 'chat', created_at: 2 } },
      { type: 'edge.upsert', payload: { id: 'branch-root-child', workspace_id: 'ws-1', source_node_id: 'root', target_node_id: 'child', kind: 'branch' } },
    ],
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-structure-events-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    structureEvents.flush();
    frames = [];
    unsubscribe = structureEvents.subscribe({ send: (event) => frames.push(event) });
    frames.length = 0;
  });

  afterEach(() => {
    unsubscribe();
    structureEvents.flush();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud;
  });

  test('command batches report creations, and only structural edits after that', () => {
    seed();
    assert.deepEqual(delivered(), [
      'workspace created ws-1 - - -',
      'tree created ws-1 tree-1 - -',
      'node created ws-1 tree-1 root -',
      'node created ws-1 tree-1 child -',
    ]);

    // Activity, pane and view fields are not structure.
    applyWorkspaceCommands('ws-1', {
      operationId: 'activity',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'One', created_at: 1, updated_at: 5, active_tree_id: 'tree-1' } },
        { type: 'tree.upsert', payload: { id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'root', last_active_at: 9, created_at: 1 } },
        { type: 'node.patch', payload: { id: 'child', tree_id: 'tree-1', parent_node_id: 'root', pane_width: 420, minimized: 0 } },
        { type: 'node.patch', payload: { id: 'child', viewed_at: 7 } },
      ],
    });
    assert.deepEqual(delivered(), []);

    applyWorkspaceCommands('ws-1', {
      operationId: 'edits',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Renamed', created_at: 1, updated_at: 6, archived_at: 10 } },
        { type: 'tree.upsert', payload: { id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'root', name: 'Thread', archived_at: 11, last_active_at: 9, created_at: 1 } },
        { type: 'node.patch', payload: { id: 'child', title: 'Child title' } },
        { type: 'node.patch', payload: { id: 'root', deleted_at: 12, deletion_group_id: 'del-1' } },
      ],
    });
    assert.deepEqual(delivered(), [
      'workspace renamed ws-1 - - -',
      'workspace archived ws-1 - - -',
      'tree renamed ws-1 tree-1 - -',
      'tree archived ws-1 tree-1 - -',
      'node renamed ws-1 tree-1 child -',
      'node deleted ws-1 tree-1 root -',
    ]);

    applyWorkspaceCommands('ws-1', {
      operationId: 'undo',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Renamed', created_at: 1, updated_at: 7, archived_at: null, deleted_at: 13 } },
        { type: 'node.patch', payload: { id: 'root', deleted_at: null, deletion_group_id: null } },
      ],
    });
    assert.deepEqual(delivered(), [
      'workspace deleted ws-1 - - -',
      'workspace unarchived ws-1 - - -',
      'node restored ws-1 tree-1 root -',
    ]);
  });

  test('a batch that fails is rolled back and reports nothing', () => {
    seed();
    delivered();
    assert.throws(() => applyWorkspaceCommands('ws-1', {
      operationId: 'fails',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Never', created_at: 1, updated_at: 2 } },
        { type: 'node.patch', payload: { id: 'missing-node', title: 'x' } },
      ],
    }), /node not found/);
    assert.deepEqual(delivered(), []);

    // A transaction's records wait for its commit and vanish with a rollback.
    assert.throws(() => runInTransaction(() => {
      recordStructureChange({ entity: 'workspace', op: 'renamed', workspaceId: 'ws-1' });
      throw new Error('abort');
    }), /abort/);
    runInTransaction(() => {
      recordStructureChange({ entity: 'workspace', op: 'archived', workspaceId: 'ws-1' });
      structureEvents.flush();
      assert.equal(frames.length, 0, 'not staged before COMMIT');
    });
    assert.deepEqual(delivered(), ['workspace archived ws-1 - - -']);
  });

  test('moves, trims, purges and workspace deletion report what they removed', () => {
    seed();
    saveWorkspace({ id: 'ws-2', name: 'Two', created_at: 1, updated_at: 1 });
    delivered();

    trimNode('ws-1', 'child', 20, 'arch-1');
    assert.deepEqual(delivered(), ['node archived ws-1 - child -']);
    restoreTrimmedNode('ws-1', 'child');
    assert.deepEqual(delivered(), ['node restored ws-1 - child -']);

    moveTreeToWorkspace('tree-1', 'ws-1', 'ws-2');
    assert.deepEqual(delivered(), ['tree moved ws-2 tree-1 - ws-1']);

    purgeWorkspaceNodes('ws-2', ['root', 'child']);
    assert.deepEqual(delivered().sort(), [
      'node purged ws-2 - child -',
      'node purged ws-2 - root -',
      'tree deleted ws-2 tree-1 - -',
    ]);

    deleteWorkspace('ws-1');
    deleteWorkspace('ws-1');
    assert.deepEqual(delivered(), ['workspace purged ws-1 - - -'], 'a repeated purge reports nothing');
  });

  test('a request names its window only on writes that apply its own payload', async () => {
    seed();
    delivered();
    const headers = { 'x-michi-window-id': 'window-a' };
    const origins = () => {
      structureEvents.flush();
      const changes = frames.flatMap((frame) => frame.changes);
      frames.length = 0;
      return changes.map((c) => `${c.entity} ${c.op} ${c.originWindowId ?? '-'}`);
    };

    // The window's own command batch: its store already shows the rename.
    const commands = routeHandler(setupPersistenceRoutes(), 'post', '/workspaces/:id/commands');
    const renamed = fakeResponse();
    commands({
      params: { id: 'ws-1' },
      body: { operationId: 'rename-child', commands: [{ type: 'node.patch', payload: { id: 'child', title: 'Mine' } }] },
      headers,
    }, renamed);
    assert.equal(renamed.statusCode, 200);
    assert.deepEqual(origins(), ['node renamed window-a']);

    // Continue as branch: the backend makes the thread, so the window that
    // clicked must hear of it like every other window.
    const run = {
      id: 'run-1', workspaceId: 'ws-1', parentNodeId: null, parentRunId: null, parentMessageId: null,
      task: 'Check the lease', resultBundle: null, status: 'succeeded', definitionId: null,
      effectiveDefinition: { name: 'Researcher' },
    } as unknown as AgentRunDtoV1;
    const router = express.Router();
    mountAgentRunActionRoutes(router, {
      actions: new AgentRunActionsService({
        runs: { getRun: () => run, listEvents: () => [] },
        definitions: { create: async () => { throw new Error('not used'); } },
      }),
      operationId: () => 'continue-1',
    });
    const continued = fakeResponse();
    await routeHandler(router, 'post', '/agent-runs/:runId/continue-as-branch')({
      params: { runId: 'run-1' },
      body: { version: 1, workspaceId: 'ws-1', includeTask: true, includeResult: false, includeTranscript: false, fallback: 'new_thread' },
      headers,
      user: { id: LOCAL_AGENT_OWNER_ID },
    }, continued);
    assert.equal(continued.statusCode, 201, JSON.stringify(continued.body));
    assert.deepEqual(origins(), ['tree created -', 'node created -']);

    // The DB worker commits a window's graph slice after the request's scope:
    // it still names the window, and only when the caller applied its payload.
    await initDbWorker(getDbPath());
    try {
      const slice = (id: string) => ({
        workspace: { id: 'ws-1', name: 'One', cwd: null, createdAt: 1, activeTreeId: 'tree-1' },
        tree: { id: 'tree-1', rootNodeId: 'root', createdAt: 1, lastActiveAt: 1 },
        node: { id, treeId: 'tree-1', parentNodeId: 'root', kind: 'chat', createdAt: 3 },
        edges: [{ id: `branch-root-${id}`, sourceNodeId: 'root', targetNodeId: id, kind: 'branch' }],
      });
      await runWithStructureOrigin('window-a', () => dbWorker.ensureDurableGraphNode(slice('from-window')));
      await dbWorker.ensureDurableGraphNode(slice('from-tool'));
    } finally {
      await shutdownDbWorker();
    }
    assert.deepEqual(origins(), ['node created window-a', 'node created -']);
  });

  test('cloud mode delivers a change only to the workspace owner', () => {
    process.env.MICHI_CLOUD = '1';
    const alice: WorkspaceStructureChangedEvent[] = [];
    const stop = structureEvents.subscribe({ ownerUserId: 'alice', send: (event) => alice.push(event) });
    try {
      saveWorkspace({ id: 'ws-alice', name: 'A', created_at: 1, updated_at: 1, owner_user_id: 'alice' });
      saveWorkspace({ id: 'ws-bob', name: 'B', created_at: 1, updated_at: 1, owner_user_id: 'bob' });
      structureEvents.flush();
      assert.deepEqual(alice.slice(1).flatMap((frame) => frame.changes.map((c) => c.workspaceId)), ['ws-alice']);
      assert.equal(alice[1].seq, alice[0].seq + 1);
    } finally {
      stop();
    }
  });
});
