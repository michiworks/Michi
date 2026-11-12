import './isolatedConfigDir';
import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * Where the agent's own tools exist (DESIGN-v2 §2.3): V's catalog has all of
 * them but nothing_to_do, a check-in's (S, `n-cmph-…`) the hidden-turn ones
 * and nothing_to_do, on every runtime; ordinary chats get none. Claude,
 * Codex and Kiro reach Michi's tools through the conversation's MCP slot, Pi
 * through its own catalog. A profile that does not match the node's purpose
 * gets no tools at all. End to end through an MCP client and Pi's execute,
 * a card's payload keeps its fields through each runtime's schema. Temp
 * MICHI_DATA_DIR per test; no runtime, MCP server process or network.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ActivePageTurnAttribution } from '../src/agents/pageToolNames';
import { buildPiTools } from '../src/agents/pi/piTools';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import type { RuntimeToolProfile } from '../src/agents/types';
import { CHECKIN_TOOL_NAMES, COMPANION_OWN_TOOL_NAMES, MAIN_TOOL_NAMES, assistantToolProfile } from '../src/assistant/policy';
import { ensureAssistant } from '../src/assistant/store';
import { assistantToolsFor } from '../src/assistant/tools';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { McpSlotRegistry, buildMcpServerForSlot, type McpSlot } from '../src/services/mcpServer';
import { getCompanionSettings } from '../src/services/companion/settings';
import { setCompanionToolDeps } from '../src/services/companion/tools';
import { chatOwner } from './helpers/owners';
import { activeTurnRow, makeCheckinNode } from './helpers/checkinNodes';

const OWN = new Set<string>(COMPANION_OWN_TOOL_NAMES);
const CHECKIN = assistantToolProfile('checkin');
const MAIN_OWN = COMPANION_OWN_TOOL_NAMES.filter((name) => MAIN_TOOL_NAMES.includes(name));
const CHECKIN_OWN = COMPANION_OWN_TOOL_NAMES.filter((name) => CHECKIN_TOOL_NAMES.includes(name));
/** A slot as the runtimes open one; `extra` adds a closed profile's allow-list and the turn attribution. */
function slotFor(nodeId: string, workspaceId: string, extra: Record<string, unknown> = {}): McpSlot {
  return new McpSlotRegistry().create(nodeId, '/tmp', null, {
    onSpawnBranches: async () => [],
    onSaveArtifact: () => null,
    onUpdateArtifact: () => null,
    onShowImage: () => ({ error: 'unsupported in test' }),
    onAskUser: async () => null,
    ...extra,
  } as never, { nodeId, workspaceId });
}

const mcpToolNames = (slot: McpSlot) => Object.keys((buildMcpServerForSlot(slot) as any)._registeredTools as Record<string, unknown>);

/** Pi's tools for a chat: null `toolProfile` builds them without any profile. */
function piTools(nodeId: string, workspaceId: string, dataDir: string, toolProfile: RuntimeToolProfile | null,
  getActivePageTurnAttribution?: () => ActivePageTurnAttribution | null): any[] {
  const Type: any = new Proxy({}, { get: () => (..._args: any[]) => ({}) });
  const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any;
  configureRuntimeDeps({
    dataDir,
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
    agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: '', modelByRuntime: {}, reasoningByRuntime: {} }) as never,
      resolveModel: () => '', resolveReasoning: () => undefined },
  });
  try {
    return buildPiTools({
      bridge, cwd: '/tmp', parentChatId: nodeId, workspaceId, enableFollowUps: false,
      imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set(), Type,
      owner: chatOwner(nodeId), toolProfile: toolProfile ?? undefined, getActivePageTurnAttribution,
    });
  } finally {
    __resetRuntimeDeps();
  }
}

const textOf = (result: unknown) => ((result as { content?: Array<{ text?: string }> }).content ?? []).map((part) => part.text ?? '').join('');

describe('the agent\'s own tools, per runtime (DESIGN-v2 §2.3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-catalog-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    setCompanionToolDeps({});
  });

  afterEach(() => {
    setCompanionToolDeps({});
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('V has them all but nothing_to_do, a check-in the hidden-turn ones; an ordinary chat none, a mismatched profile nothing', () => {
    const v = ensureAssistant();
    const s = makeCheckinNode(v.workspaceId);
    saveWorkspace({ id: 'ws-1', name: 'Project', cwd: '/tmp/ws-1', created_at: 1, updated_at: 1, settings: null });
    saveTree({ id: 't-n-1', workspace_id: 'ws-1', root_node_id: 'n-1', last_active_at: 1, created_at: 1 });
    saveNode({ id: 'n-1', workspace_id: 'ws-1', tree_id: 't-n-1', kind: 'chat', title: 'Chat', status: 'idle',
      minimized: 0, spawned_by_agent: 0, acp_session_id: 'n-1', runtime_id: 'claude', created_at: 1 });
    const runtimeDir = path.join(tmpDir, 'runtime');

    assert.deepEqual(MAIN_OWN, COMPANION_OWN_TOOL_NAMES.filter((name) => name !== 'nothing_to_do'));
    assert.deepEqual(assistantToolsFor('main').filter((tool) => OWN.has(tool.name)).map((tool) => tool.name), MAIN_OWN);
    assert.deepEqual(assistantToolsFor('checkin').filter((tool) => OWN.has(tool.name)).map((tool) => tool.name), CHECKIN_OWN);
    // ask_user is the runtime's user channel (the MCP slot's, Pi's), not one of these.
    assert.deepEqual(assistantToolsFor('main').map((tool) => tool.name).sort(), MAIN_TOOL_NAMES.filter((name) => name !== 'ask_user').sort(), 'every V name has its tool');
    assert.deepEqual(assistantToolsFor('checkin').map((tool) => tool.name).sort(), [...CHECKIN_TOOL_NAMES].sort(), 'every check-in name has its tool');

    // Claude, Codex and Kiro: the conversation's MCP slot.
    const vMcp = mcpToolNames(slotFor(v.nodeId, v.workspaceId));
    assert.deepEqual(vMcp.filter((name) => OWN.has(name)).sort(), [...MAIN_OWN].sort());
    const sMcp = mcpToolNames(slotFor(s, v.workspaceId, { restricted: true, exposedToolNames: new Set(CHECKIN.allowedToolNames) }));
    assert.deepEqual(sMcp.sort(), [...CHECKIN_TOOL_NAMES].sort(), 'a check-in\'s slot is its allow-list, nothing more');
    for (const [label, slot] of [
      ['an ordinary chat', slotFor('n-1', 'ws-1')],
      ['an ordinary chat, asked for them', slotFor('n-1', 'ws-1', { restricted: true, exposedToolNames: new Set(CHECKIN_TOOL_NAMES) })],
    ] as const) {
      assert.deepEqual(mcpToolNames(slot).filter((name) => OWN.has(name)), [], `${label} (MCP)`);
    }

    // Pi: its own catalog.
    const vPi = piTools(v.nodeId, v.workspaceId, runtimeDir, assistantToolProfile('main')).map((tool) => tool.name as string);
    assert.deepEqual(vPi.filter((name) => OWN.has(name)).sort(), [...MAIN_OWN].sort());
    const sPi = piTools(s, v.workspaceId, runtimeDir, CHECKIN).map((tool) => tool.name as string);
    assert.deepEqual(sPi.sort(), [...CHECKIN_TOOL_NAMES].sort(), 'a check-in on Pi: its allow-list, no native tool, no ask_user');
    for (const [label, tools] of [
      ['an ordinary chat', piTools('n-1', 'ws-1', runtimeDir, null)],
      // §2.5: checkin with an open profile, main with the closed one: no tools at all.
      ['V with the closed profile', piTools(v.nodeId, v.workspaceId, runtimeDir, CHECKIN)],
      ['a check-in with the open profile', piTools(s, v.workspaceId, runtimeDir, assistantToolProfile('main'))],
      ['a check-in without a profile', piTools(s, v.workspaceId, runtimeDir, null)],
    ] as const) {
      const listed = tools.map((tool: any) => tool.name as string);
      if (label === 'an ordinary chat') assert.deepEqual(listed.filter((name) => OWN.has(name)), [], `${label} (Pi)`);
      else assert.deepEqual(listed, [], `${label} (Pi)`);
    }
  });

  test('through an MCP client: a check-in lists exactly its allow-list, a card\'s payload keeps its fields, and V\'s user turn renames', async (t) => {
    const v = ensureAssistant();
    const s = makeCheckinNode(v.workspaceId);
    let current: ActivePageTurnAttribution | null = null;
    const open = async (slot: McpSlot) => {
      const server = buildMcpServerForSlot(slot);
      const client = new Client({ name: 'companion-fixture', version: '1' });
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      t.after(async () => { await client.close(); await server.close(); });
      await server.connect(serverSide);
      await client.connect(clientSide);
      return client;
    };

    const checkin = await open(slotFor(s, v.workspaceId, {
      restricted: true, exposedToolNames: new Set(CHECKIN.allowedToolNames), getActivePageTurnAttribution: () => current,
    }));
    const listed = (await checkin.listTools()).tools;
    assert.deepEqual(listed.map((tool) => tool.name).sort(), [...CHECKIN_TOOL_NAMES].sort());
    const propose = listed.find((tool) => tool.name === 'companion_propose')!;
    const payload = (propose.inputSchema.properties as Record<string, { type?: string; additionalProperties?: unknown }>).payload;
    assert.equal(payload.type, 'object');
    assert.notEqual(payload.additionalProperties, false, 'the kind decides the payload\'s fields');
    const hidden = { turnId: 'cmp-run-1', assistantId: `self-${s}-cmp-run-1` };
    activeTurnRow(s, hidden.turnId, hidden.assistantId);
    current = hidden;
    const quiet: any = await checkin.callTool({ name: 'nothing_to_do', arguments: { note: 'nothing new' } });
    assert.equal(quiet.isError, undefined, textOf(quiet));
    const rename: any = await checkin.callTool({ name: 'companion_set_name', arguments: { name: 'Nova' } });
    assert.equal(rename.isError, true, 'a check-in has no rename');

    const main = await open(slotFor(v.nodeId, v.workspaceId, { getActivePageTurnAttribution: () => current }));
    const mainNames = (await main.listTools()).tools.map((tool) => tool.name);
    assert.equal(mainNames.includes('nothing_to_do'), false);
    const user = { turnId: 'turn-user-1', assistantId: `a-${v.nodeId}-turn-user-1` };
    activeTurnRow(v.nodeId, user.turnId, user.assistantId);
    current = user;
    const renamed: any = await main.callTool({ name: 'companion_set_name', arguments: { name: 'Nova' } });
    assert.equal(renamed.isError, undefined, textOf(renamed));
    assert.equal(getCompanionSettings().displayName, 'Nova');
  });

  test('through Pi\'s execute: a check-in ends quietly in its hidden turn, V renames in the user\'s', async () => {
    const v = ensureAssistant();
    const s = makeCheckinNode(v.workspaceId);
    let current: ActivePageTurnAttribution | null = null;
    const runtimeDir = path.join(tmpDir, 'runtime');
    const runner = (tools: any[]) => async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, name);
      const result = await tool.execute(`call-${name}`, { __tool_use_purpose: 'test', ...args });
      return { text: textOf(result), isError: result.isError === true };
    };
    const checkin = runner(piTools(s, v.workspaceId, runtimeDir, CHECKIN, () => current));
    const main = runner(piTools(v.nodeId, v.workspaceId, runtimeDir, assistantToolProfile('main'), () => current));

    const hidden = { turnId: 'cmp-run-1', assistantId: `self-${s}-cmp-run-1` };
    activeTurnRow(s, hidden.turnId, hidden.assistantId);
    current = hidden;
    assert.equal((await checkin('nothing_to_do', { note: 'nothing new' })).isError, false);

    const user = { turnId: 'turn-user-1', assistantId: `a-${v.nodeId}-turn-user-1` };
    activeTurnRow(v.nodeId, user.turnId, user.assistantId);
    current = user;
    assert.equal((await main('companion_set_name', { name: 'Nova' })).isError, false);
    assert.equal(getCompanionSettings().displayName, 'Nova');
  });
});
