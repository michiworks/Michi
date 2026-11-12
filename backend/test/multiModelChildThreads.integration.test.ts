// Isolate configuration before importing runtime modules; only the runtimes are faked.
import { isolatedIntegrationDataDir, resetIntegrationConfig } from './isolatedIntegrationEnvironment';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, dropSession, peekLiveSession } from '../src/agents/sessionRegistry';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import { getAgentConfig, loadAgentConfig, resolveModel, resolveReasoning } from '../src/services/agentConfig';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode, getWorkspace, getWorkspaceInstructions, listMessages, updateNodeResumeBinding } from '../src/services/dbRepository';
import { __resetRuntimeDeps, configureRuntimeDeps } from '../src/agents/runtimeDeps';
import { createChildThread, type CreateChildInput } from '../src/services/multiModel/childThreads';
import { SqliteMultiModelStore } from '../src/services/multiModel/store';
import { acquireSessionRestoreLock } from '../src/services/nativeResume';
import { chatOwner } from './helpers/owners';

const store = new SqliteMultiModelStore();
let directory: string;
let calls: Array<{ kind: 'new' | 'fork'; runtimeId: string; opts: NewAgentSessionOptions & { anchorMessageId?: string } }>;
let failNew: boolean;
const priorCloud = process.env.MICHI_CLOUD;

function fakeRuntime(id: string, fork: boolean): AgentRuntime {
  const session = (opts: NewAgentSessionOptions): AgentSession => ({
    id: opts.sessionId!, nativeSessionId: `native-${opts.sessionId}`, runtimeId: id, currentModelId: opts.model ?? null,
    owner: chatOwner(opts.sessionId!), getHistory: () => [], getPendingAssistant: () => undefined, cancel() {},
    async *send() { yield { kind: 'turn_end', stopReason: 'end_turn' }; },
  } as AgentSession);
  return {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id, label: id, capabilities: {
      modes: false, permissions: false, models: false, providerModels: false, reasoning: false,
      supportedReasoningLevels: [], apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: true, nativeResume: true,
    },
    async warm() {}, async shutdown() {}, async releaseSession(sessionId) { dropSession(sessionId); },
    async newSession(opts) {
      calls.push({ kind: 'new', runtimeId: id, opts });
      if (failNew) throw new Error('runtime down');
      return session(opts);
    },
    ...(fork ? {
      async forkSession(opts: NewAgentSessionOptions & { anchorMessageId?: string }) {
        calls.push({ kind: 'fork', runtimeId: id, opts });
        return session(opts);
      },
    } : {}),
  } as AgentRuntime;
}

function input(extra: Partial<CreateChildInput>): CreateChildInput {
  return {
    ownerUserId: 'local-user', callerNodeId: 'caller', runId: 'wfr_run', childNodeId: 'n-child',
    permissionMode: 'trust', approveForMe: false,
    choice: { runtimeId: 'codex', providerId: null, modelId: 'm1', reasoning: null, runtimeLabel: 'Codex', modelLabel: 'M1' },
    context: 'fork', askMessageId: 'm-ask', title: 'Codex · M1', ...extra,
  };
}

describe('createChildThread', () => {
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(isolatedIntegrationDataDir, 'mm-child-'));
    process.env.MICHI_DATA_DIR = directory;
    delete process.env.MICHI_CLOUD;
    resetIntegrationConfig();
    closeDb(); initDb(); clearAllSessions(); loadAgentConfig();
    calls = [];
    failNew = false;
    registerRuntime(fakeRuntime('codex', true));
    registerRuntime(fakeRuntime('other', false));
    const db = getDb();
    db.prepare("INSERT INTO workspaces (id, name, cwd, created_at, updated_at) VALUES ('ws', 'W', ?, 1, 1)").run(directory);
    db.prepare("INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES ('tree', 'ws', 'caller', 1, 1)").run();
    db.prepare("INSERT INTO nodes (id, workspace_id, tree_id, kind, title, status, created_at) VALUES ('caller', 'ws', 'tree', 'chat', 'Caller', 'idle', 1)").run();
    updateNodeResumeBinding('caller', { runtime_id: 'codex', acp_session_id: 'native-caller', model_id: 'm1' });
    const insert = db.prepare('INSERT INTO messages (id, node_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('m-1', 'caller', 'user', 'Earlier question', 1, 10);
    insert.run('m-2', 'caller', 'assistant', 'Earlier answer', 2, 11);
    insert.run('m-ask', 'caller', 'user', 'Ask other models', 3, 12);
    insert.run('m-later', 'caller', 'assistant', 'I proposed a plan', 4, 13);
  });
  afterEach(() => {
    clearAllSessions();
    closeDb();
    if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
  });

  const deps = () => ({ defaultCwd: directory, store });

  test('a fresh child opens with an empty branch context and no parent', async () => {
    const opened = await createChildThread(input({ context: 'fresh', choice: { ...input({}).choice, runtimeId: 'other' } }), deps());
    opened.release();
    assert.equal(opened.forkKind, 'fresh');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'new');
    assert.deepEqual(calls[0].opts.branchContext, { parentNodeId: 'caller', kind: 'exact', messages: [] });
    assert.equal(calls[0].opts.parentChatId, undefined);
    const node = getNode('n-child')!;
    assert.deepEqual([node.fresh_context, node.multi_model_run_id, node.parent_node_id, node.tree_id], [1, 'wfr_run', 'caller', 'tree']);
    const edge = getDb().prepare('SELECT fork_kind, fork_boundary_message_id FROM edges WHERE target_node_id = ?').get('n-child') as Record<string, unknown>;
    assert.deepEqual({ ...edge }, { fork_kind: null, fork_boundary_message_id: null });
  });

  test('a fork child of an idle caller on the same runtime forks natively at the ask', async () => {
    const opened = await createChildThread(input({}), deps());
    opened.release();
    assert.equal(opened.forkKind, 'native');
    assert.deepEqual(calls.map((call) => call.kind), ['fork']);
    assert.equal(calls[0].opts.anchorMessageId, 'm-ask');
    const node = getNode('n-child')!;
    assert.deepEqual([node.runtime_id, node.model_id, node.acp_session_id, node.permission_mode, node.composer_draft, node.fresh_context, node.spawned_by_agent],
      ['codex', 'm1', 'native-n-child', 'trust', null, 0, 1]);
    const edge = getDb().prepare('SELECT fork_kind, fork_boundary_message_id, anchor_message_id FROM edges WHERE target_node_id = ?').get('n-child') as Record<string, unknown>;
    assert.deepEqual({ ...edge }, { fork_kind: 'native', fork_boundary_message_id: 'm-ask', anchor_message_id: null });
    assert.ok(peekLiveSession('n-child'), 'the session is registered');
  });

  test('a fork child on another runtime gets the caller up to the ask as text', async () => {
    const opened = await createChildThread(input({ choice: { ...input({}).choice, runtimeId: 'other' } }), deps());
    opened.release();
    assert.equal(opened.forkKind, 'text');
    assert.equal(calls[0].kind, 'new');
    assert.equal(calls[0].opts.parentChatId, 'caller');
    assert.deepEqual(calls[0].opts.branchContext?.messages.map((message) => message.content), ['Earlier question', 'Earlier answer', 'Ask other models']);
    assert.equal(calls[0].opts.branchContext?.boundaryMessageId, 'm-ask');
    const edge = getDb().prepare('SELECT fork_kind FROM edges WHERE target_node_id = ?').get('n-child') as { fork_kind: string };
    assert.equal(edge.fork_kind, 'text');
  });

  test('the branch stores the setting it is given (the caller\'s own), approve-for-me included', async () => {
    const opened = await createChildThread(input({ permissionMode: 'ask', approveForMe: true, context: 'fresh' }), deps());
    opened.release();
    const node = getNode('n-child')!;
    assert.deepEqual([node.permission_mode, node.permission_approve_for_me], ['ask', 1]);
  });

  test('a fork without the ask falls back to fresh', async () => {
    const opened = await createChildThread(input({ askMessageId: null, choice: { ...input({}).choice, runtimeId: 'other' } }), deps());
    opened.release();
    assert.equal(opened.forkKind, 'fresh');
    assert.equal(getNode('n-child')?.fresh_context, 1);
  });

  test('a failed session open rolls the node back and releases the lock', async () => {
    failNew = true;
    await assert.rejects(createChildThread(input({ context: 'fresh' }), deps()), /runtime down/);
    assert.equal(getNode('n-child'), null);
    const release = await acquireSessionRestoreLock('n-child');
    release();
  });

  test('in cloud a branch opens in the owner\'s sandbox, whatever folder the workspace row names', async () => {
    process.env.MICHI_CLOUD = '1';
    configureRuntimeDeps({
      historyStore: { getNode, listMessages, getWorkspace, getWorkspaceInstructions },
      dataDir: directory,
      agentConfig: { getAgentConfig, resolveModel, resolveReasoning },
    });
    try {
      for (const [childNodeId, cwd] of [['n-null', null], ['n-client', '/etc']] as const) {
        getDb().prepare("UPDATE workspaces SET cwd = ?, owner_user_id = 'alice' WHERE id = 'ws'").run(cwd);
        const opened = await createChildThread(input({ ownerUserId: 'alice', childNodeId, choice: { ...input({}).choice, runtimeId: 'other' } }), deps());
        opened.release();
      }
    } finally {
      __resetRuntimeDeps();
    }
    const expected = path.join(directory, 'user-cwds', 'alice', 'ws-ws');
    assert.deepEqual(calls.map((call) => call.opts.cwd), [expected, expected]);
  });

  test('an unavailable caller is refused before anything is created', async () => {
    getDb().prepare("UPDATE workspaces SET archived_at = 5 WHERE id = 'ws'").run();
    await assert.rejects(createChildThread(input({}), deps()), /removed/);
    assert.equal(getNode('n-child'), null);
    assert.equal(calls.length, 0);
  });
});
