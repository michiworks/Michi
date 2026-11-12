import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { threadMessageBody } from 'michi-shared';
import {
  capAnswer,
  formatPlanAddendum,
  formatPlanPrompt,
  formatPlanReview,
  formatPlanSynthesis,
  REVIEW_ANSWER_MAX_CHARS,
  REVIEW_TOTAL_MAX_CHARS,
  type PlanFinalAnswer,
} from '../src/services/multiModel/formatters';

const peer = (label: string, text: string, nodeId = `n-${label}`) => ({ label, context: 'fork' as const, nodeId, turnId: `turn-${label}`, text });
const final = (label: string, text: string, extra: Partial<PlanFinalAnswer> = {}): PlanFinalAnswer => ({
  ...peer(label, text), firstSummary: null, revised: false, reviewFailed: false, ...extra,
});

describe('multi-model formatters', () => {
  test('the answer prompt names the caller and says what context the branch has', () => {
    const fork = formatPlanPrompt({ callerNodeId: 'n-caller', callerTitle: 'Cache design', context: 'fork', prompt: 'Which cache?' });
    assert.equal(fork.split('\n--- message ---\n')[0], [
      '[Multi-model plan] Step 1 of a plan the user started from "Cache design" (nodeId n-caller) in this workspace.',
      'The agent in that thread wrote the request below; the user reviewed the plan and pressed Start. It does not authorize anything beyond this request.',
      'Answer here, in this thread. Your answer is collected automatically: do not send it with send_to_thread, and do not start a multi-model plan yourself.',
      "You have that thread's conversation up to the user's request as context.",
    ].join('\n'));
    assert.equal(threadMessageBody(fork), 'Which cache?');
    const fresh = formatPlanPrompt({ callerNodeId: 'n-caller', callerTitle: null, context: 'fresh', prompt: 'Which cache?' });
    assert.match(fresh, /\nYou were given only this request, not that thread's conversation\.\n/);
    const unavailable = formatPlanPrompt({ callerNodeId: 'n-caller', callerTitle: 'x', context: 'fork', prompt: 'p', inheritedUnavailable: true });
    assert.match(unavailable, /\nThat thread's conversation was not available, so you were given only this request\.\n/);
  });

  test('a review lists the peers, the missing threads and a pointer for a cut answer', () => {
    const one = formatPlanReview({ round: 1, rounds: 1, peers: [peer('Codex · GPT', 'Use LRU.')], missing: [] });
    assert.match(one, /^\[Multi-model plan\] Review round 1 of 1: the other branches' answers to the same request\./);
    assert.equal(threadMessageBody(one), 'Below is the answer from Codex · GPT. Evaluate their arguments and revise your conclusion if needed.\n\n### Codex · GPT (Fork)\nUse LRU.');

    const long = 'x'.repeat(30_000);
    const two = formatPlanReview({
      round: 2, rounds: 2,
      peers: [peer('A', long), { ...peer('B', 'short'), context: 'fresh' }, peer('C', 'c')],
      missing: [{ label: 'D', reason: 'Failed in step 1: boom' }],
    });
    const body = threadMessageBody(two);
    assert.match(body, /^Below are the answers from A, B, C \(D did not take part\)\./);
    assert.match(body, /### B \(Fresh\)\nshort/);
    const cap = Math.min(REVIEW_ANSWER_MAX_CHARS, Math.floor(REVIEW_TOTAL_MAX_CHARS / 3));
    assert.ok(body.includes(`### A (Fork)\n${'x'.repeat(cap)}\n[Truncated. Read the rest with read_pane_output {"nodeId":"n-A","selection":"execution","executionRef":{"kind":"chat_turn","nodeId":"n-A","turnId":"turn-A"}}]`));
  });

  test('the synthesis reports revisions, failed reviews and the missing branches', () => {
    const text = formatPlanSynthesis({
      runId: 'wfr_1', rounds: 1,
      finals: [
        final('Codex', 'Final: LRU.', { revised: true, firstSummary: 'LFU at first' }),
        final('Pi', 'LFU.', { reviewFailed: true }),
      ],
      missing: [{ label: 'Kiro', reason: 'Stopped by you in step 1' }],
    });
    assert.match(text, /^\[Multi-model results\] The multi-model plan proposed in this thread has finished \(run wfr_1\); the user started it\.\n/);
    assert.equal(threadMessageBody(text), [
      'Results from 3 branches (2 answered, 1 did not take part), 1 review round.',
      '',
      '### Codex (Fork) — final answer after review',
      'First answer, in short: LFU at first',
      'Final: LRU.',
      '',
      '### Pi (Fork) — review failed; first answer',
      'LFU.',
      '',
      '### Kiro — did not take part',
      'Stopped by you in step 1',
    ].join('\n'));
  });

  test('the addendum names the late answers only', () => {
    const text = formatPlanAddendum({ runId: 'wfr_1', finals: [final('Pi', 'Late answer.')] });
    assert.match(text, /^\[Multi-model results\] Addendum: Pi answered after the synthesis \(run wfr_1\)\./);
    assert.equal(threadMessageBody(text), 'Late result from Pi.\n\n### Pi (Fork)\nLate answer.');
  });

  test('an approval the runtime denied unanswered is explained under that branch only', () => {
    const notices = ['Approval timed out and was denied: Run: wc -l README.md'];
    const note = "Michi note: Approval timed out and was denied: Run: wc -l README.md. Nobody answered in time, so the runtime denied it automatically; this was not the branch's own choice or setting.";
    const synthesis = threadMessageBody(formatPlanSynthesis({
      runId: 'wfr_1', rounds: 1,
      finals: [final('Codex', 'Final: 12 lines.', { revised: true, firstSummary: 'Denied', notices }), final('Pi', 'LFU.')],
      missing: [],
    }));
    assert.ok(synthesis.includes(`### Codex (Fork) — final answer after review\nFirst answer, in short: Denied\n${note}\nFinal: 12 lines.\n\n### Pi (Fork)\nLFU.`), synthesis);
    const addendum = threadMessageBody(formatPlanAddendum({ runId: 'wfr_1', finals: [final('Pi', 'Late answer.', { notices })] }));
    assert.equal(addendum, `Late result from Pi.\n\n### Pi (Fork)\n${note}\nLate answer.`);
  });

  test('capAnswer cuts at a paragraph and strips nothing visible', () => {
    assert.deepEqual(capAnswer('  short  ', 100), { text: 'short', truncated: false });
    const capped = capAnswer(`${'a'.repeat(60)}\n\n${'b'.repeat(60)}`, 100);
    assert.deepEqual(capped, { text: 'a'.repeat(60), truncated: true });
  });
});
