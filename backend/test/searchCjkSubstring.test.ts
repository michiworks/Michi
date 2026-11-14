/**
 * messages_fts and nodes_fts use unicode61, which keeps a run of Chinese text
 * as one token, so "海报" never matched "两版海报都已更新" or the title
 * "审阅海报改回三折页风格的建议". Queries with CJK characters match substrings
 * with LIKE instead; other queries keep FTS. Temp SQLite per test.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/services/db';
import { saveMessage, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { keywordSearch, nodeGroupedSearch } from '../src/routes/search';

function seedChat(id: string, title: string): void {
  saveTree({ id: `t-${id}`, workspace_id: 'ws-a', root_node_id: id, last_active_at: 1, created_at: 1 });
  saveNode({ id, workspace_id: 'ws-a', tree_id: `t-${id}`, kind: 'chat', title, status: 'idle', minimized: 0, spawned_by_agent: 0, runtime_id: 'claude', created_at: 1 });
}

describe('CJK queries match substrings', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-cjk-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws-a', name: 'A', cwd: null, created_at: 1, updated_at: 1, settings: null });
    seedChat('n-poster', '审阅海报改回三折页风格的建议');
    saveMessage({ id: 'm-1', node_id: 'n-poster', role: 'assistant', content: '两版海报都已更新，版面检查通过。', seq: 1, created_at: 10 });
    saveMessage({ id: 'm-2', node_id: 'n-poster', role: 'user', content: '把 Michi 海报改回三折页', seq: 2, created_at: 20 });
    seedChat('n-title-only', '海报配色讨论');
    saveMessage({ id: 'm-3', node_id: 'n-title-only', role: 'user', content: 'palette ideas', seq: 1, created_at: 5 });
    seedChat('n-other', 'Pelican release');
    saveMessage({ id: 'm-4', node_id: 'n-other', role: 'user', content: '100% 完成, pelican_plan 已合并', seq: 1, created_at: 30 });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('keyword search finds CJK text inside longer runs, newest first, with a marked snippet', () => {
    const rows = keywordSearch('海报');
    assert.deepEqual(rows.map((r) => r.id), ['m-2', 'm-1']);
    assert.equal(rows[1].snippet, '两版<mark>海报</mark>都已更新，版面检查通过。');
  });

  test('every term must occur, ASCII case-insensitively', () => {
    assert.deepEqual(keywordSearch('michi 海报').map((r) => r.id), ['m-2']);
    assert.deepEqual(keywordSearch('海报 pelican').map((r) => r.id), []);
  });

  test('% and _ in a CJK query are literal', () => {
    assert.deepEqual(keywordSearch('100% 完成').map((r) => r.id), ['m-4']);
    assert.deepEqual(keywordSearch('pelican_plan 合并').map((r) => r.id), ['m-4']);
    assert.deepEqual(keywordSearch('10_% 完成').map((r) => r.id), []);
  });

  test('grouped search finds message hits and title-only hits', () => {
    const grouped = nodeGroupedSearch('海报');
    assert.deepEqual(grouped.map((r) => r.nodeId), ['n-poster', 'n-title-only']);
    const [poster, titleOnly] = grouped;
    assert.equal(poster.totalMatches, 2);
    assert.deepEqual(poster.snippets.map((s) => s.messageId), ['m-2', 'm-1']);
    assert.equal(poster.snippets[0].snippet, '把 Michi <mark>海报</mark>改回三折页');
    assert.equal(titleOnly.totalMatches, 0);
    assert.equal(titleOnly.snippets[0].snippet, '<mark>海报</mark>配色讨论');
  });

  test('a title-only CJK hit inside a longer title', () => {
    assert.deepEqual(nodeGroupedSearch('三折页风格').map((r) => r.nodeId), ['n-poster']);
  });

  test('English queries still use FTS whole-token matching', () => {
    assert.deepEqual(keywordSearch('pelic').map((r) => r.id), [], 'no substring match without CJK');
    assert.deepEqual(keywordSearch('ideas').map((r) => r.id), ['m-3']);
    assert.deepEqual(nodeGroupedSearch('pelican').map((r) => r.nodeId), ['n-other']);
  });
});
