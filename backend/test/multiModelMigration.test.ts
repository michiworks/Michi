import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../src/services/migrate';

const MIGRATION = '0067_multi_model_runs.sql';

function objectExists(db: DatabaseSync, type: string, name: string): boolean {
  return !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name);
}

function workflowRuns(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT * FROM workflow_runs ORDER BY id').all().map((row) => ({ ...row }));
}

test('0067 rebuilds workflow_runs for michi runs and adds the multi-model tables and node markers', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'michi-multi-model-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(__dirname, '../src/db/migrations');
  const files = readdirSync(source).filter((name) => name.endsWith('.sql')).sort();
  assert.ok(files.includes(MIGRATION));
  for (const file of files.filter((name) => name < '0067')) copyFileSync(join(source, file), join(dir, file));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  runMigrations(db, dir);

  db.exec(`
    INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES ('ws-a', 'A', NULL, 1, 1);
    INSERT INTO nodes (id, workspace_id, kind, created_at) VALUES ('node-1', 'ws-a', 'chat', 1);
    INSERT INTO workflow_runs (id, owner_user_id, workspace_id, node_id, runtime, native_id, status, run_json, started_at, updated_at)
      VALUES ('wfr_c', 'local-user', 'ws-a', 'node-1', 'claude', 'task-1', 'running', '{"version":1,"name":"Claude ü"}', 10, 11),
             ('wfr_k', 'local-user', 'ws-a', NULL, 'kiro', 'wf-1', 'completed', '{"version":1,"name":"Kiro"}', 20, 21);
  `);
  const before = workflowRuns(db);

  copyFileSync(join(source, MIGRATION), join(dir, MIGRATION));
  // The real database runs every file with foreign keys on (db.ts).
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, dir);

  assert.deepEqual(workflowRuns(db), before, 'existing runs are copied unchanged');
  assert.ok(objectExists(db, 'index', 'idx_workflow_runs_workspace'));
  assert.equal(objectExists(db, 'table', 'workflow_runs_next'), false);
  const insert = db.prepare(`INSERT INTO workflow_runs (id, owner_user_id, workspace_id, node_id, runtime, native_id, status, run_json, started_at, updated_at)
    VALUES (?, 'local-user', 'ws-a', 'node-1', ?, ?, 'paused', '{"version":1}', 30, 30)`);
  insert.run('wfr_m', 'michi', 'mm_1');
  assert.throws(() => insert.run('wfr_m2', 'michi', 'mm_1'), /UNIQUE/, 'owner, runtime and native id stay unique');
  assert.throws(() => insert.run('wfr_f', 'foo', 'x'), /CHECK/);
  assert.throws(() => db.prepare(`UPDATE workflow_runs SET run_json = '{"version":2}' WHERE id = 'wfr_m'`).run(), /CHECK/);

  assert.equal(objectExists(db, 'table', 'multi_model_runs'), true);
  assert.equal(objectExists(db, 'table', 'multi_model_turns'), true);
  for (const index of ['idx_multi_model_runs_caller', 'idx_multi_model_runs_open', 'idx_multi_model_turns_run', 'idx_nodes_multi_model_run']) {
    assert.ok(objectExists(db, 'index', index), index);
  }
  assert.deepEqual({ ...db.prepare("SELECT multi_model_run_id, fresh_context FROM nodes WHERE id = 'node-1'").get() },
    { multi_model_run_id: null, fresh_context: 0 });
  assert.throws(() => db.prepare("UPDATE nodes SET fresh_context = 2 WHERE id = 'node-1'").run(), /CHECK/);

  db.prepare(`INSERT INTO multi_model_runs (id, native_id, owner_user_id, workspace_id, caller_node_id, status, plan_json, state_json, created_at, updated_at)
    VALUES ('wfr_m', 'mm_1', 'local-user', 'ws-a', 'node-1', 'proposed', '{}', '{}', 1, 1)`).run();
  db.prepare(`INSERT INTO multi_model_turns (turn_id, run_id, node_id, role, created_at) VALUES ('mm-1-syn-a1', 'wfr_m', 'node-1', 'synthesis', 1)`).run();
  assert.throws(() => db.prepare(`INSERT INTO multi_model_turns (turn_id, run_id, node_id, role, created_at) VALUES ('t', 'wfr_m', 'node-1', 'vote', 1)`).run(), /CHECK/);

  // The rebuilt table keeps its foreign keys: the node link is cleared, the workspace cascades.
  db.prepare("DELETE FROM nodes WHERE id = 'node-1'").run();
  assert.deepEqual(workflowRuns(db).map((row) => (row as { node_id: string | null }).node_id), [null, null, null]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM multi_model_runs').get()?.n, 0, 'a run goes with its caller');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM multi_model_turns').get()?.n, 0, 'and its turns with it');
  db.prepare("DELETE FROM workspaces WHERE id = 'ws-a'").run();
  assert.deepEqual(workflowRuns(db), []);

  const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  runMigrations(db, dir);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), ledger, 'a second pass is a no-op');
});

test('0067 keeps going when a database that once ran without foreign keys has stale workflow_runs rows', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'michi-multi-model-migration-stale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(__dirname, '../src/db/migrations');
  const files = readdirSync(source).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files.filter((name) => name < '0067')) copyFileSync(join(source, file), join(dir, file));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  runMigrations(db, dir);

  db.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES ('ws-a', 'A', NULL, 1, 1);
    INSERT INTO workflow_runs (id, owner_user_id, workspace_id, node_id, runtime, native_id, status, run_json, started_at, updated_at)
      VALUES ('wfr_gone_node', 'local-user', 'ws-a', 'gone-node', 'claude', 'task-1', 'completed', '{"version":1}', 10, 11),
             ('wfr_gone_ws', 'local-user', 'gone-ws', NULL, 'kiro', 'wf-1', 'completed', '{"version":1}', 20, 21);
  `);

  copyFileSync(join(source, MIGRATION), join(dir, MIGRATION));
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, dir);

  assert.deepEqual(
    db.prepare('SELECT id, node_id FROM workflow_runs ORDER BY id').all().map((row) => ({ ...row })),
    [{ id: 'wfr_gone_node', node_id: null }],
    'a dangling node_id becomes NULL and a run of a missing workspace is dropped',
  );
});
