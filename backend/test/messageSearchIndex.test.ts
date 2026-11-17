/**
 * messages.created_at is stored after tool_calls, so a search reading it from
 * the table walks each hit's overflow chain (11-09 performance audit, P0-5).
 * The grouped search and its title pass read it from
 * idx_messages_node_role_created (migration 0095): this checks the plans of
 * the statements the real functions prepare. Temp SQLite per test.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { nodeGroupedSearch } from '../src/routes/search';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-search-index-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  const db = initDb();
  db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'W', 1, 1)").run();
  db.prepare("INSERT INTO nodes (id, workspace_id, kind, status, title) VALUES ('n-message', 'ws', 'chat', 'idle', 'Release'), ('n-title', 'ws', 'chat', 'idle', 'Heron plan')").run();
  db.prepare("INSERT INTO messages (id, node_id, role, content, seq, created_at) VALUES ('m-1', 'n-message', 'user', 'heron notes', 1, 1)").run();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the grouped search reads each hit\'s created_at from idx_messages_node_role_created', () => {
  const db = getDb();
  const prepare = db.prepare;
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  db.prepare = (sql: string) => {
    const statement = prepare.call(db, sql);
    const all = statement.all.bind(statement);
    Object.defineProperty(statement, 'all', { value: (...params: []) => { statements.push({ sql, params }); return all(...params); }, configurable: true });
    return statement;
  };
  try {
    assert.deepEqual(nodeGroupedSearch('heron').map((row) => row.nodeId), ['n-message', 'n-title']);
  } finally {
    db.prepare = prepare;
  }
  const plan = ({ sql, params }: { sql: string; params: unknown[] }) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params as []) as Array<{ detail: string }>).map((row) => row.detail);
  const matches = plan(statements[0]!);
  const titles = plan(statements.find((statement) => statement.sql.includes('nodes_fts'))!);
  assert.ok(matches.includes('SEARCH x USING COVERING INDEX idx_messages_node_role_created (node_id=?)'), matches.join('\n'));
  assert.ok(titles.includes('SEARCH m USING COVERING INDEX idx_messages_node_role_created (node_id=?)'), titles.join('\n'));
});
