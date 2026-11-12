import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readWindowGlass, writeWindowGlass } from '../electron/dist/windowGlass.js';

const withDir = (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'michi-window-glass-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('window glass is on until it is saved off', () => withDir((dir) => {
  const file = join(dir, 'window-glass.json');
  assert.equal(readWindowGlass(file), true);
  writeWindowGlass(file, false);
  assert.equal(readWindowGlass(file), false);
  writeWindowGlass(file, true);
  assert.equal(readWindowGlass(file), true);
}));

test('an unreadable or malformed file leaves window glass on', () => withDir((dir) => {
  const file = join(dir, 'window-glass.json');
  for (const body of ['not json', '[]', 'null', '{"enabled":"false"}', '{"enabled":0}']) {
    writeFileSync(file, body);
    assert.equal(readWindowGlass(file), true, body);
  }
}));
