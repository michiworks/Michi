import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent, type DurableTurnSnapshot } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { beginTurn, finalizeTurn, getNode, loadAllWorkspacesMeta } from '../src/services/dbRepository';
import { applyWorkspaceCommands } from '../src/services/domainCommands';
import { subscribeNodeCompletionSeen, type NodeCompletionSeen } from '../src/services/attentionSignals';

// Migration 0064 and the facts it holds: completion counts written with the
// turn receipt, seen counts written by the view mark, both in the hydration rows.

let dir: string;
let previousData: string | undefined;
let previousCloud: string | undefined;
let op = 0;

beforeEach(() => {
  previousData = process.env.MICHI_DATA_DIR;
  previousCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-attention-facts-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  const workspace = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  workspace.run('ws-a', 'Mine', 'alice');
  workspace.run('ws-b', 'Theirs', 'bob');
  const node = getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES (?,?,'chat','idle',1)");
  node.run('n-a', 'ws-a');
  node.run('n-b', 'ws-b');
});

afterEach(() => {
  closeDb();
  if (previousData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousData;
  if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

function event(name: ChatStreamEvent['event'], data: Record<string, unknown>): ChatStreamEvent {
  return { event: name, data } as ChatStreamEvent;
}

/** Runs one durable turn through begin and finalize, as ChatHub persists it. */
function turn(nodeId: string, turnId: string, ending: Array<[ChatStreamEvent['event'], Record<string, unknown>]>): DurableTurnSnapshot {
  let snapshot = createDurableTurn({ turnId, assistantId: `a-${turnId}`, nodeId, workspaceId: 'ws-a', displayUserText: 'Hi', startedAt: 1 });
  beginTurn(snapshot);
  ending.forEach(([name, data], index) => { snapshot = applyTurnEvent(snapshot, event(name, { seq: index + 1, ...data })); });
  finalizeTurn(snapshot);
  return snapshot;
}

function facts(nodeId: string) {
  // node:sqlite rows have a null prototype; strict deepEqual wants plain objects.
  return { ...getDb().prepare(`SELECT completion_seq, last_completed_at, last_completed_turn_id, seen_completion_seq
    FROM nodes WHERE id = ?`).get(nodeId) as {
      completion_seq: number; last_completed_at: number | null; last_completed_turn_id: string | null; seen_completion_seq: number;
    } };
}

const view = (workspaceId: string, payload: Record<string, unknown>, ownerUserId: string | null = null) =>
  applyWorkspaceCommands(workspaceId, { operationId: `view-${++op}`, ownerUserId, commands: [{ type: 'node.patch', payload }] });

describe('migration 0064', () => {
  test('adds the node facts with defaults and the notification table with its constraints', () => {
    assert.deepEqual(facts('n-a'), { completion_seq: 0, last_completed_at: null, last_completed_turn_id: null, seen_completion_seq: 0 });
    const applied = getDb().prepare("SELECT 1 FROM schema_migrations WHERE version = '0064_attention'").get();
    assert.ok(applied, 'the migration is recorded in the ledger');
    const indexes = (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attention_notifications'")
      .all() as Array<{ name: string }>).map((row) => row.name);
    for (const name of ['idx_attention_active_key', 'idx_attention_fact', 'idx_attention_owner_status', 'idx_attention_workspace']) {
      assert.ok(indexes.includes(name), `${name} exists`);
    }
    const insert = getDb().prepare(`INSERT INTO attention_notifications
      (id, owner_user_id, workspace_id, target_type, target_id, key, fact, kind, reason, title, body, created_at, status, resolve_reason, resolved_at)
      VALUES (?, 'alice', 'ws-a', 'node', 'n-a', 'node:n-a', ?, 'finished', 'completed', 'T', '', 1, ?, ?, ?)`);
    insert.run('r1', 'completion:1', 'active', null, null);
    assert.throws(() => insert.run('r2', 'completion:2', 'active', null, null), /UNIQUE/, 'one active record per key');
    insert.run('r3', 'completion:3', 'resolved', 'seen', 2);
    assert.throws(() => insert.run('r4', 'completion:3', 'resolved', 'seen', 2), /UNIQUE/, 'a fact is recorded once per key');
    assert.throws(() => insert.run('r5', 'completion:5', 'resolved', null, 2), /CHECK/, 'a resolved record says why');
    assert.throws(() => insert.run('r6', 'completion:6', 'active', null, 3), /CHECK/, 'an active record has no resolution time');
    const minimal = getDb().prepare(`INSERT INTO attention_notifications
      (id, owner_user_id, workspace_id, target_type, target_id, key, fact, kind, reason, title, created_at)
      VALUES (?, 'alice', ?, 'node', 'n-a', ?, 'f', ?, 'completed', 'T', 1)`);
    assert.throws(() => minimal.run('r7', 'ws-a', 'node:kind', 'urgent'), /CHECK/, 'kind is one of the three');
    assert.throws(() => minimal.run('r8', 'ws-missing', 'node:fk', 'finished'), /FOREIGN KEY/, 'the workspace must exist');
    minimal.run('r9', 'ws-a', 'node:defaults', 'finished');
    assert.deepEqual({ ...getDb().prepare("SELECT status, body FROM attention_notifications WHERE id = 'r9'").get() }, { status: 'active', body: '' });
    getDb().prepare("DELETE FROM attention_notifications WHERE id = 'r9'").run();
    getDb().prepare("UPDATE attention_notifications SET status = 'resolved', resolve_reason = 'stale', resolved_at = 5 WHERE id = 'r1'").run();
    getDb().prepare('DELETE FROM workspaces WHERE id = ?').run('ws-a');
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM attention_notifications').get() as { n: number }).n, 0,
      'records go with their workspace');
  });
});

describe('completion facts', () => {
  test('a turn that completed with an answer is counted once, with the receipt', () => {
    const snapshot = turn('n-a', 't1', [['chunk', { text: 'Done.' }], ['done', { stopReason: 'end_turn', completedAt: 1_234 }]]);
    assert.deepEqual(facts('n-a'), { completion_seq: 1, last_completed_at: 1_234, last_completed_turn_id: 't1', seen_completion_seq: 0 });
    finalizeTurn(snapshot);
    assert.equal(facts('n-a').completion_seq, 1, 'finalizing again does not count again');
    turn('n-a', 't2', [['tool_call', { toolCallId: 'tool-1', title: 'ls', status: 'completed' }], ['done', { stopReason: 'end_turn', completedAt: 2_000 }]]);
    assert.deepEqual([facts('n-a').completion_seq, facts('n-a').last_completed_turn_id], [2, 't2'], 'a tool-only answer counts');
  });

  test('cancelled, failed and empty turns are not completions', () => {
    turn('n-a', 't-cancel', [['chunk', { text: 'Partial' }], ['done', { stopReason: 'cancelled' }]]);
    turn('n-a', 't-error', [['chunk', { text: 'Partial' }], ['error', { message: 'boom' }]]);
    turn('n-a', 't-empty', [['done', { stopReason: 'end_turn' }]]);
    turn('n-a', 't-thinking', [['thought', { text: 'Hmm' }], ['done', { stopReason: 'end_turn' }]]);
    assert.deepEqual(facts('n-a'), { completion_seq: 0, last_completed_at: null, last_completed_turn_id: null, seen_completion_seq: 0 });
  });

  test('the hydration rows carry the facts, and graph snapshots cannot write them', () => {
    turn('n-a', 't1', [['chunk', { text: 'One' }], ['done', { stopReason: 'end_turn', completedAt: 10 }]]);
    view('ws-a', { id: 'n-a', viewed_at: 20, seen_completion_seq: 1 });
    applyWorkspaceCommands('ws-a', { operationId: 'graph', commands: [
      { type: 'node.upsert', payload: { id: 'n-a', workspace_id: 'ws-a', kind: 'chat', created_at: 1, completion_seq: 0 } },
      { type: 'node.patch', payload: { id: 'n-a', title: 'Renamed', completion_seq: 99, seen_completion_seq: 0, viewed_at: 21 } },
    ] });
    const row = loadAllWorkspacesMeta().flatMap((workspace) => workspace.nodes).find((node) => node.id === 'n-a')!;
    assert.deepEqual(
      [row.completion_seq, row.last_completed_at, row.last_completed_turn_id, row.seen_completion_seq, row.title],
      [1, 10, 't1', 1, 'Renamed'],
    );
  });
});

describe('the view mark carries the seen completion count', () => {
  test('it only moves forward, is held to the completion count, and is announced after commit', () => {
    const seen: NodeCompletionSeen[] = [];
    let committedAtAnnouncement: number | null = null;
    const unsubscribe = subscribeNodeCompletionSeen((mark) => {
      seen.push(mark);
      committedAtAnnouncement = facts(mark.nodeId).seen_completion_seq;
    });
    try {
      turn('n-a', 't1', [['chunk', { text: 'One' }], ['done', { stopReason: 'end_turn' }]]);
      turn('n-a', 't2', [['chunk', { text: 'Two' }], ['done', { stopReason: 'end_turn' }]]);
      view('ws-a', { id: 'n-a', viewed_at: 5, seen_completion_seq: 1 });
      assert.equal(facts('n-a').seen_completion_seq, 1);
      assert.deepEqual(seen, [{ workspaceId: 'ws-a', nodeId: 'n-a', seenCompletionSeq: 1 }]);
      assert.equal(committedAtAnnouncement, 1, 'listeners read the committed row');
      view('ws-a', { id: 'n-a', viewed_at: 6, seen_completion_seq: 0 });
      assert.equal(facts('n-a').seen_completion_seq, 1, 'an older mark from another window does not move it back');
      view('ws-a', { id: 'n-a', viewed_at: 7, seen_completion_seq: 50 });
      assert.equal(facts('n-a').seen_completion_seq, 2, 'never above what the server recorded');
      view('ws-a', { id: 'n-a', viewed_at: 8, seen_completion_seq: 2 });
      assert.equal(seen.length, 2, 'a mark that sees nothing new is not announced');
      assert.equal(getNode('n-a')?.viewed_at, 8, 'the view mark itself still lands');
    } finally {
      unsubscribe();
    }
  });

  test('a view-mark-only patch never fails the batch, and malformed counts are rejected', () => {
    assert.doesNotThrow(() => view('ws-a', { id: 'n-gone', viewed_at: 5, seen_completion_seq: 1 }));
    assert.throws(() => view('ws-a', { id: 'n-a', viewed_at: 5, seen_completion_seq: -1 }), /seen_completion_seq/);
    assert.throws(() => view('ws-a', { id: 'n-a', viewed_at: 5, seen_completion_seq: 1.5 }), /seen_completion_seq/);
    assert.throws(() => view('ws-a', { id: 'n-a', seen_completion_seq: 1 }), /only accepted with viewed_at/);
    view('ws-a', { id: 'n-b', viewed_at: 5, seen_completion_seq: 1 });
    assert.equal(facts('n-b').seen_completion_seq, 0, 'a node of another workspace is untouched');
  });

  test('in the cloud the mark needs the workspace owner', () => {
    process.env.MICHI_CLOUD = '1';
    getDb().prepare("UPDATE nodes SET completion_seq = 1 WHERE id IN ('n-a', 'n-b')").run();
    assert.throws(() => view('ws-b', { id: 'n-b', viewed_at: 5, seen_completion_seq: 1 }, 'alice'), /not found/);
    assert.equal(facts('n-b').seen_completion_seq, 0);
    view('ws-a', { id: 'n-a', viewed_at: 5, seen_completion_seq: 1 }, 'alice');
    assert.equal(facts('n-a').seen_completion_seq, 1);
  });
});
