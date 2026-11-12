import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { listThreads, readNode, readNodeOverview, searchMessages } from '../src/services/globalContext';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR; oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-global-context-owner-'));
  process.env.MICHI_DATA_DIR = dir; process.env.MICHI_CLOUD = '1';
  closeDb(); initDb();
  const db = getDb();
  db.prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES ('ws','Mine','alice',1,1),('other','Theirs','bob',1,1)").run();
  db.prepare("INSERT INTO nodes(id,workspace_id,kind,status,title) VALUES ('n-other','other','chat','idle','Secret plans')").run();
  db.prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES ('m-1','n-other','user','the launch codeword',1,1)").run();
});
afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('in cloud mode a session without an owner reads no workspace, as one with another owner', () => {
  for (const owner of [null, undefined, '', 'alice']) {
    assert.equal(listThreads('ws', owner, 'other').status, 'no_workspace', String(owner));
    assert.equal(readNode('ws', owner, 'n-other').status, 'not_found', String(owner));
    assert.equal(readNodeOverview('ws', owner, 'n-other').status, 'not_found', String(owner));
    assert.doesNotMatch(searchMessages('ws', owner, 'codeword', 'all').text, /n-other/, String(owner));
  }
});
