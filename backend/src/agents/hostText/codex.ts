import type { FollowUpsExperimentMode } from 'michi-runtime';
import { TITLE_RULES } from '../../services/titleGeneration';
import { OVERVIEW_CONTENT, OVERVIEW_NO_RESTATE } from '../turnMetadataText';

// Michi's product text for the Codex adapter. The adapter receives it through
// its options (CodexAdapterOptions.hostText, built by michiCodexOptions.ts).

/** Developer instructions of Codex's pre-turn title thread: the sidecar titles' rules, answered through its output schema. */
export const TITLE_INSTRUCTIONS = `${TITLE_RULES}
Return only the JSON object required by the output schema.`;

export function buildCodexTurnMetadataInstruction(
  _mode: FollowUpsExperimentMode,
  enableFollowUps: boolean = true,
): string {
  const followUpsInstruction = !enableFollowUps
    ? '- Follow-ups are disabled. Do not call set_follow_ups or emit follow-up metadata. Call set_branch_overview before writing the final answer.'
    : `- Do not call set_follow_ups. Follow-ups are delivered only through the three [FOLLOW-UP n/3: ...] sentinel lines.
- Emit all three follow-up sentinel lines before calling set_branch_overview.
- Call set_branch_overview only after [FOLLOW-UP 3/3: ...] has been emitted and closed.
- After the set_branch_overview tool result, emit no more visible text. The overview tail is background metadata work.`;

  return `

Codex turn metadata:
- Before ending every real user turn, call mcp____michi_internal____set_branch_overview exactly once.
- The one exception is a turn whose message says it runs a skill: follow the skill, and call neither set_branch_overview nor set_follow_ups in it.
- Pass {"overview":"..."}: ${OVERVIEW_CONTENT} — matching the user's language. Entries accumulate into the branch's journal; ${OVERVIEW_NO_RESTATE}.
- The structured overview tool call is canonical. Do not duplicate the overview as textual fallback metadata or visible answer text. This replaces any older instructions or conversation examples that requested overview text markers.
${followUpsInstruction}`;
}
