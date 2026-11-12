/**
 * Timing helpers over the structured metrics facade (`MICHI_METRICS=1`).
 * When metrics are off, every helper short-circuits to near-zero cost.
 *
 * Typical usage:
 *   const t0 = perf.now();
 *   ... work ...
 *   perf.measure('acp:spawn', t0, { cwd });
 *
 * Or for a one-shot mark (no duration):
 *   perf.mark('acp:first_chunk', { chatId });
 */

import * as metrics from "./metrics";

/** High-resolution-ish timestamp (ms, float); 0 while metrics are off. */
export function now(): number {
    return metrics.now();
}

/** Record an elapsed duration. `startTime` should come from `perf.now()`. */
export function measure(
    stage: string,
    startTime: number,
    meta?: Record<string, unknown>,
): void {
    metrics.measure(stage, startTime, meta);
}

/** Record a one-shot event (no duration). Useful for "first chunk arrived at X". */
export function mark(stage: string, meta?: Record<string, unknown>): void {
    metrics.mark(stage, meta);
}
