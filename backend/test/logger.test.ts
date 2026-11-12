import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const backendRoot = path.resolve(__dirname, '..');

/** Loads the logger in a fresh process, since it reads its settings when it loads. */
function logInChild(extraEnv: NodeJS.ProcessEnv) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-logger-'));
  const env: NodeJS.ProcessEnv = { ...process.env, MICHI_LOG_DIR: logDir, TS_NODE_TRANSPILE_ONLY: '1', ...extraEnv };
  if (!extraEnv.MICHI_SERVICE_MODE) delete env.MICHI_SERVICE_MODE;
  const script = [
    "const { log } = require('./src/services/logger');",
    "log.info('http', 'POST /api/x 200');",
    "log.warn('boot', 'slow');",
    "log.error('boot', 'failed');",
  ].join('\n');
  const child = spawnSync(process.execPath, ['--require', 'ts-node/register', '-e', script], { cwd: backendRoot, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return { stdout: child.stdout, stderr: child.stderr, file: fs.readFileSync(path.join(logDir, 'backend.log'), 'utf8') };
}

test('the logger mirrors INFO and WARN to stdout and ERROR to stderr', () => {
  const { stdout, stderr, file } = logInChild({});
  assert.match(stdout, /INFO .*POST \/api\/x 200\n.*WARN .*slow\n$/);
  assert.match(stderr, /ERROR .*failed\n$/);
  assert.equal(file.split('\n').filter(Boolean).length, 3);
});

test('a background service keeps stdout quiet: backend.log has the lines and rotates, launchd stdout does not', () => {
  const { stdout, stderr, file } = logInChild({ MICHI_SERVICE_MODE: '1' });
  assert.equal(stdout, '');
  assert.match(stderr, /ERROR .*failed\n$/);
  assert.equal(file.split('\n').filter(Boolean).length, 3);
});
