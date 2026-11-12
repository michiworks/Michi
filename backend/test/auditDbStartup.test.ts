/**
 * audit.db at startup and after a failure (services/db.ts, services/audit.ts):
 * an existing audit.db is opened, snapshotted and migrated before the server
 * listens; when that fails, audit records are dropped without retrying the
 * copy on every write, the failure is logged once and shown in /api/health.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { auditDbUnavailable, closeAuditDb, getAuditDb, openExistingAuditDb } from '../src/services/db';
import { auditLogHealth, recordAudit } from '../src/services/audit';
import { log } from '../src/services/logger';

const AUDIT_MIGRATION = '0000_audit_init';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-audit-startup-'));
  process.env.MICHI_DATA_DIR = dataDir;
  closeAuditDb();
});

afterEach(() => {
  closeAuditDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const auditPath = () => path.join(dataDir, 'audit.db');
const backupsDir = () => path.join(dataDir, 'backups');

/** An audit.db with one record whose only migration is then unrecorded, so opening it migrates again. */
function auditDbWithPendingMigration(): void {
  recordAudit({ action: 'auth.sign_out' });
  closeAuditDb();
  const raw = new DatabaseSync(auditPath());
  raw.exec(`DELETE FROM schema_migrations WHERE version = '${AUDIT_MIGRATION}'`);
  raw.close();
}

function migrated(): boolean {
  const raw = new DatabaseSync(auditPath(), { readOnly: true });
  try {
    return !!raw.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(AUDIT_MIGRATION);
  } finally {
    raw.close();
  }
}

function records(): number {
  const raw = new DatabaseSync(auditPath(), { readOnly: true });
  try {
    return (raw.prepare('SELECT count(*) AS n FROM audit_log').get() as { n: number }).n;
  } finally {
    raw.close();
  }
}

test('startup does not create audit.db', () => {
  openExistingAuditDb();

  assert.equal(fs.existsSync(auditPath()), false);
  assert.equal(auditDbUnavailable(), false);
});

test('an existing audit.db with a pending migration is snapshotted and migrated at startup', () => {
  auditDbWithPendingMigration();

  openExistingAuditDb();

  assert.equal(migrated(), true);
  assert.deepEqual(fs.readdirSync(backupsDir()).map((file) => /^audit-.*-pre-(.+)\.db$/.exec(file)?.[1]), [AUDIT_MIGRATION]);
  recordAudit({ action: 'auth.sign_out' });
  assert.equal(records(), 2, 'the request path writes to the database opened at startup');
});

test('after a failed start, audit records are dropped without another copy until restart, logged once', (t) => {
  auditDbWithPendingMigration();
  fs.writeFileSync(backupsDir(), 'not a directory'); // the snapshot fails
  const errors = t.mock.method(log, 'error');

  openExistingAuditDb();

  assert.equal(auditDbUnavailable(), true);
  assert.deepEqual(auditLogHealth(), { auditLog: 'unavailable' });
  // Fixing the cause does not matter until a restart: no write tries again.
  fs.rmSync(backupsDir());
  for (let i = 0; i < 3; i++) assert.doesNotThrow(() => recordAudit({ action: 'auth.sign_out' }));
  assert.throws(() => getAuditDb(), /Michi did not migrate .*audit\.db/);
  assert.equal(fs.existsSync(backupsDir()), false, 'no further snapshot attempt');
  assert.equal(migrated(), false);
  assert.equal(records(), 1, 'the three records were dropped');
  const unavailable = errors.mock.calls.filter((call) => call.arguments[1] === 'audit database unavailable until restart; audit records are dropped');
  assert.equal(unavailable.length, 1);

  closeAuditDb(); // what a restart does
  recordAudit({ action: 'auth.sign_out' });

  assert.equal(auditDbUnavailable(), false);
  assert.deepEqual(auditLogHealth(), {});
  assert.equal(migrated(), true);
  assert.equal(records(), 2);
  assert.equal(fs.readdirSync(backupsDir()).length, 1);
});
