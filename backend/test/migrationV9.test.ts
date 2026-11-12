/**
 * initDb and the oldest schema it opens, v14: it no longer upgrades a data.db
 * below that (the in-process V1..V14 steps were retired), refusing one with
 * UnsupportedSchemaError before writing anything. It creates a fresh database
 * at v14 and opens one at v14 or later, with or without the SQL ledger.
 *
 * Uses node:test (built-in, Node 22+) + node:sqlite (built-in).
 * MICHI_DATA_DIR is set to a unique tmp path per test so the singleton
 * is re-created against a fresh file each time.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initDb, closeDb, getDb, isDbOpen, UnsupportedSchemaError } from '../src/services/db';
import { getWorkspaceBackend } from '../src/services/dbRepository';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-test-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  closeDb(); // clear singleton so next initDb() opens tmpDir/data.db
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const migrationsDir = path.join(__dirname, '../src/db/migrations');

function dbPath(): string {
  return path.join(tmpDir, 'data.db');
}

function withRawDb<T>(fn: (raw: DatabaseSync) => T): T {
  const raw = new DatabaseSync(dbPath());
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
}

function schemaVersion(db: DatabaseSync): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
}

describe('the oldest schema initDb opens', () => {

  test('getWorkspaceBackend returns null for non-existent workspace', () => {
    initDb();
    assert.equal(getWorkspaceBackend('does-not-exist'), null);
  });

  test('a database below v14 is refused and left as it was', () => {
    // A v8 database (Michi before 2026-05-19), reduced to the tables read here.
    withRawDb((raw) => {
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT, model TEXT,
          active_tree_id TEXT, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
          settings TEXT, deleted_at INTEGER, archived_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS nodes (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, tree_id TEXT,
          parent_node_id TEXT, kind TEXT NOT NULL DEFAULT 'chat', title TEXT,
          status TEXT NOT NULL DEFAULT 'idle', position_x REAL, position_y REAL,
          minimized INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
          deletion_group_id TEXT, spawned_by_agent INTEGER NOT NULL DEFAULT 0,
          current_mode_id TEXT, pane_width REAL, digest TEXT, follow_ups TEXT,
          acp_session_id TEXT, composer_draft TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
        );
        INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8');
      `);
      const now = Date.now();
      raw.prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('ws-acp', 'AcpTest', now, now);
      raw.prepare(
        `INSERT INTO nodes (id, workspace_id, kind, status, minimized, spawned_by_agent, acp_session_id, created_at)
         VALUES (?, ?, 'chat', 'idle', 0, 0, ?, ?)`,
      ).run('nd-acp', 'ws-acp', 'kiro-sid-123', now);
    });
    const schemaBefore = withRawDb((raw) => raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all());

    assert.throws(() => initDb(), (err: unknown) => {
      assert.ok(err instanceof UnsupportedSchemaError, String(err));
      assert.equal(err.code, 'unsupported_schema');
      assert.equal(err.schemaVersion, 8);
      assert.equal(err.dbPath, dbPath());
      assert.match(err.message, /predates schema v14/);
      assert.match(err.message, /Open it once with an older Michi release to upgrade it, then retry\./);
      return true;
    });
    assert.equal(isDbOpen(), false, 'no half-initialized connection stays open');

    withRawDb((raw) => {
      assert.deepEqual(raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all(), schemaBefore);
      assert.equal(schemaVersion(raw), '8');
      const row = raw.prepare('SELECT acp_session_id FROM nodes WHERE id = ?').get('nd-acp') as { acp_session_id: string };
      assert.equal(row.acp_session_id, 'kiro-sid-123');
    });
    assert.equal(fs.existsSync(path.join(tmpDir, 'backups')), false, 'no pre-migration snapshot of a refused database');
  });

  test('a fresh database is created at v14 and opens again', () => {
    assert.equal(schemaVersion(initDb()), '14');
    closeDb();
    assert.equal(schemaVersion(initDb()), '14');
  });

  test('a v14 database the SQL files never ran on gets all of them', () => {
    // As Michi left it between V14 (2026-05-25) and the SQL runner (2026-05-27);
    // 0000_baseline holds the V1..V14 DDL.
    withRawDb((raw) => {
      raw.exec(fs.readFileSync(path.join(migrationsDir, '0000_baseline.sql'), 'utf8'));
      raw.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '14')");
      raw.prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('ws-v14', 'V14', 1, 1);
    });

    initDb();
    const db = getDb();

    const expected = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')).sort();
    const applied = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>)
      .map((r) => r.version);
    assert.deepEqual(applied, expected);
    assert.equal(schemaVersion(db), '14');
    assert.ok(db.prepare("SELECT 1 FROM workspaces WHERE id = 'ws-v14'").get());
  });
});
