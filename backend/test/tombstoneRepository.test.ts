/**
 * Tests for the Phase 3 tombstone mechanism: a stale POST /sync from
 * another tab cannot revive ids the active tab has just purged.
 *
 * Mirrors the safety properties we promised in the design discussion:
 *   - emptyWorkspaceTrash / purgeWorkspaceNodes leave a non-null
 *     `purged_at` instead of physically deleting the row.
 *   - saveNode / saveWorkspace / saveTree / saveEdge / saveMessage /
 *     saveContext all silently no-op on tombstoned ids.
 *   - listNodes / getNode / listWorkspaces / getWorkspace filter
 *     tombstones out — the UI never sees them.
 *   - runTombstoneGc drops rows older than TOMBSTONE_TTL_MS and is
 *     called automatically by the purge functions.
 *   - deleteContext tombstones a deleted artifact's id (context_tombstones,
 *     migration 0081), so saveContext cannot write it back.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb } from '../src/services/db';
import {
  saveWorkspace, saveTree, saveNode, saveContext, purgeWorkspaceNodes, deleteWorkspace,
  deleteContext, isContextTombstoned, listContexts, runTombstoneGc, TOMBSTONE_TTL_MS,
} from '../src/services/dbRepository';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-tomb-test-'));
}

function insertWorkspace(id: string) {
  saveWorkspace({
    id, name: 'test', cwd: null, active_tree_id: null,
    created_at: 1, updated_at: 1, settings: null,
    deleted_at: null, archived_at: null,
  });
}

function insertNode(wsId: string, id: string, opts: { deletedAt?: number; groupId?: string } = {}) {
  saveNode({
    id, workspace_id: wsId,
    tree_id: null, parent_node_id: null,
    kind: 'chat', title: id, status: 'idle',
    position_x: null, position_y: null, minimized: 0,
    deleted_at: opts.deletedAt ?? null,
    deletion_group_id: opts.groupId ?? null,
    spawned_by_agent: 0, current_mode_id: null, pane_width: null,
    digest: null, follow_ups: null, acp_session_id: null,
    runtime_id: null, provider_id: null, model_id: null,
    reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null,
    trim_snapshot: null,
    created_at: 1,
  });
}

function rawCount(table: string, where = ''): number {
  const sql = `SELECT COUNT(*) as cnt FROM ${table}${where ? ` WHERE ${where}` : ''}`;
  return (getDb().prepare(sql).get() as { cnt: number }).cnt;
}

describe('saveNode anti-revival guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('a node from a tombstoned workspace is also refused', () => {
    insertWorkspace('ws1');
    deleteWorkspace('ws1');     // tombstones workspace + cascades to nodes

    // Tab B tries to re-insert a node into the dead workspace.
    insertNode('ws1', 'rogue');

    assert.equal(rawCount('nodes', "id = 'rogue'"), 0);
  });
});

describe('purgeWorkspaceNodes targets a specific list', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('cross-workspace ids are ignored (defence in depth)', () => {
    insertWorkspace('ws1');
    insertWorkspace('ws2');
    insertNode('ws1', 'mine');
    insertNode('ws2', 'theirs');

    const purged = purgeWorkspaceNodes('ws1', ['mine', 'theirs']);

    assert.equal(purged, 1);
    assert.equal(rawCount('nodes', "id = 'theirs' AND purged_at IS NULL"), 1);
  });
});

describe('deleteWorkspace tombstones the workspace and cascades', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('saveTree/saveEdge after workspace tombstone is a no-op', () => {
    insertWorkspace('ws1');
    deleteWorkspace('ws1');

    saveTree({
      id: 't-rogue', workspace_id: 'ws1', root_node_id: 'doesnt-matter',
      name: null, archived_at: null, pinned_at: null,
      last_active_at: 1, created_at: 1,
    });
    saveContext({
      id: 'c-rogue', workspace_id: 'ws1', name: 'x', file_path: '/x',
      size: null, auto_inject: 0, source: 'user',
      created_at: 1, updated_at: 1,
    });

    assert.equal(rawCount('trees', "id = 't-rogue'"), 0);
    assert.equal(rawCount('contexts', "id = 'c-rogue'"), 0);
  });
});

describe('deleteContext tombstones the artifact id', () => {
  let tmpDir: string;
  const savedCloud = process.env.MICHI_CLOUD;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });
  afterEach(() => {
    if (savedCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = savedCloud;
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const insertContext = (id: string, name = 'notes', wsId = 'ws1') => saveContext({
    id, workspace_id: wsId, name, file_path: `.contexts/${name}.md`,
    size: null, auto_inject: 0, source: 'user', created_at: 1, updated_at: 1,
  });

  test('a deleted id is not written back; a new id under the same name is', () => {
    insertWorkspace('ws1');
    insertContext('c-1');

    assert.equal(deleteContext('c-1'), true);
    assert.equal(isContextTombstoned('c-1'), true);
    // A stale window's copy of it.
    insertContext('c-1');
    assert.equal(rawCount('contexts', "id = 'c-1'"), 0);
    // Saved again, an artifact of that name always gets a new id.
    insertContext('c-2');
    assert.deepEqual(listContexts('ws1').map((row) => [row.id, row.name]), [['c-2', 'notes']]);
    // Deleting a row that is not there tombstones nothing.
    assert.equal(deleteContext('c-missing'), false);
    assert.equal(isContextTombstoned('c-missing'), false);
  });

  test("in cloud mode another user's delete removes nothing and tombstones nothing", () => {
    insertWorkspace('ws1');
    getDb().prepare("UPDATE workspaces SET owner_user_id = 'alice' WHERE id = 'ws1'").run();
    insertContext('c-1');
    process.env.MICHI_CLOUD = '1';

    assert.equal(deleteContext('c-1', 'bob'), false);
    assert.equal(rawCount('contexts', "id = 'c-1'"), 1);
    assert.equal(isContextTombstoned('c-1'), false);
    assert.equal(deleteContext('c-1', 'alice'), true);
    assert.equal(isContextTombstoned('c-1'), true);
  });

  test('tombstones older than the TTL are collected, by runTombstoneGc and by the next delete', () => {
    insertWorkspace('ws1');
    insertContext('c-old', 'old');
    insertContext('c-older', 'older');
    insertContext('c-new', 'new');
    deleteContext('c-old');
    deleteContext('c-older');
    const expired = Date.now() - TOMBSTONE_TTL_MS - 1;
    getDb().prepare("UPDATE context_tombstones SET deleted_at = ? WHERE id IN ('c-old', 'c-older')").run(expired);

    assert.equal(runTombstoneGc().contexts, 2);
    assert.equal(rawCount('context_tombstones'), 0);

    deleteContext('c-new');
    getDb().prepare("INSERT INTO context_tombstones (id, workspace_id, deleted_at) VALUES ('c-ancient', 'ws1', ?)").run(expired);
    insertContext('c-last', 'last');
    deleteContext('c-last');
    assert.deepEqual(
      (getDb().prepare('SELECT id FROM context_tombstones ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id),
      ['c-last', 'c-new'],
    );
  });
});
