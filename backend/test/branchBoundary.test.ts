import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveMessage, saveNode, saveEdge, saveTree, saveWorkspace } from '../src/services/dbRepository';
import {
  BranchBoundaryError,
  renderBranchContext,
  resolveBranchBoundary,
  toBranchContext,
} from '../src/services/branchBoundary';

describe('resolve a branch boundary from durable graph + messages', () => {
  let dir: string;
  const oldDataDir = process.env.MICHI_DATA_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-branch-boundary-'));
    process.env.MICHI_DATA_DIR = dir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws', name: 'Workspace', created_at: 1, updated_at: 1 });
    saveTree({ id: 'tree', workspace_id: 'ws', root_node_id: 'root', created_at: 1, last_active_at: 1 });
    for (const id of ['root', 'child']) {
      saveNode({ id, workspace_id: 'ws', tree_id: 'tree', parent_node_id: id === 'child' ? 'root' : null,
        kind: 'chat', title: id, status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
    }
    const messages = [
      ['m1', 'user', 'first question', 1],
      ['m2', 'assistant', 'first answer', 2],
      ['m3', 'user', 'later question', 3],
      ['m4', 'assistant', 'later answer', 4],
    ] as const;
    for (const [id, role, content, createdAt] of messages) {
      saveMessage({ id, node_id: 'root', role, content, seq: createdAt - 1, created_at: createdAt });
    }
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (oldDataDir === undefined) delete process.env.MICHI_DATA_DIR;
    else process.env.MICHI_DATA_DIR = oldDataDir;
  });

  function branchEdge(anchor: string | null, createdAt: number | null = null) {
    saveEdge({ id: 'root-child', workspace_id: 'ws', source_node_id: 'root', target_node_id: 'child',
      kind: 'branch', anchor_message_id: anchor, created_at: createdAt });
  }

  test('a missing anchor is rejected instead of silently inheriting everything', () => {
    branchEdge('gone');
    assert.throws(
      () => resolveBranchBoundary({ childNodeId: 'child' }),
      (error: unknown) => error instanceof BranchBoundaryError && error.code === 'BRANCH_ANCHOR_UNAVAILABLE',
    );
  });

  test('a pre-provenance edge falls back to its creation time and is marked approximate', () => {
    branchEdge(null, 2);
    const boundary = resolveBranchBoundary({ childNodeId: 'child' });
    assert.ok(boundary);
    assert.equal(boundary.kind, 'approx');
    assert.equal(boundary.atTail, false);
    assert.deepEqual(boundary.messages.map(message => message.id), ['m1', 'm2']);
    assert.match(boundary.note ?? '', /reconstructed from the branch creation time/);
  });

  test('an unanswered final user message adds a model-facing tail note', () => {
    branchEdge('m3');
    const boundary = resolveBranchBoundary({ childNodeId: 'child' });
    assert.ok(boundary);
    assert.match(boundary.note ?? '', /had not yet answered/);
    const context = toBranchContext(boundary);
    assert.equal(context.kind, 'exact');
    const rendered = renderBranchContext(context);
    assert.match(rendered ?? '', /Inherited branch transcript/);
    assert.match(rendered ?? '', /Note: At the branch point/);
  });

  test('a long parent cut keeps the summaries of its cut turns, none from after the branch point', () => {
    // 60 more turns of about 2k characters each, then a branch at turn 49.
    for (let t = 0; t < 60; t++) {
      for (const [k, role] of [[0, 'user'], [1, 'assistant']] as const) {
        const at = 1_000 + 100 * t + 10 * k;
        saveMessage({ id: `t${t}-${role}`, node_id: 'root', role, content: `${role === 'user' ? 'Q' : 'A'}${t} `.padEnd(2_000, '.'),
          seq: 10 + 2 * t + k, created_at: at });
      }
    }
    const overviews = Array.from({ length: 60 }, (_, t) => ({ at: 1_000 + 100 * t + 50, text: `Turn ${t} settled S${t}.` }));
    getDb().prepare('UPDATE nodes SET branch_overview = ? WHERE id = ?').run(JSON.stringify(overviews), 'root');
    branchEdge('t49-assistant');
    const boundary = resolveBranchBoundary({ childNodeId: 'child' });
    assert.ok(boundary);
    const context = toBranchContext(boundary);
    assert.equal(context.messages.at(-1)?.createdAt, 1_000 + 100 * 49 + 10, 'the times reach the runtime-facing context');
    const rendered = renderBranchContext(context) ?? '';
    assert.match(rendered, /Summaries the agent wrote at the end of each turn in the omitted part/);
    assert.ok(rendered.includes('- Turn 20 settled S20.'), 'a cut turn');
    for (const absent of ['S0.', 'S49.', 'S50.', 'S59.']) assert.equal(rendered.includes(absent), false, absent);
    assert.match(rendered, /call read_node with nodeId "root", from "head", offset \d+/);
  });
});
