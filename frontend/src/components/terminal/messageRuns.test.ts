import { describe, expect, it } from 'vitest';
import { mergeRunUsage, messageRunPositions } from './messageRuns';
import type { ChatMessage } from '../../state/chatTypes';

const msg = (role: 'user' | 'assistant'): ChatMessage => ({ id: role, role, text: '', toolCalls: [] });

describe('messageRunPositions', () => {
  it('joins replies with no user message between them, and only those', () => {
    const roles = ['user', 'assistant', 'assistant', 'assistant', 'user', 'assistant'] as const;
    expect(messageRunPositions(roles.map(msg))).toEqual([
      { continuesRun: false, runContinues: false, start: 0 },
      { continuesRun: false, runContinues: true, start: 1 },
      { continuesRun: true, runContinues: true, start: 1 },
      { continuesRun: true, runContinues: false, start: 1 },
      { continuesRun: false, runContinues: false, start: 4 },
      { continuesRun: false, runContinues: false, start: 5 },
    ]);
  });

  it('does not join across the inherited-history divider', () => {
    const positions = messageRunPositions(['user', 'assistant', 'assistant'].map((r) => msg(r as 'user')), 2);
    expect(positions[1].runContinues).toBe(false);
    expect(positions[2]).toEqual({ continuesRun: false, runContinues: false, start: 2 });
  });
});

describe('mergeRunUsage', () => {
  it('adds up the parts', () => {
    expect(mergeRunUsage([
      { durationMs: 1000, totalTokens: 10, inputTokens: 8, outputTokens: 2, contextUsagePercentage: 10 },
      undefined,
      { durationMs: 500, totalTokens: 5, inputTokens: 4, outputTokens: 1, contextUsagePercentage: 12 },
    ])).toMatchObject({ durationMs: 1500, totalTokens: 15, inputTokens: 12, outputTokens: 3, contextUsagePercentage: 12 });
  });

  it('shows a count only when every part reports it', () => {
    const merged = mergeRunUsage([{ durationMs: 1000, totalTokens: 10 }, { durationMs: 500 }]);
    expect(merged?.durationMs).toBe(1500);
    expect(merged?.totalTokens).toBeUndefined();
  });

  it('sums charges of one unit, and is unverifiable if any part is', () => {
    expect(mergeRunUsage([
      { charge: { amount: 0.5, unit: 'USD', provenance: 'sdk_estimate' } },
      { charge: { amount: 0.25, unit: 'USD', provenance: 'sdk_estimate' } },
    ])?.charge).toEqual({ amount: 0.75, unit: 'USD', provenance: 'sdk_estimate' });
    expect(mergeRunUsage([{ durationMs: 1000, totalTokens: 1 }, { durationMs: 1000, unverifiable: true }]))
      .toEqual({ durationMs: 2000, unverifiable: true });
  });
});
