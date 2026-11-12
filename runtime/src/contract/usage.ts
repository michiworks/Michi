/**
 * How full a session's context window is, for context_usage and
 * usage_summary: the tokens of the latest model call (its prompt, cache reads
 * and writes included, plus its output), or the compacted size after a
 * compaction. A turn's summed usage counts the shared prompt once per call and
 * is not a fill measure.
 */
export function contextFillPercentage(usedTokens: number, contextWindow: number | undefined): number | undefined {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  return Math.min(100, Math.max(0, (usedTokens / contextWindow) * 100));
}
