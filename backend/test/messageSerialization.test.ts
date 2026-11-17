import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeTurnContent } from 'michi-shared';
import { contentFromIncomingMessage, stripSentinelsStreamingSafe } from '../src/services/messageSerialization';

describe('branch overview message metadata', () => {
  test('removes overview sentinels from persisted text', () => {
    const raw = [
      'Body.',
      '[BRANCH-OVERVIEW: quoted example]',
      '[BRANCH-OVERVIEW: final durable state]',
    ].join('\n');

    assert.equal(stripSentinelsStreamingSafe(raw), 'Body.\n');
  });

  test('keeps prose after a sentinel prefix quoted mid-line', () => {
    const raw = 'missing `[BRANCH-OVERVIEW:`\n- next item\n[BRANCH-OVERVIEW: done]';
    assert.equal(stripSentinelsStreamingSafe(raw), 'missing `[BRANCH-OVERVIEW:`\n- next item\n');
  });
});

describe('imported assistant content', () => {
  test('a reply that showed blocks stores their plain text after its answer, as a finished turn does', () => {
    const blocks = [
      { id: 'a-b-0', kind: 'answer', rawText: '[TITLE: Days]\nPick one:' },
      { id: 'a-b-1', kind: 'blocks', blocks: [{ type: 'poll', id: 'cb-1', question: 'Day?', options: ['Mon', 'Tue'] }], fallbackText: 'Day?\n- Mon\n- Tue' },
    ];
    assert.equal(contentFromIncomingMessage({ role: 'assistant', blocks }), 'Pick one:\n\nDay?\n- Mon\n- Tue');
    assert.equal(contentFromIncomingMessage({ role: 'assistant', blocks: JSON.stringify(blocks.slice(1)) }), 'Day?\n- Mon\n- Tue');
  });

  test('matches what a finished turn stores', () => {
    const answers = [
      '[TITLE: Plan]\nAnswer.\n\n\n\nMore.\n[FOLLOW-UP 1/3: unclosed?',
      'Title: Plan\n\nAnswer.\n\nFollow-up Questions:\n1. Next?',
      'Answer with `[BRANCH-OVERVIEW: quoted]`.\n\n[FOLLOW-UPS: a? | b?]\n[BRANCH-OVERVIEW: done]',
    ];
    for (const raw of answers) {
      const blocks = [{ kind: 'thinking', rawText: 'hmm' }, { kind: 'answer', rawText: raw }];
      assert.equal(contentFromIncomingMessage({ role: 'assistant', blocks }), finalizeTurnContent(raw));
      assert.equal(contentFromIncomingMessage({ role: 'assistant', blocks: JSON.stringify(blocks) }), finalizeTurnContent(raw));
    }
    assert.equal(contentFromIncomingMessage({ role: 'assistant', blocks: [{ kind: 'answer', rawText: 'Answer.\n\n\n\nMore.\n[FOLLOW-UP 1/3: unclosed?' }] }), 'Answer.\n\nMore.');
  });
});
