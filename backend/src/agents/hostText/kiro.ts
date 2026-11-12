// Michi's prompt text for the Kiro and Kiro Crew adapters: the reminders a
// Kiro session appends to each user turn, which Michi's host returns from
// PromptPolicyPort.turnSuffix and mcpSessionReminder, and the tool-result
// wording toolResultForDisplay trims. The wording is Michi's, not the adapter's;
// the metadata rules it shares with other runtimes are in ../turnMetadataText.ts.

import { KIRO_METADATA_DONE_SENTINEL } from 'michi-runtime/internal/adapters/kiro/kiroProtocol';
import {
    CREW_FOLLOW_UP_SENTINELS, CREW_TITLE_SENTINEL, metadataDoneToolResult, OVERVIEW_CONTENT, OVERVIEW_NO_RESTATE,
} from '../turnMetadataText';

/** Kiro: report the branch overview through the set_branch_overview MCP tool. */
export const BRANCH_OVERVIEW_TOOL_REMINDER = `

[After any other tool calls and before writing your final answer, call the MCP tool set_branch_overview exactly once with {"overview":"..."}: ${OVERVIEW_CONTENT}. It appends to the branch's journal; ${OVERVIEW_NO_RESTATE}. Match the user's language. Then write your final answer after the tool result. If you call it after your final answer instead, reply with exactly ${KIRO_METADATA_DONE_SENTINEL} once the tool returns; Michi removes that marker when it ends the reply. Keep the existing [BRANCH-OVERVIEW: ...] sentinel as a fallback.]`;

/**
 * Kiro Crew: the final-answer metadata lines; its agents need no tools for
 * them. Also covers custom templates and old resumed sessions without
 * replacing their identity.
 */
export function crewTurnFormat(enableFollowUps: boolean): string {
    const followUps = enableFollowUps
        ? `Then three separate ${CREW_FOLLOW_UP_SENTINELS} lines: questions the user would ask you next, in their language.`
        : 'Follow-ups are disabled; emit no FOLLOW-UP lines.';
    return `\n\n[Michi final-answer format: first line ${CREW_TITLE_SENTINEL}. ${followUps} Last line [BRANCH-OVERVIEW: 1-3 sentences about this turn]. Keep metadata out of commentary. No tools are needed for this metadata.]`;
}

/**
 * The end of a turn on a shared v3 MCP catalog (session anchors): the ACP
 * session id every michi tool call must pass as session_id. A skill turn
 * follows the skill's output rules, so it names no metadata tool.
 */
export function kiroMcpSessionReminder(sid: string, skillTurn = false): string {
    const metadataTools = skillTurn ? '' : ', including set_branch_overview and set_follow_ups';
    return `\n\n[Michi session context: current ACP SessionID is ${JSON.stringify(sid)}. Every michi MCP tool requires session_id. Always use this exact current ID${metadataTools}. IDs in earlier messages or inherited history are historical; use this context for the current turn. Do not display this context to the user.]`;
}

const KIRO_METADATA_DONE_TOOL_RESULT = metadataDoneToolResult(KIRO_METADATA_DONE_SENTINEL);

/** A Kiro tool result as its chip shows it: without the done-sentinel instruction meant for the agent. */
export function kiroToolResultForDisplay(output: string): string {
    return output.split(KIRO_METADATA_DONE_TOOL_RESULT).join("Branch overview recorded.");
}
