import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./ci/npm-ci.sh', import.meta.url));
const fetchArgs = ['ci', '--fetch-retries=5', '--fetch-retry-factor=2',
  '--fetch-retry-mintimeout=10000', '--fetch-retry-maxtimeout=60000'];

function invoke(attempts, { brokenTee = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'michi npm retry '));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.RUNNER_TEMP;
const countFile = dir + '/calls';
const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
fs.writeFileSync(countFile, String(count + 1));
fs.appendFileSync(dir + '/argv', JSON.stringify(process.argv.slice(2)) + '\\n');
const attempt = JSON.parse(process.env.MICHI_TEST_NPM_ATTEMPTS)[count];
if (!attempt) process.exit(99);
console.log(attempt.output);
process.exit(attempt.status);
`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nprintf "%s\\n" "$1" >> "$RUNNER_TEMP/sleeps"\n', { mode: 0o755 });
  if (brokenTee) writeFileSync(path.join(bin, 'tee'), '#!/bin/bash\ncat >/dev/null\nexit 1\n', { mode: 0o755 });
  try {
    const result = spawnSync('/bin/bash', [script], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: dir,
        MICHI_TEST_NPM_ATTEMPTS: JSON.stringify(attempts) },
    });
    assert.ifError(result.error);
    const calls = Number(readFileSync(path.join(dir, 'calls'), 'utf8'));
    const argv = readFileSync(path.join(dir, 'argv'), 'utf8').trim().split('\n').map(JSON.parse);
    for (const args of argv) assert.deepEqual(args, fetchArgs);
    const logDir = readdirSync(dir).find((name) => name.startsWith('michi-npm-ci.'));
    const logs = readdirSync(path.join(dir, logDir)).sort().map((name) => readFileSync(path.join(dir, logDir, name), 'utf8'));
    const sleeps = readdirSync(dir).includes('sleeps') ? readFileSync(path.join(dir, 'sleeps'), 'utf8').trim().split('\n') : [];
    return { ...result, calls, logs, sleeps };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ok = { status: 0, output: 'installed successfully' };
const reset = { status: 1, output: 'npm error code ECONNRESET\nnpm error network aborted' };

test('success runs once, streams output and keeps its complete log', () => {
  const r = invoke([ok]);
  assert.equal(r.status, 0);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.sleeps, []);
  assert.deepEqual(r.logs, [ok.output + '\n']);
  assert.match(r.stdout, /installed successfully/);
});

for (const diagnostic of ['npm error code ECONNRESET', 'npm ERR! code EAI_AGAIN',
  'npm error RequestError: read ETIMEDOUT', 'npm error code E503']) {
  test(`recovers ${diagnostic} with a fresh log per attempt`, () => {
    const r = invoke([{ status: 1, output: diagnostic }, ok]);
    assert.equal(r.status, 0);
    assert.equal(r.calls, 2);
    assert.deepEqual(r.sleeps, ['15']);
    assert.deepEqual(r.logs, [diagnostic + '\n', ok.output + '\n']);
  });
}

test('stops after three attempts, backs off and preserves the final exit code', () => {
  const r = invoke([reset, reset, { ...reset, status: 42 }]);
  assert.equal(r.status, 42);
  assert.equal(r.calls, 3);
  assert.deepEqual(r.sleeps, ['15', '30']);
  assert.equal(r.logs.length, 3);
});

for (const output of ['npm error code EUSAGE\npackage-lock is out of sync',
  'npm error code ERESOLVE', 'npm error code E404', 'npm error code E401',
  'npm error code E403', 'gyp ERR! build error', 'src/app.ts: error TS2307: Cannot find module',
  'npm error command failed', 'npm warn ECONNRESET\nnpm error command failed',
  'npm error code ECONNRESET_EXTRA', `${reset.output}\nnpm error code EUSAGE`,
  `${reset.output}\ngyp ERR! build error`]) {
  test(`does not retry deterministic or unclassified failure: ${output}`, () => {
    const r = invoke([{ status: 2, output }]);
    assert.equal(r.status, 2);
    assert.equal(r.calls, 1);
    assert.deepEqual(r.sleeps, []);
  });
}

test('an earlier network failure does not make a later unknown failure retryable', () => {
  const r = invoke([reset, { status: 7, output: 'npm error command failed' }]);
  assert.equal(r.status, 7);
  assert.equal(r.calls, 2);
  assert.deepEqual(r.sleeps, ['15']);
});

test('cancellation and broken log capture do not trigger another installation', () => {
  const cancelled = invoke([{ ...reset, status: 143 }]);
  assert.equal(cancelled.status, 143);
  assert.equal(cancelled.calls, 1);
  const logFailure = invoke([reset], { brokenTee: true });
  assert.equal(logFailure.status, 1);
  assert.equal(logFailure.calls, 1);
  assert.match(logFailure.stderr, /Could not retain npm output/);
});

test('release workflow bounds installation and retains failure logs; test is registered', () => {
  const workflow = readFileSync(new URL('../.github/workflows/build-dmg.yml', import.meta.url), 'utf8');
  assert.match(workflow, /name: Install dependencies\n\s+timeout-minutes: 12\n\s+run: bash scripts\/ci\/npm-ci\.sh/);
  assert.match(workflow, /name: Upload failed dependency installation logs\n\s+if: failure\(\)/);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/michi-npm-ci\.\*\/attempt-\*\.log/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts['test:contracts'].split(' ').includes('scripts/ci-npm-install.test.mjs'));
});
