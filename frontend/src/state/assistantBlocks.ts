import { stripSentinelsStreamingSafe } from './assistantParsing';
import type { AssistantBlock, ChatMessage, SubagentInfo, ToolCallState } from './chatTypes';
import {
  applyTurnEvent,
  extractTurnMetadata,
  finalizeTurnContent,
  extractKiroSteering,
  KiroSteeringParser,
  mergeSteeringReports,
  type SteeringReport,
  type SteeringSegment,
  type ChatStreamEvent,
  type DurableTurnSnapshot,
} from 'michi-shared';

function isTextBlock(block: AssistantBlock): block is Extract<AssistantBlock, { kind: 'answer' | 'thinking' }> {
  return block.kind === 'answer' || block.kind === 'thinking';
}

// Shallow array copy. Preserving element identity lets `sameBlockRefs`
// short-circuit React.memo for unchanged runs during streaming.
function cloneBlocks(blocks: readonly AssistantBlock[] | undefined): AssistantBlock[] {
  return (blocks ?? []).slice();
}

export function isValidAssistantBlocks(value: unknown): value is AssistantBlock[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const b = item as Record<string, unknown>;
    if (typeof b.id !== 'string' || b.id.length === 0) return false;
    if (b.kind === 'answer' || b.kind === 'thinking') return typeof b.rawText === 'string';
    if (b.kind === 'image') return typeof (b as { path?: unknown }).path === 'string';
    if (b.kind === 'user-input') {
      return (
        typeof b.requestId === 'number' &&
        b.section === 'answer' &&
        typeof b.rawOffset === 'number' &&
        Number.isFinite(b.rawOffset)
      );
    }
    return (
      b.kind === 'tool' &&
      typeof b.toolCallId === 'string' &&
      (b.section === 'answer' || b.section === 'thinking') &&
      typeof b.rawOffset === 'number' &&
      Number.isFinite(b.rawOffset)
    );
  });
}

export function parseAssistantBlocks(raw: unknown): AssistantBlock[] | undefined {
  let value = raw;
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return isValidAssistantBlocks(value) ? cloneBlocks(value) : undefined;
}

export function assistantAnswerRawText(m: ChatMessage): string {
  if (m.role !== 'assistant') return m.text;
  const blocks = m.blocks;
  if (!blocks || blocks.length === 0) return m.text ?? '';
  return blocks.map((b) => (b.kind === 'answer' ? b.rawText : '')).join('');
}

export function assistantAnswerVisibleText(m: ChatMessage): string {
  return stripSentinelsStreamingSafe(extractKiroSteering(assistantAnswerRawText(m)).text).visibleText;
}

export function assistantPersistenceContent(m: ChatMessage): string {
  return m.role === 'assistant' ? finalizeTurnContent(assistantAnswerRawText(m)) : m.text;
}

export function assistantMetadata(m: ChatMessage): { title: string | null; branchOverview: string | null; followUps: string[] } {
  const metadata = extractTurnMetadata(assistantAnswerRawText(m));
  return {
    title: metadata.title ?? null,
    branchOverview: metadata.branchOverview ?? null,
    followUps: metadata.followUps ?? [],
  };
}

export function visibleMessageText(m: ChatMessage): string {
  return m.role === 'assistant' ? assistantAnswerVisibleText(m) : m.text;
}

/**
 * Frontend adapter around the shared durable projector. Durable stream event
 * placement lives in shared; this layer preserves UI-only ChatMessage fields.
 */
export function projectAssistantStreamEvent(
  message: ChatMessage,
  workspaceId: string,
  event: ChatStreamEvent,
): ChatMessage {
  if (message.role !== 'assistant') return message;
  const startedAt = message.createdAt ?? 0;
  const snapshot: DurableTurnSnapshot = {
    version: 1,
    turnId: event.data.turnId ?? `frontend-${message.id}`,
    nodeId: '',
    workspaceId,
    assistantId: message.id,
    userMessage: null,
    assistantMessage: {
      id: message.id,
      role: 'assistant',
      // Placeholder: `applyTurnEvent` recomputes content from blocks where it
      // matters (chunk/done/error) and never reads this input, and our return
      // below discards `projected.assistantMessage.content` entirely. Computing
      // the real value here would run finalizeTurnContent's full-string scan on
      // every chunk (O(L²) over a streaming turn) just to throw it away.
      // Persistence/fingerprints derive content lazily via assistantPersistenceContent.
      content: '',
      blocks: message.blocks ?? [],
      toolCalls: message.toolCalls,
      plan: message.plan,
      subagents: message.subagents,
      metadata: { steeringReports: message.steeringReports, usageSummary: message.usageSummary, warnings: message.warnings },
      createdAt: startedAt,
    },
    nodeMetadata: {},
    status: 'active',
    lastAppliedSeq: -1,
    startedAt,
  };
  const projected = applyTurnEvent(snapshot, event);
  return {
    ...message,
    blocks: projected.assistantMessage.blocks,
    toolCalls: projected.assistantMessage.toolCalls,
    plan: projected.assistantMessage.plan,
    ...(projected.assistantMessage.subagents ? { subagents: projected.assistantMessage.subagents } : {}),
    usageSummary: projected.assistantMessage.metadata?.usageSummary,
    warnings: projected.assistantMessage.metadata?.warnings,
    ...(projected.assistantMessage.metadata?.steeringReports
      ? { steeringReports: projected.assistantMessage.metadata.steeringReports } : {}),
    streaming: projected.status === 'active' ? message.streaming : false,
  };
}

export function finalizeAssistantBlocks(message: ChatMessage): ChatMessage {
  if (message.role !== 'assistant') return message;
  const blocks = cloneBlocks(message.blocks).map((b) =>
    isTextBlock(b) ? { ...b, streaming: false } : b,
  );
  return { ...message, streaming: false, blocks };
}

export function hasAssistantBlocks(m: ChatMessage): boolean {
  return m.role === 'assistant' && isValidAssistantBlocks(m.blocks);
}

/** One-time compatibility projection for pre-parser persisted replies. */
function extractLegacySteering(message: ChatMessage): ChatMessage {
  if (!assistantAnswerRawText(message).includes('[STEERING')) return message;
  const parser = new KiroSteeringParser();
  const reports: SteeringReport[] = [];
  const visible = (segments: SteeringSegment[]) => segments.map((segment) => {
    if (segment.kind === 'text') return segment.text;
    reports.push(segment.report);
    return '';
  }).join('');
  const blocks = (message.blocks ?? []).map((block) => block.kind === 'answer'
    ? { ...block, rawText: visible(parser.push(block.rawText)) } : block);
  const tail = visible(parser.finish());
  let lastAnswer = blocks.length - 1;
  while (lastAnswer >= 0 && blocks[lastAnswer].kind !== 'answer') lastAnswer--;
  const last = blocks[lastAnswer];
  if (last?.kind === 'answer') blocks[lastAnswer] = { ...last, rawText: last.rawText + tail };
  if (!reports.length) return message;
  let answerOffset = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === 'answer') answerOffset += block.rawText.length;
    else if (block.kind === 'thinking') answerOffset = 0;
    else if ((block.kind === 'tool' || block.kind === 'user-input') && block.section === 'answer') {
      blocks[i] = { ...block, rawOffset: answerOffset };
    }
  }
  return { ...message, blocks, steeringReports: mergeSteeringReports(message.steeringReports, reports) };
}

export function migrateAssistantToBlocks(message: ChatMessage): ChatMessage {
  if (message.role !== 'assistant') return message;
  const existing = parseAssistantBlocks(message.blocks);
  if (existing) {
    return extractLegacySteering({ ...message, blocks: existing, text: '', thought: undefined });
  }

  const blocks: AssistantBlock[] = [];
  if (message.thought) {
    blocks.push({
      id: `${message.id}-legacy-thinking-0`,
      kind: 'thinking',
      rawText: message.thought,
      streaming: false,
    });
  }

  const raw = message.text ?? '';
  const withIndex = (message.toolCalls ?? []).map((tool, index) => ({ tool, index }));
  const positioned = withIndex
    .filter(({ tool }) => typeof tool.textOffset === 'number' && Number.isFinite(tool.textOffset))
    .map(({ tool, index }) => ({
      tool,
      index,
      offset: Math.max(0, Math.min(tool.textOffset as number, raw.length)),
    }))
    .sort((a, b) => (a.offset - b.offset) || (a.index - b.index));
  const trailing = withIndex.filter(({ tool }) => typeof tool.textOffset !== 'number' || !Number.isFinite(tool.textOffset));

  let cursor = 0;
  let answerSlice = 0;
  const pushAnswer = (text: string) => {
    if (!text) return;
    blocks.push({
      id: `${message.id}-legacy-answer-${answerSlice++}`,
      kind: 'answer',
      rawText: text,
      streaming: false,
    });
  };
  for (const item of positioned) {
    pushAnswer(raw.slice(cursor, item.offset));
    blocks.push({
      id: `${message.id}-legacy-tool-${item.tool.id || item.index}`,
      kind: 'tool',
      toolCallId: item.tool.id,
      section: 'answer',
      rawOffset: item.offset,
    });
    cursor = item.offset;
  }
  pushAnswer(raw.slice(cursor));
  for (const item of trailing) {
    blocks.push({
      id: `${message.id}-legacy-tool-${item.tool.id || item.index}`,
      kind: 'tool',
      toolCallId: item.tool.id,
      section: 'answer',
      rawOffset: raw.length,
    });
  }

  return extractLegacySteering({ ...message, blocks, text: '', thought: undefined, streaming: false });
}

export function messageForPersistence(m: ChatMessage): {
  content: string;
  blocks: string | null;
  toolCalls: ToolCallState[];
  steeringReports?: SteeringReport[];
  subagents?: SubagentInfo[];
} {
  if (m.role !== 'assistant') {
    return { content: m.text, blocks: null, toolCalls: m.toolCalls ?? [] };
  }
  const migrated = migrateAssistantToBlocks(m);
  return {
    content: assistantPersistenceContent(migrated),
    blocks: migrated.blocks && migrated.blocks.length > 0 ? JSON.stringify(migrated.blocks) : null,
    toolCalls: migrated.toolCalls ?? [],
    ...(migrated.steeringReports?.length ? { steeringReports: migrated.steeringReports } : {}),
    ...(migrated.subagents?.length ? { subagents: migrated.subagents } : {}),
  };
}
