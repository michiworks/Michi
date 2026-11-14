#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REMOTE_SERVICE_NAME = 'michi-remote.service';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

/** Michi's minimum Node version: root package.json engines.node, ">=X.Y.Z"
 *  (also read by bin/lib/node-select.sh and crew-app/launch.py). */
export function readMinimumNodeVersion(repoRoot = REPO_ROOT) {
  const range = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).engines?.node;
  const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range ?? '');
  if (!match) throw new Error(`package.json engines.node must be ">=X.Y.Z" (found ${JSON.stringify(range)})`);
  return match.slice(1).map(Number);
}

export const MIN_NODE_VERSION = readMinimumNodeVersion();
const SERVER_PATH = path.join(REPO_ROOT, 'backend', 'dist', 'server.js');
const HEALTH_TIMEOUT_MS = 20_000;

function usage() {
  return `Michi remote backend control

Usage:
  npm run remote:launch [-- --service] [options]
  npm run remote:status
  npm run remote:stop
  npm run remote:restart [-- --service] [options]
  npm run remote:service:remove
  node scripts/remote-control.mjs prune-releases [--keep PATH]

Options:
  --service             Register/start a systemd user service
  --no-setup            Skip npm install + web/backend build
  --public              Bind 0.0.0.0 instead of 127.0.0.1
  --bind-host HOST      Explicit bind host
  --port PORT           Backend port (default: 3000)
  --data-dir PATH       Michi data directory (default: ~/.michi)
  --token TOKEN         Explicit token (prefer MICHI_REMOTE_TOKEN to avoid shell history)
  --keep PATH           prune-releases: also keep this checkout (repeatable)
  --help                 Show this help
`;
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith('--') ? args.shift() : 'launch';
  const allowedActions = new Set(['launch', 'status', 'stop', 'restart', 'remove-service', 'prune-releases']);
  if (!allowedActions.has(action)) throw new Error(`unknown action: ${action}`);

  const options = {
    action,
    service: false,
    setup: true,
    public: false,
    bindHost: undefined,
    port: undefined,
    dataDir: undefined,
    token: undefined,
    keep: [],
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--service') options.service = true;
    else if (arg === '--no-setup') options.setup = false;
    else if (arg === '--public') options.public = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--bind-host') options.bindHost = takeValue(args, index++, arg);
    else if (arg.startsWith('--bind-host=')) options.bindHost = arg.slice('--bind-host='.length);
    else if (arg === '--port') options.port = takeValue(args, index++, arg);
    else if (arg.startsWith('--port=')) options.port = arg.slice('--port='.length);
    else if (arg === '--data-dir') options.dataDir = takeValue(args, index++, arg);
    else if (arg.startsWith('--data-dir=')) options.dataDir = arg.slice('--data-dir='.length);
    else if (arg === '--token') options.token = takeValue(args, index++, arg);
    else if (arg.startsWith('--token=')) options.token = arg.slice('--token='.length);
    else if (arg === '--keep') options.keep.push(takeValue(args, index++, arg));
    else if (arg.startsWith('--keep=')) options.keep.push(arg.slice('--keep='.length));
    else throw new Error(`unknown option: ${arg}`);
  }

  if (options.public && options.bindHost) {
    throw new Error('--public and --bind-host cannot be used together');
  }
  return options;
}

function expandHome(input, homeDir) {
  if (input === '~') return homeDir;
  if (input.startsWith('~/')) return path.join(homeDir, input.slice(2));
  return input;
}

function validatePort(raw) {
  const port = Number(raw ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return port;
}

function validateBindHost(host) {
  if (!host || host.length > 255 || /[\s/]/.test(host)) {
    throw new Error(`invalid bind host: ${host}`);
  }
  return host;
}

function validateToken(token) {
  if (typeof token !== 'string' || token.trim().length < 16) {
    throw new Error('MICHI_REMOTE_TOKEN must be at least 16 characters');
  }
  if (/[\r\n\0]/.test(token)) throw new Error('MICHI_REMOTE_TOKEN contains an invalid character');
  return token.trim();
}

export function parseEnvironmentFile(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        continue;
      }
    }
    values[key] = value;
  }
  return values;
}

function readExistingEnvironment(envFile) {
  if (!existsSync(envFile)) return {};
  try {
    return parseEnvironmentFile(readFileSync(envFile, 'utf8'));
  } catch {
    return {};
  }
}

export function resolveRemoteConfig(
  options,
  env = process.env,
  homeDir = os.homedir(),
  createToken = () => randomBytes(32).toString('base64url'),
) {
  const rawDataDir = expandHome(
    options.dataDir ?? env.MICHI_DATA_DIR ?? path.join(homeDir, '.michi'),
    homeDir,
  );
  if (/[\r\n\0]/.test(rawDataDir)) throw new Error('data directory contains an invalid character');
  const dataDir = path.resolve(rawDataDir);
  const envFile = path.join(dataDir, 'remote.env');
  const existing = readExistingEnvironment(envFile);
  const token = validateToken(
    options.token
      ?? env.MICHI_REMOTE_TOKEN
      ?? existing.MICHI_REMOTE_TOKEN
      ?? createToken(),
  );
  const port = validatePort(options.port ?? env.PORT ?? existing.PORT ?? 3000);
  const bindHost = validateBindHost(
    options.public
      ? '0.0.0.0'
      : options.bindHost
        ?? env.MICHI_BIND_HOST
        ?? existing.MICHI_BIND_HOST
        ?? '127.0.0.1',
  );

  return {
    repoRoot: REPO_ROOT,
    serverPath: SERVER_PATH,
    dataDir,
    envFile,
    pidFile: path.join(dataDir, 'remote.pid'),
    logFile: path.join(dataDir, 'remote.log'),
    token,
    port,
    bindHost,
    pathEnv: env.PATH ?? '',
  };
}

function quoteEnvironmentValue(value) {
  return JSON.stringify(String(value));
}

export function renderEnvironmentFile(config) {
  const rows = [
    'MICHI_REMOTE_ACCESS="1"',
    `MICHI_REMOTE_TOKEN=${quoteEnvironmentValue(config.token)}`,
    `MICHI_BIND_HOST=${quoteEnvironmentValue(config.bindHost)}`,
    `MICHI_DATA_DIR=${quoteEnvironmentValue(config.dataDir)}`,
    `PORT=${quoteEnvironmentValue(config.port)}`,
    'NODE_ENV="production"',
    'MICHI_REQUIRE_AUTH=""',
    'MICHI_CLOUD="0"',
  ];
  if (config.pathEnv) rows.push(`PATH=${quoteEnvironmentValue(config.pathEnv)}`);
  return `${rows.join('\n')}\n`;
}

function writeSecureFile(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, filePath);
  chmodSync(filePath, 0o600);
}

function systemdQuote(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')}"`;
}

export function renderSystemdUnit(config, nodePath = process.execPath) {
  return `[Unit]
Description=Michi remote backend
After=network.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(config.repoRoot)}
EnvironmentFile=${systemdQuote(config.envFile)}
ExecStart=${systemdQuote(nodePath)} --experimental-sqlite ${systemdQuote(config.serverPath)}
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=default.target
`;
}

export function compareVersions(actual, required = MIN_NODE_VERSION) {
  const parts = String(actual).replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < required.length; index += 1) {
    if ((parts[index] ?? 0) > required[index]) return 1;
    if ((parts[index] ?? 0) < required[index]) return -1;
  }
  return 0;
}

function assertSupportedNode() {
  if (compareVersions(process.versions.node) < 0) {
    throw new Error(`Node.js ${MIN_NODE_VERSION.join('.')} or newer is required (current: ${process.version})`);
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.stdio ?? 'inherit',
    timeout: options.timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

/**
 * node-pty, which backend terminals need, is optional and compiled at install
 * time on Linux. node-gyp rejects the Python 3.7 some hosts default to, so
 * point it at a newer Python on PATH; with none, terminals stay unavailable.
 */
export function nodeGypEnvironment(env = process.env, pythonAtLeast38 = defaultPythonAtLeast38, findExecutable = findOnPath) {
  if (process.platform === 'win32' || env.npm_config_python || env.PYTHON || pythonAtLeast38(env)) return env;
  for (const name of ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3.8']) {
    const found = findExecutable(name, env);
    if (found) return { ...env, npm_config_python: found };
  }
  return env;
}

function defaultPythonAtLeast38(env) {
  const result = spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { env, stdio: 'ignore' });
  return result.status === 0;
}

function findOnPath(name, env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function runSetup() {
  runChecked('npm', ['run', 'remote:setup'], { cwd: REPO_ROOT, stdio: 'inherit', env: nodeGypEnvironment() });
  if (!existsSync(SERVER_PATH)) throw new Error(`remote build did not produce ${SERVER_PATH}`);
}

function serviceUnitPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.config', 'systemd', 'user', REMOTE_SERVICE_NAME);
}

function hasSystemdUnit(homeDir = os.homedir()) {
  return existsSync(serviceUnitPath(homeDir));
}

function ensureSystemdUserAvailable() {
  const result = spawnSync('systemctl', ['--user', 'show-environment'], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      'systemd user services are unavailable. Run without --service for detached background mode.',
    );
  }
}

function isServiceActive() {
  const result = spawnSync('systemctl', ['--user', 'is-active', '--quiet', REMOTE_SERVICE_NAME], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  return result.status === 0;
}

function tryEnableLinger() {
  const user = process.env.USER;
  if (!user) return false;
  const current = spawnSync('loginctl', ['show-user', user, '-p', 'Linger', '--value'], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 5_000,
  });
  if (current.status === 0 && current.stdout.trim() === 'yes') return true;
  const enabled = spawnSync('loginctl', ['enable-linger', user], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  return enabled.status === 0;
}

function readPidRecord(pidFile) {
  if (!existsSync(pidFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pidFile, 'utf8'));
    if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function pidBelongsToMichi(record, config) {
  if (!record || record.serverPath !== config.serverPath) return false;
  const procCmdline = `/proc/${record.pid}/cmdline`;
  if (!existsSync(procCmdline)) return true;
  try {
    return readFileSync(procCmdline, 'utf8').includes(config.serverPath);
  } catch {
    return false;
  }
}

function activeBackgroundRecord(config) {
  const record = readPidRecord(config.pidFile);
  if (
    !record
    || !processIsAlive(record.pid)
    || !pidBelongsToMichi(record, config)
  ) {
    if (existsSync(config.pidFile)) rmSync(config.pidFile, { force: true });
    return null;
  }
  return record;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readHealth(config) {
  return new Promise((resolve) => {
    const request = http.request({
      host: healthHostForBind(config.bindHost),
      port: config.port,
      path: '/api/health',
      method: 'GET',
      headers: { Authorization: `Bearer ${config.token}` },
      timeout: 1_000,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({});
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
    request.end();
  });
}

async function probeHealth(config) {
  return (await readHealth(config)) !== null;
}

async function waitForHealth(config, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth(config)) return;
    await delay(250);
  }
  throw new Error(`Michi did not become healthy on ${healthHostForBind(config.bindHost)}:${config.port} within ${timeoutMs}ms`);
}

function serverEnvironment(config) {
  return {
    ...process.env,
    MICHI_REMOTE_ACCESS: '1',
    MICHI_REMOTE_TOKEN: config.token,
    MICHI_BIND_HOST: config.bindHost,
    MICHI_DATA_DIR: config.dataDir,
    PORT: String(config.port),
    NODE_ENV: 'production',
    MICHI_REQUIRE_AUTH: '',
    MICHI_CLOUD: '0',
  };
}

export function healthHostForBind(bindHost) {
  if (bindHost === '0.0.0.0') return '127.0.0.1';
  if (bindHost === '::' || bindHost === '[::]') return '::1';
  return bindHost;
}

function configFingerprint(config) {
  return createHash('sha256')
    .update(JSON.stringify({
      serverPath: config.serverPath,
      dataDir: config.dataDir,
      port: config.port,
      bindHost: config.bindHost,
      token: config.token,
    }))
    .digest('hex');
}

async function startDetached(config) {
  const existing = activeBackgroundRecord(config);
  if (existing) {
    if (existing.configFingerprint === configFingerprint(config) && await probeHealth(config)) {
      return existing;
    }
    await stopDetached(config);
  }

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const logFd = openSync(config.logFile, 'a', 0o600);
  chmodSync(config.logFile, 0o600);
  let child;
  try {
    child = spawn(process.execPath, ['--experimental-sqlite', config.serverPath], {
      cwd: config.repoRoot,
      env: serverEnvironment(config),
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  if (!child.pid) throw new Error('failed to start Michi background process');
  const record = {
    pid: child.pid,
    serverPath: config.serverPath,
    configFingerprint: configFingerprint(config),
    startedAt: Date.now(),
  };
  writeSecureFile(config.pidFile, `${JSON.stringify(record)}\n`);
  child.unref();
  try {
    await waitForHealth(config);
  } catch (error) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
    rmSync(config.pidFile, { force: true });
    throw new Error(`${error.message}. See ${config.logFile}`);
  }
  return record;
}

async function stopDetached(config) {
  const record = activeBackgroundRecord(config);
  if (!record) return false;
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && processIsAlive(record.pid)) await delay(100);
  if (processIsAlive(record.pid)) {
    try { process.kill(-record.pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  rmSync(config.pidFile, { force: true });
  return true;
}

async function installAndStartService(config) {
  await stopDetached(config);
  writeSecureFile(config.envFile, renderEnvironmentFile(config));
  const unitPath = serviceUnitPath();
  mkdirSync(path.dirname(unitPath), { recursive: true, mode: 0o700 });
  writeFileSync(unitPath, renderSystemdUnit(config), { encoding: 'utf8', mode: 0o644 });
  chmodSync(unitPath, 0o644);
  runChecked('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  runChecked('systemctl', ['--user', 'enable', REMOTE_SERVICE_NAME], { stdio: 'inherit' });
  runChecked('systemctl', ['--user', 'restart', REMOTE_SERVICE_NAME], { stdio: 'inherit' });
  await waitForHealth(config);
  return { linger: tryEnableLinger() };
}

function removeService() {
  const unitPath = serviceUnitPath();
  if (!existsSync(unitPath)) return false;
  if (isServiceActive()) {
    runChecked('systemctl', ['--user', 'disable', '--now', REMOTE_SERVICE_NAME], { stdio: 'inherit' });
  } else {
    spawnSync('systemctl', ['--user', 'disable', REMOTE_SERVICE_NAME], { stdio: 'ignore' });
  }
  rmSync(unitPath, { force: true });
  runChecked('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  return true;
}

function realPath(file) {
  try { return realpathSync(file); } catch { return path.resolve(file); }
}

// Points a symlink at target in one rename. Leaves anything else at that path.
function replaceSymlink(link, target) {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  mkdirSync(path.dirname(link), { recursive: true });
  const temporary = `${link}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, link);
  return true;
}

// Keeps one `michi` on PATH across releases: it follows the build serving the
// default data directory. `michi --data-dir` reaches other installations.
// For a remote installation, <devdesktop>/current follows the same build, so
// the Kiro Crew App can be registered once to that path (crew-setup.cjs).
function linkCurrentBuild(config, homeDir = os.homedir()) {
  const launcher = path.join(config.repoRoot, 'bin', 'michi');
  if (realPath(config.dataDir) !== realPath(path.join(homeDir, '.michi')) || !existsSync(launcher)) return;
  replaceSymlink(path.join(homeDir, '.local', 'bin', 'michi'), launcher);
  const remoteRoot = realPath(path.join(homeDir, '.local', 'share', 'michi', 'devdesktop'));
  if (realPath(config.repoRoot).startsWith(remoteRoot + path.sep)) replaceSymlink(path.join(remoteRoot, 'current'), realPath(config.repoRoot));
}

// `michi update` names each checkout <revision>-<attempt id>.
const RELEASE_NAME = /^[0-9a-f]{40}-[0-9A-Za-z-]+$/;

// Working directories and absolute command-line paths of live processes.
// Entries this user cannot read are skipped; such processes cannot use the
// user's private release directories.
function pathsInUse(procDir) {
  const paths = [];
  for (const pid of readdirSync(procDir)) {
    if (!/^\d+$/.test(pid)) continue;
    try { paths.push(readlinkSync(path.join(procDir, pid, 'cwd'))); } catch { /* gone or not ours */ }
    try {
      for (const arg of readFileSync(path.join(procDir, pid, 'cmdline'), 'utf8').split('\0')) {
        if (arg.startsWith('/')) paths.push(realPath(arg));
      }
    } catch { /* gone or not ours */ }
  }
  return paths;
}

// Installations the Kiro Crew App starts Michi's MCP from: MICHI_CREW_INSTALL_DIR
// in the App's registered source and in the agents Crew generates on Sync.
// Apps prepared before <devdesktop>/current existed pin one release, which
// Crew keeps using after Michi updates.
function crewInstallations(homeDir, env) {
  const manifests = [];
  const crewHome = env.KIROCREW_HOME || path.join(homeDir, '.kiro', 'crew');
  try {
    const { source } = JSON.parse(readFileSync(path.join(crewHome, 'apps', 'michi-crew-runtime', 'installed.json'), 'utf8'));
    if (typeof source === 'string') manifests.push(path.join(source, 'app.json'));
  } catch { /* no Crew App */ }
  const agents = path.join(homeDir, '.kiro', 'agents');
  try {
    for (const name of readdirSync(agents)) if (name.endsWith('.json')) manifests.push(path.join(agents, name));
  } catch { /* no Kiro agents */ }
  const dirs = [];
  for (const file of manifests) {
    try {
      for (const server of Object.values(JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {})) {
        const dir = server?.env?.MICHI_CREW_INSTALL_DIR;
        if (typeof dir === 'string' && dir) dirs.push(dir);
      }
    } catch { /* unreadable or not JSON */ }
  }
  return dirs;
}

/**
 * Removes the release checkouts beside this one that nothing needs any more:
 * older builds and failed update attempts. Keeps this checkout, the `keep`
 * paths (the build an update replaced, for rollback), the builds that
 * ~/.local/bin/michi and <devdesktop>/current name, the build Kiro Crew is
 * registered to, and any release a live process uses. Acts only from a
 * checkout inside a `releases` directory, so running it from a source
 * checkout cannot touch the directories beside that.
 */
export function pruneReleases({ repoRoot = REPO_ROOT, keep = [], homeDir = os.homedir(), procDir = '/proc', env = process.env } = {}) {
  const releasesDir = path.dirname(realPath(repoRoot));
  if (path.basename(releasesDir) !== 'releases') return { removed: [], failed: [], skipped: 'this checkout is not a release' };
  if (!existsSync(procDir)) return { removed: [], failed: [], skipped: 'running processes cannot be listed' };
  const links = [path.join(homeDir, '.local', 'bin', 'michi'), path.join(path.dirname(releasesDir), 'current')];
  const needed = [repoRoot, ...keep, ...links, ...crewInstallations(homeDir, env)]
    .map(realPath).concat(pathsInUse(procDir));
  const removed = [], failed = [];
  for (const name of readdirSync(releasesDir)) {
    const dir = path.join(releasesDir, name);
    if (!RELEASE_NAME.test(name) || !lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    if (needed.some((file) => file === dir || file.startsWith(dir + path.sep))) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { removed, failed };
}

function pruneReleasesCommand(options) {
  const keep = options.keep.map((file) => path.resolve(expandHome(file, os.homedir())));
  const { removed, failed, skipped } = pruneReleases({ keep });
  if (skipped) console.log(`Kept every release: ${skipped}.`);
  else console.log(removed.length ? `Removed ${removed.length} old Michi release${removed.length === 1 ? '' : 's'}.` : 'No old Michi releases to remove.');
  if (failed.length) {
    console.error(`Could not remove: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

function printConnection(config, mode, extra = {}) {
  writeSecureFile(path.join(config.dataDir, 'remote-installation.json'), `${JSON.stringify({ serverPath: config.serverPath })}\n`);
  if (process.platform === 'linux') linkCurrentBuild(config);
  console.log('');
  console.log('Michi remote backend is running.');
  console.log(`Mode: ${mode}`);
  console.log(`Bind: ${config.bindHost}:${config.port}`);
  console.log(`Data: ${config.dataDir}`);
  if (extra.pid) console.log(`PID: ${extra.pid}`);
  if (mode === 'background') console.log(`Log: ${config.logFile}`);
  if (mode === 'systemd user service') {
    console.log(`Logs: journalctl --user -u ${REMOTE_SERVICE_NAME} -f`);
    if (extra.linger === false) {
      console.log(`Warning: enable persistence after logout with: loginctl enable-linger ${process.env.USER ?? '$USER'}`);
    }
  }
  if (config.bindHost === '0.0.0.0') {
    console.log('Warning: the backend is network-visible; use a firewall/private network/HTTPS proxy.');
  }
  console.log('');
  console.log('Copy this token into Michi Settings -> Connections:');
  console.log(`MICHI_REMOTE_TOKEN=${config.token}`);
  console.log('');
}

async function launch(options) {
  assertSupportedNode();
  const config = resolveRemoteConfig(options);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
  writeSecureFile(config.envFile, renderEnvironmentFile(config));
  const useService = options.service || hasSystemdUnit();
  if (useService) ensureSystemdUserAvailable();
  if (options.setup) runSetup();

  if (useService) {
    const result = await installAndStartService(config);
    printConnection(config, 'systemd user service', result);
    return;
  }

  if (isServiceActive()) {
    printConnection(config, 'systemd user service', { linger: undefined });
    return;
  }
  const record = await startDetached(config);
  printConnection(config, 'background', { pid: record.pid });
}

async function stop(options) {
  const config = resolveRemoteConfig(options);
  let stopped = false;
  if (hasSystemdUnit() && isServiceActive()) {
    runChecked('systemctl', ['--user', 'stop', REMOTE_SERVICE_NAME], { stdio: 'inherit' });
    stopped = true;
  }
  stopped = (await stopDetached(config)) || stopped;
  console.log(stopped ? 'Michi remote backend stopped.' : 'Michi remote backend is not running.');
}

async function printRevision(config) {
  const revision = (await readHealth(config))?.build?.revision;
  if (revision) console.log(`revision: ${revision}`);
}

async function status(options) {
  const config = resolveRemoteConfig(options);
  if (hasSystemdUnit() && isServiceActive()) {
    console.log(`running: systemd user service (${REMOTE_SERVICE_NAME})`);
    console.log(`config: ${config.envFile}`);
    await printRevision(config);
    return;
  }
  const record = activeBackgroundRecord(config);
  if (record) {
    console.log(`running: background pid ${record.pid}`);
    console.log(`log: ${config.logFile}`);
    await printRevision(config);
    return;
  }
  console.log('stopped');
  process.exitCode = 1;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.action === 'launch') return launch(options);
  if (options.action === 'stop') return stop(options);
  if (options.action === 'status') return status(options);
  if (options.action === 'prune-releases') return pruneReleasesCommand(options);
  if (options.action === 'remove-service') {
    console.log(removeService() ? 'Michi systemd user service removed.' : 'Michi systemd user service is not installed.');
    return;
  }
  if (options.action === 'restart') {
    await stop(options);
    return launch(options);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`remote control failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
