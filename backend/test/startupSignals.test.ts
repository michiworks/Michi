/**
 * SIGINT/SIGTERM during startup (services/startupSignals.ts): they wait for the
 * event loop instead of killing a synchronous step such as the pre-migration
 * snapshot, then go to the graceful shutdown server.ts installs later, or end
 * the process with 128 + the signal number when none was installed.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { closeAuditDb, closeDb, initDb } from '../src/services/db';

const BACKEND_DIR = path.resolve(__dirname, '..');
const POSIX = process.platform !== 'win32';
/** Only CREATE INDEX IF NOT EXISTS, so the test can mark it unapplied and rerun it. */
const PENDING = '0048_task_activity_indexes';
const PENDING_INDEX = 'idx_page_changes_database_pending';

/** Run `script` (CommonJS, resolved from backend/) in a child Node process. */
function runChild(script: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--require', 'ts-node/register', '-e', script], {
    cwd: BACKEND_DIR,
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', ...env },
    encoding: 'utf8',
    timeout: 90_000,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

/** Keeps the child's event loop running, as the server's listener does, so a waiting signal is handled. */
const KEEP_ALIVE = "setTimeout(() => console.log('timed out'), 20000);";

describe('signals while the backend starts', { skip: !POSIX }, () => {
  test('without the startup handlers a signal kills startup at once', () => {
    const child = runChild(`process.kill(process.pid, 'SIGTERM'); console.log('continued');`);

    assert.equal(child.signal, 'SIGTERM');
    assert.equal(child.stdout, '');
  });

  for (const [signal, status] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
    test(`${signal} waits for the synchronous step, then ends the process with ${status}`, () => {
      const child = runChild(`
        const { installStartupSignalHandlers } = require('./src/services/startupSignals');
        installStartupSignalHandlers();
        process.kill(process.pid, '${signal}');
        const until = Date.now() + 200; while (Date.now() < until) {}
        console.log('step finished');
        ${KEEP_ALIVE}
      `);

      assert.equal(child.signal, null, child.stderr);
      assert.equal(child.status, status, child.stderr);
      // Then the handler's own log line, unless the exit cut it off.
      assert.equal(child.stdout.split('\n')[0], 'step finished');
      assert.doesNotMatch(child.stdout, /timed out/);
    });
  }

  test('a signal that arrived during startup goes to the graceful shutdown installed later', () => {
    const child = runChild(`
      const { installStartupSignalHandlers } = require('./src/services/startupSignals');
      const release = installStartupSignalHandlers();
      process.kill(process.pid, 'SIGTERM');
      console.log('started');
      process.on('SIGTERM', () => { console.log('graceful shutdown'); process.exit(0); });
      release();
      ${KEEP_ALIVE}
    `);

    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'started\ngraceful shutdown\n');
  });
});

describe('a signal during the pre-migration snapshot', { skip: !POSIX }, () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-startup-signal-'));
    process.env.MICHI_DATA_DIR = dataDir;
    closeDb();
    closeAuditDb();
  });

  afterEach(() => {
    closeDb();
    closeAuditDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('no longer loses the migration: the snapshot and migrations finish, then the process exits', () => {
    initDb();
    closeDb();
    const dbPath = path.join(dataDir, 'data.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`DROP INDEX ${PENDING_INDEX}; DELETE FROM schema_migrations WHERE version = '${PENDING}';`);
    raw.close();

    // The signal is sent as initDb starts, so it is waiting while the copy is made.
    const child = runChild(`
      const { installStartupSignalHandlers } = require('./src/services/startupSignals');
      const { initDb } = require('./src/services/db');
      installStartupSignalHandlers();
      process.kill(process.pid, 'SIGTERM');
      initDb();
      console.log('migrated');
      ${KEEP_ALIVE}
    `, { MICHI_DATA_DIR: dataDir });

    assert.equal(child.status, 143, child.stderr);
    assert.ok(child.stdout.split('\n').includes('migrated'), child.stdout);
    assert.doesNotMatch(child.stdout, /timed out/);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(PENDING), 'the migration was applied');
    } finally {
      db.close();
    }
    const backups = fs.readdirSync(path.join(dataDir, 'backups'));
    assert.equal(backups.length, 1, `one snapshot, no temporary copy: ${backups.join(', ')}`);
    assert.match(backups[0], new RegExp(`^data-.*-pre-${PENDING}\\.db$`));
  });
});
