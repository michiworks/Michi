import type { CompanionActor, SpaceActivityDetail, SpaceSummaryDto, TaskOrigin } from 'michi-shared';

/**
 * The MVP's 'meta-agent' actor (DESIGN-v2 §2.7 replaced it with a
 * CompanionActor; the W2 merge removed it from the shared types). A backend
 * from before the merge still sends it for what its Meta agent wrote; it reads
 * as the agent's Pages upkeep, "<name> · Pages upkeep".
 */
const UPKEEP: CompanionActor = Object.freeze({ kind: 'companion', via: 'upkeep' });

const LEGACY = 'meta-agent';

/** SpaceSummaryDto.createdBy from any backend. */
export function spaceCreatorFrom(value: unknown): SpaceSummaryDto['createdBy'] {
  return value === LEGACY ? UPKEEP : value as SpaceSummaryDto['createdBy'];
}

/** SpaceActivityDetail.by from any backend. */
export function activityWriterFrom(value: unknown): SpaceActivityDetail['by'] {
  return (value as { kind?: unknown } | null)?.kind === LEGACY ? UPKEEP : value as SpaceActivityDetail['by'];
}

/** TaskOrigin.by from any backend. */
export function taskCreatorFrom(value: unknown): TaskOrigin['by'] {
  return value === LEGACY ? UPKEEP : value as TaskOrigin['by'];
}
