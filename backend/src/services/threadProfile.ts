import { getModelReasoningOptions } from '../agents/modelReasoning';
import type { AgentReasoning, AgentRuntime } from '../agents/types';

export interface NewThreadProfile {
  providerId: string | null;
  modelId: string | null;
  reasoning: AgentReasoning | null;
}

/**
 * The profile a thread created by Michi opens with, resolved the way
 * ensure-session resolves one: runtimes without provider models carry no
 * provider, and a reasoning level the model cannot use is replaced by the
 * model's own (or dropped) instead of failing the session.
 */
export async function resolveNewThreadProfile(
  runtime: AgentRuntime,
  requested: { providerId?: string | null; modelId?: string | null; reasoning?: AgentReasoning | null },
): Promise<NewThreadProfile> {
  const providerId = runtime.capabilities.providerModels ? requested.providerId ?? null : null;
  const modelId = requested.modelId ?? null;
  const effort = await getModelReasoningOptions(runtime, modelId, providerId, requested.reasoning ?? null);
  return { providerId, modelId: effort.modelId ?? modelId, reasoning: (effort.value ?? null) as AgentReasoning | null };
}
