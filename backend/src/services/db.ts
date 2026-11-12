import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { pendingMigrations, runMigrations as runSqlMigrations } from './migrate';
import { snapshotBeforeMigrations } from './migrationSnapshot';
import { getMichiDataDir } from './dataDir';
import { log } from './logger';
import { instrumentDatabase, timedSync } from './performanceDiagnostics';

declare const __MICHIBUNDLE__: boolean | undefined;

let _db: DatabaseSync | null = null;
let _auditDb: DatabaseSync | null = null;
/** Why audit.db could not be opened; getAuditDb does not try again until closeAuditDb(). */
let _auditDbFailure: Error | null = null;
const statementCache = new Map<string, StatementSync>();

/**
 * Resolve a migration directory.
 *
 * Dev mode (ts-node): __dirname is .../backend/src/services, SQL lives at
 * .../backend/src/db/migrations, so '../db/...' is correct.
 *
 * Bundled mode: esbuild flattens everything into dist/server.js so __dirname
 * is .../backend/dist, and scripts/build.mjs copies SQL to .../backend/dist/db.
 * The relative offset is then 'db/...' (no '..').
 *
 * The __MICHIBUNDLE__ flag is defined in scripts/build.mjs.
 */
function resolveMigrationsDir(rel: 'migrations' | 'auditMigrations'): string {
  const bundled = typeof __MICHIBUNDLE__ !== 'undefined' && __MICHIBUNDLE__;
  return bundled
    ? path.join(__dirname, 'db', rel)
    : path.join(__dirname, '../db', rel);
}

export function getDbPath(): string {
  return path.join(getMichiDataDir(), 'data.db');
}

export function initDb(): DatabaseSync {
  if (_db) return _db;
  const db = instrumentDatabase(new DatabaseSync(getDbPath()), 'main-db');
  _db = db;
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    // Multi-window prereq (spec §18/D12): a writer that loses the WAL write-lock
    // race waits up to 15s for the lock instead of throwing SQLITE_BUSY at once.
    // 15s is generous for a desktop app; the real mitigation is the retry loop in
    // runInTransaction() below.
    db.exec('PRAGMA busy_timeout = 15000');
    const migrationsDir = resolveMigrationsDir('migrations');
    // Throws UnsupportedSchemaError, before anything is written, for a database below V14.
    const fresh = isFreshSchema(db);
    // Copies an existing database to backups/ before the migrations below
    // change it; when the copy fails this throws and nothing is migrated.
    snapshotBeforeMigrations(db, pendingMigrations(db, migrationsDir)[0]);
    if (fresh) createV14Schema(db);
    // File-based SQL migration runner — records applied files in schema_migrations.
    runSqlMigrations(db, migrationsDir);
  } catch (err) {
    // No half-initialized connection stays open; the next getDb() starts over.
    closeDb();
    throw err;
  }
  return db;
}

export function getDb(): DatabaseSync {
  if (!_db) return initDb();
  return _db;
}

/** The open database, or null before initDb: for reads that must never open (and migrate) one themselves. */
export function openDbOrNull(): DatabaseSync | null {
  return _db;
}

/** Cache only static SQL owned by hot paths; never pass unbounded dynamic SQL. */
export function prepareCached(sql: string): StatementSync {
  const existing = statementCache.get(sql);
  if (existing) return existing;
  const statement = getDb().prepare(sql);
  statementCache.set(sql, statement);
  return statement;
}

/** Whether the database is open (getDb() opens it again after closeDb()). */
export function isDbOpen(): boolean {
  return _db !== null;
}

export function closeDb(): void {
  statementCache.clear();
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getAuditDbPath(): string {
  return path.join(getMichiDataDir(), 'audit.db');
}

/**
 * The audit DB: audit.db in the same data dir as data.db, but deliberately
 * separate so cascade deletes on user rows in data.db do NOT wipe audit
 * history. The audit DB has its own schema_migrations ledger pointing at
 * src/db/auditMigrations/. openExistingAuditDb() opens an existing one at
 * startup; the first audit record creates a new one.
 *
 * When opening fails (e.g. its pre-migration snapshot or a migration fails),
 * the error is logged once and every later call throws it without trying
 * again, which would repeat the whole copy on a request, until closeAuditDb()
 * or a restart. Audit records are dropped meanwhile (auditDbUnavailable()).
 */
export function getAuditDb(): DatabaseSync {
  if (_auditDb) return _auditDb;
  if (_auditDbFailure) throw _auditDbFailure;
  let db: DatabaseSync | null = null;
  try {
    db = instrumentDatabase(new DatabaseSync(getAuditDbPath()), 'audit-db');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    // Same multi-window prereq as initDb: audit rows are written on the hot path
    // (every turn / permission), so a second window writing concurrently would
    // otherwise hit SQLITE_BUSY here too.
    db.exec('PRAGMA busy_timeout = 15000');
    const migrationsDir = resolveMigrationsDir('auditMigrations');
    snapshotBeforeMigrations(db, pendingMigrations(db, migrationsDir)[0]);
    runSqlMigrations(db, migrationsDir);
  } catch (err) {
    db?.close();
    _auditDbFailure = err as Error;
    log.error('boot', 'audit database unavailable until restart; audit records are dropped', {
      db: getAuditDbPath(),
      error: (err as Error).message,
    });
    throw err;
  }
  _auditDb = db;
  return db;
}

/**
 * Open audit.db at startup when it exists, so its pending migrations, and the
 * snapshot before them, run before the server listens rather than in the
 * request that writes the next audit record. A failure does not stop startup:
 * getAuditDb logs it and the audit log stays unavailable until restart.
 */
export function openExistingAuditDb(): void {
  if (!fs.existsSync(getAuditDbPath())) return;
  try {
    getAuditDb();
  } catch {
    // Logged by getAuditDb.
  }
}

/** True once audit.db failed to open in this process: audit records are being dropped. */
export function auditDbUnavailable(): boolean {
  return _auditDbFailure !== null;
}

/** Closes audit.db; the next getAuditDb() opens it again, also after a failure. */
export function closeAuditDb(): void {
  _auditDbFailure = null;
  if (_auditDb) {
    _auditDb.close();
    _auditDb = null;
  }
}

// Callbacks registered (runAfterCommit) while runInTransaction's body runs.
let commitHooks: Array<() => void> | null = null;

/**
 * Run `fn` once the current runInTransaction commits; dropped if it rolls
 * back (or is retried). Outside a transaction a write has already committed,
 * so `fn` runs now. One failing callback does not stop the others.
 */
export function runAfterCommit(fn: () => void): void {
  if (commitHooks) commitHooks.push(fn);
  else runCommitHook(fn);
}

function runCommitHook(fn: () => void): void {
  try {
    fn();
  } catch {
    // Observers of a committed write must not turn it into a failure.
  }
}

let savepointSerial = 0;

/**
 * Inside an open transaction `fn` runs in a savepoint: its after-commit work
 * joins the enclosing transaction's, or is dropped if the savepoint rolls back,
 * and the outermost transaction alone retries on SQLITE_BUSY.
 */
export function runInTransaction<T>(fn: () => T): T {
  const db = getDb();
  if (db.isTransaction) return runInSavepoint(db, fn);
  const maxRetries = 3;
  for (let attempt = 0; ; attempt++) {
    db.exec('BEGIN');
    const outerHooks = commitHooks;
    const hooks: Array<() => void> = [];
    commitHooks = hooks;
    try {
      const result = fn();
      db.exec('COMMIT');
      commitHooks = outerHooks;
      for (const hook of hooks) runCommitHook(hook);
      return result;
    } catch (err) {
      commitHooks = outerHooks;
      db.exec('ROLLBACK');
      if (isSqliteBusy(err) && attempt < maxRetries) {
        // Exponential backoff: 100ms, 200ms, 400ms.
        // Uses Atomics.wait on a dummy SharedArrayBuffer for sync sleep.
        timedSync('main-db.busy-backoff', () => sleepSyncMs(100 * Math.pow(2, attempt)));
        continue;
      }
      throw err;
    }
  }
}

function runInSavepoint<T>(db: DatabaseSync, fn: () => T): T {
  const name = `tx_${++savepointSerial}`;
  db.exec(`SAVEPOINT ${name}`);
  const outerHooks = commitHooks;
  const hooks: Array<() => void> = [];
  commitHooks = hooks;
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    commitHooks = outerHooks;
    // A transaction begun outside runInTransaction has no frame to join.
    if (outerHooks) outerHooks.push(...hooks);
    else for (const hook of hooks) runCommitHook(hook);
    return result;
  } catch (err) {
    commitHooks = outerHooks;
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw err;
  }
}

/** Detect SQLite BUSY / database-is-locked errors. */
function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('database is locked') || msg.includes('sqlite_busy');
}

/** Synchronous millisecond sleep (does not yield the event loop). */
function sleepSyncMs(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

/**
 * The oldest schema initDb opens: `meta.schema_version` 14, written by the last
 * of the retired in-process steps V1..V14 (2026-05-25). The SQL files build on
 * it; the first, 0000_baseline, repeats the V1..V14 DDL. Their runner first ran
 * on 2026-05-27, after V14, so a database with its ledger (schema_migrations)
 * is at V14 even without that row.
 */
const MIN_SCHEMA_VERSION = 14;

/**
 * A data.db below MIN_SCHEMA_VERSION: initDb no longer upgrades one, and
 * throws this before writing anything to it.
 */
export class UnsupportedSchemaError extends Error {
  readonly code = 'unsupported_schema';

  constructor(readonly dbPath: string, readonly schemaVersion: number) {
    super(
      `${dbPath} predates schema v14 (May 2026): it is at v${schemaVersion}, which this Michi no longer upgrades. ` +
        'Open it once with an older Michi release to upgrade it, then retry.',
    );
    this.name = 'UnsupportedSchemaError';
  }
}

function getSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * True for an empty database, which initDb creates at V14; false for one at
 * V14 or later, by its schema_version or SQL ledger. Throws
 * UnsupportedSchemaError for any other: a database below V14, which the SQL
 * files cannot bring up to date.
 */
function isFreshSchema(db: DatabaseSync): boolean {
  const version = getSchemaVersion(db);
  if (version >= MIN_SCHEMA_VERSION) return false;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()) return false;
  if (!db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()) return true;
  const error = new UnsupportedSchemaError(getDbPath(), version);
  log.error('boot', 'database predates schema v14; not opening it', { db: error.dbPath, schemaVersion: version });
  throw error;
}

/**
 * Creates the V14 schema on an empty database the way the retired V1..V14
 * steps did: V1's tables, then the columns V5, V9, V10 and V11 added, then the
 * tables of V7 and V13. Every data.db was made like this, so a new one keeps
 * their column order and stored CREATE text (test/fixtures/dataDbSchema.golden.txt);
 * 0000_baseline.sql orders nodes' columns differently. One transaction, so a
 * crash cannot leave a partial schema, which the next start would refuse.
 *
 * Some SQL files add these columns again (0005_branch_anchor, 0031): migrate.ts
 * skips such a duplicate ADD COLUMN, so keep that tolerance.
 */
function createV14Schema(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    createSchemaTables(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function createSchemaTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      cwd            TEXT,
      model          TEXT,
      active_tree_id TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      settings       TEXT,
      deleted_at     INTEGER,
      archived_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS trees (
      id             TEXT PRIMARY KEY,
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      root_node_id   TEXT NOT NULL,
      name           TEXT,
      archived_at    INTEGER,
      pinned_at      INTEGER,
      last_active_at INTEGER NOT NULL,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trees_workspace ON trees(workspace_id);

    CREATE TABLE IF NOT EXISTS nodes (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      tree_id           TEXT REFERENCES trees(id) ON DELETE CASCADE,
      parent_node_id    TEXT REFERENCES nodes(id) ON DELETE SET NULL,
      kind              TEXT NOT NULL DEFAULT 'chat',
      title             TEXT,
      status            TEXT NOT NULL DEFAULT 'idle',
      position_x        REAL,
      position_y        REAL,
      minimized         INTEGER NOT NULL DEFAULT 0,
      deleted_at        INTEGER,
      deletion_group_id TEXT,
      spawned_by_agent  INTEGER NOT NULL DEFAULT 0,
      current_mode_id   TEXT,
      pane_width        REAL,
      digest            TEXT,
      follow_ups        TEXT,
      follow_ups_source_message_id TEXT,
      composer_draft    TEXT,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_workspace ON nodes(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_tree ON nodes(tree_id);

    CREATE TABLE IF NOT EXISTS edges (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      source_node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      kind              TEXT NOT NULL DEFAULT 'branch',
      anchor_message_id TEXT,
      created_at        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_edges_workspace ON edges(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id);

    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      blocks     TEXT,
      tool_calls TEXT,
      seq        INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_node ON messages(node_id);

	    CREATE TABLE IF NOT EXISTS contexts (
	      id           TEXT PRIMARY KEY,
	      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	      name         TEXT NOT NULL,
	      file_path    TEXT NOT NULL,
	      size         INTEGER,
	      auto_inject  INTEGER NOT NULL DEFAULT 0,
	      source       TEXT NOT NULL DEFAULT 'user',
	      created_at   INTEGER NOT NULL,
	      updated_at   INTEGER NOT NULL,
	      UNIQUE(workspace_id, name)
	    );
    CREATE INDEX IF NOT EXISTS idx_contexts_workspace ON contexts(workspace_id);
	  `);

  // FTS5 full-text index - optional. Node 22.11 ships sqlite without FTS5;
  // gracefully skip so the app still starts (search falls back to LIKE).
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content=messages,
        content_rowid=rowid
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  } catch {
    // FTS5 unavailable
  }

  // V5, V9, V10 and V11: session and runtime columns.
  db.exec(`
    ALTER TABLE nodes ADD COLUMN acp_session_id TEXT;
    ALTER TABLE workspaces ADD COLUMN backend TEXT NOT NULL DEFAULT 'kiro';
    ALTER TABLE nodes ADD COLUMN external_session_id TEXT;
    ALTER TABLE nodes ADD COLUMN runtime_id TEXT;
    ALTER TABLE nodes ADD COLUMN provider_id TEXT;
    ALTER TABLE nodes ADD COLUMN model_id TEXT;
    ALTER TABLE nodes ADD COLUMN reasoning TEXT;
    ALTER TABLE nodes ADD COLUMN resume_fingerprint TEXT;
  `);

  // V7: per-workspace, per-tool always-allow grants. Written when the user
  // selects "Allow always" on a permission prompt; read by the policy
  // resolver to short-circuit ask → allow.
  //
  // Cleanup is intentionally hard-delete-only: soft-delete (deleted_at) and
  // tombstoning (purged_at, set by deleteWorkspace) leave grants in place —
  // harmless, since the policy resolver never runs for a hidden workspace. The
  // grant is reaped automatically by ON DELETE CASCADE when runTombstoneGc()
  // finally drops the workspace row (purged_at past TTL). That cascade only
  // fires because the connection sets `PRAGMA foreign_keys = ON` above.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_permission_grants (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      tool_name    TEXT NOT NULL,
      granted_at   INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, tool_name)
    );
    CREATE INDEX IF NOT EXISTS idx_grants_workspace ON workspace_permission_grants(workspace_id);
  `);

  // V13: BYOK provider keys, scoped per user. Plaintext keys are encrypted at
  // rest with AES-256-GCM using MICHI_ENCRYPTION_KEY (see services/userKeys.ts).
  //
  // No FK on user_id because Better-Auth's `user` table lives in a
  // separate sqlite file (auth.sqlite) and SQLite can't enforce FKs across
  // databases. Application code is the single writer.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_provider_keys (
      user_id    TEXT NOT NULL,
      provider   TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      iv         BLOB NOT NULL,
      tag        BLOB NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      PRIMARY KEY (user_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_user_provider_keys_user ON user_provider_keys(user_id);
  `);

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(MIN_SCHEMA_VERSION));
}
