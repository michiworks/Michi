import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setupDigestRoutes } from '../src/routes/digests';
import { setupMichiRoutes } from '../src/routes/michi';
import { ChatManager } from '../src/services/chatManager';
import type { AgentSession, LoadAgentSessionOptions, NewAgentSessionOptions } from '../src/agents/types';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import { closeDb, getDb, initDb } from '../src/services/db';
import * as repository from '../src/services/dbRepository';
import * as config from '../src/services/agentConfig';
import * as registry from '../src/agents/registry';
import { __resetRuntimeDeps, configureRuntimeDeps } from '../src/agents/runtimeDeps';

const originalEnv = { ...process.env };
let directory: string;
let server: Server;
let base: string;
let warmed: string[];
let discovered: string[];
let loaded: LoadAgentSessionOptions[];
let created: NewAgentSessionOptions[];
let digestCwds: Array<string | undefined>;
const catalog = { availableModes: [{ id: 'default', name: 'Default' }], defaultModeId: 'default' };

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-workspace-cwd-'));
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb(); clearAllSessions();
  warmed = []; discovered = []; loaded = []; created = []; digestCwds = [];
  const runtime = { id: 'kiro', capabilities: { modes: true, warmSessions: true, nativeResume: false },
    warm: async (cwd: string) => { warmed.push(cwd); },
    async releaseSession() {},
    newSession: async (options: NewAgentSessionOptions): Promise<AgentSession> => {
      created.push(options);
      return { id: options.sessionId!, runtimeId: 'kiro', getHistory: () => [],
        getPendingAssistant: () => undefined, async *send() {}, async cancel() {} };
    },
    loadSession: async (options: LoadAgentSessionOptions): Promise<AgentSession> => {
      loaded.push(options);
      return { id: options.sessionId, runtimeId: 'kiro', getHistory: () => [],
        getPendingAssistant: () => undefined, async *send() {}, async cancel() {} };
    } };
  const agentConfig = config.getAgentConfig();
  mock.method(config, 'getAgentConfig', () => ({ ...agentConfig, runtime: 'kiro' }));
  mock.method(registry, 'getRuntime', () => runtime);
  const manager = { getRuntime: () => runtime, getModeCatalog: async (cwd: string) => {
    discovered.push(cwd); return catalog;
  }, resolvePrimaryAgentBinding: async () => null,
  newChat: async (_parent: unknown, cwd?: string) => { digestCwds.push(cwd); return 'digest-chat'; },
  async *sendMessage() { yield { kind: 'chunk', text: '# Digest' }; yield { kind: 'turn_end' }; },
  } as unknown as ChatManager;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { user: { id: req.header('x-user') ?? 'alice' } }); next(); });
  app.use('/api', setupMichiRoutes(manager));
  app.use('/api', setupDigestRoutes(manager));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  clearAllSessions(); __resetRuntimeDeps(); closeDb();
  mock.restoreAll();
  for (const key of ['MICHI_DATA_DIR', 'MICHI_CLOUD']) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

function saveWorkspace(cwd: string) {
  repository.saveWorkspace({ id: 'ws', name: 'Workspace', cwd, owner_user_id: 'alice', created_at: 1, updated_at: 1 });
}
function postWarm(body: unknown, user = 'alice') {
  return fetch(`${base}/warm`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) });
}

test('missing and non-directory cwd return actionable 400 errors without starting a runtime', async () => {
  const file = path.join(directory, 'file');
  fs.writeFileSync(file, 'not a directory');
  for (const cwd of [path.join(directory, 'deleted-workspace'), file]) {
    saveWorkspace(cwd);
    for (const response of [await postWarm({ cwd }), await fetch(`${base}/workspaces/ws/modes`)]) {
      assert.equal(response.status, 400);
      const body = await response.json() as { code: string; error: string };
      assert.equal(body.code, 'WORKSPACE_CWD_INVALID');
      assert.ok(body.error.includes(cwd));
      assert.match(body.error, /Select an existing folder/);
    }
  }
  for (const cwd of [undefined, '', 'relative']) {
    const response = await postWarm({ cwd });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, 'WORKSPACE_CWD_INVALID');
  }
  assert.deepEqual(warmed, []);
  assert.deepEqual(discovered, []);
});

function post(route: string, body: unknown, user = 'alice') {
  return fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) });
}

test('every route that takes a desktop folder refuses an unusable one with the same actionable error', async () => {
  saveWorkspace(directory);
  getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,created_at) VALUES ('node-a','ws','chat','idle',1)").run();
  const file = path.join(directory, 'file');
  fs.writeFileSync(file, 'not a directory');
  const unusable: Array<[string, string]> = [
    ['deleted folder', path.join(directory, 'deleted-workspace')],
    ['file', file],
    ['relative path', 'relative'],
  ];
  // Root reads any folder, and Windows has no such mode.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = path.join(directory, 'locked');
    fs.mkdirSync(locked, { mode: 0o000 });
    unusable.push(['folder it cannot read', locked]);
  }
  const routes: Array<[string, (cwd: string) => unknown]> = [
    ['/nodes/node-a/ensure-session', (cwd) => ({ cwd, workspaceId: 'ws' })],
    ['/runtime/health', (cwd) => ({ cwd })],
    ['/workspaces/import-file', (cwd) => ({ cwd, originalName: 'note.txt', content: 'hi' })],
    ['/workspaces/copy-file', (cwd) => ({ cwd, sourcePath: file })],
    ['/workspaces/link-file', (cwd) => ({ cwd, sourcePath: file })],
    ['/chats', (cwd) => ({ cwd, workspaceId: 'ws', nodeId: 'node-a' })],
    ['/chats/node-a/load', (cwd) => ({ cwd, nodeId: 'node-a' })],
    ['/digests/stream', (cwd) => ({ cwd, workspace: { name: 'W', createdAt: 1 }, rootTitle: 'T', nodes: [{ nodeId: 'node-a', depth: 0, messages: [] }] })],
  ];
  try {
    for (const [route, body] of routes) {
      for (const [label, cwd] of unusable) {
        const response = await post(route, body(cwd));
        assert.equal(response.status, 400, `${route}, ${label}`);
        const result = await response.json() as { code: string; error: string };
        assert.equal(result.code, 'WORKSPACE_CWD_INVALID', `${route}, ${label}`);
        assert.match(result.error, /Select an existing folder/, `${route}, ${label}`);
      }
    }
  } finally {
    if (unusable.length > 3) fs.chmodSync(unusable[3][1], 0o700);
  }
  assert.deepEqual([warmed, loaded, digestCwds], [[], [], []]);
  assert.equal(fs.existsSync(path.join(directory, '.contexts')), false);
});

test('both requests succeed after a missing folder is restored', async () => {
  const cwd = path.join(directory, 'restored');
  saveWorkspace(cwd);
  assert.equal((await postWarm({ cwd })).status, 400);
  assert.equal((await fetch(`${base}/workspaces/ws/modes`)).status, 400);
  fs.mkdirSync(cwd);
  assert.equal((await postWarm({ cwd })).status, 200);
  const modes = await fetch(`${base}/workspaces/ws/modes`);
  assert.equal(modes.status, 200);
  assert.deepEqual(await modes.json(), catalog);
  assert.deepEqual(warmed, [cwd]);
  assert.deepEqual(discovered, [fs.realpathSync.native(cwd)]);
});

function enableCloud() {
  process.env.MICHI_CLOUD = '1';
  configureRuntimeDeps({
    historyStore: { getNode: repository.getNode, listMessages: repository.listMessages,
      getWorkspace: repository.getWorkspace, getWorkspaceInstructions: repository.getWorkspaceInstructions },
    dataDir: directory, providerKeys: { getProviderApiKey: () => null },
    agentConfig: { getAgentConfig: config.getAgentConfig, resolveModel: config.resolveModel, resolveReasoning: config.resolveReasoning },
  });
}

test('cloud requests retain owner isolation and derive cwd from the owned Workspace', async () => {
  enableCloud();
  saveWorkspace('/ignored/client/path');
  assert.equal((await postWarm({ workspaceId: 'ws' }, 'bob')).status, 404);
  assert.equal((await fetch(`${base}/workspaces/ws/modes`, { headers: { 'x-user': 'bob' } })).status, 404);
  assert.deepEqual(warmed, []);
  assert.deepEqual(discovered, []);
  assert.equal((await postWarm({ workspaceId: 'ws', cwd: '/untrusted' })).status, 200);
  assert.equal((await fetch(`${base}/workspaces/ws/modes`)).status, 200);
  const expected = path.join(directory, 'user-cwds', 'alice', 'ws-ws');
  assert.deepEqual(warmed, [expected]);
  assert.deepEqual(discovered, [expected]);
});

test('a cloud digest runs in the sandbox of the owned Workspace, not a folder the request names', async () => {
  enableCloud();
  saveWorkspace('/ignored/client/path');
  const body = { workspaceId: 'ws', cwd: directory, workspace: { name: 'W', cwd: directory, createdAt: 1 }, rootTitle: 'T',
    nodes: [{ nodeId: 'node-a', depth: 0, messages: [] }] };
  assert.equal((await post('/digests/stream', body, 'bob')).status, 404);
  const response = await post('/digests/stream', body);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /event: done/);
  assert.deepEqual(digestCwds, [path.join(directory, 'user-cwds', 'alice', 'ws-ws')]);
});

test('cloud session reload derives cwd and Workspace from the owned node, not the request body', async () => {
  enableCloud();
  saveWorkspace('/ignored/client/path');
  repository.saveWorkspace({ id: 'foreign', name: 'Foreign', cwd: directory, owner_user_id: 'bob', created_at: 1, updated_at: 1 });
  getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,created_at) VALUES ('node-a','ws','chat','idle',1)").run();
  const response = await fetch(`${base}/chats/node-a/load`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'alice' },
    body: JSON.stringify({ nodeId: 'node-a', cwd: directory, workspaceId: 'foreign' }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].cwd, fs.realpathSync.native(path.join(directory, 'user-cwds', 'alice', 'ws-ws')));
  assert.equal(loaded[0].workspaceId, 'ws');
  assert.equal(loaded[0].ownerUserId, 'alice');
});

test('cloud sessions the backend reopens use the owned sandbox, not the stored Workspace folder', async () => {
  enableCloud();
  const manager = new ChatManager(undefined, directory);
  for (const [nodeId, cwd] of [['node-null', null], ['node-client', '/etc']] as const) {
    repository.saveWorkspace({ id: 'ws', name: 'Workspace', cwd, owner_user_id: 'alice', created_at: 1, updated_at: 1 });
    getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,created_at) VALUES (?,'ws','chat','idle',1)").run(nodeId);
    assert.ok(await manager.ensureParentSession({ ownerUserId: 'alice', workspaceId: 'ws', nodeId }));
  }
  const expected = path.join(directory, 'user-cwds', 'alice', 'ws-ws');
  assert.deepEqual(created.map((options) => options.cwd), [expected, expected]);
});
