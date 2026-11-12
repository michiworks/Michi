import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_KEYWORDS_MAX_COUNT,
  MEMORY_KEYWORD_MAX_CHARS,
  type MemoryImportSource,
  type MemoryKind,
  type MemoryOrigin,
  type MemoryRecord,
  type MemorySourceRisk,
  type MemoryStatus,
} from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID, workspaceOwnerMatches } from '../agentOwner';
import { getDb, openDbOrNull, prepareCached, runInTransaction } from '../db';
import { log } from '../logger';
import { stripSentinelsStreamingSafe } from '../messageSerialization';
import { companionTaintOf } from '../turnTrust';
import { learnsFromConversation, learnsInWorkspace } from './assistantConversation';
import { insertExtractionTombstone, memoryBodyHash, turnTombstoned } from './extractionRepository';
import { memoriesAfterRow, memoryTransaction, nextUnusedId, readMemoryMode } from './memoryRepository';
import {
  COMMON_TERMS, WEAK_TERMS, locateTerm, normalizeText, profileConcepts, profileKeywords, queryConcepts, segmentTerms,
  type RecallConcept,
} from './memoryTerms';
import { relayedInput } from './typedText';

/**
 * Michi Memory's recall index (spec §3; tables from migrations 0071 and
 * 0073): one document per memory and one per completed human turn,
 * searchable in Chinese, English and mixed text (memoryTerms.ts).
 *
 *  - Memory documents follow every write memoryService makes (indexMemory,
 *    removeMemory, inside its transactions): body and keywords; active only
 *    while the memory is, so a superseded memory stays findable only with
 *    includeInactive.
 *  - Turn documents (indexTurn, from ChatHub.onTurnFinalized): what the user
 *    typed (steers included) and the reply, at the user message's time, with
 *    the conversation's title. The snippet keeps each side's head and tail;
 *    content keeps up to TURN_INDEX_CHARS of each. Only completed turns a
 *    person typed in ordinary chats and V (the user's conversation with their
 *    Michi assistant: assistantConversation.ts): never self-turns (thread
 *    messages, scheduled jobs), maintenance, page, digest or Scheduled-only
 *    threads, or anything else of a system workspace (a check-in's node, a
 *    post). A turn that took in check-in or collector material
 *    (turnTrust.companionTaintOf) is indexed as what the user typed alone, as
 *    extraction reads it: such material never reaches another conversation
 *    from here. Nothing is indexed for an owner whose memory is off.
 *  - Hiding: a forgotten memory's document goes with it; conversation turns
 *    are chat history, which forgetting a memory leaves as it is (as
 *    ChatGPT's and Claude's chat history). A turn document is hidden only
 *    when the user asks Michi not to recall that excerpt (the reply footer's
 *    Don't recall, forgetConversationTurn), when its conversation stops
 *    learning (hideConversationTurns) and when the user deletes all their
 *    memories (resetOwnerRecall). A hidden document keeps no text and no
 *    index entry, no search returns it, indexing its turn again leaves it
 *    hidden, and an extraction tombstone keeps extraction from reading the
 *    footer's turn into a memory. A turn the user asked to forget what it
 *    says (memory_delete with its c: ref) is only kept out of automatic
 *    memory (keepTurnOutOfMemory): recall still shows it. Deleting a
 *    conversation takes its turn documents (0071's triggers), never the
 *    memories saved from it.
 *  - startRecallBackfill indexes what existed before, once per database and
 *    index version, in short slices that yield to the event loop.
 *  - recallSearch ranks by how much of the query a document covers, weighted
 *    by how rare each part is, then gates out weak matches. Automatic recall
 *    matches a turn by what its snippet shows; a search the agent asks for
 *    also by its whole content.
 *
 * Every read names its owner. On the desktop that is the local user
 * (requestAgentOwnerOrNull); in the cloud, the workspace's owner. A purge removes the
 * documents with the workspace or conversation (0071's triggers and
 * memoryRepository's purges).
 */

export type RecallDocKind = 'memory' | 'turn';

// ── documents ────────────────────────────────────────────────────────────────

interface DocFields {
  ownerUserId: string;
  workspaceId: string | null;
  refId: string;
  nodeId: string | null;
  turnId: string | null;
  at: number;
  title: string | null;
  snippet: string;
  active: boolean;
  /** One keyphrase per line; undefined keeps the stored ones. */
  keys?: string;
  /** A turn's whole indexed text, when the snippet cut it (memory_recall_docs.content). */
  content?: string | null;
}

interface StoredDoc {
  id: number;
  title: string | null;
  snippet: string;
  keys: string;
  content: string | null;
  hidden: number;
}

/**
 * Excerpt terms (title, snippet, keys): what automatic recall matches. Full
 * terms: those of a turn's content its snippet lacks, which a search the
 * agent asks for matches too; the two hold no snippet term twice.
 */
type TermsTable = 'memory_recall_fts' | 'memory_recall_full_fts';
const FULL: TermsTable = 'memory_recall_full_fts';

/** The index entry of a document: its title (conversations only), snippet and keys, as memoryTerms terms. */
function termsOf(kind: RecallDocKind, title: string | null, snippet: string, keys: string): string {
  return segmentTerms(kind === 'turn' && title ? `${title}\n${snippet}\n${keys}` : `${snippet}\n${keys}`).join(' ');
}

function writeTerms(id: number, terms: string, replace: boolean, table: TermsTable = 'memory_recall_fts'): void {
  if (replace) prepareCached(`DELETE FROM ${table} WHERE rowid = ?`).run(id);
  if (terms) prepareCached(`INSERT INTO ${table} (rowid, terms) VALUES (?, ?)`).run(id, terms);
}

function fullTermsOf(content: string | null, snippet: string): string {
  if (!content) return '';
  const shown = new Set(segmentTerms(snippet));
  return segmentTerms(content).filter((term) => !shown.has(term)).join(' ');
}

interface WriteOptions {
  /** Rewrite both index entries even when the text did not change (the backfill brings older documents up to this index). */
  reindex?: boolean;
}

/**
 * Insert or update a document (unique per kind and ref); its index entries
 * are rewritten only when its text changed. A hidden document stays as it
 * is (null): what the user asked Michi to forget is never indexed again.
 */
function writeDoc(kind: RecallDocKind, fields: DocFields, options: WriteOptions = {}): number | null {
  return memoryTransaction(() => {
    const existing = prepareCached(`SELECT id, title, snippet, keys, content, hidden FROM memory_recall_docs
        WHERE doc_kind = ? AND ref_id = ?`).get(kind, fields.refId) as StoredDoc | undefined;
    if (existing?.hidden === 1) return null;
    const keys = fields.keys ?? existing?.keys ?? '';
    const content = fields.content ?? null;
    const active = fields.active ? 1 : 0;
    if (existing) {
      prepareCached(`UPDATE memory_recall_docs SET owner_user_id = ?, workspace_id = ?, node_id = ?, turn_id = ?, at = ?,
          title = ?, snippet = ?, keys = ?, active = ?, content = ? WHERE id = ?`)
        .run(fields.ownerUserId, fields.workspaceId, fields.nodeId, fields.turnId, fields.at, fields.title, fields.snippet, keys, active,
          content, existing.id);
      if (options.reindex || existing.title !== fields.title || existing.snippet !== fields.snippet || existing.keys !== keys) {
        writeTerms(existing.id, termsOf(kind, fields.title, fields.snippet, keys), true);
      }
      if (options.reindex || existing.content !== content || existing.snippet !== fields.snippet) {
        writeTerms(existing.id, fullTermsOf(content, fields.snippet), true, FULL);
      }
      return existing.id;
    }
    // A conversation's id is its c: ref (memoryRefs.ts): never reuse a deleted document's.
    const id = nextUnusedId('memory_recall_docs');
    prepareCached(`INSERT INTO memory_recall_docs (id, owner_user_id, workspace_id, doc_kind, ref_id, node_id, turn_id, at,
        title, snippet, keys, active, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, fields.ownerUserId, fields.workspaceId, kind, fields.refId, fields.nodeId, fields.turnId, fields.at, fields.title, fields.snippet,
        keys, active, content);
    writeTerms(id, termsOf(kind, fields.title, fields.snippet, keys), false);
    writeTerms(id, fullTermsOf(content, fields.snippet), false, FULL);
    return id;
  });
}

/** A document's text and index entries go; the row stays, hidden, so the turn is never indexed again. */
function hideDoc(id: number): void {
  prepareCached(`UPDATE memory_recall_docs SET hidden = 1, title = NULL, snippet = '', content = NULL, keys = '' WHERE id = ?`).run(id);
  writeTerms(id, '', true);
  writeTerms(id, '', true, FULL);
}

/**
 * A memory document's keys: its keywords, its topic, and the words of every
 * profile category its text states (memoryTerms.profileKeywords), whoever
 * saved it, so a question that names only the category ("where do I work?")
 * or the topic finds it.
 */
function memoryKeys(record: MemoryRecord): string {
  const keywords = record.topic && !(record.keywords ?? []).some((keyword) => normalizeText(keyword) === normalizeText(record.topic!))
    ? [...(record.keywords ?? []), record.topic]
    : record.keywords ?? [];
  const seen = new Set(keywords.map((keyword) => normalizeText(keyword)));
  const bridge = profileKeywords(`${record.body}\n${keywords.join('\n')}`).filter((word) => !seen.has(normalizeText(word)));
  return [...keywords, ...bridge].join('\n');
}

function memoryFields(record: MemoryRecord): DocFields {
  return {
    ownerUserId: record.ownerUserId,
    workspaceId: record.scope.kind === 'workspace' ? record.scope.workspaceId : null,
    refId: record.id,
    nodeId: record.source?.nodeId ?? null,
    turnId: record.source?.turnId ?? null,
    at: record.observedAt ?? record.createdAt,
    title: null,
    snippet: record.body,
    keys: memoryKeys(record),
    active: record.status === 'active',
  };
}

/**
 * Index a memory as stored now (any status; searchable by default only while
 * active). memoryService calls it inside each write's transaction; a failure
 * is logged and never fails the write (the memory's next write indexes it
 * again).
 */
export function indexMemory(record: MemoryRecord): void {
  try {
    writeDoc('memory', memoryFields(record));
  } catch (error) {
    log.warn('workspace', 'recall index: memory not indexed', { memoryId: record.id, error: (error as Error).message });
  }
}

/** Drop a deleted memory's document (its index entry goes with it: memory_recall_docs_ad). */
export function removeMemory(ownerUserId: string, memoryId: string): void {
  try {
    prepareCached("DELETE FROM memory_recall_docs WHERE doc_kind = 'memory' AND ref_id = ? AND owner_user_id = ?").run(memoryId, ownerUserId);
  } catch (error) {
    log.warn('workspace', 'recall index: memory document not removed', { memoryId, error: (error as Error).message });
  }
}

// ── conversations ────────────────────────────────────────────────────────────

/** In a snippet, the user's words and the reply each keep at most this much (head and tail). */
const TURN_PART_CHARS = 1_200;
/** In a turn's content (what a search the agent asks for matches, and a ref lookup reads), each side keeps at most this much. */
const TURN_INDEX_CHARS = 16_000;
/** Steers kept per turn. */
const MAX_STEERS = 20;
/** Between the user's words and the reply in a snippet and in content. */
const REPLY_MARK = '\n→ ';

/** Spaces collapsed; past `max` characters, the head (two thirds) and the tail around an ellipsis. */
function excerpt(text: string, max = TURN_PART_CHARS): string {
  const clean = text.replace(/[^\S\n]+/gu, ' ').replace(/ ?\n[\s]*\n\s*/gu, '\n\n').trim();
  const chars = [...clean];
  if (chars.length <= max) return clean;
  const head = Math.round((max * 2) / 3);
  const tail = max - head - 3;
  return `${chars.slice(0, head).join('').trimEnd()} … ${chars.slice(-tail).join('').trimStart()}`;
}

function joinTurn(user: string, reply: string): string {
  return reply ? `${user}${REPLY_MARK}${reply}` : user;
}

function splitTurn(text: string): { user: string; reply: string } {
  const split = text.indexOf(REPLY_MARK);
  return split < 0 ? { user: text, reply: '' } : { user: text.slice(0, split), reply: text.slice(split + REPLY_MARK.length) };
}

/** What the user typed, of a turn document's snippet or content (the part before the reply). */
export function turnUserWords(text: string): string {
  return splitTurn(text).user;
}

function cloudMode(): boolean {
  return process.env.MICHI_CLOUD === '1';
}

/** Whose memory a workspace's conversations belong to: its owner in the cloud, the local user on the desktop. */
function recallOwner(workspaceOwnerUserId: string | null): string | null {
  if (!cloudMode()) return LOCAL_AGENT_OWNER_ID;
  return workspaceOwnerUserId?.trim() || null;
}

/** Memory is on unless the owner turned it off (the retired 'explicit' counts as on). */
function memoryOn(ownerUserId: string): boolean {
  return (readMemoryMode(ownerUserId) ?? DEFAULT_MEMORY_SETTINGS.mode) !== 'off';
}

interface ConversationRow {
  title: string | null;
  workspace_id: string;
  kind: string;
  /** nodes.memory_mode: NULL is learn; use_only and off keep what is said in the conversation out of memory. */
  memory_mode: string | null;
  page_id: string | null;
  maintenance_job_id: string | null;
  scheduled_only_job_id: string | null;
  purged_at: number | null;
  owner_user_id: string | null;
  settings: string | null;
  workspace_purged_at: number | null;
}

/**
 * An ordinary chat thread (not a page, digest, maintenance or Scheduled-only
 * thread, nor of a system workspace but V: assistantConversation.ts) whose
 * memory setting learns from it.
 */
function recallableConversation(nodeId: string, row: ConversationRow | undefined): row is ConversationRow {
  return !!row && row.kind === 'chat' && row.page_id === null && row.maintenance_job_id === null
    && row.scheduled_only_job_id === null && row.purged_at === null && row.workspace_purged_at === null
    && row.memory_mode === null && learnsFromConversation(nodeId, row.settings);
}

const CONVERSATION_SQL = `SELECT n.title, n.workspace_id, n.kind, n.memory_mode, n.page_id, n.maintenance_job_id, n.scheduled_only_job_id,
    n.purged_at, w.owner_user_id, w.settings, w.purged_at AS workspace_purged_at
  FROM nodes n JOIN workspaces w ON w.id = n.workspace_id WHERE n.id = ?`;

interface TurnSource {
  ownerUserId: string;
  workspaceId: string;
  nodeId: string;
  turnId: string;
  title: string | null;
  userText: string;
  steers: readonly string[];
  assistantText: string;
  at: number;
}

/**
 * Write a turn's document (what the user typed, steers included, and the
 * reply), then bring the conversation's other documents up to its current
 * title (a title often arrives after the first turn). Null when the turn's
 * document is hidden (Don't recall, a conversation that stopped learning,
 * Delete all memories). A move to another workspace is followed by 0071's
 * memory_recall_docs_node_moved.
 */
function writeTurnDoc(source: TurnSource, options: WriteOptions = {}): number | null {
  return memoryTransaction(() => {
    const user = [source.userText, ...source.steers.slice(0, MAX_STEERS)].map((text) => text.trim()).filter(Boolean).join('\n');
    const reply = stripSentinelsStreamingSafe(source.assistantText);
    const snippet = joinTurn(excerpt(user), excerpt(reply));
    const content = joinTurn(excerpt(user, TURN_INDEX_CHARS), excerpt(reply, TURN_INDEX_CHARS));
    const id = writeDoc('turn', {
      ownerUserId: source.ownerUserId,
      workspaceId: source.workspaceId,
      refId: source.turnId,
      nodeId: source.nodeId,
      turnId: source.turnId,
      at: source.at,
      title: source.title,
      snippet,
      content: content === snippet ? null : content,
      active: true,
    }, options);
    if (id === null) return null;
    retitleDocs(source.nodeId, source.title);
    return id;
  });
}

/** The conversation's recallable documents get this title (and their index entries with it). */
function retitleDocs(nodeId: string, title: string | null): void {
  const stale = prepareCached(`SELECT id, snippet, keys FROM memory_recall_docs
      WHERE doc_kind = 'turn' AND node_id = ? AND title IS NOT ? AND hidden = 0 LIMIT 500`)
    .all(nodeId, title) as Array<{ id: number; snippet: string; keys: string }>;
  for (const doc of stale) {
    prepareCached('UPDATE memory_recall_docs SET title = ? WHERE id = ?').run(title, doc.id);
    writeTerms(doc.id, termsOf('turn', title, doc.snippet, doc.keys), true);
  }
}

/** A finished turn, as ChatHub.onTurnFinalized reports it (TurnFinalizedEvent fits; an eval harness builds one directly). */
export interface RecallTurn {
  /** The session's user; in the cloud it must be the workspace's owner. */
  ownerUserId: string | null;
  nodeId: string;
  turnId: string;
  /** A person typed userText (the composer route); nothing else is indexed. */
  humanOrigin: boolean;
  userText: string;
  /** When the user sent it (ms); default completedAt. */
  userMessageAt?: number | null;
  /** Messages a person steered into the turn. */
  steers?: ReadonlyArray<{ text: string }>;
  /** The visible reply. */
  assistantText?: string | null;
  /** The durable outcome; only 'completed' is indexed (absent counts as completed). */
  outcome?: string;
  /** False when the terminal commit failed: nothing is indexed. */
  persisted?: boolean;
  completedAt: number;
}

export interface IndexTurnOptions {
  /**
   * Whose memory the conversation's workspace belongs to, from the
   * workspace's stored owner. Default: that owner in the cloud, the local
   * user on the desktop (requestAgentOwnerOrNull's rule). An eval harness that keeps
   * owners apart in one desktop database passes (id) => id.
   */
  ownerFor?: (workspaceOwnerUserId: string | null) => string | null;
}

/**
 * Index one finished turn (wired to ChatHub.onTurnFinalized in server.ts):
 * a completed turn a person typed, in an ordinary chat thread that learns
 * (its memory setting is learn), of an owner whose memory is on. True when a
 * document was written (not when the turn was hidden). Never throws.
 */
export function indexTurn(turn: RecallTurn, options: IndexTurnOptions = {}): boolean {
  try {
    if (!turn || turn.humanOrigin !== true || turn.persisted === false) return false;
    if (turn.outcome !== undefined && turn.outcome !== 'completed') return false;
    const steers = (turn.steers ?? []).map((steer) => (typeof steer?.text === 'string' ? steer.text : '')).filter((text) => text.trim());
    const userText = typeof turn.userText === 'string' ? turn.userText : '';
    if (!userText.trim() && steers.length === 0) return false;
    const row = prepareCached(CONVERSATION_SQL).get(turn.nodeId) as ConversationRow | undefined;
    if (!recallableConversation(turn.nodeId, row)) return false;
    const ownerUserId = (options.ownerFor ?? recallOwner)(row.owner_user_id);
    if (!ownerUserId || !workspaceOwnerMatches(row.owner_user_id, ownerUserId)) return false;
    if (cloudMode() && turn.ownerUserId && turn.ownerUserId !== ownerUserId) return false;
    if (!memoryOn(ownerUserId)) return false;
    const at = Number.isFinite(turn.userMessageAt) ? Number(turn.userMessageAt) : turn.completedAt;
    const companion = companionTaintOf({ nodeId: turn.nodeId, turnId: turn.turnId }) !== null;
    return writeTurnDoc({
      ownerUserId, workspaceId: row.workspace_id, nodeId: turn.nodeId, turnId: turn.turnId, title: row.title,
      userText, steers, assistantText: !companion && typeof turn.assistantText === 'string' ? turn.assistantText : '', at,
    }) !== null;
  } catch (error) {
    log.warn('workspace', 'recall index: turn not indexed', { turnId: turn?.turnId, error: (error as Error)?.message ?? String(error) });
    return false;
  }
}

/** Keyphrases as memory keywords are kept: trimmed, one line each, distinct once folded (normalizeText), within the shared limits. */
function normalizeKeys(keys: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of keys) {
    if (typeof value !== 'string') continue;
    const key = value.replace(/\s+/gu, ' ').trim();
    if (!key || key.length > MEMORY_KEYWORD_MAX_CHARS) continue;
    const identity = normalizeText(key);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(key);
    if (out.length >= MEMORY_KEYWORDS_MAX_COUNT) break;
  }
  return out;
}

/**
 * Replace the keyphrases of a turn's document (extraction's bilingual keys)
 * and index them with it. False when the owner has no document for the turn,
 * or a hidden one.
 */
export function setTurnKeys(ownerUserId: string, turnId: string, keys: readonly string[]): boolean {
  return memoryTransaction(() => {
    const doc = prepareCached(`SELECT id, title, snippet, keys, content, hidden FROM memory_recall_docs
        WHERE doc_kind = 'turn' AND ref_id = ? AND owner_user_id = ?`).get(turnId, ownerUserId) as StoredDoc | undefined;
    if (!doc || doc.hidden === 1) return false;
    const joined = normalizeKeys(keys).join('\n');
    if (doc.keys === joined) return true;
    prepareCached('UPDATE memory_recall_docs SET keys = ? WHERE id = ?').run(joined, doc.id);
    writeTerms(doc.id, termsOf('turn', doc.title, doc.snippet, joined), true);
    return true;
  });
}

// ── forgetting ───────────────────────────────────────────────────────────────

/** No memory body is empty: a tombstone with this hash bars only its source turn (extractionRepository.tombstoneBlocks). */
const TURN_TOMBSTONE_HASH = memoryBodyHash('');

/**
 * Automatic extraction never reads this turn into a memory, even before its
 * first run (an extraction tombstone; extractionRun.readExtractionTurn skips
 * it). Recall still shows the turn: chat history stays as it is. Once is
 * enough: a turn a removal names already is left as it is.
 */
function keepTurnOutOfMemory(ownerUserId: string, turnId: string, workspaceId: string | null): void {
  if (turnTombstoned(ownerUserId, turnId)) return;
  insertExtractionTombstone({ ownerUserId, workspaceId, sourceTurnId: turnId, bodyHash: TURN_TOMBSTONE_HASH, reason: 'deleted', now: Date.now() });
}

/**
 * After the owner deleted all their memories (memoryService.resetMemories):
 * the memories' documents go, and every conversation turn's document is
 * hidden (its text and index entries go; the row stays, so the turn is never
 * indexed again). Returns how many turn documents it hid.
 */
export function resetOwnerRecall(ownerUserId: string): number {
  return memoryTransaction(() => {
    const db = getDb();
    db.prepare("DELETE FROM memory_recall_docs WHERE owner_user_id = ? AND doc_kind = 'memory'").run(ownerUserId);
    for (const table of ['memory_recall_fts', 'memory_recall_full_fts']) {
      db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT id FROM memory_recall_docs WHERE owner_user_id = ? AND doc_kind = 'turn' AND hidden = 0)`)
        .run(ownerUserId);
    }
    const hidden = db.prepare(`UPDATE memory_recall_docs SET hidden = 1, title = NULL, snippet = '', content = NULL, keys = ''
      WHERE owner_user_id = ? AND doc_kind = 'turn' AND hidden = 0`).run(ownerUserId);
    return Number(hidden.changes);
  });
}

/**
 * Hide every indexed turn of a conversation that stopped learning (its
 * memory setting became use_only or off): automatic recall and memory_search
 * no longer show what was said in it, and indexing it again changes nothing.
 * Returns how many documents it hid.
 */
export function hideConversationTurns(ownerUserId: string, nodeId: string): number {
  return memoryTransaction(() => {
    const docs = prepareCached(`SELECT id FROM memory_recall_docs
        WHERE doc_kind = 'turn' AND node_id = ? AND owner_user_id = ? AND hidden = 0`).all(nodeId, ownerUserId) as Array<{ id: number }>;
    for (const doc of docs) hideDoc(doc.id);
    return docs.length;
  });
}

/**
 * Hide the past-conversation turn a c: ref names, when this scope may read
 * it (recallDocument's rules), and bar extraction from it: the user asked
 * Michi not to recall it (the reply footer's Don't recall, as ChatGPT's
 * "Don't mention this again"). True too when the owner's turn is hidden
 * already; false when there is no such turn. The conversation itself is
 * unchanged.
 */
export function forgetConversationTurn(query: RecallDocumentQuery): boolean {
  const hit = recallDocument({ ...query, kinds: ['turn'] });
  if (!hit || hit.kind !== 'turn') return conversationTurnHidden(query?.ownerUserId, query?.docId);
  memoryTransaction(() => {
    hideDoc(hit.docId);
    if (hit.turnId) keepTurnOutOfMemory(query.ownerUserId.trim(), hit.turnId, hit.workspaceId);
  });
  return true;
}

/**
 * Keep the past-conversation turn a c: ref names, when this scope may read it
 * (recallDocument's rules), out of automatic memory (keepTurnOutOfMemory):
 * the user asked to forget what it says (memory_delete with a c: ref). Recall
 * still shows it, as ChatGPT's and Claude's chat history; only deleting the
 * conversation removes it. Returns the turn's id, also when the owner's turn
 * is hidden already; null when there is no such turn.
 */
export function keepConversationTurnOutOfMemory(query: RecallDocumentQuery): string | null {
  const hit = recallDocument({ ...query, kinds: ['turn'] });
  if (!hit || hit.kind !== 'turn') return hiddenTurnId(query?.ownerUserId, query?.docId);
  if (hit.turnId) keepTurnOutOfMemory(query.ownerUserId.trim(), hit.turnId, hit.workspaceId);
  return hit.turnId ?? hit.refId;
}

/** The turn of the owner's past-conversation document with this id (a c: ref's) when it is hidden already, else null. */
function hiddenTurnId(ownerUserId: unknown, docId: unknown): string | null {
  const owner = typeof ownerUserId === 'string' ? ownerUserId.trim() : '';
  if (!owner || !Number.isSafeInteger(docId)) return null;
  const row = prepareCached(`SELECT ref_id FROM memory_recall_docs WHERE id = ? AND owner_user_id = ? AND doc_kind = 'turn' AND hidden = 1`)
    .get(docId as number, owner) as { ref_id: string } | undefined;
  return row?.ref_id ?? null;
}

/** Whether the owner's past-conversation turn with this document id (a c: ref's) is hidden already. */
export function conversationTurnHidden(ownerUserId: unknown, docId: unknown): boolean {
  return hiddenTurnId(ownerUserId, docId) !== null;
}

// ── backfill ─────────────────────────────────────────────────────────────────

/**
 * meta key: how far the backfill got ('memories:<row id>', 'turns:<row id>',
 * then 'done'). v2 (migration 0073) indexes every turn's content, v3 folds
 * word endings (cooked → cook), v5 adds every memory's profile category
 * words (memoryKeys). Turn documents an earlier version wrote without what
 * the user declined keep that text out: no later version indexes them again.
 */
const BACKFILL_META_KEY = 'memory_recall_backfill_v5';

export interface RecallBackfillResult {
  memories: number;
  turns: number;
  /** False when it stopped early (the database closed); it resumes from its cursor next time. */
  done: boolean;
}

export interface RecallBackfillOptions {
  /** Rows read per query. Default 25. */
  batchSize?: number;
  /** Work per slice before yielding to the event loop (at least one batch). Default 15 ms. */
  sliceMs?: number;
  /** Pause between slices. Default 5 ms. */
  pauseMs?: number;
}

interface BackfillCursor {
  phase: 'memories' | 'turns' | 'done';
  after: number;
}

function readCursor(): BackfillCursor {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(BACKFILL_META_KEY) as { value: string } | undefined;
  const match = /^(memories|turns):(\d+)$/u.exec(row?.value ?? '');
  if (row?.value === 'done') return { phase: 'done', after: 0 };
  return match ? { phase: match[1] as 'memories' | 'turns', after: Number(match[2]) } : { phase: 'memories', after: 0 };
}

function writeCursor(cursor: BackfillCursor): void {
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(BACKFILL_META_KEY, cursor.phase === 'done' ? 'done' : `${cursor.phase}:${cursor.after}`);
}

interface BackfillTurnRow {
  row_id: number;
  turn_id: string;
  node_id: string;
  completed_at: number | null;
  user_head: string | null;
  user_tail: string | null;
  user_length: number | null;
  user_at: number | null;
  user_seq: number | null;
  user_metadata: string | null;
  assistant_head: string | null;
  assistant_tail: string | null;
  assistant_length: number | null;
  assistant_seq: number | null;
  title: string | null;
  workspace_id: string;
  owner_user_id: string | null;
  settings: string | null;
}

/** Characters read from a stored message: the head, and the tail of a longer one (more than content keeps of either). */
const STORED_HEAD_CHARS = 16_000;
const STORED_TAIL_CHARS = 8_000;
/** The rest of a message after its head, at most STORED_TAIL_CHARS of its end. */
const storedTail = (column: string) => `CASE WHEN length(${column}) > ${STORED_HEAD_CHARS}
    THEN substr(${column}, max(${STORED_HEAD_CHARS + 1}, length(${column}) - ${STORED_TAIL_CHARS - 1})) END`;

/**
 * Composer turns only: a foreground turn's assistant message id is a-<node>-<turn>
 * (ChatHub.beginTurn; self-turns use self-), and only the composer starts one.
 */
const BACKFILL_TURNS_SQL = `SELECT t.rowid AS row_id, t.turn_id, t.node_id, t.completed_at,
    substr(u.content, 1, ${STORED_HEAD_CHARS}) AS user_head, ${storedTail('u.content')} AS user_tail,
    length(u.content) AS user_length, u.created_at AS user_at, u.seq AS user_seq, u.metadata AS user_metadata,
    substr(a.content, 1, ${STORED_HEAD_CHARS}) AS assistant_head, ${storedTail('a.content')} AS assistant_tail,
    length(a.content) AS assistant_length, a.seq AS assistant_seq,
    n.title, n.workspace_id, w.owner_user_id, w.settings
  FROM turns t
  JOIN nodes n ON n.id = t.node_id
  JOIN workspaces w ON w.id = n.workspace_id
  LEFT JOIN messages u ON u.id = t.user_message_id
  LEFT JOIN messages a ON a.id = t.assistant_message_id
  WHERE t.rowid > ? AND t.status = 'completed' AND t.user_message_id IS NOT NULL AND t.assistant_message_id LIKE 'a-%'
    AND n.kind = 'chat' AND n.page_id IS NULL AND n.maintenance_job_id IS NULL AND n.scheduled_only_job_id IS NULL
    AND n.memory_mode IS NULL AND n.purged_at IS NULL AND w.purged_at IS NULL
  ORDER BY t.rowid LIMIT ?`;

function storedText(head: string | null, tail: string | null, length: number | null): string {
  if (!head) return '';
  if (!tail) return head;
  return (length ?? 0) > STORED_HEAD_CHARS + STORED_TAIL_CHARS ? `${head}\n…\n${tail}` : `${head}${tail}`;
}

/** User messages between a turn's own message and its reply: what was steered into it. */
const BACKFILL_STEERS_SQL = `SELECT substr(content, 1, ${TURN_INDEX_CHARS}) AS content FROM messages
  WHERE node_id = ? AND role = 'user' AND seq > ? AND seq < ? ORDER BY seq LIMIT ${MAX_STEERS}`;

/** One page of turns after a row id: how many rows were read, and the last row id. */
function backfillTurns(after: number, limit: number, modes: Map<string, boolean>, counts: { turns: number }): { read: number; last: number } {
  const rows = prepareCached(BACKFILL_TURNS_SQL).all(after, limit) as unknown as BackfillTurnRow[];
  let last = after;
  for (const row of rows) {
    last = row.row_id;
    if (!learnsFromConversation(row.node_id, row.settings) || relayedInput(row.user_metadata)) continue;
    const ownerUserId = recallOwner(row.owner_user_id);
    if (!ownerUserId) continue;
    if (!modes.has(ownerUserId)) modes.set(ownerUserId, memoryOn(ownerUserId));
    if (!modes.get(ownerUserId)) continue;
    const userText = storedText(row.user_head, row.user_tail, row.user_length);
    if (!userText.trim()) continue;
    const steers = row.user_seq !== null && row.assistant_seq !== null
      ? (prepareCached(BACKFILL_STEERS_SQL).all(row.node_id, row.user_seq, row.assistant_seq) as Array<{ content: string }>)
        .map((steer) => steer.content)
      : [];
    const at = row.user_at ?? row.completed_at ?? 0;
    if (backfillOne('turn', row.turn_id, () => writeTurnDoc({
      ownerUserId, workspaceId: row.workspace_id, nodeId: row.node_id, turnId: row.turn_id, title: row.title, userText, steers,
      assistantText: companionTaintOf({ nodeId: row.node_id, turnId: row.turn_id }) !== null ? ''
        : storedText(row.assistant_head, row.assistant_tail, row.assistant_length), at,
    }, { reindex: true }) !== null)) counts.turns += 1;
  }
  return { read: rows.length, last };
}

/** One document; a failure (its savepoint rolled back) is logged and skipped so it cannot hold the backfill up. */
function backfillOne(kind: RecallDocKind, refId: string, write: () => boolean): boolean {
  try {
    return write();
  } catch (error) {
    log.warn('workspace', 'recall index backfill skipped a document', { kind, refId, error: (error as Error).message });
    return false;
  }
}

let backfillRun: Promise<RecallBackfillResult> | null = null;

async function runBackfill(options: RecallBackfillOptions): Promise<RecallBackfillResult> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 25));
  const sliceMs = Math.max(1, options.sliceMs ?? 15);
  const pauseMs = Math.max(0, options.pauseMs ?? 5);
  const counts = { memories: 0, turns: 0 };
  const modes = new Map<string, boolean>();
  const startedAt = Date.now();
  for (;;) {
    // The database closed (shutdown, a test's teardown): stop; the cursor resumes it next time.
    if (!openDbOrNull()) return { ...counts, done: false };
    const cursor = readCursor();
    if (cursor.phase === 'done') break;
    // A retried transaction (SQLITE_BUSY) runs this again from the same cursor; count only what committed.
    const slice = runInTransaction(() => {
      const sliceEnd = Date.now() + sliceMs;
      const done = { memories: 0, turns: 0 };
      let { phase, after } = cursor;
      while (phase !== 'done' && Date.now() < sliceEnd) {
        if (phase === 'memories') {
          const page = memoriesAfterRow(after, batchSize);
          for (const { rowId, record } of page) {
            if (backfillOne('memory', record.id, () => writeDoc('memory', memoryFields(record), { reindex: true }) !== null)) done.memories += 1;
            after = rowId;
          }
          if (page.length < batchSize) { phase = 'turns'; after = 0; }
        } else {
          const turns = backfillTurns(after, batchSize, modes, done);
          after = turns.last;
          if (turns.read < batchSize) phase = 'done';
        }
      }
      writeCursor({ phase, after });
      return done;
    });
    counts.memories += slice.memories;
    counts.turns += slice.turns;
    await new Promise<void>((resolve) => { setTimeout(resolve, pauseMs); });
  }
  if (counts.memories || counts.turns) {
    log.info('boot', 'memory recall index backfilled', { ...counts, durMs: Date.now() - startedAt });
  }
  return { ...counts, done: true };
}

/**
 * Index the memories and completed human turns that existed before the
 * recall index, once per database and index version (meta key
 * memory_recall_backfill_v5), in slices of a few milliseconds that yield to
 * the event loop; indexing is idempotent, and hidden documents stay hidden,
 * so live writes meanwhile are harmless. A second call while one
 * runs returns the same promise. Rejects only on a database error; the next
 * start resumes from the cursor.
 */
export function startRecallBackfill(options: RecallBackfillOptions = {}): Promise<RecallBackfillResult> {
  backfillRun ??= runBackfill(options).finally(() => { backfillRun = null; });
  return backfillRun;
}

// ── search ───────────────────────────────────────────────────────────────────

export interface RecallSearchQuery {
  /** The memory owner (requestAgentOwnerOrNull: the local user on the desktop). */
  ownerUserId: string;
  /**
   * Workspaces whose conversations, and workspace-scope memories, are
   * searched; 'all' is every workspace of the owner recall may read. A
   * workspace in Trash, with AI navigation off, or a system workspace other
   * than the assistant's is skipped unless it is currentWorkspaceId.
   */
  workspaceIds: readonly string[] | 'all';
  /** Also search the user's own (user-scope) memories. */
  includeUserScope: boolean;
  /** Workspace-scope memories from these instead of workspaceIds ([] for user scope only). */
  memoryWorkspaceIds?: readonly string[] | 'all';
  /** The asking session's workspace: searchable even in Trash or with AI navigation off. */
  currentWorkspaceId?: string | null;
  /** What to look for; '' with gate false lists the newest documents. */
  query: string;
  /** Default both. */
  kinds?: readonly RecallDocKind[];
  /** Source time (ms) at or after this. */
  after?: number | null;
  /** Source time (ms) before this. */
  before?: number | null;
  /** Leave out this conversation's turns (the current one); memories from it stay. */
  excludeNodeId?: string | null;
  excludeNodeIds?: readonly string[];
  /** Superseded memories too, ranked below active ones. Never what the user asked Michi to forget (hidden). */
  includeInactive?: boolean;
  /**
   * The relevance gate for automatic recall (default true): a result must
   * match a content part of the query, and a rare one or two parts that are
   * together specific enough (memories: one specific part). Conversational
   * words (like, one, 时间) never count, and an everyday word (friend, 朋友)
   * is not rare on its own unless it is the query's only content. false: any
   * match counts (a search the agent asked for), ranked as before.
   */
  gate?: boolean;
  /**
   * What a turn is matched by: 'excerpt', the words its snippet shows (with
   * the conversation's title and the turn's keyphrases), or 'full', also
   * everything the user typed and the whole reply (each up to
   * TURN_INDEX_CHARS). Default: excerpt with the gate on, so automatic recall
   * stays as precise as what it shows; full with it off. Memories match by
   * body and keywords either way.
   */
  match?: 'excerpt' | 'full';
  /** Default 10, at most 50. */
  limit?: number;
  /** Turns per conversation; default 2. Soft: a further turn of one replaces the last hits when they score below half of it. */
  perConversation?: number;
  /** For recency; default Date.now(). */
  now?: number;
}

export interface RecallMemoryInfo {
  id: string;
  /** memories.row_id, for short references. */
  rowId: number;
  version: number;
  kind: MemoryKind;
  origin: MemoryOrigin;
  status: MemoryStatus;
  sourceRisk: MemorySourceRisk | null;
  eventAt: number | null;
  observedAt: number;
  keywords: string[];
  /** The tool whose memory it was imported from (nativeMemoryImport.ts), or null. */
  importSource: MemoryImportSource | null;
  /** What it is about (MemoryRecord.topic), or null. */
  topic: string | null;
}

export interface RecallHit {
  /** memory_recall_docs.id, for short references to a past conversation. */
  docId: number;
  kind: RecallDocKind;
  /** The memory id or the turn id. */
  refId: string;
  /** When the user said it (ms). */
  at: number;
  /** A memory's body; a turn's "user words\n→ reply" excerpt (each side's head and tail). */
  snippet: string;
  /** A turn's whole indexed text ("user words\n→ reply", each side up to TURN_INDEX_CHARS) when the snippet cut it; else null. */
  content: string | null;
  /** The conversation's current title (for a memory, the conversation it came from), when known. */
  title: string | null;
  nodeId: string | null;
  turnId: string | null;
  /** A memory's scope workspace (null: user scope); a conversation's workspace. */
  workspaceId: string | null;
  active: boolean;
  score: number;
  /** The parts of the query this document holds (folded text). */
  matched: string[];
  memory: RecallMemoryInfo | null;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_PER_CONVERSATION = 2;
/** Index terms a query is searched by at most (two 32-bit masks per candidate). */
const MAX_ATOMS = 64;
/** A term in more than this share of all documents is not searched by ... */
const COMMON_SHARE = 0.25;
/** ... once the index holds this many. */
const COMMON_MIN_DOCS = 50;
/** Rows searched in scope to find candidates, rarest terms first; commoner terms only mark them. */
const SEED_ROWS = 6_000;
/** Candidates ranked in full, by coverage; the factors after coverage change a score by under 2×. */
const MAX_RANKED = 2_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_LIMIT = 8.64e15;

const ATOM_SCOPE = `d.owner_user_id = ? AND d.hidden = 0 AND (? = 1 OR d.active = 1) AND d.at >= ? AND d.at < ?
  AND CASE d.doc_kind
    WHEN 'memory' THEN ? = 1 AND ((d.workspace_id IS NULL AND ? = 1) OR d.workspace_id IN (SELECT value FROM json_each(?)))
    WHEN 'turn' THEN ? = 1 AND d.workspace_id IN (SELECT value FROM json_each(?))
      AND (d.node_id IS NULL OR d.node_id NOT IN (SELECT value FROM json_each(?)))
    ELSE 0 END`;

/**
 * The in-scope documents holding one index term, as one comma-separated
 * string (a memory's id negated), so a common term costs no object per row.
 * CROSS JOIN keeps the FTS match outermost: otherwise the planner walks the
 * owner's documents and probes the index once per document (~200 ms at 10k).
 */
const ATOM_SQL = `SELECT group_concat(CASE d.doc_kind WHEN 'memory' THEN -d.id ELSE d.id END) AS ids
  FROM memory_recall_fts CROSS JOIN memory_recall_docs d ON d.id = memory_recall_fts.rowid
  WHERE memory_recall_fts MATCH ? AND ${ATOM_SCOPE}`;
/** Documents holding a term, every owner: which terms are rare enough to find candidates by. */
const ATOM_COUNT_SQL = 'SELECT count(*) AS n FROM memory_recall_fts WHERE memory_recall_fts MATCH ?';
/** Every owner's documents holding a common term; only ids already found in scope are kept. */
const ATOM_ROWIDS_SQL = 'SELECT group_concat(rowid) AS ids FROM memory_recall_fts WHERE memory_recall_fts MATCH ?';

/**
 * Documents holding a term in their excerpt or their content (the term is
 * bound twice). The content index leaves out the snippet's terms, so a
 * document is listed twice only for a term of its title or keys that its
 * content holds too: callers count it once.
 */
const FULL_MATCH = `(SELECT rowid AS id FROM memory_recall_fts WHERE memory_recall_fts MATCH ?
  UNION ALL SELECT rowid AS id FROM memory_recall_full_fts WHERE memory_recall_full_fts MATCH ?)`;

/** The three atom queries of a match mode, and how many times each binds the term. */
interface AtomQueries {
  /** Names the mode in a RecallMemo's keys. */
  name: string;
  count: string;
  docs: string;
  rowids: string;
  binds: number;
}

const EXCERPT_ATOMS: AtomQueries = { name: 'excerpt', count: ATOM_COUNT_SQL, docs: ATOM_SQL, rowids: ATOM_ROWIDS_SQL, binds: 1 };
const FULL_ATOMS: AtomQueries = {
  name: 'full',
  count: `SELECT (SELECT count(*) FROM memory_recall_fts WHERE memory_recall_fts MATCH ?)
    + (SELECT count(*) FROM memory_recall_full_fts WHERE memory_recall_full_fts MATCH ?) AS n`,
  docs: `SELECT group_concat(CASE d.doc_kind WHEN 'memory' THEN -d.id ELSE d.id END) AS ids
    FROM ${FULL_MATCH} f CROSS JOIN memory_recall_docs d ON d.id = f.id WHERE ${ATOM_SCOPE}`,
  rowids: `SELECT group_concat(id) AS ids FROM ${FULL_MATCH}`,
  binds: 2,
};
/** About how many documents the index holds (ids grow; deletions leave gaps). */
const DOC_SPAN_SQL = 'SELECT max(id) AS n FROM memory_recall_docs';
/** About how many documents are in scope, from the indexes alone (for inverse document frequency). */
const SCOPE_TURNS_SQL = 'SELECT count(*) AS n FROM memory_recall_docs WHERE workspace_id IN (SELECT value FROM json_each(?))';
const SCOPE_MEMORIES_SQL = `SELECT count(*) AS n FROM memory_recall_docs WHERE owner_user_id = ? AND doc_kind = 'memory'
  AND ((workspace_id IS NULL AND ? = 1) OR workspace_id IN (SELECT value FROM json_each(?)))`;
const NEWEST_SQL = `SELECT d.id AS id, d.doc_kind AS kind, d.at AS at, d.active AS active FROM memory_recall_docs d
  WHERE ${ATOM_SCOPE} ORDER BY d.at DESC, d.id DESC LIMIT ?`;
/** What ranking needs of the documents that passed the gate. */
const RANK_SQL = `SELECT d.id AS id, d.at AS at, d.active AS active, m.origin AS origin FROM memory_recall_docs d
  LEFT JOIN memories m ON d.doc_kind = 'memory' AND m.id = d.ref_id AND m.owner_user_id = d.owner_user_id
  WHERE d.id IN (SELECT value FROM json_each(?))`;

const HIT_SQL = `SELECT d.id, d.doc_kind, d.ref_id, d.node_id, d.turn_id, d.workspace_id, d.at, d.title, d.snippet, d.active, d.hidden,
    n.title AS node_title, n.memory_mode AS node_memory_mode, n.workspace_id AS node_workspace_id, n.kind AS node_kind, n.deleted_at AS node_deleted_at,
    n.deletion_group_id AS node_group, n.purged_at AS node_purged_at, n.page_id AS node_page_id,
    n.maintenance_job_id AS node_maintenance_job_id, n.scheduled_only_job_id AS node_scheduled_only_job_id,
    m.row_id AS memory_row_id, m.kind AS memory_kind, m.origin AS memory_origin, m.status AS memory_status,
    m.version AS memory_version, m.source_risk AS memory_source_risk, m.event_at AS memory_event_at,
    m.observed_at AS memory_observed_at, m.created_at AS memory_created_at, m.body AS memory_body,
    m.keywords AS memory_keywords, m.workspace_id AS memory_workspace_id, m.import_source AS memory_import_source,
    m.topic AS memory_topic
  FROM memory_recall_docs d
  LEFT JOIN nodes n ON n.id = d.node_id
  LEFT JOIN memories m ON d.doc_kind = 'memory' AND m.id = d.ref_id AND m.owner_user_id = d.owner_user_id
  WHERE d.id IN (SELECT value FROM json_each(?)) AND d.owner_user_id = ?`;

interface WorkspaceRow {
  id: string;
  owner_user_id: string | null;
  settings: string | null;
  deleted_at: number | null;
}

function navigationAllowed(settings: string | null): boolean {
  if (!settings) return true;
  try {
    const parsed = JSON.parse(settings) as Record<string, unknown> | null;
    return !parsed || typeof parsed !== 'object' || parsed.aiGlobalContext !== false;
  } catch {
    return true;
  }
}

/** The owner's workspaces among `requested` that recall may read (see RecallSearchQuery.workspaceIds). */
function readableWorkspaces(ownerUserId: string, requested: readonly string[] | 'all', current: string | null): string[] {
  const all = requested === 'all';
  if (!all && (!Array.isArray(requested) || requested.length === 0)) return [];
  const params: string[] = [];
  let sql = 'SELECT id, owner_user_id, settings, deleted_at FROM workspaces WHERE purged_at IS NULL';
  if (!all) {
    sql += ' AND id IN (SELECT value FROM json_each(?))';
    params.push(JSON.stringify(requested.filter((id) => typeof id === 'string')));
  }
  if (cloudMode()) {
    sql += ' AND owner_user_id = ?';
    params.push(ownerUserId);
  }
  return (prepareCached(sql).all(...params) as unknown as WorkspaceRow[])
    .filter((row) => workspaceOwnerMatches(row.owner_user_id, ownerUserId))
    .filter((row) => row.id === current
      || (row.deleted_at === null && learnsInWorkspace(row.settings) && navigationAllowed(row.settings)))
    .map((row) => row.id);
}

/**
 * The owner's workspaces whose conversations recall may read for a session in `current` (workspaceIds 'all'): that
 * one, and every other one neither in Trash, nor a system workspace but the assistant's (only V's turns are indexed
 * there), nor with AI navigation off.
 */
export function recallableWorkspaces(ownerUserId: string, current: string | null): string[] {
  return readableWorkspaces(ownerUserId, 'all', current);
}

interface Scope {
  ownerUserId: string;
  includeInactive: boolean;
  after: number;
  before: number;
  memories: boolean;
  userScope: boolean;
  memoryWorkspaces: string[];
  turns: boolean;
  turnWorkspaces: string[];
  excludeNodes: string[];
}

/** The same scope as sets, for checking each hit. */
interface ScopeSets {
  memoryWorkspaces: ReadonlySet<string>;
  turnWorkspaces: ReadonlySet<string>;
  excludeNodes: ReadonlySet<string>;
}

function scopeParams(scope: Scope): Array<string | number> {
  return [
    scope.ownerUserId, scope.includeInactive ? 1 : 0, scope.after, scope.before,
    scope.memories ? 1 : 0, scope.userScope ? 1 : 0, JSON.stringify(scope.memoryWorkspaces),
    scope.turns ? 1 : 0, JSON.stringify(scope.turnWorkspaces), JSON.stringify(scope.excludeNodes),
  ];
}

interface Candidate {
  id: number;
  kind: RecallDocKind;
  at: number;
  active: boolean;
  /** Bit i: the document holds atom i. */
  low: number;
  high: number;
  matched: string[];
  coverage: number;
  score: number;
}

function hasAtom(candidate: Candidate, atom: number): boolean {
  return ((atom < 32 ? candidate.low >>> atom : candidate.high >>> (atom - 32)) & 1) === 1;
}

function setAtom(candidate: Candidate, atom: number): void {
  if (atom < 32) candidate.low |= 1 << atom;
  else candidate.high |= 1 << (atom - 32);
}

interface PlannedConcept {
  concept: RecallConcept;
  /** Atom index of each of concept.atoms. */
  atoms: number[];
  /** A content concept (RecallConcept.content), which may pass the gate alone when rare; the gate admits no document without one. */
  rareEligible: boolean;
}

/** The gate counts an everyday word (memoryTerms.COMMON_TERMS) as found in at least this many documents. */
const COMMON_MIN_DF = 3;

function idf(n: number, df: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function validLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function validTime(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(-TIME_LIMIT, Math.min(TIME_LIMIT, value)) : fallback;
}

interface HitRow {
  id: number;
  doc_kind: RecallDocKind;
  ref_id: string;
  node_id: string | null;
  turn_id: string | null;
  workspace_id: string | null;
  at: number;
  title: string | null;
  snippet: string;
  active: number;
  hidden: number;
  node_title: string | null;
  node_memory_mode: string | null;
  node_workspace_id: string | null;
  node_kind: string | null;
  node_deleted_at: number | null;
  node_group: string | null;
  node_purged_at: number | null;
  node_page_id: string | null;
  node_maintenance_job_id: string | null;
  node_scheduled_only_job_id: string | null;
  memory_row_id: number | null;
  memory_kind: MemoryKind | null;
  memory_origin: MemoryOrigin | null;
  memory_status: MemoryStatus | null;
  memory_version: number | null;
  memory_source_risk: MemorySourceRisk | null;
  memory_event_at: number | null;
  memory_observed_at: number | null;
  memory_created_at: number | null;
  memory_body: string | null;
  memory_keywords: string | null;
  memory_workspace_id: string | null;
  memory_import_source: MemoryImportSource | null;
  memory_topic: string | null;
}

/** In Trash (an archived thread, kept in an arch-* group, is not). */
function trashed(row: HitRow): boolean {
  return row.node_deleted_at !== null && !(row.node_group ?? '').startsWith('arch-');
}

/**
 * The hit for a document that is still readable in this scope, else null.
 * A memory's title shows only while its conversation learns (not Use only or
 * Off).
 */
function hitOf(row: HitRow, scope: Scope, sets: ScopeSets, candidate: Candidate): RecallHit | null {
  // What the user asked Michi not to recall: whatever the scope asks.
  if (row.hidden === 1) return null;
  const liveNode = row.node_kind !== null && row.node_purged_at === null && !trashed(row);
  if (row.doc_kind === 'turn') {
    if (!row.snippet || !liveNode || row.node_kind !== 'chat' || row.node_page_id !== null || row.node_maintenance_job_id !== null
      || row.node_scheduled_only_job_id !== null || !sets.turnWorkspaces.has(row.node_workspace_id ?? '')
      || sets.excludeNodes.has(row.node_id ?? '')) return null;
    return {
      docId: row.id, kind: 'turn', refId: row.ref_id, at: row.at, snippet: row.snippet, content: null,
      title: row.node_title ?? row.title,
      nodeId: row.node_id, turnId: row.turn_id, workspaceId: row.node_workspace_id, active: true,
      score: candidate.score, matched: candidate.matched, memory: null,
    };
  }
  if (row.memory_row_id === null || row.memory_status === null || row.memory_body === null) return null;
  if (row.memory_status !== 'active' && !(scope.includeInactive && row.memory_status === 'superseded')) return null;
  const workspaceId = row.memory_workspace_id;
  if (workspaceId === null ? !scope.userScope : !sets.memoryWorkspaces.has(workspaceId)) return null;
  return {
    docId: row.id, kind: 'memory', refId: row.ref_id, at: row.at, snippet: row.memory_body, content: null,
    title: liveNode && row.node_memory_mode === null ? row.node_title : null, nodeId: row.node_id, turnId: row.turn_id, workspaceId,
    active: row.memory_status === 'active', score: candidate.score, matched: candidate.matched,
    memory: {
      id: row.ref_id, rowId: row.memory_row_id, version: row.memory_version ?? 1, kind: row.memory_kind ?? 'fact',
      origin: row.memory_origin ?? 'explicit', status: row.memory_status, sourceRisk: row.memory_source_risk,
      eventAt: row.memory_event_at, observedAt: row.memory_observed_at ?? row.memory_created_at ?? row.at,
      keywords: row.memory_keywords ? row.memory_keywords.split('\n').filter(Boolean) : [],
      importSource: row.memory_import_source ?? null,
      topic: row.memory_topic ?? null,
    },
  };
}

/** A turn the per-conversation cap held back replaces a hit at the end that scores below this share of its score. */
const OVERFLOW_SHARE = 0.5;

/**
 * Candidates in rank order → hits, checking each is still readable, at most
 * perConversation turns per thread. The cap is soft: a turn it held back
 * replaces the last hits while they score below OVERFLOW_SHARE of its score
 * (a third turn of the conversation that holds the answer beats a weak
 * match elsewhere).
 */
function collectHits(ranked: Candidate[], scope: Scope, limit: number, perConversation: number): RecallHit[] {
  const hits: RecallHit[] = [];
  const overflow: RecallHit[] = [];
  const perNode = new Map<string, number>();
  const sets: ScopeSets = {
    memoryWorkspaces: new Set(scope.memoryWorkspaces),
    turnWorkspaces: new Set(scope.turnWorkspaces),
    excludeNodes: new Set(scope.excludeNodes),
  };
  const batch = Math.max(limit * 3, 30);
  for (let start = 0; start < ranked.length && hits.length < limit; start += batch) {
    const slice = ranked.slice(start, start + batch);
    const rows = new Map((prepareCached(HIT_SQL).all(JSON.stringify(slice.map((c) => c.id)), scope.ownerUserId) as unknown as HitRow[])
      .map((row) => [row.id, row]));
    for (const candidate of slice) {
      const row = rows.get(candidate.id);
      const hit = row ? hitOf(row, scope, sets, candidate) : null;
      if (!hit) continue;
      if (hit.kind === 'turn' && hit.nodeId) {
        const seen = perNode.get(hit.nodeId) ?? 0;
        if (seen >= perConversation) {
          overflow.push(hit);
          continue;
        }
        perNode.set(hit.nodeId, seen + 1);
      }
      hits.push(hit);
      if (hits.length >= limit) break;
    }
  }
  for (const held of overflow) {
    const last = hits[hits.length - 1];
    if (hits.length < limit || !last || last.score >= OVERFLOW_SHARE * held.score) break;
    hits.pop();
    const at = hits.findIndex((hit) => hit.score < held.score);
    hits.splice(at < 0 ? hits.length : at, 0, held);
  }
  // The whole text of the turns found, for excerpts around what matched (turnExcerpt) and ref lookups.
  const turns = hits.filter((hit) => hit.kind === 'turn');
  if (turns.length > 0) {
    const contents = new Map((prepareCached(CONTENT_SQL).all(JSON.stringify(turns.map((hit) => hit.docId))) as
      Array<{ id: number; content: string }>).map((row) => [row.id, row.content]));
    for (const hit of turns) hit.content = contents.get(hit.docId) ?? null;
  }
  return hits;
}

const CONTENT_SQL = `SELECT id, content FROM memory_recall_docs WHERE id IN (SELECT value FROM json_each(?)) AND content IS NOT NULL`;

/**
 * Search the recall index: memories (user scope and the given workspaces)
 * and past conversations, for a query in any mix of Chinese and English.
 *
 * The query is split into concepts (memoryTerms.queryConcepts); a question
 * about the user's own work, home, school, family, pets or devices adds one
 * whose words are those memories of that category carry
 * (memoryTerms.profileConcepts, profileKeywords). Each
 * document gets the sum, over the concepts it holds, of the concept's inverse
 * document frequency in this scope (for CJK, of the longest part of the
 * concept it holds; half when it holds only a neighbouring character pair,
 * not the word). Memories rank above conversations (explicit ones highest),
 * recent above old, active above superseded. With the gate on (the default,
 * for automatic recall) a document needs a content concept (a CJK word,
 * a latin word of four or more letters, a number or an identifier), and a
 * rare one (in at most two documents), or two concepts whose weight together
 * is at least that of two found in 5% of documents; a memory may also pass
 * with one content concept found in at most 5%. Conversational words
 * (memoryTerms.WEAK_TERMS) count for nothing there, ranking included, and an
 * everyday word (COMMON_TERMS) counts as found in three documents at least,
 * so in a small store it is not rare alone, unless it is the only content
 * concept the query has. Empty when the owner's memory is off.
 */
export function recallSearch(query: RecallSearchQuery): RecallHit[] {
  const ownerUserId = typeof query?.ownerUserId === 'string' ? query.ownerUserId.trim() : '';
  if (!ownerUserId || !memoryOn(ownerUserId)) return [];
  const text = typeof query.query === 'string' ? query.query : '';
  const gate = query.gate !== false;
  const limit = validLimit(query.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const perConversation = validLimit(query.perConversation, DEFAULT_PER_CONVERSATION, MAX_LIMIT);
  const scope = searchScope(ownerUserId, query);
  if (!scope) return [];
  const now = validTime(query.now, Date.now());

  if (!text.trim()) {
    if (gate) return [];
    const newest = (prepareCached(NEWEST_SQL).all(...scopeParams(scope), limit * 4) as Array<{ id: number; kind: RecallDocKind; at: number; active: number }>)
      .map((row): Candidate => ({ id: row.id, kind: row.kind, at: row.at, active: row.active === 1, low: 0, high: 0, matched: [], coverage: 0, score: 0 }));
    return collectHits(newest, scope, limit, perConversation);
  }
  // Only turns have content: a search of memories alone matches excerpts either way.
  const full = (query.match ?? (gate ? 'excerpt' : 'full')) === 'full' && scope.turns;
  return rankedSearch(text, scope, { gate, limit, perConversation, now, atoms: full ? FULL_ATOMS : EXCERPT_ATOMS });
}

/** What recallSearch and recallDocument read: the RecallSearchQuery fields that name a scope. */
type RecallScopeQuery = Pick<RecallSearchQuery, 'workspaceIds' | 'includeUserScope' | 'memoryWorkspaceIds' | 'currentWorkspaceId'
  | 'kinds' | 'after' | 'before' | 'excludeNodeId' | 'excludeNodeIds' | 'includeInactive'>;

export interface RecallDocumentQuery extends RecallScopeQuery {
  ownerUserId: string;
  /** memory_recall_docs.id (the number in a c: ref). */
  docId: number;
}

/**
 * One document by its id, as a hit, when the scope may still read it (the
 * same rules as recallSearch); null otherwise or when memory is off. For a
 * ref an agent was shown and asks about.
 */
export function recallDocument(query: RecallDocumentQuery): RecallHit | null {
  const ownerUserId = typeof query?.ownerUserId === 'string' ? query.ownerUserId.trim() : '';
  if (!ownerUserId || !Number.isSafeInteger(query.docId) || query.docId <= 0 || !memoryOn(ownerUserId)) return null;
  const scope = searchScope(ownerUserId, query);
  if (!scope) return null;
  const candidate: Candidate = { id: query.docId, kind: 'turn', at: 0, active: true, low: 0, high: 0, matched: [], coverage: 0, score: 0 };
  return collectHits([candidate], scope, 1, 1)[0] ?? null;
}

/**
 * The indexed turn with this id (a memory's source turn), when a related
 * memory may quote it: shown (not hidden), it read nothing from outside (web
 * pages, files, tool output), and nothing from it was deleted or turned down
 * (an extraction tombstone names it): of "I moved to Osaka, my new address
 * is …" with the address forgotten, the move's note must not bring the
 * address back. recallDocument then checks that a scope may read it.
 */
export function quotableTurnDocId(ownerUserId: string, turnId: string): number | null {
  if (!ownerUserId || !turnId) return null;
  const row = prepareCached(`SELECT d.id AS id FROM memory_recall_docs d
      WHERE d.doc_kind = 'turn' AND d.ref_id = ? AND d.owner_user_id = ? AND d.hidden = 0 AND d.read_outside = 0
        AND NOT EXISTS (SELECT 1 FROM memory_extraction_tombstones t WHERE t.owner_user_id = d.owner_user_id AND t.source_turn_id = d.ref_id)`)
    .get(turnId, ownerUserId) as { id: number } | undefined;
  return row ? row.id : null;
}

/** The scope a query reads, or null when it reads nothing. */
function searchScope(ownerUserId: string, query: RecallScopeQuery): Scope | null {
  const requestedKinds = (query.kinds ?? []).filter((kind): kind is RecallDocKind => kind === 'memory' || kind === 'turn');
  const kinds = new Set<RecallDocKind>(requestedKinds.length > 0 ? requestedKinds : ['memory', 'turn']);
  const current = typeof query.currentWorkspaceId === 'string' ? query.currentWorkspaceId : null;
  const turnWorkspaces = kinds.has('turn') ? readableWorkspaces(ownerUserId, query.workspaceIds, current) : [];
  const memoryRequested = query.memoryWorkspaceIds ?? query.workspaceIds;
  const memoryWorkspaces = !kinds.has('memory') ? []
    : memoryRequested === query.workspaceIds && kinds.has('turn') ? turnWorkspaces
      : readableWorkspaces(ownerUserId, memoryRequested, current);
  const scope: Scope = {
    ownerUserId,
    includeInactive: query.includeInactive === true,
    after: validTime(query.after, -TIME_LIMIT),
    before: validTime(query.before, TIME_LIMIT + 1),
    memories: kinds.has('memory'),
    userScope: kinds.has('memory') && query.includeUserScope === true,
    memoryWorkspaces,
    turns: kinds.has('turn') && turnWorkspaces.length > 0,
    turnWorkspaces,
    excludeNodes: [query.excludeNodeId, ...(query.excludeNodeIds ?? [])].filter((id): id is string => typeof id === 'string' && !!id),
  };
  return !scope.turns && !scope.userScope && scope.memoryWorkspaces.length === 0 ? null : scope;
}

/**
 * The documents among `docIds` (turns of one workspace's conversations) that
 * recall's gate passes for `query`: what automatic recall would show for it,
 * the gate weighed over the workspace's documents as always, matched by the
 * turns' whole indexed text. recallTurnMatch is its test for one document.
 * [] when memory is off.
 * @testonly
 */
export function recallTurnsMatching(input: { ownerUserId: string; workspaceId: string; query: string; docIds: readonly number[]; now?: number }): number[] {
  return turnHitsMatching(input).map((hit) => hit.docId);
}

/**
 * What one synchronous run of several searches over the same scope reads
 * once (reply sources check one turn against up to a dozen items): the index's
 * counts and document lists per term. The index must not change while it is
 * used.
 */
export interface RecallMemo {
  values: Map<string, unknown>;
}

export function createRecallMemo(): RecallMemo {
  return { values: new Map() };
}

function memoized<T>(memo: RecallMemo | undefined, key: string, read: () => T): T {
  if (!memo) return read();
  if (memo.values.has(key)) return memo.values.get(key) as T;
  const value = read();
  memo.values.set(key, value);
  return value;
}

/**
 * Whether recall's gate passes one turn document for `query`, as
 * recallTurnsMatching weighs it (the workspace's turn documents as document
 * frequencies, matched by the turn's whole indexed text): the parts of the
 * query it holds (folded text), or null. Reply sources (replySources.ts) use
 * it to tell whether a reply repeated what it was given, with `excludeSelf`:
 * the document's own terms do not count toward how common they are (a reply
 * holds every term it repeats, so it would make each one look commoner by
 * one); `memo` shares the index reads of one turn's checks.
 */
export function recallTurnMatch(input: {
  ownerUserId: string; workspaceId: string; query: string; docId: number; now?: number; memo?: RecallMemo; excludeSelf?: boolean;
}): string[] | null {
  const hit = turnHitsMatching({ ...input, docIds: [input.docId], self: input.excludeSelf ? input.docId : undefined })[0];
  return hit ? hit.matched : null;
}

/** recallTurnsMatching's search: the hits among `docIds` that recall's gate passes, with what each matched. */
function turnHitsMatching(input: {
  ownerUserId: string; workspaceId: string; query: string; docIds: readonly number[]; now?: number; memo?: RecallMemo; self?: number;
}): RecallHit[] {
  const ownerUserId = typeof input?.ownerUserId === 'string' ? input.ownerUserId.trim() : '';
  if (!ownerUserId || !memoryOn(ownerUserId) || !input.query?.trim() || input.docIds.length === 0) return [];
  const scope = workspaceTurnScope(ownerUserId, input.workspaceId);
  if (!scope) return [];
  const only = new Set(input.docIds);
  return rankedSearch(input.query, scope, {
    gate: true, limit: MAX_LIMIT, perConversation: MAX_LIMIT, now: validTime(input.now, Date.now()), atoms: FULL_ATOMS, only, memo: input.memo,
    self: input.self,
  });
}

/** One workspace's turn documents, as the turn tests read them. */
function workspaceTurnScope(ownerUserId: string, workspaceId: string): Scope | null {
  return searchScope(ownerUserId, {
    workspaceIds: [workspaceId], includeUserScope: false, memoryWorkspaceIds: [], currentWorkspaceId: workspaceId, kinds: ['turn'],
  });
}

/**
 * The index terms recall searches a query by (the atoms rankedSearch plans:
 * its concepts and the profile categories it asks about). A document holding
 * none of them cannot match it: a cheap prefilter before the search.
 */
export function queryAtoms(query: string): Set<string> {
  const text = typeof query === 'string' ? query : '';
  const own = queryConcepts(text);
  const atoms = new Set<string>();
  for (const concept of [...own, ...profileConcepts(text, own)]) {
    const fresh = concept.atoms.filter((atom) => !atoms.has(atom));
    if (atoms.size + new Set(fresh).size > MAX_ATOMS) break;
    for (const atom of concept.atoms) atoms.add(atom);
  }
  return atoms;
}

/** The index terms a turn document is matched by in full: its title, snippet, keys and whole content. */
export function docTerms(doc: { title: string | null; snippet: string; keys: string; content: string | null }): Set<string> {
  return new Set([...segmentTerms(`${doc.title ?? ''}\n${doc.snippet}\n${doc.keys}`), ...(doc.content ? segmentTerms(doc.content) : [])]);
}

interface GateOptions {
  gate: boolean;
  atoms: AtomQueries;
  /** Only these documents can pass. */
  only?: ReadonlySet<number>;
  memo?: RecallMemo;
  /** A document whose own terms do not count toward how common they are (recallTurnMatch's excludeSelf). */
  self?: number;
}

interface Gated {
  /** The candidates the gate passes (in `only`, when given), each with what it matched; in no order. */
  passed: Candidate[];
}

/** recallSearch's plan, candidates and gate for a non-empty query (see recallSearch); null when no document holds a term of it. */
function gatedCandidates(text: string, scope: Scope, options: GateOptions): Gated | null {
  const { ownerUserId } = scope;
  const { gate, atoms: sql, only, memo } = options;
  const term = (atom: string) => Array.from({ length: sql.binds }, () => `"${atom}"`);
  // Plan: concepts and the distinct index terms (atoms) that find them.
  const atoms: string[] = [];
  const atomIndex = new Map<string, number>();
  const planned: PlannedConcept[] = [];
  const own = queryConcepts(text);
  // A question about the user's own work, home, family… also looks for the words such memories carry (profileConcepts).
  for (const concept of [...own, ...profileConcepts(text, own)]) {
    const fresh = concept.atoms.filter((atom) => !atomIndex.has(atom));
    if (atoms.length + new Set(fresh).size > MAX_ATOMS) break;
    const ids = concept.atoms.map((atom) => {
      let index = atomIndex.get(atom);
      if (index === undefined) {
        index = atoms.length;
        atoms.push(atom);
        atomIndex.set(atom, index);
      }
      return index;
    });
    planned.push({ concept, atoms: ids, rareEligible: concept.content });
  }
  if (planned.length === 0) return null;
  // An everyday word may be rare alone only when it is all the message asks about (我下周去哪出差？): then it is the best
  // evidence there is; beside other content (how a fridge keeps food cold) a match on it alone is incidental.
  const contentPlans = planned.filter((plan) => plan.rareEligible && !WEAK_TERMS.has(plan.concept.text));
  const soleContent = contentPlans.length === 1 ? contentPlans[0] : null;

  // Which documents hold each atom, rarest atom first. The rarer atoms are
  // searched in scope and their documents are the candidates (until about
  // SEED_ROWS rows); the commoner ones only mark the candidates they hold, and
  // count as found in as many documents as hold them overall. An atom in more
  // than a quarter of all documents (COMMON_SHARE: this corpus's stop words)
  // is left out, unless nothing rarer was searched.
  const params = scopeParams(scope);
  const paramsKey = JSON.stringify(params);
  const span = memoized(memo, 'span', () => (prepareCached(DOC_SPAN_SQL).get() as { n: number | null }).n ?? 0);
  const counts = atoms.map((atom) => memoized(memo, `count:${sql.name}:${atom}`, () => (prepareCached(sql.count).get(...term(atom)) as { n: number }).n));
  const candidates = new Map<number, Candidate>();
  const atomDocs: number[][] = atoms.map(() => []);
  const seeded = atoms.map(() => false);
  let seededRows = 0;
  for (const index of atoms.map((_, i) => i).sort((a, b) => counts[a] - counts[b] || a - b)) {
    if (counts[index] === 0) continue;
    const anySeeded = seededRows > 0;
    if (anySeeded && span >= COMMON_MIN_DOCS && counts[index] > span * COMMON_SHARE) continue;
    const docs = atomDocs[index];
    if (!anySeeded || seededRows + counts[index] <= SEED_ROWS) {
      // Signed ids (a memory's negated), each document once.
      const ids = memoized(memo, `docs:${sql.name}:${atoms[index]}:${paramsKey}`, () => {
        const list = (prepareCached(sql.docs).get(...term(atoms[index]), ...params) as { ids: string | null }).ids;
        const seen = new Set<number>();
        const out: number[] = [];
        for (const part of list ? list.split(',') : []) {
          const signed = Number(part);
          if (seen.has(Math.abs(signed))) continue;
          seen.add(Math.abs(signed));
          out.push(signed);
        }
        return out;
      });
      seeded[index] = true;
      seededRows += Math.max(counts[index], 1);
      for (const signed of ids) {
        const id = Math.abs(signed);
        docs.push(id);
        let candidate = candidates.get(id);
        if (!candidate) {
          candidate = { id, kind: signed < 0 ? 'memory' : 'turn', at: 0, active: true, low: 0, high: 0, matched: [], coverage: 0, score: 0 };
          candidates.set(id, candidate);
        }
        setAtom(candidate, index);
      }
    } else {
      const ids = memoized(memo, `rowids:${sql.name}:${atoms[index]}`, () => {
        const list = (prepareCached(sql.rowids).get(...term(atoms[index])) as { ids: string | null }).ids;
        return list ? list.split(',').map(Number) : [];
      });
      for (const id of ids) {
        const candidate = candidates.get(id);
        if (!candidate || hasAtom(candidate, index)) continue;
        docs.push(candidate.id);
        setAtom(candidate, index);
      }
    }
  }
  if (candidates.size === 0) return null;
  // About how many documents are in scope, and never fewer than a searched atom holds.
  const inScope = memoized(memo, `scope:${paramsKey}`, () => (scope.turns
    ? (prepareCached(SCOPE_TURNS_SQL).get(JSON.stringify(scope.turnWorkspaces)) as { n: number }).n : 0)
    + (scope.memories
      ? (prepareCached(SCOPE_MEMORIES_SQL).get(ownerUserId, scope.userScope ? 1 : 0, JSON.stringify(scope.memoryWorkspaces)) as { n: number }).n
      : 0));
  const total = Math.max(inScope, ...atomDocs.filter((_, index) => seeded[index]).map((docs) => docs.length), 1);

  // The document a reply-source check tests does not count toward the commonness of the terms it holds.
  const selfCandidate = options.self !== undefined ? candidates.get(options.self) : undefined;
  const selfHolds = (run: readonly number[]) => !!selfCandidate && run.every((atom) => hasAtom(selfCandidate, atom));
  const atomDf = (atom: number): number => Math.max(0,
    (seeded[atom] ? atomDocs[atom].length : Math.min(counts[atom], total)) - (selfHolds([atom]) ? 1 : 0));
  const dfRef = Math.max(3, Math.ceil(total * 0.05));
  const tau = 2 * idf(total, dfRef);
  const specificIdf = idf(total, dfRef);

  // df of a run of a concept's atoms: the documents holding all of them,
  // counted on the rarest searched atom's documents (else bounded by the rarest atom).
  const runDf = new Map<string, number>();
  const dfOf = (plan: PlannedConcept, from: number, to: number): number => {
    if (from === to) return atomDf(plan.atoms[from]);
    const key = plan.atoms.slice(from, to + 1).join(',');
    let df = runDf.get(key);
    if (df === undefined) {
      const run = plan.atoms.slice(from, to + 1);
      const searchedRun = run.filter((atom) => seeded[atom]);
      if (searchedRun.length === 0) {
        df = Math.min(...run.map(atomDf));
      } else {
        const rarest = searchedRun.reduce((a, b) => (atomDocs[b].length < atomDocs[a].length ? b : a));
        df = 0;
        for (const id of atomDocs[rarest]) {
          const candidate = candidates.get(id)!;
          if (id !== options.self && run.every((atom) => hasAtom(candidate, atom))) df += 1;
        }
      }
      runDf.set(key, df);
    }
    return df;
  };

  const passed: Candidate[] = [];
  for (const candidate of candidates.values()) {
    // Only these can pass: the others are weighed for nothing.
    if (only && !only.has(candidate.id)) continue;
    let credit = 0;
    let creditWeight = 0;
    let rare = false;
    let specific = false;
    let content = false;
    for (const plan of planned) {
      // The best run of consecutive atoms this document holds.
      let best: { weight: number; idf: number; df: number; anchored: boolean; from: number; to: number } | null = null;
      for (let from = 0; from < plan.atoms.length; from += 1) {
        if (!hasAtom(candidate, plan.atoms[from])) continue;
        let to = from;
        // A category's words are each the whole concept: no runs.
        while (!plan.concept.alternatives && to + 1 < plan.atoms.length && hasAtom(candidate, plan.atoms[to + 1])) to += 1;
        const df = dfOf(plan, from, to);
        const weightIdf = idf(total, df);
        const anchor = plan.concept.anchor;
        // A latin concept's first atom is the whole of it (an identifier, as much as all its words).
        const anchored = !anchor || (from <= anchor.from && to >= anchor.to) || (plan.concept.type !== 'cjk' && from === 0);
        const weight = anchored ? weightIdf : weightIdf / 2;
        if (!best || weight > best.weight) best = { weight, idf: weightIdf, df, anchored, from, to };
        from = to;
      }
      if (!best) continue;
      // The part held: a run of overlapping bigrams spells its characters once; of an identifier's words, the first.
      const held = plan.concept.atoms.slice(best.from, best.to + 1);
      const part = plan.concept.alternatives ? held[0]
        : plan.concept.type === 'cjk' ? held[0] + held.slice(1).map((pair) => [...pair].slice(1).join('')).join('')
          : best.from === 0 ? plan.concept.text : held[0];
      // Automatic recall: a conversational word says nothing about which document the user means.
      if (gate && (WEAK_TERMS.has(plan.concept.text) || WEAK_TERMS.has(part))) continue;
      candidate.coverage += best.weight;
      candidate.matched.push(part);
      if (!best.anchored) continue;
      credit += 1;
      // An everyday word counts as found in COMMON_MIN_DF documents at least, so it is not rare alone; so does a
      // category's word (profileConcepts): "住在梅田的酒店" says where the user stayed, not that it answers "where do I live".
      const common = COMMON_TERMS.has(plan.concept.text) || COMMON_TERMS.has(part) || plan.concept.alternatives === true;
      const gateIdf = common ? idf(total, Math.min(total, Math.max(best.df, COMMON_MIN_DF))) : best.idf;
      creditWeight += gateIdf;
      if (!plan.rareEligible) continue;
      content = true;
      if ((!common || plan === soleContent) && best.df <= 2) rare = true;
      if (gateIdf >= specificIdf) specific = true;
    }
    const pass = !gate || (content && (rare || (credit >= 2 && creditWeight >= tau) || (candidate.kind === 'memory' && specific)));
    if (pass && candidate.coverage > 0) passed.push(candidate);
  }
  return { passed };
}

/** recallSearch for a non-empty query: plan its concepts, find, gate and rank documents (only those in `only`, when given). */
function rankedSearch(text: string, scope: Scope, options: {
  gate: boolean; limit: number; perConversation: number; now: number; atoms: AtomQueries; only?: ReadonlySet<number>; memo?: RecallMemo; self?: number;
}): RecallHit[] {
  const { limit, perConversation, now } = options;
  const gated = gatedCandidates(text, scope, { gate: options.gate, atoms: options.atoms, only: options.only, memo: options.memo, self: options.self });
  if (!gated || gated.passed.length === 0) return [];

  // Rank the best-covered: memories above conversations (explicit highest), recent and active first.
  const ranked = gated.passed.sort((a, b) => b.coverage - a.coverage).slice(0, MAX_RANKED);
  const facts = new Map((prepareCached(RANK_SQL).all(JSON.stringify(ranked.map((candidate) => candidate.id))) as
    Array<{ id: number; at: number; active: number; origin: string | null }>).map((row) => [row.id, row]));
  for (const candidate of ranked) {
    const row = facts.get(candidate.id);
    candidate.at = row?.at ?? 0;
    candidate.active = row?.active === 1;
    const kindFactor = candidate.kind === 'turn' ? 1 : row?.origin === 'explicit' ? 1.5 : 1.3;
    const recency = 1 + 0.15 * Math.exp(-Math.max(0, now - candidate.at) / (60 * DAY_MS));
    candidate.score = candidate.coverage * kindFactor * recency * (candidate.active ? 1 : 0.5);
  }
  ranked.sort((a, b) => b.score - a.score || b.at - a.at || b.id - a.id);
  return collectHits(ranked, scope, limit, perConversation);
}

// ── excerpts and ref lookups ─────────────────────────────────────────────────

/** What a past-conversation line shows: the user's words and the reply, each on one line. */
export interface TurnExcerpt {
  user: string;
  reply: string;
}

/**
 * At most `budget` of a text (cost per character), on one line: a window
 * around the first of `terms` it holds (a third of the budget before it),
 * else its start; '…' marks a cut.
 */
function windowAround(text: string, terms: readonly string[], budget: number, cost: (char: string) => number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const chars = [...flat];
  const costs = chars.map(cost);
  if (costs.reduce((sum, value) => sum + value, 0) <= budget) return flat;
  const found = terms.length > 0 ? locateTerm(flat, terms) : null;
  const at = found === null ? 0 : [...flat.slice(0, found)].length;
  let start = at;
  let before = 0;
  while (start > 0 && before + costs[start - 1] <= budget / 3) {
    start -= 1;
    before += costs[start];
  }
  // Start at a word, not inside one.
  const word = /[\p{L}\p{N}]/u;
  if (start > 0 && start < at && word.test(chars[start - 1]) && word.test(chars[start])) {
    const space = chars.indexOf(' ', start);
    if (space >= 0 && space < at) start = space + 1;
  }
  let end = start;
  let used = 0;
  while (end < chars.length && used + costs[end] <= budget) {
    used += costs[end];
    end += 1;
  }
  while (end === chars.length && start > 0 && used + costs[start - 1] <= budget) {
    start -= 1;
    used += costs[start];
  }
  const window = chars.slice(start, end).join('').trim();
  return `${start > 0 ? '…' : ''}${window}${end < chars.length ? '…' : ''}`;
}

/**
 * A past conversation's excerpt for display (a pack line, a search result):
 * the user's words and the reply, at most budget.user and budget.reply long
 * (cost per character, default 1; the user's words get both when the turn
 * keeps no reply). Each is a window around the first of hit.matched it
 * holds, else its start, from the turn's whole indexed text.
 */
export function turnExcerpt(
  hit: Pick<RecallHit, 'snippet' | 'content' | 'matched'>,
  budget: { user: number; reply: number },
  cost: (char: string) => number = () => 1,
): TurnExcerpt {
  const { user, reply } = splitTurn(hit.content ?? hit.snippet);
  const terms = hit.matched ?? [];
  if (!reply.trim()) return { user: windowAround(user, terms, budget.user + budget.reply, cost), reply: '' };
  return { user: windowAround(user, terms, budget.user, cost), reply: windowAround(reply, terms, budget.reply, cost) };
}

/** A ref lookup's turn at most (characters): the user's words and the reply. */
const TURN_VIEW_CHARS = 6_000;
/** A ref lookup's neighbouring turns, at most (characters). */
const NEIGHBOUR_CHARS = 200;

/** The turn before or after the one a ref lookup reads, in the same conversation. */
export interface RecallNeighbour {
  docId: number;
  /** The turn's id. */
  turnId: string;
  at: number;
  /** The start of its snippet, on one line. */
  text: string;
}

export interface RecallTurnView {
  hit: RecallHit;
  /** The turn as indexed ("user words\n→ reply"), at most TURN_VIEW_CHARS (each side's head and tail past that). */
  text: string;
  /** The conversation's indexed turns just before and after it; hidden ones are skipped. */
  previous: RecallNeighbour | null;
  next: RecallNeighbour | null;
}

const NEIGHBOUR_SQL = (direction: 'before' | 'after') => `SELECT id, ref_id, at, snippet FROM memory_recall_docs
  WHERE owner_user_id = ? AND doc_kind = 'turn' AND node_id = ? AND hidden = 0 AND snippet <> ''
    AND ${direction === 'before' ? '(at < ? OR (at = ? AND id < ?))' : '(at > ? OR (at = ? AND id > ?))'}
  ORDER BY at ${direction === 'before' ? 'DESC' : 'ASC'}, id ${direction === 'before' ? 'DESC' : 'ASC'} LIMIT 1`;
const NEIGHBOUR_BEFORE_SQL = NEIGHBOUR_SQL('before');
const NEIGHBOUR_AFTER_SQL = NEIGHBOUR_SQL('after');

/** A turn's text within TURN_VIEW_CHARS: the user's words get what the reply leaves, and at least a quarter. */
function viewOf(text: string): string {
  if ([...text].length <= TURN_VIEW_CHARS) return text;
  const { user, reply } = splitTurn(text);
  const userLength = [...user].length;
  const userShare = Math.min(userLength, Math.max(Math.floor(TURN_VIEW_CHARS / 4), TURN_VIEW_CHARS - [...reply].length));
  return joinTurn(excerpt(user, userShare), excerpt(reply, TURN_VIEW_CHARS - userShare));
}

/** A search result's preview of the turn after it, at most (characters). */
const NEXT_PREVIEW_CHARS = 160;

/**
 * What the user said next in a hit's conversation (the next indexed turn,
 * hidden ones skipped): up to NEXT_PREVIEW_CHARS of their words, on one
 * line, with that turn's doc id. A search result shows it, so a decision
 * made in the following message ("what did we finally pick?") is in sight.
 */
export function nextUserTurn(ownerUserId: string, hit: Pick<RecallHit, 'kind' | 'nodeId' | 'at' | 'docId'>): RecallNeighbour | null {
  if (hit.kind !== 'turn' || !hit.nodeId) return null;
  const row = prepareCached(NEIGHBOUR_AFTER_SQL).get(ownerUserId, hit.nodeId, hit.at, hit.at, hit.docId) as
    { id: number; ref_id: string; at: number; snippet: string } | undefined;
  if (!row) return null;
  const text = windowAround(splitTurn(row.snippet).user, [], NEXT_PREVIEW_CHARS, () => 1);
  return text ? { docId: row.id, turnId: row.ref_id, at: row.at, text } : null;
}

/**
 * A past-conversation turn by its c: ref, for a ref lookup: the hit (the
 * same rules as recallDocument), its whole indexed text within
 * TURN_VIEW_CHARS, and the turns before and after it in that conversation
 * (hidden ones skipped), so the agent can read on. null when the scope may
 * not read it.
 */
export function recallTurn(query: RecallDocumentQuery): RecallTurnView | null {
  const hit = recallDocument({ ...query, kinds: ['turn'] });
  if (!hit || hit.kind !== 'turn' || !hit.nodeId) return null;
  const ownerUserId = query.ownerUserId.trim();
  const neighbour = (sql: string): RecallNeighbour | null => {
    const row = prepareCached(sql).get(ownerUserId, hit.nodeId, hit.at, hit.at, hit.docId) as
      { id: number; ref_id: string; at: number; snippet: string } | undefined;
    if (!row) return null;
    return { docId: row.id, turnId: row.ref_id, at: row.at, text: windowAround(row.snippet.replace(REPLY_MARK, ' → '), [], NEIGHBOUR_CHARS, () => 1) };
  };
  return { hit, text: viewOf(hit.content ?? hit.snippet), previous: neighbour(NEIGHBOUR_BEFORE_SQL), next: neighbour(NEIGHBOUR_AFTER_SQL) };
}
