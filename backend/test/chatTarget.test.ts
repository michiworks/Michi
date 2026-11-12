/**
 * The one rule for whether a turn the backend starts on its own (a
 * send_to_thread message or its wake reply, a multi-model step, an Agent Run
 * Watch wake, a scheduled run) may still run in a chat, and how each caller
 * maps it. send_to_thread and the scheduled executor run the same states in
 * their own suites (threadMessageTool, scheduledJobsChatExecutor).
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProductionParentTarget } from '../src/agents/agentRunAssembly';
import { chatNodeUnavailable, chatTargetUnavailable, type ChatTargetUnavailable } from '../src/services/chatTarget';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode } from '../src/services/dbRepository';
import { callerUnavailable, childAvailable } from '../src/services/multiModel/childThreads';

const WS = 'ws';

/** Each state, applied to chat 'n-chat' (tree 't-chat' in WS), and what the rule answers for it. */
const STATES: Array<[string, () => void, ChatTargetUnavailable | null]> = [
  ['a live chat', () => {}, null],
  ['a chat with no tree', () => run("UPDATE nodes SET tree_id = NULL WHERE id = 'n-chat'"), null],
  ['a purged chat', () => run("UPDATE nodes SET purged_at = 5 WHERE id = 'n-chat'"), 'gone'],
  ['not a chat', () => run("UPDATE nodes SET kind = 'digest' WHERE id = 'n-chat'"), 'not_chat'],
  ['the legacy archived status', () => run("UPDATE nodes SET status = 'archived' WHERE id = 'n-chat'"), 'archived'],
  ['an archived branch', () => run("UPDATE nodes SET deleted_at = 5, deletion_group_id = 'arch-1' WHERE id = 'n-chat'"), 'archived'],
  ['an archived tree', () => run("UPDATE trees SET archived_at = 5 WHERE id = 't-chat'"), 'archived'],
  ['a chat in the Trash', () => run("UPDATE nodes SET deleted_at = 5, deletion_group_id = 'del-1' WHERE id = 'n-chat'"), 'trashed'],
  ['a chat in the Trash inside an archived tree', () => {
    run("UPDATE trees SET archived_at = 5 WHERE id = 't-chat'");
    run("UPDATE nodes SET deleted_at = 6, deletion_group_id = 'del-1' WHERE id = 'n-chat'");
  }, 'trashed'],
  ['an archived workspace', () => run(`UPDATE workspaces SET archived_at = 5 WHERE id = '${WS}'`), 'workspace_archived'],
  ['a workspace in the Trash', () => run(`UPDATE workspaces SET deleted_at = 5 WHERE id = '${WS}'`), 'workspace_trashed'],
  ['a chat moved to another workspace', () => {
    run("UPDATE trees SET workspace_id = 'ws-other' WHERE id = 't-chat'");
    run("UPDATE nodes SET workspace_id = 'ws-other' WHERE id = 'n-chat'");
  }, 'moved'],
];

const NODE_REASONS = new Set<ChatTargetUnavailable>(['gone', 'not_chat', 'archived', 'trashed']);

function run(sql: string): void {
  getDb().prepare(sql).run();
}

describe('chatTarget', () => {
  let tmpDir: string;

  function freshDatabase(): void {
    closeDb();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-chat-target-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    initDb();
    run(`INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('${WS}', 'W', 1, 1), ('ws-other', 'Other', 1, 1)`);
    run(`INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES ('t-chat', '${WS}', 'n-chat', 1, 1)`);
    run(`INSERT INTO nodes (id, workspace_id, tree_id, kind, title, status, created_at) VALUES ('n-chat', '${WS}', 't-chat', 'chat', 'Chat', 'idle', 1)`);
  }

  beforeEach(() => {
    delete process.env.MICHI_CLOUD;
    freshDatabase();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('names why a chat cannot take a backend-started turn', () => {
    assert.equal(chatTargetUnavailable(getNode('n-missing')), 'gone');
    for (const [label, mutate, expected] of STATES) {
      freshDatabase();
      mutate();
      const node = getNode('n-chat');
      assert.equal(chatTargetUnavailable(node, WS), expected, label);
      assert.equal(chatNodeUnavailable(node), expected !== null && NODE_REASONS.has(expected) ? expected : null, `${label}: the chat itself`);
      if (expected === 'moved') assert.equal(chatTargetUnavailable(node), null, `${label}: no workspace to stay in`);
    }
  });

  test('multi-model: the caller is removed or moved, and a branch is gone only for its own state', () => {
    for (const [label, mutate, expected] of STATES) {
      freshDatabase();
      mutate();
      assert.equal(callerUnavailable('n-chat', WS), expected === null ? null : expected === 'moved' ? 'moved' : 'removed', label);
      assert.equal(childAvailable('n-chat'), expected === null || !NODE_REASONS.has(expected), `${label}: as a branch`);
    }
  });

  test('an Agent Run Watch wakes only a chat that may take the turn', async () => {
    for (const [label, mutate, expected] of STATES) {
      freshDatabase();
      mutate();
      const ensured: string[] = [];
      const started: string[] = [];
      const locks: string[] = [];
      let locked = false;
      const target = new ProductionParentTarget({
        ensureParentSession: async (input: { nodeId: string }) => { ensured.push(input.nodeId); return { id: input.nodeId }; },
      } as any, {
        startRequestedSelfTurn: async (input: { turnId: string }) => {
          assert.equal(locked, true, `${label}: the turn registers under the restore lock`);
          started.push(input.turnId);
          return { turnId: input.turnId, assistantId: 'assistant', existing: false, done: Promise.resolve() };
        },
        requestedTurnStatus: () => 'completed',
      } as any, {} as any, {
        acquireRestoreLock: async (nodeId) => { locks.push(nodeId); locked = true; return () => { locked = false; }; },
        isLiveSession: (session) => session.id === 'n-chat',
      });
      const result = await target.continueParent({
        deliveryId: 'delivery-1', requestedTurnId: 'requested-turn', ownerUserId: 'owner-1',
        workspaceId: WS, parentRunId: null, parentNodeId: 'n-chat', parentTurnId: 'parent-turn',
        runIds: ['run-1'], handoff: 'done',
      });
      assert.equal(result, expected === null ? 'delivered' : 'undeliverable', label);
      assert.deepEqual([ensured.length, started.length], expected === null ? [1, 1] : [0, 0], `${label}: opens and starts nothing when refused`);
      assert.deepEqual(locks, expected === null ? ['n-chat'] : [], label);
      assert.equal(locked, false, `${label}: the lock is released`);
    }
  });
});
