import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectWindowComposerDraft } from 'michi-shared';

import { closeDb, getDb, initDb } from '../src/services/db';
import { applyWorkspaceCommands, type WorkspaceCommand } from '../src/services/domainCommands';
import { DomainError } from '../src/services/domainErrors';
import { runWithStructureOrigin } from '../src/services/structureEvents';
import {
  getNode, getWorkspace, isContextTombstoned, listContexts, listEdges, listTrees, purgeWorkspaceNodes, runTombstoneGc, saveWorkspace,
  TOMBSTONE_TTL_MS,
} from '../src/services/dbRepository';

describe('workspace domain commands', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-domain-commands-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('applies an explicit command batch transactionally and replays it idempotently', () => {
    const input = {
      operationId: 'op-1',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Workspace', created_at: 1, updated_at: 1, active_tree_id: 'tree-1' } },
        { type: 'tree.upsert', payload: { id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'root', last_active_at: 1, created_at: 1 } },
        { type: 'node.upsert', payload: { id: 'root', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: null, kind: 'chat', title: null, status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 } },
        { type: 'context.upsert', payload: { id: 'ctx-1', workspace_id: 'ws-1', name: 'guide', file_path: '/guide.md', auto_inject: 0, source: 'user', created_at: 1, updated_at: 1 } },
      ],
    } as const;

    const first = applyWorkspaceCommands('ws-1', input);
    const replay = applyWorkspaceCommands('ws-1', input);

    assert.deepEqual(replay, first);
    assert.equal(getWorkspace('ws-1')?.name, 'Workspace');
    assert.equal(listTrees('ws-1').length, 1);
    assert.equal(getNode('root')?.tree_id, 'tree-1');
    assert.equal(listContexts('ws-1').length, 1);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM command_receipts').get() as { count: number }).count, 1);
  });

  test('a trashed branch sent without a tree stays in its parent\'s tree', () => {
    applyWorkspaceCommands('ws-1', {
      operationId: 'seed-branch',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Workspace', active_tree_id: 'tree-1' } },
        { type: 'tree.upsert', payload: { id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'root' } },
        { type: 'node.upsert', payload: { id: 'root', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: null } },
        { type: 'node.upsert', payload: { id: 'branch', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: 'root' } },
      ],
    });
    // What a window that derives trees from branch edges sends once Trash dropped the branch's edges.
    const trashed = { id: 'branch', workspace_id: 'ws-1', tree_id: null, parent_node_id: 'root', deleted_at: 5, deletion_group_id: 'trim-1' };
    applyWorkspaceCommands('ws-1', {
      operationId: 'trash-branch',
      commands: [{ type: 'node.upsert', payload: trashed }, { type: 'node.patch', payload: trashed }],
    });

    const branch = getNode('branch');
    assert.equal(branch?.tree_id, 'tree-1');
    assert.equal(branch?.parent_node_id, 'root');
    assert.equal(branch?.deleted_at, 5);
  });

  test('rejects operation id reuse with a different payload', () => {
    applyWorkspaceCommands('ws-1', {
      operationId: 'op-reused',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-1', name: 'One', created_at: 1, updated_at: 1 } }],
    });
    assert.throws(() => applyWorkspaceCommands('ws-1', {
      operationId: 'op-reused',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Two', created_at: 1, updated_at: 2 } }],
    }), /different payload/i);
    assert.equal(getWorkspace('ws-1')?.name, 'One');
  });

  test('replays a batch sent again with its keys in another order', () => {
    const first = applyWorkspaceCommands('ws-1', {
      operationId: 'op-order',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-1', name: 'One', created_at: 1, updated_at: 1 } }],
    });
    const replay = applyWorkspaceCommands('ws-1', {
      operationId: 'op-order',
      commands: [{ payload: { updated_at: 1, created_at: 1, name: 'One', id: 'ws-1' }, type: 'workspace.upsert' }],
    });
    assert.deepEqual(replay, first);
  });

  test('saves and clears per-window drafts without overwriting another window', () => {
    const first = JSON.stringify({ value: 'window one', mentions: [] });
    const second = JSON.stringify({ value: 'window two', mentions: [] });
    applyWorkspaceCommands('ws-1', {
      operationId: 'draft-seed',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Drafts', created_at: 1, updated_at: 1 } },
        { type: 'node.upsert', payload: { id: 'draft-node', workspace_id: 'ws-1', kind: 'chat', created_at: 1,
          composer_draft: first, composer_draft_window_id: 'window-a' } },
      ],
    });
    const patchDraft = (operationId: string, windowId: string, draft: string | null) => applyWorkspaceCommands('ws-1', {
      operationId,
      commands: [{ type: 'node.patch', payload: { id: 'draft-node', composer_draft: draft, composer_draft_window_id: windowId } }],
    });
    patchDraft('draft-second', 'window-b', second);
    assert.equal(selectWindowComposerDraft(getNode('draft-node')?.composer_draft, 'window-a'), first);
    assert.equal(selectWindowComposerDraft(getNode('draft-node')?.composer_draft, 'window-b'), second);
    patchDraft('clear-first', 'window-a', null);
    assert.equal(selectWindowComposerDraft(getNode('draft-node')?.composer_draft, 'window-a'), null);
    assert.equal(selectWindowComposerDraft(getNode('draft-node')?.composer_draft, 'window-b'), second);

    // Legacy/outbox writes must preserve scoped drafts as well.
    applyWorkspaceCommands('ws-1', {
      operationId: 'draft-outbox',
      commands: [{ type: 'node.patch', payload: { id: 'draft-node', composer_draft: JSON.stringify({ __michiPendingSpawnPrompt: 'child prompt' }) } }],
    });
    assert.equal(selectWindowComposerDraft(getNode('draft-node')?.composer_draft, 'window-b'), second);
    assert.equal(JSON.parse(getNode('draft-node')!.composer_draft!).__michiPendingSpawnPrompt, 'child prompt');
    assert.throws(() => patchDraft('invalid-window', '', first), /composer_draft_window_id/);
    assert.equal(selectWindowComposerDraft(getNode('draft-node')?.composer_draft, 'window-b'), second);
    saveWorkspace({ id: 'ws-2', name: 'Other', created_at: 1, updated_at: 1 });
    assert.throws(() => applyWorkspaceCommands('ws-2', {
      operationId: 'foreign-draft', commands: [{ type: 'node.patch', payload: { id: 'draft-node', composer_draft: first, composer_draft_window_id: 'window-b' } }],
    }), /node not found/i);
  });

  test('rejects cross-workspace edges and rolls back the whole batch', () => {
    applyWorkspaceCommands('ws-a', {
      operationId: 'seed-a',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-a', name: 'A', created_at: 1, updated_at: 1 } },
        { type: 'node.upsert', payload: { id: 'a', workspace_id: 'ws-a', tree_id: null, parent_node_id: null, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 } },
      ],
    });
    applyWorkspaceCommands('ws-b', {
      operationId: 'seed-b',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-b', name: 'B', created_at: 1, updated_at: 1 } },
        { type: 'node.upsert', payload: { id: 'b', workspace_id: 'ws-b', tree_id: null, parent_node_id: null, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 } },
      ],
    });
    assert.throws(() => applyWorkspaceCommands('ws-a', {
      operationId: 'bad-edge',
      commands: [{ type: 'edge.upsert', payload: { id: 'link-a-b', workspace_id: 'ws-a', source_node_id: 'a', target_node_id: 'b', kind: 'link' } }],
    }), /same workspace/i);
    assert.equal(listEdges('ws-a').length, 0);
  });

  test('rejects branch and link edges between trees', () => {
    applyWorkspaceCommands('ws-1', {
      operationId: 'seed-trees',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Workspace', active_tree_id: 'tree-1' } },
        { type: 'tree.upsert', payload: { id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'root-1' } },
        { type: 'tree.upsert', payload: { id: 'tree-2', workspace_id: 'ws-1', root_node_id: 'root-2' } },
        { type: 'node.upsert', payload: { id: 'root-1', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: null } },
        { type: 'node.upsert', payload: { id: 'root-2', workspace_id: 'ws-1', tree_id: 'tree-2', parent_node_id: null } },
      ],
    });
    for (const kind of ['branch', 'link']) {
      assert.throws(() => applyWorkspaceCommands('ws-1', {
        operationId: `cross-${kind}`,
        commands: [{ type: 'edge.upsert', payload: { id: `cross-${kind}`, workspace_id: 'ws-1', source_node_id: 'root-1', target_node_id: 'root-2', kind } }],
      }), (error: any) => error.code === 'edge_tree_mismatch');
    }
    assert.equal(listEdges('ws-1').length, 0);
  });

  test('node pinned_at round-trips through node.upsert and node.patch (migration 0021)', () => {
    applyWorkspaceCommands('ws-1', {
      operationId: 'pin-seed',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Pins', created_at: 1, updated_at: 1 } },
        { type: 'node.upsert', payload: { id: 'n1', workspace_id: 'ws-1', tree_id: null, parent_node_id: null, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, pinned_at: 111, created_at: 1 } },
      ],
    });
    assert.equal(getNode('n1')?.pinned_at, 111);

    // Patch path (what the frontend sends on every dirty node) can pin…
    applyWorkspaceCommands('ws-1', {
      operationId: 'pin-patch',
      commands: [{ type: 'node.patch', payload: { id: 'n1', pinned_at: 222 } }],
    });
    assert.equal(getNode('n1')?.pinned_at, 222);

    // …and unpin (explicit null clears it).
    applyWorkspaceCommands('ws-1', {
      operationId: 'unpin-patch',
      commands: [{ type: 'node.patch', payload: { id: 'n1', pinned_at: null } }],
    });
    assert.equal(getNode('n1')?.pinned_at, null);

    // A patch that omits pinned_at leaves the stored value alone.
    applyWorkspaceCommands('ws-1', {
      operationId: 'repin',
      commands: [{ type: 'node.patch', payload: { id: 'n1', pinned_at: 333 } }],
    });
    applyWorkspaceCommands('ws-1', {
      operationId: 'width-only',
      commands: [{ type: 'node.patch', payload: { id: 'n1', pane_width: 420 } }],
    });
    assert.equal(getNode('n1')?.pinned_at, 333);
    assert.equal(getNode('n1')?.pane_width, 420);
  });

  test('workspace commands preserve the existing runtime backend', () => {
    saveWorkspace({
      id: 'ws-1', name: 'Before', created_at: 1, updated_at: 1, backend: 'claude',
    });

    applyWorkspaceCommands('ws-1', {
      operationId: 'rename-only',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-1', name: 'After' } }],
    });

    assert.equal(getWorkspace('ws-1')?.name, 'After');
    assert.equal(getWorkspace('ws-1')?.backend, 'claude');
  });

  test('workspace commands persist folder configuration', () => {
    const folders = JSON.stringify([{ id: 'root', path: '/workspace', addedAt: 1 }, { id: 'extra', path: '/reference', addedAt: 2 }]);
    applyWorkspaceCommands('ws-1', {
      operationId: 'folders-seed',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Folders', cwd: '/workspace', folders } }],
    });

    assert.equal(getWorkspace('ws-1')?.cwd, '/workspace');
    assert.equal(getWorkspace('ws-1')?.folders, folders);
  });

  test('workspace commands preserve omitted folders and clear an explicit null', () => {
    const folders = JSON.stringify([{ id: 'root', path: '/workspace', addedAt: 1 }]);
    saveWorkspace({ id: 'ws-1', name: 'Before', cwd: '/workspace', folders, created_at: 1, updated_at: 1 });
    applyWorkspaceCommands('ws-1', {
      operationId: 'folders-rename',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-1', name: 'After' } }],
    });
    assert.equal(getWorkspace('ws-1')?.folders, folders);

    applyWorkspaceCommands('ws-1', {
      operationId: 'folders-clear',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-1', cwd: null, folders: null } }],
    });
    assert.equal(getWorkspace('ws-1')?.folders, null);
    assert.equal(getWorkspace('ws-1')?.cwd, null);
  });

  test('rejects tree, edge, and context ids that already belong to another workspace', () => {
    applyWorkspaceCommands('ws-a', {
      operationId: 'seed-collision-a',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-a', name: 'A', created_at: 1, updated_at: 1 } },
        { type: 'tree.upsert', payload: { id: 'tree-shared', workspace_id: 'ws-a', root_node_id: 'a1', name: 'A tree', last_active_at: 1, created_at: 1 } },
        { type: 'node.upsert', payload: { id: 'a1', workspace_id: 'ws-a', tree_id: 'tree-shared', parent_node_id: null, kind: 'chat', created_at: 1 } },
        { type: 'node.upsert', payload: { id: 'a2', workspace_id: 'ws-a', tree_id: 'tree-shared', parent_node_id: 'a1', kind: 'chat', created_at: 2 } },
        { type: 'edge.upsert', payload: { id: 'edge-shared', workspace_id: 'ws-a', source_node_id: 'a1', target_node_id: 'a2', kind: 'branch' } },
        { type: 'context.upsert', payload: { id: 'ctx-shared', workspace_id: 'ws-a', name: 'a-context', file_path: '/a.md' } },
      ],
    });
    applyWorkspaceCommands('ws-b', {
      operationId: 'seed-collision-b',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-b', name: 'B', created_at: 1, updated_at: 1 } },
        { type: 'node.upsert', payload: { id: 'b1', workspace_id: 'ws-b', tree_id: null, parent_node_id: null, kind: 'chat', created_at: 1 } },
        { type: 'node.upsert', payload: { id: 'b2', workspace_id: 'ws-b', tree_id: null, parent_node_id: null, kind: 'chat', created_at: 2 } },
      ],
    });

    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'collide-tree',
      commands: [{ type: 'tree.upsert', payload: { id: 'tree-shared', workspace_id: 'ws-b', root_node_id: 'b1', name: 'B tree' } }],
    }), /different workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'collide-edge',
      commands: [{ type: 'edge.upsert', payload: { id: 'edge-shared', workspace_id: 'ws-b', source_node_id: 'b1', target_node_id: 'b2', kind: 'branch' } }],
    }), /different workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'collide-context',
      commands: [{ type: 'context.upsert', payload: { id: 'ctx-shared', workspace_id: 'ws-b', name: 'b-context', file_path: '/b.md' } }],
    }), /different workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'delete-foreign-tree',
      commands: [{ type: 'tree.delete', payload: { id: 'tree-shared' } }],
    }), /different workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'delete-foreign-edge',
      commands: [{ type: 'edge.delete', payload: { id: 'edge-shared' } }],
    }), /different workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'delete-foreign-context',
      commands: [{ type: 'context.delete', payload: { id: 'ctx-shared' } }],
    }), /different workspace/i);

    assert.equal(listTrees('ws-a')[0]?.name, 'A tree');
    assert.equal(listEdges('ws-a')[0]?.source_node_id, 'a1');
    assert.equal(listContexts('ws-a')[0]?.name, 'a-context');
  });

  test('rejects cross-workspace tree references, roots, and context origins', () => {
    applyWorkspaceCommands('ws-a', {
      operationId: 'seed-reference-a',
      commands: [
        { type: 'workspace.upsert', payload: { id: 'ws-a', name: 'A', created_at: 1, updated_at: 1 } },
        { type: 'tree.upsert', payload: { id: 'tree-a', workspace_id: 'ws-a', root_node_id: 'a-root', last_active_at: 1, created_at: 1 } },
        { type: 'node.upsert', payload: { id: 'a-root', workspace_id: 'ws-a', tree_id: 'tree-a', parent_node_id: null, kind: 'chat', created_at: 1 } },
      ],
    });
    applyWorkspaceCommands('ws-b', {
      operationId: 'seed-reference-b',
      commands: [{ type: 'workspace.upsert', payload: { id: 'ws-b', name: 'B', created_at: 1, updated_at: 1 } }],
    });

    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'foreign-tree-ref',
      commands: [{ type: 'node.upsert', payload: { id: 'b-node', workspace_id: 'ws-b', tree_id: 'tree-a', parent_node_id: null, kind: 'chat', created_at: 1 } }],
    }), /tree.*same workspace|different workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'foreign-tree-root',
      commands: [{ type: 'tree.upsert', payload: { id: 'tree-b', workspace_id: 'ws-b', root_node_id: 'a-root', last_active_at: 1, created_at: 1 } }],
    }), /root.*same workspace/i);
    assert.throws(() => applyWorkspaceCommands('ws-b', {
      operationId: 'foreign-context-origin',
      commands: [{ type: 'context.upsert', payload: { id: 'ctx-b', workspace_id: 'ws-b', name: 'ctx-b', file_path: '/b.md', origin_node_id: 'a-root' } }],
    }), /origin.*same workspace/i);

    assert.equal(getNode('b-node'), null);
    assert.equal(listTrees('ws-b').length, 0);
    assert.equal(listContexts('ws-b').length, 0);
  });

  describe('a deleted artifact stays deleted (context_tombstones)', () => {
    const contextRow = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
      id, workspace_id: 'ws-1', name, file_path: `.contexts/${name}.md`, source: 'agent', kind: 'embedded', created_at: 1, updated_at: 1, ...extra,
    });
    const upsert = (operationId: string, id: string, name: string, extra: Record<string, unknown> = {}) => applyWorkspaceCommands('ws-1', {
      operationId, commands: [{ type: 'context.upsert', payload: contextRow(id, name, extra) }],
    });
    /** The Artifacts drawer's Delete, as the dirty delta sends it. */
    const remove = (operationId: string, id: string) => applyWorkspaceCommands('ws-1', {
      operationId, commands: [{ type: 'context.delete', payload: { id } }],
    });
    const contexts = () => listContexts('ws-1').map((row) => [row.id, row.name]);

    beforeEach(() => {
      applyWorkspaceCommands('ws-1', {
        operationId: 'seed',
        commands: [
          { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Workspace', active_tree_id: 'tree-1' } },
          { type: 'tree.upsert', payload: { id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'root' } },
          { type: 'node.upsert', payload: { id: 'root', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: null } },
          { type: 'node.upsert', payload: { id: 'branch', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: 'root' } },
        ],
      });
    });

    test('a later upsert of its id is skipped and reported gone; the rest of the batch applies', () => {
      upsert('create', 'ctx-a', 'notes');
      assert.deepEqual(remove('delete', 'ctx-a').applied, [{ type: 'context.delete', id: 'ctx-a' }]);
      assert.equal(isContextTombstoned('ctx-a'), true);

      // A stale window pins its copy and renames the workspace in the same batch.
      const stale = {
        operationId: 'stale-pin',
        commands: [
          { type: 'context.upsert', payload: contextRow('ctx-a', 'notes', { pinned_at: 5 }) },
          { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Renamed' } },
        ],
      } as const;
      const result = applyWorkspaceCommands('ws-1', stale);
      assert.deepEqual(result.applied, [{ type: 'workspace.upsert', id: 'ws-1' }]);
      assert.deepEqual(result.goneContextIds, ['ctx-a']);
      assert.deepEqual(contexts(), []);
      assert.equal(getWorkspace('ws-1')?.name, 'Renamed');
      // A retry of the same operation answers the same.
      assert.deepEqual(applyWorkspaceCommands('ws-1', stale), result);
      assert.deepEqual(contexts(), []);
    });

    test('a batch with nothing deleted answers no goneContextIds', () => {
      const result = upsert('create', 'ctx-a', 'notes');
      assert.equal('goneContextIds' in result, false);
      assert.deepEqual(result.applied, [{ type: 'context.upsert', id: 'ctx-a' }]);
    });

    test('an artifact saved again under the deleted name, with a new id, is created', () => {
      upsert('create', 'ctx-a', 'notes');
      remove('delete', 'ctx-a');
      const result = upsert('recreate', 'ctx-b', 'notes');
      assert.deepEqual(result.applied, [{ type: 'context.upsert', id: 'ctx-b' }]);
      assert.deepEqual(contexts(), [['ctx-b', 'notes']]);
    });

    test('a stale upsert of the old id while a new artifact holds its name is gone, not a UNIQUE failure', () => {
      upsert('create', 'ctx-a', 'notes');
      remove('delete', 'ctx-a');
      upsert('recreate', 'ctx-b', 'notes');
      // Without the tombstone this insert broke UNIQUE(workspace_id, name): a 500 the sender retried forever.
      const result = upsert('stale', 'ctx-a', 'notes', { pinned_at: 9 });
      assert.deepEqual(result.goneContextIds, ['ctx-a']);
      assert.deepEqual(contexts(), [['ctx-b', 'notes']]);
    });

    test('a stale upsert whose origin thread was purged since is gone, not a conflict', () => {
      upsert('create', 'ctx-a', 'notes', { origin_node_id: 'branch' });
      remove('delete', 'ctx-a');
      purgeWorkspaceNodes('ws-1', ['branch']);
      assert.equal(getNode('branch'), null);
      // Without the tombstone: context_origin_workspace_mismatch, a 409 the sender kept re-reading for.
      const result = upsert('stale', 'ctx-a', 'notes', { origin_node_id: 'branch' });
      assert.deepEqual(result.goneContextIds, ['ctx-a']);
      assert.deepEqual(contexts(), []);
    });

    test('deleting an artifact that is not there tombstones nothing', () => {
      remove('delete-missing', 'ctx-never');
      assert.equal(isContextTombstoned('ctx-never'), false);
      assert.deepEqual(upsert('create', 'ctx-never', 'notes').applied, [{ type: 'context.upsert', id: 'ctx-never' }]);
    });

    describe("an older window's id takeover: another artifact written under a live one's name, the live one deleted", () => {
      /** A batch of an older window (no artifactIdentity), or of one that matches artifacts by id only. */
      const batch = (operationId: string, commands: WorkspaceCommand[], artifactIdentity?: 'id') =>
        applyWorkspaceCommands('ws-1', { operationId, commands, ...(artifactIdentity ? { artifactIdentity } : {}) });
      const deleteOf = (id: string): WorkspaceCommand => ({ type: 'context.delete', payload: { id } });
      /**
       * What such a window sends once a reconnect replays A's save: C's row
       * under A's id (C's created_at, source and pin kept), then C's delete.
       */
      const takeoverOfC = (name = 'notes'): WorkspaceCommand[] => [
        { type: 'context.upsert', payload: contextRow('ctx-a', name, { source: 'user', pinned_at: 4, created_at: 7 }) },
        deleteOf('ctx-c'),
      ];
      /** A "notes" deleted, then C made as "notes", as the backend holds them. */
      const deletedThenRetaken = (name = 'notes') => {
        upsert('create', 'ctx-a', name);
        remove('delete', 'ctx-a');
        upsert('recreate', 'ctx-c', 'notes', { source: 'user', pinned_at: 4, created_at: 7 });
      };
      const keptC = () => {
        assert.deepEqual(contexts().filter(([id]) => id === 'ctx-c'), [['ctx-c', 'notes']]);
        assert.equal(isContextTombstoned('ctx-c'), false);
      };
      const WINDOW = 'window-old-1';

      test('keeps the live one: neither deleted nor tombstoned, while the rest of the batch applies', () => {
        deletedThenRetaken();
        const [write, deleteC] = takeoverOfC();
        const takeover = batch('takeover', [write, { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Renamed' } }, deleteC]);
        assert.deepEqual(takeover.applied, [{ type: 'workspace.upsert', id: 'ws-1' }]);
        assert.deepEqual(takeover.goneContextIds, ['ctx-a']);
        keptC();
        assert.equal(getWorkspace('ws-1')?.name, 'Renamed');
      });

      test('also when the reported name differs only in case, as those windows matched it', () => {
        deletedThenRetaken('Notes');
        const takeover = batch('takeover', takeoverOfC('Notes'));
        assert.deepEqual(takeover.applied, []);
        keptC();
      });

      test('also when the deleted artifact left no tombstone (deleted before migration 0081): its write is answered name-taken', () => {
        upsert('create', 'ctx-a', 'notes');
        getDb().prepare("DELETE FROM contexts WHERE id = 'ctx-a'").run();
        upsert('recreate', 'ctx-c', 'notes', { source: 'user', pinned_at: 4, created_at: 7 });
        assert.equal(isContextTombstoned('ctx-a'), false);
        const takeover = batch('takeover', takeoverOfC());
        assert.deepEqual(takeover.applied, []);
        assert.deepEqual(takeover.nameTakenContextIds, ['ctx-a']);
        assert.deepEqual(contexts(), [['ctx-c', 'notes']]);
        assert.equal(isContextTombstoned('ctx-c'), false);
      });

      test('also once the deleted artifact\'s tombstone was collected', () => {
        deletedThenRetaken();
        getDb().prepare("UPDATE context_tombstones SET deleted_at = ? WHERE id = 'ctx-a'").run(Date.now() - TOMBSTONE_TTL_MS - 1);
        runTombstoneGc();
        assert.equal(isContextTombstoned('ctx-a'), false);
        const takeover = batch('takeover', takeoverOfC());
        assert.deepEqual(takeover.nameTakenContextIds, ['ctx-a']);
        assert.deepEqual(contexts(), [['ctx-c', 'notes']]);
        assert.equal(isContextTombstoned('ctx-c'), false);
      });

      test('also when the artifact written under its name is live under another one, which it keeps', () => {
        upsert('create-a', 'ctx-a', 'bar');
        upsert('create-c', 'ctx-c', 'notes', { source: 'user', pinned_at: 4, created_at: 7 });
        const takeover = batch('takeover', takeoverOfC());
        assert.deepEqual(takeover.nameTakenContextIds, ['ctx-a']);
        assert.deepEqual(contexts(), [['ctx-a', 'bar'], ['ctx-c', 'notes']]);
        assert.equal(isContextTombstoned('ctx-c'), false);
      });

      test('also when the flush went in two chunks, the write in the first and the delete in the next, from the same window', () => {
        deletedThenRetaken();
        const [write, deleteC] = takeoverOfC();
        const first = runWithStructureOrigin(WINDOW, () => batch('chunk-1', [write]));
        assert.deepEqual(first.goneContextIds, ['ctx-a']);
        const second = runWithStructureOrigin(WINDOW, () => batch('chunk-2', [deleteC]));
        assert.deepEqual(second.applied, []);
        keptC();
        // Another window's delete of it is that window's own.
        const elsewhere = runWithStructureOrigin('window-old-2', () => batch('elsewhere', [deleteC]));
        assert.deepEqual(elsewhere.applied, [{ type: 'context.delete', id: 'ctx-c' }]);
        assert.equal(isContextTombstoned('ctx-c'), true);
      });

      describe('the bridge between two chunks of one flush (review 4, findings 1 and 2)', () => {
        /** `run` with the clock `ms` ahead. */
        const later = <T>(ms: number, run: () => T): T => {
          const now = Date.now() + ms;
          const clock = mock.method(Date, 'now', () => now);
          try {
            return run();
          } finally {
            clock.mock.restore();
          }
        };
        const fromWindow = <T>(run: () => T, windowId = WINDOW): T => runWithStructureOrigin(windowId, run);
        const deleted = (id: string) => {
          assert.deepEqual(contexts().filter(([live]) => live === id), []);
          assert.equal(isContextTombstoned(id), true);
        };

        test('also when the write was answered name-taken (no tombstone left), and so for an unload beacon\'s chunks', () => {
          upsert('create', 'ctx-a', 'notes');
          getDb().prepare("DELETE FROM contexts WHERE id = 'ctx-a'").run();
          upsert('recreate', 'ctx-c', 'notes', { source: 'user', pinned_at: 4, created_at: 7 });
          const [write, deleteC] = takeoverOfC();
          assert.deepEqual(fromWindow(() => batch('chunk-1', [write])).nameTakenContextIds, ['ctx-a']);
          assert.deepEqual(fromWindow(() => batch('chunk-2', [deleteC])).applied, []);
          keptC();
          // An older frontend's beacons carry no window id: one unload's chunks share its stamp.
          assert.deepEqual(batch('unload-ws-1-1731400000000-0', [write]).nameTakenContextIds, ['ctx-a']);
          assert.deepEqual(batch('unload-ws-1-1731400000000-1', [deleteC]).applied, []);
          keptC();
        });

        test("is spent by the delete it held: the window's next delete of the live one, a moment later, deletes it", () => {
          deletedThenRetaken();
          const [write, deleteC] = takeoverOfC();
          fromWindow(() => batch('chunk-1', [write]));
          assert.deepEqual(fromWindow(() => batch('chunk-2', [deleteC])).applied, []);
          keptC();
          // The user deletes it now (that window reloaded and sees it again).
          assert.deepEqual(fromWindow(() => batch('user-delete', [deleteC])).applied, [{ type: 'context.delete', id: 'ctx-c' }]);
          deleted('ctx-c');
        });

        test('holds only within TAKEOVER_BRIDGE_TTL_MS: a delete 31 s later deletes', () => {
          deletedThenRetaken();
          const [write, deleteC] = takeoverOfC();
          fromWindow(() => batch('chunk-1', [write]));
          assert.deepEqual(later(31_000, () => fromWindow(() => batch('chunk-2', [deleteC]))).applied, [{ type: 'context.delete', id: 'ctx-c' }]);
          deleted('ctx-c');
        });

        test("R4: an older window's new artifact answered name-taken, then that window's delete of the one holding the name, later: deleted", () => {
          // C "notes" is live; the window, which had not heard of it, made N "notes".
          upsert('create-c', 'ctx-c', 'notes');
          const made = fromWindow(() => batch('make-n', [{ type: 'context.upsert', payload: contextRow('ctx-n', 'notes') }]));
          assert.deepEqual(made.nameTakenContextIds, ['ctx-n']);
          // C's report re-keyed N to C there; the user deletes "notes".
          assert.deepEqual(later(31_000, () => fromWindow(() => batch('delete-c', [deleteOf('ctx-c')]))).applied,
            [{ type: 'context.delete', id: 'ctx-c' }]);
          deleted('ctx-c');
        });

        test('R3: batches without a window id (other than one unload\'s beacons) share no bridge: the delete is applied', () => {
          upsert('create-c', 'ctx-c', 'notes');
          // One older window's beacon skipped N's write...
          assert.deepEqual(batch('unload-ws-1-1731400000000-0', [{ type: 'context.upsert', payload: contextRow('ctx-n', 'notes') }])
            .nameTakenContextIds, ['ctx-n']);
          // ...and another's beacon (another unload), or a batch with no window id at all, deletes C.
          assert.deepEqual(batch('unload-ws-1-1731400000999-0', [deleteOf('ctx-c')]).applied, [{ type: 'context.delete', id: 'ctx-c' }]);
          deleted('ctx-c');
          upsert('create-d', 'ctx-d', 'plan');
          assert.deepEqual(batch('plain-1', [{ type: 'context.upsert', payload: contextRow('ctx-m', 'plan') }]).nameTakenContextIds, ['ctx-m']);
          assert.deepEqual(batch('plain-2', [deleteOf('ctx-d')]).applied, [{ type: 'context.delete', id: 'ctx-d' }]);
          deleted('ctx-d');
        });

        test('holds only the artifact that held the name then: a later one under that name is deleted', () => {
          deletedThenRetaken();
          remove('delete-c', 'ctx-c');
          // The window's write of A is answered gone, and no live artifact holds "notes": nothing is noted.
          assert.deepEqual(fromWindow(() => batch('write-a', [takeoverOfC()[0]])).goneContextIds, ['ctx-a']);
          // Another window makes E "notes"; this window hears of it, and its user deletes it.
          batch('make-e', [{ type: 'context.upsert', payload: contextRow('ctx-e', 'notes') }], 'id');
          assert.deepEqual(fromWindow(() => batch('delete-e', [deleteOf('ctx-e')])).applied, [{ type: 'context.delete', id: 'ctx-e' }]);
          deleted('ctx-e');
        });

        test('notes nothing when the batch decided the delete itself: the next delete from that window deletes', () => {
          deletedThenRetaken();
          assert.deepEqual(fromWindow(() => batch('takeover', takeoverOfC())).applied, []);
          keptC();
          assert.deepEqual(fromWindow(() => batch('user-delete', [deleteOf('ctx-c')])).applied, [{ type: 'context.delete', id: 'ctx-c' }]);
          deleted('ctx-c');
        });
      });

      test('a window that matches artifacts by id only deletes it: its write of a deleted artifact under that name is its own', () => {
        deletedThenRetaken('Notes');
        // It missed another window's delete of A ("Notes"), pins A and deletes C in one flush.
        const flush = batch('pin-and-delete', [
          { type: 'context.upsert', payload: contextRow('ctx-a', 'Notes', { pinned_at: 9 }) }, deleteOf('ctx-c'),
        ], 'id');
        assert.deepEqual(flush.applied, [{ type: 'context.delete', id: 'ctx-c' }]);
        assert.deepEqual(flush.goneContextIds, ['ctx-a']);
        assert.deepEqual(contexts(), []);
        assert.equal(isContextTombstoned('ctx-c'), true);
      });

      test('"delete notes, make a new notes" in one flush: deleted and made from a window that matches by id, kept from an older one', () => {
        deletedThenRetaken();
        const replace: WorkspaceCommand[] = [
          { type: 'context.upsert', payload: contextRow('ctx-e', 'notes', { created_at: 20 }) }, deleteOf('ctx-c'),
        ];
        // An older window: kept (that batch failed whole before, a 500 retried forever); the new one is named.
        const older = batch('replace-older', replace);
        assert.deepEqual(older.applied, []);
        assert.deepEqual(older.nameTakenContextIds, ['ctx-e']);
        keptC();
        // The same flush from a window that matches by id.
        const current = batch('replace', replace, 'id');
        assert.deepEqual(current.applied, [{ type: 'context.delete', id: 'ctx-c' }, { type: 'context.upsert', id: 'ctx-e' }]);
        assert.deepEqual(contexts(), [['ctx-e', 'notes']]);
        assert.equal(isContextTombstoned('ctx-c'), true);
      });

      test('a delete in any other batch, or beside a write under another name, deletes and tombstones', () => {
        deletedThenRetaken();
        upsert('other', 'ctx-d', 'plan');
        // The deleted one written back under another name than the live one's.
        assert.deepEqual(batch('other-name', [
          { type: 'context.upsert', payload: contextRow('ctx-a', 'plan-old') }, deleteOf('ctx-d'),
        ]).applied, [{ type: 'context.delete', id: 'ctx-d' }]);
        assert.equal(isContextTombstoned('ctx-d'), true);
        // A plain delete, from an older window and from a current one.
        assert.deepEqual(remove('plain', 'ctx-c').applied, [{ type: 'context.delete', id: 'ctx-c' }]);
        assert.equal(isContextTombstoned('ctx-c'), true);
        upsert('another', 'ctx-f', 'draft');
        assert.deepEqual(batch('plain-current', [deleteOf('ctx-f')], 'id').applied, [{ type: 'context.delete', id: 'ctx-f' }]);
        assert.deepEqual(contexts(), []);
      });
    });
  });

  describe("in cloud mode, another user's artifacts", () => {
    const savedCloud = process.env.MICHI_CLOUD;
    afterEach(() => {
      if (savedCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = savedCloud;
    });
    const row = (id: string, workspaceId: string, name: string) => ({
      id, workspace_id: workspaceId, name, file_path: `.contexts/${name}.md`, source: 'user', created_at: 1, updated_at: 1,
    });
    const batch = (workspaceId: string, owner: string, operationId: string, commands: WorkspaceCommand[]) =>
      () => applyWorkspaceCommands(workspaceId, { operationId, commands, ownerUserId: owner });
    /** How a batch failed, with the id it names left out. */
    const failure = (run: () => unknown, id: string) => {
      try {
        run();
      } catch (error) {
        assert.ok(error instanceof DomainError);
        return { kind: error.kind, code: error.code, message: error.message.replace(id, '<id>'), details: { ...error.details, entityId: '<id>' } };
      }
      return assert.fail('the batch committed');
    };

    beforeEach(() => {
      process.env.MICHI_CLOUD = '1';
      batch('ws-alice', 'alice', 'seed-alice', [
        { type: 'workspace.upsert', payload: { id: 'ws-alice', name: 'Alice' } },
        { type: 'context.upsert', payload: row('ctx-live', 'ws-alice', 'live') },
        { type: 'context.upsert', payload: row('ctx-deleted', 'ws-alice', 'deleted') },
      ])();
      batch('ws-alice', 'alice', 'delete-alice', [{ type: 'context.delete', payload: { id: 'ctx-deleted' } }])();
      batch('ws-bob', 'bob', 'seed-bob', [{ type: 'workspace.upsert', payload: { id: 'ws-bob', name: 'Bob' } }])();
    });

    test("one deleted there answers a write from another workspace as a live one does, never gone", () => {
      assert.equal(isContextTombstoned('ctx-deleted'), true);
      for (const type of ['context.upsert', 'context.delete'] as const) {
        const command = (id: string): WorkspaceCommand => ({ type, payload: type === 'context.upsert' ? row(id, 'ws-bob', 'probe') : { id } });
        const live = failure(batch('ws-bob', 'bob', `${type}-live`, [command('ctx-live')]), 'ctx-live');
        assert.equal(live.code, 'entity_workspace_mismatch');
        // Bob cannot tell whether Alice deleted it.
        assert.deepEqual(failure(batch('ws-bob', 'bob', `${type}-deleted`, [command('ctx-deleted')]), 'ctx-deleted'), live, type);
      }
      assert.deepEqual(listContexts('ws-bob'), []);
      // Alice's own stale write of it is still answered gone.
      assert.deepEqual(batch('ws-alice', 'alice', 'stale-alice', [
        { type: 'context.upsert', payload: row('ctx-deleted', 'ws-alice', 'deleted') },
      ])().goneContextIds, ['ctx-deleted']);
    });

    test('a batch from someone else deletes and tombstones none of them, sent to her workspace or to his', () => {
      const deleteLive: WorkspaceCommand[] = [{ type: 'context.delete', payload: { id: 'ctx-live' } }];
      assert.equal(failure(batch('ws-alice', 'bob', 'bob-in-alice', deleteLive), 'ctx-live').code, 'workspace_not_found');
      assert.equal(failure(batch('ws-bob', 'bob', 'bob-in-bob', deleteLive), 'ctx-live').code, 'entity_workspace_mismatch');
      assert.deepEqual(listContexts('ws-alice').map((context) => context.id), ['ctx-live']);
      assert.equal(isContextTombstoned('ctx-live'), false);
      // Nor can his batch write over one of hers.
      assert.equal(failure(batch('ws-alice', 'bob', 'bob-upsert', [
        { type: 'context.upsert', payload: { ...row('ctx-live', 'ws-alice', 'taken'), pinned_at: 1 } },
      ]), 'ctx-live').code, 'workspace_not_found');
      assert.equal(listContexts('ws-alice')[0]?.name, 'live');
      // Hers deletes it, and tombstones it.
      assert.deepEqual(batch('ws-alice', 'alice', 'alice-delete', deleteLive)().applied, [{ type: 'context.delete', id: 'ctx-live' }]);
      assert.equal(isContextTombstoned('ctx-live'), true);
    });

    test("his churn of window ids never pushes out her older window's bridge between two chunks (review 4, finding 2)", () => {
      const write = (workspaceId: string, id: string, name: string): WorkspaceCommand =>
        ({ type: 'context.upsert', payload: row(id, workspaceId, name) });
      // Her older window's takeover: the write under "live" in one chunk (held by ctx-live)...
      assert.deepEqual(runWithStructureOrigin('alice-window', batch('ws-alice', 'alice', 'alice-chunk-1', [write('ws-alice', 'ctx-x', 'live')]))
        .nameTakenContextIds, ['ctx-x']);
      // ...while his batches from 600 window ids each leave a bridge in his own workspace...
      batch('ws-bob', 'bob', 'bob-seed', [write('ws-bob', 'ctx-b', 'b')])();
      for (let i = 0; i < 600; i += 1) {
        runWithStructureOrigin(`bob-window-${i}`, batch('ws-bob', 'bob', `bob-${i}`, [write('ws-bob', `ctx-b-${i}`, 'b')]));
      }
      // ...and the delete in her next chunk is still that takeover's.
      assert.deepEqual(runWithStructureOrigin('alice-window', batch('ws-alice', 'alice', 'alice-chunk-2', [
        { type: 'context.delete', payload: { id: 'ctx-live' } },
      ])).applied, []);
      assert.deepEqual(listContexts('ws-alice').map((context) => context.id), ['ctx-live']);
      assert.equal(isContextTombstoned('ctx-live'), false);
    });
  });

  describe('an upsert under a name another artifact holds (UNIQUE(workspace_id, name))', () => {
    const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
      id, workspace_id: 'ws-1', name, file_path: `.contexts/${id}.md`, source: 'user', created_at: 1, updated_at: 1, ...extra,
    });
    const upsert = (id: string, name: string, extra: Record<string, unknown> = {}): WorkspaceCommand =>
      ({ type: 'context.upsert', payload: row(id, name, extra) });
    // As the current frontend sends them (an older window's deletes are checked for takeovers above).
    const run = (operationId: string, commands: WorkspaceCommand[]) =>
      applyWorkspaceCommands('ws-1', { operationId, commands, artifactIdentity: 'id' });
    const contexts = () => listContexts('ws-1').map((context) => [context.id, context.name, context.pinned_at ?? null]);

    beforeEach(() => {
      run('seed', [{ type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Workspace' } }, upsert('ctx-c', 'foo')]);
    });

    test("a stale window's write is skipped and named, not a failed batch; the rest of it applies", () => {
      // Window 1 renames C to "bar" and saves D as "foo".
      run('window-1', [upsert('ctx-c', 'bar'), upsert('ctx-d', 'foo')]);
      // A stale window pins C, still "foo", and renames the workspace. Before: a SQLite UNIQUE error, a 500 retried forever.
      const stale = {
        operationId: 'stale', artifactIdentity: 'id',
        commands: [upsert('ctx-c', 'foo', { pinned_at: 5 }), { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Renamed' } }],
      } as const;
      const result = applyWorkspaceCommands('ws-1', stale);
      assert.deepEqual(result.applied, [{ type: 'workspace.upsert', id: 'ws-1' }]);
      assert.deepEqual(result.nameTakenContextIds, ['ctx-c']);
      // C is alive: not gone.
      assert.equal('goneContextIds' in result, false);
      assert.deepEqual(contexts(), [['ctx-c', 'bar', null], ['ctx-d', 'foo', null]]);
      assert.equal(getWorkspace('ws-1')?.name, 'Renamed');
      assert.deepEqual(applyWorkspaceCommands('ws-1', stale), result);
    });

    test('also when the artifact holding the name was written earlier in the same batch', () => {
      const result = run('same-batch', [upsert('ctx-d', 'bar'), upsert('ctx-e', 'bar', { pinned_at: 5 })]);
      assert.deepEqual(result.applied, [{ type: 'context.upsert', id: 'ctx-d' }]);
      assert.deepEqual(result.nameTakenContextIds, ['ctx-e']);
      assert.deepEqual(contexts(), [['ctx-c', 'foo', null], ['ctx-d', 'bar', null]]);
    });

    test('a name the batch frees after the write that takes it is taken once it is free', () => {
      run('seed-d', [upsert('ctx-d', 'bar')]);
      // "foo" deleted and "bar" renamed to "foo" in one flush: upserts go before deletes.
      const renamed = run('rename-into-deleted', [upsert('ctx-d', 'foo'), { type: 'context.delete', payload: { id: 'ctx-c' } }]);
      assert.deepEqual(renamed.applied, [{ type: 'context.delete', id: 'ctx-c' }, { type: 'context.upsert', id: 'ctx-d' }]);
      assert.equal('nameTakenContextIds' in renamed, false);
      assert.deepEqual(contexts(), [['ctx-d', 'foo', null]]);
      // A rename into a name the next upsert renames away from.
      run('seed-e', [upsert('ctx-e', 'bar')]);
      const swapped = run('rename-chain', [upsert('ctx-e', 'foo'), upsert('ctx-d', 'baz')]);
      assert.deepEqual(swapped.applied, [{ type: 'context.upsert', id: 'ctx-d' }, { type: 'context.upsert', id: 'ctx-e' }]);
      assert.deepEqual(contexts(), [['ctx-d', 'baz', null], ['ctx-e', 'foo', null]]);
      // Two that swap names cannot both have theirs: both are named.
      assert.deepEqual(run('swap', [upsert('ctx-d', 'foo'), upsert('ctx-e', 'baz')]).nameTakenContextIds?.sort(), ['ctx-d', 'ctx-e']);
      assert.deepEqual(contexts(), [['ctx-d', 'baz', null], ['ctx-e', 'foo', null]]);
    });

    test('a chain of renames frees one name after another; a later write of the same artifact wins', () => {
      run('seed-chain', [upsert('ctx-d', 'bar'), upsert('ctx-e', 'baz')]);
      // C foo -> bar, D bar -> baz, E baz -> qux: each name is free only once the next rename is written.
      const chain = run('chain', [upsert('ctx-c', 'bar'), upsert('ctx-d', 'baz'), upsert('ctx-e', 'qux')]);
      assert.equal('nameTakenContextIds' in chain, false);
      assert.deepEqual(chain.applied.map((entry) => entry.id), ['ctx-e', 'ctx-d', 'ctx-c']);
      assert.deepEqual(contexts(), [['ctx-c', 'bar', null], ['ctx-d', 'baz', null], ['ctx-e', 'qux', null]]);
      // A held upsert that a later one of the same artifact supersedes is not
      // written after it at the end of the batch.
      const superseded = run('superseded', [
        upsert('ctx-e', 'bar'), { type: 'context.delete', payload: { id: 'ctx-c' } }, upsert('ctx-e', 'quux'),
      ]);
      assert.deepEqual(superseded.applied, [{ type: 'context.delete', id: 'ctx-c' }, { type: 'context.upsert', id: 'ctx-e' }]);
      assert.equal('nameTakenContextIds' in superseded, false);
      assert.deepEqual(contexts(), [['ctx-d', 'baz', null], ['ctx-e', 'quux', null]]);
    });

    test('names are matched as the UNIQUE constraint matches them: exactly', () => {
      const result = run('case', [upsert('ctx-d', 'Foo')]);
      assert.deepEqual(result.applied, [{ type: 'context.upsert', id: 'ctx-d' }]);
      assert.deepEqual(contexts(), [['ctx-c', 'foo', null], ['ctx-d', 'Foo', null]]);
    });
  });

  describe('an artifact whose origin thread is gone', () => {
    const row = (id: string, extra: Record<string, unknown>) => ({
      id, workspace_id: 'ws-1', name: id, file_path: `.contexts/${id}.md`, source: 'agent', kind: 'embedded', created_at: 1, updated_at: 1, ...extra,
    });
    const upsert = (operationId: string, id: string, extra: Record<string, unknown>, after: WorkspaceCommand[] = []) =>
      applyWorkspaceCommands('ws-1', { operationId, commands: [{ type: 'context.upsert', payload: row(id, extra) }, ...after] });
    const stored = (id: string) => {
      const context = listContexts('ws-1').find((candidate) => candidate.id === id);
      return context && { origin: [context.origin_node_id ?? null, context.origin_message_id ?? null], pinnedAt: context.pinned_at ?? null };
    };
    const originConflict = (error: unknown) => error instanceof DomainError && error.code === 'context_origin_workspace_mismatch';

    beforeEach(() => {
      applyWorkspaceCommands('ws-1', {
        operationId: 'seed',
        commands: [
          { type: 'workspace.upsert', payload: { id: 'ws-1', name: 'Workspace', active_tree_id: 'tree-1' } },
          { type: 'tree.upsert', payload: { id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'root' } },
          { type: 'node.upsert', payload: { id: 'root', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: null } },
          { type: 'node.upsert', payload: { id: 'branch', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: 'root' } },
        ],
      });
      getDb().prepare("INSERT INTO messages (id, node_id, role, content, seq, created_at) VALUES ('m-1', 'branch', 'assistant', 'notes', 0, 1)").run();
      applyWorkspaceCommands('ws-2', {
        operationId: 'seed-2',
        commands: [
          { type: 'workspace.upsert', payload: { id: 'ws-2', name: 'Other' } },
          { type: 'node.upsert', payload: { id: 'elsewhere', workspace_id: 'ws-2', tree_id: null, parent_node_id: null } },
        ],
      });
    });

    test('purged since, a pin of it saves without an origin instead of failing the batch', () => {
      upsert('create', 'ctx-a', { origin_node_id: 'branch', origin_message_id: 'm-1' });
      assert.deepEqual(stored('ctx-a')?.origin, ['branch', 'm-1']);
      purgeWorkspaceNodes('ws-1', ['branch']);
      // Before: context_origin_workspace_mismatch, a 409 that held up every later write of the workspace.
      const pinned = upsert('pin', 'ctx-a', { origin_node_id: 'branch', origin_message_id: 'm-1', pinned_at: 5 });
      assert.deepEqual(pinned.applied, [{ type: 'context.upsert', id: 'ctx-a' }]);
      assert.deepEqual(stored('ctx-a'), { origin: [null, null], pinnedAt: 5 });
      // One saved from a window that still shows the purged thread: likewise.
      upsert('save-from-stale', 'ctx-b', { origin_node_id: 'branch', origin_message_id: 'm-1' });
      assert.deepEqual(stored('ctx-b')?.origin, [null, null]);
    });

    test('gone altogether since (its tombstone collected), a pin still saves, whether or not its origin was dropped before', () => {
      upsert('create-a', 'ctx-a', { origin_node_id: 'branch' });
      upsert('create-b', 'ctx-b', { origin_node_id: 'branch' });
      purgeWorkspaceNodes('ws-1', ['branch']);
      upsert('pin-b', 'ctx-b', { origin_node_id: 'branch', pinned_at: 4 });
      getDb().prepare('UPDATE nodes SET purged_at = ? WHERE id = ?').run(Date.now() - TOMBSTONE_TTL_MS - 1, 'branch');
      runTombstoneGc();
      assert.equal(getDb().prepare("SELECT 1 FROM nodes WHERE id = 'branch'").get(), undefined);
      // The window still sends the origin each was made with.
      upsert('pin-a', 'ctx-a', { origin_node_id: 'branch', pinned_at: 5 });
      upsert('pin-b-again', 'ctx-b', { origin_node_id: 'branch', pinned_at: 6 });
      assert.deepEqual([stored('ctx-a'), stored('ctx-b')], [{ origin: [null, null], pinnedAt: 5 }, { origin: [null, null], pinnedAt: 6 }]);
    });

    test("a new artifact's origin that is not there, or one of another workspace, still fails the batch", () => {
      assert.throws(() => upsert('missing', 'ctx-a', { origin_node_id: 'absent' }), originConflict);
      // The same request creates it after the artifact: that ordering stays refused, as before.
      assert.throws(() => upsert('created-after', 'ctx-a', { origin_node_id: 'later' }, [
        { type: 'node.upsert', payload: { id: 'later', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: 'root' } },
      ]), originConflict);
      // Another workspace's thread, live or purged.
      assert.throws(() => upsert('elsewhere-live', 'ctx-a', { origin_node_id: 'elsewhere' }), originConflict);
      purgeWorkspaceNodes('ws-2', ['elsewhere']);
      assert.throws(() => upsert('elsewhere-purged', 'ctx-a', { origin_node_id: 'elsewhere' }), originConflict);
      assert.equal(stored('ctx-a'), undefined);
      assert.equal(getNode('later'), null);
    });
  });
});
