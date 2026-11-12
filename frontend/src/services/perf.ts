/**
 * Frontend timing helpers over the structured metrics facade, mirroring
 * backend/src/services/perf.ts. Enabled by VITE_MICHI_METRICS=1 or the
 * other switches metrics.ts reads; all helpers short-circuit to near-zero
 * cost when disabled.
 */

import * as metrics from './metrics';

export function now(): number {
    return metrics.now();
}

export function measure(stage: string, startTime: number, meta?: Record<string, unknown>): void {
    metrics.measure(stage, startTime, meta);
}

export function mark(stage: string, meta?: Record<string, unknown>): void {
    metrics.mark(stage, meta);
}

export function enabled(): boolean {
    return metrics.enabled();
}
