import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode } from '../src/services/dbRepository';
import { applyWorkspaceCommands } from '../src/services/domainCommands';
import { scanGraphIntegrity } from '../src/services/graphIntegrity';

function seedWorkspace(workspaceId: string, treeId: string, rootId: string, childIds: string[]): void {
  applyWorkspaceCommands(workspaceId, {
    operationId: `seed-${workspaceId}`,
    commands: [
      { type: 'workspace.upsert', payload: { id: workspaceId, name: workspaceId, active_tree_id: treeId } },
      { type: 'tree.upsert', payload: { id: treeId, workspace_id: workspaceId, root_node_id: rootId } },
      { type: 'node.upsert', payload: { id: rootId, workspace_id: workspaceId, tree_id: treeId, parent_node_id: null } },
      ...childIds.flatMap((id) => [
        { type: 'node.upsert' as const, payload: { id, workspace_id: workspaceId, tree_id: treeId, parent_node_id: rootId } },
        { type: 'edge.upsert' as const, payload: { id: `branch-${rootId}-${id}`, workspace_id: workspaceId, source_node_id: rootId, target_node_id: id, kind: 'branch' } },
      ]),
    ],
  });
}

describe('graph integrity scan', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-graph-integrity-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    seedWorkspace('ws-a', 'tree-a', 'root-a', ['child-1', 'child-2']);
    seedWorkspace('ws-b', 'tree-b', 'root-b', []);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('counts each broken placement invariant and changes nothing', () => {
    assert.deepEqual(scanGraphIntegrity(), {
      childOutsideParentTree: 0, liveChildWithoutBranchEdge: 0, treeWithoutRoot: 0, crossWorkspacePlacement: 0,
    });
    // A trashed branch keeps parent and tree without edges: not a problem.
    getDb().prepare('UPDATE nodes SET deleted_at = 1 WHERE id = ?').run('child-2');
    getDb().prepare('DELETE FROM edges WHERE target_node_id = ?').run('child-2');
    assert.equal(scanGraphIntegrity().liveChildWithoutBranchEdge, 0);

    getDb().prepare('UPDATE nodes SET tree_id = NULL WHERE id = ?').run('child-1');
    getDb().prepare('UPDATE nodes SET deleted_at = NULL WHERE id = ?').run('child-2');
    getDb().prepare('UPDATE nodes SET purged_at = 1 WHERE id = ?').run('root-b');
    saveNode({ id: 'stray', workspace_id: 'ws-a', tree_id: 'tree-b', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
    const before = JSON.stringify(getDb().prepare('SELECT * FROM nodes ORDER BY id').all());

    assert.deepEqual(scanGraphIntegrity(), {
      childOutsideParentTree: 1, liveChildWithoutBranchEdge: 1, treeWithoutRoot: 1, crossWorkspacePlacement: 1,
    });
    assert.equal(JSON.stringify(getDb().prepare('SELECT * FROM nodes ORDER BY id').all()), before);
  });
});
