/**
 * The two graph write paths, given the same inputs: the main thread
 * (graphCommands.ensureDurableGraphNode over dbRepository's saveWorkspace,
 * saveTree, saveNode and saveEdge, and dbRepository.updateNodeResumeBinding)
 * and the SQLite worker (dbWorkerThread.ts through dbWorkerClient, as
 * routes/michi.ts calls it). Each path runs every scenario on its own fresh
 * data.db; the rows each scenario leaves, the outcome of each step and the
 * structure changes reported are compared.
 *
 * The worker's save* helpers are private to its thread, so both paths are
 * driven through the commands they share. Where they differ today is listed,
 * with the reason, in EXPECTED_DIFFERENCES: a fix to either path, or a new
 * drift, changes that list. Merging the two paths (cleanup audit STR-01) should
 * leave only the differences it means to keep.
 *
 * Both saveTree upserts write root_node_id and rev, but neither shows here:
 * both paths reject a tree replayed with another root before saving it ('a tree
 * replayed with another root' pins the rejection), and the command carries no rev.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceStructureChange } from 'michi-shared';
import { closeDb, getDb, getDbPath, initDb } from '../src/services/db';
import { dbWorker, initDbWorker, shutdownDbWorker } from '../src/services/dbWorkerClient';
import { updateNodeResumeBinding } from '../src/services/dbRepository';
import { DomainError } from '../src/services/domainErrors';
import { ensureDurableGraphNode } from '../src/services/graphCommands';
import type { EnsureDurableGraphNodeInput } from '../src/services/graphCommandTypes';
import { structureEvents } from '../src/services/structureEvents';

type ResumeBinding = Parameters<typeof dbWorker.persistResumeBinding>[0];
type Step = { ensure: EnsureDurableGraphNodeInput } | { bind: ResumeBinding } | { sql: string };

interface WritePath {
  ensure(input: EnsureDurableGraphNodeInput): Promise<unknown>;
  bind(binding: ResumeBinding): Promise<void>;
}

const mainThread: WritePath = {
  ensure: async (input) => ensureDurableGraphNode(input),
  bind: async ({ nodeId, ...fields }) => updateNodeResumeBinding(nodeId, fields),
};

const workerThread: WritePath = {
  ensure: (input) => dbWorker.ensureDurableGraphNode(input),
  bind: (binding) => dbWorker.persistResumeBinding(binding),
};

const T0 = 1_700_000_000_000;

function rootOf(scenario: string): EnsureDurableGraphNodeInput {
  return {
    workspace: { id: `${scenario}-ws`, name: ' Alpha ', cwd: '/tmp/alpha', createdAt: T0, activeTreeId: `${scenario}-tree`, settings: { sidebar: 'open' } },
    tree: { id: `${scenario}-tree`, rootNodeId: `${scenario}-root`, name: 'Main', lastActiveAt: T0 + 1, createdAt: T0 },
    node: { id: `${scenario}-root`, treeId: `${scenario}-tree`, title: 'Root', currentModeId: 'mode-a', composerDraft: '{"text":"hi"}', createdAt: T0 },
    edges: [],
  };
}

/** A branch of the scenario's root; `edges` defaults to its branch edge. */
function childOf(
  scenario: string,
  child: string,
  overrides: Partial<Pick<EnsureDurableGraphNodeInput, 'workspace' | 'tree' | 'edges'>> = {},
): EnsureDurableGraphNodeInput {
  const root = rootOf(scenario);
  const nodeId = `${scenario}-${child}`;
  return {
    workspace: { ...root.workspace, ...overrides.workspace },
    tree: { ...root.tree!, ...overrides.tree },
    node: { id: nodeId, treeId: root.tree!.id, parentNodeId: root.node.id, title: child, spawnedByAgent: true, createdAt: T0 + 10 },
    edges: overrides.edges ?? [
      { id: `${nodeId}-edge`, sourceNodeId: root.node.id, targetNodeId: nodeId, kind: 'branch', anchorMessageId: 'm-1', createdAt: T0 + 10 },
    ],
  };
}

function binding(nodeId: string, fields: Partial<ResumeBinding>): ResumeBinding {
  return {
    nodeId, acp_session_id: nodeId, runtime_id: 'kiro', runtime_engine: null, provider_id: null, model_id: null,
    reasoning: null, resume_fingerprint: null, current_mode_id: null, ...fields,
  };
}

const SCENARIOS: Record<string, Step[]> = {
  'create a root, then branch a child': [
    { ensure: rootOf('create') },
    { ensure: childOf('create', 'child') },
  ],
  'a new node in a renamed, archived and pinned tree': [
    { ensure: rootOf('tree-update') },
    { ensure: childOf('tree-update', 'child', {
      workspace: { ...rootOf('tree-update').workspace, name: 'Beta' },
      tree: { ...rootOf('tree-update').tree!, name: 'Renamed', archivedAt: T0 + 20, pinnedAt: T0 + 21, lastActiveAt: T0 + 22 },
    }) },
  ],
  'an edge replayed with another anchor': [
    { ensure: rootOf('edge-replay') },
    { ensure: childOf('edge-replay', 'child') },
    { ensure: childOf('edge-replay', 'child', { edges: [
      { id: 'edge-replay-child-edge', sourceNodeId: 'edge-replay-root', targetNodeId: 'edge-replay-child', kind: 'branch', anchorMessageId: 'm-2', createdAt: T0 + 30 },
    ] }) },
  ],
  'an edge from a tombstoned node': [
    { ensure: rootOf('purged-source') },
    { ensure: childOf('purged-source', 'gone') },
    { sql: "UPDATE nodes SET purged_at = 1 WHERE id = 'purged-source-gone'" },
    { ensure: childOf('purged-source', 'new', { edges: [
      { id: 'purged-source-merge', sourceNodeId: 'purged-source-gone', targetNodeId: 'purged-source-new', kind: 'merge' },
    ] }) },
  ],
  'a tombstoned node replayed': [
    { ensure: rootOf('purged-node') },
    { ensure: childOf('purged-node', 'gone') },
    { sql: "UPDATE nodes SET purged_at = 1 WHERE id = 'purged-node-gone'" },
    { ensure: childOf('purged-node', 'gone', { edges: [] }) },
  ],
  'a tombstoned root replayed': [
    { ensure: rootOf('purged-root') },
    { sql: "UPDATE nodes SET purged_at = 1 WHERE id = 'purged-root-root'" },
    { ensure: rootOf('purged-root') },
  ],
  'a child of a maintenance, Scheduled-only parent': [
    { ensure: rootOf('marked') },
    { sql: "UPDATE nodes SET maintenance_job_id = 'job-m', scheduled_only_job_id = 'job-s' WHERE id = 'marked-root'" },
    { ensure: childOf('marked', 'child') },
  ],
  'a link edge across trees': [
    { ensure: rootOf('cross-link') },
    { ensure: { ...rootOf('cross-link'),
      tree: { id: 'cross-link-other-tree', rootNodeId: 'cross-link-other', lastActiveAt: T0 + 2, createdAt: T0 + 2 },
      node: { id: 'cross-link-other', treeId: 'cross-link-other-tree', title: 'Other', createdAt: T0 + 2 } } },
    { ensure: childOf('cross-link', 'child', { edges: [
      { id: 'cross-link-child-edge', sourceNodeId: 'cross-link-root', targetNodeId: 'cross-link-child', kind: 'branch', anchorMessageId: 'm-1', createdAt: T0 + 10 },
      { id: 'cross-link-link', sourceNodeId: 'cross-link-other', targetNodeId: 'cross-link-child', kind: 'link', createdAt: T0 + 10 },
    ] }) },
  ],
  'a tree replayed with another root': [
    { ensure: rootOf('reroot') },
    { ensure: childOf('reroot', 'child', { tree: { ...rootOf('reroot').tree!, rootNodeId: 'reroot-child' } }) },
  ],
  'resume bindings': [
    { ensure: rootOf('bind') },
    { bind: binding('bind-root', { current_mode_id: 'mode-b', provider_id: 'p', model_id: 'm', reasoning: 'high', resume_fingerprint: 'f1' }) },
    { bind: binding('bind-root', { acp_session_id: 'kiro-v1', runtime_engine: 'v1' }) },
    { bind: binding('bind-root', { acp_session_id: 'claude-session', runtime_id: 'claude', runtime_engine: 'v1' }) },
    { bind: binding('bind-root', { runtime_id: 'codex' }) },
    { bind: binding('bind-missing', {}) },
    { sql: "UPDATE nodes SET purged_at = 1 WHERE id = 'bind-root'" },
    { bind: binding('bind-root', { acp_session_id: 'after-purge' }) },
  ],
};

/**
 * Where the worker differs from the main thread today, per scenario. Every
 * line here is a known divergence; an empty list means the paths agree.
 */
const EXPECTED_DIFFERENCES: Record<string, string[]> = {
  'create a root, then branch a child': [],
  'a new node in a renamed, archived and pinned tree': [],
  'an edge replayed with another anchor': [],
  'an edge from a tombstoned node': [],
  'a tombstoned node replayed': [],
  'a tombstoned root replayed': [],
  'a child of a maintenance, Scheduled-only parent': [],
  'a link edge across trees': [],
  'a tree replayed with another root': [],
  'resume bindings': [],
};

type Row = Record<string, unknown>;

interface Observation {
  outcomes: string[];
  rows: Record<string, Map<string, Row>>;
  changes: string[];
}

const GRAPH_TABLES: Record<string, string> = {
  workspaces: 'SELECT * FROM workspaces WHERE id = ?',
  trees: 'SELECT * FROM trees WHERE workspace_id = ?',
  nodes: 'SELECT * FROM nodes WHERE workspace_id = ?',
  edges: 'SELECT * FROM edges WHERE workspace_id = ?',
};

function outcomeOf(error: unknown): string {
  if (error instanceof DomainError) return `rejected ${error.code}`;
  return `rejected ${error instanceof Error ? error.message : String(error)}`;
}

function describeChange(change: WorkspaceStructureChange): string {
  return `${change.entity} ${change.op} ${change.nodeId ?? change.treeId ?? change.workspaceId}`;
}

async function observe(writePath: WritePath, useWorker: boolean): Promise<Map<string, Observation>> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-graph-write-paths-'));
  const previous = process.env.MICHI_DATA_DIR;
  process.env.MICHI_DATA_DIR = dataDir;
  closeDb();
  initDb();
  const reported: WorkspaceStructureChange[] = [];
  const unsubscribe = structureEvents.subscribe({ send: (event) => reported.push(...event.changes) });
  try {
    if (useWorker) await initDbWorker(getDbPath());
    const observations = new Map<string, Observation>();
    for (const [name, steps] of Object.entries(SCENARIOS)) {
      const workspaceId = (steps[0] as { ensure: EnsureDurableGraphNodeInput }).ensure.workspace.id;
      const outcomes: string[] = [];
      reported.length = 0;
      for (const step of steps) {
        try {
          if ('ensure' in step) await writePath.ensure(step.ensure);
          else if ('bind' in step) await writePath.bind(step.bind);
          else getDb().exec(step.sql);
          outcomes.push('ok');
        } catch (error) {
          outcomes.push(outcomeOf(error));
        }
        structureEvents.flush();
      }
      const rows: Observation['rows'] = {};
      for (const [table, sql] of Object.entries(GRAPH_TABLES)) {
        rows[table] = new Map((getDb().prepare(sql).all(workspaceId) as Row[]).map((row) => {
          // The commands stamp updated_at with their own clock.
          const stable = table === 'workspaces' ? { ...row, updated_at: typeof row.updated_at } : { ...row };
          return [row.id as string, stable];
        }));
      }
      const changes = reported.filter((change) => change.workspaceId === workspaceId).map(describeChange).sort();
      observations.set(name, { outcomes, rows, changes });
    }
    return observations;
  } finally {
    unsubscribe();
    if (useWorker) await shutdownDbWorker();
    closeDb();
    if (previous === undefined) delete process.env.MICHI_DATA_DIR;
    else process.env.MICHI_DATA_DIR = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function withoutOne(list: string[], item: string): string[] {
  const index = list.indexOf(item);
  return index < 0 ? list : [...list.slice(0, index), ...list.slice(index + 1)];
}

function differences(main: Observation, worker: Observation): string[] {
  const out: string[] = [];
  main.outcomes.forEach((outcome, step) => {
    if (outcome !== worker.outcomes[step]) out.push(`step ${step + 1}: main ${outcome} | worker ${worker.outcomes[step]}`);
  });
  for (const table of Object.keys(GRAPH_TABLES)) {
    const ids = [...new Set([...main.rows[table].keys(), ...worker.rows[table].keys()])].sort();
    for (const id of ids) {
      const a = main.rows[table].get(id);
      const b = worker.rows[table].get(id);
      if (!a || !b) {
        out.push(`${table} ${id}: only ${a ? 'main' : 'worker'}`);
        continue;
      }
      for (const column of Object.keys(a)) {
        if (a[column] !== b[column]) {
          out.push(`${table} ${id}.${column}: main ${JSON.stringify(a[column])} | worker ${JSON.stringify(b[column])}`);
        }
      }
    }
  }
  let onlyWorker = worker.changes;
  for (const change of main.changes) {
    if (onlyWorker.includes(change)) onlyWorker = withoutOne(onlyWorker, change);
    else out.push(`change only from main: ${change}`);
  }
  for (const change of onlyWorker) out.push(`change only from worker: ${change}`);
  return out;
}

let main: Map<string, Observation>;
let worker: Map<string, Observation>;

before(async () => {
  main = await observe(mainThread, false);
  worker = await observe(workerThread, true);
});

for (const name of Object.keys(SCENARIOS)) {
  test(`graph write paths: ${name}`, () => {
    assert.deepEqual(differences(main.get(name)!, worker.get(name)!), EXPECTED_DIFFERENCES[name]);
  });
}

test('graph write paths: the scenarios write what they describe', () => {
  // Guards against a vacuous comparison: both paths failing the same way would agree.
  const create = main.get('create a root, then branch a child')!;
  assert.deepEqual(create.outcomes, ['ok', 'ok']);
  assert.equal(create.rows.nodes.size, 2);
  assert.equal(create.rows.edges.get('create-child-edge')?.fork_boundary_message_id, 'm-1');
  assert.deepEqual(main.get('a tree replayed with another root')!.outcomes, ['ok', 'rejected tree_identity_mismatch']);
  assert.deepEqual(main.get('a link edge across trees')!.outcomes, ['ok', 'ok', 'rejected edge_tree_mismatch']);
  assert.equal(worker.get('a link edge across trees')!.rows.nodes.has('cross-link-child'), false);
  const replayedEdge = worker.get('an edge replayed with another anchor')!.rows.edges.get('edge-replay-child-edge')!;
  assert.deepEqual(
    { anchor: replayedEdge.anchor_message_id, createdAt: replayedEdge.created_at, boundary: replayedEdge.fork_boundary_message_id },
    { anchor: 'm-2', createdAt: T0 + 30, boundary: 'm-1' },
  );
  const purgedSource = worker.get('an edge from a tombstoned node')!;
  assert.equal(purgedSource.outcomes[3], 'rejected edge_workspace_mismatch');
  assert.equal(purgedSource.rows.nodes.has('purged-source-new'), false);
  assert.equal(worker.get('a tombstoned node replayed')!.outcomes[3], 'rejected graph prerequisite transaction did not materialize canonical rows');
  assert.deepEqual(worker.get('a tombstoned root replayed')!.outcomes, ['ok', 'ok', 'rejected tree_root_mismatch']);
  const markedChild = worker.get('a child of a maintenance, Scheduled-only parent')!.rows.nodes.get('marked-child')!;
  assert.deepEqual(
    { maintenance: markedChild.maintenance_job_id, scheduledOnly: markedChild.scheduled_only_job_id },
    { maintenance: 'job-m', scheduledOnly: 'job-s' },
  );
  assert.deepEqual(
    worker.get('a new node in a renamed, archived and pinned tree')!.changes.filter((change) => change.startsWith('tree ')),
    ['tree archived tree-update-tree', 'tree created tree-update-tree', 'tree renamed tree-update-tree'],
  );
  const bind = worker.get('resume bindings')!;
  assert.deepEqual(bind.outcomes, ['ok', 'ok', 'ok', 'ok', 'ok', 'rejected Cannot persist resume binding: node bind-missing does not exist', 'ok', 'ok']);
  const root = bind.rows.nodes.get('bind-root')!;
  assert.deepEqual(
    { acp: root.acp_session_id, external: root.external_session_id, runtime: root.runtime_id, engine: root.runtime_engine, mode: root.current_mode_id },
    { acp: 'after-purge', external: null, runtime: 'kiro', engine: 'v2', mode: 'mode-b' },
  );
});
