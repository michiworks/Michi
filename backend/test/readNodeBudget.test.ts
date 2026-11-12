import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { readNode, type ReadNodeOpts } from '../src/services/globalContext';

// read_node fits whole messages in 12,288 characters. 40 messages of 1,000
// characters, alternating user and assistant: 12 fit in one read.
let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;
const id = (seq: number) => `m-${String(seq).padStart(2, '0')}`;
const range = (from: number, to: number, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => id(from + i * step));

function insertMessage(nodeId: string, seq: number, content: string, messageId = id(seq)): void {
  getDb().prepare('INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES (?,?,?,?,?,1)')
    .run(messageId, nodeId, seq % 2 ? 'user' : 'assistant', content, seq);
}

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR; oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-read-node-budget-'));
  process.env.MICHI_DATA_DIR = dir; process.env.MICHI_CLOUD = '1';
  closeDb(); initDb();
  const db = getDb();
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,settings,created_at,updated_at) VALUES (?,?,?,?,1,1)')
    .run('ws', 'Workspace', 'alice', JSON.stringify({ aiGlobalContext: true }));
  for (const nodeId of ['n-long', 'n-huge']) db.prepare("INSERT INTO nodes(id,workspace_id,kind,status,title) VALUES (?,'ws','chat','idle','Thread')").run(nodeId);
  for (let seq = 1; seq <= 40; seq++) insertMessage('n-long', seq, `${id(seq)} ${'x'.repeat(995)}`);
});
afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

function read(opts?: ReadNodeOpts, nodeId = 'n-long') {
  const result = readNode('ws', 'alice', nodeId, { ...opts, messageIds: true });
  assert.equal(result.status, 'ok', result.text);
  return { ...result, ids: [...result.text.matchAll(/\[message (m-\d+)\]: /g)].map((match) => match[1]!) };
}

test('without options and from the head, the newest and the oldest messages that fit are shown', () => {
  const newest = read();
  assert.deepEqual(newest.ids, range(29, 40));
  assert.deepEqual(newest.shownMessageIds, newest.ids);
  assert.match(newest.text, /\[28 earlier messages omitted by the size cap; continue with offset 13\]/);
  const oldest = read({ from: 'head' });
  assert.deepEqual(oldest.ids, range(1, 12));
  assert.match(oldest.text, /showing 12\/40 \(messages 1-12 of 40; continue with offset 13\)/);
});

test('reading from the tail keeps the newest end, with or without a limit or a role', () => {
  assert.deepEqual(read({ from: 'tail', limit: 20 }).ids, range(29, 40));
  assert.deepEqual(read({ from: 'tail' }).ids, range(29, 40));
  assert.deepEqual(read({ role: 'assistant' }).ids, range(18, 40, 2));
});

test('continuing with the offset the header names skips no message', () => {
  const first = read({ from: 'tail', limit: 20 });
  assert.match(first.text, /showing 12\/40 \(messages 29-40 of 40; continue with offset 13\)/);
  const second = read({ from: 'tail', offset: 13, limit: 20 });
  assert.deepEqual(second.ids, range(17, 28));
  assert.match(second.text, /messages 17-28 of 40; continue with offset 25\)/);
  const last = read({ from: 'tail', offset: 37 });
  assert.deepEqual(last.ids, range(1, 4));
  assert.match(last.text, /showing 4\/40 \(messages 1-4 of 40\)$/m);
});

test('a message longer than the cap is shown in parts that continue to its end', () => {
  // A surrogate pair straddles the first part's last character.
  const long = `${'y'.repeat(12_287)}😀${'z'.repeat(2_711)}`;
  insertMessage('n-huge', 1, 'short question', 'h-01');
  insertMessage('n-huge', 2, long, 'h-02');
  for (const opts of [undefined, { from: 'tail' as const, limit: 1 }]) {
    const first = read(opts, 'n-huge');
    assert.deepEqual(first.shownMessageIds, [], 'a part is not a whole message');
    const marker = first.text.match(/Continue with messageId "h-02" and charOffset (\d+)/);
    assert.ok(marker, first.text);
    let text = first.text.match(/^assistant \[message h-02\]: (.*)$/m)![1]!;
    let offset = Number(marker[1]);
    assert.equal(offset, 12_287);
    for (let step = 0; offset < long.length && step < 5; step++) {
      const next = read({ messageId: 'h-02', charOffset: offset }, 'n-huge');
      text += next.text.match(/^assistant \[message h-02\]: (.*)$/m)![1]!;
      const more = next.text.match(/charOffset (\d+)\]/);
      offset = more ? Number(more[1]) : long.length;
    }
    assert.equal(text, long);
  }
  const whole = read({ messageId: 'h-01', charOffset: 0 }, 'n-huge');
  assert.deepEqual(whole.shownMessageIds, ['h-01']);
  assert.equal(readNode('ws', 'alice', 'n-huge', { messageId: 'm-01' }).status, 'not_found', 'another thread\'s message');
});
