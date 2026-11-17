import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8LineReader } from '../src/core/lineReader';

test('a character split between two reads arrives whole', () => {
  const lines: string[] = [];
  const read = utf8LineReader((line) => lines.push(line));
  const bytes = Buffer.from('{"text":"中文"}\n');
  const cut = bytes.indexOf(Buffer.from('中')) + 1; // inside the 3-byte character
  read(bytes.subarray(0, cut));
  read(bytes.subarray(cut));
  assert.deepEqual(lines, ['{"text":"中文"}']);
});

test('a line can span reads, and one read can finish several lines', () => {
  const lines: string[] = [];
  const read = utf8LineReader((line) => lines.push(line));
  read(Buffer.from('a'));
  read(Buffer.from('b\nc\nd'));
  assert.deepEqual(lines, ['ab', 'c']);
  read(Buffer.from('\n'));
  assert.deepEqual(lines, ['ab', 'c', 'd']);
});
