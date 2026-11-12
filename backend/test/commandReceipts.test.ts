import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb, initDb, runInTransaction } from '../src/services/db';
import { deleteCommandReceipts, withCommandReceipt } from '../src/services/commandReceipts';
import { DomainError } from '../src/services/domainErrors';

describe('command receipts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-command-receipts-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const receipt = (operationId: string, request: unknown, run: () => unknown) =>
    runInTransaction(() => withCommandReceipt({ ledgerId: 'ws-1', operationId, request, now: 1 }, run));

  test('replays the first result for the same request, whatever its key order', () => {
    let runs = 0;
    const first = receipt('op-1', { a: 1, nested: { x: true, y: [1, { p: 1, q: 2 }] } }, () => ({ value: ++runs }));
    const replay = receipt('op-1', { nested: { y: [1, { q: 2, p: 1 }], x: true }, a: 1 }, () => ({ value: ++runs }));
    assert.deepEqual(first, { value: 1 });
    assert.deepEqual(replay, first);
    assert.equal(runs, 1);
  });

  test('a different request under the same operation id is a conflict', () => {
    receipt('op-1', { a: 1 }, () => 'done');
    assert.throws(() => receipt('op-1', { a: 2 }, () => 'again'), (error: unknown) =>
      error instanceof DomainError && error.kind === 'conflict' && error.code === 'operation_id_reused'
      && /op-1 was reused with a different payload/.test(error.message));
  });

  test('replays a receipt written before requests were canonicalized', () => {
    const request = { z: 1, a: 2 };
    getDb().prepare(`INSERT INTO command_receipts (workspace_id, operation_id, payload_hash, result_json, created_at)
      VALUES ('ws-1', 'op-old', ?, '"stored"', 1)`)
      .run(createHash('sha256').update(JSON.stringify(request)).digest('hex'));
    assert.equal(receipt('op-old', request, () => 'ran again'), 'stored');
  });

  test('writes nothing when the command fails', () => {
    assert.throws(() => receipt('op-1', { a: 1 }, () => { throw new Error('boom'); }), /boom/);
    assert.equal(receipt('op-1', { a: 2 }, () => 'ok'), 'ok');
  });

  test('deletes the receipts of the given ledgers only', () => {
    receipt('op-1', {}, () => 1);
    runInTransaction(() => withCommandReceipt({ ledgerId: 'ws-2', operationId: 'op-1', request: {}, now: 1 }, () => 2));
    deleteCommandReceipts(['ws-1', 'ws-missing']);
    const ledgers = (getDb().prepare('SELECT workspace_id FROM command_receipts').all() as Array<{ workspace_id: string }>)
      .map((row) => row.workspace_id);
    assert.deepEqual(ledgers, ['ws-2']);
  });
});
