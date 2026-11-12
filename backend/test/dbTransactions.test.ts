import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb, runAfterCommit, runInTransaction } from '../src/services/db';
import { pagesTransaction } from '../src/services/pages/core';
import { memoryTransaction } from '../src/services/memory/memoryRepository';

let dir: string;
let oldData: string | undefined;
beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-db-transactions-'));
  process.env.MICHI_DATA_DIR = dir;
  closeDb(); initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', 'alice');
});
afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  fs.rmSync(dir, { recursive: true, force: true });
});

const rename = (name: string) => getDb().prepare('UPDATE workspaces SET name=? WHERE id=?').run(name, 'ws');
const name = () => (getDb().prepare("SELECT name FROM workspaces WHERE id='ws'").get() as { name: string }).name;

for (const [label, transaction] of [['pagesTransaction', pagesTransaction], ['memoryTransaction', memoryTransaction]] as const) {
  test(`an outermost ${label} runs its after-commit work only once it commits`, () => {
    const ran: string[] = [];
    transaction(() => {
      rename('Committed');
      runAfterCommit(() => ran.push(`committed while ${getDb().isTransaction ? 'open' : 'closed'}`));
    });
    assert.throws(() => transaction(() => {
      rename('Rolled back');
      runAfterCommit(() => ran.push('rolled back'));
      throw new Error('write failed');
    }), /write failed/);
    assert.deepEqual(ran, ['committed while closed']);
    assert.equal(name(), 'Committed');
  });

  test(`an outermost ${label} retries a body the database was too busy for`, () => {
    let attempts = 0;
    const result = transaction(() => {
      attempts += 1;
      rename(`Attempt ${attempts}`);
      if (attempts === 1) throw new Error('database is locked');
      return attempts;
    });
    assert.equal(result, 2);
    assert.equal(name(), 'Attempt 2');
  });
}

test('a nested transaction that rolls back drops its after-commit work, and the outer one keeps its own', () => {
  const ran: string[] = [];
  runInTransaction(() => {
    rename('Outer');
    runAfterCommit(() => ran.push('outer'));
    assert.throws(() => pagesTransaction(() => {
      rename('Inner');
      runAfterCommit(() => ran.push('inner'));
      throw new Error('inner failed');
    }), /inner failed/);
    runInTransaction(() => runAfterCommit(() => ran.push('nested')));
    assert.deepEqual(ran, []);
  });
  assert.deepEqual(ran, ['outer', 'nested']);
  assert.equal(name(), 'Outer');
});

test('a transaction inside a page or memory transaction joins it', () => {
  assert.throws(() => pagesTransaction(() => {
    memoryTransaction(() => runInTransaction(() => rename('Inner')));
    throw new Error('outer failed');
  }), /outer failed/);
  assert.equal(name(), 'Workspace');
});
