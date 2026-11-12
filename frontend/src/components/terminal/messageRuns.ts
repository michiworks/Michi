import type { ChatMessage } from '../../state/chatTypes';
import type { TurnUsageInfo } from './MessageBlock';

/**
 * Where a message sits in a run of replies. Replies with no user message
 * between them (a turn woken by a finished subagent or a thread message)
 * read as one message: the agent label shows on the first part only, and the
 * actions and usage on the last.
 */
export interface MessageRunPosition {
  /** A reply directly before this one belongs to the same run. */
  continuesRun: boolean;
  /** A reply directly after this one belongs to the same run. */
  runContinues: boolean;
  /** Index of the run's first part (the message itself outside a run). */
  start: number;
}

/**
 * Run positions of `messages`. `breakBefore` is the index a divider renders
 * before (the inherited-history boundary); runs do not cross it.
 */
export function messageRunPositions(messages: readonly ChatMessage[], breakBefore?: number): MessageRunPosition[] {
  const joins = (i: number) =>
    i > 0 && i !== breakBefore && messages[i].role === 'assistant' && messages[i - 1].role === 'assistant';
  const positions: MessageRunPosition[] = [];
  let start = 0;
  for (let i = 0; i < messages.length; i++) {
    const continuesRun = joins(i);
    if (!continuesRun) start = i;
    positions.push({ continuesRun, runContinues: i + 1 < messages.length && joins(i + 1), start });
  }
  return positions;
}

function sumAll(parts: readonly TurnUsageInfo[], pick: (u: TurnUsageInfo) => number | undefined): number | undefined {
  let total = 0;
  for (const part of parts) {
    const value = pick(part);
    if (value === undefined) return undefined;
    total += value;
  }
  return total;
}

/**
 * One usage line for a whole run, over the parts that report usage (older
 * replies may have none, and showed no line either). Durations add up over
 * the parts that have one; a count shows only when every such part reports
 * it. The context share is the last part's.
 */
export function mergeRunUsage(parts: readonly (TurnUsageInfo | undefined)[]): TurnUsageInfo | undefined {
  const known = parts.filter((u): u is TurnUsageInfo => !!u);
  if (known.length === 0) return undefined;
  if (known.length === 1) return known[0];
  const durations = known.filter((u) => u.durationMs !== undefined);
  const durationMs = durations.length > 0 ? durations.reduce((sum, u) => sum + u.durationMs!, 0) : undefined;
  if (known.some((u) => u.unverifiable)) {
    return { durationMs, unverifiable: true };
  }
  const charges = known.map((u) => u.charge);
  const first = charges[0];
  const charge = first && charges.every((c) => c && c.unit === first.unit)
    ? {
        amount: charges.reduce((sum, c) => sum + c!.amount, 0),
        unit: first.unit,
        provenance: charges.every((c) => c!.provenance === first.provenance) ? first.provenance : 'unknown' as const,
      }
    : undefined;
  return {
    durationMs,
    charge,
    credits: charge ? undefined : sumAll(known, (u) => u.credits),
    totalTokens: sumAll(known, (u) => u.totalTokens),
    inputTokens: sumAll(known, (u) => u.inputTokens),
    cachedInputTokens: sumAll(known, (u) => u.cachedInputTokens),
    outputTokens: sumAll(known, (u) => u.outputTokens),
    reasoningOutputTokens: sumAll(known, (u) => u.reasoningOutputTokens),
    contextUsagePercentage: known[known.length - 1].contextUsagePercentage,
  };
}
