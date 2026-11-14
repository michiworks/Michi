import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { LEAN_NODE_FIELDS } from 'michi-shared';

import { closeDb, initDb } from '../src/services/db';
import { applyWorkspaceCommands } from '../src/services/domainCommands';
import {
  getNode, loadAllWorkspacesMeta, saveEdge, saveMessage, saveNode, saveTree, saveWorkspace, type NodeRow,
} from '../src/services/dbRepository';
import { setupPersistenceRoutes } from '../src/routes/persistence';

const OVERVIEW = JSON.stringify([{ at: 1, text: 'First' }, { at: 2, text: 'Second' }]);
const FOLLOW_UPS = JSON.stringify(['Why?', 'What next?']);
const DRAFT = JSON.stringify({ __michiWindowDrafts: { 'win-1': JSON.stringify({ value: 'half typed', mentions: [] }) } });
const LEGACY_SPAWN_OUTBOX = JSON.stringify({ __michiPendingSpawnPrompt: 'Look into the flaky test' });

function node(id: string, treeId: string, fields: Partial<NodeRow> = {}): NodeRow {
  return {
    id, workspace_id: 'ws', tree_id: treeId, parent_node_id: null, kind: 'chat', title: id, status: 'idle',
    minimized: 0, spawned_by_agent: 0, created_at: 1, ...fields,
  };
}

function heavy(): Partial<NodeRow> {
  return { branch_overview: OVERVIEW, follow_ups: FOLLOW_UPS, follow_ups_source_message_id: 'a-1', composer_draft: DRAFT };
}

function stored(id: string) {
  const row = getNode(id)!;
  return {
    branch_overview: row.branch_overview, follow_ups: row.follow_ups,
    follow_ups_source_message_id: row.follow_ups_source_message_id, composer_draft: row.composer_draft,
  };
}

describe('lean node fields', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-lean-fields-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws', name: 'Workspace', created_at: 1, updated_at: 1, active_tree_id: 'tree-a', cwd: null, settings: null });
    saveTree({ id: 'tree-a', workspace_id: 'ws', root_node_id: 'root', name: null, archived_at: null, pinned_at: null, last_active_at: 2, created_at: 1 });
    saveTree({ id: 'tree-m', workspace_id: 'ws', root_node_id: 'merge', name: null, archived_at: null, pinned_at: null, last_active_at: 1, created_at: 1 });
    saveTree({ id: 'tree-s', workspace_id: 'ws', root_node_id: 'src', name: null, archived_at: null, pinned_at: null, last_active_at: 1, created_at: 1 });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('node upsert', () => {
    test('a payload that leaves a lean column out keeps the stored value', () => {
      saveNode(node('root', 'tree-a', heavy()));
      saveNode(node('root', 'tree-a', { title: 'Renamed' }));
      assert.equal(getNode('root')?.title, 'Renamed');
      assert.deepEqual(stored('root'), { branch_overview: OVERVIEW, follow_ups: FOLLOW_UPS, follow_ups_source_message_id: 'a-1', composer_draft: DRAFT });
      // An in-process caller's explicit undefined reads like a left-out key.
      saveNode(node('root', 'tree-a', { branch_overview: undefined, composer_draft: undefined }));
      assert.equal(getNode('root')?.branch_overview, OVERVIEW);
      assert.equal(getNode('root')?.composer_draft, DRAFT);
    });

    test('an explicit null still clears, and a new row without the keys stores NULL', () => {
      saveNode(node('root', 'tree-a', heavy()));
      saveNode(node('root', 'tree-a', { branch_overview: null, follow_ups: null, follow_ups_source_message_id: null, composer_draft: null }));
      assert.deepEqual(stored('root'), { branch_overview: null, follow_ups: null, follow_ups_source_message_id: null, composer_draft: null });
      saveNode(node('fresh', 'tree-a'));
      assert.deepEqual(stored('fresh'), { branch_overview: null, follow_ups: null, follow_ups_source_message_id: null, composer_draft: null });
    });

    test('commands without the lean keys leave them stored', () => {
      saveNode(node('root', 'tree-a', heavy()));
      applyWorkspaceCommands('ws', { operationId: 'op-lean', commands: [
        // What a lean window sends for a node it holds without those fields.
        { type: 'node.upsert', payload: { id: 'root', workspace_id: 'ws', tree_id: 'tree-a', parent_node_id: null, kind: 'chat', title: 'root', status: 'idle', minimized: 1, spawned_by_agent: 0, created_at: 1 } },
        { type: 'node.patch', payload: { id: 'root', tree_id: 'tree-a', parent_node_id: null, kind: 'chat', spawned_by_agent: 0, minimized: 1, pane_width: 480 } },
      ] });
      assert.equal(getNode('root')?.pane_width, 480);
      assert.deepEqual(stored('root'), { branch_overview: OVERVIEW, follow_ups: FOLLOW_UPS, follow_ups_source_message_id: 'a-1', composer_draft: DRAFT });
    });
  });

  describe('metadata and pages over HTTP', () => {
    async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
      const app = express();
      app.use('/api', setupPersistenceRoutes());
      const server = app.listen(0, '127.0.0.1');
      try {
        await once(server, 'listening');
        return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }

    beforeEach(() => {
      saveNode(node('root', 'tree-a', heavy()));
      saveNode(node('child', 'tree-a', { parent_node_id: 'root', branch_overview: OVERVIEW, composer_draft: LEGACY_SPAWN_OUTBOX }));
      saveNode(node('empty', 'tree-a', { parent_node_id: 'root', follow_ups: FOLLOW_UPS }));
      saveNode(node('plain', 'tree-a', { parent_node_id: 'root' }));
      saveNode(node('merge', 'tree-m', { branch_overview: OVERVIEW }));
      saveNode(node('src', 'tree-s', { branch_overview: OVERVIEW }));
      saveNode(node('src-child', 'tree-s', { parent_node_id: 'src', branch_overview: OVERVIEW }));
      saveEdge({ id: 'branch-root-child', workspace_id: 'ws', source_node_id: 'root', target_node_id: 'child', kind: 'branch', created_at: 1 });
      saveEdge({ id: 'branch-root-empty', workspace_id: 'ws', source_node_id: 'root', target_node_id: 'empty', kind: 'branch', created_at: 1 });
      saveEdge({ id: 'branch-root-plain', workspace_id: 'ws', source_node_id: 'root', target_node_id: 'plain', kind: 'branch', created_at: 1 });
      saveEdge({ id: 'branch-src-src-child', workspace_id: 'ws', source_node_id: 'src', target_node_id: 'src-child', kind: 'branch', created_at: 1 });
      saveEdge({ id: 'merge-src-child-merge', workspace_id: 'ws', source_node_id: 'src-child', target_node_id: 'merge', kind: 'merge', created_at: 1 });
      saveMessage({ id: 'm-0', node_id: 'root', role: 'user', content: 'hi', blocks: null, tool_calls: null, metadata: null, seq: 0, created_at: 1 });
      saveMessage({ id: 'm-1', node_id: 'root', role: 'assistant', content: 'hello', blocks: null, tool_calls: null, metadata: null, seq: 1, created_at: 2 });
    });

    test('lean metadata leaves out the lean fields that hold a value and names them', async () => {
      await withServer(async (base) => {
        const lean = await (await fetch(`${base}/workspaces/all?meta=1&lean=1`)).json() as {
          leanNodeFields: string[]; workspaces: Array<{ nodes: Array<Record<string, unknown>> }>;
        };
        assert.deepEqual(lean.leanNodeFields, [...LEAN_NODE_FIELDS]);
        const rows = new Map(lean.workspaces[0].nodes.map(row => [row.id, row]));
        const keys = (id: string) => ['branch_overview', 'follow_ups', 'follow_ups_source_message_id', 'composer_draft']
          .filter(key => key in rows.get(id)!);
        assert.deepEqual(keys('root'), [], 'every heavy value deferred');
        assert.equal(rows.get('root')!.message_count, 2);
        // A legacy spawn outbox is a draft like any other: no window sends it any more.
        assert.deepEqual(keys('child'), ['follow_ups', 'follow_ups_source_message_id']);
        // A merge source and its branch ancestors keep their overviews for the merge thread's Map.
        assert.ok(keys('src-child').includes('branch_overview') && keys('src').includes('branch_overview'));
        assert.equal(rows.get('root')!.title, 'root');
        assert.deepEqual(keys('empty'), ['branch_overview', 'composer_draft'], 'follow-ups and their source travel together');
        assert.deepEqual(keys('plain'), ['branch_overview', 'follow_ups', 'follow_ups_source_message_id', 'composer_draft'], 'null values are the row\'s own');
        assert.deepEqual(keys('merge'), ['follow_ups', 'follow_ups_source_message_id', 'composer_draft'], 'not a merge source');

        const full = await (await fetch(`${base}/workspaces/all?meta=1`)).json() as Record<string, unknown> & {
          workspaces: Array<{ nodes: Array<Record<string, unknown>> }>;
        };
        assert.equal('leanNodeFields' in full, false);
        const root = full.workspaces[0].nodes.find(row => row.id === 'root')!;
        assert.equal(root.branch_overview, OVERVIEW);
        assert.equal(root.composer_draft, DRAFT);
        // Bodies in a full snapshot: lean applies to metadata only.
        const bodies = await (await fetch(`${base}/workspaces/all?lean=1`)).json() as Record<string, unknown>;
        assert.equal('leanNodeFields' in bodies, false);
      });
    });

    test('a tree page carries the lean fields of every node it covers, empty ones included', async () => {
      await withServer(async (base) => {
        const page = await (await fetch(`${base}/workspaces/ws/trees/tree-a/messages?limit=1`)).json() as {
          pages: Array<{ nodeId: string; total: number; before: { seq: number; id: string } | null; node?: Record<string, unknown> }>;
        };
        const byNode = new Map(page.pages.map(entry => [entry.nodeId, entry]));
        assert.deepEqual([...byNode.keys()].sort(), ['child', 'empty', 'plain', 'root']);
        assert.deepEqual(byNode.get('root')!.node, { branch_overview: OVERVIEW, follow_ups: FOLLOW_UPS, follow_ups_source_message_id: 'a-1', composer_draft: DRAFT });
        assert.equal(byNode.get('empty')!.total, 0);
        assert.deepEqual(byNode.get('empty')!.node, { branch_overview: null, follow_ups: FOLLOW_UPS, follow_ups_source_message_id: null, composer_draft: null });
        const before = byNode.get('root')!.before!;
        const older = await (await fetch(`${base}/workspaces/ws/trees/tree-a/messages?limit=1&nodeId=root&beforeSeq=${before.seq}&beforeId=${before.id}`)).json() as {
          pages: Array<Record<string, unknown>>;
        };
        assert.equal(older.pages.length, 1);
        assert.equal('node' in older.pages[0], false, 'an older page follows a latest page that brought them');
      });
    });
  });

  test('a lean read copies rows: the stored rows and a later full read stay whole', () => {
    saveNode(node('root', 'tree-a', heavy()));
    const lean = loadAllWorkspacesMeta(undefined, { lean: true });
    assert.equal('branch_overview' in lean[0].nodes[0], false);
    assert.equal(loadAllWorkspacesMeta()[0].nodes[0].branch_overview, OVERVIEW);
    assert.equal(getNode('root')?.composer_draft, DRAFT);
  });
});
