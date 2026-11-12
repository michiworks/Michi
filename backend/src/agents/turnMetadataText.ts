// The rules of Michi's per-turn reply metadata, the branch overview and the
// three follow-up questions, which several prompts state: the system prompt
// (preamble.ts), each runtime's per-turn reminder (hostText/kiro.ts,
// hostText/codex.ts, followUpsExperiment.ts) and the metadata tools' MCP
// descriptions and results (mcpServer.ts). Claude's warm pool and prompt cache
// need these texts byte-identical, so a change here is a prompt change for
// every runtime; the adapter and tool catalog goldens show it.
// crew-app/agents/michi.json is static and restates the Crew lines; a test
// checks it against CREW_TITLE_SENTINEL and CREW_FOLLOW_UP_SENTINELS.

/** What a branch overview covers. */
const OVERVIEW_SUBJECT = 'what this turn did — what was explored, decided, or discovered';

const OVERVIEW_LENGTH = '1-3 concise sentences';

/** A branch overview's content. */
export const OVERVIEW_CONTENT = `${OVERVIEW_LENGTH} describing ${OVERVIEW_SUBJECT}`;

/** Overviews accumulate into the branch's journal, so each covers its own turn. */
export const OVERVIEW_NO_RESTATE = 'do not restate earlier turns';

/** The three follow-up sentinel lines, numbered 1/3 to 3/3, holding `question(n)`. */
export function followUpSentinels(question: (n: number) => string): string[] {
    return [1, 2, 3].map((n) => `[FOLLOW-UP ${n}/3: ${question(n)}]`);
}

/** Kiro Crew's final-answer title line. */
export const CREW_TITLE_SENTINEL = '[TITLE: short summary]';

/** Kiro Crew's follow-up lines. */
export const CREW_FOLLOW_UP_SENTINELS = followUpSentinels(() => 'question').join(', ');

const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

export const SET_FOLLOW_UPS_DESCRIPTION =
    "Set exactly three follow-up questions for this turn. Write them from the user's point of view and in the user's language. Call near the end of the reply.";

export const SET_BRANCH_OVERVIEW_DESCRIPTION =
    `Append this turn's entry to the branch's durable journal. Summarize ${OVERVIEW_SUBJECT} — in ${OVERVIEW_LENGTH}, matching the user's language. ${sentence(OVERVIEW_NO_RESTATE)} Call near the end of every reply.`;

/** The set_branch_overview result Michi's MCP server gives a slot with a metadataDoneSentinel (Kiro's). */
export function metadataDoneToolResult(sentinel: string): string {
    return `Branch overview recorded. This turn's user-facing response is already complete; emit ${sentinel} as the runtime end-of-turn marker (auto-stripped before display).`;
}
