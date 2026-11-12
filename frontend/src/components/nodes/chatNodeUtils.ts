export const BRANCH_PREFIX = /^\/(btw|branch)\s+/i;

export function stripBranchPrefix(text: string): { branched: boolean; text: string } {
  const m = text.match(BRANCH_PREFIX);
  if (m) return { branched: true, text: text.slice(m[0].length) };
  return { branched: false, text };
}

/**
 * Decide whether a submit() call should create a new branch (child node) or
 * keep the message on the current node. Pure function.
 *
 * Rules (updated 2026-05-07 — see composer-queue-design.md):
 *   - forceBranch (⌘+Enter, Branch button)              → branch
 *   - slashBranched (text starts with /btw or /branch)  → branch
 *   - streaming                                          → caller queues; this returns false
 *   - otherwise                                          → in-place reply
 *
 * The `streaming` parameter is kept in the signature for now because
 * existing callers still pass it; the new queue path lives in TPane.onSubmit.
 */
export function shouldBranchOnSubmit(params: {
  forceBranch: boolean;
  slashBranched: boolean;
  streaming: boolean;
}): boolean {
  return params.forceBranch || params.slashBranched;
}

// The command itself, then whitespace or the end: `/explore-codebase` or
// `/explore:deep` names a skill, which must not fan out.
export const FANOUT_PREFIX = /^\/(fanout|fan-out|explore)(?=\s|$)[ \t]*/i;

/**
 * Parse a /fanout command into a list of topic strings, one per branch.
 * Accepts two styles:
 *
 *   /fanout
 *   - study option A
 *   - investigate option B
 *   1. research C
 *
 *   /fanout study A; investigate B; research C
 *
 * Returns `null` when the text is not a fanout command. Returns an empty
 * list (not null) when the command is present but no topics could be parsed
 * — callers should treat that as a no-op.
 */
export function parseFanoutCommand(text: string): { topics: string[] } | null {
  const m = text.match(FANOUT_PREFIX);
  if (!m) return null;
  const body = text.slice(m[0].length);

  const topics: string[] = [];
  const rawLines = body.split('\n').map((l) => l.trim()).filter(Boolean);

  // If the command was on its own line, every following line is a topic.
  if (rawLines.length > 1 || (rawLines[0] && /^[-*•]|\d+[.)]\s/.test(rawLines[0]))) {
    for (const line of rawLines) {
      const cleaned = line
        .replace(/^[-*•]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .trim();
      if (cleaned) topics.push(cleaned);
    }
    return { topics };
  }

  // Otherwise it's a single-line command with semicolon (or comma-newline)
  // separated topics.
  const singleLine = rawLines[0] ?? '';
  if (singleLine) {
    // Only split on semicolons. Commas are too common inside normal prose to
    // make a safe separator ("study A, B, and C" would over-split).
    for (const part of singleLine.split(';')) {
      const cleaned = part.trim();
      if (cleaned) topics.push(cleaned);
    }
  }
  return { topics };
}
