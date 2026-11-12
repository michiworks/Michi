import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import {
  MEMORY_KEYWORDS_MAX_COUNT, MEMORY_KEYWORD_MAX_CHARS, MEMORY_KINDS, MEMORY_TOPIC_MAX_CHARS,
  type MemoryKind, type MemoryRecord, type MemoryScope, type MemorySourceRisk,
} from 'michi-shared';
import { log } from '../logger';
import { holdsWorkspaceMemories } from './assistantConversation';
import { buildExtractionInstructions } from './extractionPolicy';
import { MEMORY_EXTRACTION_TOOL_NAMES } from './extractionProfile';
import { extractionIdempotencyKey, getCommittedProposal, insertCommittedProposal, memoryBodyHash, tombstoneBlocks } from './extractionRepository';
import {
  activeMemoriesFromTurn, activeMemoryBodies, memoryTransaction, michiNotesFromConversation, storedMemoryByRowId, topicsInUse, workspaceAccessible,
  type StoredMemory,
} from './memoryRepository';
import { memoryDay, memoryRef, parseRef } from './memoryRefs';
import { createMemory, forgetMemory, getMemorySettings, MemoryError } from './memoryService';
import { normalizeText, profileKeywords, segmentTerms } from './memoryTerms';
import { recallSearch, setTurnKeys } from './recallIndex';
import { containsCredential } from './secrets';
import { typedTextBacks } from './typedText';

/**
 * Automatic memory extraction v2 (spec §4): one model answer per batch, the
 * new turns of one conversation. The seam is shared by production and
 * evaluations:
 *
 *  - buildExtractionPrompt: the system instructions (extractionPolicy.ts)
 *    and a prompt that carries the turns inline (what the user wrote,
 *    unmasked, the end of the assistant message the first of them answered,
 *    each reply's start and end, sent times, the conversation's title) with
 *    up to RELATED_MAX existing memories as refs an update or a forget may
 *    name: the notes Michi took on its own from the conversation's earlier
 *    turns (so marked), then what recall finds.
 *  - EXTRACTION_PAYLOAD_SCHEMA / validateExtractionPayload: the answer, a
 *    direct model call's JSON (extractionDirect.ts) or the arguments of the
 *    one memory_extract call (extractionTools.ts).
 *  - commitExtractionPayload: saves it as active memories. Production calls
 *    it while an execution settles, inside the transaction that moves the
 *    conversation's position (extractionRun.ts); an evaluation calls it
 *    directly.
 *
 * Commit rules: every memory quotes words the user wrote in its source turn,
 * or it is dropped (tool output, web pages, files and the assistant's words
 * never make a memory on their own). about 'user' goes to the user scope,
 * 'project' to the source workspace (the user scope too for V's: the
 * assistant's workspace is no memory scope). explicit marks a request to remember
 * that the agent missed: the memory is the user's own (origin explicit). An
 * update supersedes its target (a listed, active memory of the user scope or
 * the workspace, unchanged since the prompt) and never narrows its scope; a
 * memory the user saved (origin explicit) is superseded only by an update
 * marked explicit (the user corrected it themself), otherwise the update is
 * added beside it; an update marked explicit makes an automatic memory the
 * user's own even with its text unchanged. exclude_turns names the turns of
 * the batch whose content the user declined or took back: nothing is
 * extracted from them (no memory and no keyphrases), what Michi noted on its
 * own from them is forgotten, and the conversation is left as it is. forget
 * names listed notes of Michi's that these turns decline or take back when
 * what they say came before them (earlier in the conversation, or in another
 * one), as Mem0's DELETE: they are forgotten. A memory going to the user
 * scope is barred by a removal of its body in any workspace. The
 * kind is the model's, and every memory's keywords carry the words of the
 * profile categories it states (memoryTerms.profileKeywords). Bodies already
 * stored (normalized hash) or restated by a memory saved from the same turn,
 * bodies or turns a removal barred (tombstones), credentials (secrets.ts), and
 * proposals a run already committed are dropped.
 */

// ── the payload ──────────────────────────────────────────────────────────────

/** A memory body, a quote and a keyword at most (characters). */
const BODY_MAX = 300;
const QUOTE_MAX = 500;
const TURN_ID_MAX = 200;
/** Memories and turn keyphrase entries one answer carries at most. */
const MEMORIES_MAX = 40;
const TURN_KEYS_MAX = 24;
/** Refs one answer forgets at most (a listed memory's ref: m:…). */
const FORGET_MAX = 16;
const REF_MAX = 64;
/** Keywords per memory and keyphrases per turn at most (the prompt asks for 3-10 and 5-15). */
const KEYWORDS_MAX = 16;
const KEYS_MAX = 20;

function string(maxLength: number): Record<string, unknown> {
  return { type: 'string', minLength: 1, maxLength };
}

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The answer, strict: every object closed (additionalProperties false),
 * every field typed and bounded. The same schema validates a memory_extract
 * call (extractionTools.ts) and an evaluation's structured output.
 */
export const EXTRACTION_PAYLOAD_SCHEMA: Readonly<Record<string, unknown>> = frozen({
  type: 'object',
  additionalProperties: false,
  required: ['memories', 'turn_keys'],
  properties: {
    memories: {
      type: 'array',
      maxItems: MEMORIES_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'kind', 'about', 'body', 'keywords', 'quote', 'source_turn'],
        properties: {
          op: { type: 'string', enum: ['add', 'update'] },
          // Optional fields may also be null (strict function calling sends every field).
          target: { type: ['string', 'null'], maxLength: REF_MAX },
          kind: { type: 'string', enum: [...MEMORY_KINDS] },
          about: { type: 'string', enum: ['user', 'project'] },
          body: string(BODY_MAX),
          keywords: { type: 'array', minItems: 1, maxItems: KEYWORDS_MAX, items: string(MEMORY_KEYWORD_MAX_CHARS) },
          topic: { type: ['string', 'null'], maxLength: MEMORY_TOPIC_MAX_CHARS },
          event_date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          quote: string(QUOTE_MAX),
          source_turn: string(TURN_ID_MAX),
          explicit: { type: ['boolean', 'null'] },
        },
      },
    },
    turn_keys: {
      type: 'array',
      maxItems: TURN_KEYS_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source_turn', 'keys'],
        properties: {
          source_turn: string(TURN_ID_MAX),
          keys: { type: 'array', maxItems: KEYS_MAX, items: string(MEMORY_KEYWORD_MAX_CHARS) },
        },
      },
    },
    exclude_turns: { type: 'array', maxItems: TURN_KEYS_MAX, items: string(TURN_ID_MAX) },
    forget: { type: 'array', maxItems: FORGET_MAX, items: string(REF_MAX) },
  },
});

export type ExtractionOp = 'add' | 'update';
export type ExtractionAbout = 'user' | 'project';

/** One memory of a validated payload: trimmed, keywords distinct, target only on an update. */
export interface ExtractionPayloadMemory {
  op: ExtractionOp;
  /** An update's target: a ref the prompt listed (m:…). */
  target?: string;
  kind: MemoryKind;
  about: ExtractionAbout;
  body: string;
  keywords: string[];
  /** What it is about, in a few words (MemoryRecord.topic). */
  topic?: string;
  /** A real calendar day, YYYY-MM-DD. */
  event_date?: string;
  /** The user's own words it comes from. */
  quote: string;
  source_turn: string;
  /** The user asked to remember it (a request the agent missed): it is saved as theirs. */
  explicit?: true;
}

export interface ExtractionTurnKeys {
  source_turn: string;
  keys: string[];
}

/** What validateExtractionPayload returns: the payload's own shape (EXTRACTION_PAYLOAD_SCHEMA), normalized. */
export interface ExtractionPayload {
  memories: ExtractionPayloadMemory[];
  /** One entry per turn (entries for the same turn merged). */
  turn_keys: ExtractionTurnKeys[];
  /** Turns whose content the user declined or took back, each once: nothing is extracted from them. */
  exclude_turns: string[];
  /**
   * Refs of listed memories Michi noted on its own whose content these turns decline or take back (also what came
   * before them, in the conversation or another one), each once: they are deleted.
   */
  forget: string[];
}

/** A payload that does not match EXTRACTION_PAYLOAD_SCHEMA; problems name each field (memories[0].kind …). */
export class ExtractionPayloadError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'ExtractionPayloadError';
  }
}

let payloadCheck: ((value: unknown) => { valid: boolean; errorMessage?: string }) | null = null;

const ALLOWED: Record<string, string> = {
  op: 'add or update',
  kind: MEMORY_KINDS.join(', '),
  about: 'user or project',
};

/** Ajv's "data/memories/0/kind must be equal to one of the allowed values" as "memories[0].kind must be … (preference, …)". */
function schemaProblems(errorMessage: string | undefined): string[] {
  const parts = (errorMessage || 'the arguments do not match the schema').split(/,\s+(?=data\b)/u);
  return parts.map((part) => {
    const named = part.replace(/^data((?:\/[^\s/]+)*)/u, (_match, path: string) => {
      const segments = path.split('/').filter(Boolean).map((segment) => (/^\d+$/u.test(segment) ? `[${segment}]` : `.${segment}`));
      return segments.length ? segments.join('').replace(/^\./u, '') : 'the arguments';
    });
    const field = /(?:^|\.)(\w+)\s+must be equal to one of the allowed values/u.exec(named)?.[1];
    return field && ALLOWED[field] ? `${named} (${ALLOWED[field]})` : named;
  });
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Trimmed, one line each, distinct once folded (normalizeText), blanks dropped. */
function distinct(values: readonly string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = collapse(value);
    if (!item || item.length > MEMORY_KEYWORD_MAX_CHARS) continue;
    const identity = normalizeText(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function realDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

interface WireMemory {
  op: ExtractionOp; target?: string | null; kind: MemoryKind; about: ExtractionAbout; body: string; keywords: string[];
  topic?: string | null; event_date?: string | null; quote: string; source_turn: string; explicit?: boolean | null;
}

/** Fenced and inline code: it does not say which language the user writes. */
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/gu;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LATIN_WORD = /[A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z]/gu;

/**
 * The language a turn's user wrote in: 'zh' when CJK characters make at
 * least half of it (a Latin word weighing two characters; code left out),
 * 'en' when it has Latin words and no CJK at all, else null (code-switched).
 */
export function turnLanguage(text: string): 'zh' | 'en' | null {
  const plain = (text ?? '').replace(CODE, ' ').normalize('NFKC');
  const cjk = (plain.match(CJK_CHAR) ?? []).length;
  const latin = (plain.match(LATIN_WORD) ?? []).length;
  if (cjk === 0) return latin > 0 ? 'en' : null;
  return cjk / (cjk + 2 * latin) >= 0.5 ? 'zh' : null;
}

/**
 * The answer as the schema reads it: a memories, turn_keys, exclude_turns or
 * forget list left out (or null) is empty, since a model with nothing to save
 * may omit it rather than send [] (Kiro calls memory_extract with turn_keys
 * alone), and an MCP client's own metadata (_meta) is no part of it. A
 * hide_words list an older prompt asked for is dropped: nothing reads it.
 */
function withDefaults(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { _meta: _ignored, hide_words: _retired, ...answer } = value as Record<string, unknown>;
  return {
    ...answer, memories: answer.memories ?? [], turn_keys: answer.turn_keys ?? [], exclude_turns: answer.exclude_turns ?? [], forget: answer.forget ?? [],
  };
}

/**
 * Checks an answer against EXTRACTION_PAYLOAD_SCHEMA and normalizes it:
 * strings trimmed (a body on one line), keywords and keyphrases distinct,
 * target kept only on an update, event_date a real calendar day, explicit
 * only when true, turn_keys merged per turn, exclude_turns and forget each
 * once. A list left out reads as empty (withDefaults). Throws
 * ExtractionPayloadError listing every problem.
 */
export function validateExtractionPayload(value: unknown): ExtractionPayload {
  payloadCheck ??= new AjvJsonSchemaValidator().getValidator(EXTRACTION_PAYLOAD_SCHEMA as Record<string, unknown>);
  const answer = withDefaults(value);
  const checked = payloadCheck(answer);
  if (!checked.valid) throw new ExtractionPayloadError(schemaProblems(checked.errorMessage));
  const raw = answer as { memories: WireMemory[]; turn_keys: ExtractionTurnKeys[]; exclude_turns: string[]; forget: string[] };
  const problems: string[] = [];
  const memories = raw.memories.map((memory, index): ExtractionPayloadMemory => {
    const where = `memories[${index}]`;
    const body = collapse(memory.body);
    const quote = memory.quote.trim();
    const sourceTurn = memory.source_turn.trim();
    if (!body) problems.push(`${where}.body must not be blank`);
    if (!quote) problems.push(`${where}.quote must not be blank`);
    if (!sourceTurn) problems.push(`${where}.source_turn must not be blank`);
    const eventDate = typeof memory.event_date === 'string' ? memory.event_date : undefined;
    if (eventDate !== undefined && !realDate(eventDate)) problems.push(`${where}.event_date must be a real date (YYYY-MM-DD)`);
    const target = memory.op === 'update' ? memory.target?.trim() : undefined;
    const topic = typeof memory.topic === 'string' ? collapse(memory.topic) : '';
    return {
      op: memory.op,
      ...(target ? { target } : {}),
      kind: memory.kind,
      about: memory.about,
      body,
      keywords: distinct(memory.keywords, KEYWORDS_MAX),
      ...(topic ? { topic } : {}),
      ...(eventDate !== undefined ? { event_date: eventDate } : {}),
      quote,
      source_turn: sourceTurn,
      ...(memory.explicit === true ? { explicit: true as const } : {}),
    };
  });
  const keys = new Map<string, string[]>();
  raw.turn_keys.forEach((entry, index) => {
    const turn = entry.source_turn.trim();
    if (!turn) { problems.push(`turn_keys[${index}].source_turn must not be blank`); return; }
    keys.set(turn, [...(keys.get(turn) ?? []), ...entry.keys]);
  });
  if (problems.length) throw new ExtractionPayloadError(problems);
  return {
    memories,
    turn_keys: [...keys].map(([turn, list]) => ({ source_turn: turn, keys: distinct(list, KEYS_MAX) })),
    exclude_turns: [...new Set(raw.exclude_turns.map((turn) => turn.trim()).filter(Boolean))],
    forget: [...new Set(raw.forget.map((ref) => ref.trim()).filter(Boolean))],
  };
}

// ── the prompt ───────────────────────────────────────────────────────────────

/** One completed turn, as the prompt shows it and the commit checks quotes against it. */
export interface ExtractionTurnInput {
  turnId: string;
  /** The conversation (chat node) it belongs to: the memories' source. */
  nodeId?: string | null;
  /** The conversation's title. */
  title?: string | null;
  /** What the user wrote: the message, then any messages steered into the turn. Quotes must come from it. */
  userText: string;
  /**
   * When the user sent it (ms): the memories' observed time, the day relative dates count from, and the time a removal
   * of the same body at or after it bars them (extractionRepository.tombstoneBlocks).
   */
  userAt: number;
  /** When the turn completed (ms; default userAt). */
  completedAt?: number;
  /** Text the user selected and replied to (material, not their words). */
  quotedText?: string | null;
  /** The assistant's reply (the prompt shows its start and end, for context). */
  assistantText?: string | null;
  /** The assistant message the user answered (the prompt shows its end: what "yes, do that" accepts). */
  previousAssistantText?: string | null;
  /** The turn read web pages, files or tool output. */
  untrusted?: boolean;
  /** The turn whose reply the user answered read web pages, files or tool output. */
  previousUntrusted?: boolean;
}

/**
 * An existing memory the prompt lists: Michi's own notes from the conversation's earlier turns, then what recall finds
 * over the turns (unless the caller gives its own list).
 */
export interface ExtractionRelatedMemory {
  /** m:<row>v<version>: the version shown; an update naming it supersedes only that version. */
  ref: string;
  memoryId: string;
  kind: MemoryKind;
  about: ExtractionAbout;
  body: string;
  /** The user saved it (origin explicit): updated only by a correction. */
  savedByUser: boolean;
  /** When the user said it (ms). */
  observedAt: number;
  /** Michi noted it on its own from an earlier turn of the conversation the prompt reads. */
  thisConversation?: boolean;
  /** What it is about (MemoryRecord.topic), when it has one. */
  topic?: string | null;
}

export interface ExtractionPromptInput {
  /** The memory owner, as given (requestAgentOwnerOrNull: the local user on the desktop). */
  ownerUserId: string;
  /** The turns' workspace. */
  workspaceId: string;
  workspaceName?: string | null;
  turns: readonly ExtractionTurnInput[];
  /** Up to RELATED_MAX existing memories to list; absent: looked up (recallSearch over each turn's words). */
  related?: readonly ExtractionRelatedMemory[];
  /** The topics the owner's memories here use, most used first; absent: looked up (memoryRepository.topicsInUse). */
  topics?: readonly string[];
  /** Default Date.now(): today's date in the prompt. */
  now?: number;
  /** The extractor's tool; default memory_extract. null: a direct model call answered with the JSON payload. */
  toolName?: string | null;
}

export interface ExtractionPrompt {
  system: string;
  prompt: string;
  /** The memories the prompt lists: pass them to commitExtractionPayload as ctx.related. */
  related: ExtractionRelatedMemory[];
}

/** Existing memories the prompt lists at most, and topics in use. */
const RELATED_MAX = 8;
const TOPICS_MAX = 30;
/** What the prompt shows of each text: its start and its end. */
const USER_HEAD = 3_000;
const USER_TAIL = 1_000;
const REPLY_HEAD = 600;
const REPLY_TAIL = 300;
const BEFORE_HEAD = 300;
const BEFORE_TAIL = 700;
const QUOTED_CHARS = 600;
const TITLE_CHARS = 120;
/** A turn's words recall searches by. */
const RELATED_QUERY_CHARS = 2_000;
/** Room an excerpt marker takes, so an excerpt of an excerpt keeps it as it is. */
const MARKER_ROOM = 48;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The start and the end of a text (tail 0: the start only), with how much was left out. */
function excerptText(text: string, head: number, tail: number): string {
  const clean = text.trim();
  const chars = [...clean];
  if (chars.length <= head + tail + MARKER_ROOM) return clean;
  const omitted = chars.length - head - tail;
  const end = tail > 0 ? `\n${chars.slice(chars.length - tail).join('').trimStart()}` : '';
  return `${chars.slice(0, head).join('').trimEnd()}\n[… ${omitted} characters omitted …]${end}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The local day, time and weekday of a time (ms). */
function sentLabel(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return `${memoryDay(ms)} ${pad(date.getHours())}:${pad(date.getMinutes())} (${WEEKDAYS[date.getDay()]})`;
}

function titleOf(turn: ExtractionTurnInput): string {
  return turn.title?.trim() ? excerptText(turn.title, TITLE_CHARS, 0) : '';
}

/**
 * One turn as a JSON line. `follows`: the turn before it in the prompt is of
 * the same conversation, so the message this one answered is shown already
 * (its reply) and `before` is left out. `titled`: the header names the
 * conversation, so the turn does not.
 */
function turnLine(turn: ExtractionTurnInput, follows: boolean, titled: boolean): string {
  const before = !follows && turn.previousAssistantText?.trim() ? excerptText(turn.previousAssistantText, BEFORE_HEAD, BEFORE_TAIL) : '';
  const quoted = turn.quotedText?.trim() ? excerptText(turn.quotedText, QUOTED_CHARS, 0) : '';
  const reply = turn.assistantText?.trim() ? excerptText(turn.assistantText, REPLY_HEAD, REPLY_TAIL) : '';
  const title = titled ? '' : titleOf(turn);
  const lang = turnLanguage(turn.userText);
  return JSON.stringify({
    turn: turn.turnId,
    ...(title ? { conversation: title } : {}),
    sent: sentLabel(turn.userAt),
    ...(lang ? { lang } : {}),
    ...(turn.untrusted || turn.previousUntrusted ? { readOutsideContent: true } : {}),
    ...(before ? { before } : {}),
    ...(quoted ? { quoted } : {}),
    user: excerptText(turn.userText, USER_HEAD, USER_TAIL),
    ...(reply ? { reply } : {}),
  });
}

function relatedLine(memory: ExtractionRelatedMemory): string {
  const marks = [memory.kind, `about ${memory.about}`, ...(memory.topic ? [`topic ${JSON.stringify(memory.topic)}`] : []), ...(memory.savedByUser ? ['savedByUser'] : []),
    ...(memory.thisConversation ? ['noted earlier in this conversation'] : []), `said ${memoryDay(memory.observedAt)}`];
  return `- ${memory.ref} · ${marks.join(' · ')}: ${collapse(excerptText(memory.body, BODY_MAX, 0))}`;
}

/** The conversation every turn of the prompt is from, or null (turns of several, or none named). */
function singleConversation(turns: readonly ExtractionTurnInput[]): string | null {
  const nodeId = turns[0]?.nodeId ?? null;
  return nodeId && turns.every((turn) => turn.nodeId === nodeId) ? nodeId : null;
}

/** Michi's own notes from the conversation's earlier turns the prompt lists at most, ahead of what recall finds. */
const EARLIER_NOTES_MAX = 3;

/**
 * The notes Michi took on its own from earlier turns of the conversation the
 * turns are from (memoryRepository.michiNotesFromConversation), newest first,
 * whatever words they share with the new turns: a "don't keep that" later in
 * the conversation names them in forget.
 */
function earlierNotes(input: ExtractionPromptInput): ExtractionRelatedMemory[] {
  const nodeId = singleConversation(input.turns);
  if (!nodeId) return [];
  try {
    return michiNotesFromConversation({
      ownerUserId: input.ownerUserId, nodeId, workspaceId: input.workspaceId, exceptTurnIds: input.turns.map((turn) => turn.turnId), limit: EARLIER_NOTES_MAX,
    }).map(({ rowId, record }) => ({
      ref: memoryRef(rowId, record.version), memoryId: record.id, kind: record.kind, about: record.scope.kind === 'user' ? 'user' : 'project',
      body: record.body, savedByUser: false, observedAt: record.observedAt ?? record.createdAt, thisConversation: true,
      ...(record.topic ? { topic: record.topic } : {}),
    }));
  } catch (error) {
    log.warn('scheduler', 'automatic memory: the conversation\'s earlier notes not found', { error: (error as Error).message });
    return [];
  }
}

/**
 * The active memories of the user scope and the workspace that recall finds
 * for the turns' words, the best of each turn in turn.
 */
function findRelated(input: ExtractionPromptInput, now: number): ExtractionRelatedMemory[] {
  const lists = input.turns.map((turn) => {
    const query = [turn.userText, turn.quotedText ?? ''].join('\n').slice(0, RELATED_QUERY_CHARS);
    try {
      return recallSearch({
        ownerUserId: input.ownerUserId, workspaceIds: [input.workspaceId], includeUserScope: true,
        currentWorkspaceId: input.workspaceId, query, kinds: ['memory'], gate: false, limit: RELATED_MAX, now,
      });
    } catch (error) {
      log.warn('scheduler', 'automatic memory: related memories not found', { error: (error as Error).message });
      return [];
    }
  });
  const related: ExtractionRelatedMemory[] = [];
  const seen = new Set<string>();
  for (let rank = 0; related.length < RELATED_MAX && lists.some((list) => rank < list.length); rank += 1) {
    for (const list of lists) {
      const hit = list[rank];
      const memory = hit?.memory;
      if (!hit || !memory || memory.status !== 'active' || seen.has(memory.id) || related.length >= RELATED_MAX) continue;
      seen.add(memory.id);
      related.push({
        ref: memoryRef(memory.rowId, memory.version), memoryId: memory.id, kind: memory.kind,
        about: hit.workspaceId === null ? 'user' : 'project', body: hit.snippet,
        savedByUser: memory.origin === 'explicit', observedAt: memory.observedAt, ...(memory.topic ? { topic: memory.topic } : {}),
      });
    }
  }
  return related;
}

/** Michi's notes from the conversation's earlier turns first, then what recall found, each memory once, within RELATED_MAX. */
function relatedFor(input: ExtractionPromptInput, now: number): ExtractionRelatedMemory[] {
  const listed = new Map<string, ExtractionRelatedMemory>();
  for (const memory of [...earlierNotes(input), ...findRelated(input, now)]) if (!listed.has(memory.memoryId)) listed.set(memory.memoryId, memory);
  return [...listed.values()].slice(0, RELATED_MAX);
}

/**
 * The extractor's system instructions and the prompt for these turns, with
 * the existing memories it lists. Reads the database only to look those up
 * (input.related absent).
 */
export function buildExtractionPrompt(input: ExtractionPromptInput): ExtractionPrompt {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const toolName = input.toolName === undefined ? MEMORY_EXTRACTION_TOOL_NAMES[0] : input.toolName;
  const related = (input.related ?? relatedFor(input, now)).slice(0, RELATED_MAX);
  const topics = (input.topics ?? topicsInUse(input.ownerUserId, input.workspaceId, TOPICS_MAX)).slice(0, TOPICS_MAX);
  const name = input.workspaceName?.trim();
  const count = input.turns.length;
  // One conversation (as a run reads it): its title once, in the header.
  const oneConversation = count > 0 && input.turns.every((turn) => (turn.nodeId ?? null) === (input.turns[0].nodeId ?? null) && turn.title === input.turns[0].title);
  const title = oneConversation ? titleOf(input.turns[0]) : '';
  const lines = [
    `Michi Memory extraction${name ? ` · workspace ${JSON.stringify(excerptText(name, TITLE_CHARS, 0))}` : ''}${title ? ` · conversation ${JSON.stringify(title)}` : ''} · today ${memoryDay(now)} (${WEEKDAYS[new Date(now).getDay()] ?? 'unknown day'})`,
    '',
    related.length
      ? 'Existing memories (the user\'s and this workspace\'s; refs for "update" and "forget"):'
      : 'Existing memories: none related to these turns.',
    ...related.map(relatedLine),
    ...(topics.length ? ['', `Topics in use: ${topics.map((topic) => JSON.stringify(topic)).join(', ')}`] : []),
    '',
    'Turns, oldest first, one JSON object per line. "user" is what the user wrote, "lang" the language they wrote it in (zh or en); "before" is the end of the assistant message they answered; "quoted" is text they selected and replied to; "reply" is the start and end of the assistant\'s answer; readOutsideContent: the turn read web pages, files or tool output.',
    ...input.turns.map((turn, index) => turnLine(turn, index > 0 && !!turn.nodeId && input.turns[index - 1].nodeId === turn.nodeId, oneConversation)),
    '',
    toolName
      ? `Call ${toolName} once with the answer for ${count === 1 ? 'this turn' : `these ${count} turns`}, then stop.`
      : 'Reply with the JSON object only.',
  ];
  return { system: buildExtractionInstructions({ toolName }), prompt: lines.join('\n'), related };
}

// ── the commit ───────────────────────────────────────────────────────────────

export interface ExtractionCommitContext {
  /** The memory owner, as given (as for buildExtractionPrompt). */
  ownerUserId: string;
  /** The turns' workspace: project memories go here; it must be the owner's. */
  workspaceId: string;
  /** The turns the prompt carried (unreadable ones left out). */
  turns: readonly ExtractionTurnInput[];
  /** The prompt's related memories: an update may target only these. Absent: any active memory of the user scope or the workspace. */
  related?: ReadonlyArray<Pick<ExtractionRelatedMemory, 'ref' | 'memoryId'>>;
  /** An execution's id (memory_extraction_runs): each commit is recorded so no turn yields the same body twice. */
  runId?: string | null;
  now?: number;
}

export type ExtractionDropReason =
  /** Memory is off for the owner. */
  | 'memory_off'
  /** The quote is in no turn's user text: not the user's own words. */
  | 'quote_not_found'
  /** The quote is in more than one turn and source_turn names none of them. */
  | 'unknown_source_turn'
  | 'secret'
  /** The same body is stored, or a memory saved from the same turn already says it. */
  | 'duplicate'
  /** The user removed this body, or a memory from this turn, before. */
  | 'tombstoned'
  /** An earlier run committed this body from this turn. */
  | 'already_saved'
  /** More memories from one turn than MEMORIES_PER_TURN. */
  | 'limit'
  /** Its source turn is one the user declined or took back (exclude_turns). */
  | 'excluded'
  | 'invalid';

export interface ExtractionSavedMemory {
  index: number;
  /** update: it superseded its target. */
  op: ExtractionOp;
  memory: MemoryRecord;
  supersededId: string | null;
  /**
   * Why an update was added beside its target instead: the target is not a
   * listed, active memory in scope unchanged since the prompt
   * ('unavailable'), or the user saved it and the update is not marked
   * explicit ('saved_by_user').
   */
  targetIgnored: 'unavailable' | 'saved_by_user' | null;
}

export interface ExtractionCommitResult {
  saved: ExtractionSavedMemory[];
  dropped: Array<{ index: number; reason: ExtractionDropReason }>;
  /** Turns whose recall document took the payload's keyphrases. */
  turnKeys: number;
  /** Turns of the batch the payload's exclude_turns named: nothing was extracted from them. */
  excludedTurns: number;
  /**
   * Memories Michi had noted on its own (origin extracted), forgotten: the user declined what they say. Those from the
   * excluded turns, and the listed ones forget named.
   */
  forgotten: number;
}

/** Memories one turn yields at most. */
const MEMORIES_PER_TURN = 8;
/** Share of a body's index terms a memory from the same turn must hold to say the same. */
const RESTATED_SHARE = 0.8;
const QUOTE_GAP = /…+|\.{3,}|⋯+/u;
const THIRD_PERSON_SUBJECT = /^\s*(?:the\s+)?users?(?:['’]s)?\b|^\s*用户的?/iu;

/** Letters and digits only, folded: punctuation, spacing, width, case and quoting do not matter. */
function quoteKey(text: string): string {
  return normalizeText(text).replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Every part of the quote (split at an ellipsis) is in the user's text; at least two letters or digits in all. */
function quotedIn(userKey: string, quote: string): boolean {
  const parts = quote.split(QUOTE_GAP).map(quoteKey).filter(Boolean);
  const size = parts.reduce((sum, part) => sum + [...part].length, 0);
  return size >= 2 && parts.every((part) => userKey.includes(part));
}

function termsOf(body: string): Set<string> {
  return new Set(segmentTerms(body.replace(THIRD_PERSON_SUBJECT, '')));
}

/** Most of the body's terms are in one of these bodies. */
function restated(body: string, others: ReadonlyArray<{ body: string }>): boolean {
  const terms = termsOf(body);
  if (terms.size === 0) return false;
  return others.some((other) => {
    const have = termsOf(other.body);
    let held = 0;
    for (const term of terms) if (have.has(term)) held += 1;
    return held / terms.size >= RESTATED_SHARE;
  });
}

/** Local midnight of a YYYY-MM-DD day (memoryDay shows it as that day again), whatever the year. */
function dayStart(day: string | undefined): number | null {
  if (!day) return null;
  const [year, month, date] = day.split('-').map(Number);
  const start = new Date(0);
  start.setFullYear(year, month - 1, date);
  start.setHours(0, 0, 0, 0);
  const ms = start.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The payload's keywords, the quote as the user's own wording, and the words
 * of every profile category the memory states in both languages (its
 * employer: company, 公司, 工作, job…; where they live: city, 城市, 住在…:
 * memoryTerms.profileKeywords), so a question naming only the category finds
 * it; no secret, within the shared limits.
 */
function keywordsOf(memory: ExtractionPayloadMemory): string[] {
  const quote = collapse(memory.quote);
  const own = quote.length <= MEMORY_KEYWORD_MAX_CHARS && normalizeText(quote) !== normalizeText(memory.body) ? [quote] : [];
  const category = profileKeywords(`${memory.body}\n${memory.keywords.join('\n')}`);
  return distinct([...memory.keywords, ...own, ...category].filter((keyword) => !containsCredential(keyword)), MEMORY_KEYWORDS_MAX_COUNT);
}

/** A turn that read outside content stays marked unless the body restates what the user wrote. */
function sourceRiskOf(turn: ExtractionTurnInput, body: string): MemorySourceRisk | null {
  return (turn.untrusted || turn.previousUntrusted) && !typedTextBacks([turn.userText], body) ? 'untrusted' : null;
}

interface KeyedTurn { turn: ExtractionTurnInput; key: string }

/** The turn whose user text holds the quote: the named one, else the only one. */
function sourceTurnOf(memory: ExtractionPayloadMemory, turns: readonly KeyedTurn[]): ExtractionTurnInput | 'quote_not_found' | 'unknown_source_turn' {
  const named = turns.find((entry) => entry.turn.turnId === memory.source_turn);
  if (named && quotedIn(named.key, memory.quote)) return named.turn;
  const holding = turns.filter((entry) => quotedIn(entry.key, memory.quote));
  if (holding.length === 1) return holding[0].turn;
  return holding.length === 0 ? 'quote_not_found' : 'unknown_source_turn';
}

/** An update's target: a listed, active memory of the user scope or the workspace, at the version the prompt showed. */
function targetOf(memory: ExtractionPayloadMemory, ctx: ExtractionCommitContext): StoredMemory | null {
  const parsed = memory.op === 'update' ? parseRef(memory.target) : null;
  if (!parsed || parsed.kind !== 'memory') return null;
  const stored = storedMemoryByRowId(ctx.ownerUserId, parsed.rowId);
  if (!stored || stored.record.status !== 'active') return null;
  const scope = stored.record.scope;
  if (scope.kind === 'workspace' && scope.workspaceId !== ctx.workspaceId) return null;
  if (parsed.version !== null && parsed.version !== stored.record.version) return null;
  if (ctx.related) {
    const listed = ctx.related.find((entry) => entry.memoryId === stored.record.id);
    const shown = listed ? parseRef(listed.ref) : null;
    if (!shown || shown.kind !== 'memory' || shown.version !== stored.record.version) return null;
  }
  return stored;
}

/**
 * A memory forget may delete: a listed (ctx.related; absent: any), active
 * note Michi took on its own (none the user saved or imported), of the user
 * scope or the workspace, at the version the prompt showed, as targetOf
 * reads an update's target.
 */
function forgettable(ref: string, ctx: ExtractionCommitContext): StoredMemory | null {
  const parsed = parseRef(ref);
  if (!parsed || parsed.kind !== 'memory') return null;
  const stored = storedMemoryByRowId(ctx.ownerUserId, parsed.rowId);
  const record = stored?.record;
  if (!stored || !record || record.status !== 'active' || record.origin !== 'extracted' || record.importSource) return null;
  if (record.scope.kind === 'workspace' && record.scope.workspaceId !== ctx.workspaceId) return null;
  if (parsed.version !== null && parsed.version !== record.version) return null;
  if (ctx.related) {
    const listed = ctx.related.find((entry) => entry.memoryId === record.id);
    const shown = listed ? parseRef(listed.ref) : null;
    if (!shown || shown.kind !== 'memory' || shown.version !== record.version) return null;
  }
  return stored;
}

/** Forgets one of Michi's own notes as the agent would delete it (memoryService.forgetMemory); false when it went already. */
function forgetNote(ownerUserId: string, memoryId: string): boolean {
  try {
    forgetMemory({ ownerUserId }, memoryId);
    return true;
  } catch (error) {
    // Forgotten with another one's versions a moment before.
    if (!(error instanceof MemoryError) || error.code !== 'not_found') throw error;
    return false;
  }
}

/**
 * Saves a validated payload (spec §4) for the owner, in one transaction (a
 * savepoint inside the caller's). First what the user declined or took back:
 * of the turns of exclude_turns among the batch's, what Michi noted on its own
 * from them (an agent's unasked save, a note from an earlier run), and the
 * notes forget names (forgettable: listed notes of Michi's, a decline later
 * than what it is about, in the conversation or another one), each forgotten
 * (memoryService.forgetMemory) as the agent would delete it; what the user
 * saved stays theirs to delete. Then each memory as an active memory,
 * extracted unless marked explicit, with its keywords (and the quote),
 * event_at and observed_at (the user's send time); then each turn's
 * keyphrases on its recall document. Nothing comes from a turn of
 * exclude_turns. Never writes anything the rules in this module's header
 * drop. Throws MemoryError not_found when the workspace is not the owner's.
 */
export function commitExtractionPayload(payload: ExtractionPayload, ctx: ExtractionCommitContext): ExtractionCommitResult {
  const result: ExtractionCommitResult = { saved: [], dropped: [], turnKeys: 0, excludedTurns: 0, forgotten: 0 };
  const memories = payload?.memories ?? [];
  if (!workspaceAccessible(ctx.ownerUserId, ctx.workspaceId)) throw new MemoryError('not_found', 'Workspace not found');
  if (getMemorySettings(ctx.ownerUserId).mode === 'off') {
    result.dropped.push(...memories.map((_memory, index) => ({ index, reason: 'memory_off' as const })));
    return result;
  }
  const caller = { ownerUserId: ctx.ownerUserId };
  // The assistant's workspace is no memory scope: what V's turns yield is the user's.
  const workspaceScope = holdsWorkspaceMemories(ctx.workspaceId);
  return memoryTransaction(() => {
    const known = new Map(ctx.turns.map((turn) => [turn.turnId, turn]));
    // What the user declined or took back: nothing below is extracted from it, and Michi keeps none of its own notes of it.
    const excluded = new Set((payload?.exclude_turns ?? []).filter((turnId) => known.has(turnId)));
    result.excludedTurns = excluded.size;
    for (const turnId of excluded) {
      for (const memory of activeMemoriesFromTurn(ctx.ownerUserId, turnId)) {
        if (memory.origin === 'extracted' && forgetNote(ctx.ownerUserId, memory.id)) result.forgotten += 1;
      }
    }
    // Michi's notes of what these turns decline when it was said before them (earlier in the conversation, or elsewhere).
    for (const ref of payload?.forget ?? []) {
      const note = forgettable(ref, ctx);
      if (note && forgetNote(ctx.ownerUserId, note.record.id)) result.forgotten += 1;
    }
    const turns: KeyedTurn[] = ctx.turns.map((turn) => ({ turn, key: quoteKey(turn.userText) }));
    const stored = new Set(activeMemoryBodies(ctx.ownerUserId, ctx.workspaceId).map(memoryBodyHash));
    const perTurn = new Map<string, number>();
    memories.forEach((memory, index) => {
      const drop = (reason: ExtractionDropReason) => { result.dropped.push({ index, reason }); };
      const turn = sourceTurnOf(memory, turns);
      if (typeof turn === 'string') return drop(turn);
      if (excluded.has(turn.turnId)) return drop('excluded');
      if (containsCredential(memory.body) || containsCredential(memory.quote)) return drop('secret');
      if ((perTurn.get(turn.turnId) ?? 0) >= MEMORIES_PER_TURN) return drop('limit');
      const found = targetOf(memory, ctx);
      // What the user saved changes only when they corrected it themself.
      const target = found && (found.record.origin !== 'explicit' || memory.explicit === true) ? found : null;
      const targetIgnored = memory.op !== 'update' ? null : !found ? 'unavailable' as const : !target ? 'saved_by_user' as const : null;
      const body = memory.body;
      const hash = memoryBodyHash(body);
      // An automatic memory the user asked to remember becomes theirs, its text unchanged: not a second copy of itself.
      const madeTheirs = !!target && memory.explicit === true && target.record.origin === 'extracted' && memoryBodyHash(target.record.body) === hash;
      if (stored.has(hash) && !madeTheirs) return drop('duplicate');
      const fromTurn = activeMemoriesFromTurn(ctx.ownerUserId, turn.turnId).filter((other) => other.id !== target?.record.id);
      if (restated(body, fromTurn)) return drop('duplicate');
      // A user-scope target stays there; about 'user' widens a workspace target, never the other way round.
      const userScope = !workspaceScope || memory.about === 'user' || target?.record.scope.kind === 'user';
      // A memory for the user scope would show in every workspace again: a removal of its body in any of them bars it,
      // also one made while this turn ran (what the user sent before it).
      if (tombstoneBlocks({ ownerUserId: ctx.ownerUserId, workspaceId: ctx.workspaceId, sourceTurnId: turn.turnId,
        bodyHash: hash, statedAt: turn.userAt, everywhere: userScope })) return drop('tombstoned');
      const key = ctx.runId ? extractionIdempotencyKey({ ownerUserId: ctx.ownerUserId, workspaceId: ctx.workspaceId, sourceTurnId: turn.turnId, bodyHash: hash }) : null;
      const committed = key ? getCommittedProposal(key) : null;
      // Making an automatic memory theirs is no new proposal: an earlier run may have committed that very body.
      if (committed && !(madeTheirs && committed.memoryId === target?.record.id)) return drop('already_saved');
      const scope: MemoryScope = userScope ? { kind: 'user' } : { kind: 'workspace', workspaceId: ctx.workspaceId };
      // A request to remember the agent missed, or a correction of what the user saved, is the user's own (pinned).
      const origin = memory.explicit === true || target?.record.origin === 'explicit' ? 'explicit' as const : 'extracted' as const;
      const input = {
        scope, kind: memory.kind, body, keywords: keywordsOf(memory), topic: memory.topic ?? target?.record.topic ?? null, eventAt: dayStart(memory.event_date),
        observedAt: Number.isInteger(turn.userAt) ? turn.userAt : null,
        source: { ...(turn.nodeId ? { nodeId: turn.nodeId } : {}), turnId: turn.turnId },
        status: 'active' as const, origin, sourceRisk: sourceRiskOf(turn, memory.body),
      };
      let record: MemoryRecord;
      let supersededId: string | null = null;
      let ignored: ExtractionSavedMemory['targetIgnored'] = targetIgnored;
      try {
        if (target) {
          try {
            record = createMemory(caller, { ...input, supersedesId: target.record.id });
            supersededId = target.record.id;
          } catch (error) {
            // Corrected or removed since it was read: the new statement still stands on its own.
            if (!(error instanceof MemoryError) || !['not_found', 'invalid_state', 'version_conflict'].includes(error.code)) throw error;
            record = createMemory(caller, { ...input, origin: memory.explicit === true ? 'explicit' : 'extracted' });
            ignored = 'unavailable';
          }
        } else {
          record = createMemory(caller, input);
        }
      } catch (error) {
        if (error instanceof MemoryError && error.code === 'invalid_argument') {
          log.warn('scheduler', 'automatic memory: a memory was not saved', { error: error.message });
          return drop('invalid');
        }
        throw error;
      }
      stored.add(hash);
      perTurn.set(turn.turnId, (perTurn.get(turn.turnId) ?? 0) + 1);
      if (key && ctx.runId && !committed) {
        insertCommittedProposal({ idempotencyKey: key, ownerUserId: ctx.ownerUserId, workspaceId: ctx.workspaceId, sourceTurnId: turn.turnId,
          memoryId: record.id, scopeHint: userScope ? 'maybe_global' : 'workspace', runId: ctx.runId, now: Number.isFinite(ctx.now) ? Number(ctx.now) : Date.now() });
      }
      result.saved.push({ index, op: supersededId ? 'update' : 'add', memory: record, supersededId, targetIgnored: supersededId ? null : ignored });
    });
    for (const entry of payload?.turn_keys ?? []) {
      if (!known.has(entry.source_turn) || excluded.has(entry.source_turn)) continue;
      const keys = entry.keys.filter((key) => !containsCredential(key));
      if (keys.length && setTurnKeys(ctx.ownerUserId, entry.source_turn, keys)) result.turnKeys += 1;
    }
    return result;
  });
}
