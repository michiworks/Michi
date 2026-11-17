import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockSubmissionHostKey, blockSubmissionSignature, parseBlockSubmissionHost, parseBlockSubmissionHostKey } from '../src/pages';

test('a signature follows the interactive content only, whatever order its keys were written in', () => {
  const form = { type: 'form', title: 'Trip', prompt: 'Plan', fields: [{ key: 'city', label: 'City', type: 'text', required: true }] };
  const reordered = { prompt: 'Other prompt', fields: [{ required: true, type: 'text', label: 'City', key: 'city' }], title: 'Renamed', type: 'form' };
  assert.equal(blockSubmissionSignature(form), blockSubmissionSignature(reordered));
  assert.notEqual(blockSubmissionSignature(form), blockSubmissionSignature({ ...form, fields: [...form.fields, { key: 'when', label: 'When', type: 'date' }] }));
  const poll = { type: 'poll', question: 'When?', options: ['Mon', 'Tue'] };
  assert.equal(blockSubmissionSignature(poll), blockSubmissionSignature({ ...poll, multi: false }));
  assert.notEqual(blockSubmissionSignature(poll), blockSubmissionSignature({ ...poll, multi: true }));
  assert.notEqual(blockSubmissionSignature(poll), blockSubmissionSignature({ ...poll, options: ['Tue', 'Mon'] }));
  const choice = { type: 'choice', question: 'Which?', options: ['A', 'B'] };
  // A pick the page stores on the block is not content: it must not reset the submission.
  assert.equal(blockSubmissionSignature(choice), blockSubmissionSignature({ ...choice, selected: 1 }));
  assert.notEqual(blockSubmissionSignature(choice), blockSubmissionSignature({ ...choice, type: 'poll' }));
  assert.match(blockSubmissionSignature(form), /^form-[0-9a-z]+-\d+$/);
});

test('host keys round-trip and refuse what is not exactly a page or a chat message', () => {
  for (const host of [{ kind: 'page', pageId: 'pg-1' }, { kind: 'chat', nodeId: 'n-1', messageId: 'm.1' }] as const) {
    assert.deepEqual(parseBlockSubmissionHostKey(blockSubmissionHostKey(host)), host);
    assert.deepEqual(parseBlockSubmissionHost(host), host);
  }
  for (const key of ['', 'page:', 'page:a:b', 'chat:a', 'chat:a:b:c', 'chat::b', 'other:a', 'page:a b', `page:${'x'.repeat(201)}`, 7, null]) {
    assert.equal(parseBlockSubmissionHostKey(key), null, String(key));
  }
  for (const host of [null, [], 'page:a', { kind: 'page' }, { kind: 'page', pageId: 'a', extra: 1 }, { kind: 'chat', nodeId: 'a' }, { kind: 'chat', nodeId: 'a:b', messageId: 'c' }]) {
    assert.equal(parseBlockSubmissionHost(host), null, JSON.stringify(host));
  }
});

test('an actions block is signed by its buttons, so rewritten buttons start fresh', () => {
  const block = (prompt: string) => ({ type: 'actions', id: 'a', buttons: [{ label: 'Go', prompt }] });
  assert.equal(blockSubmissionSignature(block('one')), blockSubmissionSignature(block('one')));
  assert.notEqual(blockSubmissionSignature(block('one')), blockSubmissionSignature(block('two')));
});
