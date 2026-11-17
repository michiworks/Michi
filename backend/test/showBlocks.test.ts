import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareShowBlocks } from '../src/agents/showBlocks';

const poll = { type: 'poll', question: 'Which day?', options: ['Mon', 'Tue'] };

test('show_blocks gives every block an id of its own and builds the fallback text once', () => {
  const shown = prepareShowBlocks({ blocks: [poll, { type: 'stat', label: 'Open', value: '3' }], title: 'Plan' });
  assert.ok(shown.ok);
  const ids = shown.payload.blocks.map((block) => (block as { id: string }).id);
  assert.equal(ids.length, 2);
  assert.ok(ids.every((id) => /^cb-[0-9a-f-]{36}$/.test(id)));
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(shown.payload.blocks.map(({ id: _id, ...content }: any) => content), [poll, { type: 'stat', label: 'Open', value: '3' }]);
  assert.equal(shown.payload.title, 'Plan');
  assert.equal(shown.payload.fallbackText, 'Plan\n\nWhich day?\n- Mon\n- Tue\n\nOpen: 3');
  assert.equal(shown.text, 'Showed 2 blocks to the user. Their answer arrives as their next message; end your turn and wait for it.');
});

test('blocks with nothing to answer only report that they were shown', () => {
  const shown = prepareShowBlocks({ blocks: [{ type: 'stat', label: 'Open', value: '3' }] });
  assert.ok(shown.ok);
  assert.equal('title' in shown.payload, false);
  assert.equal(shown.text, 'Showed 1 block to the user.');
});

test('a refused call tells the agent which field is wrong', () => {
  const shown = prepareShowBlocks({ blocks: [{ type: 'poll', question: 'Q', options: ['one'] }] });
  assert.ok(!shown.ok);
  assert.match(shown.error, /^show_blocks failed: blocks\[0\]: This poll block is not valid: options needs at least 2 items\./);
});
