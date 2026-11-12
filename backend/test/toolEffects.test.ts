/**
 * The tool effects register's ratchet (DESIGN-v2 §2.9): every tool name a
 * runtime can register is classified (a new tool without a class fails here
 * and gets into no catalog); a check-in's catalog holds only reads, its three
 * deep reads, Michi-internal writes, cards and nothing_to_do; each runtime's
 * check-in launch catalog is exactly CHECKIN_TOOL_NAMES (Kiro's one exception,
 * the external tools, which a check-in's call is refused:
 * W1-A's kiroMetaAgent tests); V's Michi part is MAIN_TOOL_NAMES, on Pi with
 * PI_MAIN_EXTRA. Temp MICHI_DATA_DIR per test.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_RUN_TOOL_NAMES } from 'michi-runtime/internal/contract/tools';
import { listEnabledBuiltinTools } from '../src/agents/builtinTools';
import { KIRO_META_AGENT_EXTRA_ALLOWED, kiroMetaAgentConfig } from '../src/agents/kiro/kiroMetaAgent';
import { META_AGENT_MAINTENANCE_TOOL_NAMES } from '../src/agents/maintenancePolicy';
import { checkMetaAgentToolCatalog } from '../src/agents/metaAgentGuard';
import { PAGE_TOOL_NAMES } from '../src/agents/pageToolNames';
import { buildPiTools } from '../src/agents/pi/piTools';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { SCHEDULED_JOB_TOOL_NAMES } from '../src/agents/scheduledJobToolNames';
import type { RuntimeToolProfile } from '../src/agents/types';
import {
  CHECKIN_TOOL_NAMES, COMPANION_OWN_TOOL_NAMES, MAIN_TOOL_NAMES, META_AGENT_CHAT_TOOL_NAMES, PI_MAIN_EXTRA, PI_NATIVE_TOOL_NAMES,
  TURN_METADATA_TOOL_NAMES, assistantToolProfile,
} from '../src/assistant/policy';
import { ensureAssistant } from '../src/assistant/store';
import { MICHI_TOOL_EFFECTS, michiBareToolName, michiToolEffect } from '../src/assistant/toolEffects';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { McpSlotRegistry, buildMcpServerForSlot, type McpSlot } from '../src/services/mcpServer';
import { chatOwner } from './helpers/owners';
import { makeCheckinNode } from './helpers/checkinNodes';

const CHECKIN = assistantToolProfile('checkin');
/** The three deep reads a check-in keeps (Q2): outside reads, but only of the user's own services. */
const CHECKIN_DEEP_READ_TOOLS: readonly string[] = [];
/** The channels a check-in keeps: cards the user applies, and the quiet end. */
const CHECKIN_CHANNEL_TOOLS: readonly string[] = ['companion_propose', 'nothing_to_do'];

/** A slot as the runtimes open one, every callback a runtime can give. */
function slotFor(nodeId: string, workspaceId: string, extra: Record<string, unknown> = {}): McpSlot {
  return new McpSlotRegistry().create(nodeId, '/tmp', null, {
    onSpawnBranches: async () => [],
    onSaveArtifact: () => null,
    onUpdateArtifact: () => null,
    onShowImage: () => ({ error: 'unsupported in test' }),
    onAskUser: async () => null,
    onSetFollowUps: () => {},
    onSetBranchOverview: () => {},
    ...extra,
  } as never, { nodeId, workspaceId });
}

const mcpToolNames = (slot: McpSlot) => Object.keys((buildMcpServerForSlot(slot) as any)._registeredTools as Record<string, unknown>);

function piToolNames(nodeId: string, workspaceId: string, dataDir: string, toolProfile: RuntimeToolProfile | null): string[] {
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
      bridge, cwd: '/tmp', parentChatId: nodeId, workspaceId, enableFollowUps: true,
      imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set(), Type,
      owner: chatOwner(nodeId), toolProfile: toolProfile ?? undefined,
      // The session's user channel, as PiSession gives one: a check-in's catalog still has no ask_user.
      requestUserInput: async () => ({}) as never,
    }).map((tool: any) => tool.name as string);
  } finally {
    __resetRuntimeDeps();
  }
}

const sorted = (names: Iterable<string>) => [...new Set(names)].sort();

describe('the tool effects register (DESIGN-v2 §2.9)', () => {
  let tmpDir: string;
  let v: ReturnType<typeof ensureAssistant>;
  let s: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-tool-effects-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    process.env.MICHI_DESK = '1';
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    v = ensureAssistant();
    s = makeCheckinNode(v.workspaceId);
    saveWorkspace({ id: 'ws-1', name: 'Project', cwd: '/tmp/ws-1', created_at: 1, updated_at: 1, settings: null });
    saveTree({ id: 't-n-1', workspace_id: 'ws-1', root_node_id: 'n-1', last_active_at: 1, created_at: 1 });
    saveNode({ id: 'n-1', workspace_id: 'ws-1', tree_id: 't-n-1', kind: 'chat', title: 'Chat', status: 'idle',
      minimized: 0, spawned_by_agent: 0, acp_session_id: 'n-1', runtime_id: 'claude', created_at: 1 });
  });

  afterEach(() => {
    delete process.env.MICHI_DESK;
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('every tool name a runtime can register has a class', () => {
    const runtimeDir = path.join(tmpDir, 'runtime');
    const registered = sorted([
      // The lists catalogs are built from.
      ...META_AGENT_CHAT_TOOL_NAMES, ...MAIN_TOOL_NAMES, ...CHECKIN_TOOL_NAMES, ...COMPANION_OWN_TOOL_NAMES, ...PI_MAIN_EXTRA, ...PI_NATIVE_TOOL_NAMES,
      ...SCHEDULED_JOB_TOOL_NAMES, ...PAGE_TOOL_NAMES, ...TURN_METADATA_TOOL_NAMES, ...AGENT_RUN_TOOL_NAMES, ...META_AGENT_MAINTENANCE_TOOL_NAMES,
      ...listEnabledBuiltinTools().map((tool) => tool.name),
      // What the MCP slots and Pi actually register: an ordinary chat, V, a check-in.
      ...mcpToolNames(slotFor('n-1', 'ws-1')), ...mcpToolNames(slotFor(v.nodeId, v.workspaceId)), ...mcpToolNames(slotFor(s, v.workspaceId)),
      ...piToolNames('n-1', 'ws-1', runtimeDir, null), ...piToolNames(v.nodeId, v.workspaceId, runtimeDir, assistantToolProfile('main')),
      ...piToolNames(s, v.workspaceId, runtimeDir, CHECKIN),
    ]);
    assert.ok(registered.length > 60, `${registered.length} names`);
    assert.deepEqual(registered.filter((name) => michiToolEffect(name) === null), [], 'classify a new tool in assistant/toolEffects.ts');
    // The classes the design names.
    assert.equal(michiToolEffect('companion_read'), 'read');
    assert.equal(michiToolEffect('companion_edit_goal'), 'michi_write');
    assert.equal(michiToolEffect('companion_session_send'), 'indirect');
    assert.equal(michiToolEffect('not_a_tool'), null);
  });

  test('a check-in\'s catalog: reads, its three deep reads, Michi-internal writes, cards and nothing_to_do; nothing indirect or outside', () => {
    const outside = CHECKIN_TOOL_NAMES.filter((name) => {
      const effect = MICHI_TOOL_EFFECTS[name];
      return !(effect === 'read' || effect === 'michi_write' || CHECKIN_DEEP_READ_TOOLS.includes(name) || CHECKIN_CHANNEL_TOOLS.includes(name));
    });
    assert.deepEqual(outside, []);
    assert.deepEqual(CHECKIN_DEEP_READ_TOOLS.map((name) => MICHI_TOOL_EFFECTS[name]), []);
    assert.deepEqual(CHECKIN_CHANNEL_TOOLS.map((name) => MICHI_TOOL_EFFECTS[name]), ['channel', 'channel']);
    for (const absent of ['ask_user', 'start_conversation', 'send_to_thread', 'companion_session_send', 'companion_check_now', 'companion_set_name',
      'create_scheduled_job', 'spawn_branches', 'spawn_agent', 'open_url', 'save_artifact', 'web_search', 'fetch_content', 'bash', 'write']) {
      assert.ok(!(CHECKIN_TOOL_NAMES as readonly string[]).includes(absent), absent);
    }
    assert.equal(CHECKIN_TOOL_NAMES.length, 29);
    assert.equal(new Set(CHECKIN_TOOL_NAMES).size, CHECKIN_TOOL_NAMES.length);
  });

  test('each runtime launches a check-in with exactly its catalog and rejects extra credential tools', () => {
    // Claude, Codex and Kiro reach Michi through the conversation's MCP slot.
    assert.deepEqual(sorted(mcpToolNames(slotFor(s, v.workspaceId, { restricted: true, exposedToolNames: new Set(CHECKIN.allowedToolNames) }))),
      sorted(CHECKIN_TOOL_NAMES));
    assert.deepEqual(sorted(mcpToolNames(slotFor(s, v.workspaceId))), sorted(CHECKIN_TOOL_NAMES), 'without its allow-list too');
    // Kiro's agent allows those names alone.
    const kiro = kiroMetaAgentConfig('chat', CHECKIN.allowedToolNames!) as { allowedTools: string[] };
    assert.deepEqual(kiro.allowedTools, CHECKIN_TOOL_NAMES.map((name) => `@michi/${name}`));
    const observed = [...CHECKIN_TOOL_NAMES, ...KIRO_META_AGENT_EXTRA_ALLOWED];
    assert.equal(checkMetaAgentToolCatalog({ runtimeId: 'kiro', toolset: 'chat', observed, allowed: CHECKIN_TOOL_NAMES, extraAllowed: KIRO_META_AGENT_EXTRA_ALLOWED }), null);
    assert.deepEqual(checkMetaAgentToolCatalog({ runtimeId: 'kiro', toolset: 'chat', observed: [...observed, 'mcp:example-credentials:assume_role'], allowed: CHECKIN_TOOL_NAMES, extraAllowed: KIRO_META_AGENT_EXTRA_ALLOWED })
      ?.unexpectedTools, ['mcp:example-credentials:assume_role'], 'any other tool from that server still fails');
    // Pi: its own catalog, no native tool.
    assert.deepEqual(sorted(piToolNames(s, v.workspaceId, path.join(tmpDir, 'runtime'), CHECKIN)), sorted(CHECKIN_TOOL_NAMES));
  });

  test('V\'s Michi part is MAIN_TOOL_NAMES; on Pi with PI_MAIN_EXTRA and its native tools', () => {
    const vMcp = mcpToolNames(slotFor(v.nodeId, v.workspaceId)).filter((name) => !(TURN_METADATA_TOOL_NAMES as readonly string[]).includes(name));
    assert.deepEqual(sorted(vMcp), sorted(MAIN_TOOL_NAMES));
    const vPi = piToolNames(v.nodeId, v.workspaceId, path.join(tmpDir, 'runtime'), assistantToolProfile('main'));
    const natives = new Set<string>(PI_NATIVE_TOOL_NAMES);
    const extra = new Set<string>(PI_MAIN_EXTRA);
    assert.deepEqual(sorted(vPi.filter((name) => !natives.has(name) && !extra.has(name) && !(TURN_METADATA_TOOL_NAMES as readonly string[]).includes(name))),
      sorted(MAIN_TOOL_NAMES), 'the Michi part');
    assert.deepEqual(vPi.filter((name) => !(MAIN_TOOL_NAMES as readonly string[]).includes(name) && !natives.has(name) && !extra.has(name)
      && !(TURN_METADATA_TOOL_NAMES as readonly string[]).includes(name)), [], 'nothing beyond MAIN, PI_MAIN_EXTRA and the natives');
  });

  test('runtime tool names map back to Michi\'s bare names, and nothing else does', () => {
    assert.equal(michiBareToolName('mcp____michi_internal____edit_page'), 'edit_page');
    assert.equal(michiBareToolName('@michi/companion_read'), 'companion_read');
    assert.equal(michiBareToolName('mcp_michi_list_tasks'), 'list_tasks');
    assert.equal(michiBareToolName('read_page'), 'read_page');
    for (const other of ['mcp__other__edit_page', '@other/read_page', 'Bash', 'mcp_michi_not_a_tool']) assert.equal(michiBareToolName(other), null, other);
  });
});
