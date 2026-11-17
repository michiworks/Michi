/**
 * The live sessions of archived and deleted chats (alone, with their thread
 * or with their workspace) are released (ChatManager.releaseRetiredSessions),
 * and their open thread reply wakes settle (settleRetiredSenderWakes).
 */
import { afterEach, beforeEach, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
import type { WorkspaceStructureChange, WorkspaceStructureChangedEvent } from 'michi-shared';
import type { AgentRuntime, AgentSession, IdleReleaseVerdict } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, peekLiveSession, registerSession } from '../src/agents/sessionRegistry';
import { chatHub } from '../src/agents/chatHub';
import { settleRetiredSenderWakes } from '../src/agents/threadMessageWakes';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { acquireSessionRestoreLock } from '../src/services/nativeResume';
import { ChatManager } from '../src/services/chatManager';
import { createThreadWake, getThreadWake } from '../src/services/threadMessageWakeStore';
import { chatOwner } from './helpers/owners';

let tmpDir: string;

describe('ChatManager.releaseRetiredSessions', () => {
  const RUNTIME = 'claude-retire-test';
  let releases: string[];
  let kept: Set<string>;

  function fakeRuntime(idleRelease = true): AgentRuntime {
    return {
      id: RUNTIME, label: 'Retire test', descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
      capabilities: {
        modes: false, permissions: true, models: false, providerModels: false, reasoning: false,
        supportedReasoningLevels: [], apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: true,
      },
      async warm() {},
      async newSession() { throw new Error('unused'); },
      ...(idleRelease ? {
        idleRelease: (id: string): IdleReleaseVerdict => kept.has(id) ? { action: 'keep', reason: 'background_work' } : { action: 'release' },
      } : {}),
      async releaseSession(id) { releases.push(id); },
      async shutdown() {},
    };
  }

  function liveSession(id: string): AgentSession {
    const session: AgentSession = {
      id, runtimeId: RUNTIME, nativeSessionId: `native-${id}`, owner: chatOwner(id),
      getHistory: () => [], getPendingAssistant: () => undefined,
      async *send() { /* unused */ }, cancel() {},
    };
    registerSession(session, null, chatOwner(id));
    return session;
  }

  function chat(id: string, workspaceId: string, fields: { tree?: string; deletedGroup?: string } = {}): void {
    saveNode({
      id, workspace_id: workspaceId, tree_id: fields.tree ?? null, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1,
      ...(fields.deletedGroup ? { deleted_at: 2, deletion_group_id: fields.deletedGroup } : {}),
    });
    liveSession(id);
  }

  const frame = (changes: WorkspaceStructureChange[], resync = false): WorkspaceStructureChangedEvent =>
    ({ epoch: 'e', seq: 1, changes, ...(resync ? { resync: true as const } : {}) });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-retired-sessions-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    releases = [];
    kept = new Set();
    registerRuntime(fakeRuntime());
    saveWorkspace({ id: 'ws-a', name: 'A', cwd: tmpDir, created_at: 1, updated_at: 1 });
    saveWorkspace({ id: 'ws-b', name: 'B', cwd: tmpDir, created_at: 1, updated_at: 1 });
    saveNode({ id: 'root-1', workspace_id: 'ws-a', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
    saveTree({ id: 't-1', workspace_id: 'ws-a', root_node_id: 'root-1', last_active_at: 1, created_at: 1 });
    saveTree({ id: 't-2', workspace_id: 'ws-a', root_node_id: 'root-1', last_active_at: 1, created_at: 1 });
  });

  afterEach(() => {
    clearAllSessions();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The archived and deleted state the frames below describe. */
  function retire(): void {
    getDb().prepare('UPDATE trees SET archived_at = 5 WHERE id = ?').run('t-1');
    getDb().prepare('UPDATE workspaces SET archived_at = 5 WHERE id = ?').run('ws-b');
  }

  test('an archived thread, chat or workspace and a trashed chat give back their sessions; busy and running ones, and the rest, keep theirs', async (t: TestContext) => {
    chat('in-archived-thread', 'ws-a', { tree: 't-1' });
    chat('archived-chat', 'ws-a', { tree: 't-2', deletedGroup: 'arch-1' });
    chat('trashed-chat', 'ws-a', { tree: 't-2', deletedGroup: 'trash-1' });
    chat('in-archived-workspace', 'ws-b');
    chat('busy', 'ws-a', { tree: 't-1' });
    chat('background', 'ws-a', { tree: 't-1' });
    chat('live', 'ws-a', { tree: 't-2' });
    retire();
    kept.add('background');
    t.mock.method(chatHub, 'isBusy', (id: string) => id === 'busy');
    const released = await new ChatManager(undefined, tmpDir).releaseRetiredSessions(frame([
      { entity: 'tree', op: 'archived', workspaceId: 'ws-a', treeId: 't-1' },
      { entity: 'node', op: 'archived', workspaceId: 'ws-a', nodeId: 'archived-chat', treeId: 't-2' },
      { entity: 'node', op: 'deleted', workspaceId: 'ws-a', nodeId: 'trashed-chat', treeId: 't-2' },
      { entity: 'workspace', op: 'archived', workspaceId: 'ws-b' },
    ]));
    assert.equal(released, 4);
    assert.deepEqual(releases.sort(), ['archived-chat', 'in-archived-thread', 'in-archived-workspace', 'trashed-chat']);
    for (const id of releases) assert.equal(peekLiveSession(id), undefined, id);
    for (const id of ['busy', 'background', 'live']) assert.ok(peekLiveSession(id), id);
  });

  test('unarchiving releases nothing; a chat restored while the release waited for its lock keeps its session', async () => {
    chat('in-thread', 'ws-a', { tree: 't-1' });
    const manager = new ChatManager(undefined, tmpDir);
    assert.equal(await manager.releaseRetiredSessions(frame([{ entity: 'tree', op: 'unarchived', workspaceId: 'ws-a', treeId: 't-1' }])), 0);

    retire();
    const unlock = await acquireSessionRestoreLock('in-thread');
    const pass = manager.releaseRetiredSessions(frame([{ entity: 'tree', op: 'archived', workspaceId: 'ws-a', treeId: 't-1' }]));
    getDb().prepare('UPDATE trees SET archived_at = NULL WHERE id = ?').run('t-1');
    unlock();
    assert.equal(await pass, 0);
    assert.deepEqual(releases, []);
    assert.ok(peekLiveSession('in-thread'));
  });

  test('a resync frame checks every live chat; sessions with no chat row and runtimes without idle release keep theirs', async () => {
    chat('in-thread', 'ws-a', { tree: 't-1' });
    liveSession('no-row');
    retire();
    assert.equal(await new ChatManager(undefined, tmpDir).releaseRetiredSessions(frame([], true)), 1);
    assert.deepEqual(releases, ['in-thread']);
    assert.ok(peekLiveSession('no-row'));

    registerRuntime(fakeRuntime(false));
    chat('other', 'ws-b');
    assert.equal(await new ChatManager(undefined, tmpDir).releaseRetiredSessions(frame([{ entity: 'workspace', op: 'archived', workspaceId: 'ws-b' }])), 0);
    assert.ok(peekLiveSession('other'));
  });

  test('the open reply wakes of an archived or trashed sender settle; a begun reply and a live sender\'s wake stay', () => {
    chat('archived-sender', 'ws-a', { tree: 't-1' });
    chat('trashed-sender', 'ws-a', { tree: 't-2', deletedGroup: 'trash-1' });
    chat('live-sender', 'ws-a', { tree: 't-2' });
    chat('begun-sender', 'ws-a', { tree: 't-1' });
    retire();
    const wake = (targetTurnId: string, callerNodeId: string) => createThreadWake({
      targetTurnId, requestedTurnId: `reply-${targetTurnId}`, ownerUserId: null, workspaceId: 'ws-a',
      callerNodeId, callerTurnId: null, targetNodeId: 'root-1', hop: 1,
    });
    wake('turn-a', 'archived-sender');
    wake('turn-b', 'trashed-sender');
    wake('turn-c', 'live-sender');
    wake('turn-d', 'begun-sender');
    getDb().prepare(`INSERT INTO turns (turn_id, node_id, assistant_message_id, status, started_at, updated_at) VALUES ('reply-turn-d', 'begun-sender', 'a-d', 'active', 1, 1)`).run();

    settleRetiredSenderWakes(frame([{ entity: 'tree', op: 'unarchived', workspaceId: 'ws-a', treeId: 't-1' }]));
    assert.equal(getThreadWake('turn-a')!.state, 'pending', 'a frame that retires nothing settles nothing');

    settleRetiredSenderWakes(frame([{ entity: 'tree', op: 'archived', workspaceId: 'ws-a', treeId: 't-1' }]));
    assert.deepEqual([getThreadWake('turn-a')!.state, getThreadWake('turn-a')!.detail], ['undeliverable', 'sender_archived']);
    assert.deepEqual([getThreadWake('turn-b')!.state, getThreadWake('turn-b')!.detail], ['undeliverable', 'sender_trashed']);
    assert.equal(getThreadWake('turn-c')!.state, 'pending');
    assert.equal(getThreadWake('turn-d')!.state, 'pending', 'its delivery settles it delivered');
  });
});
