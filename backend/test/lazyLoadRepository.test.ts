import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setupPersistenceRoutes } from '../src/routes/persistence';

import { closeDb, getDb, initDb } from '../src/services/db';
import {
  saveWorkspace,
  saveTree,
  saveNode,
  saveMessage,
  loadAllWorkspacesMeta,
  loadWorkspaceMeta,
  loadTreeMessagePage,
  loadTreeMessageSnapshot,
} from '../src/services/dbRepository';

function seedNode(id: string, workspaceId: string, treeId: string): void {
  saveNode({
    id, workspace_id: workspaceId, tree_id: treeId, parent_node_id: null,
    kind: 'chat', title: null, branch_overview: null, status: 'idle',
    position_x: null, position_y: null, minimized: 0, deleted_at: null,
    deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
    pane_width: null, digest: null, follow_ups: null,
    follow_ups_source_message_id: null, acp_session_id: null, runtime_id: null,
    provider_id: null, model_id: null, reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null, trim_snapshot: null,
    created_at: 1,
  });
}

function seedMessage(id: string, nodeId: string, seq: number, content: string): void {
  saveMessage({
    id, node_id: nodeId, role: seq % 2 === 0 ? 'user' : 'assistant',
    content, blocks: null, tool_calls: null, metadata: null, seq, created_at: seq,
  });
}

describe('lazy-load repository', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-lazyload-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();

    // ws-1: two trees. tree-A has 2 nodes (3 msgs total), tree-B has 1 node (2 msgs).
    saveWorkspace({
      id: 'ws-1', name: 'Workspace', created_at: 1, updated_at: 1,
      active_tree_id: 'tree-A', cwd: null, settings: null,
    });
    saveTree({ id: 'tree-A', workspace_id: 'ws-1', root_node_id: 'n-a1', name: null, archived_at: null, pinned_at: null, last_active_at: 2, created_at: 1 });
    saveTree({ id: 'tree-B', workspace_id: 'ws-1', root_node_id: 'n-b1', name: null, archived_at: null, pinned_at: null, last_active_at: 1, created_at: 1 });
    seedNode('n-a1', 'ws-1', 'tree-A');
    seedNode('n-a2', 'ws-1', 'tree-A');
    seedNode('n-b1', 'ws-1', 'tree-B');
    seedMessage('m-a1-0', 'n-a1', 0, 'alpha hello');
    seedMessage('m-a1-1', 'n-a1', 1, 'alpha reply');
    seedMessage('m-a2-0', 'n-a2', 0, 'beta hello');
    seedMessage('m-b1-0', 'n-b1', 0, 'gamma hello');
    seedMessage('m-b1-1', 'n-b1', 1, 'gamma reply');
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('meta payload carries structure + message_count but NO message bodies', () => {
    const all = loadAllWorkspacesMeta();
    assert.equal(all.length, 1);
    const ws = all[0];
    assert.equal(ws.workspace.id, 'ws-1');
    assert.equal(ws.trees.length, 2);
    assert.equal(ws.nodes.length, 3);
    // The whole point: no bodies inline.
    assert.deepEqual(ws.messages, []);
    // Counts ride on each node row.
    const byId = new Map(ws.nodes.map(n => [n.id, n.message_count]));
    assert.equal(byId.get('n-a1'), 2);
    assert.equal(byId.get('n-a2'), 1);
    assert.equal(byId.get('n-b1'), 2);
  });

  test('a node with zero messages reports message_count 0 (not undefined)', () => {
    seedNode('n-empty', 'ws-1', 'tree-B');
    const meta = loadWorkspaceMeta('ws-1')!;
    const empty = meta.nodes.find(n => n.id === 'n-empty')!;
    assert.equal(empty.message_count, 0);
  });

  test('loadTreeMessageSnapshot for an unknown tree is empty, not an error', () => {
    assert.deepEqual(loadTreeMessageSnapshot('ws-1', 'tree-nope'), { messages: [], turns: [] });
  });

  test('pages each node from its newest messages and continues without duplicates after new output', () => {
    for (let seq = 2; seq < 120; seq++) seedMessage(`m-a1-${seq}`, 'n-a1', seq, `message ${seq}`);
    const first = loadTreeMessagePage('ws-1', 'tree-A', { limit: 50 });
    const cursor = first.pages.find(page => page.nodeId === 'n-a1')!;
    assert.equal(cursor.total, 120);
    assert.equal(first.messages.filter(row => row.node_id === 'n-a1').length, 50);
    assert.equal(first.messages.find(row => row.node_id === 'n-a1')?.seq, 70);
    assert.equal(first.pages.find(page => page.nodeId === 'n-a2')?.before, null);
    assert.ok(first.messages.every(row => row.node_id !== 'n-b1'));
    seedMessage('new', 'n-a1', 120, 'arrived between pages');
    const second = loadTreeMessagePage('ws-1', 'tree-A', { limit: 50, nodeId: 'n-a1', before: cursor.before! });
    assert.equal(second.messages[0].seq, 20);
    assert.equal(second.messages.at(-1)?.seq, 69);
    const last = loadTreeMessagePage('ws-1', 'tree-A', { limit: 50, nodeId: 'n-a1', before: second.pages[0].before! });
    assert.equal(last.messages.length, 20);
    assert.equal(last.pages[0].before, null);
    assert.equal(new Set([...last.messages, ...second.messages, ...first.messages.filter(row => row.node_id === 'n-a1')].map(row => row.id)).size, 120);
  });

  test('turn pages start at a user message, within the limit', () => {
    for (let seq = 2; seq < 30; seq++) seedMessage(`m-a1-${seq}`, 'n-a1', seq, `message ${seq}`);
    const page = loadTreeMessagePage('ws-1', 'tree-A', { limit: 15, nodeId: 'n-a1', maxBytes: 1_000_000 });
    // Seq 15 is an answer; its question is on the next page with it.
    assert.deepEqual(page.messages.map(row => row.seq), Array.from({ length: 14 }, (_, i) => 16 + i));
    assert.equal(page.messages[0].role, 'user');
    assert.deepEqual(page.pages[0].before, { seq: 16, id: 'm-a1-16' });
    const counted = loadTreeMessagePage('ws-1', 'tree-A', { limit: 15, nodeId: 'n-a1' });
    assert.equal(counted.messages[0].seq, 15);
  });

  test('a turn page ends before the turn past its budget and keeps the newest turn whole', () => {
    seedMessage('m-a1-2', 'n-a1', 2, 'small question');
    seedMessage('m-a1-3', 'n-a1', 3, 'x'.repeat(6000));
    seedMessage('m-a1-4', 'n-a1', 4, 'last question');
    seedMessage('m-a1-5', 'n-a1', 5, 'y'.repeat(3000));
    const newest = loadTreeMessagePage('ws-1', 'tree-A', { limit: 50, nodeId: 'n-a1', maxBytes: 2048 });
    assert.deepEqual(newest.messages.map(row => row.id), ['m-a1-4', 'm-a1-5']);
    assert.deepEqual(newest.pages[0].before, { seq: 4, id: 'm-a1-4' });
    const next = loadTreeMessagePage('ws-1', 'tree-A', { limit: 50, nodeId: 'n-a1', maxBytes: 2048, before: newest.pages[0].before! });
    assert.deepEqual(next.messages.map(row => row.id), ['m-a1-2', 'm-a1-3']);
    const wide = loadTreeMessagePage('ws-1', 'tree-A', { limit: 50, nodeId: 'n-a1', maxBytes: 20_000 });
    assert.equal(wide.messages.length, 6);
    assert.equal(wide.pages[0].before, null);
  });

  test('turn pages count the rows as projected and read every message once', () => {
    seedNode('n-a3', 'ws-1', 'tree-A');
    // Copied history can open with an answer: the oldest page ends with it.
    saveMessage({ id: 'lead', node_id: 'n-a3', role: 'assistant', content: 'copied answer', blocks: null,
      tool_calls: null, metadata: null, seq: 0, created_at: 0 });
    for (let seq = 1; seq < 40; seq++) {
      saveMessage({ id: `r-${String(seq).padStart(2, '0')}`, node_id: 'n-a3', role: seq % 2 === 1 ? 'user' : 'assistant',
        content: seq % 2 === 1 ? 'q' : 'z'.repeat(900), blocks: null, tool_calls: null, metadata: null, seq, created_at: seq });
    }
    const all = ['lead', ...Array.from({ length: 39 }, (_, i) => `r-${String(i + 1).padStart(2, '0')}`)];
    const read = (project?: (row: { content: string }) => unknown) => {
      const pages: string[][] = [];
      let before: { seq: number; id: string } | undefined;
      do {
        const page = loadTreeMessagePage('ws-1', 'tree-A', { limit: 50, nodeId: 'n-a3', maxBytes: 2048, before,
          ...(project ? { project: project as never } : {}) });
        pages.unshift(page.messages.map(row => row.id));
        before = page.pages[0].before ?? undefined;
      } while (before);
      return pages;
    };
    // Projected, an answer is short: the whole history fits.
    assert.deepEqual(read(row => ({ ...row, content: row.content.slice(0, 10) })), [all]);
    // As stored, two answers fill the budget.
    const pages = read();
    assert.ok(pages.length > 5);
    assert.deepEqual(pages.flat(), all);
    for (const page of pages.slice(1)) assert.ok(page[0].startsWith('r-') && Number(page[0].slice(2)) % 2 === 1, page.join());
    assert.equal(pages[0][0], 'lead');
  });

  test('a newest turn longer than the page cap is cut at the cap', () => {
    for (let seq = 2; seq < 260; seq++) {
      saveMessage({ id: `t-${String(seq).padStart(3, '0')}`, node_id: 'n-a1', role: 'assistant', content: 'step',
        blocks: null, tool_calls: null, metadata: null, seq, created_at: seq });
    }
    const page = loadTreeMessagePage('ws-1', 'tree-A', { limit: 15, nodeId: 'n-a1', maxBytes: 1_000_000 });
    assert.equal(page.messages.length, 200);
    assert.equal(page.messages.at(-1)?.seq, 259);
    assert.deepEqual(page.pages[0].before, { seq: 60, id: 't-060' });
  });

  test('isolates page cursors by workspace and tree, including empty nodes', () => {
    assert.deepEqual(loadTreeMessagePage('ws-1', 'tree-A', { limit: 50, nodeId: 'n-b1' }), { messages: [], pages: [], turns: [] });
    assert.deepEqual(loadTreeMessagePage('other', 'tree-A', { limit: 50 }), { messages: [], pages: [], turns: [] });
    seedNode('empty', 'ws-1', 'tree-A');
    assert.deepEqual(loadTreeMessagePage('ws-1', 'tree-A', { limit: 50, nodeId: 'empty' }), {
      messages: [], turns: [], pages: [{ nodeId: 'empty', total: 0, before: null, node: {
        branch_overview: null, follow_ups: null, follow_ups_source_message_id: null, composer_draft: null,
      } }],
    });
  });

  test('reads each node’s latest turn in the same snapshot as its messages', () => {
    const insert = getDb().prepare(`INSERT INTO turns(turn_id,node_id,assistant_message_id,status,last_seq,started_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`);
    insert.run('older', 'n-a1', 'a-older', 'completed', 12, 1, 1);
    insert.run('latest', 'n-a1', 'a-latest', 'active', 40, 2, 2);
    insert.run('other-tree', 'n-b1', 'a-other', 'active', 7, 2, 2);
    const snapshot = loadTreeMessageSnapshot('ws-1', 'tree-A');
    assert.equal(snapshot.messages.length, 3);
    assert.deepEqual(snapshot.turns.map(row => ({ ...row })), [
      { node_id: 'n-a1', turn_id: 'latest', status: 'active', last_seq: 40, error: null, completed_at: null },
    ]);
    assert.deepEqual(loadTreeMessagePage('ws-1', 'tree-A', { limit: 50 }).turns, snapshot.turns);
  });

  test('enforces cloud ownership for page reads', () => {
    const old = process.env.MICHI_CLOUD;
    process.env.MICHI_CLOUD = '1';
    try {
      saveWorkspace({ id: 'owned', name: 'Owned', owner_user_id: 'alice', created_at: 1, updated_at: 1 });
      saveTree({ id: 'tree', workspace_id: 'owned', root_node_id: 'secret', name: null, archived_at: null, pinned_at: null, last_active_at: 1, created_at: 1 });
      seedNode('secret', 'owned', 'tree'); seedMessage('secret-row', 'secret', 0, 'private');
      assert.equal(loadTreeMessagePage('owned', 'tree', { limit: 50 }, 'alice').messages.length, 1);
      assert.deepEqual(loadTreeMessagePage('owned', 'tree', { limit: 50 }, 'bob'), { messages: [], pages: [], turns: [] });
    } finally { if (old === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = old; }
  });

  test('HTTP pages validate cursors, preserve full-history compatibility and enforce ownership', async () => {
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 'bob' } as typeof req.user; next(); });
    app.use('/api', setupPersistenceRoutes());
    const server = app.listen(0, '127.0.0.1');
    const oldCloud = process.env.MICHI_CLOUD;
    try {
      await once(server, 'listening');
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/ws-1/trees/tree-A/messages`;
      const recent = await fetch(`${url}?limit=1`);
      assert.equal(recent.status, 200);
      assert.equal(recent.headers.get('cache-control'), 'no-store');
      const page = await recent.json() as ReturnType<typeof loadTreeMessagePage>;
      assert.equal(page.messages.length, 2); // One per node in this tree.
      assert.deepEqual(page.pages.find(item => item.nodeId === 'n-a1')?.before, { seq: 1, id: 'm-a1-1' });
      const older = await fetch(`${url}?limit=1&nodeId=n-a1&beforeSeq=1&beforeId=m-a1-1`);
      assert.equal((await older.json() as ReturnType<typeof loadTreeMessagePage>).messages[0].id, 'm-a1-0');
      const all = await fetch(url);
      const snapshot = await all.json() as ReturnType<typeof loadTreeMessageSnapshot>;
      assert.equal(snapshot.messages.length, 3);
      assert.deepEqual(snapshot.turns, []);
      const turnPage = await fetch(`${url}?limit=1&nodeId=n-a1&maxBytes=1024`);
      assert.deepEqual((await turnPage.json() as ReturnType<typeof loadTreeMessagePage>).messages.map(row => row.id), ['m-a1-0', 'm-a1-1']);
      for (const query of ['limit=0', 'limit=201', 'limit=1.5', 'limit=1&limit=2',
        'limit=1&beforeSeq=1&beforeId=m-a1-1', 'limit=1&nodeId=n-a1&beforeSeq=1',
        'limit=1&nodeId=n-a1&beforeId=m-a1-1', 'limit=1&nodeId=n-a1&beforeSeq=-1&beforeId=m-a1-1',
        'limit=1&maxBytes=1023', 'limit=1&maxBytes=2.5', 'limit=1&maxBytes=big', 'limit=1&maxBytes=1024&maxBytes=2048',
        `limit=1&maxBytes=${32 * 1024 * 1024 + 1}`]) {
        const response = await fetch(`${url}?${query}`);
        assert.equal(response.status, 400, query);
        await response.body?.cancel();
      }
      process.env.MICHI_CLOUD = '1';
      const denied = await fetch(`${url}?limit=1`);
      assert.equal(denied.status, 404);
      await denied.body?.cancel();
    } finally {
      if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
