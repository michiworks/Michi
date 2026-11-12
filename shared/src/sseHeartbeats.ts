/**
 * How often each persistent SSE route writes while idle. A client that hears
 * nothing, heartbeats included, for sseSilenceTimeoutMs of it treats the
 * feed as stalled and reconnects.
 */
export const SSE_HEARTBEAT_MS = {
  workflowRuns: 15_000,
  memoryChanges: 25_000,
  artifactWatch: 25_000,
} as const;

export function sseSilenceTimeoutMs(heartbeatMs: number): number {
  return heartbeatMs * 3;
}
