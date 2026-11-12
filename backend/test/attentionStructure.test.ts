import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunStatus, type AgentRunDtoV1 } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { deleteTree, deleteWorkspace, moveTreeToWorkspace, purgeWorkspaceNodes } from '../src/services/dbRepository';
import { applyWorkspaceCommands } from '../src/services/domainCommands';
import { structureEvents } from '../src/services/structureEvents';
import { AttentionFeed } from '../src/services/attention/attentionFeed';
import { AttentionRepository } from '../src/services/attention/attentionRepository';
import { AttentionService } from '../src/services/attention/attentionService';
import { collect, completeTurn, done, ev, manualClock, permission, records, turnStart } from './helpers/attentionHarness';

// Records and the structure they point at: trash, archive, moves and purges
// (workspace_structure_changed frames, subscribed as server.ts does) and the
// same rules at startup. Records carry thread titles and tool, question and
// error text, so none may outlive a purged target.

const LOCAL = 'local-user';
let dir: string;
let previousData: string | undefined;
let previousCloud: string | undefined;
let detach: Array<() => void> = [];
let op = 0;

function setup(options: { getRun?: (owner: string, id: string) => AgentRunDtoV1 | null; repository?: AttentionRepository } = {}) {
  const clock = manualClock();
  const feed = new AttentionFeed();
  // The bus swallows subscriber exceptions, so failures are collected instead.
  const errors: unknown[] = [];
  const service = new AttentionService({
    presence: { isTargetVisibleInFocusedWindow: () => false }, feed, clock, getRun: options.getRun, repository: options.repository,
    onError: (_message, error) => errors.push(error),
  });
  service.start();
  const unsubscribe = structureEvents.subscribe({ send: (frame) => service.structureChanged(frame) });
  detach.push(() => {
    structureEvents.flush();
    unsubscribe();
    service.stop();
    assert.deepEqual(errors, [], 'the service reported no failure');
  });
  return { clock, feed, service };
}

const command = (workspaceId: string, type: string, payload: Record<string, unknown>) =>
  applyWorkspaceCommands(workspaceId, { operationId: `op-${++op}`, commands: [{ type, payload }] as never });

const rows = () => records().map((row) => [row.target_id, row.status, row.resolve_reason]);

beforeEach(() => {
  previousData = process.env.MICHI_DATA_DIR;
  previousCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-attention-structure-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  const workspace = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  for (const id of ['ws-a', 'ws-b', 'ws-c']) workspace.run(id, id, 'alice');
  const tree = getDb().prepare('INSERT INTO trees(id,workspace_id,root_node_id,last_active_at,created_at) VALUES (?,?,?,1,1)');
  tree.run('t-1', 'ws-a', 'n-1');
  tree.run('t-2', 'ws-a', 'n-2');
  tree.run('t-b', 'ws-b', 'n-b');
  const node = getDb().prepare("INSERT INTO nodes(id,workspace_id,tree_id,parent_node_id,kind,status,title,created_at) VALUES (?,?,?,?,'chat','idle',?,1)");
  node.run('n-1', 'ws-a', 't-1', null, 'Fix the build');
  node.run('n-1c', 'ws-a', 't-1', 'n-1', 'A branch of it');
  node.run('n-2', 'ws-a', 't-2', null, 'Release notes');
  node.run('n-b', 'ws-b', 't-b', null, 'Elsewhere');
});

afterEach(() => {
  for (const fn of detach.reverse()) fn();
  detach = [];
  closeDb();
  if (previousData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousData;
  if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

const runOf = (overrides: Partial<AgentRunDtoV1> = {}): AgentRunDtoV1 => ({
  id: 'run-1', status: AgentRunStatus.Completed, workspaceId: 'ws-b', task: 'Review the parser', resultBundle: null,
  effectiveDefinition: { name: 'Reviewer' }, ...overrides,
} as AgentRunDtoV1);

describe('trash and archive', () => {
  test('trashing a thread, archiving its tree or trashing its workspace leaves its records stale, and windows hear it', async () => {
    const run = runOf();
    const { clock, feed, service } = setup({ getRun: () => run });
    const window = collect(feed, LOCAL);
    completeTurn('n-1', 'ws-a', 't1');
    service.observeChatEvent(done('n-1', 't1'));
    service.observeChatEvent(permission('n-1c', 't2', 1));
    service.observeChatEvent(permission('n-2', 't3', 1));
    service.observeChatEvent(permission('n-b', 't4', 1));
    const notified = service.agentRunNotifier.notify(LOCAL, run);
    clock.advance(1_000);
    await notified;
    assert.equal(records().filter((row) => row.status === 'active').length, 5);

    command('ws-a', 'node.patch', { id: 'n-1', deleted_at: 5, deletion_group_id: 'g-1' });
    structureEvents.flush();
    assert.deepEqual(window.of('attention_resolved').map((resolved) => [resolved.target.nodeId, resolved.reason]), [['n-1', 'stale']]);
    assert.equal(records().find((row) => row.target_id === 'n-1c')?.status, 'active', 'its branch is not in the trash');

    command('ws-a', 'tree.upsert', { id: 't-2', workspace_id: 'ws-a', root_node_id: 'n-2', archived_at: 7 });
    structureEvents.flush();
    command('ws-b', 'workspace.upsert', { id: 'ws-b', name: 'ws-b', deleted_at: 9 });
    structureEvents.flush();
    assert.deepEqual(rows(), [
      ['n-1', 'resolved', 'stale'], ['n-1c', 'active', null], ['n-2', 'resolved', 'stale'],
      ['n-b', 'resolved', 'stale'], ['run-1', 'resolved', 'stale'],
    ]);
    assert.deepEqual(service.snapshot(LOCAL).map((item) => item.target.type === 'node' ? item.target.nodeId : null), ['n-1c']);
  });

  test('archiving a workspace leaves its records stale too, and a target hidden like that gets no new record', () => {
    const { clock, service } = setup();
    service.observeChatEvent(permission('n-b', 't1', 1));
    clock.advance(1_000);
    command('ws-b', 'workspace.upsert', { id: 'ws-b', name: 'ws-b', archived_at: 3 });
    structureEvents.flush();
    assert.deepEqual(rows(), [['n-b', 'resolved', 'stale']]);
    service.observeChatEvent(permission('n-b', 't1', 2));
    getDb().prepare("UPDATE trees SET archived_at = 4 WHERE id = 't-2'").run();
    service.observeChatEvent(permission('n-2', 't2', 1));
    getDb().prepare("UPDATE nodes SET status = 'archived' WHERE id = 'n-1'").run();
    service.observeChatEvent(permission('n-1', 't3', 1));
    clock.advance(1_000);
    assert.deepEqual(rows(), [['n-b', 'resolved', 'stale']], 'archived workspace, tree or thread: nothing to call the user to');
  });
});

describe('purges', () => {
  test('a purged thread, tree or workspace takes every record of it along', () => {
    const { clock, feed, service } = setup();
    const window = collect(feed, LOCAL);
    completeTurn('n-1c', 'ws-a', 't1');
    service.observeChatEvent(done('n-1c', 't1'));
    clock.advance(1_000);
    service.nodeCompletionSeen({ workspaceId: 'ws-a', nodeId: 'n-1c', seenCompletionSeq: 1 });
    service.observeChatEvent(turnStart('n-1c', 't2'));
    service.observeChatEvent(permission('n-1c', 't2', 1));
    service.observeChatEvent(permission('n-1', 't3', 1));
    service.observeChatEvent(permission('n-2', 't4', 1));
    service.observeChatEvent(permission('n-b', 't5', 1));
    clock.advance(1_000);
    assert.deepEqual(rows(), [
      ['n-1c', 'resolved', 'seen'], ['n-1c', 'active', null], ['n-1', 'active', null], ['n-2', 'active', null], ['n-b', 'active', null],
    ]);

    purgeWorkspaceNodes('ws-a', ['n-1c']);
    structureEvents.flush();
    assert.deepEqual(rows(), [['n-1', 'active', null], ['n-2', 'active', null], ['n-b', 'active', null]],
      'its seen record and its active one: no row of it stays');
    assert.deepEqual(window.of('attention_resolved').map((resolved) => [resolved.target.nodeId, resolved.reason]),
      [['n-1c', 'seen'], ['n-1c', 'stale']], 'windows drop the active one');

    deleteTree('t-2');
    structureEvents.flush();
    deleteWorkspace('ws-b');
    structureEvents.flush();
    assert.deepEqual(rows(), [['n-1', 'active', null]], 'a deleted tree takes its threads, a purged workspace everything in it');
    assert.deepEqual(service.snapshot(LOCAL).map((item) => item.target.type === 'node' ? item.target.nodeId : null), ['n-1']);
  });
});

describe('moves', () => {
  test('a tree moved to another workspace takes its records along', () => {
    const { clock, service } = setup();
    service.observeChatEvent(turnStart('n-1', 't1'));
    service.observeChatEvent(permission('n-1', 't1', 1));
    service.observeChatEvent(permission('n-2', 't2', 1));
    clock.advance(1_000);
    moveTreeToWorkspace('t-1', 'ws-a', 'ws-c');
    structureEvents.flush();
    assert.deepEqual(records().map((row) => [row.target_id, row.workspace_id, row.status]),
      [['n-1', 'ws-c', 'active'], ['n-2', 'ws-a', 'active']]);
    assert.deepEqual(service.snapshot(LOCAL).map((item) => [item.target.type === 'node' ? item.target.nodeId : null, item.target.workspaceId]).sort(),
      [['n-1', 'ws-c'], ['n-2', 'ws-a']], 'a window opening it finds it where it is');
    service.observeChatEvent(ev('permission_resolved', { nodeId: 'n-1', chatId: 'n-1', turnId: 't1', requestId: 1 }));
    assert.deepEqual(records().map((row) => [row.target_id, row.status, row.resolve_reason]),
      [['n-1', 'resolved', 'answered'], ['n-2', 'active', null]], 'and it resolves as before');
  });
});

describe('frames', () => {
  test('a resync frame checks every record', () => {
    const { clock, service } = setup();
    service.observeChatEvent(permission('n-1', 't1', 1));
    service.observeChatEvent(permission('n-2', 't2', 1));
    service.observeChatEvent(permission('n-b', 't3', 1));
    clock.advance(1_000);
    getDb().prepare("UPDATE nodes SET deleted_at = 5 WHERE id = 'n-1'").run();
    getDb().prepare("UPDATE nodes SET purged_at = 5 WHERE id = 'n-b'").run();
    service.structureChanged({ epoch: 'e', seq: 4, changes: [], resync: true });
    assert.deepEqual(rows(), [['n-1', 'resolved', 'stale'], ['n-2', 'active', null]]);
  });

  test('changes that cannot leave a record behind, or touch no workspace with records, read nothing', () => {
    class CountingRepository extends AttentionRepository {
      reads = 0;
      override nodeFacts(nodeId: string): ReturnType<AttentionRepository['nodeFacts']> {
        this.reads += 1;
        return super.nodeFacts(nodeId);
      }
    }
    const repository = new CountingRepository();
    const { clock, service } = setup({ repository });
    service.observeChatEvent(permission('n-1', 't1', 1));
    clock.advance(1_000);
    repository.reads = 0;
    service.structureChanged({ epoch: 'e', seq: 1, changes: [
      { entity: 'node', op: 'renamed', workspaceId: 'ws-a', nodeId: 'n-1' },
      { entity: 'tree', op: 'created', workspaceId: 'ws-a', treeId: 't-9' },
      { entity: 'workspace', op: 'restored', workspaceId: 'ws-a' },
      { entity: 'node', op: 'deleted', workspaceId: 'ws-c', nodeId: 'n-9' },
    ] });
    assert.equal(repository.reads, 0);
    service.structureChanged({ epoch: 'e', seq: 2, changes: [{ entity: 'node', op: 'moved', workspaceId: 'ws-c', fromWorkspaceId: 'ws-a', nodeId: 'n-1' }] });
    assert.equal(repository.reads, 1, 'a move out of the record\'s workspace is read');
    assert.deepEqual(rows(), [['n-1', 'active', null]]);
  });
});

describe('startup', () => {
  test('after a restart, purged targets lose every record, hidden ones are stale and moved ones follow', () => {
    const first = setup();
    completeTurn('n-1', 'ws-a', 't1');
    first.service.observeChatEvent(done('n-1', 't1'));
    first.clock.advance(1_000);
    first.service.nodeCompletionSeen({ workspaceId: 'ws-a', nodeId: 'n-1', seenCompletionSeq: 1 });
    completeTurn('n-1c', 'ws-a', 't2');
    first.service.observeChatEvent(done('n-1c', 't2'));
    completeTurn('n-2', 'ws-a', 't3');
    first.service.observeChatEvent(done('n-2', 't3'));
    completeTurn('n-b', 'ws-b', 't4');
    first.service.observeChatEvent(done('n-b', 't4'));
    first.clock.advance(1_000);
    for (const fn of detach.splice(0)) fn();
    // While no service watched: purge one thread, archive another's tree, move a third.
    getDb().prepare("UPDATE nodes SET purged_at = 7 WHERE id = 'n-1'").run();
    getDb().prepare("UPDATE trees SET archived_at = 7 WHERE id = 't-2'").run();
    getDb().prepare("UPDATE nodes SET workspace_id = 'ws-c' WHERE id = 'n-b'").run();
    setup();
    assert.deepEqual(records().map((row) => [row.target_id, row.workspace_id, row.status, row.resolve_reason]), [
      ['n-1c', 'ws-a', 'active', null], ['n-2', 'ws-a', 'resolved', 'stale'], ['n-b', 'ws-c', 'active', null],
    ]);
  });
});
