// Must precede application imports: config and credential paths are captured at load time.
import { isolatedIntegrationDataDir, resetIntegrationConfig } from './isolatedIntegrationEnvironment';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, dropSession } from '../src/agents/sessionRegistry';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import { setupMichiRoutes } from '../src/routes/michi';
import { loadAgentConfig, updateAgentConfig } from '../src/services/agentConfig';
import { resolveBranchBoundary } from '../src/services/branchBoundary';
import { ChatManager } from '../src/services/chatManager';
import { closeDb, getDb, initDb } from '../src/services/db';
import { updateNodeResumeBinding } from '../src/services/dbRepository';
import { sessionPlanSnapshot } from '../src/services/planSnapshot';

const originalEnv = { ...process.env };
let directory: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;
let opened: NewAgentSessionOptions[];
let manager: ChatManager;

const PLAN = JSON.stringify({ plan: [{ content: 'Caller step', priority: 'high', status: 'pending' }] });

function insertMessage(id: string, nodeId: string, role: string, content: string, seq: number, metadata: string | null = null): void {
  getDb().prepare('INSERT INTO messages (id, node_id, role, content, seq, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, nodeId, role, content, seq, seq, metadata);
}

/** A branch of `parent` with an edge cut at the parent's question; `marker` makes it a multi-model branch. */
function branch(id: string, marker: 'fresh' | 'fork' | null): void {
  getDb().prepare(`INSERT INTO nodes (id, workspace_id, parent_node_id, kind, status, created_at, multi_model_run_id, fresh_context)
    VALUES (?, 'ws', 'parent', 'chat', 'idle', 5, ?, ?)`).run(id, marker ? 'wfr_run' : null, marker === 'fresh' ? 1 : 0);
  getDb().prepare(`INSERT INTO edges (id, workspace_id, source_node_id, target_node_id, kind, created_at, fork_boundary_message_id)
    VALUES (?, 'ws', 'parent', ?, 'branch', 5, ?)`).run(`branch-parent-${id}`, id, marker === 'fresh' ? null : 'p-question');
}

/** A runtime that records the options of every session it opens. */
function runtimeNamed(id: string): AgentRuntime {
  return {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id, label: id, capabilities: { modes: false, permissions: false, models: false,
      providerModels: false, reasoning: false, supportedReasoningLevels: [], apiKeys: false,
      warmSessions: false, saveContext: false, spawnBranches: true, nativeResume: false },
    async warm() {}, async shutdown() {}, async releaseSession(sessionId) { dropSession(sessionId); },
    async newSession(opts) {
      opened.push(opts);
      return { id: opts.sessionId!, runtimeId: id, getHistory: () => [], getPendingAssistant: () => undefined,
        async *send() { yield { kind: 'turn_end', stopReason: 'end_turn' }; }, async cancel() {} } as AgentSession;
    },
  };
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(isolatedIntegrationDataDir, 'mm-fresh-'));
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  resetIntegrationConfig();
  closeDb(); initDb(); clearAllSessions(); loadAgentConfig();
  opened = [];
  registerRuntime(runtimeNamed('codex'));
  updateAgentConfig({ runtime: 'codex' });
  getDb().prepare("INSERT INTO workspaces (id, name, cwd, created_at, updated_at) VALUES ('ws', 'W', ?, 1, 1)").run(directory);
  getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, title, created_at) VALUES ('parent', 'ws', 'chat', 'idle', 'Caller', 1)").run();
  updateNodeResumeBinding('parent', { runtime_id: 'codex', acp_session_id: 'native-parent' });
  insertMessage('p-question', 'parent', 'user', 'Parent question', 1);
  insertMessage('p-answer', 'parent', 'assistant', 'Parent later answer', 2, PLAN);
  branch('fresh', 'fresh');
  branch('fork', 'fork');
  branch('plain', null);
  for (const id of ['fresh', 'fork', 'plain']) {
    insertMessage(`${id}-own`, id, 'user', `${id} own message`, 10);
    insertMessage(`${id}-reply`, id, 'assistant', `${id} own reply`, 11);
  }
  const app = express();
  app.use(express.json());
  manager = new ChatManager(undefined, directory);
  app.use('/api', setupMichiRoutes(manager));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearAllSessions(); closeDb(); process.env = { ...originalEnv };
  fs.rmSync(directory, { recursive: true, force: true });
});

async function ensure(nodeId: string): Promise<NewAgentSessionOptions> {
  const response = await fetch(`${base}/nodes/${nodeId}/ensure-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'ws', cwd: directory, parentChatId: 'parent',
      priorMessages: [{ role: 'user', content: `${nodeId} own message` }, { role: 'assistant', content: `${nodeId} own reply` }] }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return opened.at(-1)!;
}

describe('fresh multi-model branches and fork cuts', () => {
  test('resolveBranchBoundary of a fresh branch inherits nothing', () => {
    const boundary = resolveBranchBoundary({ childNodeId: 'fresh', parentNodeId: 'parent' });
    assert.deepEqual(boundary, { childNodeId: 'fresh', parentNodeId: 'parent', edgeId: 'branch-parent-fresh', kind: 'exact', atTail: false, messages: [] });
  });

  test('ensure-session rebuilds a fresh branch without its parent, whatever parentChatId says', async () => {
    const opts = await ensure('fresh');
    assert.equal(opts.parentChatId, undefined);
    assert.ok(!(opts.mergeContexts ?? []).some((context) => context.includes('Parent question')));
    assert.ok((opts.mergeContexts ?? []).some((context) => context.includes('fresh own message')));
  });

  test('ensure-session rebuilds a fork branch with its cut, not the parent tail', async () => {
    const opts = await ensure('fork');
    assert.equal(opts.parentChatId, undefined);
    const inherited = (opts.mergeContexts ?? []).find((context) => context.includes('Inherited branch transcript'));
    assert.ok(inherited, 'the boundary prefix is a merge context');
    assert.match(inherited, /Parent question/);
    assert.doesNotMatch(inherited, /Parent later answer/);

    const plain = await ensure('plain');
    assert.equal(plain.parentChatId, 'parent', 'ordinary branches keep the previous behavior');
  });

  test('a runtime switch rebuilds a fresh branch without its parent and a fork branch with its cut', async () => {
    const other: AgentRuntime = {
      ...runtimeNamed('other'),
      async loadSession() { throw new Error('a switched runtime is rebuilt, not loaded'); },
    };
    registerRuntime(other);
    const load = async (nodeId: string): Promise<NewAgentSessionOptions> => {
      updateNodeResumeBinding(nodeId, { runtime_id: 'codex', acp_session_id: `native-${nodeId}` });
      const response = await fetch(`${base}/chats/${nodeId}/load`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId, cwd: directory, workspaceId: 'ws', runtimeId: 'other' }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return opened.at(-1)!;
    };
    const fresh = await load('fresh');
    assert.equal(fresh.parentChatId, undefined);
    assert.equal(fresh.branchContext, undefined);
    assert.ok(!(fresh.mergeContexts ?? []).some((context) => context.includes('Parent question')));
    assert.ok((fresh.mergeContexts ?? []).some((context) => context.includes('fresh own message')));

    const fork = await load('fork');
    assert.equal(fork.parentChatId, undefined);
    assert.deepEqual(fork.branchContext?.messages.map((message) => message.content), ['Parent question']);
    assert.ok((fork.mergeContexts ?? []).some((context) => context.includes('fork own message')));

    const plain = await load('plain');
    assert.equal(plain.parentChatId, 'parent', 'ordinary branches keep the previous behavior');
  });

  test('restoreParentSession prepends the cut for fork branches only', async () => {
    await manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'fork' });
    const fork = opened.at(-1)!;
    assert.match(fork.mergeContexts?.[0] ?? '', /Inherited branch transcript[\s\S]*Parent question/);
    assert.doesNotMatch(fork.mergeContexts?.[0] ?? '', /Parent later answer/);
    await manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'fresh' });
    assert.ok(!(opened.at(-1)!.mergeContexts ?? []).some((context) => context.includes('Parent question')));
    await manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'plain' });
    assert.ok(!(opened.at(-1)!.mergeContexts ?? []).some((context) => context.includes('Inherited branch transcript')));
  });

  test("sessionPlanSnapshot of a fresh branch is its own plan or none, never the caller's", () => {
    getDb().prepare("UPDATE edges SET fork_boundary_message_id = 'p-answer' WHERE id = 'branch-parent-plain'").run();
    assert.equal(sessionPlanSnapshot({ nodeId: 'plain' })?.[0]?.content, 'Caller step', 'an ordinary branch inherits the plan');
    assert.equal(sessionPlanSnapshot({ nodeId: 'fresh' }), null);
    assert.equal(sessionPlanSnapshot({ nodeId: 'fresh', branch: { parentNodeId: 'parent', boundaryMessageId: 'p-answer' } }), null);
    insertMessage('fresh-plan', 'fresh', 'assistant', 'mine', 12, JSON.stringify({ plan: [{ content: 'Own step' }] }));
    assert.equal(sessionPlanSnapshot({ nodeId: 'fresh' })?.[0]?.content, 'Own step');
  });

  test("a fresh branch's descendants inherit nothing from above it, not even the caller's ancestors", () => {
    // The caller is itself a branch of a thread that has a plan; the grandchild is an ordinary branch of the fresh one.
    getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('top', 'ws', 'chat', 'idle', 0)").run();
    insertMessage('top-plan', 'top', 'assistant', 'top', 0, JSON.stringify({ plan: [{ content: 'Top step' }] }));
    getDb().prepare("UPDATE nodes SET parent_node_id = 'top' WHERE id = 'parent'").run();
    getDb().prepare(`INSERT INTO edges (id, workspace_id, source_node_id, target_node_id, kind, created_at, fork_boundary_message_id)
      VALUES ('branch-top-parent', 'ws', 'top', 'parent', 'branch', 1, 'top-plan')`).run();
    getDb().prepare("INSERT INTO nodes (id, workspace_id, parent_node_id, kind, status, created_at) VALUES ('grand', 'ws', 'fresh', 'chat', 'idle', 20)").run();
    getDb().prepare(`INSERT INTO edges (id, workspace_id, source_node_id, target_node_id, kind, created_at, fork_boundary_message_id)
      VALUES ('branch-fresh-grand', 'ws', 'fresh', 'grand', 'branch', 20, 'fresh-reply')`).run();
    assert.equal(sessionPlanSnapshot({ nodeId: 'plain' })?.[0]?.content, 'Top step', 'an ordinary chain walks up to the top');
    assert.equal(sessionPlanSnapshot({ nodeId: 'grand' }), null);
    insertMessage('fresh-plan', 'fresh', 'assistant', 'mine', 11.5, JSON.stringify({ plan: [{ content: 'Fresh step' }] }));
    getDb().prepare("UPDATE edges SET fork_boundary_message_id = 'fresh-plan' WHERE id = 'branch-fresh-grand'").run();
    assert.equal(sessionPlanSnapshot({ nodeId: 'grand' })?.[0]?.content, 'Fresh step', "the fresh branch's own plan is inherited");
  });
});
