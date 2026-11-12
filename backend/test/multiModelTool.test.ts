/**
 * The multi-model tool surface: the propose and list handlers over a fake
 * port (agents/multiModelTool.ts), their MCP registration per slot kind, the
 * Pi catalog, the kill switch, and the permission and trust entries that let
 * both tools run without a native prompt.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MultiModelProposalResult, ReadyModelsDto } from 'michi-shared';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import {
  LIST_READY_MODELS_TOOL,
  MultiModelError,
  PROPOSE_MULTI_MODEL_PLAN_TOOL,
  configureMultiModelTools,
  listReadyModelsTool,
  proposeMultiModelPlanTool,
  type MultiModelToolCaller,
  type MultiModelToolPort,
} from '../src/agents/multiModelTool';
import { BUILTIN_TOOLS, CHAT_ONLY_BUILTIN_TOOLS, listEnabledBuiltinTools } from '../src/agents/builtinTools';
import { resolveChatPolicy } from '../src/agents/permissionPolicy';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { buildPiTools } from '../src/agents/pi/piTools';
import { loadPiTypebox } from '../src/agents/pi/piAi';
import { McpSlotRegistry, buildMcpServerForSlot } from '../src/services/mcpServer';
import { classifyToolTrust, MICHI_TOOL_NAMES } from '../src/services/turnTrust';
import { ensureAssistant } from '../src/assistant/store';
import { chatOwner, runOwner } from './helpers/owners';

const NAMES = [LIST_READY_MODELS_TOOL, PROPOSE_MULTI_MODEL_PLAN_TOOL] as const;

const PROPOSAL: MultiModelProposalResult = {
  status: 'proposed', runId: 'wfr_1', nativeId: 'mm_1',
  threads: [{ key: 't1', label: 'Codex · GPT-6.1 Sol', context: 'fork' }],
  reviewRounds: 1, next: 'End your turn now.',
};
const READY: ReadyModelsDto = {
  version: 1,
  runtimes: [{ runtimeId: 'codex', label: 'Codex', defaultModelId: 'gpt', defaultProviderId: null, models: [{ modelId: 'gpt', label: 'GPT' }] }],
};

const CALLER: MultiModelToolCaller = {
  ownerUserId: 'alice', workspaceId: 'ws-a', nodeId: 'n-a', runtimeSessionId: 'n-a',
  turn: { turnId: 'turn-1', assistantId: 'asst-1' }, isAgentRun: false, assistant: false, maintenance: false,
};

interface RecordingPort extends MultiModelToolPort {
  proposals: Array<{ caller: MultiModelToolCaller; args: unknown; signal?: AbortSignal }>;
  lists: MultiModelToolCaller[];
}

function recordingPort(overrides: Partial<MultiModelToolPort> = {}): RecordingPort {
  const port: RecordingPort = {
    proposals: [],
    lists: [],
    async propose(caller, args, opts) {
      port.proposals.push({ caller, args, signal: opts?.signal });
      return overrides.propose ? overrides.propose(caller, args, opts) : PROPOSAL;
    },
    async listReadyModels(caller) {
      port.lists.push(caller);
      return overrides.listReadyModels ? overrides.listReadyModels(caller) : READY;
    },
  };
  return port;
}

const text = (result: { content: Array<{ text: string }> }) => result.content[0].text;

afterEach(() => configureMultiModelTools(null));

describe('handlers', () => {
  test('propose returns the port\'s result as JSON and passes the caller, the arguments and the signal', async () => {
    const port = recordingPort();
    const signal = new AbortController().signal;
    const args = { title: 'Compare', threads: [] };
    const result = await proposeMultiModelPlanTool(CALLER, args, { signal }, port);
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(text(result)), PROPOSAL);
    assert.equal(port.proposals.length, 1);
    assert.equal(port.proposals[0].caller, CALLER);
    assert.equal(port.proposals[0].args, args);
    assert.equal(port.proposals[0].signal, signal);
  });

  test('a MultiModelError becomes an error result with its code and message', async () => {
    const port = recordingPort({
      propose: async () => { throw new MultiModelError('limit', 'At most 5 threads.', 400); },
      listReadyModels: async () => { throw new MultiModelError('refused', 'Not in a branch of a plan.', 409); },
    });
    const proposed = await proposeMultiModelPlanTool(CALLER, {}, {}, port);
    assert.equal(proposed.isError, true);
    assert.deepEqual(JSON.parse(text(proposed)), { status: 'error', code: 'limit', message: 'At most 5 threads.' });
    const listed = await listReadyModelsTool(CALLER, port);
    assert.equal(listed.isError, true);
    assert.deepEqual(JSON.parse(text(listed)), { status: 'error', code: 'refused', message: 'Not in a branch of a plan.' });
  });

  test('any other failure goes to the generic error path', async () => {
    const port = recordingPort({ propose: async () => { throw new Error('database is locked'); } });
    await assert.rejects(proposeMultiModelPlanTool(CALLER, {}, {}, port), /database is locked/);
  });

  test('an unconfigured port is unavailable; the boot wiring is the default port', async () => {
    const unavailable = { status: 'error', code: 'unavailable', message: 'Multi-model plans are not available in this Michi backend.' };
    for (const result of [await proposeMultiModelPlanTool(CALLER, {}), await listReadyModelsTool(CALLER)]) {
      assert.equal(result.isError, true);
      assert.deepEqual(JSON.parse(text(result)), unavailable);
    }
    const port = recordingPort();
    configureMultiModelTools(port);
    assert.deepEqual(JSON.parse(text(await listReadyModelsTool(CALLER))), READY);
    assert.deepEqual(JSON.parse(text(await proposeMultiModelPlanTool(CALLER, {}))), PROPOSAL);
    assert.deepEqual([port.lists.length, port.proposals.length], [1, 1]);
  });

  test('an already-aborted call is cancelled without reaching the port; an abort during the call is cancelled too', async () => {
    const port = recordingPort();
    const aborted = new AbortController();
    aborted.abort();
    const before = await proposeMultiModelPlanTool(CALLER, {}, { signal: aborted.signal }, port);
    assert.equal(before.isError, true);
    assert.equal(JSON.parse(text(before)).code, 'cancelled');
    assert.equal(port.proposals.length, 0);

    const during = new AbortController();
    const racing = recordingPort({ propose: async () => { during.abort(); throw new DOMException('aborted', 'AbortError'); } });
    const result = await proposeMultiModelPlanTool(CALLER, {}, { signal: during.signal }, racing);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(text(result)).code, 'cancelled');
  });

  test('a backend fault during an aborted call keeps its own error', async () => {
    const during = new AbortController();
    const fault = new Error('database is locked');
    const failing = recordingPort({ propose: async () => { during.abort(); throw fault; } });
    await assert.rejects(proposeMultiModelPlanTool(CALLER, {}, { signal: during.signal }, failing), (error) => error === fault);
  });
});

describe('catalog entries', () => {
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined) => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    saved.clear();
  });

  test('defined once, chat-only, trusted Michi tools', () => {
    for (const name of NAMES) {
      assert.equal(BUILTIN_TOOLS.filter((tool) => tool.name === name).length, 1, name);
      assert.ok(CHAT_ONLY_BUILTIN_TOOLS.has(name), name);
      assert.ok(MICHI_TOOL_NAMES.has(name), name);
      assert.equal(classifyToolTrust({ runtimeId: 'claude', toolName: name, mcpServer: '__michi_internal__', hostTool: true }), 'trusted');
    }
    const propose = BUILTIN_TOOLS.find((tool) => tool.name === PROPOSE_MULTI_MODEL_PLAN_TOOL)!;
    assert.deepEqual(Object.keys(propose.parameters.object).sort(), ['reviewRounds', 'sharedContext', 'sharedPrompt', 'threads', 'title']);
  });

  test('the kill switch removes both tools, on the fast path too', () => {
    // Web search (Railway), scheduling and skills all on: the unfiltered fast path.
    for (const key of ['MICHI_CLOUD', 'MICHI_SCHEDULED_JOBS', 'MICHI_WEB_SEARCH_ENABLED', 'MICHI_DISABLE_MULTI_MODEL']) setEnv(key, undefined);
    setEnv('RAILWAY_PROJECT_ID', 'test-project');
    assert.equal(listEnabledBuiltinTools(), BUILTIN_TOOLS);
    setEnv('MICHI_DISABLE_MULTI_MODEL', '1');
    const fast = listEnabledBuiltinTools().map((tool) => tool.name as string);
    for (const name of NAMES) assert.ok(!fast.includes(name), name);
    assert.ok(fast.includes('web_search') && fast.includes('michi_skills') && fast.includes('create_scheduled_job'));
    // The filtered path (web search off).
    setEnv('RAILWAY_PROJECT_ID', undefined);
    setEnv('MICHI_WEB_SEARCH_ENABLED', '0');
    const filtered = listEnabledBuiltinTools().map((tool) => tool.name as string);
    for (const name of NAMES) assert.ok(!filtered.includes(name), name);
    setEnv('MICHI_DISABLE_MULTI_MODEL', undefined);
    for (const name of NAMES) assert.ok(listEnabledBuiltinTools().some((tool) => tool.name === name), name);
  });

  test('Ask mode runs both without a prompt under every runtime\'s name', () => {
    configureRuntimeDeps({
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined },
      chatPermissions: { getMode: () => 'ask', hasGrant: () => false, grant: () => {} },
      dataDir: os.tmpdir(),
    } as never);
    try {
      for (const tool of NAMES) {
        for (const name of [tool, `mcp____michi_internal____${tool}`, `@michi/${tool}`]) {
          assert.equal(resolveChatPolicy(chatOwner('n-a'), null, name), 'allow', `Pi ${name}`);
          assert.equal(resolveChatPolicy(chatOwner('n-a'), null, name, true), 'allow', `native ${name}`);
        }
      }
    } finally {
      __resetRuntimeDeps();
    }
  });
});

describe('tool surfaces', () => {
  const saved = { cloud: process.env.MICHI_CLOUD, dataDir: process.env.MICHI_DATA_DIR, killSwitch: process.env.MICHI_DISABLE_MULTI_MODEL };
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-multi-model-tool-'));
    process.env.MICHI_DATA_DIR = dataDir;
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_DISABLE_MULTI_MODEL;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws-a', name: 'Project', created_at: 1, updated_at: 1, active_tree_id: 'tree-a', owner_user_id: null } as never);
    saveTree({ id: 'tree-a', workspace_id: 'ws-a', root_node_id: 'n-a', last_active_at: 1, created_at: 1 } as never);
    saveNode({
      id: 'n-a', workspace_id: 'ws-a', tree_id: 'tree-a', parent_node_id: null,
      kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1,
    } as never);
  });

  afterEach(() => {
    closeDb();
    for (const [key, value] of [['MICHI_CLOUD', saved.cloud], ['MICHI_DATA_DIR', saved.dataDir], ['MICHI_DISABLE_MULTI_MODEL', saved.killSwitch]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const slotCallbacks = { onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null, onAskUser: async () => null };

  async function mcpTools(t: any, binding: { nodeId: string | null; workspaceId: string | null }, extra: Record<string, unknown> = {}, sessionId = 'n-a') {
    const slot = new McpSlotRegistry().create(sessionId, '/tmp', null, { ...slotCallbacks, ...extra } as never, binding);
    const server = buildMcpServerForSlot(slot);
    const client = new Client({ name: 'multi-model-tools', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(a);
    await client.connect(b);
    const tools = client.getServerCapabilities()?.tools ? (await client.listTools()).tools : [];
    return { client, tools };
  }

  test('MCP chat slots serve both, bound to the slot\'s node, session and turn', async (t) => {
    const port = recordingPort();
    configureMultiModelTools(port);
    const turn = { turnId: 'turn-7', assistantId: 'asst-7' };
    const { client, tools } = await mcpTools(t, { nodeId: 'n-a', workspaceId: 'ws-a' }, {
      owner: chatOwner('n-a'), getActivePageTurnAttribution: () => turn,
    });
    for (const name of NAMES) assert.ok(tools.some((tool) => tool.name === name), name);
    assert.deepEqual(tools.find((tool) => tool.name === LIST_READY_MODELS_TOOL)?.annotations,
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    assert.equal(tools.find((tool) => tool.name === PROPOSE_MULTI_MODEL_PLAN_TOOL)?.annotations?.readOnlyHint, false);

    const listed: any = await client.callTool({ name: LIST_READY_MODELS_TOOL, arguments: {} });
    assert.deepEqual(JSON.parse(listed.content[0].text), READY);
    const args = {
      title: 'Compare',
      threads: [{ runtime: 'codex', context: 'fork', prompt: 'Answer it.' }],
      reviewRounds: 1,
    };
    const proposed: any = await client.callTool({ name: PROPOSE_MULTI_MODEL_PLAN_TOOL, arguments: args });
    assert.deepEqual(JSON.parse(proposed.content[0].text), PROPOSAL);
    assert.deepEqual(port.proposals[0].args, args);
    assert.ok(port.proposals[0].signal instanceof AbortSignal, 'the call\'s signal reaches the port');
    for (const caller of [port.lists[0], port.proposals[0].caller]) {
      assert.deepEqual(caller, {
        ownerUserId: null, workspaceId: 'ws-a', nodeId: 'n-a', runtimeSessionId: 'n-a', turn,
        isAgentRun: false, assistant: false, maintenance: false,
      });
    }

    const invalid: any = await client.callTool({ name: PROPOSE_MULTI_MODEL_PLAN_TOOL, arguments: { ...args, reviewRounds: 3 } });
    assert.equal(invalid.isError, true);
    assert.equal(port.proposals.length, 1, 'the schema refuses reviewRounds 3 before the port');
  });

  test('Agent Run, assistant, fenced and maintenance slots never get them', async (t) => {
    const run = await mcpTools(t, { nodeId: null, workspaceId: 'ws-a' }, { owner: runOwner('run-1', 'attempt-1') }, 'run-attempt');
    const assistant = ensureAssistant();
    const home = await mcpTools(t, { nodeId: assistant.nodeId, workspaceId: assistant.workspaceId },
      { owner: chatOwner(assistant.nodeId), restricted: true, isServing: () => true }, assistant.nodeId);
    const fenced = await mcpTools(t, { nodeId: 'n-a', workspaceId: 'ws-a' }, { owner: chatOwner('n-a'), restricted: true });
    const maintenance = await mcpTools(t, { nodeId: 'n-a', workspaceId: 'ws-a' }, { owner: chatOwner('n-a'), maintenance: true });
    for (const [kind, { tools }] of Object.entries({ run, home, fenced, maintenance })) {
      for (const name of NAMES) assert.ok(!tools.some((tool) => tool.name === name), `${kind}: ${name}`);
    }
    assert.ok(home.tools.length > 0, 'the assistant catalog is served');
  });

  test('the kill switch removes them from MCP chat slots', async (t) => {
    process.env.MICHI_DISABLE_MULTI_MODEL = '1';
    const { tools } = await mcpTools(t, { nodeId: 'n-a', workspaceId: 'ws-a' }, { owner: chatOwner('n-a') });
    assert.ok(tools.length > 0);
    for (const name of NAMES) assert.ok(!tools.some((tool) => tool.name === name), name);
  });

  async function piTools(owner: unknown, extra: Record<string, unknown> = {}) {
    configureRuntimeDeps({
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null } as any,
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined } as any,
      dataDir,
    });
    const { Type } = await loadPiTypebox();
    try {
      return buildPiTools({
        bridge: {} as any, cwd: '/tmp', parentChatId: 'session-a', workspaceId: 'ws-a', enableFollowUps: false,
        imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set<string>(), Type,
        ownerUserId: 'alice', owner, ...extra,
      } as any);
    } finally {
      __resetRuntimeDeps();
    }
  }

  test('Pi chat threads get both, sequential, bound to the thread; the purpose field never reaches the port', async () => {
    const port = recordingPort();
    configureMultiModelTools(port);
    const turn = { turnId: 'turn-9', assistantId: 'asst-9' };
    const tools = await piTools(chatOwner('n-a'), { getActivePageTurnAttribution: () => turn });
    const list = tools.find((tool: any) => tool.name === LIST_READY_MODELS_TOOL);
    const propose = tools.find((tool: any) => tool.name === PROPOSE_MULTI_MODEL_PLAN_TOOL);
    assert.ok(list && propose);
    assert.deepEqual([list.label, list.executionMode, propose.label, propose.executionMode],
      ['List ready models', 'sequential', 'Propose multi-model plan', 'sequential']);

    const signal = new AbortController().signal;
    const result = await propose.execute('call-1', { __tool_use_purpose: 'ask others', title: 'Compare', threads: [] }, signal);
    assert.deepEqual(JSON.parse(result.content[0].text), PROPOSAL);
    assert.deepEqual(result.details, { content: result.content });
    assert.deepEqual(port.proposals[0].args, { title: 'Compare', threads: [] });
    assert.equal(port.proposals[0].signal, signal);
    assert.deepEqual(port.proposals[0].caller, {
      ownerUserId: 'alice', workspaceId: 'ws-a', nodeId: 'n-a', runtimeSessionId: 'session-a', turn,
      isAgentRun: false, assistant: false, maintenance: false,
    });
    assert.deepEqual(JSON.parse((await list.execute('call-2', {})).content[0].text), READY);
  });

  test('Pi Agent Runs, maintenance batches and the assistant profile get neither', async () => {
    const assistant = ensureAssistant();
    const catalogs = {
      run: await piTools(runOwner('run-1', 'attempt-1')),
      maintenance: await piTools(chatOwner('n-a'), { toolProfile: { maintenance: true } }),
      assistant: await piTools(chatOwner(assistant.nodeId), { workspaceId: assistant.workspaceId, toolProfile: { assistant: true } }),
    };
    assert.ok(catalogs.assistant.length > 0, 'the assistant profile gets its own catalog');
    for (const [kind, tools] of Object.entries(catalogs)) {
      for (const name of NAMES) assert.ok(!tools.some((tool: any) => tool.name === name), `${kind}: ${name}`);
    }
  });
});
