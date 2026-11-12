import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DurableMessageMetadata } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { AttentionFeed } from '../src/services/attention/attentionFeed';
import { AttentionService } from '../src/services/attention/attentionService';
import { AttentionWakeFacts } from '../src/services/attention/attentionWakeFacts';
import { completeTurn, done, ev, manualClock, permission, records, turnStart } from './helpers/attentionHarness';

// send_to_thread exchanges: only an exchange's end is a completion to call
// the user to. Wake records are written here column by column, as
// services/threadMessageWakeStore.ts writes them (migration 0065).

let dir: string;
let previousData: string | undefined;
let previousCloud: string | undefined;
let stops: Array<() => void> = [];

function setup() {
  const clock = manualClock();
  const errors: unknown[] = [];
  const service = new AttentionService({
    presence: { isTargetVisibleInFocusedWindow: () => false }, feed: new AttentionFeed(), clock,
    onError: (_message, error) => errors.push(error),
  });
  service.start();
  stops.push(() => {
    service.stop();
    assert.deepEqual(errors, [], 'the service reported no failure');
  });
  return { clock, service };
}

/** send_to_thread with wake, as the tool records it before the message goes out. */
function wake(targetTurnId: string, callerNodeId: string, callerTurnId: string | null, targetNodeId: string, state = 'pending'): void {
  getDb().prepare(`INSERT INTO thread_message_wakes (target_turn_id, requested_turn_id, owner_user_id, workspace_id,
      caller_node_id, caller_turn_id, target_node_id, hop, state, created_at, updated_at)
    VALUES (?, ?, NULL, 'ws-a', ?, ?, ?, 2, ?, 1, 1)`).run(targetTurnId, replyTo(targetTurnId), callerNodeId, callerTurnId, targetNodeId, state);
}
const settleWake = (targetTurnId: string, state: string) =>
  getDb().prepare('UPDATE thread_message_wakes SET state = ? WHERE target_turn_id = ?').run(state, targetTurnId);
const replyTo = (targetTurnId: string) => `thread-reply-${targetTurnId}`;

const message = (fromNodeId: string): DurableMessageMetadata => ({ threadMessage: { fromNodeId, fromTitle: 'Peer', hop: 1 } });
const reply = (fromNodeId: string): DurableMessageMetadata => ({ threadMessage: { fromNodeId, fromTitle: 'Peer', kind: 'reply', hop: 2 } });

/** One turn, observed and persisted the way ChatHub runs it. */
function runTurn(service: AttentionService, nodeId: string, turnId: string, metadata?: DurableMessageMetadata): void {
  service.observeChatEvent(turnStart(nodeId, turnId, metadata));
  completeTurn(nodeId, 'ws-a', turnId, metadata);
  service.observeChatEvent(done(nodeId, turnId));
}

const finished = () => records().filter((row) => row.kind === 'finished').map((row) => [row.key, row.fact]);

beforeEach(() => {
  previousData = process.env.MICHI_DATA_DIR;
  previousCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-attention-wakes-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES ('ws-a','A','alice',1,1)").run();
  const node = getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,title,created_at) VALUES (?,'ws-a','chat','idle',?,1)");
  node.run('n-a', 'Sender');
  node.run('n-b', 'Target');
  node.run('n-c', 'Another sender');
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  closeDb();
  if (previousData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousData;
  if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('wake', () => {
  test('one wake round trip notifies once: when the sender\'s reply turn ends', () => {
    const { clock, service } = setup();
    service.observeChatEvent(turnStart('n-a', 'ta1'));
    wake('tb1', 'n-a', 'ta1', 'n-b');
    service.observeChatEvent(turnStart('n-b', 'tb1', message('n-a')));
    completeTurn('n-a', 'ws-a', 'ta1');
    service.observeChatEvent(done('n-a', 'ta1'));
    clock.advance(1_000);
    assert.deepEqual(finished(), [], 'the sender handed the task on: its chain goes on');
    completeTurn('n-b', 'ws-a', 'tb1', message('n-a'));
    service.observeChatEvent(done('n-b', 'tb1'));
    settleWake('tb1', 'delivering');
    clock.advance(1_000);
    assert.deepEqual(finished(), [], 'the target\'s answer goes back to the sender by itself');
    service.observeChatEvent(turnStart('n-a', replyTo('tb1'), reply('n-b')));
    settleWake('tb1', 'delivered');
    completeTurn('n-a', 'ws-a', replyTo('tb1'), reply('n-b'));
    service.observeChatEvent(done('n-a', replyTo('tb1')));
    clock.advance(1_000);
    assert.deepEqual(finished(), [['node:n-a', 'completion:2']], 'the reply that asks for nothing more ends the exchange');
    const target = getDb().prepare("SELECT completion_seq, seen_completion_seq FROM nodes WHERE id = 'n-b'").get() as Record<string, number>;
    assert.deepEqual({ ...target }, { completion_seq: 1, seen_completion_seq: 0 }, 'the target\'s answer still counts as unread');
  });

  test('a reply that wakes again is a hand-off too: only the last reply notifies', () => {
    const { clock, service } = setup();
    service.observeChatEvent(turnStart('n-a', 'ta1'));
    wake('tb1', 'n-a', 'ta1', 'n-b');
    completeTurn('n-a', 'ws-a', 'ta1');
    service.observeChatEvent(done('n-a', 'ta1'));
    runTurn(service, 'n-b', 'tb1', message('n-a'));
    clock.advance(1_000);
    settleWake('tb1', 'delivered');
    service.observeChatEvent(turnStart('n-a', replyTo('tb1'), reply('n-b')));
    wake('tb2', 'n-a', replyTo('tb1'), 'n-b');
    completeTurn('n-a', 'ws-a', replyTo('tb1'), reply('n-b'));
    service.observeChatEvent(done('n-a', replyTo('tb1')));
    runTurn(service, 'n-b', 'tb2', message('n-a'));
    clock.advance(1_000);
    assert.deepEqual(finished(), [], 'two hand-offs on each side so far');
    settleWake('tb2', 'delivered');
    runTurn(service, 'n-a', replyTo('tb2'), reply('n-b'));
    clock.advance(1_000);
    assert.deepEqual(finished(), [['node:n-a', 'completion:3']]);
  });

  test('a wake that will not be delivered leaves both ends to notify', () => {
    const { clock, service } = setup();
    // The message never began: the tool settled the wake undeliverable and told its sender.
    service.observeChatEvent(turnStart('n-a', 'ta1'));
    wake('tx', 'n-a', 'ta1', 'n-b', 'undeliverable');
    completeTurn('n-a', 'ws-a', 'ta1');
    service.observeChatEvent(done('n-a', 'ta1'));
    // The user put the sender in the trash while the target answered: the reply has nowhere to go.
    service.observeChatEvent(turnStart('n-c', 'tc1'));
    wake('tb1', 'n-c', 'tc1', 'n-b');
    service.observeChatEvent(turnStart('n-b', 'tb1', message('n-c')));
    completeTurn('n-c', 'ws-a', 'tc1');
    service.observeChatEvent(done('n-c', 'tc1'));
    getDb().prepare("UPDATE nodes SET deleted_at = 5 WHERE id = 'n-c'").run();
    completeTurn('n-b', 'ws-a', 'tb1', message('n-c'));
    service.observeChatEvent(done('n-b', 'tb1'));
    settleWake('tb1', 'undeliverable');
    clock.advance(1_000);
    assert.deepEqual(finished().sort(), [['node:n-a', 'completion:1'], ['node:n-b', 'completion:1']],
      'the abandoned sender\'s turn, and the answer that reaches nobody else');
  });
});

describe('wait', () => {
  test('a message answered while its sending turn still runs notifies only through the sender', () => {
    const { clock, service } = setup();
    service.observeChatEvent(turnStart('n-a', 'ta1'));
    runTurn(service, 'n-b', 'tb1', message('n-a'));
    clock.advance(1_000);
    assert.deepEqual(finished(), [], 'the sender is waiting for this answer');
    completeTurn('n-a', 'ws-a', 'ta1');
    service.observeChatEvent(done('n-a', 'ta1'));
    clock.advance(1_000);
    assert.deepEqual(finished(), [['node:n-a', 'completion:1']]);
  });

  test('a message whose sender stopped waiting notifies when it is answered', () => {
    const { clock, service } = setup();
    service.observeChatEvent(turnStart('n-a', 'ta1'));
    service.observeChatEvent(turnStart('n-b', 'tb1', message('n-a')));
    // The wait timed out (or the sender never waited), and its turn ended first.
    completeTurn('n-a', 'ws-a', 'ta1');
    service.observeChatEvent(done('n-a', 'ta1'));
    completeTurn('n-b', 'ws-a', 'tb1', message('n-a'));
    service.observeChatEvent(done('n-b', 'tb1'));
    clock.advance(1_000);
    assert.deepEqual(finished(), [['node:n-a', 'completion:1'], ['node:n-b', 'completion:1']]);
    // The sender's turn running now began after the message did: it is not the turn that sent it.
    service.observeChatEvent(turnStart('n-c', 'tc1'));
    service.observeChatEvent(turnStart('n-b', 'tb2', message('n-c')));
    service.observeChatEvent(ev('error', { nodeId: 'n-c', chatId: 'n-c', turnId: 'tc1', message: 'x', code: 'backend_restarted' }));
    service.observeChatEvent(turnStart('n-c', 'tc2'));
    completeTurn('n-b', 'ws-a', 'tb2', message('n-c'));
    service.observeChatEvent(done('n-b', 'tb2'));
    clock.advance(1_000);
    assert.deepEqual(finished(), [['node:n-a', 'completion:1'], ['node:n-b', 'completion:1'], ['node:n-b', 'completion:2']]);
  });
});

describe('scheduled chains', () => {
  test('woken replies in a chain a Scheduled Job began are left to the scheduler; their approvals are not', () => {
    const { clock, service } = setup();
    const scheduled = { scheduledJobId: 'job-1' };
    service.observeChatEvent(turnStart('n-a', 'ta1', scheduled));
    wake('tb1', 'n-a', 'ta1', 'n-b');
    completeTurn('n-a', 'ws-a', 'ta1', scheduled);
    service.observeChatEvent(done('n-a', 'ta1'));
    runTurn(service, 'n-b', 'tb1', message('n-a'));
    clock.advance(1_000);
    settleWake('tb1', 'delivered');
    service.observeChatEvent(turnStart('n-a', replyTo('tb1'), reply('n-b')));
    service.observeChatEvent(permission('n-a', replyTo('tb1'), 1));
    clock.advance(1_000);
    assert.deepEqual(records().map((row) => [row.reason, row.status]), [['approval', 'active']],
      'the scheduler watches only its run\'s own turn, so this approval is ours to announce');
    service.observeChatEvent(ev('permission_resolved', { nodeId: 'n-a', chatId: 'n-a', turnId: replyTo('tb1'), requestId: 1 }));
    completeTurn('n-a', 'ws-a', replyTo('tb1'), reply('n-b'));
    service.observeChatEvent(done('n-a', replyTo('tb1')));
    clock.advance(1_000);
    assert.deepEqual(finished(), [], 'the scheduled run\'s thread relies on the scheduler\'s notices');

    // In the same thread, a chain the user began notifies as usual.
    service.observeChatEvent(turnStart('n-a', 'tu1'));
    wake('tb2', 'n-a', 'tu1', 'n-b');
    completeTurn('n-a', 'ws-a', 'tu1');
    service.observeChatEvent(done('n-a', 'tu1'));
    runTurn(service, 'n-b', 'tb2', message('n-a'));
    clock.advance(1_000);
    settleWake('tb2', 'delivered');
    runTurn(service, 'n-a', replyTo('tb2'), reply('n-b'));
    clock.advance(1_000);
    assert.deepEqual(finished(), [['node:n-a', 'completion:4']]);
  });

  test('the chain origin follows replies back to the first turn that asked', () => {
    wake('tb1', 'n-a', 'ta1', 'n-b', 'delivered');
    wake('tb2', 'n-a', replyTo('tb1'), 'n-b', 'delivered');
    wake('tc1', 'n-c', null, 'n-b', 'delivered');
    const wakes = new AttentionWakeFacts();
    assert.equal(wakes.chainOrigin(replyTo('tb2')), 'ta1');
    assert.equal(wakes.chainOrigin(replyTo('tb1')), 'ta1');
    assert.equal(wakes.chainOrigin('ta1'), null, 'not a reply');
    assert.equal(wakes.chainOrigin(replyTo('tc1')), null, 'a record that could not name its turn');
    assert.equal(wakes.registeredOpenWake('n-a', 'ta1'), false, 'delivered is no longer open');
    assert.equal(wakes.answersWake('tb2'), true);
  });
});
