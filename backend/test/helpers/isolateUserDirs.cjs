// Preloaded by the backend test runner (see test:raw). Without it a test would open the user's own ~/.michi
// (data.db, config.json, logs). Each test file's process gets its own temporary directories, removed when it
// exits. Values a test sets itself are kept: a test sets them in code (after this preload) or in the env of a
// child process it spawns, and such descendants see MICHI_TEST_ISOLATED_ROOT and keep what they inherit.
//
// Values inherited from the developer's shell are replaced, not kept: a shell that exports
// MICHI_DATA_DIR=~/.michi would otherwise point every test at the real database, and exported remote-access or
// auth settings would change how routes authenticate. Set MICHI_TEST_KEEP_ENV_DIRS=1 to keep inherited
// directories deliberately.
//
// A new data.db runs every file in src/db/migrations, and most test files open a new one for each test. So in
// each test file's process, initDb (services/db.ts) starts a data.db that does not exist yet as a copy of one
// this process's own initDb migrated once, in its temporary directory: the copy has no pending migration, so
// initDb migrates nothing and takes no snapshot, as for any database that is up to date. A database that
// exists (a test made it, or opened it before) opens as it is, as every one does when the copy cannot be made.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIRS = [['MICHI_DATA_DIR', 'data'], ['MICHI_CONFIG_DIR', 'config'], ['MICHI_LOG_DIR', 'logs']];
// Deployment settings a developer shell may export for a running backend; tests that need them set them in code.
const SHELL_ONLY = ['MICHI_REMOTE_ACCESS', 'MICHI_REMOTE_TOKEN', 'MICHI_BIND_HOST', 'MICHI_CLOUD', 'MICHI_REQUIRE_AUTH'];
// Switches that make golden tests rewrite their fixtures (MICHI_UPDATE_MCP_GOLDEN and the like). One left
// exported in a shell would re-baseline them silently, so they count only with MICHI_GOLDEN_WRITE_CONFIRM=1.
const GOLDEN_CONFIRM = 'MICHI_GOLDEN_WRITE_CONFIRM';

// The runner's own process only spawns one child per file; its directories would be shared by all of them.
const runnerParent = !process.env.NODE_TEST_CONTEXT && process.execArgv.includes('--test');
// A process spawned by an already isolated test inherits that test's choices.
const descendant = Boolean(process.env.MICHI_TEST_ISOLATED_ROOT);

// Also in the runner's own process, so the files it spawns start without them and this is said once.
if (!descendant && process.env[GOLDEN_CONFIRM] !== '1') {
  for (const name of Object.keys(process.env)) {
    if (!name.includes('GOLDEN') || name === GOLDEN_CONFIRM) continue;
    delete process.env[name];
    console.error(`Ignoring ${name}: golden fixtures are rewritten only with ${GOLDEN_CONFIRM}=1 as well.`);
  }
}

if (!runnerParent && !descendant) {
  const keepInherited = process.env.MICHI_TEST_KEEP_ENV_DIRS === '1';
  const dirs = DIRS.filter(([name]) => !(keepInherited && process.env[name]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-test-dirs-'));
  for (const [name, sub] of dirs) process.env[name] = path.join(root, sub);
  for (const name of SHELL_ONLY) delete process.env[name];
  process.env.MICHI_TEST_ISOLATED_ROOT = root;
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  startDatabasesMigrated(path.join(root, 'db-template'));
}

/** Has initDb start a data.db that does not exist yet from one migrated once, in `dir`; needs ts-node's loader. */
function startDatabasesMigrated(dir) {
  const extensions = require('node:module')._extensions;
  const loadTs = extensions['.ts'];
  if (typeof loadTs !== 'function') return;
  const dbModule = fs.realpathSync(path.join(__dirname, '..', '..', 'src', 'services', 'db.ts'));
  extensions['.ts'] = function loadTsModule(module, filename) {
    loadTs.call(this, module, filename);
    if (filename === dbModule) startFromMigrated(module.exports, dir);
  };
}

/** A database's files: where a stray WAL or journal is left, initDb would read it into whatever data.db it finds. */
const DATABASE_FILES = ['', '-wal', '-shm', '-journal'];

function startFromMigrated(db, dir) {
  const initDb = db.initDb;
  /** The migrated data.db; null once making it failed, so that initDb migrates each one itself. */
  let migrated;
  db.initDb = function initDbFromMigrated() {
    const target = db.isDbOpen() ? null : db.getDbPath();
    if (target && !DATABASE_FILES.some((suffix) => fs.existsSync(target + suffix))) {
      if (migrated === undefined) migrated = migrateOnce(db, initDb, dir);
      if (migrated) copyNew(migrated, target);
    }
    return initDb();
  };
}

/** initDb's own work on an empty data.db in `dir`, closed (which checkpoints its WAL into the file): that file, or null. */
function migrateOnce(db, initDb, dir) {
  const dataDir = process.env.MICHI_DATA_DIR;
  process.env.MICHI_DATA_DIR = dir;
  try {
    initDb();
    return path.join(dir, 'data.db');
  } catch {
    return null;
  } finally {
    db.closeDb();
    if (dataDir === undefined) delete process.env.MICHI_DATA_DIR;
    else process.env.MICHI_DATA_DIR = dataDir;
  }
}

function copyNew(source, target) {
  try {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    // initDb then makes the database as it always did; a partial copy must not be what it opens.
    if (err.code !== 'EEXIST') fs.rmSync(target, { force: true });
  }
}
