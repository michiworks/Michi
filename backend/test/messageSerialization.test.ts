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
