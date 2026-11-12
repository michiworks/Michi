import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MARKER } from './preflight.mjs';
import { setupWorktree } from './worktree-setup.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'worktree-setup.mjs');
const GIT = existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';
const WORKSPACES = ['frontend', 'backend', 'shared', 'runtime'];

function git(cwd, ...args) {
  execFileSync(GIT, ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'ignore' });
}

function write(path, content = '{}') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// A main checkout with an npm-style install, and a detached worktree of it with no node_modules.
function repo(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'michi-worktree-setup-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = join(base, 'main');
  write(join(main, 'package.json'), JSON.stringify({ workspaces: WORKSPACES }));
  for (const workspace of WORKSPACES) write(join(main, workspace, 'package.json'), JSON.stringify({ name: `michi-${workspace}` }));
  git(base, 'init', '-q', '-b', 'dev', main);
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  write(join(main, 'node_modules', 'dep-a', 'package.json'));
  write(join(main, 'node_modules', '.bin', 'tool'), '');
  write(join(main, 'node_modules', '@scope', 'x', 'package.json'));
  for (const workspace of WORKSPACES) symlinkSync(`../${workspace}`, join(main, 'node_modules', `michi-${workspace}`));
  write(join(main, 'backend', 'node_modules', 'be-only', 'package.json'));
  write(join(main, 'frontend', 'node_modules', 'fe-only', 'package.json'));
  write(join(main, 'shared', 'node_modules', 'zod', 'package.json'));
  write(join(main, 'runtime', 'node_modules', 'ws', 'package.json'));
  const worktree = join(base, 'wt');
  git(main, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
  return { main, worktree };
}

const isLink = (path) => lstatSync(path).isSymbolicLink();
const isDir = (path) => !isLink(path) && lstatSync(path).isDirectory();

test('links the main install, with workspace packages resolving to the worktree', (t) => {
  const { main, worktree } = repo(t);
  const result = setupWorktree(worktree);
  assert.equal(result.main, main);
  assert.deepEqual(result.failures, []);

  assert.ok(isDir(join(worktree, 'node_modules')));
  assert.equal(readlinkSync(join(worktree, 'node_modules', 'dep-a')), join(main, 'node_modules', 'dep-a'));
  assert.equal(readlinkSync(join(worktree, 'node_modules', '.bin')), join(main, 'node_modules', '.bin'));
  assert.equal(readlinkSync(join(worktree, 'node_modules', '@scope')), join(main, 'node_modules', '@scope'));
  assert.ok(isDir(join(worktree, 'node_modules')));
  for (const workspace of WORKSPACES) {
    assert.equal(readlinkSync(join(worktree, 'node_modules', `michi-${workspace}`)), `../${workspace}`);
  }
  assert.ok(isDir(join(worktree, 'backend', 'node_modules')));
  assert.equal(readlinkSync(join(worktree, 'backend', 'node_modules', 'be-only')), join(main, 'backend', 'node_modules', 'be-only'));
  for (const workspace of ['frontend', 'shared', 'runtime']) {
    assert.equal(readlinkSync(join(worktree, workspace, 'node_modules')), join(main, workspace, 'node_modules'));
  }
  assert.equal(JSON.parse(readFileSync(join(worktree, MARKER), 'utf8')).main, main);
});

test('replaces a plain node_modules link without writing into main, and is idempotent', (t) => {
  const { main, worktree } = repo(t);
  symlinkSync(join(main, 'node_modules'), join(worktree, 'node_modules'));
  const before = readdirSync(join(main, 'node_modules')).sort();

  const first = setupWorktree(worktree);
  assert.ok(first.changes.includes(`replaced link ${join(worktree, 'node_modules')} with a directory`));
  assert.deepEqual(first.failures, []);
  assert.deepEqual(readdirSync(join(main, 'node_modules')).sort(), before);
  assert.ok(!existsSync(join(main, MARKER)));

  assert.deepEqual(setupWorktree(worktree).changes, []);
});

test('drops links to packages the main checkout no longer has', (t) => {
  const { main, worktree } = repo(t);
  setupWorktree(worktree);
  rmSync(join(main, 'node_modules', 'dep-a'), { recursive: true });
  const { changes } = setupWorktree(worktree);
  assert.deepEqual(changes, [`removed stale link ${join(worktree, 'node_modules', 'dep-a')}`]);
  assert.equal(lstatSync(join(worktree, 'node_modules', 'dep-a'), { throwIfNoEntry: false }), undefined);
});

test('refuses the main checkout and real directories it would replace', (t) => {
  const { main, worktree } = repo(t);
  const before = readdirSync(join(main, 'node_modules')).sort();
  assert.throws(() => setupWorktree(main), /is the main checkout/);
  assert.throws(() => setupWorktree(worktree, { main: worktree }), /refusing to link .* to itself/);
  assert.deepEqual(readdirSync(join(main, 'node_modules')).sort(), before);

  write(join(worktree, 'frontend', 'node_modules', 'installed', 'package.json'));
  assert.throws(() => setupWorktree(worktree), /refusing to replace .*frontend\/node_modules: it is a real directory/);
});

test('the command prints how to remove the worktree, links first', (t) => {
  const { main, worktree } = repo(t);
  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  const run = spawnSync(process.execPath, [SCRIPT, worktree, '--main', main], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.split('\n').map((line) => line.trim());
  const removeLinks = lines.indexOf(`rm ${join(worktree, 'frontend', 'node_modules')}`);
  const removeDirs = lines.indexOf(`rm -r ${join(worktree, 'node_modules')} ${join(worktree, 'backend', 'node_modules')}`);
  const removeWorktree = lines.indexOf(`git -C ${main} worktree remove ${worktree}`);
  assert.ok(removeLinks >= 0 && removeLinks < removeDirs && removeDirs < removeWorktree, run.stdout);

  const refused = spawnSync(process.execPath, [SCRIPT, main], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is the main checkout/);
});
