import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultHost } from '../src/core/defaultHost';
import { claudeAdapterOptions, type ClaudeAdapterOptions } from '../src/adapters/claude/claudeAdapterOptions';
import { ClaudeSession } from '../src/adapters/claude/ClaudeSession';
import { ClaudeRuntime } from '../src/adapters/claude/ClaudeRuntime';
import { claudeProjectSlug, discardClaudeNativeFiles } from '../src/adapters/claude/claudeProjectsPath';
import type { ClaudeSdkTransportOptions } from '../src/adapters/claude/claudeSdkTransport';
import { CLAUDE_RUNTIME_DESCRIPTOR } from '../src/adapters/claude/claudeDescriptor';
import { restrictedToolApproval } from '../src/adapters/claude/claudeRestrictedProfile';
import type { RuntimeToolProfile } from '../src/contract/types';

const transportModule = require('../src/adapters/claude/claudeSdkTransport') as typeof import('../src/adapters/claude/claudeSdkTransport');
const claudeBinary = require('../src/adapters/claude/claudeBinary') as typeof import('../src/adapters/claude/claudeBinary');
const processTree = require('../src/core/processTree') as typeof import('../src/core/processTree');

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
const mcpRegistry = {
  create: () => ({ slotId: 'slot-1' }),
  dispose: async () => {},
  get: () => undefined,
  endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:9/api/mcp/${slotId}`, headers: [] }),
} as any;

function tmp(t: TestContext, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function options(extra: Partial<ClaudeAdapterOptions> = {}, env: NodeJS.ProcessEnv = {}): ClaudeAdapterOptions {
  return { ...claudeAdapterOptions({ host: createDefaultHost({ logLevel: 'silent' }), spawnEnv: () => env }), ...extra };
}

function session(id: string, deps: Record<string, unknown> = {}, adapter: ClaudeAdapterOptions = options()): ClaudeSession {
  return new ClaudeSession(id, { nodeId: id, cwd: os.tmpdir(), workspaceId: null, mcpRegistry, bridge, options: adapter, persistNativeIdentity: false, ...deps } as any);
}

/** The transport options a session's spawn passes; the spawn then fails before any process starts. */
async function spawnOptions(t: TestContext, s: ClaudeSession): Promise<ClaudeSdkTransportOptions> {
  let captured: ClaudeSdkTransportOptions | undefined;
  t.mock.method(transportModule, 'createClaudeSdkTransport', async (args: ClaudeSdkTransportOptions) => {
    captured = args;
    throw new Error('fixture: no CLI');
  });
  await assert.rejects(s.spawnFresh(), /fixture: no CLI/);
  assert.ok(captured);
  return captured;
}

describe('Claude ephemeral sessions (DESIGN-v2 §3.2)', () => {
  it('declare native ephemeral sessions', () => {
    assert.equal(CLAUDE_RUNTIME_DESCRIPTOR.topology.ephemeralSessions, 'native');
  });

  it('an ephemeral session spawns with persistSession false and quiet telemetry; an ordinary one does not', async (t) => {
    const ephemeral = await spawnOptions(t, session('n-cmph-1', { ephemeral: true }));
    assert.equal(ephemeral.persistSession, false);
    assert.equal(ephemeral.quietTelemetry, true);
    t.mock.restoreAll();
    const ordinary = await spawnOptions(t, session('n-chat-1'));
    assert.equal(ordinary.persistSession, undefined);
    assert.equal(ordinary.quietTelemetry, undefined);
  });

  it('the SDK gets persistSession false and an environment without telemetry exporters', async (t) => {
    t.mock.method(claudeBinary, 'preflightClaudeAuth', () => {});
    t.mock.method(claudeBinary, 'findClaudeBinary', () => '/fixture/claude');
    const { EventEmitter } = require('node:events') as typeof import('node:events');
    const { PassThrough } = require('node:stream') as typeof import('node:stream');
    t.mock.method(processTree, 'spawnAgentProcess', () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }));
    const seen: any[] = [];
    const sdk: any = { query(args: any) {
      seen.push(args.options);
      args.options.spawnClaudeCodeProcess({ command: '/fixture/claude', args: [], cwd: '/tmp', env: {} });
      return { initializationResult: async () => ({}), close: () => {}, async *[Symbol.asyncIterator]() { /* none */ } };
    } };
    const spawnEnv = {
      PATH: '/usr/bin', AWS_PROFILE: 'p', ANTHROPIC_API_KEY: 'k',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector', otel_service_name: 'x', CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    };
    const base = {
      cwd: '/tmp', permissionMode: 'default' as const, mcpConfigInline: '{"mcpServers":{}}', onMessage: () => {}, onStderr: () => {},
      onError: () => {}, authorize: async () => ({ behavior: 'deny' as const, message: 'x' }), preToolUse: async () => undefined,
      log: () => {}, spawnEnv, sdk,
    };
    (await transportModule.createClaudeSdkTransport({ ...base, persistSession: false, quietTelemetry: true })).close();
    (await transportModule.createClaudeSdkTransport(base)).close();
    const [ephemeral, ordinary] = seen;
    assert.equal(ephemeral.persistSession, false);
    for (const key of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'otel_service_name', 'CLAUDE_CODE_ENABLE_TELEMETRY']) assert.equal(key in ephemeral.env, false, key);
    assert.equal(ephemeral.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(ephemeral.env.AWS_PROFILE, 'p', 'the session still reaches its model');
    assert.equal(ephemeral.env.ANTHROPIC_API_KEY, 'k');
    assert.equal(ordinary.persistSession, true);
    assert.equal(ordinary.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://collector');
    assert.equal(ordinary.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
    assert.equal('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' in ordinary.env, false);
  });

  it('a crashed ephemeral session fails its turn instead of resuming; an ordinary one resumes', async (t) => {
    for (const ephemeral of [true, false]) {
      const s = session(`n-crash-${ephemeral}`, ephemeral ? { ephemeral: true } : {});
      const resumes: string[] = [];
      t.mock.method(s, 'spawnResume', async (id: string) => { resumes.push(id); throw new Error('fixture: resumed'); });
      (s as any).state = 'crashed';
      (s as any).externalSessionId = randomUUID();
      const events: unknown[] = [];
      await assert.rejects(async () => { for await (const event of s.send('hello')) events.push(event); },
        ephemeral ? /not restored/ : /fixture: resumed/);
      assert.equal(resumes.length, ephemeral ? 0 : 1);
      await s.dispose();
    }
    await assert.rejects(session('n-direct', { ephemeral: true }).spawnResume(randomUUID()), /never resumed/);
  });

  it('the runtime never forks or warm-pools an ephemeral session, and defers discarding a live one', async (t) => {
    const adapter = options();
    const runtime = new ClaudeRuntime({ ...adapter, bridge, mcpSlots: mcpRegistry });
    t.after(() => runtime.shutdown());
    await assert.rejects(runtime.forkSession({ sessionId: 'n-f', parentChatId: 'n-p', cwd: '/tmp', sourceNativeSessionId: randomUUID(), ephemeral: true } as any), /never forked/);
    const manager = (runtime as any).manager;
    manager.active.set('n-live', session('n-live', { ephemeral: true }, adapter));
    assert.equal(await runtime.discardNativeSession({ sessionId: 'n-live', owner: { mode: 'interactive', key: 'n-live' }, nativeSessionId: randomUUID(), cwd: '/tmp' }), 'deferred');
    await manager.active.get('n-live').dispose();
    manager.active.delete('n-live');
  });
});

describe('restricted Claude sessions pass their own profile to the host verdict (DESIGN-v2 §2.5)', () => {
  const profile: RuntimeToolProfile = { restricted: true, allowedToolNames: ['read_node'] };

  it('the helper forwards the profile', () => {
    const seen: unknown[] = [];
    assert.equal(restrictedToolApproval({ restrictedToolApproval: (name, p) => { seen.push([name, p]); return 'allow'; } }, 'read_node', profile), 'allow');
    assert.deepEqual(seen, [['read_node', profile]]);
  });

  it('both ClaudeSession call sites (the SDK hook verdict and the approval callback) pass the session profile', async () => {
    const seen: Array<[string | null, RuntimeToolProfile | undefined]> = [];
    const adapter = options({ restrictedToolApproval: (name, p) => { seen.push([name, p]); return name === 'read_node' ? 'allow' : 'deny'; } });
    const s = session('n-cmph-2', { toolProfile: profile }, adapter);
    try {
      (s as any).assistantInitVerified = true;
      (s as any).state = 'idle';
      const hook = (s as any).assistantSdkVerdict('mcp____michi_internal____read_node', {}, new AbortController().signal);
      assert.equal(hook.behavior, 'allow');
      const approval = await (s as any).makeOnApprove()({ toolName: 'mcp____michi_internal____list_threads', input: {}, toolUseId: 't-1' });
      assert.equal(approval.behavior, 'deny');
      assert.deepEqual(seen, [['read_node', profile], ['list_threads', profile]]);
    } finally { await s.dispose(); }
  });
});

describe('discardClaudeNativeFiles removes only the session\'s own files', () => {
  function layout(t: TestContext) {
    const config = tmp(t, 'claude-discard-');
    const cwd = path.join(tmp(t, 'claude-cwd-'), 'checkin', '.michi');
    fs.mkdirSync(cwd, { recursive: true });
    const adapter = options({ configDir: () => config });
    const id = randomUUID();
    const other = randomUUID();
    const projects = path.join(config, 'projects', claudeProjectSlug(fs.realpathSync(cwd)));
    fs.mkdirSync(path.join(projects, id, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(projects, `${id}.jsonl`), '{}\n');
    fs.writeFileSync(path.join(projects, `${other}.jsonl`), '{}\n');
    fs.mkdirSync(path.join(config, 'session-env', id), { recursive: true });
    fs.mkdirSync(path.join(config, 'session-env', other), { recursive: true });
    return { config, cwd, adapter, id, other, projects };
  }

  it('the jsonl, the <id>/ directory and session-env/<id>/; nothing else', async (t) => {
    const { config, cwd, adapter, id, other, projects } = layout(t);
    assert.equal(await discardClaudeNativeFiles(adapter, { cwd, nativeSessionId: id }), 'discarded');
    assert.equal(fs.existsSync(path.join(projects, `${id}.jsonl`)), false);
    assert.equal(fs.existsSync(path.join(projects, id)), false);
    assert.equal(fs.existsSync(path.join(config, 'session-env', id)), false);
    assert.ok(fs.existsSync(path.join(projects, `${other}.jsonl`)));
    assert.ok(fs.existsSync(path.join(config, 'session-env', other)));
    assert.equal(await discardClaudeNativeFiles(adapter, { cwd, nativeSessionId: id }), 'absent');
  });

  it('refuses a native id that is not a UUID, and an empty or relative one, removing nothing', async (t) => {
    const { cwd, adapter, projects, config } = layout(t);
    const before = fs.readdirSync(projects).sort();
    for (const bad of ['', '..', '../projects', '.', 'abc', `${randomUUID()}/..`, `../${randomUUID()}`, '*']) {
      assert.equal(await discardClaudeNativeFiles(adapter, { cwd, nativeSessionId: bad }), 'unsupported', JSON.stringify(bad));
    }
    assert.equal(await discardClaudeNativeFiles(adapter, { cwd: 'relative/dir', nativeSessionId: randomUUID() }), 'unsupported');
    assert.equal(await discardClaudeNativeFiles(adapter, { cwd, nativeSessionId: null }), 'absent');
    assert.deepEqual(fs.readdirSync(projects).sort(), before);
    assert.ok(fs.existsSync(path.join(config, 'projects')));
  });

  it('refuses a cloud user segment that would leave the projects directory', async (t) => {
    const { cwd, config } = layout(t);
    const host = createDefaultHost({ logLevel: 'silent', ports: { principal: { enforceUserOwnership: () => true } } as any });
    const adapter = { ...claudeAdapterOptions({ host, spawnEnv: () => ({}) }), configDir: () => config };
    assert.equal(host.principal.enforceUserOwnership(), true);
    assert.equal(await discardClaudeNativeFiles(adapter, { cwd, nativeSessionId: randomUUID(), ownerUserId: '../..' }), 'unsupported');
  });
});
