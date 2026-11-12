import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listWorkspaceDirectory, resolveAllowedDirectory } = require('../electron/dist/workspaceFiles.js');

test('workspace directory listing is shallow, sorted, and root constrained', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'michi-files-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'michi-files-outside-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'z.txt'), 'z');
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  try {
    await fs.symlink(outside, path.join(root, 'escaped-link'));
  } catch {
    // Windows without Developer Mode cannot create directory symlinks.
  }

  const entries = await listWorkspaceDirectory(root, [root]);
  assert.deepEqual(entries.map((entry) => [entry.name, entry.kind]), [
    ['src', 'directory'],
    ['a.txt', 'file'],
    ['z.txt', 'file'],
  ]);
  await assert.rejects(() => resolveAllowedDirectory(outside, [root]), /outside this workspace/);
});

test('a child whose name starts with .. is inside the workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'michi-files-root-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '..cache'));
  await fs.writeFile(path.join(root, '..cache', 'entry.txt'), 'x');
  await fs.mkdir(path.join(root, 'src'));
  let linked = true;
  try {
    await fs.symlink(path.join(root, '..cache'), path.join(root, 'src', 'cache-link'));
  } catch {
    linked = false; // Windows without Developer Mode cannot create directory symlinks.
  }

  assert.deepEqual((await listWorkspaceDirectory(path.join(root, '..cache'), [root])).map((entry) => entry.name), ['entry.txt']);
  assert.deepEqual((await listWorkspaceDirectory(path.join(root, 'src'), [root])).map((entry) => entry.name), linked ? ['cache-link'] : []);
  await assert.rejects(() => resolveAllowedDirectory(path.join(root, 'src', '..', '..'), [root]), /outside this workspace/);
});
