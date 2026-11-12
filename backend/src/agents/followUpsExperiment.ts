import { followUpReminder, type MetadataOutputMode } from './preamble';
import { followUpSentinels } from './turnMetadataText';

/** Appended to every real user turn of a session that reports its branch
 * overview through the tool (Codex chats). It stays out of Michi history, so
 * branches and resume transcripts do not accumulate it. */
export const FOLLOW_UPS_SENTINEL_TURN_REMINDER = `

[Follow-up metadata reminder for this turn: do not call set_follow_ups. Near the end of the final answer, emit exactly these three standalone sentinel lines, numbered in order and each closed with "]":
${followUpSentinels(() => "a concise next question written in the user's voice and language").join('\n')}
The questions are what the user would ask you next, not questions you ask the user. Do not omit the closing brackets.]`;

/**
 * The per-turn reminder of a native runtime's session. `overviewTool`: the
 * session reports its overview through the tool, so the reminder carries the
 * follow-up sentinels only, on every turn.
 */
export function followUpsTurnReminder(
  userTurnCount: number,
  overviewTool: boolean,
  enableFollowUps: boolean = true,
): string {
  if (overviewTool) {
    // The sentinel reminder only carries the follow-up sentinel protocol, so
    // dropping it when follow-ups are disabled leaves branch-overview intact.
    return enableFollowUps ? FOLLOW_UPS_SENTINEL_TURN_REMINDER : '';
  }
  return followUpReminder(userTurnCount, enableFollowUps);
}

export function followUpsMetadataOutputMode(overviewTool: boolean): MetadataOutputMode {
  return overviewTool ? 'sentinel-followups-tool-overview' : 'sentinel';
}
