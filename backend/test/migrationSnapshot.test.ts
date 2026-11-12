/**
 * Pre-migration snapshots (services/migrationSnapshot.ts, wired into initDb and
 * getAuditDb): an existing database is copied to backups/ before a pending
 * migration runs, the copy is verified and private, at most five per database
 * within three times its size are kept, and a failed copy stops the migration
 * with the database unchanged.
 */
import { test, beforeEach, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { closeAuditDb, closeDb, getAuditDb, initDb, isDbOpen } from '../src/services/db';
import { log } from '../src/services/logger';
import { snapshotBeforeMigrations } from '../src/services/migrationSnapshot';

const POSIX = process.platform !== 'win32';
const SNAPSHOT_ENV = ['MICHI_SKIP_MIGRATION_SNAPSHOT', 'MICHI_MIGRATION_SNAPSHOTS', 'MICHI_CLOUD', 'MICHI_REQUIRE_AUTH'];

/** Only CREATE INDEX IF NOT EXISTS, so the test can mark it unapplied and rerun it. */
const PENDING = '0048_task_activity_indexes';
const PENDING_INDEX = 'idx_page_changes_database_pending';
const SNAPSHOT = /^(data|audit)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3}Z)-pre-(.+)\.db$/;

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-migration-snapshot-'));
  process.env.MICHI_DATA_DIR = dataDir;
  for (const name of SNAPSHOT_ENV) delete process.env[name];
  closeDb();
  closeAuditDb();
});

afterEach(() => {
  closeDb();
  closeAuditDb();
  for (const name of SNAPSHOT_ENV) delete process.env[name];
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

/** The copy method each written snapshot's log line names. */
function copyMethods(t: TestContext): () => unknown[] {
  const info = t.mock.method(log, 'info');
  return () => info.mock.calls
    .filter((call) => call.arguments[1] === 'pre-migration snapshot written')
    .map((call) => (call.arguments[2] as { method?: unknown }).method);
}

/** Undo PENDING again on a database initDb already migrated, so the next initDb runs it. */
function makePendingAgain(dbPath: string): void {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`DROP INDEX ${PENDING_INDEX}; DELETE FROM schema_migrations WHERE version = '${PENDING}';`);
  raw.close();
}

function backupsDir(): string {
  return path.join(dataDir, 'backups');
}

function backups(): string[] {
  return fs.existsSync(backupsDir()) ? fs.readdirSync(backupsDir()).sort() : [];
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function applied(db: DatabaseSync, version: string): boolean {
  return !!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
}

function hasIndex(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
}

function withDb<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** A fully migrated data.db with a row in it, where PENDING is then undone and unrecorded. */
function existingDbWithPendingMigration(): string {
  initDb();
  closeDb();
  const dbPath = path.join(dataDir, 'data.db');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws-kept', 'Kept', 1, 1);
    DROP INDEX ${PENDING_INDEX};
    DELETE FROM schema_migrations WHERE version = '${PENDING}';
  `);
  raw.close();
  return dbPath;
}

/** A small file database with a schema, for calling the snapshot helper directly. */
function smallDb(): DatabaseSync {
  const db = new DatabaseSync(path.join(dataDir, 'data.db'));
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  return db;
}

test('an existing database is snapshotted, verified, before its pending migration runs', () => {
  existingDbWithPendingMigration();

  const db = initDb();

  const files = backups();
  assert.equal(files.length, 1, files.join(', '));
  const name = SNAPSHOT.exec(files[0]);
  assert.ok(name, files[0]);
  assert.equal(name[1], 'data');
  assert.equal(name[6], PENDING);
  const takenAt = Date.parse(`${name[2]}T${name[3]}:${name[4]}:${name[5]}`);
  assert.ok(Math.abs(Date.now() - takenAt) < 60_000, `UTC timestamp ${files[0]}`);
  withDb(path.join(backupsDir(), files[0]), (snapshot) => {
    assert.deepEqual(snapshot.prepare('PRAGMA quick_check').all().map((row) => row.quick_check), ['ok']);
    assert.ok(snapshot.prepare("SELECT 1 FROM workspaces WHERE id = 'ws-kept'").get());
    assert.equal(applied(snapshot, PENDING), false, 'the snapshot is the state before the migration');
    assert.equal(hasIndex(snapshot, PENDING_INDEX), false);
  });
  assert.equal(applied(db, PENDING), true);
  assert.equal(hasIndex(db, PENDING_INDEX), true);
});

test('no snapshot for a fresh database, nothing pending, or an in-memory database', () => {
  initDb();
  closeDb();
  assert.equal(fs.existsSync(backupsDir()), false, 'fresh database');

  initDb();
  closeDb();
  assert.equal(fs.existsSync(backupsDir()), false, 'nothing pending');

  const memory = new DatabaseSync(':memory:');
  memory.exec('CREATE TABLE t (id INTEGER)');
  assert.equal(snapshotBeforeMigrations(memory, '0001_next'), null);
  memory.close();
  assert.equal(fs.existsSync(backupsDir()), false, 'in-memory database');
});

test('the audit database is snapshotted before its pending migrations', () => {
  const audit = getAuditDb();
  audit.prepare("INSERT INTO audit_log (ts, action) VALUES (1, 'auth.sign_out')").run();
  closeAuditDb();
  assert.equal(fs.existsSync(backupsDir()), false, 'a fresh audit database is not snapshotted');
  const raw = new DatabaseSync(path.join(dataDir, 'audit.db'));
  raw.exec("DELETE FROM schema_migrations WHERE version = '0000_audit_init'");
  raw.close();

  getAuditDb();

  const files = backups();
  assert.equal(files.length, 1, files.join(', '));
  assert.equal(SNAPSHOT.exec(files[0])?.[1], 'audit');
  assert.equal(SNAPSHOT.exec(files[0])?.[6], '0000_audit_init');
  withDb(path.join(backupsDir(), files[0]), (snapshot) => {
    assert.equal((snapshot.prepare('SELECT count(*) AS n FROM audit_log').get() as { n: number }).n, 1);
  });
});

test('retention keeps the newest five snapshots of the database and touches nothing else', () => {
  fs.mkdirSync(backupsDir());
  const older = [1, 2, 3, 4, 5, 6].map((day) => `data-2020-01-0${day}T00-00-00.000Z-pre-0001_old.db`);
  const unrelated = [
    'notes.txt',
    'data-manual-copy.db',
    'data.db',
    'data-2019-01-01T00-00-00.000Z-pre-0001_old.db-wal',
    'audit-2019-01-01T00-00-00.000Z-pre-0001_old.db',
    'data.snapshot-1-0badf00d.tmp.keep',
  ];
  for (const file of [...older, ...unrelated]) fs.writeFileSync(path.join(backupsDir(), file), 'x');
  const snapshotNamedDirectory = 'data-2018-01-01T00-00-00.000Z-pre-0001_old.db';
  fs.mkdirSync(path.join(backupsDir(), snapshotNamedDirectory));
  const db = smallDb();

  const created = snapshotBeforeMigrations(db, '0002_next');
  db.close();

  assert.ok(created);
  assert.match(path.basename(created), /^data-.*-pre-0002_next\.db$/);
  assert.deepEqual(backups(), [...older.slice(2), path.basename(created), ...unrelated, snapshotNamedDirectory].sort());
});

test('retention never removes the snapshot just written, even when the clock went back', () => {
  fs.mkdirSync(backupsDir());
  const future = [1, 2, 3, 4, 5].map((day) => `data-2999-01-0${day}T00-00-00.000Z-pre-0001_old.db`);
  for (const file of future) fs.writeFileSync(path.join(backupsDir(), file), 'x');
  const db = smallDb();

  const created = snapshotBeforeMigrations(db, '0002_next');
  db.close();

  assert.ok(created);
  assert.deepEqual(backups(), [...future.slice(1), path.basename(created)].sort());
});

test('a temporary copy left by a dead process is removed; one of a live process is kept', () => {
  fs.mkdirSync(backupsDir());
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  assert.equal(typeof deadPid, 'number');
  const dead = `data.snapshot-${deadPid}-0badf00d.tmp`;
  const live = `data.snapshot-${process.ppid}-cafebabe.tmp`;
  const otherDb = `audit.snapshot-${deadPid}-0badf00d.tmp`;
  for (const file of [dead, live, otherDb]) fs.writeFileSync(path.join(backupsDir(), file), 'partial');
  const db = smallDb();

  const created = snapshotBeforeMigrations(db, '0002_next');
  db.close();

  assert.ok(created);
  assert.deepEqual(backups(), [path.basename(created), live, otherDb].sort());
});

const failures: Array<{ cause: string; message: RegExp; arrange: (t: TestContext) => void }> = [
  {
    cause: 'too little free space',
    message: /only 0\.0 MB free on the disk holding .*backups.*free up disk space/,
    arrange: (t) => {
      t.mock.method(fs, 'statfsSync', () => ({ type: 0, bsize: 4096, blocks: 1, bfree: 0, bavail: 0, files: 0, ffree: 0 }));
    },
  },
  {
    cause: 'backups/ is not a directory',
    message: /EEXIST|ENOTDIR/,
    arrange: () => fs.writeFileSync(backupsDir(), 'not a directory'),
  },
  {
    cause: 'the copy cannot be renamed',
    message: /simulated rename failure/,
    arrange: (t) => {
      t.mock.method(fs, 'renameSync', () => {
        throw new Error('simulated rename failure');
      });
    },
  },
];

for (const { cause, message, arrange } of failures) {
  test(`a failed snapshot (${cause}) stops the migration and leaves the database unchanged`, (t) => {
    const dbPath = existingDbWithPendingMigration();
    const before = sha256(dbPath);
    arrange(t);

    assert.throws(() => initDb(), (err: Error) => {
      assert.match(err.message, /^Michi did not migrate .*data\.db: the snapshot taken before migration 0048_task_activity_indexes failed/);
      assert.match(err.message, message);
      assert.match(err.message, /The database was not changed\./);
      assert.match(err.message, /set MICHI_SKIP_MIGRATION_SNAPSHOT=1 to migrate without a snapshot/);
      return true;
    });
    t.mock.restoreAll();

    assert.equal(isDbOpen(), false, 'no half-initialized connection stays open');
    assert.equal(sha256(dbPath), before);
    withDb(dbPath, (db) => assert.equal(applied(db, PENDING), false));
    if (fs.statSync(backupsDir()).isDirectory()) assert.deepEqual(backups(), [], 'no copy or temporary file is left');
  });
}

test('MICHI_SKIP_MIGRATION_SNAPSHOT=1 migrates without a snapshot', () => {
  existingDbWithPendingMigration();
  fs.writeFileSync(backupsDir(), 'not a directory'); // a snapshot would fail
  process.env.MICHI_SKIP_MIGRATION_SNAPSHOT = '1';

  const db = initDb();

  assert.equal(applied(db, PENDING), true);
  assert.equal(fs.readFileSync(backupsDir(), 'utf8'), 'not a directory');
});

test('snapshots are private: backups/ becomes 0700, also when it existed wider, and each copy is 0600', { skip: !POSIX }, (t) => {
  const dbPath = existingDbWithPendingMigration();
  fs.chmodSync(dbPath, 0o644);
  fs.mkdirSync(backupsDir(), { mode: 0o755 });
  fs.chmodSync(backupsDir(), 0o755);
  const methods = copyMethods(t);

  initDb();
  closeDb();
  makePendingAgain(dbPath);
  t.mock.method(fs, 'copyFileSync', () => {
    throw new Error('simulated copy failure');
  });
  initDb();

  assert.deepEqual(methods(), ['file copy', 'VACUUM INTO']);
  assert.equal(mode(backupsDir()), 0o700);
  const files = backups();
  assert.equal(files.length, 2, files.join(', '));
  for (const file of files) assert.equal(mode(path.join(backupsDir(), file)), 0o600, file);
});

test('a database file that cannot be copied is snapshotted with VACUUM INTO', (t) => {
  existingDbWithPendingMigration();
  const methods = copyMethods(t);
  t.mock.method(fs, 'copyFileSync', (_from: fs.PathLike, to: fs.PathLike) => {
    fs.writeFileSync(to, 'half a copy');
    throw new Error('simulated copy failure');
  });

  const db = initDb();

  assert.deepEqual(methods(), ['VACUUM INTO']);
  const files = backups();
  assert.equal(files.length, 1, `only the snapshot, no partial copy: ${files.join(', ')}`);
  withDb(path.join(backupsDir(), files[0]), (snapshot) => {
    assert.ok(snapshot.prepare("SELECT 1 FROM workspaces WHERE id = 'ws-kept'").get());
    assert.equal(applied(snapshot, PENDING), false);
  });
  assert.equal(applied(db, PENDING), true);
});

test('a file copy is a self-contained rollback-journal database, like VACUUM INTO writes', () => {
  existingDbWithPendingMigration();

  initDb();

  const files = backups();
  assert.equal(files.length, 1, `no -wal or -shm beside the snapshot: ${files.join(', ')}`);
  withDb(path.join(backupsDir(), files[0]), (snapshot) => {
    assert.equal((snapshot.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete');
  });
  assert.deepEqual(backups(), files, 'reading it does not create them either');
});

test('a connection reading an older state makes the snapshot VACUUM INTO, within a second', (t) => {
  const dbPath = existingDbWithPendingMigration();
  const reader = new DatabaseSync(dbPath);
  const writer = new DatabaseSync(dbPath);
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM workspaces').get();
    writer.exec("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws-later', 'Later', 2, 2)");
    const methods = copyMethods(t);

    const startedAt = Date.now();
    const db = initDb();

    assert.ok(Date.now() - startedAt < 10_000, 'the checkpoint waits about a second, not the 15 s busy timeout');
    assert.deepEqual(methods(), ['VACUUM INTO']);
    withDb(path.join(backupsDir(), backups()[0]), (snapshot) => {
      assert.ok(snapshot.prepare("SELECT 1 FROM workspaces WHERE id = 'ws-later'").get(), 'the latest commit is in it');
    });
    assert.equal(applied(db, PENDING), true);
    assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 15_000, 'busy timeout restored');
  } finally {
    reader.exec('ROLLBACK');
    reader.close();
    writer.close();
  }
});

test('a commit that reaches the WAL before the write lock makes the snapshot VACUUM INTO', (t) => {
  existingDbWithPendingMigration();
  const methods = copyMethods(t);
  const statSync = fs.statSync;
  t.mock.method(fs, 'statSync', ((file: fs.PathLike, ...rest: unknown[]) =>
    String(file).endsWith('data.db-wal') ? { size: 4096 } : (statSync as (...args: unknown[]) => unknown)(file, ...rest)
  ) as typeof fs.statSync);

  initDb();

  assert.deepEqual(methods(), ['VACUUM INTO']);
  assert.equal(backups().length, 1);
});

test('a connection holding the write lock makes the snapshot VACUUM INTO', (t) => {
  const db = smallDb();
  const holder = new DatabaseSync(path.join(dataDir, 'data.db'));
  const methods = copyMethods(t);
  try {
    holder.exec('BEGIN IMMEDIATE');
    db.exec('PRAGMA busy_timeout = 15000');

    const startedAt = Date.now();
    const created = snapshotBeforeMigrations(db, '0002_next');

    assert.ok(created);
    assert.ok(Date.now() - startedAt < 10_000);
    assert.deepEqual(methods(), ['VACUUM INTO']);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
    db.close();
  }
});

test('retention keeps the snapshots within three times the database size, dropping the oldest first', () => {
  fs.mkdirSync(backupsDir());
  const db = smallDb();
  const databaseBytes = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
    * (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  // Newest first: two full-size snapshots fit beside the new one (3 × the size), the third does not.
  const sized = [
    ['data-2020-01-04T00-00-00.000Z-pre-0001_old.db', databaseBytes],
    ['data-2020-01-03T00-00-00.000Z-pre-0001_old.db', databaseBytes],
    ['data-2020-01-02T00-00-00.000Z-pre-0001_old.db', 1],
  ] as const;
  for (const [file, bytes] of sized) fs.writeFileSync(path.join(backupsDir(), file), Buffer.alloc(bytes));

  const created = snapshotBeforeMigrations(db, '0002_next');
  db.close();

  assert.ok(created);
  assert.equal(fs.statSync(created).size, databaseBytes);
  assert.deepEqual(backups(), [sized[1][0], sized[0][0], path.basename(created)].sort());
});

test('retention never keeps an older snapshot after dropping a newer one that does not fit', () => {
  fs.mkdirSync(backupsDir());
  const db = smallDb();
  const tooLarge = 'data-2020-01-02T00-00-00.000Z-pre-0001_old.db';
  const small = 'data-2020-01-01T00-00-00.000Z-pre-0001_old.db';
  fs.writeFileSync(path.join(backupsDir(), tooLarge), Buffer.alloc(1024 * 1024));
  fs.writeFileSync(path.join(backupsDir(), small), 'x');

  const created = snapshotBeforeMigrations(db, '0002_next');
  db.close();

  assert.ok(created);
  assert.deepEqual(backups(), [path.basename(created)]);
});

test('a temporary copy\'s SQLite side files left by a dead process are removed too', () => {
  fs.mkdirSync(backupsDir());
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const leftovers = ['', '-wal', '-shm', '-journal'].map((suffix) => `data.snapshot-${deadPid}-0badf00d.tmp${suffix}`);
  for (const file of leftovers) fs.writeFileSync(path.join(backupsDir(), file), 'partial');
  const db = smallDb();

  const created = snapshotBeforeMigrations(db, '0002_next');
  db.close();

  assert.ok(created);
  assert.deepEqual(backups(), [path.basename(created)]);
});

test('with MICHI_CLOUD=1 there is no snapshot unless MICHI_MIGRATION_SNAPSHOTS=1', () => {
  const dbPath = existingDbWithPendingMigration();
  process.env.MICHI_CLOUD = '1';
  process.env.MICHI_REQUIRE_AUTH = 'true';

  const db = initDb();
  assert.equal(applied(db, PENDING), true);
  assert.equal(fs.existsSync(backupsDir()), false, 'off by default for a multi-account database');
  closeDb();

  makePendingAgain(dbPath);
  process.env.MICHI_MIGRATION_SNAPSHOTS = '1';
  initDb();
  assert.equal(backups().length, 1, 'the operator opted in');
});
