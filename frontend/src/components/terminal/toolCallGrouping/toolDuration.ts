import type { ToolCallState } from '../../../state/chatTypes';
import { formatDuration, spokenDuration } from '../../../lib/duration';

/**
 * Duration of a single tool call, from projection-stamped timestamps.
 * Undefined for turns persisted before timestamps existed.
 */
export function toolDurationMs(tool: ToolCallState): number | undefined {
  if (tool.startedAt == null || tool.endedAt == null) return undefined;
  const d = tool.endedAt - tool.startedAt;
  return d >= 0 ? d : undefined;
}

/**
 * Wall-clock span of a group: earliest startedAt → latest endedAt across
 * tools that carry timestamps. Undefined when none do.
 */
export function toolSpanMs(tools: readonly ToolCallState[]): number | undefined {
  let min: number | undefined;
  let max: number | undefined;
  for (const t of tools) {
    if (t.startedAt != null) min = min == null ? t.startedAt : Math.min(min, t.startedAt);
    if (t.endedAt != null) max = max == null ? t.endedAt : Math.max(max, t.endedAt);
  }
  if (min == null || max == null || max < min) return undefined;
  return max - min;
}

/** A finished duration: "0.3s" below 10s, "12s", "1m 12s", "1h 5m" (lib/duration). */
export function formatDurationMs(ms: number): string {
  return formatDuration(ms);
}

/** Spoken form of a duration for screen readers: "3.8 seconds", "2 minutes 11 seconds". */
export function spokenDurationMs(ms: number, live = false): string {
  return spokenDuration(ms, { live });
}

/** A live elapsed time in whole seconds: "12s", "1m 12s". */
export function formatElapsedMs(ms: number): string {
  return formatDuration(ms, { live: true });
}
