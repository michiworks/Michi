import { extractKiroSteering, finalizeTurnContent, stripTurnMetadataSentinels } from 'michi-shared';

export function stripSentinelsStreamingSafe(raw: string): string {
    return stripTurnMetadataSentinels(extractKiroSteering(raw).text);
}

export function normalizeJsonField(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === "string") {
        if (!value.trim()) return null;
        try {
            return JSON.stringify(JSON.parse(value));
        } catch {
            return null;
        }
    }
    try {
        return JSON.stringify(value);
    } catch {
        return null;
    }
}

export function deriveAssistantContentFromBlocks(blocks: unknown): string | null {
    let value = blocks;
    if (typeof value === "string" && value.trim()) {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(value)) return null;
    const raw = value
        .map((b) => {
            if (!b || typeof b !== "object") return "";
            const block = b as Record<string, unknown>;
            return block.kind === "answer" && typeof block.rawText === "string" ? block.rawText : "";
        })
        .join("");
    // The content a finished turn stores, so a restored row reads and searches like the original.
    return finalizeTurnContent(raw);
}

export function contentFromIncomingMessage(message: Record<string, unknown>): string {
    if (message.role === "assistant") {
        const fromBlocks = deriveAssistantContentFromBlocks(message.blocks);
        if (fromBlocks !== null) return fromBlocks;
    }
    if (typeof message.content === "string") return message.content;
    if (typeof message.text === "string") return message.text;
    return "";
}

export function normalizeIncomingMessageRow(
    raw: Record<string, unknown>,
    fallbackNodeId: string,
    fallbackSeq: number,
): MessageRow {
    const nodeId = typeof raw.node_id === "string" && raw.node_id ? raw.node_id : fallbackNodeId;
    const seq = typeof raw.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : fallbackSeq;
    return {
        id: typeof raw.id === "string" && raw.id ? raw.id : `${nodeId}-msg-${seq}`,
        node_id: nodeId,
        role: raw.role === "assistant" ? "assistant" : "user",
        content: contentFromIncomingMessage(raw),
        blocks: normalizeJsonField(raw.blocks),
        tool_calls: normalizeJsonField(raw.tool_calls ?? raw.toolCalls),
        metadata: normalizeJsonField(raw.metadata),
        seq,
        created_at: typeof raw.created_at === "number"
            ? raw.created_at
            : typeof raw.createdAt === "number"
                ? raw.createdAt
                : Date.now(),
    };
}
import type { MessageRow } from "./dbRepository";
