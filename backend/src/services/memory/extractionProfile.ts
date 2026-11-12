import { createHash } from 'node:crypto';
import type { RuntimeToolProfile } from '../../agents/types';
import { buildExtractionInstructions } from './extractionPolicy';

/**
 * The closed tool session of automatic memory, for a Meta agent runtime
 * without a direct structured call (extractionDirect.ts answers the others):
 * three host tools and nothing else. memory_extract (extractionTools.ts)
 * answers a run that reads conversation turns; memory_profile answers a run
 * that rebuilds the user's profile (userProfile.ts, whose instructions such a
 * session gets); memory_consolidate answers a run that tidies Michi's own
 * notes (consolidation.ts). The run's prompt carries everything it reads, so
 * the model answers with one call of its run's tool; each tool refuses a run
 * of another kind. All are listed in every session, so the catalog (and
 * Kiro's agent file for the toolset) is the same whichever run opens it. It is
 * a Meta agent maintenance profile (restricted, no shell, files, network or
 * external MCP tools), so every adapter runs its closed tool-catalog check
 * against these names.
 */

/** The tool of a run that rebuilds the user's profile. */
export const MEMORY_PROFILE_TOOL_NAME = 'memory_profile' as const;
/** The tool of a run that tidies Michi's own notes (consolidation). */
export const MEMORY_CONSOLIDATE_TOOL_NAME = 'memory_consolidate' as const;

export const MEMORY_EXTRACTION_TOOL_NAMES = ['memory_extract', MEMORY_PROFILE_TOOL_NAME, MEMORY_CONSOLIDATE_TOOL_NAME] as const;

export type MemoryExtractionToolName = typeof MEMORY_EXTRACTION_TOOL_NAMES[number];

export function isMemoryExtractionToolName(name: string): name is MemoryExtractionToolName {
  return (MEMORY_EXTRACTION_TOOL_NAMES as readonly string[]).includes(name);
}

/** Constructed by the backend for a scheduled extraction node only; never from request data. */
export function memoryExtractionToolProfile(): RuntimeToolProfile {
  return {
    allowedToolNames: MEMORY_EXTRACTION_TOOL_NAMES,
    maintenance: true,
    restricted: true,
    metaAgentToolset: 'memory',
  };
}

/** What a session's run does: read conversation turns, rebuild the user's profile, or tidy Michi's own notes. */
export type MemoryRunKind = 'extract' | 'profile' | 'consolidate';

const PROFILE_HASH_NAMES: Record<MemoryRunKind, string> = {
  extract: 'memory-extraction-3',
  profile: 'memory-profile-1',
  consolidate: 'memory-consolidation-1',
};

export function memoryExtractionProfileHash(
  runtimeConfig: { runtimeId: string; providerId: string | null; modelId: string | null; reasoning: string | null },
  kind: MemoryRunKind = 'extract',
): string {
  return createHash('sha256').update(JSON.stringify({ profile: PROFILE_HASH_NAMES[kind], toolNames: MEMORY_EXTRACTION_TOOL_NAMES, ...runtimeConfig })).digest('hex');
}

/** The session's system instructions: the extraction policy, answered with memory_extract. */
export function memoryExtractionBootstrapInstructions(): string {
  return buildExtractionInstructions({ toolName: MEMORY_EXTRACTION_TOOL_NAMES[0] });
}
