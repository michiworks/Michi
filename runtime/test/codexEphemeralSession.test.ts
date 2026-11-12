import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpSlot, McpSlotCallbacks, McpSlotProvider } from '../src/contract/mcp';
import type { RuntimeToolProfile } from '../src/contract/types';
import { createDefaultHost } from '../src/core/defaultHost';
import { CodexRpcError, type CodexAppServerClient } from '../src/adapters/codex/CodexAppServerClient';
import { CodexRuntime } from '../src/adapters/codex/CodexRuntime';
import type { CodexSession } from '../src/adapters/codex/CodexSession';
import { CODEX_HOST_MCP_SERVER } from '../src/adapters/codex/codexProtocol';
import { CODEX_RUNTIME_DESCRIPTOR } from '../src/adapters/codex/codexDescriptor';
import {
  CODEX_EPHEMERAL_APP_SERVER_ARGS, codexEphemeralConfigToml, codexEphemeralHomeDir, prepareCodexEphemeralHome, removeCodexEphemeralHome,
} from '../src/adapters/codex/codexEphemeralHome';
import { CODEX_RESTRICTED_FEATURES_OFF } from '../src/adapters/codex/codexRestrictedProfile';

type Handler = (method: string, params: Record<string, unknown>) => void;
interface Request { method: string; params: Record<string, any> }

/** The user's effective config as the main app-server's config/read reports it: provider keys beside things a check-in must not inherit. */
const USER_CONFIG = {
  model: 'gpt-x', model_provider: 'proxy', model_reasoning_effort: 'high',
  notify: ['/bin/sh', '-c', 'echo canary >> /tmp/canary'],
  features: { hooks: true, memories: true, js_repl: true },
  mcp_servers: { 'docs-server': { command: 'docs-server' } },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
  memories: { generate_memories: true },
  model_providers: {
    proxy: {
      name: 'proxy', base_url: 'http://127.0.0.1:8317/v1', wire_api: 'responses', env_key: 'PROXY_KEY', requires_openai_auth: true,
      http_headers: { 'X-Team': 'michi' }, experimental_bearer_token: 'literal-secret',
      // A user's config can nest anything under a provider table.
      projects: { '/x': { trust_level: 'trusted' } }, plugins: { 'p@m': { enabled: true } }, mcp_servers: { leak: { command: 'leak' } },
    },
    other: { name: 'other', base_url: 'http://other' },
  },
};

/** `omitEphemeral`: thread/start answers without the thread's `ephemeral` field, as an app-server that ignores it might. */
function fakeAppServer(label: string, opts: { config?: unknown; deleteError?: string; omitEphemeral?: boolean } = {}) {
  const requests: Request[] = [];
  const perThread = new Map<string, Set<Handler>>();
  let threads = 0;
  let shutdowns = 0;
  const exitHandlers: Array<() => void> = [];
  const client = {
    ensureStarted: async () => {},
    request: async (method: string, params: Record<string, any>) => {
      requests.push({ method, params });
      switch (method) {
        case 'config/read': return { config: opts.config ?? {}, origins: {} };
        case 'mcpServerStatus/list': return { data: [{ name: CODEX_HOST_MCP_SERVER, runtimeStatus: 'connected', tools: {} }] };
        case 'thread/start': return { thread: { id: `${label}-thread-${++threads}`, ...(opts.omitEphemeral ? {} : { ephemeral: params.ephemeral === true }), path: params.ephemeral ? null : '/r.jsonl' } };
        case 'thread/resume': return { thread: { id: params.threadId } };
        case 'thread/delete':
          if (opts.deleteError) throw new CodexRpcError('thread/delete', -32600, opts.deleteError);
          return {};
        case 'model/list': return { data: [] };
        default: return {};
      }
    },
    onNotification: (threadId: string, handler: Handler) => {
      let set = perThread.get(threadId);
      if (!set) perThread.set(threadId, (set = new Set()));
      set.add(handler);
      return () => { set.delete(handler); };
    },
    onGlobalNotification: () => () => {},
    onServerRequest: () => {},
    onExit: (handler: () => void) => { exitHandlers.push(handler); return () => {}; },
    shutdown: async () => { shutdowns += 1; },
    isRunning: () => true,
    hasPendingRequests: () => false,
  };
  return {
    client: client as unknown as CodexAppServerClient, requests,
    get shutdowns() { return shutdowns; },
    exit: () => { for (const handler of exitHandlers) handler(); },
    find: (method: string) => requests.find((r) => r.method === method),
  };
}

function slotProvider(failCreate = false): McpSlotProvider {
  let slots = 0;
  return {
    create: (parentChatId: string, cwd: string, ownerUserId: string | null, cbs: McpSlotCallbacks) => {
      if (failCreate) throw new Error('fixture: no MCP slot');
      return ({ slotId: `slot-${++slots}`, parentChatId, cwd, ownerUserId, nodeId: null, workspaceId: null, ...cbs }) as McpSlot;
    },
    dispose: async () => {},
    endpoint: (slotId: string) => ({ type: 'http', url: `http://127.0.0.1:1/api/mcp/${slotId}`, headers: [] }),
    hookEndpoint: (slotId: string) => `http://127.0.0.1:1/mcp-hooks/${slotId}/stop`,
  } as unknown as McpSlotProvider;
}

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
const restricted: RuntimeToolProfile = { allowedToolNames: ['read_node'], restricted: true };

function tmp(t: TestContext, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t: TestContext, mainOpts: { deleteError?: string } = {}, ephemeralOpts: { omitEphemeral?: boolean; failSlot?: boolean } = {}) {
  const root = tmp(t, 'codex-eph-root-');
  const userHome = tmp(t, 'codex-user-home-');
  fs.writeFileSync(path.join(userHome, 'auth.json'), '{"fixture":true}');
  const main = fakeAppServer('main', { config: USER_CONFIG, ...mainOpts });
  const ephemeral: Array<{ home: string; args: readonly string[]; server: ReturnType<typeof fakeAppServer> }> = [];
  const runtime = new CodexRuntime({
    host: createDefaultHost({ logLevel: 'silent' }), bridge, mcpSlots: slotProvider(ephemeralOpts.failSlot), ephemeralHomeRoot: root, codexHome: userHome,
  }, {
    client: main.client,
    ephemeralClient: (home, args) => {
      const server = fakeAppServer(`eph${ephemeral.length}`, { omitEphemeral: ephemeralOpts.omitEphemeral });
      ephemeral.push({ home, args, server });
      return server.client;
    },
  });
  t.after(() => runtime.shutdown());
  return { root, userHome, main, ephemeral, runtime };
}

const owner = (key: string) => ({ mode: 'interactive' as const, key });

describe('Codex ephemeral home (DESIGN-v2 §2.4; probe P3)', () => {
  it('config.toml keeps the model, the sign-in keys and the selected provider\'s connection keys, nothing else', () => {
    const text = codexEphemeralConfigToml({ config: USER_CONFIG });
    assert.match(text, /^model = "gpt-x"$/m);
    assert.match(text, /^model_provider = "proxy"$/m);
    assert.match(text, /^\[model_providers\.proxy\]$/m);
    for (const line of ['name = "proxy"', 'base_url = "http://127.0.0.1:8317/v1"', 'wire_api = "responses"', 'env_key = "PROXY_KEY"',
      'requires_openai_auth = true', 'http_headers = { X-Team = "michi" }']) {
      assert.ok(text.split('\n').includes(line), line);
    }
    for (const leak of ['notify', 'hooks', 'mcp_servers', 'memories', 'features', 'projects', 'plugins', 'literal-secret', 'leak', 'other', 'model_reasoning_effort']) {
      assert.equal(text.includes(leak), false, `${leak} must not reach a check-in`);
    }
    assert.equal(codexEphemeralConfigToml({ config: { model: 'm' } }), '# Written by Michi for one ephemeral session; removed with it.\nmodel = "m"\n');
    assert.equal(codexEphemeralConfigToml(null).includes('model'), false);
  });

  it('a home holds a link to the user\'s auth.json and that config only; removing it leaves the user\'s file', (t) => {
    const root = tmp(t, 'codex-eph-');
    const user = tmp(t, 'codex-user-');
    fs.writeFileSync(path.join(user, 'auth.json'), '{"secret":1}');
    const home = prepareCodexEphemeralHome({ root, sessionId: 'n-cmph-run-1', codexHome: user, configToml: 'model = "m"\n' });
    assert.equal(home, codexEphemeralHomeDir(root, 'n-cmph-run-1'));
    assert.equal(path.dirname(home), path.resolve(root));
    assert.deepEqual(fs.readdirSync(home).sort(), ['auth.json', 'config.toml']);
    if (process.platform !== 'win32') {
      assert.equal(fs.readlinkSync(path.join(home, 'auth.json')), path.join(user, 'auth.json'));
      assert.equal(fs.statSync(path.join(home, 'config.toml')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    }
    // A traversal-looking id still names a directory directly under the root.
    assert.equal(path.dirname(codexEphemeralHomeDir(root, '../../etc')), path.resolve(root));
    assert.equal(removeCodexEphemeralHome(root, 'n-cmph-run-1'), true);
    assert.equal(fs.existsSync(home), false);
    assert.equal(fs.readFileSync(path.join(user, 'auth.json'), 'utf8'), '{"secret":1}');
    assert.equal(removeCodexEphemeralHome(root, 'n-cmph-run-1'), false);
  });

  it('the app-server overrides switch off notify, hooks, memories, plugins, shell snapshots, history and telemetry', () => {
    const pairs = new Set<string>();
    for (let i = 0; i < CODEX_EPHEMERAL_APP_SERVER_ARGS.length; i += 2) {
      assert.equal(CODEX_EPHEMERAL_APP_SERVER_ARGS[i], '-c');
      pairs.add(CODEX_EPHEMERAL_APP_SERVER_ARGS[i + 1]);
    }
    for (const value of ['notify=[]', 'features.hooks=false', 'features.memories=false', 'features.plugins=false', 'history.persistence="none"', 'otel.exporter="none"',
      // A snapshot runs the user's login shell and its rc files (W1-A review; P3 saw shell_snapshots/ on the scratch home).
      'features.shell_snapshot=false', 'features.shell_snapshot_v2=false']) {
      assert.ok(pairs.has(value), value);
    }
  });

  it('restricted threads keep shell snapshots off too', () => {
    assert.equal(CODEX_RESTRICTED_FEATURES_OFF.shell_snapshot, false);
    assert.equal(CODEX_RESTRICTED_FEATURES_OFF.shell_snapshot_v2, false);
  });

  it('declares native ephemeral sessions', () => {
    assert.equal(CODEX_RUNTIME_DESCRIPTOR.topology.ephemeralSessions, 'native');
  });
});

describe('Codex ephemeral sessions run on an app-server and home of their own', () => {
  it('opens an ephemeral thread there, never on the user\'s app-server; release stops it, discard removes the home', async (t) => {
    const { root, main, ephemeral, runtime } = setup(t);
    const session = await runtime.newSession({ sessionId: 'n-cmph-a', cwd: os.tmpdir(), model: 'm', toolProfile: restricted, ephemeral: true }) as CodexSession;
    assert.equal(ephemeral.length, 1);
    const [{ home, args, server }] = ephemeral;
    assert.equal(home, codexEphemeralHomeDir(root, 'n-cmph-a'));
    assert.deepEqual(args, CODEX_EPHEMERAL_APP_SERVER_ARGS);
    // The user's effective config was read once, for the home's config.toml; no thread opened on the user's app-server.
    assert.deepEqual(main.requests.map((r) => r.method).filter((m) => m !== 'model/list'), ['config/read']);
    const start = server.find('thread/start')!;
    assert.equal(start.params.ephemeral, true);
    assert.equal(start.params.sandbox, 'read-only');
    assert.equal(server.find('thread/memoryMode/set'), undefined, 'an ephemeral thread refuses metadata updates (P3)');
    assert.equal(session.threadId, 'eph0-thread-1');
    assert.deepEqual(fs.readdirSync(home).sort(), ['auth.json', 'config.toml']);
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8').includes('notify'), false);

    assert.equal(await runtime.discardNativeSession({ sessionId: 'n-cmph-a', owner: owner('n-cmph-a'), nativeSessionId: session.threadId, cwd: os.tmpdir() }), 'deferred');
    await runtime.releaseSession('n-cmph-a');
    assert.equal(server.shutdowns, 1, 'release stops the session\'s own app-server');
    assert.ok(fs.existsSync(home), 'the home stays until the discard');
    assert.equal(await runtime.discardNativeSession({ sessionId: 'n-cmph-a', owner: owner('n-cmph-a'), nativeSessionId: 'eph0-thread-1', cwd: os.tmpdir() }), 'discarded');
    assert.equal(fs.existsSync(home), false);
    assert.equal(main.find('thread/delete'), undefined, 'a scratch home is discarded without touching the user\'s app-server');
  });

  it('without a home, a persisted id is deleted on the main app-server; an unknown one is absent', async (t) => {
    const deleted = setup(t);
    assert.equal(await deleted.runtime.discardNativeSession({ sessionId: 'n-cmph-old', owner: owner('n-cmph-old'), nativeSessionId: 'thread-p', cwd: os.tmpdir() }), 'discarded');
    assert.deepEqual(deleted.main.find('thread/delete')!.params, { threadId: 'thread-p' });
    const gone = setup(t, { deleteError: 'no rollout found for thread id thread-q' });
    assert.equal(await gone.runtime.discardNativeSession({ sessionId: 'n-cmph-q', owner: owner('n-cmph-q'), nativeSessionId: 'thread-q', cwd: os.tmpdir() }), 'absent');
    const notPersisted = setup(t, { deleteError: 'thread is not persisted and cannot be deleted: thread-e' });
    assert.equal(await notPersisted.runtime.discardNativeSession({ sessionId: 'n-cmph-e', owner: owner('n-cmph-e'), nativeSessionId: 'thread-e', cwd: os.tmpdir() }), 'absent');
    assert.equal(await gone.runtime.discardNativeSession({ sessionId: 'n-cmph-none', owner: owner('n-cmph-none'), nativeSessionId: null, cwd: os.tmpdir() }), 'absent');
    const failing = setup(t, { deleteError: 'database is locked' });
    await assert.rejects(failing.runtime.discardNativeSession({ sessionId: 'n-cmph-f', owner: owner('n-cmph-f'), nativeSessionId: 'thread-f', cwd: os.tmpdir() }), /database is locked/);
  });

  it('an ordinary session stays on the user\'s app-server; an ephemeral one is never forked', async (t) => {
    const { main, ephemeral, runtime } = setup(t);
    await runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'm' });
    assert.equal(ephemeral.length, 0);
    assert.equal(main.find('thread/start')!.params.ephemeral, undefined);
    await assert.rejects(runtime.forkSession({ sessionId: 'n-cmph-f', cwd: os.tmpdir(), model: 'm', parentChatId: 'chat-a', sourceNativeSessionId: 'main-thread-1', ephemeral: true }),
      /never forked/);
    assert.equal(ephemeral.length, 0);
  });

  it('restarting the user\'s app-server to recover a chat leaves a check-in on its own app-server alone', async (t) => {
    const { main, ephemeral, runtime } = setup(t);
    const chat = await runtime.newSession({ sessionId: 'chat-r', cwd: os.tmpdir(), model: 'm' }) as CodexSession;
    const session = await runtime.newSession({ sessionId: 'n-cmph-r', cwd: os.tmpdir(), model: 'm', toolProfile: restricted, ephemeral: true }) as CodexSession;
    chat.markCrashed('fixture: stuck turn');
    chat.requiresRestart = true;
    await (runtime as any).recoverSession(chat);
    assert.equal(main.shutdowns, 1, 'the user\'s app-server was restarted');
    assert.equal(chat.needsRecovery(), false);
    assert.equal(session.needsRecovery(), false, 'the check-in keeps running on its own app-server');
    assert.equal(ephemeral[0].server.shutdowns, 0);
  });

  it('a thread/start answer that does not say ephemeral: true fails the check-in and stops its app-server', async (t) => {
    const { ephemeral, runtime } = setup(t, {}, { omitEphemeral: true });
    await assert.rejects(runtime.newSession({ sessionId: 'n-cmph-o', cwd: os.tmpdir(), model: 'm', toolProfile: restricted, ephemeral: true }),
      /did not open an ephemeral thread/);
    assert.equal(ephemeral[0].server.shutdowns, 1);
  });

  it('a failure after its app-server started, before the thread, stops that app-server', async (t) => {
    const slot = setup(t, {}, { failSlot: true });
    await assert.rejects(slot.runtime.newSession({ sessionId: 'n-cmph-s', cwd: os.tmpdir(), model: 'm', toolProfile: restricted, ephemeral: true }),
      /no MCP slot/);
    assert.equal(slot.ephemeral.length, 1);
    assert.equal(slot.ephemeral[0].server.shutdowns, 1, 'not left running until a discard or shutdown');
    assert.equal(slot.ephemeral[0].server.find('thread/start'), undefined);
    // The title model is resolved on the user's app-server before a check-in's own one starts.
    const title = setup(t);
    t.mock.method(title.runtime as any, 'resolveTitleModel', async () => { throw new Error('fixture: model/list failed'); });
    await assert.rejects(title.runtime.newSession({ sessionId: 'n-cmph-t', cwd: os.tmpdir(), model: 'm', toolProfile: restricted, ephemeral: true }),
      /model\/list failed/);
    assert.equal(title.ephemeral.length, 0, 'no app-server was started for it');
  });

  it('its app-server exiting crashes only that session, which is then not restored', async (t) => {
    const { ephemeral, runtime } = setup(t);
    const chat = await runtime.newSession({ sessionId: 'chat-b', cwd: os.tmpdir(), model: 'm' }) as CodexSession;
    const session = await runtime.newSession({ sessionId: 'n-cmph-c', cwd: os.tmpdir(), model: 'm', toolProfile: restricted, ephemeral: true }) as CodexSession;
    ephemeral[0].server.exit();
    assert.equal(session.needsRecovery(), true);
    assert.equal(chat.needsRecovery(), false);
    await assert.rejects(async () => { for await (const _ of session.send('hello')) { /* none */ } }, /not restored/);
  });
});
