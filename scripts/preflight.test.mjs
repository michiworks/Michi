import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { formatReport, MARKER, preflight } from './preflight.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'preflight.mjs');

const LOCK = {
  lockfileVersion: 3,
  packages: {
    '': { workspaces: ['frontend', 'backend', 'shared', 'runtime'], devDependencies: { tool: '1.0.0' } },
    backend: { dependencies: { 'michi-runtime': 'file:../runtime', 'michi-shared': 'file:../shared', pi: '1.5.0' } },
    frontend: { dependencies: { 'michi-shared': 'file:../shared', zod: '^3.25.0' } },
    runtime: { dependencies: { ws: '^8.0.0' } },
    shared: {},
    'node_modules/michi-runtime': { resolved: 'runtime', link: true },
    'node_modules/michi-shared': { resolved: 'shared', link: true },
    'node_modules/pi': { version: '1.5.0', dependencies: { glob: '^1.0.0' } },
    'node_modules/pi/node_modules/glob': { version: '1.0.3' },
    'node_modules/ws': { version: '8.0.0' },
    'node_modules/zod': { version: '3.25.0' },
    'node_modules/tool': { version: '1.0.0', dev: true },
    'node_modules/fsevents': { version: '2.3.3', optional: true },
  },
};

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

// A checkout whose install matches LOCK; `installed` overrides versions (undefined leaves a package out).
function checkout(t, installed = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'michi-preflight-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJson(join(root, 'package-lock.json'), LOCK);
  for (const workspace of ['frontend', 'backend', 'shared', 'runtime']) writeJson(join(root, workspace, 'package.json'), {});
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync('../runtime', join(root, 'node_modules', 'michi-runtime'));
  symlinkSync('../shared', join(root, 'node_modules', 'michi-shared'));
  const versions = { 'node_modules/pi': '1.5.0', 'node_modules/pi/node_modules/glob': '1.0.3', 'node_modules/ws': '8.0.0',
    'node_modules/zod': '3.25.0', 'node_modules/tool': '1.0.0', ...installed };
  for (const [key, version] of Object.entries(versions)) {
    if (version !== undefined) writeJson(join(root, key, 'package.json'), { version });
  }
  return root;
}

test('passes when workspace packages resolve inside the checkout and the install matches the lock', (t) => {
  const root = checkout(t);
  const report = preflight({ root, env: {} });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.drift.drifted, []);
  assert.match(formatReport(report), /ok {4}installed versions match package-lock\.json/);
});

test('fails when a workspace package resolves into another checkout', (t) => {
  const root = checkout(t);
  const other = checkout(t);
  rmSync(join(root, 'node_modules', 'michi-runtime'));
  symlinkSync(join(other, 'runtime'), join(root, 'node_modules', 'michi-runtime'));
  const report = preflight({ root, env: {} });
  assert.deepEqual(report.failures, [
    `michi-runtime from backend/ resolves to ${join(other, 'runtime')}, outside this checkout`,
    `michi-runtime from frontend/ resolves to ${join(other, 'runtime')}, outside this checkout`,
  ]);
  assert.match(formatReport(report), /worktree-setup\.mjs/);
});

test('fails when a workspace package does not resolve at all', (t) => {
  const root = checkout(t);
  rmSync(join(root, 'node_modules', 'michi-shared'));
  assert.deepEqual(preflight({ root, env: {} }).failures, [
    'michi-shared does not resolve from backend/ (node_modules missing?)',
    'michi-shared does not resolve from frontend/ (node_modules missing?)',
  ]);
});

test('fails under NODE_ENV=production with the unset hint', (t) => {
  const root = checkout(t);
  assert.deepEqual(preflight({ root, env: { NODE_ENV: 'production' } }).failures,
    ['NODE_ENV=production: unset NODE_ENV (Vitest/typecheck: NODE_ENV=test)']);
  assert.deepEqual(preflight({ root, env: { NODE_ENV: 'test' } }).failures, []);
});

test('warns about installs that differ from the lock and names the suites that load them', (t) => {
  const root = checkout(t, { 'node_modules/pi': '1.4.0', 'node_modules/pi/node_modules/glob': undefined });
  const report = preflight({ root, env: {} });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.drift.drifted, [
    { key: 'node_modules/pi', lock: '1.5.0', installed: '1.4.0' },
    { key: 'node_modules/pi/node_modules/glob', lock: '1.0.3', installed: undefined },
  ]);
  assert.deepEqual(report.drift.suites, ['backend tests and tsc (npm test -w backend, test:file)']);
  const text = formatReport(report);
  assert.match(text, /WARN {2}2 installed packages differ from package-lock\.json \(1 version, 1 missing\)/);
  assert.match(text, /node_modules\/pi {2}installed 1\.4\.0, lock 1\.5\.0/);
  assert.match(text, /node_modules\/pi\/node_modules\/glob {2}missing, lock 1\.0\.3/);
  assert.doesNotMatch(text, /fsevents/);
});

test('attributes a drifted package to every workspace that reaches it', (t) => {
  const root = checkout(t, { 'node_modules/zod': '3.24.0', 'node_modules/ws': '8.1.0', 'node_modules/tool': '0.9.0' });
  assert.deepEqual(preflight({ root, env: {} }).drift.suites, [
    'root tooling (npm run check, test:e2e, electron scripts)',
    // backend reaches ws through its link to the runtime workspace.
    'backend tests and tsc (npm test -w backend, test:file)',
    'frontend Vitest and typecheck (npm test -w frontend)',
    'runtime tests (npm run test:runtime)',
  ]);
});

test('says installs are forbidden in a linked worktree and where to reinstall', (t) => {
  const root = checkout(t, { 'node_modules/pi': '1.4.0' });
  writeJson(join(root, MARKER), { main: '/checkouts/main' });
  const text = formatReport(preflight({ root, env: {} }));
  assert.match(text, /Installs are forbidden here: never run npm install, npm ci or npx/);
  assert.match(text, /Untrustworthy until \/checkouts\/main is reinstalled/);
});

test('exits 1 only on a failure; drift alone is a warning', (t) => {
  const root = checkout(t, { 'node_modules/pi': '1.4.0' });
  const run = (NODE_ENV) => spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8', env: { ...process.env, NODE_ENV } });
  const warned = run('test');
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stdout, /WARN/);
  const failed = run('production');
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAIL {2}NODE_ENV=production/);
});
