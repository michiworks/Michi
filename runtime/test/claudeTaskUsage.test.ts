import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTaskUsage } from '../src/core/workflows/claudeWorkflowFold';

describe('claudeTaskUsage', () => {
  test('reads system task frames (snake_case)', () => {
    assert.deepEqual(claudeTaskUsage({ total_tokens: 10, tool_uses: 2, duration_ms: 30 }), { totalTokens: 10, toolUses: 2, durationMs: 30 });
  });

  test('reads Task tool results (camelCase)', () => {
    assert.deepEqual(claudeTaskUsage({ totalTokens: 10, totalToolUseCount: 1, totalDurationMs: 20 }), { totalTokens: 10, toolUses: 1, durationMs: 20 });
  });

  test('returns undefined when nothing usable is present', () => {
    assert.equal(claudeTaskUsage(undefined), undefined);
    assert.equal(claudeTaskUsage({ total_tokens: 'x', duration_ms: Number.NaN }), undefined);
  });
});
