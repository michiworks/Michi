/**
 * Search runs on read-only worker connections (services/searchReader.ts,
 * searchWorker.ts), not on the main one: at most two queries at once, a
 * bounded queue, and a wait limit after which the caller hears the query was
 * too broad while the query itself runs to its end. Filters (cloud owner,
 * system workspaces) apply in the worker as they did on the main thread.
 * The reader's own tests use stand-in workers that block their thread the
 * way a native query does; the worker's use a temp SQLite per test.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { closeDb, getDb, initDb, isDbOpen } from '../src/services/db';
import type { NodeGroupedResult, SearchResult } from '../src/routes/search';
import { runSearch, SearchLimitError, SearchReader, stopSearchReader } from '../src/services/searchReader';

/**
 * Answers `block:<ms>` after blocking its thread that long, `seen` with the
 * queries it was given, anything else at once with the query itself. Counts
 * how many stand-ins are inside a query at once in `running[0]`, the most in `running[1]`.
 */
function standIn(running: Int32Array): Worker {
  return new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const running = new Int32Array(workerData.running);
    const seen = [];
    parentPort.on('message', (request) => {
      seen.push(request.query);
      const now = Atomics.add(running, 0, 1) + 1;
      if (now > Atomics.load(running, 1)) Atomics.store(running, 1, now);
      const ms = request.query.startsWith('block:') ? Number(request.query.slice(6)) : 0;
      if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      Atomics.sub(running, 0, 1);
      parentPort.postMessage({ result: request.query === 'seen' ? seen : [request.query], durationMs: ms });
    });
  `, { eval: true, workerData: { running: running.buffer } });
}

function reader(options: { waitMs?: number; lanes?: number; queueLimit?: number }) {
  const running = new Int32Array(new SharedArrayBuffer(8));
  let started = 0;
  const instance = new SearchReader('unused', { ...options, workerFactory: () => { started += 1; return standIn(running); } });
  const ask = (query: string, signal?: AbortSignal) => instance.run({ kind: 'keyword', query, limit: 1 }, signal) as Promise<unknown>;
  return { instance, ask, running, started: () => started };
}

const limit = (code: string) => (error: unknown) => error instanceof SearchLimitError && error.code === code;

describe('search reader', () => {
  test('a caller stops waiting at the wait limit; its query keeps the lane until it ends', async () => {
    const { instance, ask, started } = reader({ lanes: 1, waitMs: 300 });
    try {
      await assert.rejects(ask('block:1500'), limit('search_too_broad'));
      // The blocked query still holds the only lane: the next one waits its limit out in the queue.
      await assert.rejects(ask('quick'), limit('search_busy'));
      let answer: unknown;
      for (let attempt = 0; attempt < 20 && answer === undefined; attempt += 1) {
        answer = await ask('quick').catch(() => undefined);
      }
      assert.deepEqual(answer, ['quick'], 'the lane is free once the query ends');
      assert.equal(started(), 1, 'no second worker beside the busy one');
    } finally {
      await instance.close();
    }
  });

  test('at most two queries run at once; a bounded queue waits, the rest are refused', async () => {
    const { instance, ask, running, started } = reader({ lanes: 2, queueLimit: 1, waitMs: 10_000 });
    try {
      const first = ask('block:400');
      const second = ask('block:400');
      const queued = ask('queued');
      await assert.rejects(ask('refused'), limit('search_busy'));
      assert.deepEqual(await Promise.all([first, second, queued]), [['block:400'], ['block:400'], ['queued']]);
      assert.equal(running[1], 2);
      assert.equal(started(), 2);
    } finally {
      await instance.close();
    }
  });

  test('a search abandoned while it waits never runs', async () => {
    const { instance, ask } = reader({ lanes: 1 });
    try {
      const first = ask('block:300');
      const abandoned = new AbortController();
      const dropped = ask('dropped', abandoned.signal);
      abandoned.abort();
      await assert.rejects(dropped, { name: 'AbortError' });
      await first;
      assert.deepEqual(await ask('seen'), ['block:300', 'seen']);
    } finally {
      await instance.close();
    }
  });
});

function seedChat(workspaceId: string, nodeId: string, title: string, content: string): void {
  const db = getDb();
  db.prepare('INSERT INTO nodes (id, workspace_id, kind, status, title) VALUES (?, ?, \'chat\', \'idle\', ?)').run(nodeId, workspaceId, title);
  db.prepare('INSERT INTO messages (id, node_id, role, content, seq, created_at) VALUES (?, ?, \'user\', ?, 1, 1)').run(`m-${nodeId}`, nodeId, content);
}

describe('search worker', () => {
  let tmpDir: string;
  let oldCloud: string | undefined;

  beforeEach(() => {
    oldCloud = process.env.MICHI_CLOUD;
    delete process.env.MICHI_CLOUD;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-reader-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    getDb().prepare(`INSERT INTO workspaces (id, name, owner_user_id, settings, created_at, updated_at) VALUES
      ('ws-alice', 'Alice', 'alice', NULL, 1, 1), ('ws-bob', 'Bob', 'bob', NULL, 1, 1),
      ('ws-system', 'Michi', 'alice', '{"system":"assistant"}', 1, 1)`).run();
    seedChat('ws-alice', 'n-alice', 'Heron plan', 'heron 苍鹭 notes from alice');
    seedChat('ws-bob', 'n-bob', 'Heron plan', 'heron 苍鹭 notes from bob');
    seedChat('ws-system', 'n-system', 'Heron plan', 'heron 苍鹭 notes for the assistant');
  });

  afterEach(() => {
    stopSearchReader();
    closeDb();
    if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const keyword = async (query: string, workspaceId?: string, userId?: string) =>
    (await runSearch({ kind: 'keyword', query, workspaceId, limit: 20, userId }) as SearchResult[]).map((row) => row.node_id).sort();
  const grouped = async (query: string, workspaceId?: string, userId?: string) =>
    (await runSearch({ kind: 'grouped', query, workspaceId, limit: 20, userId }) as NodeGroupedResult[]).map((row) => row.nodeId).sort();

  test('runs on its own read-only connection, leaving system workspaces out unless named', async () => {
    closeDb();
    assert.deepEqual(await keyword('heron'), ['n-alice', 'n-bob']);
    assert.deepEqual(await keyword('苍鹭'), ['n-alice', 'n-bob']);
    assert.deepEqual(await grouped('heron'), ['n-alice', 'n-bob']);
    assert.deepEqual(await grouped('plan'), ['n-alice', 'n-bob'], 'the title pass too');
    assert.deepEqual(await keyword('heron', 'ws-system'), ['n-system']);
    assert.equal(isDbOpen(), false, 'the main connection was not opened again');
  });

  test('in cloud mode an owner finds only their own workspaces, as the switch reads when the query runs', async () => {
    assert.deepEqual(await keyword('heron', undefined, 'alice'), ['n-alice', 'n-bob'], 'local mode filters by no owner');
    process.env.MICHI_CLOUD = '1';
    assert.deepEqual(await keyword('heron', undefined, 'alice'), ['n-alice']);
    assert.deepEqual(await keyword('苍鹭', undefined, 'alice'), ['n-alice']);
    assert.deepEqual(await grouped('heron', undefined, 'alice'), ['n-alice']);
    assert.deepEqual(await grouped('plan', undefined, 'alice'), ['n-alice']);
    assert.deepEqual(await keyword('heron', 'ws-bob', 'alice'), []);
    assert.deepEqual(await grouped('苍鹭', 'ws-bob', 'alice'), []);
  });
});
