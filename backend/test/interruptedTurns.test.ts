import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERRUPTED_TURN_LIMITS } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { dismissInterruptedTurn, listInterruptedTurns } from '../src/services/interruptedTurns';
import { seedConversation, type SeedTurn } from './helpers/homeConversations';

const OWNER = LOCAL_AGENT_OWNER_ID;
const NOW = 100 * 24 * 60 * 60_000;
const CLAUDE_AUTH = 'Claude authentication failed. Refresh the CLI credentials and retry; the original session is retained.';
let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-interrupted-turns-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  const insert = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  insert.run('ws', 'sample-project', null);
  insert.run('ws-2', 'sample-notes', null);
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function chat(turns: Array<Partial<SeedTurn> & Pick<SeedTurn, 'status'>>, extra: { workspaceId?: string; title?: string | null; userMessageAt?: number } = {}): string {
  const nodeId = `c${++n}`;
  seedConversation({ nodeId, workspaceId: extra.workspaceId ?? 'ws', title: extra.title, userMessageAt: extra.userMessageAt,
    turns: turns.map((turn, index) => ({ startedAt: NOW - 60_000 + index * 1_000, ...turn })) });
  return nodeId;
}

const listed = () => listInterruptedTurns(OWNER, NOW).items;

test('lists conversations whose latest turn a restart or expired credentials stopped, newest first', () => {
  const restarted = chat([{ status: 'error', error: 'backend_restarted', startedAt: NOW - 5_000 }], { workspaceId: 'ws-2' });
  const expired = chat([{ status: 'error', error: CLAUDE_AUTH, startedAt: NOW - 3_000 }], { title: null });
  chat([{ status: 'error', error: 'DeepSeek API key not configured' }]);
  chat([{ status: 'completed' }]);
  chat([{ status: 'active' }]);
  assert.deepEqual(listed().map((item) => item.nodeId), [expired, restarted]);
  const [first, second] = listed();
  assert.equal(first.title, 'Question 0', 'an untitled chat is named by its first request');
  assert.equal(second.workspaceName, 'sample-notes');
});

test('a conversation that moved on is no longer listed', () => {
  // Resumed: a newer turn is the latest one, whatever happened to it.
  chat([{ status: 'error', error: 'backend_restarted' }, { status: 'active' }]);
  chat([{ status: 'error', error: 'backend_restarted' }, { status: 'completed' }]);
  // Written to since, without a turn of its own yet.
  chat([{ status: 'error', error: 'backend_restarted', startedAt: NOW - 5_000 }], { userMessageAt: NOW - 1_000 });
  // An earlier interruption under a newer ordinary failure.
  chat([{ status: 'error', error: 'backend_restarted' }, { status: 'error', error: 'boom' }]);
  assert.deepEqual(listed(), []);
});

test('leaves out old, hidden and run-owned turns', () => {
  chat([{ status: 'error', error: 'backend_restarted', startedAt: NOW - INTERRUPTED_TURN_LIMITS.maxAgeMs - 60_000 }]);
  chat([{ status: 'error', error: 'backend_restarted', scheduledJobId: 'job-1' }]);
  chat([{ id: 'mm-run-1-answer', status: 'error', error: 'backend_restarted' }]);
  seedConversation({ nodeId: 'trashed', workspaceId: 'ws', deletedAt: NOW, turns: [{ status: 'error', error: 'backend_restarted', startedAt: NOW - 1_000 }] });
  seedConversation({ nodeId: 'archived-tree', workspaceId: 'ws', treeArchivedAt: NOW, turns: [{ status: 'error', error: 'backend_restarted', startedAt: NOW - 1_000 }] });
  seedConversation({ nodeId: 'maintenance', workspaceId: 'ws', maintenanceJobId: 'm1', turns: [{ status: 'error', error: 'backend_restarted', startedAt: NOW - 1_000 }] });
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at,deleted_at) VALUES (?,?,?,1,1,?)').run('ws-trash', 'Gone', null, NOW);
  chat([{ status: 'error', error: 'backend_restarted' }], { workspaceId: 'ws-trash' });
  assert.deepEqual(listed(), []);
});

test('a dismissed turn stays dismissed; another owner cannot dismiss or see it', () => {
  process.env.MICHI_CLOUD = '1';
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws-a', 'Mine', 'alice');
  const nodeId = chat([{ status: 'error', error: 'backend_restarted' }], { workspaceId: 'ws-a' });
  const [item] = listInterruptedTurns('alice', NOW).items;
  assert.equal(item.nodeId, nodeId);
  assert.deepEqual(listInterruptedTurns('bob', NOW).items, []);
  assert.equal(dismissInterruptedTurn('bob', item.turnId), false);
  assert.equal(listInterruptedTurns('alice', NOW).items.length, 1);
  assert.equal(dismissInterruptedTurn('alice', item.turnId), true);
  assert.equal(dismissInterruptedTurn('alice', item.turnId), true, 'dismissing twice is fine');
  assert.deepEqual(listInterruptedTurns('alice', NOW).items, []);
});
