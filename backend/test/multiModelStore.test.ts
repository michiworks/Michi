import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, getDb, initDb } from '../src/services/db';
import { SqliteMultiModelStore, isMultiModelStepTurn, type MultiModelRunRecord } from '../src/services/multiModel/store';
import type { MultiModelPlan, MultiModelRunState } from '../src/services/multiModel/types';

// isolateUserDirs (the test preload) points MICHI_DATA_DIR at a temporary directory for this file.

const store = new SqliteMultiModelStore();

function plan(): MultiModelPlan {
  return {
    version: 1, title: 'Caches', askPreview: 'Also ask Codex', reviewRounds: 1, sharedPrompt: 'Compare the caches.', sharedContext: 'fork',
    threads: [{
      key: 't1', runtimeId: 'codex', providerId: null, modelId: 'gpt', reasoning: 'high', runtimeLabel: 'Codex', modelLabel: 'GPT',
      context: 'fork', prompt: 'Compare the caches.', removed: false, addedByUser: false,
    }],
    nextAddedKey: 1,
    caller: { runtimeId: 'claude', runtimeLabel: 'Claude Code', modelLabel: 'Opus' },
  };
}

function state(): MultiModelRunState {
  return {
    version: 1, currentStep: 0, permissionMode: 'trust', approveForMe: false,
    threads: {
      t1: {
        key: 't1', childNodeId: 'n-child', previousChildNodeIds: [], generation: 0, stopRequested: false, late: false, addendumTurnId: null,
        steps: [{ status: 'queued', turnId: null, attempt: 1, startedAt: null, endedAt: null, summary: null, excerpt: null, error: null, totalTokens: null, notice: null }],
      },
    },
    synthesis: { status: 'pending', turnId: null, attempt: 0, startedAt: null, endedAt: null, summary: null, error: null, messageId: null, totalTokens: null },
    addenda: [{ turnId: 'mm-1-add1-a1', keys: ['t1'], status: 'failed', attempt: 1, error: 'boom', messageId: null }],
    cancelRequested: false,
    statusDetail: null,
  };
}

function run(id: string, overrides: Partial<MultiModelRunRecord> = {}): Omit<MultiModelRunRecord, 'revision' | 'updatedAt'> {
  return {
    id, nativeId: `mm_${id}`, ownerUserId: 'local-user', workspaceId: 'ws-a', callerNodeId: 'n-caller', callerTurnId: 'turn-ask',
    callerMessageId: 'm-assistant', askMessageId: 'm-ask', status: 'proposed', plan: plan(), state: state(),
    createdAt: 100, startedAt: null, endedAt: null, ...overrides,
  };
}

describe('SqliteMultiModelStore (real migrations)', () => {
  before(() => {
    closeDb();
    initDb();
    getDb().exec(`
      INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES ('ws-a', 'A', NULL, 1, 1), ('ws-b', 'B', NULL, 1, 1);
      INSERT INTO nodes (id, workspace_id, parent_node_id, kind, created_at) VALUES
        ('n-caller', 'ws-a', NULL, 'chat', 1),
        ('n-child', 'ws-a', 'n-caller', 'chat', 2),
        ('n-grandchild', 'ws-a', 'n-child', 'chat', 3),
        ('n-other', 'ws-a', 'n-caller', 'chat', 4),
        ('n-elsewhere', 'ws-b', 'n-child', 'chat', 5);
    `);
  });
  after(() => closeDb());

  test('inserts and reads runs with owner scoping', () => {
    store.insertRun(run('wfr_1'), 150);
    const read = store.getRun('local-user', 'wfr_1');
    assert.deepEqual(read, { ...run('wfr_1'), revision: 0, updatedAt: 150 });
    assert.equal(store.getRun('intruder', 'wfr_1'), null);
    assert.deepEqual(store.getRunById('wfr_1'), read);
    assert.equal(store.getRunById('wfr_missing'), null);
  });

  test('saveRun is a compare-and-set on the revision', () => {
    const first = store.getRunById('wfr_1')!;
    const second = store.getRunById('wfr_1')!;
    first.status = 'running';
    first.startedAt = 200;
    first.state.threads.t1.steps[0].status = 'running';
    assert.equal(store.saveRun(first, 0, 210), true);
    assert.equal(first.revision, 1, 'the record follows the row');
    assert.equal(first.updatedAt, 210);
    second.status = 'cancelled';
    assert.equal(store.saveRun(second, 0, 220), false, 'the stale copy loses');
    const stored = store.getRunById('wfr_1')!;
    assert.equal(stored.status, 'running');
    assert.equal(stored.revision, 1);
    assert.equal(stored.startedAt, 200);
    assert.equal(stored.state.threads.t1.steps[0].status, 'running');
    assert.equal(store.saveRun(first, 1, 230), true);
    assert.equal(store.getRunById('wfr_1')!.revision, 2);
  });

  test('lists open runs and a caller\'s runs by status, and skips an unreadable row', () => {
    store.insertRun(run('wfr_2', { createdAt: 300 }), 300);
    store.insertRun(run('wfr_3', { status: 'completed', createdAt: 400 }), 400);
    getDb().prepare(`INSERT INTO multi_model_runs (id, native_id, owner_user_id, workspace_id, caller_node_id, status, plan_json, state_json, created_at, updated_at)
      VALUES ('wfr_bad', 'mm_bad', 'local-user', 'ws-a', 'n-caller', 'proposed', '{"version":2}', '{}', 500, 500)`).run();
    assert.deepEqual(store.listOpenRuns().map((r) => r.id), ['wfr_1', 'wfr_2']);
    assert.deepEqual(store.listRunsForCaller('n-caller', ['proposed', 'completed']).map((r) => r.id), ['wfr_3', 'wfr_2']);
    assert.deepEqual(store.listRunsForCaller('n-caller', ['running']).map((r) => r.id), ['wfr_1']);
    assert.deepEqual(store.listRunsForCaller('n-caller', []), []);
    assert.equal(store.getRunById('wfr_bad'), null);
  });

  test('records turns once, settles them once and lists the open ones', () => {
    const turn = { turnId: 'mm-1-t1-g0-s0-a1', runId: 'wfr_1', nodeId: 'n-child', threadKey: 't1', role: 'answer' as const, round: 0, attempt: 1, createdAt: 600 };
    store.recordTurn(turn);
    store.recordTurn({ ...turn, nodeId: 'n-other', createdAt: 601 });
    assert.deepEqual(store.turn(turn.turnId), { ...turn, outcome: null, error: null, endedAt: null }, 'the first record is kept');
    store.recordTurn({ turnId: 'mm-1-syn-a1', runId: 'wfr_1', nodeId: 'n-caller', threadKey: null, role: 'synthesis', round: 0, attempt: 1, createdAt: 602 });
    assert.deepEqual(store.openTurns('wfr_1').map((t) => t.turnId), ['mm-1-t1-g0-s0-a1', 'mm-1-syn-a1']);
    store.settleTurn(turn.turnId, 'failed', 'boom', 700);
    store.settleTurn(turn.turnId, 'completed', null, 800);
    assert.deepEqual(store.turn(turn.turnId), { ...turn, outcome: 'failed', error: 'boom', endedAt: 700 }, 'the first outcome is kept');
    assert.deepEqual(store.openTurns('wfr_1').map((t) => t.turnId), ['mm-1-syn-a1']);
    assert.equal(store.turn('missing'), null);
    assert.equal(store.hasTurnOnNode('wfr_1', 'n-child'), true);
    assert.equal(store.hasTurnOnNode('wfr_1', 'n-other'), false);
    assert.equal(store.hasTurnOnNode('wfr_2', 'n-child'), false);
  });

  test('isMultiModelStepTurn is true only for answer and review turns', () => {
    store.recordTurn({ turnId: 'mm-1-t1-g0-s1-a1', runId: 'wfr_1', nodeId: 'n-child', threadKey: 't1', role: 'review', round: 1, attempt: 1, createdAt: 900 });
    assert.equal(isMultiModelStepTurn('mm-1-t1-g0-s0-a1'), true);
    assert.equal(isMultiModelStepTurn('mm-1-t1-g0-s1-a1'), true);
    assert.equal(isMultiModelStepTurn('mm-1-syn-a1'), false);
    assert.equal(isMultiModelStepTurn('mm-unknown'), false);
    assert.equal(isMultiModelStepTurn('turn-ask'), false);
  });

  test('marks children and finds the run of a node or its nearest marked ancestor in the same workspace', () => {
    assert.equal(store.runOfNode('n-child'), null);
    store.markChild('n-child', 'wfr_1', true);
    store.markChild('n-other', 'wfr_1', false);
    assert.equal(store.runOfNode('n-child'), 'wfr_1');
    assert.equal(store.runOfNode('n-caller'), null);
    assert.equal(store.runOfNode('missing'), null);
    assert.deepEqual({ ...getDb().prepare("SELECT fresh_context FROM nodes WHERE id = 'n-child'").get() }, { fresh_context: 1 });
    assert.deepEqual({ ...getDb().prepare("SELECT fresh_context FROM nodes WHERE id = 'n-other'").get() }, { fresh_context: 0 });
    assert.equal(store.runOfNodeOrAncestor('n-grandchild'), 'wfr_1', 'a spawn_branches child of a branch');
    assert.equal(store.runOfNodeOrAncestor('n-child'), 'wfr_1');
    assert.equal(store.runOfNodeOrAncestor('n-caller'), null);
    assert.equal(store.runOfNodeOrAncestor('n-elsewhere'), null, 'the walk stays in the workspace');
    getDb().prepare("UPDATE nodes SET deleted_at = 5 WHERE id = 'n-other'").run();
    assert.deepEqual(store.childNodesOfRun('wfr_1'), [{ nodeId: 'n-child', deleted: false }, { nodeId: 'n-other', deleted: true }]);
    assert.deepEqual(store.childNodesOfRun('wfr_2'), []);
  });

  test('walks at most 32 ancestors', () => {
    const insert = getDb().prepare("INSERT INTO nodes (id, workspace_id, parent_node_id, kind, created_at) VALUES (?, 'ws-a', ?, 'chat', 1)");
    insert.run('deep-0', 'n-child');
    for (let i = 1; i <= 32; i += 1) insert.run(`deep-${i}`, `deep-${i - 1}`);
    assert.equal(store.runOfNodeOrAncestor('deep-31'), 'wfr_1', '32 hops reach n-child');
    assert.equal(store.runOfNodeOrAncestor('deep-32'), null, 'the 33rd is not walked');
  });

  test('reads a step answer and its usage from the message its turn receipt names', () => {
    const insert = getDb().prepare('INSERT INTO messages (id, node_id, role, content, metadata, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const turn = getDb().prepare(`INSERT INTO turns (turn_id, node_id, assistant_message_id, status, started_at, updated_at) VALUES (?, 'n-child', ?, 'completed', 1, 1)`);
    insert.run('reply-s0', 'n-child', 'assistant', 'Use Redis.', JSON.stringify({ usageSummary: { totalTokens: 321 } }), 1, 10);
    insert.run('reply-s1', 'n-child', 'assistant', 'Still Redis.', '{not json', 2, 11);
    insert.run('self-n-child-mm-1-t1-g0-s2-a1', 'n-child', 'assistant', 'No receipt.', null, 3, 12);
    insert.run('reply-s3', 'n-child', 'assistant', 'Redis again.', JSON.stringify({ usageSummary: { inputTokens: 300, outputTokens: 21 } }), 4, 13);
    turn.run('mm-1-t1-g0-s0-a1', 'reply-s0');
    turn.run('mm-1-t1-g0-s1-a1', 'reply-s1');
    turn.run('mm-1-t1-g0-s3-a1', 'reply-s3');
    assert.deepEqual(store.readAnswer('n-child', 'mm-1-t1-g0-s0-a1'), { messageId: 'reply-s0', content: 'Use Redis.', totalTokens: 321 });
    assert.deepEqual(store.readAnswer('n-child', 'mm-1-t1-g0-s1-a1'), { messageId: 'reply-s1', content: 'Still Redis.' });
    assert.equal(store.readAnswer('n-child', 'mm-1-t1-g0-s2-a1'), null);
    assert.deepEqual(store.readAnswer('n-child', 'mm-1-t1-g0-s3-a1'), { messageId: 'reply-s3', content: 'Redis again.', totalTokens: 321 }, 'input plus output without a total');
    assert.equal(store.readAnswer('n-other', 'mm-1-t1-g0-s0-a1'), null);
  });

  test('finds the ask message: the caller turn\'s user message, else the latest user message before that turn began', () => {
    const message = getDb().prepare("INSERT INTO messages (id, node_id, role, content, seq, created_at) VALUES (?, 'n-caller', ?, ?, ?, ?)");
    message.run('m-old', 'user', 'Earlier', 1, 1_000);
    message.run('m-ask', 'user', 'Also ask Codex', 2, 2_000);
    message.run('m-reply', 'assistant', 'Proposing', 3, 2_100);
    message.run('m-later', 'user', 'Later', 4, 3_000);
    const turn = getDb().prepare(`INSERT INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, last_seq, started_at, updated_at)
      VALUES (?, 'n-caller', ?, ?, 'completed', 0, ?, ?)`);
    turn.run('turn-ask', 'm-ask', 'm-reply', 2_050, 2_050);
    turn.run('turn-self', null, 'self-n-caller-turn-self', 2_500, 2_500);
    assert.equal(store.askMessageIdFor('n-caller', 'turn-ask'), 'm-ask');
    assert.equal(store.askMessageIdFor('n-caller', 'turn-self'), 'm-ask', 'a turn without a user message falls back by time');
    assert.equal(store.askMessageIdFor('n-caller', null), 'm-later', 'no turn: the latest user message');
    assert.equal(store.askMessageIdFor('n-child', 'turn-ask'), null, 'the turn must belong to the node');
  });
});
