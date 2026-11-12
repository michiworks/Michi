import type { MemorySourceRisk } from 'michi-shared';
import { openDbOrNull, prepareCached } from '../db';
import { segmentTerms } from './memoryTerms';

/**
 * What a person typed into a chat turn: its composer message and the
 * messages steered into it, never text an agent, a scheduled job or another
 * thread wrote. Memory uses it for provenance only, never to read intent: a
 * memory written in a turn that read outside content (web pages, shell or
 * another MCP server's output: services/turnTrust.ts) is clean when the
 * user's own words in that turn restate it (typedTextBacks), so a page cannot
 * plant a note that later packs pin; in a turn that holds check-in or
 * collector material, memory_delete forgets only what their words name
 * (typedTextNames), so that material can make Michi forget only what the
 * user mentions.
 *
 *  - ChatHub records the running turn's text (recordTypedText) and drops it
 *    when the turn ends; memory_save, memory_update and memory_delete read it
 *    while the turn runs (typedTextOfTurn, agents/memoryTools.ts). Where the
 *    person typed last tells automatic memory they left the conversations
 *    before it (lastTypedConversation), and when they last typed into one,
 *    that they came back to it while it was being read (lastTypedInto).
 *  - Automatic recall (contextBuilder.ts) and the profile show a memory still
 *    marked untrusted only when what the user typed in its turn backs it
 *    (vouchedForRecall, from data.db).
 */

interface RunningTurn {
  turnId: string;
  texts: string[];
  /** When a person first typed into it, and the database it belongs to (humanTurnRunning). */
  since: number;
  db: object | null;
}

/** By chat node: a node runs one turn at a time. */
const running = new Map<string, RunningTurn>();
/**
 * A turn whose end never reached ChatHub (a process fault) stops counting as
 * running after this long, so background work it holds off (consolidation)
 * is not held off for good.
 */
const RUNNING_STALE_MS = 6 * 60 * 60_000;
/** When a person last typed into a turn or one of their turns ended in this process, with its database (lastHumanActivityAt). */
let lastActivity: { at: number; db: object | null } | null = null;
/** Entries kept at most; a turn whose end never reached ChatHub cannot pile up. */
const MAX_RUNNING_TURNS = 1_000;
/**
 * The conversation a person typed into last in this process, and when, with
 * the database it belongs to: a process that opens another one (a test, an
 * evaluation item) starts without it.
 */
let lastTyped: { nodeId: string; at: number; db: object | null } | null = null;
/** By chat node: when a person last typed into it in this process, with the database it belongs to (lastTypedInto). */
const typedInto = new Map<string, { at: number; db: object | null }>();
/** Told when a person types into another conversation than the one they typed into last (server.ts wakes extraction). */
const switchListeners = new Set<() => void>();

/**
 * Where a person typed last in this process, and when: automatic memory
 * reads a conversation once they moved on to another one
 * (extractionRun.conversationDue). null before anyone typed.
 */
export function lastTypedConversation(): { nodeId: string; at: number } | null {
  return lastTyped && lastTyped.db === openDbOrNull() ? { nodeId: lastTyped.nodeId, at: lastTyped.at } : null;
}

/**
 * When a person last typed into this conversation in this process, for the
 * database open now, or null: automatic memory reads a conversation the user
 * came back to while it was being read again once they leave it
 * (extractionRun.settleMemoryExtractionRun).
 */
export function lastTypedInto(nodeId: string): number | null {
  const entry = typedInto.get(nodeId);
  return entry && entry.db === openDbOrNull() ? entry.at : null;
}

/** Calls `listener` whenever a person types into another conversation than the one before (they left it). Returns an unsubscribe. */
export function watchConversationSwitches(listener: () => void): () => void {
  switchListeners.add(listener);
  return () => { switchListeners.delete(listener); };
}

/** ChatHub: a person typed `text` into the node's running turn (its message, or a steer). */
export function recordTypedText(nodeId: string, turnId: string, text: string): void {
  if (!nodeId || !turnId || typeof text !== 'string' || !text.trim()) return;
  const previous = lastTyped;
  lastTyped = { nodeId, at: Date.now(), db: openDbOrNull() };
  lastActivity = { at: lastTyped.at, db: lastTyped.db };
  typedInto.delete(nodeId);
  typedInto.set(nodeId, { at: lastTyped.at, db: lastTyped.db });
  if (typedInto.size > MAX_RUNNING_TURNS) typedInto.delete(typedInto.keys().next().value as string);
  if (previous && previous.nodeId !== nodeId && previous.db === lastTyped.db) {
    for (const listener of [...switchListeners]) {
      try { listener(); } catch { /* a listener never fails the turn */ }
    }
  }
  let entry = running.get(nodeId);
  if (!entry || entry.turnId !== turnId) {
    entry = { turnId, texts: [], since: lastTyped.at, db: lastTyped.db };
    running.delete(nodeId);
    running.set(nodeId, entry);
    if (running.size > MAX_RUNNING_TURNS) running.delete(running.keys().next().value as string);
  }
  entry.texts.push(text);
}

/** ChatHub: the turn ended. */
export function releaseTypedText(nodeId: string, turnId: string): void {
  const entry = running.get(nodeId);
  if (entry?.turnId !== turnId) return;
  running.delete(nodeId);
  lastActivity = { at: Date.now(), db: entry.db };
}

/**
 * Whether a turn a person typed into is running now in this process, for the
 * database open now (a test or an evaluation item that opens another starts
 * without them). Background memory work that must never run alongside a
 * conversation (consolidation.ts) waits for it.
 */
export function humanTurnRunning(): boolean {
  const db = openDbOrNull();
  const now = Date.now();
  for (const entry of running.values()) if (entry.db === db && now - entry.since < RUNNING_STALE_MS) return true;
  return false;
}

/** When a person last typed into a turn, or one of their turns ended, in this process for the database open now; null before any. */
export function lastHumanActivityAt(): number | null {
  return lastActivity && lastActivity.db === openDbOrNull() ? lastActivity.at : null;
}

/** What a person typed into this running turn so far; [] for any other turn. */
export function typedTextOfTurn(nodeId: string, turnId: string): readonly string[] {
  const entry = running.get(nodeId);
  return entry && entry.turnId === turnId ? entry.texts : [];
}

/** Share of a memory's index terms the user's own words must hold for it to restate them. */
const RESTATED_SHARE = 0.6;

/** Notes about the user are often worded in the third person ("The user …", "用户…"): a subject the user never typed. */
const THIRD_PERSON_SUBJECT = /^\s*(?:the\s+)?users?(?:['’]s)?\b|^\s*用户的?/iu;

/** A note's text without its leading third-person subject ("The user …", "用户…"), which says nothing about what it is. */
export function withoutUserSubject(body: string): string {
  return body.replace(THIRD_PERSON_SUBJECT, '');
}

/** How many of a text's index terms (memoryTerms.segmentTerms, its third-person subject left out) the user's words hold, of how many. */
function termsTyped(typed: readonly string[], text: string): { held: number; total: number } {
  if (typed.length === 0) return { held: 0, total: 0 };
  const own = new Set(segmentTerms(typed.join('\n')));
  const terms = [...new Set(segmentTerms(withoutUserSubject(text)))];
  return { held: terms.filter((term) => own.has(term)).length, total: terms.length };
}

/**
 * Whether what the user typed backs a memory written in their turn: most of
 * the body's index terms (memoryTerms.segmentTerms) are in their words.
 */
export function typedTextBacks(typed: readonly string[], body: string): boolean {
  const { held, total } = termsTyped(typed, body);
  return total > 0 && held >= Math.min(2, total) && held / total >= RESTATED_SHARE;
}

/**
 * Whether what the user typed names what memory_delete forgets (a memory's
 * body, or what they said in a past turn): two of its index terms, or its only
 * one, are in their words, whether or not they ask to forget it. A request
 * names a memory by part of it ("forget my old address"), so this asks less
 * than typedTextBacks; one word that a memory about something else holds too
 * ("forget my new address") is not enough.
 */
export function typedTextNames(typed: readonly string[], text: string): boolean {
  const { held, total } = termsTyped(typed, text);
  return total > 0 && held >= Math.min(2, total);
}

// ── finished turns ───────────────────────────────────────────────────────────

const TURN_SQL = `SELECT t.assistant_message_id AS assistant_id, u.content AS content, u.metadata AS metadata,
    u.seq AS user_seq, a.seq AS assistant_seq
  FROM turns t
  LEFT JOIN messages u ON u.id = t.user_message_id AND u.node_id = t.node_id
  LEFT JOIN messages a ON a.id = t.assistant_message_id AND a.node_id = t.node_id
  WHERE t.turn_id = ? AND t.node_id = ?`;

/** Steers are stored as u-steer-* user messages just before the turn's reply. */
const STEERS_SQL = `SELECT content FROM messages WHERE node_id = ? AND role = 'user' AND id LIKE 'u-steer-%'
  AND seq > ? AND seq < ? ORDER BY seq LIMIT 20`;

interface StoredTurnRow {
  assistant_id: string;
  content: string | null;
  metadata: string | null;
  user_seq: number | null;
  assistant_seq: number | null;
}

/** A user message Michi relayed or generated (a thread message, a scheduled job's prompt), not one a person typed. */
export function relayedInput(metadata: string | null): boolean {
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown> | null;
    return !!parsed && typeof parsed === 'object' && (parsed.threadMessage !== undefined || parsed.scheduledJobId !== undefined);
  } catch {
    return false;
  }
}

/**
 * What a person typed in a stored turn: the composer's message of a
 * foreground turn (assistant message a-<node>-<turn>, ChatHub.beginTurn;
 * self-turns use self-) unless Michi relayed it, and the messages steered
 * into the turn. Also all that extraction reads of a turn that took in
 * Companion material (extractionRun.readExtractionTurn).
 */
export function storedTypedText(nodeId: string, turnId: string): string[] {
  const row = prepareCached(TURN_SQL).get(turnId, nodeId) as StoredTurnRow | undefined;
  if (!row) return [];
  const texts: string[] = [];
  if (row.assistant_id.startsWith('a-') && row.content?.trim() && !relayedInput(row.metadata)) texts.push(row.content);
  if (row.user_seq !== null && row.assistant_seq !== null) {
    for (const steer of prepareCached(STEERS_SQL).all(nodeId, row.user_seq, row.assistant_seq) as Array<{ content: string }>) {
      if (steer.content.trim()) texts.push(steer.content);
    }
  }
  return texts;
}

/** What vouchedForRecall needs of a memory. */
export interface RecallableMemory {
  body: string;
  sourceRisk: MemorySourceRisk | null;
  nodeId: string | null;
  turnId: string | null;
}

/**
 * Whether automatic recall may show a memory: it was not written from a turn
 * that read outside content, or what the user typed in that turn backs it
 * (typedTextBacks). Anything else stays out of packs and the profile;
 * memory_search still finds it, marked unverified.
 */
export function vouchedForRecall(memory: RecallableMemory): boolean {
  if (memory.sourceRisk !== 'untrusted') return true;
  if (!memory.nodeId || !memory.turnId) return false;
  return typedTextBacks(storedTypedText(memory.nodeId, memory.turnId), memory.body);
}
