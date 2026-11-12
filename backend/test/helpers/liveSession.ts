// A chat's live session as the session registry holds it, for tests of
// carried companion taint (services/turnTrust.ts, w2-fix D1, w3-fix D17).
// Only a registered session takes check-in material in: a source recorded
// while the chat has no session carries nothing (w4-fix failure 1), so a test
// of "the next turn on the same session" registers one first. Pair it with
// clearAllSessions() after the test.
import { registerSession } from '../../src/agents/sessionRegistry';
import type { AgentSession } from '../../src/agents/types';

export function registerLiveSession(
  nodeId: string,
  opts: { runtimeId?: string; nativeSessionId?: string | null } = {},
): AgentSession & { nativeSessionId: string | null } {
  const session = {
    id: nodeId,
    runtimeId: opts.runtimeId ?? 'claude',
    runtimeProfileHash: null,
    currentModelId: null,
    nativeSessionId: opts.nativeSessionId === undefined ? `native-${nodeId}` : opts.nativeSessionId,
    getHistory: () => [],
    getPendingAssistant: () => undefined,
    async *send() { yield { kind: 'turn_end', stopReason: 'end_turn' }; },
    async cancel() {},
  } as unknown as AgentSession & { nativeSessionId: string | null };
  registerSession(session, null);
  return session;
}
