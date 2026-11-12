// Must precede application imports: config and credential paths are captured at load time.
import { isolatedIntegrationDataDir, resetIntegrationConfig } from './isolatedIntegrationEnvironment';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, dropSession, registerSession } from '../src/agents/sessionRegistry';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import { setupMichiRoutes } from '../src/routes/michi';
import { loadAgentConfig, updateAgentConfig } from '../src/services/agentConfig';
import { ChatManager } from '../src/services/chatManager';
import { closeDb, getDb, initDb } from '../src/services/db';

const originalEnv = { ...process.env };
let directory: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;
let opened: NewAgentSessionOptions[];
let manager: ChatManager;

function session(id: string, runtimeId: string): AgentSession {
  return { id, runtimeId, getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() { yield { kind: 'turn_end', stopReason: 'end_turn' }; }, async cancel() {} };
}

/** A runtime without native resume that records every session it opens; `messages` replays history as messages, like Pi. */
function runtimeNamed(id: string, historyReplay: 'preamble' | 'messages'): AgentRuntime {
  return {
    descriptor: { ...UNKNOWN_RUNTIME_DESCRIPTOR, topology: { ...UNKNOWN_RUNTIME_DESCRIPTOR.topology, historyReplay } },
    id, label: id, capabilities: { modes: false, permissions: false, models: false,
      providerModels: false, reasoning: false, supportedReasoningLevels: [], apiKeys: false,
      warmSessions: false, saveContext: false, spawnBranches: true, nativeResume: false },
    async warm() {}, async shutdown() {}, async releaseSession(sessionId) { dropSession(sessionId); },
    async newSession(opts) { opened.push(opts); return session(opts.sessionId!, id); },
  };
}

function insertMessage(id: string, nodeId: string, role: string, content: string, seq: number): void {
  getDb().prepare('INSERT INTO messages (id, node_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, nodeId, role, content, seq, seq);
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(isolatedIntegrationDataDir, 'session-restore-'));
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  resetIntegrationConfig();
  closeDb(); initDb(); clearAllSessions(); loadAgentConfig();
  opened = [];
  registerRuntime(runtimeNamed('codex', 'preamble'));
  registerRuntime(runtimeNamed('replayer', 'messages'));
  updateAgentConfig({ runtime: 'codex' });
  getDb().prepare("INSERT INTO workspaces (id, name, cwd, created_at, updated_at) VALUES ('ws', 'W', ?, 1, 1)").run(directory);
  getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, title, created_at) VALUES ('parent', 'ws', 'chat', 'idle', 'Caller', 1)").run();
  getDb().prepare("INSERT INTO nodes (id, workspace_id, parent_node_id, kind, status, created_at) VALUES ('child', 'ws', 'parent', 'chat', 'idle', 5)").run();
  getDb().prepare(`INSERT INTO edges (id, workspace_id, source_node_id, target_node_id, kind, created_at)
    VALUES ('branch-parent-child', 'ws', 'parent', 'child', 'branch', 5)`).run();
  insertMessage('p-question', 'parent', 'user', 'Parent question', 1);
  insertMessage('p-answer', 'parent', 'assistant', 'Parent answer', 2);
  insertMessage('c-own', 'child', 'user', 'Child question', 10);
  insertMessage('c-reply', 'child', 'assistant', 'Child answer', 11);
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

async function ensure(runtimeId: string): Promise<NewAgentSessionOptions> {
  const response = await fetch(`${base}/nodes/child/ensure-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'ws', cwd: directory, parentChatId: 'parent', runtimeId,
      priorMessages: [{ role: 'user', content: 'Child question' }, { role: 'assistant', content: 'Child answer' }] }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return opened.at(-1)!;
}

async function restore(runtimeId: string): Promise<NewAgentSessionOptions> {
  getDb().prepare('UPDATE nodes SET runtime_id = ? WHERE id = ?').run(runtimeId, 'child');
  assert.ok(await manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'child' }));
  return opened.at(-1)!;
}

function inheritsParent(opts: NewAgentSessionOptions): boolean {
  return (opts.mergeContexts ?? []).some((context) => context.includes('Parent question'));
}

for (const [runtimeId, replay] of [['codex', 'preamble'], ['replayer', 'messages']] as const) {
  test(`a branch the backend rebuilds on a ${replay} runtime inherits its parent as when the user opens it`, async () => {
    const restored = await restore(runtimeId);
    dropSession('child');
    const ensured = await ensure(runtimeId);
    for (const opts of [restored, ensured]) {
      assert.equal(opts.parentChatId, 'parent');
      assert.ok(inheritsParent(opts), 'the parent has no live session, so its stored transcript is a merge context');
      const ownAsText = (opts.mergeContexts ?? []).some((context) => context.includes('Child question'));
      if (replay === 'messages') {
        assert.deepEqual(opts.replayHistory?.map((message) => message.content), ['Child question', 'Child answer']);
        assert.equal(ownAsText, false);
      } else {
        assert.equal(opts.replayHistory, undefined);
        assert.equal(ownAsText, true);
      }
    }
  });
}

test('a branch whose parent has a live session takes its history from that session, not the stored transcript', async () => {
  registerSession(session('parent', 'codex'));
  const restored = await restore('codex');
  assert.equal(restored.parentChatId, 'parent');
  assert.equal(inheritsParent(restored), false);
});

test('a fresh branch rebuilt by the backend inherits nothing from its parent', async () => {
  getDb().prepare("UPDATE nodes SET multi_model_run_id = 'wfr_run', fresh_context = 1 WHERE id = 'child'").run();
  const restored = await restore('codex');
  assert.equal(restored.parentChatId, undefined);
  assert.equal(inheritsParent(restored), false);
});
