import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Ajv from 'ajv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveShowImage } from 'michi-runtime/internal/core/showImage';
import { McpSlotRegistry, buildMcpServerForSlot } from '../src/services/mcpServer';
import { buildPiTools } from '../src/agents/pi/piTools';
import { loadPiAi, loadPiTypebox } from '../src/agents/pi/piAi';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { AGENT_RUN_TOOL_NAMES } from '../src/agents/runToolBridge';
import { chatOwner, runOwner } from './helpers/owners';

const callbacks = { onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null };
const store = { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null };
const baseCfg = { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined };
async function connect(t: any, supplied: Record<string, unknown> = {}) {
  const slot = new McpSlotRegistry().create('catalog', '/tmp', null, { ...callbacks, ...supplied } as any);
  const server = buildMcpServerForSlot(slot);
  const client = new Client({ name: 'catalog-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(a); await client.connect(b);
  return client;
}
async function catalog(t: any, supplied: Record<string, unknown> = {}) {
  const client = await connect(t, supplied);
  return client.getServerCapabilities()?.tools ? (await client.listTools()).tools : [];
}
// Canonicalize equivalent native encodings while retaining all constraints.
function normalize(value: any): any {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (['$schema', '__tool_use_purpose', '~optional'].includes(key)) continue;
    if (key === 'required') {
      const required = (item as string[]).filter(name => name !== '__tool_use_purpose').sort();
      if (required.length) out.required = required;
    } else out[key] = normalize(item);
  }
  if (out.additionalProperties && typeof out.additionalProperties === 'object' && !Object.keys(out.additionalProperties).length) out.additionalProperties = true;
  if (out.anyOf?.every((entry: any) => typeof entry.const === 'string')) {
    out.type = 'string'; out.enum = out.anyOf.map((entry: any) => entry.const); delete out.anyOf;
  }
  if (out.const !== undefined && !out.type) out.type = typeof out.const === 'number' ? 'integer' : typeof out.const;
  // Zod emits these representable integer bounds; TypeBox uses integer itself.
  if (out.type === 'integer' && out.maximum === Number.MAX_SAFE_INTEGER) delete out.maximum;
  if (out.type === 'integer' && out.minimum === Number.MIN_SAFE_INTEGER) delete out.minimum;
  return out;
}

test('real SDK catalogs and real TypeBox schemas share navigation, Agent Run and result contracts', async t => {
  configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: '/tmp/mcp-parity',
    globalContext: { listThreads: () => ({ status: 'ok', text: '' }), searchMessages: () => ({ status: 'ok', text: '' }), readNode: () => ({ status: 'ok', text: '' }), readNodeOverview: () => ({ status: 'ok', text: '' }) } });
  t.after(() => __resetRuntimeDeps());
  const pi: any = await loadPiAi();
  const owner = runOwner('run-fixture', 'attempt-fixture');
  const invoker = { invoke: async () => ({ ok: true }) } as any;
  const profile = { allowedToolNames: ['submit_agent_result'], runWorkerTools: { submitAgentResult: () => ({}) } };
  const commonOpts = { bridge: {} as any, cwd: '/tmp', parentChatId: 'p', workspaceId: null, enableFollowUps: true,
    imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set<string>(), Type: (await loadPiTypebox()).Type, agentRunTools: invoker,
    owner: chatOwner('node-fixture') };
  const piTools = [...buildPiTools(commonOpts), ...buildPiTools({ ...commonOpts, owner, toolProfile: profile } as any)];
  const mcpTools = await catalog(t, { agentRuns: invoker });
  const runTools = await catalog(t, { owner, onSubmitAgentResult: () => ({}) });
  for (const name of ['list_threads', 'search_messages', 'read_node', 'read_node_overview', 'read_conversation_updates', 'report_conversation_no_change', 'inspect_pane', 'read_pane_output', 'list_panes', 'wait_pane', 'send_to_thread', 'list_tasks', 'open_task_database', 'list_artifacts', 'search_artifacts', 'delete_artifact', ...AGENT_RUN_TOOL_NAMES, 'submit_agent_result']) {
    const mcp = [...mcpTools, ...runTools].find(tool => tool.name === name)!;
    const tool = piTools.find(tool => tool.name === name)!;
    assert.ok(mcp, `${name} missing in real MCP listTools`); assert.ok(tool, `${name} missing in Pi tools`);
    assert.equal(tool.description, mcp.description, name);
    assert.deepEqual(normalize(JSON.parse(JSON.stringify(tool.parameters))), normalize(mcp.inputSchema), name);
  }
  const search = mcpTools.find(tool => tool.name === 'search_messages')!;
  const ajv = new Ajv({ strict: false }); const validate = ajv.compile(search.inputSchema);
  assert.equal(validate({ query: 'x', limit: 50 }), true);
  for (const limit of [0, 1.5, 51]) assert.equal(validate({ query: 'x', limit }), false);
  const piSearch = piTools.find(tool => tool.name === 'search_messages');
  const piArgs = (limit: unknown) => pi.validateToolArguments(piSearch, { name: piSearch.name, arguments: { query: 'x', limit, __tool_use_purpose: 'search' } });
  for (const limit of [0, 51]) assert.throws(() => piArgs(limit));
  // Pi 1.5 (pi-schema) coerces loose arguments before validating: a fractional
  // integer is truncated instead of rejected, so it can never exceed the bounds.
  assert.equal(piArgs(1.5).limit, 1);
});

test('unsupported optional MCP capabilities are absent even when explicitly allowlisted', async t => {
  const tools = await catalog(t, { exposedToolNames: new Set(['show_image', 'ask_user']) });
  for (const name of ['show_image', 'ask_user']) assert.equal(tools.some(tool => tool.name === name), false, name);
  const enabled = await catalog(t, { exposedToolNames: new Set(['show_image', 'ask_user']),
    onShowImage: () => ({ error: 'fixture' }), onAskUser: async () => ({}) });
  assert.deepEqual(enabled.map(tool => tool.name).sort(), ['ask_user', 'show_image']);
});

test('invalid arguments get the same text from the SDK McpServer as from the host', async t => {
  const client = await connect(t);
  const invalid: any = await client.callTool({ name: 'save_artifact', arguments: { name: 'bad', body: 7 } });
  assert.equal(invalid.isError, true);
  // mcpMountEndToEnd's text for the host: zod's issues as JSON, as with MCP SDK 1.29
  // (1.32's McpServer would say "Invalid input: expected string, received number at body").
  assert.equal(invalid.content.map((part: any) => part.text).join(''), 'MCP error -32602: Input validation error: Invalid arguments for tool save_artifact: '
    + JSON.stringify([{ expected: 'string', code: 'invalid_type', path: ['body'], message: 'Invalid input: expected string, received number' }], null, 2));
});

test('side-effect tools answer the model the same on MCP and Pi', async t => {
  configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: '/tmp/mcp-parity' });
  t.after(() => __resetRuntimeDeps());
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'side-effect-parity-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'shot.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let stored = true;
  const branches = (topics: Array<{ title: string; prompt: string }>) => topics.map((topic, i) => ({ ...topic, chatId: `child-${i}`, nodeId: `child-${i}` }));
  const artifact = (name: string) => stored ? { id: 'ctx-1', name, filePath: `/tmp/${name}.md`, size: 4 } : null;
  const client = await connect(t, {
    onSpawnBranches: async (topics: any) => branches(topics),
    onSaveArtifact: (name: string) => artifact(name),
    onUpdateArtifact: (name: string) => artifact(name),
    onShowImage: (input: string) => {
      const r = resolveShowImage(cwd, input);
      return r.ok ? { relPath: r.relPath, mimeType: r.mimeType, size: r.size } : { error: r.error };
    },
  });
  const piTools = buildPiTools({
    bridge: {
      spawnBranches: async (args: any) => branches(args.topics),
      saveContext: (args: any) => artifact(args.name),
      updateContext: (args: any) => artifact(args.name),
    } as any,
    cwd, parentChatId: 'p', workspaceId: null, enableFollowUps: true, imageQuota: { usedBytes: 0, limitBytes: 1 } as any,
    seenPaths: new Set<string>(), Type: (await loadPiTypebox()).Type, owner: chatOwner('node-fixture'),
  });
  const text = (result: any) => result.content.map((part: any) => part.text).join('');
  const viaPi = async (name: string, args: Record<string, unknown>) => {
    try { return text(await piTools.find((tool: any) => tool.name === name).execute('call-1', args)); }
    catch (error) { return (error as Error).message; }
  };
  const viaMcp = async (name: string, args: Record<string, unknown>) => text(await client.callTool({ name, arguments: args }));
  const calls: Array<[string, Record<string, unknown>]> = [
    ['spawn_branches', { topics: [{ title: 'A', prompt: 'Explore A' }, { title: 'B', prompt: 'Explore B' }] }],
    ['spawn_branches', { topics: [{ title: 'A', prompt: 'Explore A' }] }],
    ['save_artifact', { name: ' notes ', body: 'text' }],
    ['save_artifact', { name: 'notes', body: 'text', path: 'notes.md' }],
    ['update_artifact', { name: ' notes ', body: 'more' }],
    ['show_image', { path: 'shot.png' }],
    ['show_image', { path: 'missing.png' }],
  ];
  for (const [name, args] of calls) assert.equal(await viaPi(name, args), await viaMcp(name, args), `${name} ${JSON.stringify(args)}`);
  stored = false;
  for (const [name, args] of [['save_artifact', { name: 'notes', body: 'text' }], ['update_artifact', { name: 'gone', body: 'more' }]] as const) {
    assert.equal(await viaPi(name, args), await viaMcp(name, args), `${name} when the bridge refuses`);
  }
});
