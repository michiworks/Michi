import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isOwnerScopedAccess } from './accessPolicy';
import { log } from './logger';

/**
 * Pre-migration snapshots. Before the first pending migration changes an
 * existing database, a verified copy of it is kept in `backups/` beside the
 * database file (the data directory, for data.db and audit.db):
 *
 *   backups/<name>-<UTC timestamp>-pre-<first pending migration>.db
 *   e.g. backups/data-2026-11-05T14-30-12.345Z-pre-0064_attention.db
 *
 * The copy is a copy of the database file (a clone on filesystems that support
 * it), taken while the WAL is checkpointed into that file and this connection
 * holds the write lock, so no other connection can change the file mid-copy.
 * When that cannot be arranged (another connection is reading or writing) or
 * the file copy fails, VACUUM INTO writes a consistent copy instead. Either
 * way the copy is written under a temporary name, fsynced, reopened read-only,
 * and must pass PRAGMA quick_check and hold as many schema objects as the
 * database before it gets the snapshot name, so every file with that name is a
 * verified snapshot. Then this database's oldest snapshots are removed until at
 * most SNAPSHOTS_KEPT remain, together at most SNAPSHOT_BUDGET times the
 * database's size. The one just written always stays; no other file in the
 * directory is touched.
 *
 * A snapshot holds everything the database held, so content deleted or purged
 * afterwards (Trash, account deletion) stays in it until retention removes it.
 * Snapshots are private to this OS user (backups/ 0700, files 0600). With
 * MICHI_CLOUD=1, where one database holds many accounts, they are off unless
 * MICHI_MIGRATION_SNAPSHOTS=1.
 *
 * Any failure, including too little free space, throws before a migration
 * runs, so the database stays as it was. MICHI_SKIP_MIGRATION_SNAPSHOT=1
 * migrates without a snapshot.
 */

const SNAPSHOTS_KEPT = 5;
/** All snapshots of a database together stay within this many times its size. */
const SNAPSHOT_BUDGET = 3;
/** Headroom over page_count × page_size for the free-space check. */
const SPACE_MARGIN = 1.1;
const SKIP_ENV = 'MICHI_SKIP_MIGRATION_SNAPSHOT';
const CLOUD_OPT_IN_ENV = 'MICHI_MIGRATION_SNAPSHOTS';
/** How long the file copy waits for other connections before VACUUM INTO is used instead. */
const FILE_COPY_LOCK_WAIT_MS = 1000;
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;
/** Files SQLite creates beside a database it opens. */
const SIDE_FILES = ['-wal', '-shm', '-journal'];
const STAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z`;
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9._-]/g;

type CopyMethod = 'file copy' | 'VACUUM INTO';

/**
 * Snapshot `db` before migrating it, when `firstPending` names the first
 * migration about to run. Nothing is written (and null returned) when nothing
 * is pending, for an in-memory or temporary database, for one without a
 * schema yet (freshly created), and when snapshots are off. Returns the
 * snapshot's path, or throws an error naming the cause and the escape hatch.
 */
export function snapshotBeforeMigrations(db: DatabaseSync, firstPending: string | undefined): string | null {
  if (!firstPending) return null;
  const dbPath = databaseFile(db);
  if (!dbPath) return null;
  const objects = schemaObjects(db);
  if (objects === 0) return null;
  const off = snapshotsOffReason();
  if (off) {
    log.warn('boot', 'migrating without a pre-migration snapshot', { db: dbPath, firstMigration: firstPending, reason: off });
    return null;
  }

  const startedAt = performance.now();
  let snapshot: { file: string; bytes: number; databaseBytes: number; method: CopyMethod };
  try {
    snapshot = writeSnapshot(db, dbPath, firstPending, objects);
  } catch (err) {
    const reason = (err as Error).message;
    log.error('boot', 'pre-migration snapshot failed; not migrating', { db: dbPath, firstMigration: firstPending, error: reason });
    throw new Error(
      `Michi did not migrate ${dbPath}: the snapshot taken before migration ${firstPending} failed (${reason}). ` +
        `The database was not changed. Fix the cause and restart, or set ${SKIP_ENV}=1 to migrate without a snapshot.`,
      { cause: err },
    );
  }
  const pruned = pruneSnapshots(
    path.dirname(snapshot.file),
    snapshotBase(dbPath),
    path.basename(snapshot.file),
    SNAPSHOT_BUDGET * Math.max(snapshot.databaseBytes, snapshot.bytes),
  );
  log.info('boot', 'pre-migration snapshot written', {
    db: dbPath,
    snapshot: snapshot.file,
    bytes: snapshot.bytes,
    method: snapshot.method,
    durationMs: Math.round(performance.now() - startedAt),
    firstMigration: firstPending,
    pruned,
  });
  return snapshot.file;
}

/** Why no snapshot is taken, or null when one is. */
function snapshotsOffReason(): string | null {
  if (process.env[SKIP_ENV] === '1') return `${SKIP_ENV}=1`;
  // A cloud database holds every account, and an account's deletion does not
  // reach copies of it: keeping them is the operator's explicit choice.
  if (isOwnerScopedAccess() && process.env[CLOUD_OPT_IN_ENV] !== '1') return `MICHI_CLOUD=1 without ${CLOUD_OPT_IN_ENV}=1`;
  return null;
}

function writeSnapshot(
  db: DatabaseSync,
  dbPath: string,
  firstPending: string,
  objects: number,
): { file: string; bytes: number; databaseBytes: number; method: CopyMethod } {
  const dir = path.join(path.dirname(dbPath), 'backups');
  const base = snapshotBase(dbPath);
  ensurePrivateDirectory(dir);
  removeAbandonedCopies(dir, base);
  const databaseBytes = ensureFreeSpace(db, dir);
  // A large copy takes a while; a log that ends here explains a slow start.
  log.info('boot', 'writing a pre-migration snapshot', { db: dbPath, bytes: databaseBytes, firstMigration: firstPending });

  const temp = path.join(dir, `${base}.snapshot-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    let method: CopyMethod = 'file copy';
    if (!copyDatabaseFile(db, dbPath, temp)) {
      method = 'VACUUM INTO';
      // Created private, so the copy never has a moment with wider permissions.
      fs.closeSync(fs.openSync(temp, 'wx', PRIVATE_FILE));
      db.prepare('VACUUM INTO ?').run(temp);
    }
    fs.chmodSync(temp, PRIVATE_FILE);
    fsyncFile(temp);
    verifyCopy(temp, objects);
    const file = availableName(dir, base, firstPending);
    fs.renameSync(temp, file);
    fsyncDirectory(dir);
    return { file, bytes: fs.statSync(file).size, databaseBytes, method };
  } finally {
    removeCopy(temp); // already gone after the rename
  }
}

/**
 * Copy the database file itself to `temp`: much faster than VACUUM INTO, and a
 * near-instant clone on APFS, Btrfs or XFS. The file alone is the whole
 * database once the WAL is checkpointed into it and truncated, and stays so
 * while this connection holds the write lock: no other connection can commit,
 * so none can add pages to the WAL or checkpoint them into the file. At startup
 * this connection is normally the only one; when another one is reading an
 * older state or writing, or anything here fails, this returns false with no
 * copy left and the caller uses VACUUM INTO, which needs neither.
 */
function copyDatabaseFile(db: DatabaseSync, dbPath: string, temp: string): boolean {
  const busyTimeout = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
  db.exec(`PRAGMA busy_timeout = ${FILE_COPY_LOCK_WAIT_MS}`);
  let fallback: string | null = null;
  try {
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
    if (checkpoint.busy !== 0) {
      fallback = 'another connection is using the database';
    } else {
      db.exec('BEGIN IMMEDIATE');
      try {
        // A commit that slipped in before the lock left pages only in the WAL.
        if (fileSize(`${dbPath}-wal`) !== 0) fallback = 'another connection wrote to the database';
        else fs.copyFileSync(dbPath, temp, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      } finally {
        db.exec('ROLLBACK');
      }
    }
    if (!fallback) {
      // The copy has the database's permissions, and SQLite gives the files it
      // creates beside a database the database's own: private first.
      fs.chmodSync(temp, PRIVATE_FILE);
      // A copy of a WAL database is one too; opened read-only to verify it,
      // it would leave -wal and -shm files behind. As VACUUM INTO writes it,
      // the snapshot is a rollback-journal database: one self-contained file.
      const copy = new DatabaseSync(temp);
      try {
        copy.exec('PRAGMA journal_mode = DELETE');
      } finally {
        copy.close();
      }
    }
  } catch (err) {
    fallback = (err as Error).message;
  } finally {
    db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  }
  if (fallback === null) return true;
  removeCopy(temp);
  log.info('boot', 'pre-migration snapshot uses VACUUM INTO instead of a file copy', { db: dbPath, reason: fallback });
  return false;
}

/** The main database's file; empty (null) for an in-memory or temporary database. */
function databaseFile(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get() as { file: string } | undefined;
  return row?.file || null;
}

function schemaObjects(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS n FROM sqlite_master').get() as { n: number }).n;
}

/** `data` for data.db: the file name without its extension. */
function snapshotBase(dbPath: string): string {
  return path.parse(dbPath).name.replace(UNSAFE_NAME_CHARS, '_');
}

/**
 * backups/ holds whole copies of the database, so it is private to this OS
 * user, also when an earlier build created it with default permissions. On
 * Windows the profile directory's ACL decides; mode bits do not apply.
 */
function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY });
  if (process.platform === 'win32') return;
  if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, PRIVATE_DIRECTORY);
}

/** The database's size (page_count × page_size), once the disk is known to have room for a copy. */
function ensureFreeSpace(db: DatabaseSync, dir: string): number {
  const { page_count: pages } = db.prepare('PRAGMA page_count').get() as { page_count: number };
  const { page_size: pageSize } = db.prepare('PRAGMA page_size').get() as { page_size: number };
  const bytes = pages * pageSize;
  const needed = Math.ceil(bytes * SPACE_MARGIN);
  let free: number;
  try {
    const stats = fs.statfsSync(dir);
    free = stats.bavail * stats.bsize;
  } catch (err) {
    // The copy still fails cleanly if the disk fills up.
    log.warn('boot', 'free disk space unknown; snapshotting without the space check', { dir, error: (err as Error).message });
    return bytes;
  }
  if (free < needed) {
    throw new Error(`only ${megabytes(free)} free on the disk holding ${dir}, and the snapshot needs about ${megabytes(needed)}; free up disk space`);
  }
  return bytes;
}

function verifyCopy(file: string, expectedObjects: number): void {
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    const results = (copy.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>).map((row) => row.quick_check);
    if (results.length !== 1 || results[0] !== 'ok') {
      throw new Error(`the copy failed PRAGMA quick_check: ${results.slice(0, 3).join('; ')}`);
    }
    const objects = schemaObjects(copy);
    if (objects !== expectedObjects) {
      throw new Error(`the copy has ${objects} schema objects, the database ${expectedObjects}`);
    }
  } finally {
    copy.close();
  }
}

/** The snapshot name for now, a millisecond later if that name is taken. */
function availableName(dir: string, base: string, firstPending: string): string {
  const migration = firstPending.replace(UNSAFE_NAME_CHARS, '_');
  for (let at = Date.now(); ; at++) {
    const file = path.join(dir, `${base}-${new Date(at).toISOString().replace(/:/g, '-')}-pre-${migration}.db`);
    if (!fs.existsSync(file)) return file;
  }
}

/**
 * Remove this database's oldest snapshots until at most SNAPSHOTS_KEPT remain
 * and they total at most `budgetBytes`; never `keep` (the one just written,
 * even if the clock went back). The newest snapshots that fit stay; the first
 * one that does not and every older one go. Only names in the exact snapshot
 * pattern count. Returns how many were removed.
 */
function pruneSnapshots(dir: string, base: string, keep: string, budgetBytes: number): number {
  const pattern = new RegExp(`^${escapeRegExp(base)}-${STAMP}-pre-[A-Za-z0-9._-]+\\.db$`);
  let removed = 0;
  try {
    const older = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== keep && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    let kept = 1;
    let bytes = fs.statSync(path.join(dir, keep)).size;
    let pruning = false;
    for (const name of older) {
      const file = path.join(dir, name);
      if (!pruning) {
        const size = fileSize(file);
        if (kept < SNAPSHOTS_KEPT && bytes + size <= budgetBytes) {
          kept++;
          bytes += size;
          continue;
        }
        pruning = true;
      }
      try {
        fs.unlinkSync(file);
        removed++;
      } catch (err) {
        log.warn('boot', 'could not remove an old pre-migration snapshot', { file, error: (err as Error).message });
      }
    }
  } catch (err) {
    log.warn('boot', 'could not prune old pre-migration snapshots', { dir, error: (err as Error).message });
  }
  return removed;
}

/**
 * Remove temporary copies (and SQLite's files beside them) left by a process
 * that died mid-snapshot, e.g. killed by a launcher's health timeout. A copy
 * whose process is still running may be in progress, so it stays.
 */
function removeAbandonedCopies(dir: string, base: string): void {
  const pattern = new RegExp(`^${escapeRegExp(base)}\\.snapshot-(\\d+)-[0-9a-f]{8}\\.tmp(?:${SIDE_FILES.join('|')})?$`);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const match = entry.isFile() ? pattern.exec(entry.name) : null;
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid !== process.pid && processAlive(pid)) continue;
    removeQuietly(path.join(dir, entry.name));
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Size in bytes; 0 for a file that does not exist. */
function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

function fsyncFile(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Persist the rename where the platform can fsync a directory (not Windows). */
function fsyncDirectory(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Best effort: the snapshot file itself is already on disk.
  }
}

/** A temporary copy and any files SQLite created beside it. */
function removeCopy(temp: string): void {
  for (const suffix of ['', ...SIDE_FILES]) removeQuietly(temp + suffix);
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // A leftover copy is removed by the next snapshot of this database.
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
