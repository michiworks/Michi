import type { ChatStreamEvent, DurableMessageMetadata, PlanEntry, ToolCallStreamPayload, UserInputQuestion, UserInputAnswer } from './chatStreamEvents';
import { extractKiroSteering, mergeSteeringReports } from './kiroSteering';
import {
  applySubagentActivity,
  finalizeSubagentRoster,
  mergeSubagentRoster,
  type SubagentInfo,
} from './subagents';

export interface DurableToolCall {
  id: string;
  title: string;
  status: string;
  kind?: string;
  detail?: string;
  inputJson?: string;
  output?: string;
  textOffset?: number;
  /** Wall-clock ms when the backend first observed the tool_call event. Optional:
   *  turns persisted before this field exists simply omit durations. */
  startedAt?: number;
  /** Wall-clock ms when the tool first reached a terminal status. */
  endedAt?: number;
}

export interface DurableUserInput {
  interactionId: string;
  requestId: number;
  questions: UserInputQuestion[];
  answers: UserInputAnswer[];
  status: 'pending' | 'answered' | 'skipped' | 'interrupted';
}

// Message ids of a turn, stored in data.db: keep their formats.
/** The assistant message of a turn a person started (ChatHub.startTurn). */
export function userTurnAssistantId(nodeId: string, turnId: string): string {
  return `a-${nodeId}-${turnId}`;
}

/** The assistant message of a self-turn: backend-requested or the runtime's own. */
export function selfTurnAssistantId(nodeId: string, turnId: string): string {
  return `self-${nodeId}-${turnId}`;
}

/** The user message of the turn whose assistant message is assistantId. */
export function userMessageIdFor(assistantId: string): string {
  return `u-${assistantId}`;
}

/** Stable fallback for older envelopes with no interactionId. */
export function userInputInteractionId(turnId: string, requestId: number): string {
  return `${turnId}:input:${requestId}`;
}

export function normalizeUserInputQuestions(interactionId: string, questions: UserInputQuestion[]): UserInputQuestion[] {
  return questions.map((question, index) => ({ id: question.id ?? `${interactionId}:q:${index}`, question: question.question,
    ...(question.header !== undefined ? { header: question.header } : {}), multiSelect: question.multiSelect,
    options: question.options.map(option => ({ label: option.label, ...(option.description !== undefined ? { description: option.description } : {}) })) }));
}

export function normalizeUserInputAnswers(questions: UserInputQuestion[], answers: UserInputAnswer[]): UserInputAnswer[] {
  return answers.map((answer, index) => ({ ...answer, id: answer.id ?? (questions[index]?.question === answer.question ? questions[index]?.id : questions.find(q => q.question === answer.question)?.id) }));
}

/** Text-block timing, stamped from the backend's `observedAt` like tool
 *  startedAt/endedAt: `startedAt` when the block's first frame is projected,
 *  `endedAt` when a later block (or the turn's end) closes it. Optional:
 *  blocks persisted before these fields existed simply omit them. */
interface DurableTextBlockTiming {
  startedAt?: number;
  endedAt?: number;
}

export type DurableAssistantBlock =
  | ({ id: string; kind: 'answer'; rawText: string; streaming?: boolean } & DurableTextBlockTiming)
  | ({ id: string; kind: 'thinking'; rawText: string; streaming?: boolean } & DurableTextBlockTiming)
  | { id: string; kind: 'tool'; toolCallId: string; section: 'answer' | 'thinking'; rawOffset: number }
  | { id: string; kind: 'user-input'; requestId: number; interaction?: DurableUserInput; section: 'answer'; rawOffset: number }
  | { id: string; kind: 'image'; workspaceId: string; path: string; caption?: string; mimeType: string; size: number };

export interface DurableMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  blocks: DurableAssistantBlock[];
  toolCalls: DurableToolCall[];
  plan?: PlanEntry[];
  /** Subagents this assistant turn delegated to (persisted in metadata). */
  subagents?: SubagentInfo[];
  metadata?: DurableMessageMetadata;
  createdAt: number;
}

export interface DurableTurnSnapshot {
  version: 1;
  turnId: string;
  nodeId: string;
  workspaceId: string;
  assistantId: string;
  userMessage: DurableMessage | null;
  steeredMessages?: DurableMessage[];
  assistantMessage: DurableMessage;
  nodeMetadata: {
    title?: string;
    followUps?: string[];
    branchOverview?: string;
  };
  status: 'active' | 'completed' | 'cancelled' | 'error';
  stopReason?: string;
  error?: string;
  lastAppliedSeq: number;
  startedAt: number;
  completedAt?: number;
}

export interface CreateDurableTurnInput {
  turnId: string;
  assistantId: string;
  nodeId: string;
  workspaceId: string;
  displayUserText: string;
  userMetadata?: DurableMessageMetadata;
  selfInitiated?: boolean;
  /** Self-initiated turns normally have no user message. A cross-thread
   * message keeps one so the receiving thread shows what it was asked. */
  keepUserMessage?: boolean;
  startedAt: number;
}

/** Stable across HTTP acknowledgement, live delivery and replay. */
export function steeredUserMessage(data: Extract<ChatStreamEvent, { event: 'steer_accepted' }>['data']): DurableMessage | null {
  const id = data.messageId ?? (data.assistantId && typeof data.seq === 'number'
    ? `u-steer-${data.assistantId}-${data.seq}` : undefined);
  if (!id) return null;
  return {
    id, role: 'user', content: data.text, blocks: [], toolCalls: [],
    metadata: { ...data.userMetadata, steered: true },
    createdAt: data.createdAt ?? 0,
  };
}

const SENTINEL_PREFIXES = ['[TITLE:', '[BRANCH-OVERVIEW:', '[FOLLOW-UP'] as const;
// One line each, like the sentinels scanTurnMetadataSentinels cuts. An
// overview runs to its line's last `]`, so it may contain brackets.
const INLINE_TITLE_RE_G = /\[TITLE:[ \t]*([^\]\n\r]+)\]/gi;
const PROSE_TITLE_RE = /^\s*(?:#+\s*)?\**\s*title\s*[:：]\s*\**\s*(.+?)\s*\**\s*$/im;
const INLINE_BRANCH_OVERVIEW_RE_G = /\[BRANCH-OVERVIEW:[ \t]*([^\n\r]+)\]/gi;
const INLINE_FOLLOW_UP_RE = /\[FOLLOW-UP\s+([1-3])\s*(?:\/\s*3)?\s*:\s*([^\]\n\r]*?)(?:\]|(?=\s*\[FOLLOW-UP\s+[1-3])|(?=[\n\r])|$)/gi;
const INLINE_FOLLOW_UPS_RE = /\[FOLLOW-UPS:\s*([^\]]+)\]/gi;
// INLINE_FOLLOW_UP_RE's third sentinel without its end-of-input close: mid-stream that is a half-written one.
const LOST_BRACKET_THIRD_FOLLOW_UP_RE_G = /\[FOLLOW-UP\s+3\s*(?:\/\s*3)?\s*:\s*([^\]\n\r]*?)(?:\]|[\n\r]|\s*\[FOLLOW-UP\s+[1-3])/gi;
const PROSE_FOLLOW_UP_RE = /(?:^|\n)[\s#*>_`-]*follow[-\s]?up\s+questions?\s*[:：][\s*_`]*/i;

export interface ExtractedTurnMetadata {
  title?: string;
  followUps?: string[];
  branchOverview?: string;
}

/**
 * Whether streamed answer text has finished its third follow-up sentinel as
 * the renderers read it (followUpsMatch): in the last group of follow-up
 * lines, closed by `]` or its line's end; failing such a group, the lost-`]`
 * reading. An empty third one is none, as the renderers drop it. Unlike the
 * renderers, the end of the text does not close it.
 */
export function hasClosedFollowUpSentinels(text: string): boolean {
  const group = lastFollowUpLineGroup(text);
  if (group.length > 0) return group.some((item) => item.index === 2 && item.closed);
  return [...text.matchAll(LOST_BRACKET_THIRD_FOLLOW_UP_RE_G)].some((match) => match[1].trim() !== '');
}

/** Matches of a global sentinel pattern whose `[` is not quoted in inline code. */
function unquotedMatches(raw: string, pattern: RegExp): RegExpMatchArray[] {
  const quoted = inlineCodeBrackets(raw);
  return [...raw.matchAll(pattern)].filter((match) => !quoted.has(match.index ?? -1));
}

function titleMatch(raw: string): { start: number; end: number; title: string } | null {
  const [inline] = unquotedMatches(raw, INLINE_TITLE_RE_G);
  if (inline?.index !== undefined) {
    return { start: inline.index, end: inline.index + inline[0].length, title: inline[1].trim() };
  }
  const prose = raw.match(PROSE_TITLE_RE);
  if (prose?.index !== undefined) {
    return { start: prose.index, end: prose.index + prose[0].length, title: prose[1].trim() };
  }
  return null;
}

const FOLLOW_UP_START_RE_G = /\[FOLLOW-UP\s+([1-3])\s*(?:\/\s*3)?\s*:\s*/gi;
/** Sentinels that end at the last `]` of their line. */
const LINE_SENTINEL_PREFIX_RE = /^\[(?:FOLLOW-UP\s+[1-3]|BRANCH-OVERVIEW:)/i;
const FOLLOW_UP_PREFIX_RE = /^\[FOLLOW-UP\s+[1-3]/i;
const METADATA_LINE_RE = /^\[(?:TITLE|BRANCH-OVERVIEW):/i;

interface FollowUpSentinel {
  index: number;
  followUp: string;
  start: number;
  /** Ended by its `]` (in lastFollowUpLineGroup, also by its line's end). */
  closed: boolean;
}

/**
 * The `[FOLLOW-UP n/3: …]` sentinels on one line. Each runs to the last `]`
 * before the next one or the end of the line, so a question may itself contain
 * brackets (`app/[slug]`, `[TITLE:]`). A start in `quoted` (inline code) is prose.
 * A line that is a single follow-up may have lost its closing `]`.
 */
export function parseFollowUpSentinelLine(
  line: string,
  quoted: ReadonlySet<number> = inlineCodeBrackets(line),
  offset = 0,
): FollowUpSentinel[] {
  const starts = [...line.matchAll(FOLLOW_UP_START_RE_G)].filter((match) => !quoted.has(offset + (match.index ?? -1)));
  return starts.flatMap((match, i) => {
    const start = match.index ?? 0;
    const segment = line.slice(start, starts[i + 1]?.index ?? line.length).trimEnd();
    const closed = segment.endsWith(']');
    if (!closed && (starts.length > 1 || line.slice(0, start).trim())) return [];
    const followUp = segment.slice(match[0].length, closed ? -1 : undefined).trim();
    return followUp ? [{ index: Number(match[1]) - 1, followUp, start: offset + start, closed }] : [];
  });
}

/**
 * The last group of follow-up lines outside fenced code. Blank lines and the
 * other metadata lines may sit between the lines of one group.
 */
function lastFollowUpLineGroup(raw: string): FollowUpSentinel[] {
  const quoted = inlineCodeBrackets(raw);
  let group: FollowUpSentinel[] = [];
  let last = group;
  let open = false;
  let fence = false;
  let offset = 0;
  for (const line of raw.split('\n')) {
    const lineOffset = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (/^(?:```|~~~)/.test(trimmed)) { fence = !fence; open = false; continue; }
    if (fence) continue;
    const items = parseFollowUpSentinelLine(line, quoted, lineOffset);
    if (items.length > 0) {
      if (!open) group = [];
      const ended = offset <= raw.length;
      group.push(...items.map((item) => ({ ...item, closed: item.closed || ended })));
      last = group;
      open = true;
    } else if (trimmed && !METADATA_LINE_RE.test(trimmed)) {
      open = false;
    }
  }
  return last;
}

function lineFollowUpsMatch(raw: string): { followUps: string[]; cutStart: number } | null {
  const last = lastFollowUpLineGroup(raw);
  const slots: string[] = [];
  for (const item of last) slots[item.index] = item.followUp;
  const followUps = slots.filter(Boolean).slice(0, 3);
  return followUps.length > 0 ? { followUps, cutStart: last[0].start } : null;
}

function followUpsMatch(raw: string): { followUps: string[]; cutStart: number } | null {
  const byLine = lineFollowUpsMatch(raw);
  if (byLine) return byLine;
  // Sentinels that lost their closing `]`.
  INLINE_FOLLOW_UP_RE.lastIndex = 0;
  const items = [...raw.matchAll(INLINE_FOLLOW_UP_RE)].flatMap((match) => {
    if (match.index === undefined) return [];
    const index = Number(match[1]) - 1;
    const followUp = match[2].trim();
    if (!Number.isInteger(index) || index < 0 || index > 2 || !followUp) return [];
    return [{ index, followUp, start: match.index, end: match.index + match[0].length }];
  });
  if (items.length > 0) {
    const tail = [items[items.length - 1]];
    for (let index = items.length - 2; index >= 0; index -= 1) {
      const previous = items[index];
      if (!/^\s*$/.test(raw.slice(previous.end, tail[0].start))) break;
      tail.unshift(previous);
    }
    const slots: string[] = [];
    for (const item of tail) slots[item.index] = item.followUp;
    const followUps = slots.filter(Boolean).slice(0, 3);
    if (followUps.length > 0) return { followUps, cutStart: tail[0].start };
  }

  INLINE_FOLLOW_UPS_RE.lastIndex = 0;
  const blocks = [...raw.matchAll(INLINE_FOLLOW_UPS_RE)];
  const block = blocks[blocks.length - 1];
  if (block?.index !== undefined) {
    const followUps = block[1].split('|').map((value: string) => value.trim()).filter(Boolean).slice(0, 3);
    if (followUps.length > 0) return { followUps, cutStart: block.index };
  }

  const prose = raw.match(PROSE_FOLLOW_UP_RE);
  if (prose?.index !== undefined) {
    const tail = raw.slice(prose.index + prose[0].length);
    const followUps = tail
      .split('\n')
      .map((line) => line
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
        .replace(/^[\s>*_`#]+/, '')
        .replace(/[\s*_`]+$/, '')
        .trim())
      .filter((line) => line.length > 0 && /[?？]/.test(line))
      .slice(0, 3);
    return { followUps, cutStart: prose.index };
  }
  return null;
}

/**
 * The branch overview an answer ends with: the last one-line marker outside
 * inline code that has text. The preamble asks for it on the very last line,
 * and an answer may quote the format earlier.
 */
export function extractBranchOverview(raw: string): string | null {
  const overviews = unquotedMatches(raw, INLINE_BRANCH_OVERVIEW_RE_G)
    .map((match) => match[1].trim())
    .filter(Boolean);
  return overviews[overviews.length - 1] ?? null;
}

/** Parse the text fallback used by runtimes that cannot emit metadata events. */
export function extractTurnMetadata(raw: string): ExtractedTurnMetadata {
  const title = titleMatch(raw)?.title;
  const branchOverview = extractBranchOverview(raw);
  const followUps = followUpsMatch(raw)?.followUps;
  return {
    ...(title ? { title } : {}),
    ...(followUps && followUps.length > 0 ? { followUps } : {}),
    ...(branchOverview ? { branchOverview } : {}),
  };
}

/** Produce the terminal visible assistant content used by persistence/fingerprints. */
export function finalizeTurnContent(raw: string): string {
  raw = extractKiroSteering(raw).text;
  const title = titleMatch(raw);
  let withoutTitle = raw;
  if (title) {
    let end = title.end;
    while (end < raw.length && raw[end] === '\n') end += 1;
    withoutTitle = raw.slice(0, title.start) + raw.slice(end);
  }
  const followUps = followUpsMatch(withoutTitle);
  const answer = followUps ? withoutTitle.slice(0, followUps.cutStart) : withoutTitle;
  const visible = stripTurnMetadataSentinels(answer);
  const quoted = inlineCodeBrackets(visible);
  return visible
    .replace(INLINE_BRANCH_OVERVIEW_RE_G, (match: string, _overview: string, offset: number) => (quoted.has(offset) ? match : ''))
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();
}

/**
 * A turn left something to read: finalized content (finalizeTurnContent), or a
 * tool call, image or question. A turn that only thought, or left only its
 * title, follow-ups or branch overview, did not. It decides whether a turn
 * counts toward a node's completion facts, on the server and in a window.
 */
export function turnLeftAnswer(content: string, blocks: readonly { kind: string }[]): boolean {
  if (content.trim()) return true;
  return blocks.some((block) => block.kind === 'tool' || block.kind === 'image' || block.kind === 'user-input');
}

function couldStillBeSentinel(value: string): boolean {
  const upper = value.toUpperCase();
  return SENTINEL_PREFIXES.some((prefix) =>
    upper.length <= prefix.length ? prefix.startsWith(upper) : upper.startsWith(prefix),
  );
}

/** Offsets of `[` inside a Markdown inline code span; a span ends with its line. */
function inlineCodeBrackets(raw: string): Set<number> {
  const offsets = new Set<number>();
  if (!raw.includes('`')) return offsets;
  let openRun = 0;
  for (let index = 0; index < raw.length;) {
    const ch = raw[index];
    if (ch === '`') {
      let end = index;
      while (raw[end] === '`') end += 1;
      const run = end - index;
      if (openRun === 0) openRun = run;
      else if (run === openRun) openRun = 0;
      index = end;
      continue;
    }
    if (ch === '\n' || ch === '\r') openRun = 0;
    else if (ch === '[' && openRun > 0) offsets.add(index);
    index += 1;
  }
  return offsets;
}

/**
 * Index in `text` of the first unquoted follow-up start, or -1. Other
 * prefixes do not end a line sentinel: questions quote `[TITLE:]`.
 */
function nextFollowUpStart(text: string, quoted: ReadonlySet<number>, offset: number): number {
  for (const match of text.matchAll(FOLLOW_UP_START_RE_G)) {
    if (!quoted.has(offset + (match.index ?? -1))) return match.index ?? -1;
  }
  return -1;
}

/** Whether the line `pos` is on has text before it, other than blanks and `cuts`. */
function lineHasTextBefore(raw: string, cuts: ReadonlyArray<{ start: number; end: number }>, pos: number): boolean {
  let index = Math.max(raw.lastIndexOf('\n', pos - 1), raw.lastIndexOf('\r', pos - 1)) + 1;
  for (const cut of cuts) {
    if (cut.end <= index) continue;
    if (/\S/.test(raw.slice(index, Math.max(index, cut.start)))) return true;
    index = cut.end;
  }
  return /\S/.test(raw.slice(index, pos));
}

/**
 * A follow-up with text before it on its line: `after` is the rest of it after
 * its first `]`, up to the next follow-up or its line's end at `lineEnd` (-1:
 * not yet). It is prose unless it ends with `]` and opens the answer's
 * follow-up lines, as when Kiro writes the first one after the answer's last
 * sentence: the next line that is not blank starts with a sentinel.
 */
function midLineFollowUp(raw: string, after: string, lineEnd: number): 'pending' | 'sentinel' | 'prose' {
  if (after.trim() && !after.trimEnd().endsWith(']')) return 'prose';
  if (lineEnd < 0) return 'pending';
  let start = lineEnd;
  while (start < raw.length && /\s/.test(raw[start])) start += 1;
  if (start === raw.length) return 'pending';
  const nextLineEnd = raw.slice(start).search(/[\n\r]/);
  const head = raw.slice(start, nextLineEnd < 0 ? raw.length : start + nextLineEnd);
  if (LINE_SENTINEL_PREFIX_RE.test(head) || METADATA_LINE_RE.test(head)) return 'sentinel';
  return nextLineEnd < 0 && couldStillBeSentinel(head) ? 'pending' : 'prose';
}

export interface TurnMetadataSentinelScan {
  /** Completed sentinels, each with the whitespace that follows it. */
  cuts: Array<{ start: number; end: number }>;
  /** Start of a trailing candidate still waiting for its `]` (a follow-up or overview: its line's end; one after text: the next line), or -1. */
  pendingStart: number;
}

/**
 * Locate Michi metadata sentinels in raw answer text. A sentinel is one line
 * of prose, so a prefix quoted in inline code (`[BRANCH-OVERVIEW:`) or one
 * whose line ends before a `]` is ordinary text. A follow-up or overview ends at
 * the last `]` of its line. A follow-up with text before it on its line is
 * prose (midLineFollowUp). Undecided text stays held, so appending text never
 * hides what was already visible.
 */
export function scanTurnMetadataSentinels(raw: string): TurnMetadataSentinelScan {
  const cuts: Array<{ start: number; end: number }> = [];
  const quoted = inlineCodeBrackets(raw);
  let cursor = 0;
  let holdStart = -1;
  while (cursor < raw.length) {
    const ch = raw[cursor];
    if (holdStart < 0) {
      if (ch === '[' && !quoted.has(cursor)) holdStart = cursor;
      cursor += 1;
      continue;
    }
    const candidate = raw.slice(holdStart, cursor + 1);
    if (ch === ']' && LINE_SENTINEL_PREFIX_RE.test(candidate)) {
      // Wait for the line to end (or the next follow-up), then cut to its last
      // `]`, so brackets inside a question or overview stay hidden with it.
      const lineEnd = raw.slice(cursor).search(/[\n\r]/);
      const rest = raw.slice(cursor + 1, lineEnd < 0 ? raw.length : cursor + lineEnd);
      const next = nextFollowUpStart(rest, quoted, cursor + 1);
      if (lineEnd < 0 && next < 0) break;
      const after = rest.slice(0, next < 0 ? rest.length : next);
      if (FOLLOW_UP_PREFIX_RE.test(candidate) && lineHasTextBefore(raw, cuts, holdStart)) {
        const midLine = midLineFollowUp(raw, after, lineEnd < 0 ? -1 : cursor + lineEnd);
        if (midLine === 'pending') break;
        if (midLine === 'prose') {
          cursor += 1;
          holdStart = -1;
          continue;
        }
      }
      let end = cursor + 1 + after.lastIndexOf(']') + 1;
      while (end < raw.length && /\s/.test(raw[end])) end += 1;
      cuts.push({ start: holdStart, end });
      cursor = end;
      holdStart = -1;
      continue;
    }
    if (ch === ']') {
      const upper = candidate.toUpperCase();
      if (SENTINEL_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
        let end = cursor + 1;
        while (end < raw.length && /\s/.test(raw[end])) end += 1;
        cuts.push({ start: holdStart, end });
        cursor = end;
      } else {
        cursor += 1;
      }
      holdStart = -1;
      continue;
    }
    if (ch === '\n' || ch === '\r' || !couldStillBeSentinel(candidate)) holdStart = -1;
    cursor += 1;
  }
  return { cuts, pendingStart: holdStart };
}

/** Strip completed or partial Michi metadata sentinels from visible content. */
export function stripTurnMetadataSentinels(raw: string): string {
  const { cuts, pendingStart } = scanTurnMetadataSentinels(raw);
  if (pendingStart >= 0) cuts.push({ start: pendingStart, end: raw.length });

  let visible = '';
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) visible += raw.slice(cursor, cut.start);
    cursor = cut.end;
  }
  if (cursor < raw.length) visible += raw.slice(cursor);
  return visible;
}

export function createDurableTurn(input: CreateDurableTurnInput): DurableTurnSnapshot {
  return {
    version: 1,
    turnId: input.turnId,
    nodeId: input.nodeId,
    workspaceId: input.workspaceId,
    assistantId: input.assistantId,
    userMessage: input.selfInitiated && !input.keepUserMessage
      ? null
      : {
          id: userMessageIdFor(input.assistantId),
          role: 'user',
          content: input.displayUserText,
          blocks: [],
          toolCalls: [],
          metadata: input.userMetadata,
          createdAt: input.startedAt,
        },
    assistantMessage: {
      id: input.assistantId,
      role: 'assistant',
      content: '',
      blocks: [],
      toolCalls: [],
      createdAt: input.startedAt,
    },
    nodeMetadata: {},
    status: 'active',
    lastAppliedSeq: -1,
    startedAt: input.startedAt,
  };
}

function nextBlockId(snapshot: DurableTurnSnapshot, blocks: DurableAssistantBlock[]): string {
  return `${snapshot.assistantId}-b-${blocks.length}`;
}

function currentSection(blocks: DurableAssistantBlock[]): 'answer' | 'thinking' {
  // Tool blocks do not start a new semantic section. Consecutive tools must
  // inherit the section established by the preceding text/tool block, or the
  // second tool after a thought would incorrectly jump back to the answer.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind === 'answer' || block.kind === 'thinking') return block.kind;
    if (block.kind === 'tool' || block.kind === 'user-input') return block.section;
  }
  return 'answer';
}

function currentRunLength(blocks: DurableAssistantBlock[], section: 'answer' | 'thinking'): number {
  let total = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (section === 'answer') {
      if (block.kind === 'thinking') break;
      if (block.kind === 'answer') total += block.rawText.length;
    } else {
      if (block.kind === 'answer') break;
      if (block.kind === 'thinking') total += block.rawText.length;
    }
  }
  return total;
}

function closeTrailingTextBlock(blocks: DurableAssistantBlock[], observedAt?: number): void {
  const index = blocks.length - 1;
  const last = blocks[index];
  if ((last?.kind === 'answer' || last?.kind === 'thinking') && last.streaming !== false) {
    blocks[index] = {
      ...last,
      streaming: false,
      ...(last.endedAt === undefined && observedAt !== undefined ? { endedAt: observedAt } : {}),
    };
  }
}

function appendText(
  snapshot: DurableTurnSnapshot,
  kind: 'answer' | 'thinking',
  text: string,
  observedAt?: number,
): DurableAssistantBlock[] {
  const blocks = snapshot.assistantMessage.blocks.slice();
  const last = blocks[blocks.length - 1];
  if (last?.kind === kind) {
    blocks[blocks.length - 1] = { ...last, rawText: last.rawText + text, streaming: true };
  } else {
    closeTrailingTextBlock(blocks, observedAt);
    blocks.push({
      id: nextBlockId(snapshot, blocks),
      kind,
      rawText: text,
      streaming: true,
      ...(observedAt !== undefined ? { startedAt: observedAt } : {}),
    });
  }
  return blocks;
}

function mergeTool(previous: DurableToolCall | undefined, update: ToolCallStreamPayload, observedAt?: number): DurableToolCall {
  const merged: DurableToolCall = previous
    ? { ...previous }
    : { id: update.toolCallId, title: '', status: '', ...(observedAt !== undefined ? { startedAt: observedAt } : {}) };
  if (update.title) merged.title = update.title;
  if (update.status) merged.status = update.status;
  if (update.kind) merged.kind = update.kind;
  if (update.detail) merged.detail = update.detail;
  if (update.inputJson) merged.inputJson = update.inputJson;
  if (update.output) {
    merged.output = update.output;
    // Output arriving means the tool has finished — infer completed if status
    // was never explicitly set to a terminal value by the runtime.
    if (isActiveToolStatus(merged.status)) merged.status = 'completed';
  }
  // Stamp completion once, on the first transition into a terminal status.
  if (merged.endedAt === undefined && observedAt !== undefined && !isActiveToolStatus(merged.status)) merged.endedAt = observedAt;
  return merged;
}

function applyTool(snapshot: DurableTurnSnapshot, update: ToolCallStreamPayload, observedAt?: number): DurableMessage {
  const message = snapshot.assistantMessage;
  const existingIndex = message.toolCalls.findIndex((tool) => tool.id === update.toolCallId);
  const toolCalls = message.toolCalls.slice();
  const existing = existingIndex >= 0 ? toolCalls[existingIndex] : undefined;
  const merged = mergeTool(existing, update, observedAt);
  const blocks = message.blocks.slice();
  if (existingIndex >= 0) {
    toolCalls[existingIndex] = merged;
  } else {
    const section = currentSection(blocks);
    merged.textOffset = currentRunLength(blocks, section);
    toolCalls.push(merged);
    closeTrailingTextBlock(blocks, observedAt);
    blocks.push({
      id: nextBlockId(snapshot, blocks),
      kind: 'tool',
      toolCallId: merged.id,
      section,
      rawOffset: merged.textOffset,
    });
  }
  return { ...message, toolCalls, blocks };
}

function finalizeMessage(message: DurableMessage, interrupted = false, completedAt?: number): DurableMessage {
  // A turn that ended via cancel/error must not stamp its still-active tools
  // as 'completed' — they may never have executed (a tool_call is emitted
  // when the tool_use block appears, before execution). 'interrupted' is a
  // terminal, non-success status so consumers (e.g. diff receipts) can tell
  // "finished" apart from "was cut off mid-flight".
  const finalStatus = interrupted ? 'interrupted' : 'completed';
  const subagents = finalizeSubagentRoster(message.subagents, interrupted);
  return {
    ...message,
    blocks: message.blocks.map((block) =>
      block.kind === 'answer' || block.kind === 'thinking'
        ? {
            ...block,
            streaming: false,
            // Only the still-open block ends with the turn; blocks closed
            // earlier keep (or, for legacy frames, lack) their own endedAt.
            ...(block.streaming !== false && block.endedAt === undefined && completedAt !== undefined
              ? { endedAt: completedAt } : {}),
          }
        : block.kind === 'user-input' && block.interaction?.status === 'pending'
          ? { ...block, interaction: { ...block.interaction, status: 'interrupted' as const } }
          : block,
    ),
    toolCalls: message.toolCalls.map((tool) => {
      const active = isActiveToolStatus(tool.status);
      return active ? { ...tool, status: finalStatus, ...(tool.endedAt !== undefined || completedAt !== undefined ? { endedAt: tool.endedAt ?? completedAt } : {}) } : tool;
    }),
    ...(subagents ? { subagents } : {}),
  };
}

export function isActiveToolStatus(status: string | undefined): boolean {
  return !status || status === 'running' || status === 'pending' || status === 'in_progress';
}

function answerContent(blocks: DurableAssistantBlock[]): string {
  return stripTurnMetadataSentinels(
    blocks.map((block) => block.kind === 'answer' ? block.rawText : '').join(''),
  );
}

function rawAnswerContent(blocks: DurableAssistantBlock[]): string {
  return blocks.map((block) => block.kind === 'answer' ? block.rawText : '').join('');
}

/** Derive the partial visible answer only at a persistence checkpoint. */
export function checkpointTurnContent(snapshot: DurableTurnSnapshot): string {
  return snapshot.status === 'active'
    ? answerContent(snapshot.assistantMessage.blocks)
    : snapshot.assistantMessage.content;
}

export function applyTurnEvent(
  snapshot: DurableTurnSnapshot,
  streamEvent: ChatStreamEvent,
): DurableTurnSnapshot {
  const seq = streamEvent.data.seq;
  if (typeof seq === 'number' && seq <= snapshot.lastAppliedSeq) return snapshot;

  let next: DurableTurnSnapshot = {
    ...snapshot,
    lastAppliedSeq: typeof seq === 'number' ? seq : snapshot.lastAppliedSeq,
  };
  switch (streamEvent.event) {
    case 'steer_accepted': {
      const message = steeredUserMessage({ ...streamEvent.data, assistantId: snapshot.assistantId });
      if (message && !next.steeredMessages?.some((existing) => existing.id === message.id)) {
        next = { ...next, steeredMessages: [...(next.steeredMessages ?? []), message] };
      }
      break;
    }
    case 'chunk': {
      const blocks = appendText(next, 'answer', streamEvent.data.text, streamEvent.data.observedAt);
      next = {
        ...next,
        assistantMessage: { ...next.assistantMessage, blocks },
      };
      break;
    }
    case 'thought': {
      const blocks = appendText(next, 'thinking', streamEvent.data.text, streamEvent.data.observedAt);
      next = { ...next, assistantMessage: { ...next.assistantMessage, blocks } };
      break;
    }
    case 'steering_report': {
      const message = next.assistantMessage;
      next = { ...next, assistantMessage: { ...message, metadata: {
        ...message.metadata,
        steeringReports: mergeSteeringReports(message.metadata?.steeringReports, streamEvent.data.reports),
      } } };
      break;
    }
    case 'plan':
      next = {
        ...next,
        assistantMessage: { ...next.assistantMessage, plan: streamEvent.data.entries.map((entry) => ({ ...entry })) },
      };
      break;
    case 'tool_call':
    case 'tool_call_update':
      next = { ...next, assistantMessage: applyTool(next, streamEvent.data, streamEvent.data.observedAt) };
      break;
    case 'user_input_request': {
      const data = streamEvent.data;
      const interactionId = data.interactionId ?? userInputInteractionId(next.turnId, data.requestId);
      if (next.assistantMessage.blocks.some(block => block.kind === 'user-input' && block.interaction?.interactionId === interactionId)) break;
      const blocks = next.assistantMessage.blocks.slice();
      const rawOffset = currentRunLength(blocks, 'answer');
      closeTrailingTextBlock(blocks, data.observedAt);
      blocks.push({ id: nextBlockId(next, blocks), kind: 'user-input', requestId: data.requestId, section: 'answer', rawOffset,
        interaction: { interactionId, requestId: data.requestId, questions: normalizeUserInputQuestions(interactionId, data.questions), answers: [], status: 'pending' } });
      next = { ...next, assistantMessage: { ...next.assistantMessage, blocks } };
      break;
    }
    case 'user_input_resolved': {
      const data = streamEvent.data;
      const interactionId = data.interactionId ?? userInputInteractionId(next.turnId, data.requestId);
      const blocks = next.assistantMessage.blocks.map(block => {
        if (block.kind !== 'user-input' || block.interaction?.interactionId !== interactionId) return block;
        // A duplicate empty confirmation must not erase a submitted answer.
        if (block.interaction.status === 'answered' && !data.answers.length) return block;
        return { ...block, interaction: { ...block.interaction,
          answers: normalizeUserInputAnswers(block.interaction.questions, data.answers),
          status: data.outcome ?? (data.answers.length ? 'answered' as const : 'skipped' as const) } };
      });
      next = { ...next, assistantMessage: { ...next.assistantMessage, blocks } };
      break;
    }
    case 'usage_summary':
      next = { ...next, assistantMessage: { ...next.assistantMessage, metadata: { ...next.assistantMessage.metadata, usageSummary: streamEvent.data } } };
      break;
    case 'warning':
      next = { ...next, assistantMessage: { ...next.assistantMessage, metadata: { ...next.assistantMessage.metadata, warnings: [...(next.assistantMessage.metadata?.warnings ?? []), streamEvent.data] } } };
      break;
    case 'subagent_list_update': {
      if (streamEvent.data.subagents.length === 0) break;
      const message = next.assistantMessage;
      next = { ...next, assistantMessage: {
        ...message,
        subagents: mergeSubagentRoster(message.subagents, streamEvent.data.subagents),
      } };
      break;
    }
    case 'subagent_tool_activity': {
      const message = next.assistantMessage;
      const subagents = applySubagentActivity(message.subagents, streamEvent.data);
      if (subagents && subagents !== message.subagents) next = { ...next, assistantMessage: { ...message, subagents } };
      break;
    }
    case 'image': {
      const blocks = next.assistantMessage.blocks.slice();
      closeTrailingTextBlock(blocks, streamEvent.data.observedAt);
      blocks.push({
        id: nextBlockId(next, blocks),
        kind: 'image',
        workspaceId: next.workspaceId,
        path: streamEvent.data.path,
        caption: streamEvent.data.caption,
        mimeType: streamEvent.data.mimeType,
        size: streamEvent.data.size,
      });
      next = { ...next, assistantMessage: { ...next.assistantMessage, blocks } };
      break;
    }
    case 'title':
      if (streamEvent.data.title.trim()) {
        next = { ...next, nodeMetadata: { ...next.nodeMetadata, title: streamEvent.data.title.trim() } };
      }
      break;
    case 'follow_ups':
      next = {
        ...next,
        nodeMetadata: {
          ...next.nodeMetadata,
          followUps: streamEvent.data.followUps.map((value) => value.trim()).filter(Boolean).slice(0, 3),
        },
      };
      break;
    case 'branch_overview':
      if (streamEvent.data.overview.trim()) {
        next = {
          ...next,
          nodeMetadata: { ...next.nodeMetadata, branchOverview: streamEvent.data.overview.trim() },
        };
      }
      break;
    case 'done': {
      const stopReason = streamEvent.data.stopReason;
      const status = stopReason === 'cancel' || stopReason === 'cancelled'
        ? 'cancelled'
        : stopReason === 'error'
          ? 'error'
          : 'completed';
      const assistantMessage = finalizeMessage(next.assistantMessage, status !== 'completed', streamEvent.data.completedAt ?? streamEvent.data.observedAt);
      const rawAnswer = rawAnswerContent(assistantMessage.blocks);
      next = {
        ...next,
        status,
        stopReason,
        completedAt: streamEvent.data.completedAt,
        nodeMetadata: { ...extractTurnMetadata(rawAnswer), ...next.nodeMetadata },
        assistantMessage: { ...assistantMessage, content: finalizeTurnContent(rawAnswer) },
      };
      break;
    }
    case 'error': {
      const assistantMessage = finalizeMessage(next.assistantMessage, true, streamEvent.data.completedAt ?? streamEvent.data.observedAt);
      const rawAnswer = rawAnswerContent(assistantMessage.blocks);
      next = {
        ...next,
        status: 'error',
        error: streamEvent.data.message,
        completedAt: streamEvent.data.completedAt,
        nodeMetadata: { ...extractTurnMetadata(rawAnswer), ...next.nodeMetadata },
        assistantMessage: { ...assistantMessage, content: finalizeTurnContent(rawAnswer) },
      };
      break;
    }
    default:
      break;
  }
  return next;
}
