import { randomUUID } from "node:crypto";
import { chatBlocksFallbackText, checkChatBlocks, type ChatStreamPayloads } from "michi-shared";

/** Block types whose answer comes back as the user's next message. */
const ANSWERED = new Set(["form", "poll", "choice", "actions"]);

export type ShowBlocksResult =
    | { ok: true; payload: ChatStreamPayloads["blocks"]; text: string }
    | { ok: false; error: string };

/**
 * A show_blocks call as the reply's `blocks` event, or why not. Each block
 * gets an id of its own here, once, so a live window, a replay and a reload
 * name it the same (submissions are kept by it); the fallback text is built
 * here too, for windows that do not draw blocks. `text` is what the agent is
 * told.
 */
export function prepareShowBlocks(args: { blocks?: unknown; title?: unknown }): ShowBlocksResult {
    const checked = checkChatBlocks(args);
    if (!checked.ok) return { ok: false, error: `show_blocks failed: ${checked.problem}` };
    const blocks = checked.blocks.map((block) => ({ ...block, id: `cb-${randomUUID()}` }));
    const fallbackText = chatBlocksFallbackText(blocks, checked.title);
    const answered = blocks.some((block) => ANSWERED.has(block.type));
    const count = `${blocks.length} block${blocks.length === 1 ? "" : "s"}`;
    return {
        ok: true,
        payload: { blocks, ...(checked.title ? { title: checked.title } : {}), fallbackText },
        text: answered
            ? `Showed ${count} to the user. Their answer arrives as their next message; end your turn and wait for it.`
            : `Showed ${count} to the user.`,
    };
}
