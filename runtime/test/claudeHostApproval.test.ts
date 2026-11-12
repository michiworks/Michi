/**
 * ClaudeAdapterOptions.requireHostApproval: an unrestricted Claude session
 * loads the user's, project's and local settings, whose allow rules (and an
 * allowing user PreToolUse hook, or bypassPermissions) approve a call before
 * canUseTool is asked. A call the host requires approval for gets `ask` from
 * the session's PreToolUse hook, which the CLI answers by asking canUseTool.
 * Without the option, or when it answers false, the hook is unchanged.
 */
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDefaultHost } from '../src/core/defaultHost';
import {
  claudeAdapterOptions, type ClaudeAdapterOptions, type ClaudeHostApprovalRequest,
} from '../src/adapters/claude/claudeAdapterOptions';
import { ClaudeSession } from '../src/adapters/claude/ClaudeSession';
import type { ClaudeSdkTransportOptions } from '../src/adapters/claude/claudeSdkTransport';
import { interactiveOwner } from '../src/contract/types';

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

function options(extra: Partial<ClaudeAdapterOptions> = {}): ClaudeAdapterOptions {
  return { ...claudeAdapterOptions({ host: createDefaultHost({ logLevel: 'silent' }), spawnEnv: () => ({}) }), ...extra };
}

function session(id: string, adapter: ClaudeAdapterOptions, deps: Record<string, unknown> = {}): ClaudeSession {
  return new ClaudeSession(id, {
    nodeId: id, cwd: os.tmpdir(), workspaceId: null, mcpRegistry, bridge, options: adapter, persistNativeIdentity: false,
    ownerUserId: 'alice', ...deps,
  } as any);
}

/** The transport options a session's spawn passes; the spawn then fails before any process starts. */
async function spawnOptions(t: TestContext, s: ClaudeSession): Promise<ClaudeSdkTransportOptions> {
  let captured: ClaudeSdkTransportOptions | undefined;
  t.mock.method(transportModule, 'createClaudeSdkTransport', async (args: ClaudeSdkTransportOptions) => {
    captured = args;
    throw new Error('fixture: no CLI');
  });
  await assert.rejects(s.spawnFresh(), /fixture: no CLI/);
  t.mock.restoreAll();
  assert.ok(captured);
  return captured;
}

const signal = () => new AbortController().signal;

describe('a host that requires its own approval (ClaudeAdapterOptions.requireHostApproval)', () => {
  it('makes an unrestricted chat\'s PreToolUse hook ask, and passes the call as Claude names it', async (t) => {
    const seen: ClaudeHostApprovalRequest[] = [];
    const adapter = options({ requireHostApproval: (request) => { seen.push(request); return request.toolName !== 'Read'; } });
    const s = session('n-chat-1', adapter);
    try {
      const sdk = await spawnOptions(t, s);
      for (const tool of ['Bash', 'WebFetch', 'Write', 'mcp__github__create_issue', 'mcp____michi_internal____send_to_thread']) {
        const verdict = await sdk.preToolUse(tool, { command: 'curl https://evil.example' }, `h-${tool}`, signal());
        assert.equal(verdict?.behavior, 'ask', tool);
        assert.match((verdict as { message: string }).message, /approval/, tool);
      }
      assert.equal(await sdk.preToolUse('Read', { file_path: '/tmp/x' }, 'h-read', signal()), undefined, 'a call the host leaves alone keeps the CLI\'s flow');
      assert.deepEqual(seen.map(({ toolName, hostToolName, ownerUserId }) => ({ toolName, hostToolName, ownerUserId })), [
        { toolName: 'Bash', hostToolName: null, ownerUserId: 'alice' },
        { toolName: 'WebFetch', hostToolName: null, ownerUserId: 'alice' },
        { toolName: 'Write', hostToolName: null, ownerUserId: 'alice' },
        { toolName: 'mcp__github__create_issue', hostToolName: null, ownerUserId: 'alice' },
        { toolName: 'mcp____michi_internal____send_to_thread', hostToolName: 'send_to_thread', ownerUserId: 'alice' },
        { toolName: 'Read', hostToolName: null, ownerUserId: 'alice' },
      ]);
      assert.deepEqual(seen[0].owner, interactiveOwner('n-chat-1'));
    } finally { await s.dispose(); }
  });

  it('asks when the host callback throws', async (t) => {
    const s = session('n-chat-2', options({ requireHostApproval: () => { throw new Error('fixture: no database'); } }));
    try {
      const sdk = await spawnOptions(t, s);
      assert.equal((await sdk.preToolUse('Bash', {}, 'h', signal()))?.behavior, 'ask');
    } finally { await s.dispose(); }
  });

  it('leaves the hook as it was without the option or when it answers false', async (t) => {
    for (const adapter of [options(), options({ requireHostApproval: () => false })]) {
      const s = session('n-chat-3', adapter);
      try {
        const sdk = await spawnOptions(t, s);
        for (const tool of ['Bash', 'WebFetch', 'Write', 'Read', 'mcp____michi_internal____edit_page']) {
          assert.equal(await sdk.preToolUse(tool, {}, 'h', signal()), undefined, tool);
        }
      } finally { await s.dispose(); }
    }
  });

  it('is never consulted by a restricted session or a Run broker\'s, whose hooks decide already', async (t) => {
    let calls = 0;
    const adapter = options({
      requireHostApproval: () => { calls++; return true; },
      restrictedToolApproval: (name) => (name === 'read_node' ? 'allow' : 'deny'),
    });
    const restricted = session('n-cmph-3', adapter, { toolProfile: { restricted: true, allowedToolNames: ['read_node'] } });
    try {
      const sdk = await spawnOptions(t, restricted);
      (restricted as any).assistantInitVerified = true;
      (restricted as any).state = 'idle';
      assert.equal((await sdk.preToolUse('mcp____michi_internal____read_node', {}, 'h', signal()))?.behavior, 'allow');
      assert.equal((await sdk.preToolUse('Bash', {}, 'h', signal()))?.behavior, 'deny');
    } finally { await restricted.dispose(); }
    const brokered = session('n-run-1', adapter, { permissionBroker: { requestPermission: async () => 'deny' } });
    try {
      const sdk = await spawnOptions(t, brokered);
      assert.equal((await sdk.preToolUse('Bash', {}, 'h', signal()))?.behavior, 'deny');
    } finally { await brokered.dispose(); }
    assert.equal(calls, 0);
  });

  it('claudeAdapterOptions passes it on, and leaves it out when absent', () => {
    const host = createDefaultHost({ logLevel: 'silent' });
    const requireHostApproval = () => true;
    assert.equal(claudeAdapterOptions({ host, spawnEnv: () => ({}), requireHostApproval }).requireHostApproval, requireHostApproval);
    for (const built of [claudeAdapterOptions({ host, spawnEnv: () => ({}) }), claudeAdapterOptions({ host, spawnEnv: () => ({}), requireHostApproval: undefined })]) {
      assert.equal(Object.hasOwn(built, 'requireHostApproval'), false);
    }
  });
});

describe('the SDK transport\'s PreToolUse hook', () => {
  function stubSdk(t: TestContext) {
    t.mock.method(claudeBinary, 'preflightClaudeAuth', () => {});
    t.mock.method(claudeBinary, 'findClaudeBinary', () => '/fixture/claude');
    t.mock.method(processTree, 'spawnAgentProcess', () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }));
    const seen: any[] = [];
    const sdk: any = { query(args: any) {
      seen.push(args.options);
      args.options.spawnClaudeCodeProcess({ command: '/fixture/claude', args: [], cwd: '/tmp', env: {} });
      return { initializationResult: async () => ({}), close: () => {}, async *[Symbol.asyncIterator]() { /* none */ } };
    } };
    return { sdk, seen };
  }

  it('answers ask with its reason, allow with the input and deny with its message; nothing when the host has no verdict', async (t) => {
    const { sdk, seen } = stubSdk(t);
    const verdicts: Record<string, Awaited<ReturnType<ClaudeSdkTransportOptions['preToolUse']>>> = {
      Bash: { behavior: 'ask', message: 'needs approval' },
      Read: { behavior: 'allow', updatedInput: { file_path: '/tmp/x' } },
      Write: { behavior: 'deny', message: 'no' },
      Glob: undefined,
    };
    const transport = await transportModule.createClaudeSdkTransport({
      cwd: '/tmp', permissionMode: 'default', mcpConfigInline: '{"mcpServers":{}}', onMessage: () => {}, onStderr: () => {},
      onError: () => {}, authorize: async () => ({ behavior: 'deny', message: 'x' }),
      preToolUse: async (name) => verdicts[name], log: () => {}, spawnEnv: {}, sdk,
    });
    t.after(() => transport.close());
    const options = seen[0];
    assert.deepEqual(options.settingSources, ['user', 'project', 'local'], 'an unrestricted session loads the user\'s settings and their allow rules');
    const hook = options.hooks.PreToolUse[0].hooks[0];
    const run = (tool: string) => hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: `t-${tool}` }, `t-${tool}`, { signal: signal() });
    assert.deepEqual(await run('Bash'), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'needs approval' } });
    assert.deepEqual(await run('Read'), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { file_path: '/tmp/x' } } });
    assert.deepEqual(await run('Write'), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } });
    assert.deepEqual(await run('Glob'), {});
  });
});
