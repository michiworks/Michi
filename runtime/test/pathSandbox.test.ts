import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { expandPath, isWithinRoot } from '../src/core/pathSandbox';

test('expandPath joins ~ and ~\\ onto the home directory', () => {
  const home = os.homedir();
  assert.equal(expandPath('~/docs'), path.join(home, 'docs'));
  assert.equal(expandPath('~\\docs'), path.join(home, 'docs'));
  assert.equal(expandPath('~'), home);
});

test('isWithinRoot counts the root and its children, never a parent or sibling', () => {
  const root = path.resolve('/workspace/root');
  const cases: Array<[string, boolean]> = [
    ['', true], ['a', true], ['a/b', true], ['..a', true], ['..cache/x', true], ['a/..', true],
    ['..', false], ['../a', false], ['../root-sibling', false], ['../../elsewhere', false],
  ];
  for (const [relative, inside] of cases) {
    assert.equal(isWithinRoot(path.join(root, relative), root), inside, relative);
  }
  assert.equal(isWithinRoot(path.parse(root).root, root), false);
});
