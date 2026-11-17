import { createHash, randomUUID } from 'node:crypto';
import type { MemoryGuess, MemoryKind, MemoryRecord } from 'michi-shared';
import { getDb } from '../db';
import { memoryBodyHash } from './extractionRepository';
import { activeMemoryBodies, activeMemoryWithBody, memoryTransaction, storedMemories, type StoredMemory } from './memoryRepository';
import { memoryRef } from './memoryRefs';
import { createMemory, MemoryError, onMemoryRemoved, type MemoryCaller } from './memoryService';
import { vouchedForRecall } from './typedText';
import { sensitiveForProfile } from './userProfile';
import { isExpired } from './validity';

/**
 * Guesses (migration 0092): a pattern a consolidation run noticed across two
 * or more of the owner's user-scope notes ("the user plans trips around food"
 * from notes on three trips). The user confirms one in Settings › Memory (it
 * becomes a note they saved) or rejects it; nothing asks or notifies them. A
 * guess is never put in a memory pack, never recalled and never used as a
 * fact: it lives in its own table, which only Settings reads.
 *
 * A run proposes at most GUESS_LIMITS.perRun (consolidationPolicy.ts asks for
 * them; consolidation.ts validates and commits them with its decisions). The
 * checks at commit are mechanical: every cited note exists, is the owner's,
 * active at the version cited, in the user scope, trusted and not past its
 * end; at least two notes; every number the guess writes is in those notes;
 * nothing sensitive in it or in them (userProfile.sensitiveForProfile, the
 * profile's rule); not the text of a guess or note the owner has; not on the
 * same notes as an earlier guess (fingerprint), whatever became of it, so a
 * rejected one never comes back. A removed note takes the pending guesses
 * citing it (installMemoryGuessHooks).
 */

export const GUESS_LIMITS = Object.freeze({
  /** Guesses one consolidation run saves at most. */
  perRun: 2,
  /** Notes a guess rests on at least. */
  minRefs: 2,
  /** Pending guesses an owner holds at most: past it, runs save none. */
  maxPending: 20,
  /** Longest guess, in characters. */
  bodyChars: 300,
});

/** One guess as a consolidation answer gives it, its refs resolved to the listed notes. */
export interface GuessProposal {
  text: string;
  cites: Array<{ memoryId: string; version: number }>;
}

export type GuessDropReason =
  | 'blank' | 'too_long' | 'refs' | 'note' | 'number' | 'sensitive' | 'duplicate' | 'seen' | 'run_cap' | 'pending_cap';

export interface GuessCommitResult {
  saved: string[];
  dropped: Array<{ index: number; reason: GuessDropReason }>;
}

interface GuessRow {
  id: string;
  owner_user_id: string;
  body: string;
  refs: string;
  status: 'pending' | 'confirmed' | 'rejected';
  fingerprint: string;
  body_hash: string;
  memory_id: string | null;
  created_at: number;
}

type Cite = { id: string; version: number };

function parseRefs(text: string): Cite[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value)
      ? value.filter((entry): entry is Cite => !!entry && typeof entry.id === 'string' && Number.isSafeInteger(entry.version))
      : [];
  } catch {
    return [];
  }
}

/** The notes a guess rests on, as one key: the same notes give the same fingerprint, in any order. */
function fingerprintOf(memoryIds: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(['memory-guess', 1, [...new Set(memoryIds)].sort()]), 'utf8').digest('hex');
}

/** Maximal runs of decimal digits after NFKC, without leading zeros ("07" is 7). */
function digitRuns(text: string): Set<string> {
  return new Set([...text.normalize('NFKC').matchAll(/\p{Nd}+/gu)].map((match) => match[0].replace(/^0+(?=\d)/u, '')));
}

function trusted(stored: StoredMemory): boolean {
  const { record } = stored;
  return record.sourceRisk === null
    && vouchedForRecall({ body: record.body, sourceRisk: record.sourceRisk, nodeId: record.source?.nodeId ?? null, turnId: record.source?.turnId ?? null });
}

/** A cited note a guess may rest on now: the owner's, active, in the user scope, trusted and not past its end. */
function citable(stored: StoredMemory | undefined, now: number): stored is StoredMemory {
  return !!stored && stored.record.status === 'active' && stored.record.scope.kind === 'user' && trusted(stored)
    && !isExpired(stored.record.validUntil, now);
}

function pendingCount(ownerUserId: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM memory_guesses WHERE owner_user_id = ? AND status = 'pending'`).get(ownerUserId) as { n: number }).n;
}

/**
 * Checks a consolidation run's guesses on the current rows and saves those
 * that pass, at most GUESS_LIMITS.perRun, in order (see the module comment).
 * Call inside the run's commit transaction.
 */
export function commitGuesses(ownerUserId: string, proposals: readonly GuessProposal[], ctx: { runId: string | null; now: number }): GuessCommitResult {
  const result: GuessCommitResult = { saved: [], dropped: [] };
  if (proposals.length === 0) return result;
  const db = getDb();
  const seen = db.prepare('SELECT fingerprint, body_hash FROM memory_guesses WHERE owner_user_id = ?').all(ownerUserId) as Array<{ fingerprint: string; body_hash: string }>;
  const fingerprints = new Set(seen.map((row) => row.fingerprint));
  const bodies = new Set([...seen.map((row) => row.body_hash), ...activeMemoryBodies(ownerUserId, null).map(memoryBodyHash)]);
  let room = Math.max(0, GUESS_LIMITS.maxPending - pendingCount(ownerUserId));
  const insert = db.prepare(`INSERT INTO memory_guesses (id, owner_user_id, body, refs, status, fingerprint, body_hash, run_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`);
  proposals.forEach((proposal, index) => {
    const drop = (reason: GuessDropReason) => { result.dropped.push({ index, reason }); };
    const text = (proposal.text ?? '').replace(/\s+/gu, ' ').trim();
    if (!text) return drop('blank');
    if ([...text].length > GUESS_LIMITS.bodyChars) return drop('too_long');
    if (result.saved.length >= GUESS_LIMITS.perRun) return drop('run_cap');
    if (room <= 0) return drop('pending_cap');
    const cites = [...new Map((proposal.cites ?? []).map((cite) => [cite.memoryId, cite])).values()];
    if (cites.length < GUESS_LIMITS.minRefs) return drop('refs');
    const stored = new Map(storedMemories(ownerUserId, cites.map((cite) => cite.memoryId)).map((entry) => [entry.record.id, entry]));
    const notes = cites.map((cite) => stored.get(cite.memoryId));
    if (!cites.every((cite, position) => citable(notes[position], ctx.now) && notes[position]!.record.version === cite.version)) return drop('note');
    const cited = notes as StoredMemory[];
    const haystack = digitRuns(cited.map((note) => [note.record.body, ...(note.record.keywords ?? [])].join('\n')).join('\n'));
    if ([...digitRuns(text)].some((run) => !haystack.has(run))) return drop('number');
    if (sensitiveForProfile(text) || cited.some((note) => sensitiveForProfile(note.record.body))) return drop('sensitive');
    const bodyHash = memoryBodyHash(text);
    if (bodies.has(bodyHash)) return drop('duplicate');
    const fingerprint = fingerprintOf(cites.map((cite) => cite.memoryId));
    if (fingerprints.has(fingerprint)) return drop('seen');
    const id = `mg-${randomUUID()}`;
    insert.run(id, ownerUserId, text, JSON.stringify(cites.map((cite) => ({ id: cite.memoryId, version: cite.version }))), fingerprint, bodyHash,
      ctx.runId, ctx.now, ctx.now);
    bodies.add(bodyHash);
    fingerprints.add(fingerprint);
    room -= 1;
    result.saved.push(id);
  });
  return result;
}

// ── Settings › Memory ────────────────────────────────────────────────────────

function owner(caller: MemoryCaller): string {
  const id = typeof caller?.ownerUserId === 'string' ? caller.ownerUserId.trim() : '';
  if (!id) throw new MemoryError('invalid_argument', 'ownerUserId is required');
  return id;
}

const GUESS_COLUMNS = 'id, owner_user_id, body, refs, status, fingerprint, body_hash, memory_id, created_at';

/** A pending guess and the notes it rests on as they read now; null while any of them is not citable. */
function shownGuess(ownerUserId: string, row: GuessRow, now: number): { guess: MemoryGuess; notes: StoredMemory[] } | null {
  const cites = parseRefs(row.refs);
  const stored = new Map(storedMemories(ownerUserId, cites.map((cite) => cite.id)).map((entry) => [entry.record.id, entry]));
  const notes = cites.map((cite) => stored.get(cite.id));
  if (cites.length < GUESS_LIMITS.minRefs || !notes.every((note) => citable(note, now))) return null;
  const shown = notes as StoredMemory[];
  return {
    guess: {
      id: row.id, body: row.body, createdAt: row.created_at,
      cites: shown.map((note) => ({ ref: memoryRef(note.rowId, note.record.version), id: note.record.id, body: note.record.body })),
    },
    notes: shown,
  };
}

/**
 * GET /api/memory-guesses: the owner's pending guesses, newest first, each
 * with the notes it rests on; one resting on a note that changed scope, was
 * corrected or is past its end is left out. Works with memory off.
 */
export function listGuesses(caller: MemoryCaller, now = Date.now()): MemoryGuess[] {
  const ownerUserId = owner(caller);
  const rows = getDb().prepare(`SELECT ${GUESS_COLUMNS} FROM memory_guesses WHERE owner_user_id = ? AND status = 'pending'
    ORDER BY created_at DESC, rowid DESC`).all(ownerUserId) as unknown as GuessRow[];
  return rows.flatMap((row) => {
    const shown = shownGuess(ownerUserId, row, now);
    return shown ? [shown.guess] : [];
  });
}

function pendingGuess(ownerUserId: string, id: unknown): GuessRow {
  const row = typeof id === 'string' && id
    ? getDb().prepare(`SELECT ${GUESS_COLUMNS} FROM memory_guesses WHERE id = ? AND owner_user_id = ?`).get(id, ownerUserId) as GuessRow | undefined
    : undefined;
  if (!row) throw new MemoryError('not_found', 'Guess not found');
  if (row.status !== 'pending') throw new MemoryError('invalid_state', `This guess was already ${row.status}`);
  return row;
}

/** The kind most of the notes share (the first note's on a tie). */
function kindOf(notes: readonly StoredMemory[]): MemoryKind {
  const counts = new Map<MemoryKind, number>();
  for (const note of notes) counts.set(note.record.kind, (counts.get(note.record.kind) ?? 0) + 1);
  let best = notes[0]!.record.kind;
  for (const [kind, count] of counts) if (count > (counts.get(best) ?? 0)) best = kind;
  return best;
}

/**
 * POST /api/memory-guesses/:id/confirm ("That's right"): the guess becomes a
 * note the user saved (origin explicit, the user scope, the kind most of its
 * notes have, their search words), or names the note that already says it;
 * the guess is confirmed. invalid_state when the notes it rests on changed
 * since (it is no longer listed); memory_disabled with memory off.
 */
export function confirmGuess(caller: MemoryCaller, id: string, now = Date.now()): MemoryRecord {
  const ownerUserId = owner(caller);
  return memoryTransaction(() => {
    const row = pendingGuess(ownerUserId, id);
    const shown = shownGuess(ownerUserId, row, now);
    if (!shown) throw new MemoryError('invalid_state', 'The notes this guess rests on changed; it no longer applies');
    const keywords = [...new Set(shown.notes.flatMap((note) => note.record.keywords ?? []))].slice(0, 10);
    const record = activeMemoryWithBody(ownerUserId, null, row.body, now)?.record
      ?? createMemory({ ownerUserId }, { scope: { kind: 'user' }, kind: kindOf(shown.notes), body: row.body, status: 'active', origin: 'explicit', keywords });
    getDb().prepare(`UPDATE memory_guesses SET status = 'confirmed', memory_id = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?`)
      .run(record.id, now, row.id, ownerUserId);
    return record;
  });
}

/**
 * POST /api/memory-guesses/:id/reject ("Not true"): the guess is rejected and
 * loses its text; its fingerprint stays, so no run proposes a guess on the
 * same notes, or with the same text, again.
 */
export function rejectGuess(caller: MemoryCaller, id: string, now = Date.now()): void {
  const ownerUserId = owner(caller);
  memoryTransaction(() => {
    const row = pendingGuess(ownerUserId, id);
    getDb().prepare(`UPDATE memory_guesses SET status = 'rejected', body = '', updated_at = ? WHERE id = ? AND owner_user_id = ?`)
      .run(now, row.id, ownerUserId);
  });
}

/** Every removal of a user-scope memory takes the pending guesses citing it, in the removing transaction. Returns an uninstall. */
export function installMemoryGuessHooks(): () => void {
  return onMemoryRemoved(({ record }) => {
    if (record.scope.kind !== 'user') return;
    getDb().prepare(`DELETE FROM memory_guesses WHERE owner_user_id = ? AND status = 'pending'
      AND EXISTS (SELECT 1 FROM json_each(memory_guesses.refs) j WHERE json_extract(j.value, '$.id') = ?)`).run(record.ownerUserId, record.id);
  });
}
