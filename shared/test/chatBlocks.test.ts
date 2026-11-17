import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHAT_BLOCK_TYPES, chatBlockFieldsDoc, chatBlocksFallbackText, checkChatBlocks } from '../src/index';

const poll = { type: 'poll', question: 'Which day?', options: ['Mon', 'Tue'] };
const form = {
  type: 'form', title: 'Trip', prompt: 'Plan my trip',
  fields: [{ key: 'city', label: 'City', type: 'text', required: true }, { key: 'class', label: 'Class', type: 'select', options: ['Economy', 'Business'] }],
};

describe('show_blocks content', () => {
  test('takes the rich blocks and charts, and leaves out what only a page can hold', () => {
    for (const type of ['form', 'poll', 'choice', 'actions', 'stat', 'chart', 'keyvalue', 'gauge']) assert.ok(CHAT_BLOCK_TYPES.includes(type as never), type);
    for (const type of ['toc', 'video', 'audio', 'markdown', 'heading', 'tabs', 'database-ref']) assert.ok(!CHAT_BLOCK_TYPES.includes(type as never), type);
    assert.match(chatBlockFieldsDoc(), /^quote \{/);
    assert.match(chatBlockFieldsDoc(), /poll \{question, options: \[text\] \(2-50\), multi\?: boolean\}; options are unique/);
  });

  test('accepts valid blocks and trims the title', () => {
    const checked = checkChatBlocks({ blocks: [poll, form, { type: 'stat', label: 'Open', value: '3' }], title: '  Plan  ' });
    assert.ok(checked.ok);
    assert.equal(checked.title, 'Plan');
    assert.deepEqual(checked.blocks.map((block) => block.type), ['poll', 'form', 'stat']);
    const untitled = checkChatBlocks({ blocks: [poll], title: '   ' });
    assert.ok(untitled.ok && untitled.title === undefined);
  });

  test('names each wrong field the way a page write does', () => {
    const checked = checkChatBlocks({ blocks: [
      { type: 'poll', question: 'Q', options: ['only'] },
      { type: 'form', title: 'T', prompt: 'P', fields: [{ key: 'a', label: 'A', type: 'select' }] },
      { type: 'stat', label: 'L', value: '1', colour: 'red' },
    ] });
    assert.ok(!checked.ok);
    assert.match(checked.problem, /^blocks\[0\]: This poll block is not valid: options needs at least 2 items\. Its fields: /);
    assert.match(checked.problem, /blocks\[1\]: This form block is not valid: fields\[0\]\.options breaks the rule "a select or multiselect field needs options"/);
    assert.match(checked.problem, /blocks\[2\]: This stat block is not valid: colour is not a field/);
  });

  test('refuses a count outside 1-12, other types, page-only fields and a bad title', () => {
    const problem = (input: { blocks?: unknown; title?: unknown }) => {
      const checked = checkChatBlocks(input);
      assert.ok(!checked.ok);
      return checked.problem;
    };
    assert.equal(problem({}), 'blocks must be a list of 1-12 blocks');
    assert.equal(problem({ blocks: [] }), 'blocks has 0 items; show 1-12 blocks');
    assert.equal(problem({ blocks: Array.from({ length: 13 }, () => poll) }), 'blocks has 13 items; show 1-12 blocks');
    assert.match(problem({ blocks: [{ type: 'markdown', text: 'x' }] }), /^blocks\[0\]\.type is not a block type a reply shows, not "markdown"; the types are quote, /);
    assert.equal(problem({ blocks: ['poll'] }), 'blocks[0] must be a block object with a type');
    assert.equal(problem({ blocks: [{ ...poll, id: 'mine', visibility: 'detail' }] }), 'blocks[0].id is not a field; blocks[0].visibility is not a field');
    assert.equal(problem({ blocks: [poll], title: 5 }), 'title must be text, not 5');
    assert.equal(problem({ blocks: [poll], title: 'x'.repeat(201) }), 'title is longer than 200 characters');
  });

  test('reads as plain text: the title, each question with its options, form fields, figures', () => {
    assert.equal(chatBlocksFallbackText([
      poll, form,
      { type: 'choice', question: 'Ship?', options: ['Yes', 'No'] },
      { type: 'actions', buttons: [{ label: 'Retry', prompt: 'retry' }, { label: 'Stop', prompt: 'stop' }] },
      { type: 'stat', label: 'Open tasks', value: '12', delta: '+3' },
      { type: 'keyvalue', items: [{ key: 'Owner', value: 'Ann' }] },
      { type: 'quote', text: 'Ship it.', cite: 'Ann' },
    ], 'Plan'), [
      'Plan',
      'Which day?\n- Mon\n- Tue',
      'Trip\n- City (required)\n- Class: Economy / Business',
      'Ship?\n- Yes\n- No',
      '[Retry] [Stop]',
      'Open tasks: 12 (+3)',
      '- Owner: Ann',
      'Ship it.\nAnn',
    ].join('\n\n'));
  });
});
