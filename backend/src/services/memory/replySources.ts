import type { MemoryRecord, ReplyMemorySource, ReplyMemorySourcesResponse } from 'michi-shared';
import { getDb, prepareCached } from '../db';
import { log } from '../logger';
import { stripSentinelsStreamingSafe } from '../messageSerialization';
import { digitRuns } from './consolidation';
import type { MemoryPack, MemoryPackItem } from './contextBuilder';
import {
  consolidationRows, conversationWorkspaceId, currentCorrection, markMemoriesUsed, memoryTransaction, readMemoryMode, storedMemories,
  type StoredMemory,
} from './memoryRepository';
import { getConversationMemoryMode, getMemorySettings, type MemoryCaller } from './memoryService';
import { COMMON_TERMS, segmentTerms } from './memoryTerms';
import { createRecallMemo, docTerms, queryAtoms, recallTurnMatch } from './recallIndex';
import { vouchedForRecall } from './typedText';

/**
 * Reply sources (spec round 10 §T): which memories a reply repeated, of what
 * its conversation's session was given, so a quiet line under the reply can
 * say what it was based on. Michi tracks this itself: no model marker, and no
 * prompt or stream change. Past-conversation excerpts are never sources: a
 * reply shares their words far more often than it uses them.
 *
 *  - The ledger (in memory, per conversation, LRU): the memories the
 *    session's pinned sections showed last (noteDelivered, from
 *    memoryInjection's delivery), and per turn the related memories its pack
 *    carried and what memory_search returned in it (noteSearched).
 *  - When a turn finalizes (attributeTurn, a ChatHub.onTurnFinalized
 *    listener after recall indexed it), the candidates are the pinned items
 *    and the items of this turn and the two before; one is used when recall's
 *    own gate (recallTurnMatch) matches it to the turn's document (whose own
 *    terms do not count toward how common they are), and the reply adds what
 *    matched: two pieces of evidence the user did not write (a matched part
 *    in the reply, a number of the item in it), or one that names the item
 *    (one of its keywords, a number of three digits or more or with a
 *    decimal). Lexical, so it may miss a paraphrase: the line says
 *    it may not list everything. Nothing here reads meaning, and nothing is
 *    shown to a model. The checks of one turn share their index reads, and a
 *    candidate whose words the reply cannot add is never searched.
 *  - A used memory's last_used_at (migration 0091) moves to now: what keeps
 *    Michi's own workspace notes from going stale (validity.ts).
 *  - The rows (memory_turn_sources, migration 0078) hold ids only; triggers
 *    drop them when a memory or a conversation goes, and the read path
 *    (replySourcesView) reads the memory rows (older rows may name
 *    past-conversation turns) and checks each again: a memory merged into
 *    another shows the one it went into, a corrected or removed one shows
 *    nothing.
 *  - Only turns Michi indexes get rows: a person-typed, completed turn of a
 *    conversation that learns, V's included. Use only and Off chats,
 *    scheduled-job turns, check-ins, posts and cancelled or failed turns get
 *    none.
 */

/** Where an item came from: a memory_search in the turn, or a section of its memory pack. */
export type ReplySourceSection = 'search' | MemoryPackItem['section'];

/** A memory the session was given. */
interface LedgerItem { id: string; section: ReplySourceSection }

interface NodeLedger {
  ownerUserId: string;
  /** What the session's latest pinned sections showed. */
  pinned: LedgerItem[];
  /** What each turn's pack and searches gave it. */
  turns: Map<string, LedgerItem[]>;
  /** The last finalized turns, oldest first (at most CARRIED_TURNS). */
  order: string[];
}

const LIMITS = Object.freeze({
  /** Conversations the ledger keeps (least recently used go). */
  nodes: 100,
  /** Items one turn holds. */
  turnItems: 30,
  /** Earlier finalized turns whose items still count. */
  carriedTurns: 2,
  /** Candidates checked per turn, and sources kept. */
  evaluated: 12,
  sources: 6,
  /**
   * A check searches the workspace's documents (its cost grows with them): a turn checks at most this many documents'
   * worth in all (evaluatedDocs / documents, at least one check), so that its end stays near one search's cost
   * however large the workspace.
   */
  evaluatedDocs: 30_000,
});

const ledgers = new Map<string, NodeLedger>();

const SECTION_RANK: Record<ReplySourceSection, number> = {
  search: 0, related: 1, recent: 2, saved: 3, preferences: 4, profile: 5,
};

/** The node's ledger, touched (LRU); a ledger of another owner starts over. */
function ledgerOf(ownerUserId: string, nodeId: string, create: boolean): NodeLedger | null {
  let ledger = ledgers.get(nodeId);
  if (ledger && ledger.ownerUserId !== ownerUserId) {
    ledgers.delete(nodeId);
    ledger = undefined;
  }
  if (!ledger) {
    if (!create) return null;
    ledger = { ownerUserId, pinned: [], turns: new Map(), order: [] };
  }
  ledgers.delete(nodeId);
  ledgers.set(nodeId, ledger);
  while (ledgers.size > LIMITS.nodes) ledgers.delete(ledgers.keys().next().value as string);
  return ledger;
}

function addItems(ledger: NodeLedger, turnId: string, items: readonly LedgerItem[]): void {
  const list = ledger.turns.get(turnId) ?? [];
  const held = new Set(list.map((item) => item.id));
  for (const item of items) {
    if (list.length >= LIMITS.turnItems) break;
    if (held.has(item.id)) continue;
    held.add(item.id);
    list.push(item);
  }
  ledger.turns.set(turnId, list);
}

/** A pack's memories (its past-conversation lines are never sources). */
function packMemories(items: readonly MemoryPackItem[]): LedgerItem[] {
  return items.flatMap((item) => (item.kind === 'memory' ? [{ id: item.id, section: item.section }] : []));
}

const PINNED_SECTIONS = new Set<MemoryPackItem['section']>(['saved', 'preferences', 'profile']);

/**
 * A turn's memory pack was delivered to its session (memoryInjection's
 * delivery, and its retraction when the conversation is off): an off pack
 * drops the conversation; a new session's pack starts the carry over; a pack
 * that carries the pinned sections replaces what they showed; its related
 * memories join the turn's. Never throws.
 */
export function noteDelivered(input: {
  ownerUserId: string; nodeId: string | null | undefined; turnId: string | null | undefined;
  pack: Pick<MemoryPack, 'off' | 'framed' | 'signature' | 'items'>;
}): void {
  try {
    const { ownerUserId, nodeId, pack } = input;
    if (!ownerUserId || !nodeId) return;
    if (pack.off) {
      ledgers.delete(nodeId);
      return;
    }
    const ledger = ledgerOf(ownerUserId, nodeId, true)!;
    if (pack.framed) {
      ledger.turns.clear();
      ledger.order = [];
    }
    if (pack.signature !== null) {
      ledger.pinned = packMemories(pack.items.filter((item) => PINNED_SECTIONS.has(item.section)));
    }
    if (input.turnId) {
      addItems(ledger, input.turnId, packMemories(pack.items.filter((item) => item.section === 'related')));
    }
  } catch (error) {
    log.warn('workspace', 'reply sources: a delivery was not noted', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** memory_search (or a ref lookup) gave the running turn these memories. Never throws. */
export function noteSearched(input: { ownerUserId: string; nodeId: string | null | undefined; turnId: string | null | undefined; memoryIds: readonly string[] }): void {
  try {
    const { ownerUserId, nodeId, turnId } = input;
    if (!ownerUserId || !nodeId || !turnId || input.memoryIds.length === 0) return;
    const ledger = ledgerOf(ownerUserId, nodeId, true)!;
    addItems(ledger, turnId, input.memoryIds.map((id) => ({ id, section: 'search' })));
  } catch (error) {
    log.warn('workspace', 'reply sources: a search was not noted', { error: error instanceof Error ? error.message : String(error) });
  }
}

// ── attribution ──────────────────────────────────────────────────────────────

/** A finished turn as ChatHub.onTurnFinalized reports it (TurnFinalizedEvent fits); an evaluation builds one directly. */
export interface AttributionTurn {
  /** As the route or server caller gave it; null on the desktop. */
  ownerUserId: string | null;
  nodeId: string;
  turnId: string;
  humanOrigin: boolean;
  userText: string;
  quotedText?: string | null;
  steers?: ReadonlyArray<{ text: string }>;
  assistantText?: string | null;
  /** The durable outcome; only 'completed' gets sources (absent counts as completed). */
  outcome?: string;
  /** 'ended' after a committed done; only that gets sources (absent counts as ended). */
  status?: string;
  persisted?: boolean;
}

export interface TurnAttribution {
  /** The turn's recall document. */
  docId: number;
  /** The memories considered, in priority order. */
  candidates: LedgerItem[];
  /** Candidates recall's gate was asked about. */
  evaluated: number;
  /** What the reply was based on, as stored. */
  used: LedgerItem[];
}

interface TurnDoc {
  id: number;
  owner_user_id: string;
  workspace_id: string | null;
  title: string | null;
  snippet: string;
  keys: string;
  content: string | null;
  hidden: number;
}

const TURN_DOC_SQL = `SELECT id, owner_user_id, workspace_id, title, snippet, keys, content, hidden FROM memory_recall_docs
  WHERE doc_kind = 'turn' AND ref_id = ?`;
const WORKSPACE_DOCS_SQL = 'SELECT count(*) AS n FROM memory_recall_docs WHERE workspace_id = ?';

/** Calls of recall's gate made by attributeTurn (the prefilter saves them). */
let gateCalls = 0;

/**
 * How many times attributeTurn asked recall's gate (the prefilter saves them).
 * @testonly
 */
export function replySourceGateCalls(): number {
  return gateCalls;
}

function memoryQuery(record: MemoryRecord): string {
  return [record.body, ...(record.keywords ?? [])].join('\n');
}

/** A memory a reply may name: the owner's, active, in the user scope or the conversation's workspace, and recallable. */
function memoryShowable(stored: StoredMemory | undefined, ownerUserId: string, workspaceId: string | null): stored is StoredMemory {
  if (!stored) return false;
  const { record } = stored;
  if (record.ownerUserId !== ownerUserId || record.status !== 'active') return false;
  if (record.scope.kind === 'workspace' && record.scope.workspaceId !== workspaceId) return false;
  return vouchedForRecall({ body: record.body, sourceRisk: record.sourceRisk, nodeId: record.source?.nodeId ?? null, turnId: record.source?.turnId ?? null });
}

/** What a text holds for clause B: its index terms, digit runs (replyCouldAdd's prefilter) and numbers (decimals kept whole). */
interface ClauseTerms {
  terms: Set<string>;
  digits: Set<string>;
  numbers: Set<string>;
}

/** The numbers of a text after NFKC, a decimal kept whole and without leading zeros (07 is 7, 42.50 stays 42.50). */
function numbersOf(text: string): Set<string> {
  return new Set([...(text ?? '').normalize('NFKC').matchAll(/\p{Nd}+(?:\.\p{Nd}+)?/gu)].map((match) => match[0].replace(/^0+(?=\d)/u, '')));
}

function clauseTerms(text: string): ClauseTerms {
  return { terms: new Set(segmentTerms(text)), digits: digitRuns(text), numbers: numbersOf(text) };
}

/** A matched part that is a number, maybe with a unit (1207, 42.5, 3岁); an identifier with digits (kestrel-9) is a name. */
const NUMBER_PART = /^\p{Nd}+(?:\.\p{Nd}+)?\p{Script=Han}?$/u;

/** A number specific enough to name what it is about on its own: three digits or more, or a decimal (1650, 42.5; not 14). */
function specificNumber(text: string): boolean {
  const folded = text.normalize('NFKC');
  return (folded.match(/\p{Nd}/gu) ?? []).length >= 3 || /\p{Nd}\.\p{Nd}/u.test(folded);
}

/**
 * Clause B: the reply adds what recall matched, by evidence the user did not
 * write: a matched part (not an everyday word) whose terms are all in the
 * reply and not all in what the user wrote, or a number of the item in the
 * reply that the user did not write. Two pieces are enough. One alone counts
 * only when it names the item: one of its keywords (a memory's search words,
 * an excerpt's keys), or a number of three digits or more or with a decimal;
 * a word that is merely uncommon in a small store, or a short number, does
 * not (round 10). A number shorter than that never counts.
 */
function replyAdds(matched: readonly string[], itemText: string, keys: readonly string[], reply: ClauseTerms, user: ClauseTerms): boolean {
  const keyTerms = new Set(keys.flatMap((key) => segmentTerms(key)));
  const evidence = new Set<string>();
  const covered = new Set<string>();
  let names = false;
  for (const part of matched) {
    if (COMMON_TERMS.has(part)) continue;
    const terms = segmentTerms(part);
    if (terms.length === 0) continue;
    if (!terms.every((term) => reply.terms.has(term)) || terms.every((term) => user.terms.has(term))) continue;
    evidence.add(`p:${terms.join(' ')}`);
    for (const number of numbersOf(part)) covered.add(number);
    if (NUMBER_PART.test(part.normalize('NFKC')) ? specificNumber(part) : terms.every((term) => keyTerms.has(term))) names = true;
  }
  for (const number of numbersOf(itemText)) {
    if (covered.has(number) || !specificNumber(number) || !reply.numbers.has(number) || user.numbers.has(number)) continue;
    evidence.add(`n:${number}`);
    names = true;
  }
  return evidence.size >= 2 || (evidence.size === 1 && names);
}

/**
 * Whether clause B (replyAdds) could pass for any part recall matches of this
 * query: a term of it (every matched part's terms are among its atoms and
 * segmentTerms) in the reply and not in the user's words, or such a number.
 */
function replyCouldAdd(query: string, atoms: ReadonlySet<string>, reply: ClauseTerms, user: ClauseTerms): boolean {
  for (const term of [...atoms, ...segmentTerms(query)]) if (reply.terms.has(term) && !user.terms.has(term)) return true;
  for (const run of digitRuns(query)) if (reply.digits.has(run) && !user.digits.has(run)) return true;
  return false;
}

/** The turn's items go from the ledger (it got no sources). */
function dropTurn(nodeId: string, turnId: string): void {
  const ledger = ledgers.get(nodeId);
  ledger?.turns.delete(turnId);
}

/**
 * The turn finalized: it joins the carried turns, and the items of the turns
 * that dropped out go (a conversation runs one turn at a time, so no other
 * turn of it is running now).
 */
function settleLedger(ledger: NodeLedger, turnId: string): void {
  ledger.order = [...ledger.order.filter((id) => id !== turnId), turnId].slice(-LIMITS.carriedTurns);
  for (const id of [...ledger.turns.keys()]) {
    if (!ledger.order.includes(id)) ledger.turns.delete(id);
  }
}

/**
 * A turn finalized (ChatHub.onTurnFinalized, after recallIndex.indexTurn):
 * stores which of what its session was given its reply repeated, at most
 * LIMITS.sources, checking at most LIMITS.evaluated
 * candidates in priority order (fewer in a large workspace: evaluatedDocs). Only a completed turn a person typed whose
 * recall document exists and is not hidden, of an owner whose memory is on,
 * gets rows; the rows exist when this returns. Returns what it considered
 * and stored (an evaluation records it); null when the turn gets none. Never
 * throws.
 */
export function attributeTurn(turn: AttributionTurn): TurnAttribution | null {
  const started = performance.now();
  try {
    const result = attribute(turn);
    if (result) {
      log.debug('workspace', 'reply sources', {
        turnId: turn.turnId, candidates: result.candidates.length, evaluated: result.evaluated, used: result.used.length,
        ms: Math.round((performance.now() - started) * 10) / 10,
      });
    }
    return result;
  } catch (error) {
    log.warn('workspace', 'reply sources: a turn was not attributed', { turnId: turn?.turnId, error: error instanceof Error ? error.message : String(error) });
    if (turn?.nodeId && turn.turnId) dropTurn(turn.nodeId, turn.turnId);
    return null;
  }
}

function attribute(turn: AttributionTurn): TurnAttribution | null {
  if (!turn?.nodeId || !turn.turnId) return null;
  const none = () => { dropTurn(turn.nodeId, turn.turnId); return null; };
  if (turn.persisted === false || turn.humanOrigin !== true) return none();
  if ((turn.outcome !== undefined && turn.outcome !== 'completed') || (turn.status !== undefined && turn.status !== 'ended')) return none();
  const doc = prepareCached(TURN_DOC_SQL).get(turn.turnId) as TurnDoc | undefined;
  if (!doc || doc.hidden === 1 || !doc.snippet) return none();
  const ownerUserId = doc.owner_user_id;
  if (process.env.MICHI_CLOUD === '1' && turn.ownerUserId && turn.ownerUserId !== ownerUserId) return none();
  if ((readMemoryMode(ownerUserId) ?? 'auto') === 'off') return none();
  const ledger = ledgerOf(ownerUserId, turn.nodeId, false);
  // Candidates: this turn's searches first, then the pack's related memories, then the pinned sections, the earlier turns' after this one's.
  const pools: LedgerItem[][] = ledger ? [
    ledger.turns.get(turn.turnId) ?? [],
    ...[...ledger.order].reverse().filter((id) => id !== turn.turnId).map((id) => ledger.turns.get(id) ?? []),
    ledger.pinned,
  ] : [];
  const ordered = pools.flatMap((pool, poolIndex) => pool.map((item, index) => ({ item, poolIndex, index })))
    .sort((a, b) => SECTION_RANK[a.item.section] - SECTION_RANK[b.item.section] || a.poolIndex - b.poolIndex || a.index - b.index);
  const seen = new Set<string>();
  const candidates: LedgerItem[] = [];
  for (const { item } of ordered) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    candidates.push(item);
  }
  const memories = new Map(storedMemories(ownerUserId, candidates.map((item) => item.id)).map((stored) => [stored.record.id, stored]));
  const reply = stripSentinelsStreamingSafe(turn.assistantText ?? '');
  const userWords = [turn.userText ?? '', ...(turn.steers ?? []).map((steer) => steer?.text ?? ''), turn.quotedText ?? ''].join('\n');
  const replyTerms = clauseTerms(reply);
  const userTerms = clauseTerms(userWords);
  const terms = docTerms(doc);
  // The checks of this turn read the index once between them (nothing writes to it meanwhile), and fewer of them run in a
  // large workspace.
  const memo = createRecallMemo();
  const documents = doc.workspace_id ? (prepareCached(WORKSPACE_DOCS_SQL).get(doc.workspace_id) as { n: number }).n : 0;
  const checks = Math.max(1, Math.min(LIMITS.evaluated, Math.floor(LIMITS.evaluatedDocs / Math.max(1, documents))));
  const considered: LedgerItem[] = [];
  const used: LedgerItem[] = [];
  let evaluated = 0;
  for (const item of candidates) {
    if (evaluated >= checks) break;
    const stored = memories.get(item.id);
    // What this turn itself saved or corrected is no source of its reply.
    if (!memoryShowable(stored, ownerUserId, doc.workspace_id) || stored.record.source?.turnId === turn.turnId) continue;
    const query = memoryQuery(stored.record);
    const keys = stored.record.keywords ?? [];
    considered.push(item);
    // Prefilter: a document holding none of the query's index terms cannot match it (no search needed).
    const atoms = queryAtoms(query);
    if (![...atoms].some((atom) => terms.has(atom))) continue;
    // Nor can the reply add what it holds when no term of it is in the reply and missing from the user's words, nor a number.
    if (!replyCouldAdd(query, atoms, replyTerms, userTerms)) continue;
    evaluated += 1;
    gateCalls += 1;
    // The reply's own turn does not make what it repeats look common (it holds every term it repeats).
    const matched = doc.workspace_id ? recallTurnMatch({ ownerUserId, workspaceId: doc.workspace_id, query, docId: doc.id, memo, excludeSelf: true }) : null;
    if (!matched || !replyAdds(matched, query, keys, replyTerms, userTerms)) continue;
    used.push(item);
  }
  const kept = used.slice(0, LIMITS.sources);
  const now = Date.now();
  memoryTransaction(() => {
    prepareCached('DELETE FROM memory_turn_sources WHERE turn_id = ?').run(turn.turnId);
    const insert = prepareCached(`INSERT OR IGNORE INTO memory_turn_sources (turn_id, item_kind, item_id, owner_user_id, node_id, rank, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    kept.forEach((item, rank) => {
      insert.run(turn.turnId, 'memory', item.id, ownerUserId, turn.nodeId, rank, now);
    });
    markMemoriesUsed(ownerUserId, kept.map((item) => item.id), now);
  });
  if (ledger) settleLedger(ledger, turn.turnId);
  return { docId: doc.id, candidates: considered, evaluated, used: kept };
}

// ── reading ──────────────────────────────────────────────────────────────────

interface SourceRow { turn_id: string; item_id: string; rank: number }

/** The user message of a turn, for a source link that opens it. */
function userMessageOf(turnId: string | null | undefined): string | null {
  if (!turnId) return null;
  return (prepareCached('SELECT user_message_id FROM turns WHERE turn_id = ?').get(turnId) as { user_message_id: string | null } | undefined)?.user_message_id ?? null;
}

/** A memory as a view shows it: itself while active; the note it was merged into when consolidation put it away; nothing else. */
function shownMemory(ownerUserId: string, stored: StoredMemory | undefined): StoredMemory | null {
  if (!stored) return null;
  if (stored.record.status === 'active') return stored;
  if (stored.record.status !== 'superseded') return null;
  if (!consolidationRows(ownerUserId, [stored.record.id])[0]?.mergedIntoId) return null; // corrected: no longer what it said
  return currentCorrection(ownerUserId, stored.record.id);
}

function memorySource(stored: StoredMemory): ReplyMemorySource {
  const { record } = stored;
  const nodeId = record.source?.nodeId;
  return {
    kind: 'memory', memoryId: record.id, text: record.body,
    savedBy: record.origin === 'explicit' ? 'user' : record.importSource ? 'import' : 'michi',
    ...(record.importSource ? { importSource: record.importSource } : {}),
    at: record.observedAt ?? record.createdAt,
    from: stored.sourceTitle && nodeId ? { nodeId, messageId: record.source?.messageId ?? userMessageOf(record.source?.turnId), title: stored.sourceTitle } : null,
  };
}

/**
 * GET /api/nodes/:nodeId/memory-sources: for each of these assistant
 * messages of the owner's conversation, what its reply was based on, each
 * item checked again now. Another owner's conversation, or one in Trash, is
 * not_found; with memory off for the owner or in the conversation, nothing.
 * Message ids of other conversations, or inherited from a parent, name no
 * turn here and answer nothing.
 */
export function replySourcesView(caller: MemoryCaller, nodeId: string, messageIds: readonly string[]): ReplyMemorySourcesResponse {
  const mode = getConversationMemoryMode(caller, nodeId);
  const ownerUserId = caller.ownerUserId;
  if (mode === 'off' || getMemorySettings(ownerUserId).mode === 'off' || messageIds.length === 0) return { messages: [] };
  const workspaceId = conversationWorkspaceId(nodeId);
  const turns = getDb().prepare(`SELECT turn_id, assistant_message_id FROM turns WHERE node_id = ? AND assistant_message_id IN (SELECT value FROM json_each(?))`)
    .all(nodeId, JSON.stringify([...new Set(messageIds)])) as Array<{ turn_id: string; assistant_message_id: string }>;
  if (turns.length === 0) return { messages: [] };
  const rows = getDb().prepare(`SELECT turn_id, item_id, rank FROM memory_turn_sources
      WHERE owner_user_id = ? AND node_id = ? AND item_kind = 'memory' AND turn_id IN (SELECT value FROM json_each(?)) ORDER BY turn_id, rank`)
    .all(ownerUserId, nodeId, JSON.stringify(turns.map((row) => row.turn_id))) as unknown as SourceRow[];
  const memories = new Map(storedMemories(ownerUserId, [...new Set(rows.map((row) => row.item_id))]).map((stored) => [stored.record.id, stored]));
  const messages: ReplyMemorySourcesResponse['messages'] = [];
  for (const { turn_id: turnId, assistant_message_id: messageId } of turns) {
    const sources: ReplyMemorySource[] = [];
    const shown = new Set<string>();
    for (const row of rows) {
      if (row.turn_id !== turnId) continue;
      const stored = shownMemory(ownerUserId, memories.get(row.item_id));
      if (!stored || shown.has(stored.record.id) || !memoryShowable(stored, ownerUserId, workspaceId)) continue;
      shown.add(stored.record.id);
      sources.push(memorySource(stored));
    }
    if (sources.length > 0) messages.push({ messageId, sources });
  }
  return { messages };
}

/**
 * Forget what the ledger holds between test cases.
 * @testonly
 */
export function resetReplySources(): void {
  ledgers.clear();
  gateCalls = 0;
}
