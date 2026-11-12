import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRemoteInstallScript, buildRemoteRecoveryScript, buildRemoteUpdateScript } from '../src/services/remoteDesktopSetup';

// The generated scripts run under bash against stub Node binaries that report
// a chosen version, in a sandbox HOME. Each stops before the Python inspection.
const REPO = path.resolve(__dirname, '../..');
const appMinimum = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).engines.node.replace(/^>=/, '') as string;
const linuxOnly = { skip: process.platform !== 'linux' };
let root = '', home = '', log = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-remote-node-')));
  home = path.join(root, 'home');
  log = path.join(root, 'node.log');
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fake-version.cjs'), "Object.defineProperty(process.versions, 'node', { value: process.env.MICHI_FAKE_NODE_VERSION });\n");
  fs.writeFileSync(path.join(home, '.local/bin/npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function stubNode(file: string, version: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh
[ "$1" = --version ] && { echo v${version}; exit 0; }
MICHI_FAKE_NODE_VERSION=${version} exec '${process.execPath}' --require '${path.join(root, 'fake-version.cjs')}' "$@"
`, { mode: 0o755 });
}
const pathNode = () => path.join(home, '.local/bin/node');
const remoteNode = () => path.join(home, '.local/share/michi/devdesktop/node/bin/node');

// A Michi checkout whose remote-control.mjs records the Node version it runs under.
function checkout(dir: string, minimum: string, { nodeSelect = true } = {}) {
  for (const folder of ['scripts', 'bin/lib', 'backend/dist']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake-michi', engines: { node: `>=${minimum}` } }));
  fs.writeFileSync(path.join(dir, 'scripts/remote-control.mjs'),
    `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(log)}, process.versions.node + ' ' + process.argv[2] + '\\n');\n`);
  if (nodeSelect) fs.copyFileSync(path.join(REPO, 'bin/lib/node-select.sh'), path.join(dir, 'bin/lib/node-select.sh'));
}

function gitSource(minimum: string) {
  const source = path.join(root, 'source');
  checkout(source, minimum);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'ignore' });
  git('init', '-q', '-b', 'dev');
  git('add', '-A');
  git('-c', 'user.name=Michi', '-c', 'user.email=michi@example.invalid', 'commit', '-q', '-m', 'source');
  return { source, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() };
}

function run(script: string) {
  const shell = script.split("python3 - <<'MICHI_PYTHON'")[0];
  const result = spawnSync('bash', ['-c', shell], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  const ran = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return { ...result, ran };
}

function recoveryFixture(minimum: string, options?: { nodeSelect?: boolean }) {
  const repo = path.join(root, 'repo'), data = path.join(root, 'data');
  checkout(repo, minimum, options);
  fs.writeFileSync(path.join(repo, 'backend/dist/server.js'), '');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'remote.env'), 'PORT="4444"\n');
  return buildRemoteRecoveryScript({ repo, dataDir: data });
}

test('recovery runs a checkout with the Node its engines.node asks for, not the downloaded one', linuxOnly, () => {
  const script = recoveryFixture('30.1.0');
  stubNode(remoteNode(), '25.0.0');
  stubNode(pathNode(), '30.2.0');
  const result = run(script);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.ran, ['30.2.0 launch']);
});

test('recovery reports node_compatibility when no Node meets the checkout minimum', linuxOnly, () => {
  const script = recoveryFixture('30.1.0');
  stubNode(remoteNode(), '25.0.0');
  stubNode(pathNode(), '30.0.9');
  const result = run(script);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MICHI_ERROR:node_compatibility/);
  assert.deepEqual(result.ran, []);
});

test("a checkout without node-select.sh gets this app's own minimum", linuxOnly, () => {
  const [major, minor, patch] = appMinimum.split('.').map(Number);
  const script = recoveryFixture('99.0.0', { nodeSelect: false });
  stubNode(remoteNode(), patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major - 1}.99.99`);
  stubNode(pathNode(), appMinimum);
  const result = run(script);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.ran, [`${appMinimum} launch`]);
});

test('update chooses Node from the revision it checks out', linuxOnly, () => {
  const { source, revision } = gitSource('30.1.0');
  const oldRepo = path.join(root, 'old'), data = path.join(root, 'data');
  execFileSync('git', ['clone', '-q', source, oldRepo], { stdio: 'ignore' });
  fs.mkdirSync(data);
  stubNode(remoteNode(), '25.0.0');
  stubNode(pathNode(), '30.2.0');
  const result = run(buildRemoteUpdateScript({ repo: oldRepo, dataDir: data, token: 'token', port: 4444 }, source, 'dev', revision, 'attempt'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.ran, ['30.2.0 stop', '30.2.0 launch']);
});

test('install clones first and chooses Node from the cloned engines.node', linuxOnly, () => {
  const { source } = gitSource('30.1.0');
  stubNode(pathNode(), '25.0.0');
  stubNode(remoteNode(), '30.2.0');
  const result = run(buildRemoteInstallScript(source, 'dev', 'attempt', path.join(root, 'data')));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.ran, ['30.2.0 launch']);
});
