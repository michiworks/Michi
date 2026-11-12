import type { AgentRuntime, StructuredCompletion } from '../../agents/types';
import { log } from '../logger';
import { getMetaAgentSettings } from '../metaAgent/settings';
import { CONSOLIDATION_PAYLOAD_SCHEMA } from './consolidationPolicy';
import { getExtractionRun, recordExtractionInvalidCall, type ExtractionRunKind } from './extractionRepository';
import { estimateTokens } from 'michi-shared';
import { answersMemoryDirectly, MEMORY_EXTRACTION_LIMITS } from './extractionRun';
import { InvalidMemoryAnswer, stageMemoryAnswer } from './extractionTools';
import { EXTRACTION_PAYLOAD_SCHEMA } from './extractionV2';
import { PROFILE_PAYLOAD_SCHEMA } from './userProfile';

/**
 * Automatic memory without a session (spec §C): a planned run (extractionRun
 * planMemoryExtractionRun with direct) is answered with one direct
 * structured call of the Meta agent's runtime, AgentRuntime.completeStructured
 * (Claude: an isolated Agent SDK query; Codex: an ephemeral thread; Pi: one
 * provider request). Each answer is validated and staged as a tool call's
 * would be (extractionTools.stageMemoryAnswer); an invalid one is repaired up
 * to MEMORY_EXTRACTION_LIMITS.maxRepairs times by asking again with the
 * problems, and past that the run settles as unreadable. A runtime without
 * the call (Kiro, Crew) answers in a maintenance session instead. The
 * scheduler settles the run either way (settleMemoryExtractionRun), with the
 * tokens the calls reported.
 *
 * The model: MICHI_MEMORY_MODEL when set, else the Meta agent's own model
 * choice, else the runtime's cheap model (its title model, or a small one
 * the account lists).
 */

export interface MemoryDirectAnswer {
  status: 'succeeded' | 'failed' | 'cancelled';
  error: string | null;
  /** What the calls used in all: reported, else estimated; null when none was made. */
  tokens: number | null;
}

export interface MemoryDirectRun {
  runId: string;
  ownerUserId: string;
  /** The Meta agent profile the scheduler resolved for the run. */
  profile: { runtimeId: string; providerId: string | null; modelId: string | null; reasoning: string | null };
  system: string;
  prompt: string;
  signal: AbortSignal;
}

/** The scheduler's seam: which runs are answered directly, and the answer. */
export interface MemoryDirectAnswerer {
  supports(runtimeId: string): boolean;
  /** Never rejects. */
  answer(run: MemoryDirectRun): Promise<MemoryDirectAnswer>;
}

/** How long one call may take; a run's own scheduler timeout bounds all of them. */
const CALL_TIMEOUT_MS = 180_000;

type StructuredRuntime = AgentRuntime & Required<Pick<AgentRuntime, 'completeStructured'>>;

/** The answer's schema for each kind of run: extraction's payload, the profile, or consolidation's decisions. */
const SCHEMAS: Record<ExtractionRunKind, Readonly<Record<string, unknown>>> = {
  extract: EXTRACTION_PAYLOAD_SCHEMA,
  profile: PROFILE_PAYLOAD_SCHEMA,
  consolidate: CONSOLIDATION_PAYLOAD_SCHEMA,
};

function structured(runtime: AgentRuntime | undefined): StructuredRuntime | null {
  return runtime && typeof runtime.completeStructured === 'function' ? runtime as StructuredRuntime : null;
}

/** The tokens a call used, as reported, else Michi's estimate of what it read and wrote. */
function callTokens(completion: StructuredCompletion, system: string, prompt: string): number {
  const usage = completion.usage;
  if (usage) {
    const total = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    if (Number.isFinite(total) && total > 0) return Math.round(total);
  }
  return estimateTokens(system) + estimateTokens(prompt) + estimateTokens(completion.text || JSON.stringify(completion.value ?? ''));
}

export function createMemoryDirectAnswerer(deps: {
  runtime(runtimeId: string): AgentRuntime | undefined;
  /** MICHI_MEMORY_MODEL; null: none set. */
  model?(): string | null;
  /** The Meta agent's own model choice (Settings › Meta agent), not the chat default it otherwise follows. */
  metaAgentModel?(ownerUserId: string): { modelId: string | null; providerId: string | null };
  now?(): number;
}): MemoryDirectAnswerer {
  const now = deps.now ?? Date.now;
  const configuredModel = deps.model ?? (() => process.env.MICHI_MEMORY_MODEL?.trim() || null);
  const metaAgentModel = deps.metaAgentModel ?? ((ownerUserId: string) => {
    const settings = getMetaAgentSettings(ownerUserId);
    return { modelId: settings.modelId ?? null, providerId: settings.providerId ?? null };
  });
  return {
    supports: (runtimeId) => answersMemoryDirectly(deps.runtime(runtimeId)),
    answer: async (input) => {
      let tokens = 0;
      let calls = 0;
      const spent = () => (calls > 0 ? tokens : null);
      try {
        const runtime = structured(deps.runtime(input.profile.runtimeId));
        if (!runtime) return { status: 'failed', error: `Runtime "${input.profile.runtimeId}" cannot answer automatic memory directly`, tokens: null };
        const chosen = metaAgentModel(input.ownerUserId);
        const model = configuredModel() || chosen.modelId || null;
        const provider = chosen.modelId ? chosen.providerId ?? input.profile.providerId : input.profile.providerId;
        let prompt = input.prompt;
        for (;;) {
          input.signal.throwIfAborted();
          const run = getExtractionRun(input.runId, input.ownerUserId);
          if (!run || run.state !== 'active') return { status: 'failed', error: 'Automatic memory run record is missing', tokens: spent() };
          const completion = await runtime.completeStructured({
            system: input.system, prompt, schema: SCHEMAS[run.kind] as Record<string, unknown>,
            model, provider, reasoning: 'low', ownerUserId: input.ownerUserId, timeoutMs: CALL_TIMEOUT_MS, signal: input.signal,
          });
          calls += 1;
          tokens += callTokens(completion, input.system, prompt);
          input.signal.throwIfAborted();
          try {
            stageMemoryAnswer(run, completion.value, now());
            return { status: 'succeeded', error: null, tokens };
          } catch (error) {
            if (!(error instanceof InvalidMemoryAnswer)) throw error;
            const { stopped } = recordExtractionInvalidCall(run.id, MEMORY_EXTRACTION_LIMITS.maxRepairs);
            // Past its repairs the run settles as unreadable (its turns are skipped).
            if (stopped) return { status: 'succeeded', error: null, tokens };
            prompt = `${input.prompt}\n\nYour previous answer was not valid: ${error.message}. Reply with the corrected JSON object only.`;
          }
        }
      } catch (error) {
        if (input.signal.aborted) return { status: 'cancelled', error: 'Cancelled', tokens: spent() };
        const message = error instanceof Error ? error.message : String(error);
        log.warn('scheduler', 'automatic memory: the direct model call failed', { runId: input.runId, runtimeId: input.profile.runtimeId, error: message });
        return { status: 'failed', error: `The model call failed: ${message}`, tokens: spent() };
      }
    },
  };
}
