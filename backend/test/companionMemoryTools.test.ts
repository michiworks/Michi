import './isolatedConfigDir';
import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * V's Michi Memory tools (DESIGN D2, D4, D10): the user's conversation with
 * the agent (V) has the ordinary chats' four memory tools on every runtime
 * (its MCP slot, loaded up front with their hints, and Pi), with the user
 * scope as its own: saves apply everywhere, this_workspace is not available,
 * a search reads every workspace recall may, and V's node is the source. A
 * check-in never has them. V's conversation setting holds: Off is a
 * temporary chat (memory tools refuse, other conversations are not read),
 * Use only saves nothing. In a V turn that holds check-in or collector
 * material only what the user typed is saved, and only what it names is
 * forgotten. No prompt in Ask mode.
 * Temp MICHI_DATA_DIR per test; no runtime, CLI or network.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MemoryRecord } from 'michi-shared';
import { MEMORY_TOOL_NAMES } from '../src/agents/memoryToolNames';
import { resolveChatPolicy } from '../src/agents/permissionPolicy';
import { buildPiTools } from '../src/agents/pi/piTools';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { CHECKIN_TOOL_NAMES, MAIN_TOOL_NAMES, assistantToolProfile } from '../src/assistant/policy';
import { ensureAssistant } from '../src/assistant/store';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { TEMPORARY_CHAT_MESSAGE } from '../src/services/globalContext';
import { McpSlotRegistry, buildMcpServerForSlot, mountMcp, type McpSlot } from '../src/services/mcpServer';
import { createMemory, listMemories } from '../src/services/memory/memoryService';
import { storedMemoryByRowId } from '../src/services/memory/memoryRepository';
import { parseRef } from '../src/services/memory/memoryRefs';
import { indexTurn } from '../src/services/memory/recallIndex';
import { recordTypedText } from '../src/services/memory/typedText';
import { carriedCompanionTaintOf, clearCarriedCompanionTaint, recordCompanionTaint, recordUntrustedSource } from '../src/services/turnTrust';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import { activeTurnRow, makeCheckinNode } from './helpers/checkinNodes';
import { registerLiveSession } from './helpers/liveSession';
import { chatOwner } from './helpers/owners';

/** The desktop's memory owner (memoryOwner.ts): the assistant exists only there. */
const OWNER = 'local-user';

let tmpDir: string;
let v: ReturnType<typeof ensureAssistant>;
let turnSerial = 0;

function slotFor(nodeId: string, workspaceId: string, extra: Record<string, unknown> = {}, registry = new McpSlotRegistry()): McpSlot {
  return registry.create(nodeId, '/tmp', null, {
    owner: chatOwner(nodeId),
    onSpawnBranches: async () => [],
    onSaveArtifact: () => null,
    onUpdateArtifact: () => null,
    onShowImage: () => ({ error: 'unsupported in test' }),
    onAskUser: async () => null,
    ...extra,
  } as never, { nodeId, workspaceId });
}

type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>;
const registered = (slot: McpSlot): Registered => (buildMcpServerForSlot(slot) as any)._registeredTools;

/** One MCP call on V's slot: its text, and its JSON when it is JSON. */
async function call(name: string, args: Record<string, unknown> = {}, slot = slotFor(v.nodeId, v.workspaceId)) {
  const tool = registered(slot)[name];
  assert.ok(tool, `${name} is registered`);
  const result = await tool.handler(args, {});
  const text = result.content.map((part) => part.text).join('');
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* an error result is text */ }
  return { text, json, isError: result.isError === true };
}

/** A running turn on V, as chatHub's durable turn row; returns its id. */
function runningTurn(nodeId = v.nodeId): string {
  getDb().prepare("UPDATE turns SET status = 'completed' WHERE node_id = ?").run(nodeId);
  const turnId = `turn-${++turnSerial}`;
  activeTurnRow(nodeId, turnId, `a-${nodeId}-${turnId}`);
  return turnId;
}

function byRef(ref: string): MemoryRecord {
  const parsed = parseRef(ref);
  assert.ok(parsed?.kind === 'memory', ref);
  const stored = storedMemoryByRowId(OWNER, parsed.rowId);
  assert.ok(stored, ref);
  return stored.record;
}

function memories(): MemoryRecord[] {
  return listMemories({ ownerUserId: OWNER }, { status: ['active'], limit: 200 }).items;
}

/** Pi's tools for an assistant node, with the given profile. */
function piTools(nodeId: string, toolProfile = assistantToolProfile('main')): any[] {
  const Type: any = new Proxy({}, { get: () => (..._args: any[]) => ({}) });
  configureRuntimeDeps({
    dataDir: path.join(tmpDir, 'runtime'),
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
    agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: '', modelByRuntime: {}, reasoningByRuntime: {} }) as never,
      resolveModel: () => '', resolveReasoning: () => undefined },
  });
  try {
    return buildPiTools({
      bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any,
      cwd: '/tmp', parentChatId: nodeId, workspaceId: v.workspaceId, enableFollowUps: false,
      imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set(), Type,
      owner: chatOwner(nodeId), toolProfile,
    });
  } finally {
    __resetRuntimeDeps();
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-memory-tools-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb(); enableSyntheticCompanionSources();
  v = ensureAssistant();
  saveWorkspace({ id: 'ws-1', name: 'Project', cwd: '/tmp/ws-1', created_at: 1, updated_at: 1, settings: null });
  saveTree({ id: 't-n-1', workspace_id: 'ws-1', root_node_id: 'n-1', last_active_at: 1, created_at: 1 });
  saveNode({ id: 'n-1', workspace_id: 'ws-1', tree_id: 't-n-1', kind: 'chat', title: 'Release notes', status: 'idle',
    minimized: 0, spawned_by_agent: 0, acp_session_id: 'n-1', runtime_id: 'claude', created_at: 1 });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('V\'s catalog (D2)', () => {
  test('V has the four memory tools on its MCP slot and on Pi; a check-in has none, whatever its slot', () => {
    for (const name of MEMORY_TOOL_NAMES) {
      assert.ok(MAIN_TOOL_NAMES.includes(name), `${name} is V's`);
      assert.ok(!CHECKIN_TOOL_NAMES.includes(name), `${name} is never a check-in's`);
    }
    const vMcp = Object.keys(registered(slotFor(v.nodeId, v.workspaceId)));
    for (const name of MEMORY_TOOL_NAMES) assert.ok(vMcp.includes(name), `${name} on V's slot`);

    const s = makeCheckinNode(v.workspaceId);
    for (const slot of [slotFor(s, v.workspaceId), slotFor(s, v.workspaceId, { restricted: true, exposedToolNames: new Set(CHECKIN_TOOL_NAMES) })]) {
      assert.deepEqual(Object.keys(registered(slot)).filter((name) => name.startsWith('memory_')), []);
    }

    const vPi = piTools(v.nodeId);
    for (const name of MEMORY_TOOL_NAMES) {
      const tool = vPi.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} on Pi`);
      assert.equal(tool.executionMode, name === 'memory_search' ? undefined : 'sequential', name);
    }
    assert.equal(vPi.filter((tool) => tool.name === 'memory_save').length, 1, 'once: V\'s own, not the ordinary chat\'s');
    assert.deepEqual(piTools(s, assistantToolProfile('checkin')).filter((tool: any) => tool.name.startsWith('memory_')), []);
  });

  test('over Michi\'s MCP host, V\'s memory tools carry their hints and load up front', async (t) => {
    const registry = new McpSlotRegistry();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    mountMcp(router, registry);
    app.use('/api', router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    // As ClaudeSession opens V's slot: open profile, Claude Code's key for a tool to load up front.
    const slot = slotFor(v.nodeId, v.workspaceId, { upFrontToolMeta: { 'anthropic/alwaysLoad': true } }, registry);
    const client = new Client({ name: 'companion-memory', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/${slot.slotId}`)));
    let listed: Awaited<ReturnType<Client['listTools']>>['tools'];
    try {
      listed = (await client.listTools()).tools;
    } finally {
      await client.close();
    }
    for (const name of MEMORY_TOOL_NAMES) {
      const tool = listed.find((candidate) => candidate.name === name);
      assert.ok(tool, name);
      assert.deepEqual(tool._meta, { 'anthropic/alwaysLoad': true }, `${name} loads up front`);
      assert.equal(tool.annotations?.openWorldHint, false, name);
    }
    assert.equal(listed.find((tool) => tool.name === 'memory_search')?.annotations?.readOnlyHint, true);
    assert.equal(listed.find((tool) => tool.name === 'memory_delete')?.annotations?.destructiveHint, true);
    assert.equal(listed.find((tool) => tool.name === 'list_workspaces')?._meta, undefined, 'only the memory tools');
  });

  test('V\'s saves are the user\'s, with V\'s node as their source; this_workspace saves everywhere and says so', async () => {
    const turnId = runningTurn();
    // A convention would go to the thread's workspace; V has none, so it applies everywhere.
    const saved = await call('memory_save', { body: 'Release notes are written in English.', kind: 'convention', userAsked: true });
    assert.equal(saved.json.status, 'saved', saved.text);
    const record = byRef(saved.json.ref);
    assert.deepEqual(record.scope, { kind: 'user' });
    assert.deepEqual(record.source, { nodeId: v.nodeId, turnId });
    assert.equal(record.origin, 'explicit');

    // A project convention asked for in V is still saved as the user's (the eval's rem-0065 shape), never refused.
    const project = await call('memory_save', { body: 'In the Michi repo, use pnpm.', kind: 'convention', appliesTo: 'this_workspace', userAsked: true });
    assert.equal(project.isError, false, project.text);
    assert.equal(project.json.status, 'saved', project.text);
    assert.match(String(project.json.note), /^This conversation is in no workspace, so the memory applies everywhere\. Saved to Michi Memory\./);
    assert.deepEqual(byRef(project.json.ref).scope, { kind: 'user' });
    assert.equal(byRef(project.json.ref).origin, 'explicit');
    assert.equal(memories().length, 2);
    assert.equal(memories().some((memory) => memory.scope.kind === 'workspace'), false, 'the assistant\'s workspace is never a memory scope');
  });

  test('a search from V reads every workspace recall may by default, each result labelled with its workspace', async () => {
    runningTurn();
    createMemory({ ownerUserId: OWNER }, { scope: { kind: 'workspace', workspaceId: 'ws-1' }, kind: 'decision', body: 'Releases ship on Thursdays.',
      status: 'active', origin: 'explicit' });
    createMemory({ ownerUserId: OWNER }, { scope: { kind: 'user' }, kind: 'preference', body: 'Write release summaries in bullet points.',
      status: 'active', origin: 'explicit' });
    const at = Date.now() - 86_400_000;
    assert.equal(indexTurn({ ownerUserId: null, nodeId: 'n-1', turnId: 'past-1', humanOrigin: true, userText: 'When do releases go out?',
      assistantText: 'Releases go out on Thursdays.', completedAt: at, userMessageAt: at }), true);
    const found = await call('memory_search', { query: 'releases' });
    const results = found.json.results as Array<Record<string, unknown>>;
    assert.ok(results.some((result) => result.type === 'memory' && result.appliesTo === 'another_workspace' && result.workspace === 'Project'), found.text);
    assert.ok(results.some((result) => result.type === 'memory' && result.appliesTo === 'everywhere'), found.text);
    assert.ok(results.some((result) => result.type === 'conversation' && result.workspace === 'Project'), found.text);
    assert.doesNotMatch(found.text, /Nothing matched in this workspace/);
  });

  test('Ask mode runs V\'s memory tools without a prompt, also in a turn that holds check-in material (D10)', () => {
    configureRuntimeDeps({
      dataDir: path.join(tmpDir, 'runtime'),
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }) as never,
        resolveModel: () => '', resolveReasoning: () => undefined },
      chatPermissions: { getMode: () => 'ask', hasGrant: () => false, grant: () => {} },
    });
    try {
      const owner = chatOwner(v.nodeId);
      const turnId = runningTurn();
      const names = (tool: string) => [tool, `mcp____michi_internal____${tool}`, `@michi/${tool}`];
      for (const tool of MEMORY_TOOL_NAMES) for (const name of names(tool)) assert.equal(resolveChatPolicy(owner, null, name, true, 'ask'), 'allow', name);
      recordCompanionTaint({ nodeId: v.nodeId, turnId }, 'companion_read', 'checkin');
      for (const tool of MEMORY_TOOL_NAMES) for (const name of names(tool)) assert.equal(resolveChatPolicy(owner, null, name, true, 'ask'), 'allow', `tainted ${name}`);
    } finally {
      __resetRuntimeDeps();
    }
  });
});

describe('V\'s conversation setting (D2)', () => {
  test('Off is a temporary chat: the memory tools refuse and no other conversation is read', async () => {
    runningTurn();
    getDb().prepare("UPDATE nodes SET memory_mode = 'off' WHERE id = ?").run(v.nodeId);
    for (const name of MEMORY_TOOL_NAMES) {
      const refused = await call(name, name === 'memory_save' ? { body: 'Reply in Chinese.', kind: 'preference', userAsked: true }
        : name === 'memory_search' ? { query: 'Chinese' } : { ref: 'm:1v1', body: 'x' });
      assert.match(refused.text, /^MEMORY_OFF_HERE/, name);
    }
    for (const [name, args] of [
      ['list_threads', { workspaceId: 'ws-1' }], ['search_messages', { query: 'release' }], ['read_node', { nodeId: 'n-1' }],
      ['read_node_overview', { nodeId: 'n-1' }], ['inspect_pane', { nodeId: 'n-1' }], ['read_pane_output', { paneId: 'node:n-1' }],
      ['wait_pane', { nodeId: 'n-1', until: 'changed', cursor: 'c' }], ['read_conversation_updates', { workspaceId: 'ws-1', after: 0 }],
    ] as const) {
      assert.equal((await call(name, args)).text, TEMPORARY_CHAT_MESSAGE, `${name} ${JSON.stringify(args)}`);
    }
    assert.notEqual((await call('read_node', { nodeId: v.nodeId })).text, TEMPORARY_CHAT_MESSAGE, 'its own transcript is no other conversation');
    assert.notEqual((await call('list_workspaces')).text, TEMPORARY_CHAT_MESSAGE, 'workspaces are no conversation');
    assert.equal(memories().length, 0);

    // On Pi too: the same catalog.
    const pi = piTools(v.nodeId);
    const run = async (name: string, args: Record<string, unknown>) =>
      (await pi.find((tool: any) => tool.name === name).execute('call', { __tool_use_purpose: 'test', ...args })).content[0].text as string;
    assert.equal(await run('list_threads', { workspaceId: 'ws-1' }), TEMPORARY_CHAT_MESSAGE);
    assert.match(await run('memory_save', { body: 'Reply in Chinese.', kind: 'preference', userAsked: true }), /^MEMORY_OFF_HERE/);
  });

  test('Use only reads, but saves and corrects nothing', async () => {
    runningTurn();
    const kept = createMemory({ ownerUserId: OWNER }, { scope: { kind: 'user' }, kind: 'preference', body: 'Reply in Chinese.', status: 'active', origin: 'explicit' });
    getDb().prepare("UPDATE nodes SET memory_mode = 'use_only' WHERE id = ?").run(v.nodeId);
    assert.match((await call('memory_save', { body: 'Prefer short answers.', kind: 'preference', userAsked: true })).text, /^NOT_SAVED_HERE/);
    assert.match((await call('memory_update', { ref: kept.id, body: 'Reply in Japanese.' })).text, /^NOT_SAVED_HERE/);
    assert.equal((await call('memory_search', { query: 'Chinese' })).json.count, 1);
    assert.notEqual((await call('list_threads', { workspaceId: 'ws-1' })).text, TEMPORARY_CHAT_MESSAGE);
    assert.deepEqual(memories().map((memory) => memory.body), ['Reply in Chinese.']);
  });
});

describe('check-in and collector material in a V turn (D4)', () => {
  test('a save or a correction is made only when what the user typed backs it; other outside content stays provenance', async () => {
    const turnId = runningTurn();
    recordCompanionTaint({ nodeId: v.nodeId, turnId }, 'companion_items', 'collector');
    const fromItems = await call('memory_save', { body: 'The user\'s manager is Dana Park.', kind: 'fact', userAsked: false });
    assert.equal(fromItems.isError, false);
    assert.deepEqual([fromItems.json.status, fromItems.json.reason], ['not_saved', 'companion_material'], fromItems.text);
    assert.equal(memories().length, 0);

    recordTypedText(v.nodeId, turnId, 'Please remember that I prefer short answers.');
    const typed = await call('memory_save', { body: 'The user prefers short answers.', kind: 'preference', userAsked: true });
    assert.equal(typed.json.status, 'saved', typed.text);
    assert.equal(byRef(typed.json.ref).sourceRisk, null, 'the user\'s own words');
    assert.equal((await call('memory_update', { ref: typed.json.ref, body: 'The user prefers answers in bullet points.' })).json.reason,
      'companion_material');
    assert.equal(byRef(typed.json.ref).status, 'active', 'unchanged');

    // A turn that read only the web keeps the ordinary rule: saved, marked untrusted.
    const webTurn = runningTurn();
    recordUntrustedSource({ nodeId: v.nodeId, turnId: webTurn }, { tool: 'WebFetch', runtimeId: 'claude' });
    const fromWeb = await call('memory_save', { body: 'The office moved to Shibuya.', kind: 'fact', userAsked: false });
    assert.equal(fromWeb.json.status, 'saved', fromWeb.text);
    assert.equal(byRef(fromWeb.json.ref).sourceRisk, 'untrusted');
  });

  test('once V\'s session took such material in, a memory is forgotten only when the user\'s own words in that message name it, and nothing in a turn that also read the web', async (t) => {
    registerLiveSession(v.nodeId);
    t.after(() => { clearCarriedCompanionTaint(v.nodeId); clearAllSessions(); });
    const fact = (body: string) => createMemory({ ownerUserId: OWNER }, { scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'explicit' });
    const acme = fact('The user is interviewing at Acme.');
    const vegetarian = fact('The user is vegetarian.');
    const peanuts = fact('The user is allergic to peanuts.');
    const chinese = fact('用户吃素。');
    recordCompanionTaint({ nodeId: v.nodeId, turnId: runningTurn() }, 'companion_items', 'collector');
    /** The user's next message, on the same session: the message route records what the session took in on it. */
    const message = (typed: string) => {
      const turnId = runningTurn();
      assert.equal(carriedCompanionTaintOf(v.nodeId), 'collector');
      recordCompanionTaint({ nodeId: v.nodeId, turnId }, 'companion_earlier_turn', 'collector');
      recordTypedText(v.nodeId, turnId, typed);
      return turnId;
    };

    message('yes, forget it');
    const refused = await call('memory_delete', { ref: acme.id });
    assert.equal(refused.isError, true);
    assert.equal(refused.text, 'NOT_ALLOWED: this conversation holds check-in material, so Michi deletes here only what the user\'s own '
      + 'words in this message name. The user can delete it in Settings → Memory.');
    message('Forget that I\'m vegetarian');
    assert.match((await call('memory_delete', { ref: peanuts.id })).text, /^NOT_ALLOWED: this conversation holds check-in material/,
      'a memory their words do not name');
    assert.equal((await call('memory_delete', { ref: vegetarian.id })).json.status, 'deleted');
    message('忘掉我吃素这件事');
    assert.equal((await call('memory_delete', { ref: chinese.id })).json.status, 'deleted');

    // Words that name it do not lift v3's refusal in a turn that also read the web. A confirmation in the next message
    // would name nothing, so the refusal asks the user to say there what to forget, which then forgets it.
    const web = message('Forget that I am allergic to peanuts');
    recordUntrustedSource({ nodeId: v.nodeId, turnId: web }, { tool: 'WebFetch', runtimeId: 'claude' });
    assert.equal((await call('memory_delete', { ref: peanuts.id })).text, 'NOT_ALLOWED: this turn read content from outside the conversation '
      + '(web pages, shell output or another tool\'s results), so Michi deletes nothing in it. The user can say in their next message '
      + 'what to forget, or delete it in Settings → Memory.');
    assert.deepEqual(memories().map((memory) => memory.body).sort(), [acme.body, peanuts.body].sort());
    message('Forget that I am allergic to peanuts');
    assert.equal((await call('memory_delete', { ref: peanuts.id })).json.status, 'deleted');
    assert.deepEqual(memories().map((memory) => memory.body), [acme.body]);

    // Once the session no longer holds it (/clear, a compaction), an ordinary turn forgets as ever.
    clearCarriedCompanionTaint(v.nodeId);
    runningTurn();
    assert.equal((await call('memory_delete', { ref: acme.id })).json.status, 'deleted');
  });

  test('in such a turn, a past conversation is kept out of memory only when the user\'s words name what they said in it', async () => {
    const at = Date.now() - 86_400_000;
    assert.equal(indexTurn({ ownerUserId: null, nodeId: 'n-1', turnId: 'past-locker', humanOrigin: true, userText: 'My gym locker number is 418.',
      assistantText: 'Noted: locker 418.', completedAt: at, userMessageAt: at }), true);
    const turnId = runningTurn();
    recordCompanionTaint({ nodeId: v.nodeId, turnId }, 'companion_items', 'collector');
    const ref = (await call('memory_search', { query: 'locker' })).json.results.find((result: any) => result.type === 'conversation').ref;
    recordTypedText(v.nodeId, turnId, 'Forget that I\'m vegetarian');
    assert.match((await call('memory_delete', { ref })).text, /^NOT_ALLOWED: this conversation holds check-in material/);
    // A steer into the same turn is the user's words too.
    recordTypedText(v.nodeId, turnId, 'and my locker number');
    assert.equal((await call('memory_delete', { ref })).json.status, 'kept_out');
  });
});
