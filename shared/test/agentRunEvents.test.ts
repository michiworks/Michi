import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRunEventType, parseAgentRunEventV1, parseJsonValue } from '../src/agentRuns';

function assistantEvent(text: string) {
  return { version: 1, runId: ' run-1 ', seq: 2, attemptId: null, type: AgentRunEventType.Assistant, payload: { version: 1, text }, createdAt: 1 };
}

test('parseAgentRunEventV1 keeps the whitespace of streamed text deltas', () => {
  for (const text of [' world', '\n\n', 'line\n', '  ']) {
    assert.deepEqual(parseAgentRunEventV1(assistantEvent(text)).payload, { version: 1, text });
  }
});

test('parseAgentRunEventV1 still trims its named fields', () => {
  assert.equal(parseAgentRunEventV1(assistantEvent('x')).runId, 'run-1');
});

test('parseJsonValue keeps JSON strings verbatim but still bounds their length', () => {
  assert.deepEqual(parseJsonValue({ patch: 'diff\n', items: [' a ', ''] }), { patch: 'diff\n', items: [' a ', ''] });
  assert.throws(() => parseJsonValue('x'.repeat(1_000_000)), /must be at most/);
  assert.throws(() => parseJsonValue(['ok', 1n]));
});
