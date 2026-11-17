/**
 * spawn_branches' depth and total limits (services/spawnLimits.ts): a branch
 * of a spawned branch is not offered the tool, the bridge refuses it as well,
 * and the chat the user made has at most MAX_SPAWNED_BRANCHES spawned below it.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { McpSlotRegistry, buildMcpServerForSlot } from '../src/services/mcpServer';
import { MAX_SPAWNED_BRANCHES, MAX_SPAWN_DEPTH, spawnBranchesOffered, spawnBranchesRefusal } from '../src/services/spawnLimits';
import { spawnRefusal } from '../src/services/spawnChild';
import { createAgentToolBridge } from '../src/agents/toolBridge';
import { buildPiTools } from '../src/agents/pi/piTools';
import { loadPiTypebox } from '../src/agents/pi/piAi';
import { __resetRuntimeDeps, configureRuntimeDeps } from '../src/agents/runtimeDeps';
import { chatOwner } from './helpers/owners';

let dir: string;
const oldDataDir = process.env.MICHI_DATA_DIR;

function node(id: string, parent: string | null, extra: { spawned?: boolean; run?: string; deleted?: boolean } = {}): void {
  getDb().prepare(`INSERT INTO nodes (id, workspace_id, tree_id, parent_node_id, kind, title, status, spawned_by_agent,
      multi_model_run_id, deleted_at, created_at) VALUES (?, 'ws', 'tree', ?, 'chat', ?, 'idle', ?, ?, ?, 1)`)
    .run(id, parent, id, extra.spawned === false ? 0 : 1, extra.run ?? null, extra.deleted ? 2 : null);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-spawn-limits-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, cwd, created_at, updated_at) VALUES ('ws', 'W', ?, 1, 1)").run(dir);
  db.prepare("INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES ('tree', 'ws', 'root', 1, 1)").run();
  node('root', null, { spawned: false });
  node('child', 'root');
  node('grandchild', 'child');
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  if (oldDataDir === undefined) delete process.env.MICHI_DATA_DIR;
  else process.env.MICHI_DATA_DIR = oldDataDir;
});

describe('spawn depth', () => {
  test('the user\'s chat and its spawned branch may spawn; a branch of that branch may not', () => {
    assert.equal(MAX_SPAWN_DEPTH, 2);
    assert.deepEqual(['root', 'child', 'grandchild'].map(spawnBranchesOffered), [true, true, false]);
    assert.equal(spawnBranchesRefusal('child', 1), null);
    assert.match(spawnBranchesRefusal('grandchild', 1) ?? '', /reached the branch depth limit.*ask the user to branch manually/);
  });

  test('a branch the user makes by hand starts again at depth 0', () => {
    node('manual', 'grandchild', { spawned: false });
    node('manualChild', 'manual');
    assert.deepEqual(['manual', 'manualChild'].map(spawnBranchesOffered), [true, true]);
  });

  test('a plan\'s branch counts as a spawned branch for depth, as it already cannot propose a plan', () => {
    node('plan', 'root', { run: 'run-1' });
    node('planChild', 'plan');
    assert.deepEqual(['plan', 'planChild'].map(spawnBranchesOffered), [true, false]);
  });

  test('a chat with no node is left to the spawn itself', () => {
    assert.equal(spawnBranchesOffered(null), true);
    assert.equal(spawnBranchesRefusal('missing', 5), null);
  });
});

describe('spawned branches below the user\'s chat', () => {
  test('count through every level, without deleted ones or plan branches', () => {
    assert.equal(MAX_SPAWNED_BRANCHES, 20);
    // child and grandchild exist; 15 more under child, one deleted, one plan branch.
    for (let i = 0; i < 15; i++) node(`c${i}`, 'child');
    node('gone', 'root', { deleted: true });
    node('plan', 'root', { run: 'run-1' });
    // 17 counted: 3 left.
    assert.equal(spawnBranchesRefusal('root', 3), null);
    assert.match(spawnBranchesRefusal('child', 4) ?? '', /only 3 more branches.*at most 3 topics/);
    node('c15', 'root');
    node('c16', 'child');
    node('c17', 'plan');
    assert.match(spawnBranchesRefusal('root', 1) ?? '', /already spawned 20 branches.*the limit is 20/);
  });

  test('a chat the user made by hand below them has its own budget', () => {
    for (let i = 0; i < 18; i++) node(`c${i}`, 'root');
    node('manual', 'c0', { spawned: false });
    assert.match(spawnBranchesRefusal('root', 1) ?? '', /already spawned 20/);
    assert.equal(spawnBranchesRefusal('manual', 5), null);
  });
});

describe('every runtime\'s path', () => {
  test('the MCP catalog (Kiro, Crew relay, Claude, Codex) leaves spawn_branches out for a chat too deep', () => {
    const registry = new McpSlotRegistry();
    const tools = (nodeId: string) => (buildMcpServerForSlot(registry.create(nodeId, dir, null,
      { onSpawnBranches: async () => [] }, { nodeId, workspaceId: 'ws' })) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    assert.ok(tools('child').spawn_branches);
    assert.equal(tools('grandchild').spawn_branches, undefined);
  });

  test('Pi leaves spawn_branches out for a chat too deep', async () => {
    configureRuntimeDeps({
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null } as never,
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }),
        resolveModel: () => '', resolveReasoning: () => undefined } as never,
      dataDir: dir,
    });
    const { Type } = await loadPiTypebox();
    try {
      const names = (nodeId: string) => (buildPiTools({
        bridge: { spawnBranches: async () => [] }, cwd: dir, parentChatId: nodeId, workspaceId: 'ws', enableFollowUps: false,
        imageQuota: { usedBytes: 0, limitBytes: 1 }, seenPaths: new Set<string>(), Type, ownerUserId: null, owner: chatOwner(nodeId),
      } as never) as Array<{ name: string }>).map((tool) => tool.name);
      assert.ok(names('child').includes('spawn_branches'));
      assert.equal(names('grandchild').includes('spawn_branches'), false);
    } finally {
      __resetRuntimeDeps();
    }
  });

  test('the bridge (every runtime, Pi included) refuses past either limit before it creates a child', async () => {
    const created: string[] = [];
    const bridge = createAgentToolBridge({
      createChild: async ({ title }) => { created.push(title); return { chatId: title, nodeId: title }; },
      spawnRefusal,
    });
    const spawn = (parentChatId: string, count: number) => bridge.spawnBranches({
      parentChatId, cwd: dir, enableFollowUps: true,
      topics: Array.from({ length: count }, (_, i) => ({ title: `${parentChatId}-${i}`, prompt: 'Go' })),
    });
    await assert.rejects(spawn('grandchild', 1), /reached the branch depth limit/);
    for (let i = 0; i < 16; i++) node(`c${i}`, 'root');
    await assert.rejects(spawn('root', 3), /only 2 more branches/);
    assert.deepEqual(created, []);
    assert.equal((await spawn('child', 2)).length, 2);
  });

  test('the bridge stops when the last places go while it creates children', async () => {
    let placesLeft = 2;
    const bridge = createAgentToolBridge({
      createChild: async ({ title }) => { placesLeft -= 2; return { chatId: title, nodeId: title }; },
      spawnRefusal: ({ requested }) => (requested > placesLeft ? 'full' : null),
    });
    const created = await bridge.spawnBranches({
      parentChatId: 'root', cwd: dir, enableFollowUps: true,
      topics: [{ title: 'a', prompt: 'Go' }, { title: 'b', prompt: 'Go' }],
    });
    assert.deepEqual(created.map((branch) => branch.title), ['a']);
  });
});
