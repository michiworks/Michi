import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseThreadMessageSource } from '../src/index';

describe('thread message plan sources', () => {
  test('keep a valid plan and the hop', () => {
    const answer = { runId: 'wfr_1', step: 'answer', context: 'fork', fromLabel: 'Claude Code' };
    assert.deepEqual(parseThreadMessageSource({ fromNodeId: 'n-caller', fromTitle: 'Caches', hop: 1, plan: answer }),
      { fromNodeId: 'n-caller', fromTitle: 'Caches', hop: 1, plan: answer });
    const review = { runId: 'wfr_1', step: 'review', round: 2, rounds: 2, fromLabel: 'Claude Code' };
    assert.deepEqual(parseThreadMessageSource({ fromNodeId: 'n-caller', hop: 1, plan: review })?.plan, review);
    const synthesis = { runId: 'wfr_1', step: 'synthesis', branches: 5 };
    assert.deepEqual(parseThreadMessageSource({ fromNodeId: 'n-caller', hop: 2, plan: synthesis }),
      { fromNodeId: 'n-caller', hop: 2, plan: synthesis });
  });

  test('drop an invalid plan and keep the rest', () => {
    for (const plan of [
      { step: 'answer' },
      { runId: '', step: 'answer' },
      { runId: 'r'.repeat(65), step: 'answer' },
      { runId: 'wfr_1', step: 'vote' },
      'answer',
      [],
    ]) {
      assert.deepEqual(parseThreadMessageSource({ fromNodeId: 'n-caller', hop: 1, plan }), { fromNodeId: 'n-caller', hop: 1 }, JSON.stringify(plan));
    }
  });

  test('drop out-of-range plan fields and clamp the label', () => {
    const parsed = parseThreadMessageSource({
      fromNodeId: 'n-caller',
      plan: { runId: 'wfr_1', step: 'review', round: 3, rounds: 1.5, context: 'both', branches: 6, fromLabel: `  ${'L'.repeat(100)}  ` },
    });
    assert.deepEqual(Object.keys(parsed!.plan!), ['runId', 'step', 'fromLabel']);
    assert.equal(parsed!.plan!.fromLabel!.length, 80);
    assert.ok(parsed!.plan!.fromLabel!.endsWith('…'));
  });
});
