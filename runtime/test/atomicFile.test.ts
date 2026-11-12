import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { writeFileAtomicSync } from '../src/core/atomicFile';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-atomic-file-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const posix = process.platform !== 'win32';

test('writes a new file private and replaces an existing one whole, leaving no temporary file', () => {
  const file = path.join(dir, 'state.json');
  writeFileAtomicSync(file, 'one');
  assert.equal(fs.readFileSync(file, 'utf8'), 'one');
  if (posix) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o644);
  writeFileAtomicSync(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  if (posix) assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the default mode applies to a replacement too');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test("'preserve' keeps an existing file's mode", { skip: !posix }, () => {
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, 'old', { mode: 0o640 });
  fs.chmodSync(file, 0o640);
  writeFileAtomicSync(file, 'new', { mode: 'preserve' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('replaces a symlink by default and writes through it only when asked', { skip: !posix }, () => {
  const target = path.join(dir, 'target.json');
  const link = path.join(dir, 'link.json');
  fs.writeFileSync(target, 'target');
  fs.symlinkSync(target, link);
  writeFileAtomicSync(link, 'replaced');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'target');

  fs.rmSync(link);
  fs.symlinkSync(target, link);
  writeFileAtomicSync(link, 'through', { followSymlink: true });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'through');
});

test('a failed rename throws and removes the temporary file', () => {
  const target = path.join(dir, 'taken');
  fs.mkdirSync(path.join(target, 'inside'), { recursive: true });
  assert.throws(() => writeFileAtomicSync(target, 'data'));
  assert.deepEqual(fs.readdirSync(dir), ['taken']);
});
