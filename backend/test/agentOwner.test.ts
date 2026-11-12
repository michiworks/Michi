import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ownerMatchParams, ownerMatchSql, requestAgentOwner, requestAgentOwnerOrNull, workspaceOwnerMatches,
} from '../src/services/agentOwner';

const priorCloud = process.env.MICHI_CLOUD;
afterEach(() => { if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud; });

function setCloud(cloud: boolean): void {
  if (cloud) process.env.MICHI_CLOUD = '1'; else delete process.env.MICHI_CLOUD;
}

test('the SQL owner filter matches workspaceOwnerMatches for every stored owner, caller and mode', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE workspaces (id TEXT, owner_user_id TEXT)');
  const stored = [null, 'local-user', 'u1'];
  stored.forEach((owner, index) => db.prepare('INSERT INTO workspaces VALUES (?, ?)').run(`w${index}`, owner));
  for (const cloud of [false, true]) {
    setCloud(cloud);
    for (const caller of ['local-user', 'u1']) {
      const matched = (db.prepare(`SELECT id FROM workspaces w WHERE ${ownerMatchSql()} ORDER BY id`).all(...ownerMatchParams(caller)) as Array<{ id: string }>)
        .map((row) => row.id);
      const expected = stored.flatMap((owner, index) => (workspaceOwnerMatches(owner, caller) ? [`w${index}`] : []));
      assert.deepEqual(matched, expected, `cloud=${cloud} caller=${caller}`);
    }
  }
  setCloud(false);
  assert.equal(db.prepare(`SELECT id FROM workspaces x WHERE ${ownerMatchSql('x')}`).all(...ownerMatchParams('local-user')).length, 3);
});

test('a request acts for the signed-in user in cloud mode and for the local user on the desktop', () => {
  setCloud(true);
  assert.equal(requestAgentOwner('alice'), 'alice');
  assert.equal(requestAgentOwner(undefined), '');
  assert.equal(requestAgentOwnerOrNull(' alice '), 'alice');
  assert.equal(requestAgentOwnerOrNull(undefined), null);
  assert.equal(requestAgentOwnerOrNull('  '), null);
  setCloud(false);
  assert.equal(requestAgentOwner('alice'), 'local-user');
  assert.equal(requestAgentOwner(undefined), 'local-user');
  assert.equal(requestAgentOwnerOrNull('alice'), 'local-user');
  assert.equal(requestAgentOwnerOrNull(null), 'local-user');
});
