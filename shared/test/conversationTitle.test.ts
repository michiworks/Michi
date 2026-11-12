import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveConversationTitle } from '../src/index';

test('an untitled conversation is named by its first message without the quote, the /btw prefix or extra whitespace', () => {
  assert.equal(deriveConversationTitle('> quoted line\n  Fix the   flaky test\nplease'), 'Fix the flaky test please');
  assert.equal(deriveConversationTitle('/btw  check the logs'), 'check the logs');
  assert.equal(deriveConversationTitle('/branch try another way'), 'try another way');
  assert.equal(deriveConversationTitle('x'.repeat(51)), `${'x'.repeat(50)}…`);
  assert.equal(deriveConversationTitle('x'.repeat(50)), 'x'.repeat(50));
  assert.equal(deriveConversationTitle('a longer question', 8), 'a longer…');
  for (const blank of ['', '   ', '> only a quote', null, undefined]) assert.equal(deriveConversationTitle(blank), null);
});
