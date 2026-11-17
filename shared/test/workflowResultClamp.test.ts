import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampWorkflowResult, omittedItemsCount } from '../src/workflowResultClamp';

const note = (n: number) => `Note ${n}: ${'detail '.repeat(40).trim()}`;

test('a result that fits keeps its form', () => {
  const value = { docs: [{ file: 'a.md', rules: 3 }] };
  assert.equal(clampWorkflowResult(value, 8_000, { pretty: true }), JSON.stringify(value, null, 2));
  assert.equal(clampWorkflowResult(value, 8_000), JSON.stringify(value));
  assert.equal(clampWorkflowResult('  done  ', 8_000), 'done');
  assert.equal(clampWorkflowResult(null, 8_000), 'null');
  assert.equal(clampWorkflowResult(undefined, 8_000), undefined);
});

test('a long result keeps every key and item, its long strings shortened to one length', () => {
  const value = {
    docs: ['tokens', 'motion', 'transitions', 'states'].map((name) => ({ file: `/out/${name}.md`, rules: 30, notes: [note(1), note(2), note(3)] })),
    summary: 'All four written.',
  };
  const text = clampWorkflowResult(value, 2_000, { pretty: true })!;
  assert.ok(text.length <= 2_000);
  const kept = JSON.parse(text) as typeof value;
  assert.deepEqual(kept.docs.map((doc) => [doc.file, doc.rules, doc.notes.length]), value.docs.map((doc) => [doc.file, 30, 3]));
  assert.equal(kept.summary, 'All four written.');
  const notes = kept.docs.flatMap((doc) => doc.notes);
  assert.ok(notes.every((text) => text.endsWith('…') && text.length === notes[0].length));
  assert.match(notes[0], /^Note 1: detail detail/);
});

test('when short strings are not enough, lists keep their first items and say how many they left out', () => {
  const value = { findings: Array.from({ length: 200 }, (_, index) => ({ id: `F${index + 1}`, detail: note(index + 1) })) };
  const text = clampWorkflowResult(value, 4_000)!;
  assert.ok(text.length <= 4_000);
  const findings = (JSON.parse(text) as { findings: unknown[] }).findings;
  const omitted = omittedItemsCount(findings[findings.length - 1]);
  assert.ok(omitted !== undefined && omitted > 0);
  assert.equal(findings.length - 1 + omitted, 200);
  const first = findings[0] as { id: string; detail: string };
  assert.equal(first.id, 'F1');
  assert.ok(first.detail.length >= 80 && first.detail.endsWith('…'));
  assert.equal(omittedItemsCount('… 3 more items'), undefined);

  // Cut again, a list counts what the first cut left out too.
  const again = (JSON.parse(clampWorkflowResult(text, 1_000)!) as { findings: unknown[] }).findings;
  assert.equal(again.length - 1 + omittedItemsCount(again[again.length - 1])!, 200);
});

test('JSON text over the limit is cut by structure; other text and too-wide JSON are cut at the limit', () => {
  const text = clampWorkflowResult(JSON.stringify({ notes: [note(1), note(2), note(3), note(4)] }, null, 2), 600)!;
  assert.equal((JSON.parse(text) as { notes: string[] }).notes.length, 4);
  const prose = 'word '.repeat(400).trim();
  assert.equal(clampWorkflowResult(prose, 600), `${prose.slice(0, 599)}…`);
  const wide = clampWorkflowResult(Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`key${index}`, index])), 600)!;
  assert.equal(wide.length, 600);
  assert.ok(wide.endsWith('…'));
});
