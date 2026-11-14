import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareVersions,
  healthHostForBind,
  nodeGypEnvironment,
  parseArgs,
  parseEnvironmentFile,
  pruneReleases,
  renderEnvironmentFile,
  renderSystemdUnit,
  resolveRemoteConfig,
} from './remote-control.mjs';

test('remote launch defaults to detached loopback mode', () => {
  const options = parseArgs(['launch']);
  assert.equal(options.action, 'launch');
  assert.equal(options.service, false);
  assert.equal(options.setup, true);
  assert.equal(options.public, false);
});

test('remote launch accepts service and explicit connection options', () => {
  const options = parseArgs([
    'launch', '--service', '--no-setup', '--port=4123',
    '--bind-host', '10.0.0.8', '--data-dir', '~/michi remote',
  ]);
  assert.equal(options.service, true);
  assert.equal(options.setup, false);
  assert.equal(options.port, '4123');
  assert.equal(options.bindHost, '10.0.0.8');
  assert.equal(options.dataDir, '~/michi remote');
});

test('remote arguments reject ambiguous or invalid options', () => {
  assert.throws(() => parseArgs(['launch', '--public', '--bind-host', '127.0.0.1']), /cannot be used together/);
  assert.throws(() => parseArgs(['launch', '--unknown']), /unknown option/);
  assert.throws(() => resolveRemoteConfig(parseArgs(['launch', '--port', '0']), {}, '/tmp'), /invalid port/);
  assert.throws(() => resolveRemoteConfig(parseArgs(['launch', '--token', 'short']), {}, '/tmp'), /at least 16/);
});

test('remote config generates a strong token once and reuses the saved token', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'michi-remote-control-'));
  try {
    const options = parseArgs(['launch', '--data-dir', path.join(home, 'data')]);
    const first = resolveRemoteConfig(options, {}, home, () => 'generated-token-1234567890');
    mkdirSync(path.dirname(first.envFile), { recursive: true });
    writeFileSync(first.envFile, renderEnvironmentFile(first), { mode: 0o600 });
    const second = resolveRemoteConfig(options, {}, home, () => 'should-not-rotate-token');
    assert.equal(first.token, 'generated-token-1234567890');
    assert.equal(second.token, first.token);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('environment file round-trips spaces and keeps remote mode isolated from cloud auth', () => {
  const config = {
    token: 'token-with-special_~-123456',
    bindHost: '127.0.0.1',
    dataDir: '/tmp/Michi Remote/data',
    port: 3000,
    pathEnv: '/usr/local/bin:/usr/bin',
  };
  const parsed = parseEnvironmentFile(renderEnvironmentFile(config));
  assert.equal(parsed.MICHI_REMOTE_TOKEN, config.token);
  assert.equal(parsed.MICHI_DATA_DIR, config.dataDir);
  assert.equal(parsed.MICHI_REMOTE_ACCESS, '1');
  assert.equal(parsed.MICHI_REQUIRE_AUTH, '');
  assert.equal(parsed.MICHI_CLOUD, '0');
});

test('systemd unit references the protected environment file without embedding the token', () => {
  const config = {
    repoRoot: '/tmp/Michi Repo',
    envFile: '/tmp/Michi Data/remote.env',
    serverPath: '/tmp/Michi Repo/backend/dist/server.js',
    token: 'must-not-appear-in-unit-123456',
  };
  const unit = renderSystemdUnit(config, '/tmp/Node Runtime/node');
  assert.match(unit, /EnvironmentFile="\/tmp\/Michi Data\/remote\.env"/);
  assert.match(unit, /ExecStart="\/tmp\/Node Runtime\/node" --experimental-sqlite/);
  assert.match(unit, /Restart=always/);
  assert.doesNotMatch(unit, /must-not-appear/);
});

test('Node version comparison enforces the documented remote minimum', () => {
  assert.equal(compareVersions('22.18.9'), -1);
  assert.equal(compareVersions('22.19.0'), 0);
  assert.equal(compareVersions('24.0.0'), 1);
});

test('health checks use a reachable address for wildcard and explicit binds', () => {
  assert.equal(healthHostForBind('0.0.0.0'), '127.0.0.1');
  assert.equal(healthHostForBind('::'), '::1');
  assert.equal(healthHostForBind('10.0.0.8'), '10.0.0.8');
});

test('package exposes the one-command remote lifecycle scripts', () => {
  const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(rootPackage.scripts['remote:launch'], 'node scripts/remote-control.mjs launch');
  assert.equal(rootPackage.scripts['remote:status'], 'node scripts/remote-control.mjs status');
  assert.equal(rootPackage.scripts['remote:stop'], 'node scripts/remote-control.mjs stop');
  assert.equal(rootPackage.scripts['remote:restart'], 'node scripts/remote-control.mjs restart');
  assert.equal(rootPackage.scripts['remote:service:remove'], 'node scripts/remote-control.mjs remove-service');
});

test('remote setup points node-gyp at a Python it accepts', () => {
  const env = { PATH: '/usr/bin:/opt/py/bin' };
  const found = (name) => (name === 'python3.12' ? '/opt/py/bin/python3.12' : null);
  assert.equal(nodeGypEnvironment(env, () => false, found).npm_config_python, '/opt/py/bin/python3.12');
  // A usable default, an explicit choice, or no newer Python leaves npm alone.
  assert.equal(nodeGypEnvironment(env, () => true, found), env);
  assert.equal(nodeGypEnvironment({ ...env, npm_config_python: '/x' }, () => false, found).npm_config_python, '/x');
  assert.equal(nodeGypEnvironment(env, () => false, () => null), env);
});

test('pruning keeps the running build, its rollback, Crew\'s build and every release still in use', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'michi-prune-')));
  try {
    const releases = path.join(root, 'releases');
    const release = (tag) => {
      const dir = path.join(releases, `${tag.repeat(40)}-${tag}0000000-attempt`);
      mkdirSync(path.join(dir, 'bin'), { recursive: true });
      return dir;
    };
    const [current, rollback, stale, failed, launcher, workingDir, server, crewSource, crewAgent] = ['a', 'b', 'c', 'd', 'e', 'f', '1', '2', '3'].map(release);
    mkdirSync(path.join(releases, 'notes'));
    symlinkSync(stale, path.join(releases, `${'9'.repeat(40)}-link`));
    const home = path.join(root, 'home');
    mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    symlinkSync(path.join(launcher, 'bin'), path.join(home, '.local/bin/michi'));
    const proc = path.join(root, 'proc');
    mkdirSync(path.join(proc, '41'), { recursive: true });
    symlinkSync(workingDir, path.join(proc, '41/cwd'));
    mkdirSync(path.join(proc, '42'));
    writeFileSync(path.join(proc, '42/cmdline'), `node\0--experimental-sqlite\0${server}/backend/dist/server.js\0`);
    mkdirSync(path.join(proc, 'self'));
    const crewManifest = (dir) => JSON.stringify({ mcpServers: { michi: { command: 'python3', env: { MICHI_CREW_INSTALL_DIR: dir } } } });
    const crewHome = path.join(root, 'crew-home');
    mkdirSync(path.join(crewHome, 'apps/michi-crew-runtime'), { recursive: true });
    mkdirSync(path.join(root, 'crew-app'));
    writeFileSync(path.join(crewHome, 'apps/michi-crew-runtime/installed.json'), JSON.stringify({ source: path.join(root, 'crew-app') }));
    writeFileSync(path.join(root, 'crew-app/app.json'), crewManifest(crewSource));
    mkdirSync(path.join(home, '.kiro/agents'), { recursive: true });
    writeFileSync(path.join(home, '.kiro/agents/kirocrew.json'), crewManifest(crewAgent));
    writeFileSync(path.join(home, '.kiro/agents/broken.json'), '{');

    const result = pruneReleases({ repoRoot: current, keep: [rollback], homeDir: home, procDir: proc, env: { KIROCREW_HOME: crewHome } });

    assert.deepEqual(result.removed.sort(), [stale, failed].map((dir) => path.basename(dir)).sort());
    assert.deepEqual(result.failed, []);
    assert.deepEqual(readdirSync(releases).sort(), [current, rollback, launcher, workingDir, server, crewSource, crewAgent, 'notes', `${'9'.repeat(40)}-link`].map((dir) => path.basename(dir)).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pruning does nothing outside a releases directory or without a process list', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'michi-prune-')));
  try {
    const sibling = path.join(root, 'checkouts', `${'c'.repeat(40)}-sibling`);
    mkdirSync(sibling, { recursive: true });
    mkdirSync(path.join(root, 'checkouts', 'source'));
    const outside = pruneReleases({ repoRoot: path.join(root, 'checkouts', 'source'), homeDir: root, procDir: root, env: {} });
    assert.match(outside.skipped, /not a release/);
    const release = path.join(root, 'releases', `${'a'.repeat(40)}-current`);
    const old = path.join(root, 'releases', `${'b'.repeat(40)}-old`);
    mkdirSync(release, { recursive: true });
    mkdirSync(old);
    const blind = pruneReleases({ repoRoot: release, homeDir: root, procDir: path.join(root, 'missing-proc'), env: {} });
    assert.match(blind.skipped, /cannot be listed/);
    assert.ok(existsSync(sibling) && existsSync(old));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prune-releases accepts repeated --keep paths', () => {
  const options = parseArgs(['prune-releases', '--keep', '/r/old', '--keep=/r/other', '--data-dir', '/d']);
  assert.equal(options.action, 'prune-releases');
  assert.deepEqual(options.keep, ['/r/old', '/r/other']);
});
