#!/usr/bin/env node
// Read-only check that test results in this checkout can be trusted. Exit 1 on any FAIL.
//
//   node scripts/preflight.mjs [--root <checkout>]
//
//   FAIL  michi-runtime or michi-shared, looked up from backend/ or frontend/, lives outside the
//         checkout: tests and tsc would exercise another checkout's source (fix: scripts/worktree-setup.mjs).
//   FAIL  NODE_ENV=production: Vitest loads React's production build and npm install skips devDependencies.
//   WARN  installed versions differ from package-lock.json; names the suites that load the drifted packages.
// In a worktree set up by scripts/worktree-setup.mjs node_modules links into the main checkout, so it also
// says that installs are forbidden there.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MARKER = '.michi-linked-worktree';
const CHECKED_PACKAGES = ['michi-runtime', 'michi-shared'];
const CHECKED_FROM = ['backend', 'frontend'];
const SUITES = {
  '': 'root tooling (npm run check, test:e2e, electron scripts)',
  backend: 'backend tests and tsc (npm test -w backend, test:file)',
  frontend: 'frontend Vitest and typecheck (npm test -w frontend)',
  runtime: 'runtime tests (npm run test:runtime)',
  shared: 'shared tests (npm test -w michi-shared)',
};
const LISTED = 20;

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Node's directory lookup: the first node_modules/<name> in fromDir or an ancestor.
function findPackageDir(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

export function checkResolution(root, fromDirs = CHECKED_FROM) {
  const realRoot = realpathSync(root);
  const failures = [];
  for (const from of fromDirs) {
    for (const name of CHECKED_PACKAGES) {
      const found = findPackageDir(join(root, from), name);
      if (!found) {
        failures.push(`${name} does not resolve from ${from}/ (node_modules missing?)`);
        continue;
      }
      const real = realpathSync(found);
      if (!isInside(realRoot, real)) failures.push(`${name} from ${from}/ resolves to ${real}, outside this checkout`);
    }
  }
  return failures;
}

function readMarker(root) {
  const path = join(root, MARKER);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

// The lock key npm would install `name` at for a package at fromKey ('' is the root, 'backend' a workspace).
function lockKeyFor(packages, fromKey, name) {
  for (let dir = fromKey; ; dir = dir.slice(0, Math.max(dir.lastIndexOf('/'), 0))) {
    const key = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) return key;
    if (!dir) return null;
  }
}

// Lock key -> the workspaces ('' for the root package) whose dependency tree reaches it.
function lockOwners(packages) {
  const owners = new Map();
  for (const workspace of ['', ...(packages['']?.workspaces ?? [])]) {
    const seen = new Set();
    const queue = [workspace];
    while (queue.length) {
      const key = queue.pop();
      const entry = packages[key];
      if (seen.has(key) || !entry) continue;
      seen.add(key);
      if (entry.link) {
        queue.push(entry.resolved);
        continue;
      }
      const names = [entry.dependencies, entry.optionalDependencies, entry.peerDependencies,
        key === workspace ? entry.devDependencies : undefined].flatMap((deps) => Object.keys(deps ?? {}));
      for (const name of names) {
        const dep = lockKeyFor(packages, key, name);
        if (dep) queue.push(dep);
      }
    }
    for (const key of seen) {
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(workspace);
    }
  }
  return owners;
}

function installedVersion(root, key) {
  try {
    return JSON.parse(readFileSync(join(root, key, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

function lockDrift(root) {
  const lockPath = join(root, 'package-lock.json');
  if (!existsSync(lockPath)) return null;
  const packages = JSON.parse(readFileSync(lockPath, 'utf8')).packages ?? {};
  const drifted = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.includes('node_modules/') || entry.link || !entry.version) continue;
    const installed = installedVersion(root, key);
    // Optional packages for other platforms are never installed.
    if (installed === undefined && entry.optional) continue;
    if (installed !== entry.version) drifted.push({ key, lock: entry.version, installed });
  }
  const owners = lockOwners(packages);
  const workspaces = new Set(drifted.flatMap(({ key }) => [...(owners.get(key) ?? [])]));
  const suites = [...workspaces].sort().map((workspace) => SUITES[workspace] ?? `${workspace} tests (npm test -w ${workspace})`);
  // Wrong versions first: a missing workspace node_modules can list dozens of entries.
  drifted.sort((a, b) => Number(a.installed === undefined) - Number(b.installed === undefined));
  return { drifted, suites };
}

export function preflight({ root, env = process.env }) {
  const marker = readMarker(root);
  const resolution = checkResolution(root);
  const nodeEnv = env.NODE_ENV === 'production'
    ? 'NODE_ENV=production: unset NODE_ENV (Vitest/typecheck: NODE_ENV=test)'
    : null;
  const modules = join(root, 'node_modules');
  // The checkout whose install these node_modules are; a reinstall has to happen there.
  const installOwner = marker?.main ?? (existsSync(modules) ? dirname(realpathSync(modules)) : root);
  return { root, marker, installOwner, resolution, failures: [...resolution, ...(nodeEnv ? [nodeEnv] : [])], drift: lockDrift(root) };
}

export function formatReport({ root, marker, installOwner, resolution, failures, drift }) {
  const lines = [`preflight: ${root}`];
  if (resolution.length === 0) {
    lines.push(`  ok    ${CHECKED_PACKAGES.join(' and ')} resolve inside this checkout from ${CHECKED_FROM.join('/ and ')}/`);
  }
  for (const failure of failures) lines.push(`  FAIL  ${failure}`);
  if (resolution.length > 0) lines.push(`        In a worktree, run: node scripts/worktree-setup.mjs ${root}`);
  if (!drift) {
    lines.push('  WARN  no package-lock.json; installed versions were not checked');
  } else if (drift.drifted.length === 0) {
    lines.push('  ok    installed versions match package-lock.json');
  } else {
    const missing = drift.drifted.filter((item) => item.installed === undefined).length;
    lines.push(`  WARN  ${drift.drifted.length} installed packages differ from package-lock.json `
      + `(${drift.drifted.length - missing} version, ${missing} missing):`);
    for (const { key, lock, installed } of drift.drifted.slice(0, LISTED)) {
      lines.push(`          ${key}  ${installed === undefined ? 'missing' : `installed ${installed}`}, lock ${lock}`);
    }
    if (drift.drifted.length > LISTED) lines.push(`          ... and ${drift.drifted.length - LISTED} more`);
    lines.push(`        Untrustworthy until ${installOwner} is reinstalled: ${drift.suites.join('; ') || 'no suite uses them'}`);
  }
  if (marker) {
    lines.push(`  note  linked worktree: node_modules links into ${marker.main ?? 'the main checkout'}. `
      + 'Installs are forbidden here: never run npm install, npm ci or npx in this worktree.');
  }
  return lines.join('\n');
}

function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const root = resolve(rootIndex >= 0 ? argv[rootIndex + 1] : join(dirname(fileURLToPath(import.meta.url)), '..'));
  const report = preflight({ root });
  console.log(formatReport(report));
  return report.failures.length > 0 ? 1 : 0;
}

// Compare real paths: /home/<user> can be a link to /local/home/<user>, and import.meta.url is resolved.
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = main(process.argv.slice(2));
