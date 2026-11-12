import type { UserInputAnswer, UserInputQuestion } from "michi-shared";
import type { AskUser } from "../singleUseApproval";
import { ASK_USER_DESCRIPTION, ASK_USER_NOT_ANSWERED, ASK_USER_TOOL, parseAskUserQuestions } from "michi-runtime/internal/mcp-host/askUser";

/** Same name, schema and result text as the MCP ask_user other runtimes use. */
export const PI_ASK_USER_TOOL = ASK_USER_TOOL;

/**
 * Pi gets its system prompt from buildPreamble (like Kiro), not from
 * buildStableSystemPrompt, whose native-question line names Claude's own
 * AskUserQuestion tool. This is that line for Pi's single question tool.
 */
export const PI_ASK_USER_INSTRUCTION =
    "Use the ask_user tool for structured questions when you need the user to choose or clarify something before continuing. "
    + "It is connected to the user interface and waits for the user's answer; the user can also type their own answer.";

/** Shows the questions and resolves the answers, or null when skipped, timed out or cancelled. */
export type PiUserInputRequester = (
    questions: UserInputQuestion[],
    signal?: AbortSignal,
) => Promise<UserInputAnswer[] | null>;

/**
 * ask_user for pi-agent-core / the Pi SDK. Sequential so a batch never shows
 * two questions at once: the host tracks one pending question per turn.
 */
export function buildPiAskUserTool(Type: any, requestUserInput: PiUserInputRequester): any {
    const option = Type.Object({
        label: Type.String({ description: "Display text for this option (1-5 words)." }),
        description: Type.Optional(Type.String({ description: "Explanation of what this option means." })),
    });
    const question = Type.Object({
        question: Type.String({ description: "The question to ask the user." }),
        header: Type.Optional(Type.String({ description: "Short label (max 12 chars) displayed as a chip/tag." })),
        options: Type.Array(option, { minItems: 2, maxItems: 4, description: "Available choices (2-4 options)." }),
        multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple selections. Defaults to false." })),
    });
    return {
        name: PI_ASK_USER_TOOL,
        label: "Ask user",
        description: ASK_USER_DESCRIPTION,
        parameters: Type.Object({
            questions: Type.Array(question, { minItems: 1, maxItems: 4, description: "Questions to ask (1-4)." }),
        }),
        executionMode: "sequential" as const,
        execute: async (_id: string, args: any, signal?: AbortSignal) => {
            const questions = parseAskUserQuestions(args?.questions);
            if (typeof questions === "string") {
                return { content: [{ type: "text", text: questions }], details: { error: questions }, isError: true };
            }
            const answers = await requestUserInput(questions, signal);
            // A stopped turn must not continue with an answer that arrived late.
            signal?.throwIfAborted();
            if (!answers) return { content: [{ type: "text", text: ASK_USER_NOT_ANSWERED }], details: { answered: false } };
            return {
                content: [{ type: "text", text: JSON.stringify({ answers: answersByQuestion(answers) }) }],
                details: { answered: true, answers },
            };
        },
    };
}

function answersByQuestion(answers: UserInputAnswer[]): Record<string, string> {
    const byQuestion: Record<string, string> = {};
    for (const answer of answers) byQuestion[answer.question] = answer.answer;
    return byQuestion;
}

/** The session's question channel in the shape Michi's approvals ask through (McpSlot.onAskUser). */
export function piAskUserChannel(requestUserInput: PiUserInputRequester | undefined, signal?: AbortSignal): AskUser | undefined {
    return requestUserInput
        ? async (questions) => { const answers = await requestUserInput(questions, signal); return answers && answersByQuestion(answers); }
        : undefined;
}
