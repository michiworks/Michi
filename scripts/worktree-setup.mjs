#!/usr/bin/env node
// Gives a development worktree the main checkout's installed packages without an install, while the
// workspace packages resolve to the worktree's own source:
//
//   node scripts/worktree-setup.mjs <worktree-path> [--main <main-checkout>]
//
//   node_modules/                    real directory with a link to each entry of <main>/node_modules,
//     michi-<pkg>              except workspace packages, which link to ../<pkg> in the worktree
//   backend/node_modules/            real directory of links to <main>/backend/node_modules entries, so a
//                                    workspace package nested there also points at the worktree
//   frontend|shared|runtime/node_modules   links to <main>/<pkg>/node_modules
//
// With plain links to <main>/node_modules, tests and tsc in the worktree load the main checkout's
// runtime/ and shared/ source. The default main checkout is the one that owns the worktree's git
// directory. The script is idempotent, refuses the main checkout itself and never replaces a real file or
// directory. It writes .michi-linked-worktree: an install here would write through the links into the main
// checkout, and scripts/preflight.mjs reports that installs are forbidden.
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkResolution, MARKER } from './preflight.mjs';

const GIT = existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';
const REAL_DIRS = ['backend'];

function git(cwd, ...args) {
  return execFileSync(GIT, ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function ensureDir(path, changes) {
  const stat = lstatOrNull(path);
  if (stat?.isDirectory()) return;
  if (stat?.isSymbolicLink()) {
    unlinkSync(path);
    changes.push(`replaced link ${path} with a directory`);
  } else if (stat) {
    throw new Error(`refusing to replace ${path}: it is a file, not a directory`);
  }
  mkdirSync(path);
}

function ensureLink(path, target, changes) {
  const stat = lstatOrNull(path);
  if (stat && !stat.isSymbolicLink()) {
    throw new Error(`refusing to replace ${path}: it is a real ${stat.isDirectory() ? 'directory' : 'file'}, `
      + 'not a link (was something installed here?)');
  }
  if (stat && readlinkSync(path) === target) return;
  if (stat) unlinkSync(path);
  symlinkSync(target, path);
  changes.push(`${stat ? 'relinked' : 'linked'} ${path} -> ${target}`);
}

// Mirrors source (a main checkout node_modules directory) into dest with one link per entry.
function linkEntries(source, dest, workspaceDirs, worktree, changes) {
  ensureDir(dest, changes);
  const wanted = new Set();
  for (const name of readdirSync(source)) {
    const scoped = name.startsWith('@') ? readdirSync(join(source, name)).map((entry) => `${name}/${entry}`) : [];
    if (!scoped.some((entry) => workspaceDirs.has(entry))) {
      wanted.add(name);
      const link = join(dest, name);
      const target = workspaceDirs.has(name)
        ? relative(dirname(link), join(worktree, workspaceDirs.get(name)))
        : join(source, name);
      ensureLink(link, target, changes);
      continue;
    }
    ensureDir(join(dest, name), changes);
    for (const entry of scoped) {
      wanted.add(entry);
      const link = join(dest, entry);
      const target = workspaceDirs.has(entry)
        ? relative(dirname(link), join(worktree, workspaceDirs.get(entry)))
        : join(source, entry);
      ensureLink(link, target, changes);
    }
    pruneLinks(join(dest, name), join(source, name), wanted, name, changes);
  }
  pruneLinks(dest, source, wanted, '', changes);
}

// Drops links this script made earlier to entries the main checkout no longer has.
function pruneLinks(dir, source, wanted, prefix, changes) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const key = prefix ? `${prefix}/${name}` : name;
    if (wanted.has(key) || !lstatSync(path).isSymbolicLink()) continue;
    if (readlinkSync(path).startsWith(`${source}/`)) {
      unlinkSync(path);
      changes.push(`removed stale link ${path}`);
    }
  }
}

// Package name -> workspace directory, for the root package.json's workspaces.
function workspacePackages(root) {
  const { workspaces = [] } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dirs = new Map();
  for (const dir of workspaces) {
    const manifest = join(root, dir, 'package.json');
    if (existsSync(manifest)) dirs.set(JSON.parse(readFileSync(manifest, 'utf8')).name, dir);
  }
  return dirs;
}

export function setupWorktree(worktreeArg, { main: mainArg } = {}) {
  const worktree = realpathSync(resolve(worktreeArg));
  const top = realpathSync(git(worktree, 'rev-parse', '--show-toplevel'));
  if (top !== worktree) throw new Error(`${worktree} is not the top of a git worktree (that is ${top})`);
  const [gitDir, commonDir] = git(worktree, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir')
    .split('\n').map((path) => realpathSync(path));
  if (gitDir === commonDir) throw new Error(`${worktree} is the main checkout; run this on a worktree made with git worktree add`);
  // `git worktree list` names the main working tree first.
  const mainCheckout = realpathSync(resolve(mainArg ?? git(worktree, 'worktree', 'list', '--porcelain').split('\n')[0].replace(/^worktree /, '')));
  if (mainCheckout === worktree) throw new Error(`refusing to link ${worktree} to itself`);
  if (realpathSync(git(mainCheckout, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== commonDir) {
    throw new Error(`${mainCheckout} is not a checkout of the same repository as ${worktree}`);
  }
  const mainModules = join(mainCheckout, 'node_modules');
  if (!lstatOrNull(mainModules)?.isDirectory()) throw new Error(`${mainModules} is not an installed node_modules directory`);

  const workspaceDirs = workspacePackages(worktree);
  const changes = [];
  linkEntries(mainModules, join(worktree, 'node_modules'), workspaceDirs, worktree, changes);
  const links = [];
  for (const dir of new Set(workspaceDirs.values())) {
    const source = join(mainCheckout, dir, 'node_modules');
    if (!lstatOrNull(source)?.isDirectory() || !existsSync(join(worktree, dir))) continue;
    if (REAL_DIRS.includes(dir)) {
      linkEntries(source, join(worktree, dir, 'node_modules'), workspaceDirs, worktree, changes);
    } else {
      ensureLink(join(worktree, dir, 'node_modules'), source, changes);
      links.push(join(worktree, dir, 'node_modules'));
    }
  }
  const marker = `${JSON.stringify({
    main: mainCheckout,
    note: 'node_modules here link into the main checkout: never run npm install, npm ci or npx in this worktree',
  }, null, 2)}\n`;
  const markerPath = join(worktree, MARKER);
  if (!existsSync(markerPath) || readFileSync(markerPath, 'utf8') !== marker) {
    writeFileSync(markerPath, marker);
    changes.push(`wrote ${markerPath}`);
  }
  const realDirs = [join(worktree, 'node_modules'), ...REAL_DIRS.map((dir) => join(worktree, dir, 'node_modules'))]
    .filter((path) => existsSync(path));
  return { worktree, main: mainCheckout, changes, links, realDirs, failures: checkResolution(worktree, ['backend']) };
}

function main(argv) {
  const mainIndex = argv.indexOf('--main');
  const positional = argv.filter((arg, index) => !arg.startsWith('--') && (mainIndex < 0 || index !== mainIndex + 1));
  if (positional.length !== 1 || (mainIndex >= 0 && !argv[mainIndex + 1])) {
    console.error('usage: node scripts/worktree-setup.mjs <worktree-path> [--main <main-checkout>]');
    return 2;
  }
  let result;
  try {
    result = setupWorktree(positional[0], { main: mainIndex >= 0 ? argv[mainIndex + 1] : undefined });
  } catch (error) {
    console.error(`worktree-setup: ${error.message}`);
    return 1;
  }
  const { worktree, main: mainCheckout, changes, links, realDirs, failures } = result;
  console.log(`worktree-setup: ${worktree} -> ${mainCheckout}: ${changes.length ? `${changes.length} changes` : 'already set up'}`);
  for (const failure of failures) console.error(`  FAIL  ${failure}`);
  if (failures.length) return 1;
  console.log('  ok    michi-runtime and michi-shared resolve inside the worktree from backend/');
  console.log('  Never run npm install, npm ci or npx here; check with: npm run preflight');
  console.log('  To remove the worktree, delete the links first (rm does not follow them):');
  for (const link of links) console.log(`    rm ${link}`);
  console.log(`    rm -r ${realDirs.join(' ')}`);
  console.log(`    git -C ${mainCheckout} worktree remove ${worktree}`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = main(process.argv.slice(2));
