// Must precede application imports: config and credential paths are captured at load time.
import { isolatedIntegrationDataDir, resetIntegrationConfig } from './isolatedIntegrationEnvironment';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupMichiRoutes } from '../src/routes/michi';
import { ChatManager } from '../src/services/chatManager';
import { closeDb, getDb, initDb } from '../src/services/db';
import { loadAgentConfig, updateAgentConfig } from '../src/services/agentConfig';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, dropSession } from '../src/agents/sessionRegistry';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { setMemorySettings } from '../src/services/memory/memoryService';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

// ensure-session's `temporary`: a chat becomes a temporary chat (memory_mode
// 'off') only while no turn has started in it, also when the window's sync
// stored its first message first; every later send carries the flag and
// changes nothing. Its Crew sessions are Off whatever was asked.

const originalEnv = { ...process.env };
let directory: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;
let fresh: NewAgentSessionOptions[];

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(isolatedIntegrationDataDir, 'ensure-temporary-'));
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  resetIntegrationConfig();
  closeDb(); initDb(); clearAllSessions(); loadAgentConfig();
  fresh = [];
  const runtime: AgentRuntime = {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id: 'codex', label: 'Codex', capabilities: { modes: false, permissions: false, models: false,
      providerModels: false, reasoning: false, supportedReasoningLevels: [], apiKeys: false,
      warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false },
    async warm() {}, async shutdown() {}, async releaseSession(id) { dropSession(id); },
    async newSession(opts) {
      fresh.push(opts);
      const session: AgentSession = {
        id: opts.sessionId!, nativeSessionId: `native-${fresh.length}`, runtimeId: 'codex', currentModelId: 'test-model',
        getHistory: () => [], getPendingAssistant: () => undefined,
        async *send() { yield { kind: 'turn_end', stopReason: 'end_turn' }; }, async cancel() {},
      };
      return session;
    },
  };
  registerRuntime(runtime);
  updateAgentConfig({ runtime: 'codex', modelByRuntime: { codex: 'test-model' } });
  getDb().prepare('INSERT INTO workspaces (id,name,cwd,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Temporary Test', directory);
  for (const id of ['new', 'begun']) {
    getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,created_at) VALUES (?,'ws','chat','idle',1)").run(id);
  }
  say('begun', 'm-1');
  turn('begun', 't-begun');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', setupMichiRoutes(new ChatManager(undefined, directory)));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearAllSessions(); closeDb(); process.env = { ...originalEnv };
  fs.rmSync(directory, { recursive: true, force: true });
});

function ensure(nodeId: string, extra: Record<string, unknown>) {
  return fetch(`${base}/nodes/${nodeId}/ensure-session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'ws', cwd: directory, priorMessages: [], ...extra }),
  });
}

const memoryMode = (nodeId: string) =>
  (getDb().prepare('SELECT memory_mode FROM nodes WHERE id = ?').get(nodeId) as { memory_mode: string | null }).memory_mode;

/** A user message row, as the window's workspace sync stores it. */
function say(nodeId: string, id: string): void {
  getDb().prepare("INSERT INTO messages (id,node_id,role,content,seq,created_at) VALUES (?,?,'user','hello',1,1)").run(id, nodeId);
}

function turn(nodeId: string, turnId: string): void {
  getDb().prepare(`INSERT INTO turns (turn_id,node_id,user_message_id,assistant_message_id,status,last_seq,started_at,updated_at)
    VALUES (?,?,NULL,?,'completed',0,1,1)`).run(turnId, nodeId, `a-${turnId}`);
}

test('temporary: true makes a chat with no turn yet a temporary chat; later sends change nothing', async () => {
  const first = await ensure('new', { temporary: true });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(memoryMode('new'), 'off');
  say('new', 'm-new');
  turn('new', 't-new');
  assert.equal((await ensure('new', {})).status, 200);
  assert.equal(memoryMode('new'), 'off', 'a send without the flag does not end it');
  assert.equal((await ensure('begun', { temporary: true })).status, 200);
  assert.equal(memoryMode('begun'), null, 'a chat with a turn keeps its setting');
});

test('a first message the window synced before ensure-session does not keep the chat from becoming temporary', async () => {
  say('new', 'm-synced');
  assert.equal((await ensure('new', { temporary: true })).status, 200);
  assert.equal(memoryMode('new'), 'off');
});

test('a turn alone counts as begun, and temporary: false changes nothing', async () => {
  turn('new', 't-1');
  assert.equal((await ensure('new', { temporary: true })).status, 200);
  assert.equal(memoryMode('new'), null);
  getDb().prepare("DELETE FROM turns WHERE turn_id = 't-1'").run();
  assert.equal((await ensure('new', { temporary: false })).status, 200);
  assert.equal(memoryMode('new'), null);
});

test('it works with memory turned off', async () => {
  setMemorySettings(LOCAL_AGENT_OWNER_ID, { mode: 'off' });
  assert.equal((await ensure('new', { temporary: true })).status, 200);
  assert.equal(memoryMode('new'), 'off');
});

test('temporary must be a boolean; nothing is written for a refused request', async () => {
  for (const temporary of ['yes', 1, null]) {
    const response = await ensure('new', { temporary });
    assert.equal(response.status, 400, String(temporary));
    assert.deepEqual(await response.json(), { error: 'temporary must be a boolean' });
  }
  assert.equal(memoryMode('new'), null);
  assert.equal(fresh.length, 0);
});

test('a temporary chat\'s new session is Crew Off whatever the client asked for', async () => {
  assert.equal((await ensure('new', { temporary: true, crewMemoryMode: 'persistent' })).status, 200);
  assert.equal(fresh[0].crewMemoryMode, 'temporary');
  assert.equal((await ensure('begun', { crewMemoryMode: 'persistent' })).status, 200);
  assert.equal(fresh[1].crewMemoryMode, 'persistent', 'any other chat keeps the mode it asked for');
});
