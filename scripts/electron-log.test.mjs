import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendLogLine, formatLogLine } from '../electron/logFile.ts';
import { formatLogLine as sharedFormatLogLine } from '../shared/src/logFormat.ts';

const TS = '2026-11-10T12:00:00.000Z';

test('electron-main.log lines match the backend log format', () => {
  const error = new Error('port in use');
  const cases = [
    undefined,
    {},
    { port: 3000, ok: true, skipped: undefined },
    { path: '/tmp/a b', query: 'x=1', plain: 'abc' },
    { err: error, stack: error.stack },
    { nested: { a: [1, 2] }, empty: '' },
  ];
  for (const meta of cases) {
    assert.equal(formatLogLine(TS, 'ERROR', 'boot', 'startup failed', meta), sharedFormatLogLine(TS, 'ERROR', 'boot', 'startup failed', meta));
  }
  assert.equal(formatLogLine(TS, 'INFO', 'boot', 'backend ready', { port: 3000, path: '/tmp/a b' }),
    '2026-11-10T12:00:00.000Z INFO  boot       backend ready port=3000 path="/tmp/a b"\n');
  const withStack = formatLogLine(TS, 'ERROR', 'boot', 'startup failed', { err: error, stack: error.stack });
  assert.equal(withStack.split('\n').length, 2, 'a stack stays on one line');
});

test('electron-main.log rotates to .1 once it reaches its size limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-electron-log-'));
  const file = path.join(dir, 'electron-main.log');
  appendLogLine(file, 'first\n', 10);
  appendLogLine(file, 'second\n', 10);
  assert.equal(fs.readFileSync(file, 'utf8'), 'first\nsecond\n');
  appendLogLine(file, 'third\n', 10);
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'first\nsecond\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'third\n');
  appendLogLine(file, 'fourth line\n', 10);
  appendLogLine(file, 'fifth\n', 10);
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'third\nfourth line\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'fifth\n');
});
