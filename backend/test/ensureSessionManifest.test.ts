// Must precede application imports: config and credential paths are captured at load time.
import { isolatedIntegrationDataDir, resetIntegrationConfig } from './isolatedIntegrationEnvironment';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
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
import { log } from '../src/services/logger';
import { saveContext } from '../src/services/dbRepository';
import { AgentDefinitionService } from '../src/services/agentDefinitionService';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

// The first turn's artifact manifest on ensure-session and on the legacy
// POST /chats: an over-long contextManifest is clamped (it was a 400 that
// stopped every message of a workspace with more than 50 artifacts), and
// artifactCount reaches the new session as sent, except for a session that
// cannot list or search artifacts (a primary Agent), which gets the list.

const originalEnv = { ...process.env };
let directory: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;
let fresh: NewAgentSessionOptions[];

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(isolatedIntegrationDataDir, 'ensure-manifest-'));
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
  getDb().prepare('INSERT INTO workspaces (id,name,cwd,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Manifest Test', directory);
  getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,created_at) VALUES ('node','ws','chat','idle',1)").run();
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

function post(endpoint: string, body: unknown) {
  return fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const manifest = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `a-${i}`, filePath: `.contexts/a-${i}.md` }));

function ensure(extra: Record<string, unknown>) {
  return post('/nodes/node/ensure-session', { workspaceId: 'ws', cwd: directory, priorMessages: [], ...extra });
}

test('ensure-session clamps a contextManifest of more than 50 items to the first 50', async (t: TestContext) => {
  const warn = t.mock.method(log, 'warn', () => {});
  const response = await ensure({ contextManifest: manifest(51) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].contextManifest?.length, 50);
  assert.equal(fresh[0].contextManifest?.[0].name, 'a-0');
  assert.equal(fresh[0].contextManifest?.[49].name, 'a-49');
  assert.ok(warn.mock.calls.some((call) => call.arguments[1] === 'contextManifest clamped'
    && JSON.stringify(call.arguments[2]) === JSON.stringify({ route: 'ensure-session', received: 51, kept: 50 })));
});

test('ensure-session passes artifactCount to the new session only when sent', async () => {
  assert.equal((await ensure({ contextManifest: manifest(2), artifactCount: 120 })).status, 200);
  assert.equal(fresh[0].artifactCount, 120);
  clearAllSessions();
  getDb().prepare("UPDATE nodes SET acp_session_id = NULL, external_session_id = NULL WHERE id = 'node'").run();
  assert.equal((await ensure({ contextManifest: manifest(2) })).status, 200);
  assert.equal(fresh.length, 2);
  assert.equal('artifactCount' in fresh[1], false);
});

test('ensure-session refuses an invalid artifactCount and still checks each kept manifest item', async () => {
  for (const artifactCount of [-1, 1.5, '3', true]) {
    const response = await ensure({ artifactCount });
    assert.equal(response.status, 400, String(artifactCount));
    assert.deepEqual(await response.json(), { error: 'artifactCount must be a non-negative integer' });
  }
  const traversal = await ensure({ contextManifest: [{ name: 'x', filePath: '../etc/passwd' }] });
  assert.equal(traversal.status, 400);
  assert.deepEqual(await traversal.json(), { error: 'contextManifest filePath must not contain ..' });
  const notArray = await ensure({ contextManifest: 'all' });
  assert.equal(notArray.status, 400);
  assert.deepEqual(await notArray.json(), { error: 'contextManifest must be an array' });
  // A bad item past the first 50 is dropped with the rest, not refused.
  const tail = await ensure({ contextManifest: [...manifest(50), { name: 'x', filePath: '../etc/passwd' }] });
  assert.equal(tail.status, 200, await tail.clone().text());
  assert.equal(fresh.at(-1)?.contextManifest?.length, 50);
  assert.equal(fresh.length, 1);
});

test('the legacy POST /chats also clamps instead of refusing', async (t: TestContext) => {
  t.mock.method(log, 'warn', () => {});
  const response = await post('/chats', { workspaceId: 'ws', cwd: directory, nodeId: 'node', contextManifest: manifest(60) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(fresh[0].contextManifest?.length, 50);
});

// ── A primary Agent: its allow-list has no list_artifacts / search_artifacts ──

function storeArtifact(id: string, name: string, updatedAt: number, extra: Record<string, unknown> = {}): void {
  saveContext({
    id, workspace_id: 'ws', name, file_path: `.contexts/${name}.md`, size: 1, auto_inject: 0, source: 'agent',
    type: 'doc', url: null, origin_node_id: null, origin_message_id: null, kind: 'embedded', pinned_at: null,
    created_at: 1, updated_at: updatedAt, rev: null, ...extra,
  } as Parameters<typeof saveContext>[0]);
}

async function primaryAgentDefinition(): Promise<string> {
  const service = new AgentDefinitionService();
  const draft = await service.create(LOCAL_AGENT_OWNER_ID, {
    version: 1, scope: 'workspace', workspaceId: 'ws',
    name: 'Reviewer', description: 'Reviews changes.', instructions: 'Review the change.',
    runtimeProfile: { version: 1, runtimeId: 'codex', providerId: null, modelId: 'test-model', reasoning: null, modeId: null },
    fallbackChain: [], toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy: null,
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 },
    defaultRunTtlMs: null,
  } as never, 'reviewer');
  const enabled = await service.enable(LOCAL_AGENT_OWNER_ID, draft.id, 'enable-reviewer');
  return enabled!.id;
}

test("a primary Agent gets the workspace's artifact list instead of a count and lookup tools it lacks", async () => {
  storeArtifact('c-old', 'old', 10);
  storeArtifact('c-new', 'new', 30);
  storeArtifact('c-pin-a', 'pin-a', 5, { pinned_at: 100 });
  storeArtifact('c-pin-b', 'pin-b', 5, { pinned_at: 200 });
  storeArtifact('c-link', 'site', 20, { file_path: '', type: 'link', url: 'https://example.com', kind: null });
  const agentDefinitionId = await primaryAgentDefinition();
  // The client sends the pinned ones, one the database has not received yet, and the total.
  const sent = [{ name: 'pin-b', filePath: '.contexts/pin-b.md' }, { name: 'fresh-pin', filePath: '.contexts/fresh-pin.md' }];
  const response = await ensure({ agentDefinitionId, contextManifest: sent, artifactCount: 6 });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(fresh.length, 1);
  assert.ok(fresh[0].toolProfile?.allowedToolNames, 'a primary Agent session has an allow-list');
  assert.equal('artifactCount' in fresh[0], false);
  assert.deepEqual(fresh[0].contextManifest, [
    ...sent,
    { name: 'pin-a', filePath: '.contexts/pin-a.md', kind: 'embedded' },
    { name: 'new', filePath: '.contexts/new.md', kind: 'embedded' },
    { name: 'site', filePath: '', url: 'https://example.com' },
    { name: 'old', filePath: '.contexts/old.md', kind: 'embedded' },
  ]);
});

test("a primary Agent's list is clamped to 50, and an ordinary chat still gets the count", async () => {
  for (let i = 0; i < 60; i++) storeArtifact(`c-${i}`, `a-${i}`, 1000 + i);
  const agentDefinitionId = await primaryAgentDefinition();
  assert.equal((await ensure({ agentDefinitionId, artifactCount: 60 })).status, 200);
  assert.equal(fresh[0].contextManifest?.length, 50);
  assert.equal(fresh[0].contextManifest?.[0].name, 'a-59');
  assert.equal('artifactCount' in fresh[0], false);

  getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,created_at) VALUES ('plain','ws','chat','idle',1)").run();
  const plain = await post('/nodes/plain/ensure-session', { workspaceId: 'ws', cwd: directory, priorMessages: [], artifactCount: 60 });
  assert.equal(plain.status, 200, await plain.clone().text());
  assert.equal(fresh[1].artifactCount, 60);
  assert.equal(fresh[1].contextManifest, undefined);
});
