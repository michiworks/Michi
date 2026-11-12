import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageSummaryTotalTokens } from '../src/index';

const USAGE_TOTAL_CASES: ReadonlyArray<{ name: string; usage: unknown; tokens: number | undefined }> = [
  { name: 'total only', usage: { totalTokens: 1200 }, tokens: 1200 },
  { name: 'input and output only', usage: { inputTokens: 900, outputTokens: 100 }, tokens: 1000 },
  { name: 'total wins over input and output', usage: { totalTokens: 50, inputTokens: 900, outputTokens: 100 }, tokens: 50 },
  { name: 'neither', usage: { contextUsagePercentage: 12, totalCredits: 0.4 }, tokens: undefined },
  { name: 'input without output', usage: { inputTokens: 900 }, tokens: undefined },
  { name: 'non-numeric total falls back to input and output', usage: { totalTokens: '1200', inputTokens: 10, outputTokens: 5 }, tokens: 15 },
  { name: 'non-numeric input and output', usage: { inputTokens: '900', outputTokens: 100 }, tokens: undefined },
  { name: 'not an object', usage: 'tokens', tokens: undefined },
];

test('usageSummaryTotalTokens takes the total, else input plus output', () => {
  for (const { name, usage, tokens } of USAGE_TOTAL_CASES) assert.equal(usageSummaryTotalTokens(usage), tokens, name);
  assert.equal(usageSummaryTotalTokens(undefined), undefined);
  assert.equal(usageSummaryTotalTokens(null), undefined);
});
