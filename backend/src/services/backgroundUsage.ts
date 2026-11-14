/**
 * What background work used (unification §3.2, Q17): recorded, never shown
 * or limited. A reply's usage_summary counts, in this order, as its
 * runtime's charge (USD or credits), else its legacy credits, else its
 * uncached input plus output tokens. A Claude total counts cache reads,
 * which made it about 21 times what was paid for, so a total alone does not
 * count. Each unit adds up on its own; nothing compares runtimes.
 */

import type { BackgroundUsageAmounts, BackgroundUsageUnit } from 'michi-shared';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function replyUsage(summary: unknown): { unit: BackgroundUsageUnit; amount: number } | null {
  if (!summary || typeof summary !== 'object') return null;
  const { charge, totalCredits, inputTokens, cachedInputTokens, outputTokens } = summary as Record<string, unknown>;
  if (charge && typeof charge === 'object') {
    const { amount, unit } = charge as Record<string, unknown>;
    if (finite(amount) && (unit === 'USD' || unit === 'credits')) return { unit, amount };
  }
  if (finite(totalCredits)) return { unit: 'credits', amount: totalCredits };
  if (finite(inputTokens) && finite(outputTokens)) {
    const cached = finite(cachedInputTokens) ? Math.min(cachedInputTokens, inputTokens) : 0;
    return { unit: 'tokens', amount: inputTokens - cached + outputTokens };
  }
  return null;
}

export function addUsage(into: BackgroundUsageAmounts, unit: BackgroundUsageUnit, amount: number): BackgroundUsageAmounts {
  into[unit] = (into[unit] ?? 0) + amount;
  return into;
}

/** The replies' usage_summary values, as message metadata stores them (JSON text or null), added up. */
export function usageOfSummaries(summaries: ReadonlyArray<string | null>): BackgroundUsageAmounts {
  const total: BackgroundUsageAmounts = {};
  for (const text of summaries) {
    if (!text) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    const usage = replyUsage(parsed);
    if (usage) addUsage(total, usage.unit, usage.amount);
  }
  return total;
}

/** A stored amounts object (companion_runs.usage_json), its valid units only. */
export function parseUsageAmounts(text: string | null): BackgroundUsageAmounts {
  if (!text) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return {}; }
  const amounts: BackgroundUsageAmounts = {};
  if (!parsed || typeof parsed !== 'object') return amounts;
  for (const unit of ['USD', 'credits', 'tokens'] as const) {
    const value = (parsed as Record<string, unknown>)[unit];
    if (finite(value)) amounts[unit] = value;
  }
  return amounts;
}

export function mergeUsage(into: BackgroundUsageAmounts, more: BackgroundUsageAmounts): BackgroundUsageAmounts {
  for (const [unit, amount] of Object.entries(more) as Array<[BackgroundUsageUnit, number]>) addUsage(into, unit, amount);
  return into;
}
