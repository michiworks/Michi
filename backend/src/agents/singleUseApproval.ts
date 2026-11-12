import type { McpSlot } from "michi-runtime/internal/contract/mcp";

/** The runtime's Michi-owned question channel (ask_user). */
export type AskUser = NonNullable<McpSlot["onAskUser"]>;

export type SingleUseApprovalResult =
  | { approved: true }
  | { approved: false; reason: "declined" | "no_answer" | "unavailable"; note?: string };

interface ApprovalChoice {
  label: string;
  description?: string;
}

/**
 * Asks the user to approve one action. Only the exact approve option
 * counts; any other answer, including a typed one, is a decline passed
 * back to the agent as the user's note.
 */
export async function askUserSingleUseApproval(askUser: AskUser | undefined, ask: {
  question: string;
  header: string;
  approve: ApprovalChoice;
  decline: ApprovalChoice;
}): Promise<SingleUseApprovalResult> {
  if (!askUser) return { approved: false, reason: "unavailable" };
  const answers = await askUser([{
    question: ask.question,
    header: ask.header,
    options: [ask.approve, ask.decline],
    multiSelect: false,
  }]);
  if (!answers) return { approved: false, reason: "no_answer" };
  const answer = (answers[ask.question] ?? Object.values(answers)[0] ?? "").trim();
  if (answer === ask.approve.label) return { approved: true };
  if (!answer || answer === ask.decline.label) return { approved: false, reason: "declined" };
  return { approved: false, reason: "declined", note: answer.slice(0, 500) };
}

/** What the agent is told after a declined or unanswered approval; `outcome` says what did not happen. */
export function declinedApprovalNext(reason: "declined" | "no_answer", outcome: string): string {
  return reason === "no_answer"
    ? `The user did not answer; ${outcome}. Do not retry unless the user asks.`
    : `The user declined; ${outcome}. Do not retry unless the user asks.`;
}
