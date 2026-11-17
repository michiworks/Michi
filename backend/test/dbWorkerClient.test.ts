import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent, type DurableMessageMetadata } from 'michi-shared';
import { closeDb, getDbPath, initDb } from '../src/services/db';
import { listMessages, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { dbWorker, initDbWorker, isDbWorkerReady, shutdownDbWorker } from '../src/services/dbWorkerClient';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-db-worker-lifecycle-')); });
afterEach(async () => { await shutdownDbWorker(); fs.rmSync(directory, { recursive: true, force: true }); });

test('a synchronous worker construction failure rejects initialization and permits retry', async () => {
  let startup: Promise<void> | undefined;
  assert.doesNotThrow(() => {
    // Worker rejects noncloneable workerData before its event handlers exist.
    startup = initDbWorker(Symbol('invalid-db-path') as unknown as string);
  });
  await assert.rejects(startup!, { name: 'DataCloneError' });
  assert.equal(isDbWorkerReady(), false);
  await initDbWorker(path.join(directory, 'data.db'));
  assert.equal(await dbWorker.ping(), 'pong');
});

test('startup failure rejects readiness and a subsequent initialized worker is usable', async () => {
  const startup = initDbWorker(path.join(directory, 'missing-parent', 'data.db'));
  assert.equal(isDbWorkerReady(), false, 'constructed is not ready');
  await assert.rejects(dbWorker.ping(), /not ready/);
  await assert.rejects(startup, /unable to open database file/);
  assert.equal(isDbWorkerReady(), false);
  await initDbWorker(path.join(directory, 'data.db'));
  assert.equal(isDbWorkerReady(), true);
  assert.equal(await dbWorker.ping(), 'pong');
});

test('shutdown during startup rejects readiness without clearing a replacement generation', async () => {
  const startup = initDbWorker(path.join(directory, 'data.db'));
  const stopped = assert.rejects(startup, /dbWorker stopped/);
  assert.equal(isDbWorkerReady(), false);
  const shutdown = shutdownDbWorker();
  assert.equal(isDbWorkerReady(), false);
  // Start the replacement before the old worker has delivered its exit event.
  const replacement = initDbWorker(path.join(directory, 'data.db'));
  await shutdown;
  await stopped;
  await replacement;
  assert.equal(isDbWorkerReady(), true);
  assert.equal(await dbWorker.ping(), 'pong');
});

test('shutdown rejects an outstanding RPC and does not replay it on restart', async () => {
  await initDbWorker(path.join(directory, 'data.db'));
  const pending = assert.rejects(dbWorker.ping(), /dbWorker stopped/);
  await shutdownDbWorker();
  await pending;
  await assert.rejects(dbWorker.ping(), /not ready/);
  await initDbWorker(path.join(directory, 'data.db'));
  assert.equal(await dbWorker.ping(), 'pong');
});

test('turn snapshots reach the worker by structured clone, and as a JSON copy when they cannot be cloned', async (t) => {
  const previousDataDir = process.env.MICHI_DATA_DIR;
  process.env.MICHI_DATA_DIR = directory;
  t.after(() => {
    closeDb();
    if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR;
    else process.env.MICHI_DATA_DIR = previousDataDir;
  });
  closeDb();
  initDb();
  saveWorkspace({ id: 'ws-1', name: 'Workspace', created_at: 1, updated_at: 1, active_tree_id: 'tree-1' });
  saveTree({ id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'node-1', last_active_at: 1, created_at: 1 });
  saveNode({
    id: 'node-1', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: null,
    kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1,
  });
  await initDbWorker(getDbPath());

  const turn = (turnId: string, userMetadata: DurableMessageMetadata) => createDurableTurn({
    turnId, assistantId: `a-${turnId}`, nodeId: 'node-1', workspaceId: 'ws-1',
    displayUserText: `question ${turnId}`, userMetadata, selfInitiated: false, startedAt: 10,
  });
  // Structured clone keeps a key holding undefined, where the JSON copy dropped it.
  const cloned = turn('turn-1', { quotedText: undefined });
  await dbWorker.beginTurn(cloned);
  const chunk = { event: 'chunk', data: { text: 'partial', seq: 1 } } as ChatStreamEvent;
  const written = await dbWorker.checkpointTurn(applyTurnEvent(cloned, chunk));
  assert.ok(written.payloadBytes !== null && written.payloadBytes > 0, 'the worker reports the bytes it rewrote');

  // A function cannot be cloned; the JSON copy leaves it out.
  await dbWorker.beginTurn(turn('turn-2', { quotedText: 'quoted', onClick: () => {} } as unknown as DurableMessageMetadata));

  const users = listMessages('node-1').filter((message) => message.role === 'user');
  assert.deepEqual(users.map((message) => [message.content, message.metadata]), [
    ['question turn-1', null],
    ['question turn-2', JSON.stringify({ quotedText: 'quoted' })],
  ]);
  await assert.rejects(dbWorker.persistResumeBinding({ nodeId: () => {} } as never), { name: 'DataCloneError' });
  assert.equal(await dbWorker.ping(), 'pong', 'a refused post leaves the worker usable');
});
