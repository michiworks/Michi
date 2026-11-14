// Isolate configuration before importing runtime modules; only the runtimes are faked.
import { isolatedIntegrationDataDir, resetIntegrationConfig } from './isolatedIntegrationEnvironment';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';
import { registerRuntime } from '../src/agents/registry';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import { clearAllSessions, dropSession, peekLiveSession } from '../src/agents/sessionRegistry';
import type { AgentRuntime, AgentSession, ModelInfo, NewAgentSessionOptions } from '../src/agents/types';
import { setupMichiRoutes } from '../src/routes/michi';
import { ChatManager } from '../src/services/chatManager';
import { loadAgentConfig, updateAgentConfig } from '../src/services/agentConfig';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode, updateNodeResumeBinding } from '../src/services/dbRepository';
import { acquireSessionRestoreLock } from '../src/services/nativeResume';
import { createSpawnChild, type SpawnChildArgs, type SpawnChildDeps } from '../src/services/spawnChild';
import { chatHub, type StartRequestedSelfTurnArgs } from '../src/agents/chatHub';
import { isRegisteredLiveSession } from '../src/agents/requestedTurnStart';
import { log } from '../src/services/logger';

let directory: string;
let opened: Array<{ kind: 'new' | 'fork'; opts: NewAgentSessionOptions }>;
let released: string[];
let started: StartRequestedSelfTurnArgs[];

function fakeRuntime(id: string, overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  const session = (opts: NewAgentSessionOptions, nativeSessionId: string): AgentSession => ({
    id: opts.sessionId!, nativeSessionId, runtimeId: id, currentModelId: opts.model ?? null, parentChatId: opts.parentChatId,
    getHistory: () => [], getPendingAssistant: () => undefined, async cancel() {},
    async *send() { yield { kind: 'turn_end', stopReason: 'end_turn' }; },
  });
  return {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id, label: id, capabilities: {
      modes: false, permissions: false, models: false, providerModels: false, reasoning: false,
      supportedReasoningLevels: [], apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: true, nativeResume: true,
    },
    async warm() {}, async shutdown() {},
    async releaseSession(sessionId) { released.push(sessionId); dropSession(sessionId); },
    async newSession(opts) { opened.push({ kind: 'new', opts }); return session(opts, `native-${opts.sessionId}`); },
    async forkSession(opts) { opened.push({ kind: 'fork', opts }); return session(opts, `fork-${opts.sessionId}`); },
    ...overrides,
  } as AgentRuntime;
}

/** Records each first turn; `onStart` runs as it registers. */
function turnDeps(onStart?: (args: StartRequestedSelfTurnArgs) => void): SpawnChildDeps {
  return {
    async startTurn(args) {
      started.push(args);
      onStart?.(args);
      return { turnId: args.turnId, assistantId: `self-${args.nodeId}-${args.turnId}`, done: Promise.resolve(), existing: false };
    },
    newTurnId: () => 'turn-1',
  };
}

function spawnArgs(extra: Partial<SpawnChildArgs> = {}): SpawnChildArgs {
  return { parentChatId: 'parent', cwd: directory, enableFollowUps: true, title: 'Look into it', prompt: 'Find the cause', ...extra };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(isolatedIntegrationDataDir, 'spawn-child-'));
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  resetIntegrationConfig();
  closeDb(); initDb(); clearAllSessions(); loadAgentConfig();
  opened = []; released = []; started = [];
  updateAgentConfig({ runtime: 'codex', modelByRuntime: { codex: 'test-model' } });
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, cwd, created_at, updated_at) VALUES ('ws', 'W', ?, 1, 1)").run(directory);
  db.prepare("INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES ('tree', 'ws', 'parent', 1, 1)").run();
  db.prepare("INSERT INTO nodes (id, workspace_id, tree_id, kind, title, status, created_at) VALUES ('parent', 'ws', 'tree', 'chat', 'Parent', 'idle', 1)").run();
  updateNodeResumeBinding('parent', { runtime_id: 'codex', acp_session_id: 'native-parent', model_id: 'test-model' });
  db.prepare("INSERT INTO messages (id, node_id, role, content, seq, created_at) VALUES ('answer', 'parent', 'assistant', 'Parent answer', 1, 1)").run();
});

afterEach(() => {
  clearAllSessions();
  closeDb();
  delete process.env.MICHI_CLOUD;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a spawned child is a chat under its parent, forked natively, bound, and its first turn started by the backend', async () => {
  const runtime = fakeRuntime('codex');
  registerRuntime(runtime);
  const child = await createSpawnChild(runtime, spawnArgs(), turnDeps());
  assert.equal(child.chatId, child.nodeId);
  assert.deepEqual(opened.map((call) => call.kind), ['fork']);
  assert.deepEqual([opened[0].opts.parentChatId, opened[0].opts.cwd, opened[0].opts.enableFollowUps], ['parent', directory, true]);
  const node = getNode(child.nodeId)!;
  assert.deepEqual([node.parent_node_id, node.tree_id, node.kind, node.title, node.spawned_by_agent, node.runtime_id, node.acp_session_id, node.model_id],
    ['parent', 'tree', 'chat', 'Look into it', 1, 'codex', `fork-${child.nodeId}`, 'test-model']);
  assert.equal(node.composer_draft ?? null, null, 'no outbox for a window to send');
  const edge = getDb().prepare('SELECT id, kind, source_node_id FROM edges WHERE target_node_id = ?').get(child.nodeId) as Record<string, unknown>;
  assert.deepEqual({ ...edge }, { id: `branch-parent-${child.nodeId}`, kind: 'branch', source_node_id: 'parent' });
  const session = peekLiveSession(child.nodeId);
  assert.ok(session, 'the session is registered');
  assert.equal(started.length, 1);
  assert.deepEqual({ ...started[0], session: started[0].session === session },
    { chatId: child.nodeId, nodeId: child.nodeId, ownerUserId: null, turnId: 'turn-1', text: 'Find the cause', displayText: 'Find the cause', session: true });
  const release = await acquireSessionRestoreLock(child.nodeId);
  release();
});

test('a child copies the parent\'s own permission setting', async () => {
  const runtime = fakeRuntime('codex');
  registerRuntime(runtime);
  const cases: Array<[string | null, number, string, number]> = [
    ['yolo', 0, 'yolo', 0],
    ['trust', 0, 'trust', 0],
    ['ask', 1, 'ask', 1],
    [null, 0, 'ask', 0],
  ];
  for (const [mode, approve, childMode, childApprove] of cases) {
    getDb().prepare("UPDATE nodes SET permission_mode = ?, permission_approve_for_me = ? WHERE id = 'parent'").run(mode, approve);
    const child = await createSpawnChild(runtime, spawnArgs(), turnDeps());
    const row = getDb().prepare('SELECT permission_mode, permission_approve_for_me FROM nodes WHERE id = ?').get(child.nodeId) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { permission_mode: childMode, permission_approve_for_me: childApprove }, String(mode));
  }
});

test('the first turn runs once, with the prompt as the child\'s only user message', async () => {
  const runtime = fakeRuntime('codex');
  registerRuntime(runtime);
  let done: Promise<void> | undefined;
  const child = await createSpawnChild(runtime, spawnArgs(), {
    startTurn: async (args) => {
      const turn = await chatHub.startRequestedSelfTurn(args);
      done = turn.done;
      return turn;
    },
    isLiveSession: isRegisteredLiveSession,
  });
  await done;
  const messages = getDb().prepare('SELECT role, content FROM messages WHERE node_id = ? ORDER BY seq').all(child.nodeId)
    .map((row) => ({ ...row }));
  assert.deepEqual(messages.filter((message) => message.role === 'user'), [{ role: 'user', content: 'Find the cause' }]);
  const turns = getDb().prepare('SELECT status FROM turns WHERE node_id = ?').all(child.nodeId).map((row) => ({ ...row }));
  assert.deepEqual(turns, [{ status: 'completed' }]);
});

test('a first turn that cannot begin leaves the child for the user, with its lock released', async (t) => {
  const runtime = fakeRuntime('codex');
  registerRuntime(runtime);
  const warn = t.mock.method(log, 'warn', () => {});
  const child = await createSpawnChild(runtime, spawnArgs(), {
    startTurn: async () => { throw new Error('hub refused'); },
    newTurnId: () => 'turn-2',
  });
  assert.equal(getNode(child.nodeId)?.title, 'Look into it');
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments.slice(0, 3)),
    [['chat', 'spawned child turn failed to begin', { nodeId: child.nodeId, turnId: 'turn-2', error: 'hub refused' }]]);
  const release = await acquireSessionRestoreLock(child.nodeId);
  release();
});

test('a session replaced before the first turn starts is not prompted', async (t) => {
  const runtime = fakeRuntime('codex');
  registerRuntime(runtime);
  t.mock.method(log, 'warn', () => {});
  const child = await createSpawnChild(runtime, spawnArgs(), { ...turnDeps(), isLiveSession: () => false });
  assert.equal(started.length, 0);
  assert.ok(getNode(child.nodeId));
});

test('a child whose session cannot open is removed and the error reaches the caller', async () => {
  const runtime = fakeRuntime('other', { async newSession() { throw new Error('runtime down'); } });
  registerRuntime(runtime);
  await assert.rejects(createSpawnChild(runtime, spawnArgs(), turnDeps()), /runtime down/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM nodes WHERE parent_node_id = 'parent'").get()!.count, 0);
});

test('an unknown parent is refused before anything is created', async () => {
  const runtime = fakeRuntime('codex');
  await assert.rejects(createSpawnChild(runtime, spawnArgs({ parentChatId: 'missing' }), turnDeps()), /spawn parent node not found/);
  assert.equal(opened.length, 0);
});

test('a Kiro child drops a configured reasoning level its model cannot use', async () => {
  const models: ModelInfo[] = [{ id: 'auto', label: 'Auto', isDefault: true, supportsReasoning: false }];
  const runtime = fakeRuntime('kiro', {
    capabilities: { ...fakeRuntime('kiro').capabilities, models: true, reasoning: true, supportedReasoningLevels: ['low', 'medium', 'high'] },
    listModels: async () => models,
    async newSession(opts) {
      opened.push({ kind: 'new', opts });
      // As AcpAgentRuntime.applyReasoning does for a model without an effort option.
      if (opts.reasoning) throw new Error('The selected Kiro model does not expose reasoning effort');
      return { id: opts.sessionId!, nativeSessionId: `native-${opts.sessionId}`, runtimeId: 'kiro', currentModelId: opts.model ?? null,
        getHistory: () => [], getPendingAssistant: () => undefined, async cancel() {}, async *send() {} };
    },
  });
  registerRuntime(runtime);
  updateAgentConfig({ modelByRuntime: { codex: 'test-model', kiro: 'auto' }, reasoningByRuntime: { kiro: 'high' } });
  const child = await createSpawnChild(runtime, spawnArgs(), turnDeps());
  assert.equal(opened.at(-1)?.opts.reasoning ?? null, null);
  assert.deepEqual([getNode(child.nodeId)?.model_id, getNode(child.nodeId)?.reasoning ?? null], ['auto', null]);
});

test('a child on a runtime without provider models stores no provider, so its first send reuses its session', async () => {
  const runtime = fakeRuntime('codex', { async loadSession() { throw new Error('the live session must be reused'); } });
  registerRuntime(runtime);
  const child = await createSpawnChild(runtime, spawnArgs(), turnDeps());
  assert.equal(getNode(child.nodeId)?.provider_id ?? null, null);

  const app = express();
  app.use(express.json());
  app.use('/api', setupMichiRoutes(new ChatManager(undefined, directory)));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/nodes/${child.nodeId}/ensure-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws', cwd: directory, parentChatId: 'parent', priorMessages: [] }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { resumeStrategy: string; chatId: string };
    assert.equal(body.resumeStrategy, 'live');
    assert.deepEqual(opened.map((call) => call.kind), ['fork'], 'the native fork is kept');
    assert.deepEqual(released, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a child\'s restore lock is held while its session opens', async () => {
  let lockFreeDuringOpen: boolean | undefined;
  const runtime = fakeRuntime('other', {
    async newSession(opts) {
      opened.push({ kind: 'new', opts });
      let acquired = false;
      void acquireSessionRestoreLock(opts.sessionId!).then((release) => { acquired = true; release(); });
      await new Promise((resolve) => setImmediate(resolve));
      lockFreeDuringOpen = acquired;
      return { id: opts.sessionId!, nativeSessionId: `native-${opts.sessionId}`, runtimeId: 'other', currentModelId: null,
        getHistory: () => [], getPendingAssistant: () => undefined, async cancel() {}, async *send() {} };
    },
  });
  registerRuntime(runtime);
  const child = await createSpawnChild(runtime, spawnArgs(), turnDeps());
  assert.equal(lockFreeDuringOpen, false);
  const release = await acquireSessionRestoreLock(child.nodeId);
  release();
});

test('a failure after binding keeps its error, survives a failed release and removes the child', async (t) => {
  const runtime = fakeRuntime('other', { async releaseSession() { throw new Error('release failed'); } });
  registerRuntime(runtime);
  t.mock.method(sessionRegistry, 'registerSession', () => { throw new Error('registry full'); });
  await assert.rejects(createSpawnChild(runtime, spawnArgs(), turnDeps()), /registry full/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM nodes WHERE parent_node_id = 'parent'").get()!.count, 0);
});
