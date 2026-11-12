import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type { MemoryRecord } from 'michi-shared';
import { getDb } from '../db';
import { getWorkspace } from '../dbRepository';
import { log } from '../logger';
import { startOfLocalDay } from '../metaAgent/todayUsage';
import {
  buildConsolidationPrompt, CONSOLIDATION_LIMITS, CONSOLIDATION_PAYLOAD_SCHEMA,
  type ConsolidationBatch, type ConsolidationGroup, type ConsolidationNote, type ConsolidationWho,
} from './consolidationPolicy';
import { normalizeMemoryBody } from './extractionRepository';
import {
  activeMemoriesFromTurn, activeMichiNoteCount, consolidationActiveRows, consolidationRows, consolidationRowsAfter, consolidationWaiting,
  hasLearningSource, memoryTransaction, memoryWorkspaceIds, storedMemories, type ConsolidationMemoryRow,
} from './memoryRepository';
import { memoryDay, memoryRef, parseRef } from './memoryRefs';
import { announceMemoryChanges, mergeMemoryInto, restoreMergedMemory } from './memoryService';
import { recallSearch } from './recallIndex';
import { humanTurnRunning, lastHumanActivityAt, withoutUserSubject } from './typedText';
import { remapProfileCitations } from './userProfile';

/**
 * Consolidation ("dreaming", spec round 10 §C): a background automatic
 * memory run puts away Michi's own notes that repeat another note, or that a
 * newer note replaced. The model decides which; this module does the rest:
 * when a run is due, which notes it lists, what an answer may say, and the
 * commit. It never writes memory text and never deletes: an applied decision
 * marks one of Michi's own notes superseded with a link to the note it went
 * into (memoryService.mergeMemoryInto), which stays exactly as it is.
 *
 * What it may change: Michi's own notes (origin extracted, not imported, not
 * edited by the user, trusted) whose source still learns. The user's own
 * notes, imported ones and those the user edited are never changed; they may
 * be what a note goes into. It shows the user nothing: no receipt, toast,
 * badge or status line; Settings › Memory lists the result as it lists any
 * change.
 *
 * Safety is mechanical: the batch and each decision are checked again at
 * commit on the current rows (status, version, protection, source, area, the
 * rules), one transaction applies them, every listed memory's preimage is
 * logged (memory_consolidation_log, ids and versions only, kept about 7
 * days: revertConsolidation), and the cursor moves only when a run commits
 * or its answer is unreadable past its repairs.
 *
 * The seam is shared by production (extractionRun.ts plans and settles runs,
 * answered by a direct call or a memory_consolidate call) and evaluations:
 * nextConsolidationBatch, buildConsolidationPrompt, validateConsolidationPayload
 * and commitConsolidation. This module never imports extractionRun.ts (which
 * imports it): the caller passes what it owns (holds, live workspaces).
 */

/** The id prefix of a consolidation run (memory_extraction_runs kind 'consolidate'). */
export const CONSOLIDATION_RUN_ID_PREFIX = 'mcr-';

export { buildConsolidationPrompt, CONSOLIDATION_INSTRUCTIONS, CONSOLIDATION_LIMITS, CONSOLIDATION_PAYLOAD_SCHEMA } from './consolidationPolicy';
export type { ConsolidationBatch, ConsolidationNote } from './consolidationPolicy';

// ── state ────────────────────────────────────────────────────────────────────

export interface ConsolidationState {
  /** A memory whose (updated_at, row_id) is at or below this was looked at. */
  cursor: { at: number; row: number };
  /** Where the live run moves the cursor when it commits. */
  planned: { runId: string; at: number; row: number } | null;
}

interface StateRow { cursor_at: number; cursor_row: number; planned_run_id: string | null; planned_at: number | null; planned_row: number | null }

/** The owner's consolidation state; an owner without a row starts at (0, 0) (nothing looked at yet). */
export function readConsolidationState(ownerUserId: string): ConsolidationState {
  const row = getDb().prepare('SELECT cursor_at, cursor_row, planned_run_id, planned_at, planned_row FROM memory_consolidation_state WHERE owner_user_id = ?')
    .get(ownerUserId) as StateRow | undefined;
  return {
    cursor: { at: row?.cursor_at ?? 0, row: row?.cursor_row ?? 0 },
    planned: row?.planned_run_id && row.planned_at !== null && row.planned_row !== null
      ? { runId: row.planned_run_id, at: row.planned_at, row: row.planned_row } : null,
  };
}

function ensureState(ownerUserId: string, now: number): void {
  getDb().prepare(`INSERT INTO memory_consolidation_state (owner_user_id, cursor_at, cursor_row, updated_at) VALUES (?, 0, 0, ?)
    ON CONFLICT(owner_user_id) DO NOTHING`).run(ownerUserId, now);
}

/** Moves the cursor forward to `to` (never back) and clears what was planned. */
function moveCursor(ownerUserId: string, to: { at: number; row: number }, now: number): void {
  ensureState(ownerUserId, now);
  getDb().prepare(`UPDATE memory_consolidation_state SET
      cursor_at = CASE WHEN ? > cursor_at OR (? = cursor_at AND ? > cursor_row) THEN ? ELSE cursor_at END,
      cursor_row = CASE WHEN ? > cursor_at OR (? = cursor_at AND ? > cursor_row) THEN ? ELSE cursor_row END,
      planned_run_id = NULL, planned_at = NULL, planned_row = NULL, updated_at = ? WHERE owner_user_id = ?`)
    .run(to.at, to.at, to.row, to.at, to.at, to.at, to.row, to.row, now, ownerUserId);
}

/** The run `runId` will move the cursor to `to` when it commits. */
export function planConsolidationCursor(ownerUserId: string, runId: string, to: { at: number; row: number }, now: number): void {
  ensureState(ownerUserId, now);
  getDb().prepare(`UPDATE memory_consolidation_state SET planned_run_id = ?, planned_at = ?, planned_row = ?, updated_at = ? WHERE owner_user_id = ?`)
    .run(runId, to.at, to.row, now, ownerUserId);
}

/** The run ended without committing: what it planned is cleared; the cursor stays. */
export function clearPlannedCursor(ownerUserId: string, runId: string, now: number): void {
  getDb().prepare(`UPDATE memory_consolidation_state SET planned_run_id = NULL, planned_at = NULL, planned_row = NULL, updated_at = ?
    WHERE owner_user_id = ? AND planned_run_id = ?`).run(now, ownerUserId, runId);
}

/** The cursor a run planned, when it is still that run's. */
export function plannedCursorOf(ownerUserId: string, runId: string): { at: number; row: number } | null {
  const planned = readConsolidationState(ownerUserId).planned;
  return planned && planned.runId === runId ? { at: planned.at, row: planned.row } : null;
}

/** The cursor moves past `to` (a range with no pair to look at, or an unreadable answer). Call inside a transaction. */
export function advanceConsolidationCursor(ownerUserId: string, to: { at: number; row: number }, now: number): void {
  moveCursor(ownerUserId, to, now);
}

// ── when it runs ─────────────────────────────────────────────────────────────

/** What the caller (extractionRun.ts) owns of the due rule. */
export interface ConsolidationHolds {
  /** Why automatic memory may not run for the owner now (not local, memory off, paused, maintenance paused), or null. */
  hold: string | null;
  /** Tokens left of automatic memory's shared daily limit, and the least an execution starts with. */
  budgetLeft: number;
  minBudget: number;
  /** When this process started: idle time counts from it at least. null: no such floor. */
  bootAt: number | null;
}

interface RunRow { state: string; started_at: number }

/** The owner's newest consolidate runs; `finishedOnly`: those that ended, a cancelled one left out (the backoff's). */
function consolidateRuns(ownerUserId: string, limit: number, finishedOnly: boolean): RunRow[] {
  return getDb().prepare(`SELECT state, started_at FROM memory_extraction_runs WHERE owner_user_id = ? AND kind = 'consolidate'
    ${finishedOnly ? "AND state NOT IN ('cancelled', 'active')" : ''} ORDER BY started_at DESC, rowid DESC LIMIT ?`)
    .all(ownerUserId, limit) as unknown as RunRow[];
}

/** A consolidate run of the owner is live: active, and its scheduler run still running. */
export function liveConsolidationRun(ownerUserId: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM memory_extraction_runs x WHERE x.owner_user_id = ? AND x.kind = 'consolidate' AND x.state = 'active'
    AND EXISTS (SELECT 1 FROM scheduled_job_runs r WHERE r.id = x.run_id AND r.status = 'running') LIMIT 1`).get(ownerUserId);
}

/**
 * A run of the owner's automatic memory of any kind is live (an extraction, a profile rebuild, a consolidation):
 * consolidation never starts beside one, since what it puts away may be what that run is reading (a rebuild that
 * listed a note would drop the line citing it).
 */
function liveMemoryRun(ownerUserId: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM memory_extraction_runs x WHERE x.owner_user_id = ? AND x.state = 'active'
    AND EXISTS (SELECT 1 FROM scheduled_job_runs r WHERE r.id = x.run_id AND r.status = 'running') LIMIT 1`).get(ownerUserId);
}

/** Tokens the owner's consolidate runs used today (reported, else estimated). */
export function consolidationTokensToday(ownerUserId: string, now: number): number {
  return (getDb().prepare(`SELECT COALESCE(SUM(COALESCE(reported_tokens, estimated_tokens)), 0) AS n FROM memory_extraction_runs
    WHERE owner_user_id = ? AND kind = 'consolidate' AND started_at >= ?`).get(ownerUserId, startOfLocalDay(now)) as { n: number }).n;
}

/** Changes consolidation applied today for the owner. */
export function consolidationChangesToday(ownerUserId: string, now: number): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM memory_consolidation_log WHERE owner_user_id = ? AND outcome = 'applied' AND created_at >= ?`)
    .get(ownerUserId, startOfLocalDay(now)) as { n: number }).n;
}

/**
 * Whether a consolidation run is due for the owner (spec §C4): automatic
 * memory may run, budget is left (the shared limit, consolidation's own
 * daily tokens and changes), no run of automatic memory is live (a profile
 * rebuild reads the notes it would put away), the newest started
 * at least spacingMs ago, the last backoffFailures did not all fail within
 * backoffMs, and no turn a person typed is running; then a memory written
 * after the cursor waits and the user has been idle idleMs, or
 * waitingTrigger wait, or the oldest waited oldestWaitingMs. Reads the
 * database and typedText's in-process activity; never writes.
 */
export function consolidationDue(ownerUserId: string, now: number, holds: ConsolidationHolds): boolean {
  if (holds.hold !== null || holds.budgetLeft < holds.minBudget) return false;
  if (consolidationTokensToday(ownerUserId, now) >= CONSOLIDATION_LIMITS.dailyTokens) return false;
  if (consolidationChangesToday(ownerUserId, now) >= CONSOLIDATION_LIMITS.changesPerDay) return false;
  if (liveMemoryRun(ownerUserId)) return false;
  // Any run uses its spacing slot, a cancelled one included.
  const newest = consolidateRuns(ownerUserId, 1, false)[0];
  if (newest && now - newest.started_at < CONSOLIDATION_LIMITS.spacingMs) return false;
  const recent = consolidateRuns(ownerUserId, CONSOLIDATION_LIMITS.backoffFailures, true);
  if (recent.length >= CONSOLIDATION_LIMITS.backoffFailures && recent.every((run) => run.state === 'failed')
    && now - recent[0]!.started_at < CONSOLIDATION_LIMITS.backoffMs) return false;
  if (humanTurnRunning()) return false;
  const waiting = consolidationWaiting(ownerUserId, readConsolidationState(ownerUserId).cursor);
  if (waiting.count === 0) return false;
  const lastActivity = Math.max(lastHumanActivityAt() ?? 0, holds.bootAt ?? 0);
  return now - lastActivity >= CONSOLIDATION_LIMITS.idleMs || waiting.count >= CONSOLIDATION_LIMITS.waitingTrigger
    || (waiting.oldest !== null && now - waiting.oldest >= CONSOLIDATION_LIMITS.oldestWaitingMs);
}

// ── the batch ────────────────────────────────────────────────────────────────

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/u;

/** Rough token count, as Michi counts it elsewhere: a CJK character is one token, other text four characters per token. */
function tokensOf(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function whoOf(row: ConsolidationMemoryRow): ConsolidationWho {
  if (row.record.origin === 'explicit') return 'user';
  if (row.record.importSource) return 'imported';
  if (row.userEditedAt !== null) return 'edited';
  return 'michi';
}

/**
 * A memory as a run lists it, read now. Changeable: Michi's own, active and trusted, its source still learning, and
 * short enough that the prompt shows it whole (CONSOLIDATION_LIMITS.bodyChars): what the model did not read is never
 * put away.
 */
export function consolidationNote(row: ConsolidationMemoryRow): ConsolidationNote {
  const record = row.record;
  const who = whoOf(row);
  const learns = hasLearningSource(record);
  return {
    ref: memoryRef(row.rowId, record.version), memoryId: record.id, rowId: row.rowId, version: record.version, who, learns,
    changeable: who === 'michi' && record.status === 'active' && record.sourceRisk === null && learns
      && [...record.body].length <= CONSOLIDATION_LIMITS.bodyChars,
    workspaceId: record.scope.kind === 'workspace' ? record.scope.workspaceId : null,
    kind: record.kind, body: record.body, keywords: record.keywords ?? [],
    said: Math.max(record.observedAt ?? record.createdAt, row.userEditedAt ?? 0),
    eventAt: record.eventAt ?? null,
    pinnable: record.origin === 'explicit' || ((record.kind === 'preference' || record.kind === 'convention') && (record.eventAt ?? null) === null),
    sourceTurnId: record.source?.turnId ?? null,
    updatedAt: record.updatedAt,
  };
}

/** Rule 6's scope for a duplicate: the same scope, or a workspace note into a user-scope one. */
function duplicateScopeFits(ref: ConsolidationNote, into: ConsolidationNote): boolean {
  return ref.workspaceId === into.workspaceId || (into.workspaceId === null && ref.workspaceId !== null);
}

/**
 * Rule 7: a note goes only where it stays as visible: a note a pack pins only into one a pack pins too, and no note
 * into a Michi note whose source no longer learns (a conversation set to Use only or Off).
 */
function visibilityFits(ref: ConsolidationNote, into: ConsolidationNote): boolean {
  return (!ref.pinnable || into.pinnable) && !(into.who === 'michi' && into.learns === false);
}

/** One of the two may change and the other may take it (rules 6 and 7, either way). */
function pairable(a: ConsolidationNote, b: ConsolidationNote): boolean {
  const fits = (subject: ConsolidationNote, into: ConsolidationNote) => subject.changeable && duplicateScopeFits(subject, into) && visibilityFits(subject, into);
  return fits(a, b) || fits(b, a);
}

/**
 * The next batch for the owner (spec §C5): up to inputsPerRun memories
 * written or changed after the cursor (active and trusted), each with up to
 * neighboursPerInput notes found near it, nearest first: those from the same
 * source turn, those whose body reads the same, then recall's own search over
 * its body and keywords (both languages carry cross-language pairs). A
 * neighbour is active, trusted, in an area (the user scope or a live
 * workspace: `liveWorkspace`) and in the input's reach, and one of the two
 * may go into the other. One group per input with a neighbour, in input
 * order, until the listing caps; the run's inputs are those up to there.
 * Null when nothing waits. Database reads only.
 */
export function nextConsolidationBatch(ownerUserId: string, now: number, liveWorkspace: (workspaceId: string) => boolean): ConsolidationBatch | null {
  const state = readConsolidationState(ownerUserId);
  const waiting = consolidationRowsAfter(ownerUserId, state.cursor, CONSOLIDATION_LIMITS.inputsPerRun);
  if (waiting.length === 0) return null;
  const live = memoryWorkspaceIds(ownerUserId).filter((workspaceId) => {
    try { return liveWorkspace(workspaceId); } catch { return false; }
  });
  const liveSet = new Set(live);
  const inArea = (note: ConsolidationNote) => note.workspaceId === null || liveSet.has(note.workspaceId);
  const active = consolidationActiveRows(ownerUserId, live);
  const notes = new Map<string, ConsolidationNote>();
  const noteFor = (row: ConsolidationMemoryRow): ConsolidationNote => {
    let note = notes.get(row.record.id);
    if (!note) { note = consolidationNote(row); notes.set(note.memoryId, note); }
    return note;
  };
  const byId = new Map(active.map((row) => [row.record.id, row]));
  const byBody = new Map<string, ConsolidationMemoryRow[]>();
  for (const row of active) {
    const key = normalizeMemoryBody(row.record.body);
    byBody.set(key, [...(byBody.get(key) ?? []), row]);
  }

  const neighboursOf = (input: ConsolidationNote): ConsolidationNote[] => {
    const reach = input.workspaceId === null ? live : [input.workspaceId];
    const inReach = (note: ConsolidationNote) => note.workspaceId === null || reach.includes(note.workspaceId);
    const ids: string[] = [];
    if (input.sourceTurnId) for (const memory of activeMemoriesFromTurn(ownerUserId, input.sourceTurnId)) ids.push(memory.id);
    for (const row of byBody.get(normalizeMemoryBody(input.body)) ?? []) ids.push(row.record.id);
    try {
      // As memory_save's similarAutomatic asks recall: a note's third-person subject ("The user …") says nothing of what it is.
      for (const hit of recallSearch({
        ownerUserId, kinds: ['memory'], query: [withoutUserSubject(input.body), ...input.keywords].join('\n'), includeUserScope: true,
        memoryWorkspaceIds: reach, workspaceIds: [], gate: true, limit: 8, now,
      })) ids.push(hit.refId);
    } catch (error) {
      log.warn('scheduler', 'consolidation: recall search failed', { error: error instanceof Error ? error.message : String(error) });
    }
    const kept: ConsolidationNote[] = [];
    const seen = new Set<string>([input.memoryId]);
    for (const id of ids) {
      if (kept.length >= CONSOLIDATION_LIMITS.neighboursPerInput) break;
      if (seen.has(id)) continue;
      seen.add(id);
      const row = byId.get(id);
      if (!row) continue; // not active, untrusted, or outside the user scope and the live workspaces
      const note = noteFor(row);
      if (!inArea(note) || !inReach(note) || !pairable(input, note)) continue;
      kept.push(note);
    }
    return kept;
  };

  const groups: ConsolidationGroup[] = [];
  const inputs: string[] = [];
  let through = state.cursor;
  let listed = 0;
  let bodyTokens = 0;
  for (const row of waiting) {
    const input = noteFor(row);
    const neighbours = inArea(input) ? neighboursOf(input) : [];
    if (neighbours.length > 0) {
      const members = [input, ...neighbours];
      const cost = members.reduce((sum, note) => sum + tokensOf([...note.body].slice(0, CONSOLIDATION_LIMITS.bodyChars).join('')), 0);
      if (groups.length > 0 && (listed + members.length > CONSOLIDATION_LIMITS.listedNotes || bodyTokens + cost > CONSOLIDATION_LIMITS.listedBodyTokens)) break;
      groups.push({ index: groups.length + 1, members: members.map((note) => note.memoryId) });
      listed += members.length;
      bodyTokens += cost;
    }
    inputs.push(input.memoryId);
    through = { at: row.record.updatedAt, row: row.rowId };
  }
  // Only what the groups list (and every input, for the log) stays.
  const listedIds = new Set([...inputs, ...groups.flatMap((group) => group.members)]);
  for (const id of [...notes.keys()]) if (!listedIds.has(id)) notes.delete(id);
  const areaNames = areaNamesOf([...notes.values()]);
  return { ownerUserId, notes, groups, inputs, areaNames, through };
}

/** The workspaces the notes belong to, by name (a name two workspaces share gets a number). */
function areaNamesOf(notes: readonly ConsolidationNote[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const workspaceId of [...new Set(notes.map((note) => note.workspaceId).filter((id): id is string => id !== null))].sort()) {
    const base = (getWorkspace(workspaceId)?.name ?? 'a project').replace(/\s+/gu, ' ').trim().slice(0, 60) || 'a project';
    let name = base;
    for (let n = 2; used.has(name); n += 1) name = `${base} (${n})`;
    used.add(name);
    names.set(workspaceId, name);
  }
  return names;
}

/** One entry of a run's listing (memory_extraction_runs.related_memories): ids and versions, never text. */
export interface ConsolidationListing {
  ref: string;
  memoryId: string;
  version: number;
  /** The group it is listed in (1-based); null for an input without a group. */
  group: number | null;
  /** It is the group's input (or an input without a group). */
  input: boolean;
}

/** A batch as a run records it: one entry per line of the prompt, then one per input without a group. */
export function consolidationListing(batch: ConsolidationBatch): ConsolidationListing[] {
  const entries: ConsolidationListing[] = [];
  for (const group of batch.groups) {
    group.members.forEach((memoryId, position) => {
      const note = batch.notes.get(memoryId)!;
      entries.push({ ref: note.ref, memoryId, version: note.version, group: group.index, input: position === 0 });
    });
  }
  const grouped = new Set(batch.groups.map((group) => group.members[0]));
  for (const memoryId of batch.inputs) {
    if (grouped.has(memoryId)) continue;
    const note = batch.notes.get(memoryId)!;
    entries.push({ ref: note.ref, memoryId, version: note.version, group: null, input: true });
  }
  return entries;
}

/** A run's listing as recorded (unrecognised entries left out). */
export function parseConsolidationListing(related: ReadonlyArray<Record<string, unknown> | { ref: string; memoryId: string }>): ConsolidationListing[] {
  return related.flatMap((entry) => {
    const value = entry as Record<string, unknown>;
    if (typeof value.ref !== 'string' || typeof value.memoryId !== 'string' || !Number.isSafeInteger(value.version)) return [];
    const group = value.group === null || Number.isSafeInteger(value.group) ? value.group as number | null : null;
    return [{ ref: value.ref, memoryId: value.memoryId, version: value.version as number, group, input: value.input === true }];
  });
}

/** A listed note as it reads now; `stale`: it is gone, changed since it was listed, or no longer active. */
export interface ListedNote extends ConsolidationNote {
  stale: boolean;
}

/** A recorded run's batch, its notes read again now (the listed versions kept: a changed one is stale). */
export interface ListedBatch extends Omit<ConsolidationBatch, 'notes'> {
  notes: Map<string, ListedNote>;
}

/** The batch a run listed, rebuilt from its listing and the current rows (for staging its answer and for the commit). */
export function listedConsolidationBatch(ownerUserId: string, listing: readonly ConsolidationListing[], through?: { at: number; row: number } | null): ListedBatch {
  const rows = new Map(consolidationRows(ownerUserId, [...new Set(listing.map((entry) => entry.memoryId))]).map((row) => [row.record.id, row]));
  const notes = new Map<string, ListedNote>();
  const groups = new Map<number, string[]>();
  const inputs: string[] = [];
  for (const entry of listing) {
    if (!notes.has(entry.memoryId)) {
      const row = rows.get(entry.memoryId);
      const parsed = parseRef(entry.ref);
      const current = row ? consolidationNote(row) : null;
      const stale = !row || row.record.status !== 'active' || row.record.version !== entry.version;
      notes.set(entry.memoryId, current
        ? { ...current, ref: entry.ref, version: entry.version, stale }
        : {
          ref: entry.ref, memoryId: entry.memoryId, rowId: parsed?.kind === 'memory' ? parsed.rowId : 0, version: entry.version, who: 'michi',
          learns: false, changeable: false, workspaceId: null, kind: 'fact', body: '', keywords: [], said: 0, eventAt: null, pinnable: false,
          sourceTurnId: null, updatedAt: 0, stale: true,
        });
    }
    if (entry.group !== null) groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry.memoryId]);
    if (entry.input && !inputs.includes(entry.memoryId)) inputs.push(entry.memoryId);
  }
  return {
    ownerUserId, notes, inputs, areaNames: areaNamesOf([...notes.values()]),
    groups: [...groups].sort((a, b) => a[0] - b[0]).map(([index, members]) => ({ index, members })),
    through: through ?? { at: 0, row: 0 },
  };
}

// ── the answer ───────────────────────────────────────────────────────────────

export type ConsolidationOp = 'keep' | 'duplicate' | 'outdated';

/** One decision of a validated answer, by memory id; the model's reasons are never kept. */
export interface ConsolidationDecision {
  ref: string;
  memoryId: string;
  op: ConsolidationOp;
  into: string | null;
  intoId: string | null;
}

/** A validated answer: a decision for every input of a group (keep when the model gave none), at most one per note. */
export interface ConsolidationPayload {
  decisions: ConsolidationDecision[];
}

/** An answer that breaks the schema or a rule; problems name each decision (decisions[1] m:… …). */
export class ConsolidationPayloadError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'ConsolidationPayloadError';
  }
}

let payloadCheck: ((value: unknown) => { valid: boolean; errorMessage?: string }) | null = null;

/** Ajv's "data/decisions/0/op must …" as "decisions[0].op must …". */
function schemaProblems(errorMessage: string | undefined): string[] {
  return (errorMessage || 'the answer does not match the schema').split(/,\s+(?=data\b)/u).map((part) =>
    part.replace(/^data((?:\/[^\s/]+)*)/u, (_match, path: string) => {
      const segments = path.split('/').filter(Boolean).map((segment) => (/^\d+$/u.test(segment) ? `[${segment}]` : `.${segment}`));
      return segments.length ? segments.join('').replace(/^\./u, '') : 'the answer';
    }));
}

/** decisions left out (or null) is none; an MCP client's own metadata (_meta) is no part of the answer. */
function withDefaults(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { _meta: _ignored, ...answer } = value as Record<string, unknown>;
  return { ...answer, decisions: answer.decisions ?? [] };
}

/** Maximal runs of decimal digits after NFKC, without leading zeros ("07" is 7). */
export function digitRuns(text: string): Set<string> {
  return new Set([...(text ?? '').normalize('NFKC').matchAll(/\p{Nd}+/gu)].map((match) => match[0].replace(/^0+(?=\d)/u, '')));
}

const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const URL_TOKEN = /https?:\/\/[^\s<>"'`，。；、）)]+/giu;
const CODE_RUN = /[\p{L}\p{N}._/:@#+-]+/gu;
const EDGE = /^[._/:@#+-]+|[._/:@#+-]+$/gu;

/**
 * The code tokens of a text, case-folded: URLs, and maximal runs of letters,
 * digits and ._/:@#+- that hold a digit (v22, us-east-1, 5.7) or one of
 * ._/:@# between letters or digits (src/app.ts, a@b.com), edges trimmed. CJK
 * characters end a run (they are words, not identifiers); the digits in them
 * are digitRuns'.
 */
export function codeTokens(text: string): Set<string> {
  const folded = (text ?? '').normalize('NFKC').toLowerCase();
  const tokens = new Set<string>();
  const rest = folded.replace(URL_TOKEN, (url) => { tokens.add(url.replace(/[.,;:!?]+$/u, '')); return ' '; });
  for (const segment of rest.split(CJK_SCRIPT)) {
    for (const match of segment.matchAll(CODE_RUN)) {
      const token = match[0].replace(EDGE, '');
      if (!token) continue;
      if (/\p{N}/u.test(token) || /[\p{L}\p{N}][._/:@#][\p{L}\p{N}]/u.test(token)) tokens.add(token);
    }
  }
  return tokens;
}

/**
 * What rule 8 finds the into lacks of the ref: its digit runs (7月10日 is in 2026-07-10), and its code tokens, each a
 * whole token of the into's body or keywords (prod.example.com is not in preprod.example.com, nor src/app.ts in
 * src/app.tsx; a bare number is a digit run's to check). Empty: it holds them all.
 */
export function containmentGaps(ref: Pick<ConsolidationNote, 'body'>, into: Pick<ConsolidationNote, 'body' | 'keywords'>): string[] {
  const haystack = [into.body, ...into.keywords].join('\n');
  const digits = digitRuns(haystack);
  const codes = codeTokens(haystack);
  const gaps = [...digitRuns(ref.body)].filter((run) => !digits.has(run));
  for (const token of codeTokens(ref.body)) if (!/^\p{N}+$/u.test(token) && !codes.has(token)) gaps.push(token);
  return [...new Set(gaps)];
}

export interface ValidateConsolidationOptions {
  /** true (default) while a repair is left: any broken rule fails the answer. false: such decisions become keep. */
  strict?: boolean;
  /** Changes consolidation applied today already (rule 10). */
  appliedToday?: number;
  /** The owner's active Michi notes (rule 10's share). */
  activeMichiNotes?: number;
}

/** The changes one run may apply (rule 10): changesPerRun, and the share of the owner's Michi notes, minChanges at least. */
export function runChangeCap(activeMichiNotes: number): number {
  return Math.min(CONSOLIDATION_LIMITS.changesPerRun,
    Math.max(CONSOLIDATION_LIMITS.minChanges, Math.ceil(CONSOLIDATION_LIMITS.changeShare * Math.max(0, activeMichiNotes))));
}

type CheckedNote = ConsolidationNote & { stale?: boolean };

/**
 * Rules 4 and 6-9 for one non-keep decision on these notes (as listed, or
 * read again at commit): the rule broken and the message, or null.
 */
export function decisionProblem(op: Exclude<ConsolidationOp, 'keep'>, ref: CheckedNote, into: CheckedNote): { rule: number; message: string } | null {
  if (!ref.changeable) {
    return { rule: 4, message: ref.who === 'michi' ? `${ref.ref} cannot be changed: keep it` : `${ref.ref} is the user's own: keep it` };
  }
  if (op === 'duplicate' ? !duplicateScopeFits(ref, into) : ref.workspaceId !== into.workspaceId) {
    return { rule: 6, message: op === 'duplicate'
      ? `${into.ref} is about ${into.workspaceId === null ? 'all the user\'s work' : 'a project'}, ${ref.ref} about ${ref.workspaceId === null ? 'all of it' : 'another project'}: keep it`
      : `${into.ref} and ${ref.ref} are not about the same area: keep it` };
  }
  if (!visibilityFits(ref, into)) {
    return { rule: 7, message: into.who === 'michi' && into.learns === false
      ? `${into.ref} comes from a conversation that no longer adds to memory: keep it, or choose another note`
      : `${ref.ref} is a standing preference or rule and ${into.ref} is not: keep it, or choose another note` };
  }
  if (op === 'duplicate') {
    const gaps = containmentGaps(ref, into);
    if (gaps.length > 0) {
      return { rule: 8, message: `${into.ref} does not hold ${gaps.map((gap) => JSON.stringify(gap)).join(', ')}; keep it, or choose another note` };
    }
    if (ref.eventAt !== null && (into.eventAt === null || memoryDay(into.eventAt) !== memoryDay(ref.eventAt))) {
      return { rule: 8, message: `${ref.ref} is about ${memoryDay(ref.eventAt)} and ${into.ref} is not about that day; keep it` };
    }
  } else if (!(into.said > ref.said)) {
    return { rule: 9, message: `${into.ref} was not said after ${ref.ref}, so it does not replace it; keep it` };
  }
  return null;
}

interface RawDecision { ref: string; op: ConsolidationOp; into: string | null; why?: string }

/** The listed note a ref names (a ref without a version names the listed one); null when it was not listed at that version. */
function listedNote(batch: Pick<ListedBatch, 'notes'> | Pick<ConsolidationBatch, 'notes'>, text: string | null): CheckedNote | null {
  const parsed = text ? parseRef(text) : null;
  if (!parsed || parsed.kind !== 'memory') return null;
  for (const note of batch.notes.values()) {
    if (note.rowId === parsed.rowId) return parsed.version === null || parsed.version === note.version ? note : null;
  }
  return null;
}

/**
 * Checks an answer for a batch (spec §C7) and normalizes it: the schema;
 * one decision for every group's input and at most one per note, each ref
 * and into listed at its listed version (rule 2); keep without an into, a
 * change into another note of the same group (3); only a note that may
 * change changes (4); no chains (5); scope (6) and visibility (7); a
 * duplicate's into holds its digits, codes and event day (8); an outdated
 * note's into was said later (9); the caps (10). Strict (while a repair is
 * left): any broken rule throws ConsolidationPayloadError with every
 * problem. Lenient (the last answer): a decision breaking a rule, and a
 * missing one, becomes keep; schema problems always throw. A stale note (gone
 * or changed since it was listed) is not the model's to fix: its decisions
 * stand here, and the commit skips them.
 */
export function validateConsolidationPayload(raw: unknown, batch: ListedBatch | ConsolidationBatch, options: ValidateConsolidationOptions = {}): ConsolidationPayload {
  payloadCheck ??= new AjvJsonSchemaValidator().getValidator(CONSOLIDATION_PAYLOAD_SCHEMA as Record<string, unknown>);
  const answer = withDefaults(raw);
  const checked = payloadCheck(answer);
  if (!checked.valid) throw new ConsolidationPayloadError(schemaProblems(checked.errorMessage));
  const strict = options.strict !== false;
  const decisions = (answer as { decisions: RawDecision[] }).decisions;
  const groupsOf = new Map<string, Set<number>>();
  for (const group of batch.groups) for (const id of group.members) groupsOf.set(id, new Set([...(groupsOf.get(id) ?? []), group.index]));
  const inputs = batch.groups.map((group) => group.members[0]!);
  const problems: string[] = [];
  const decided = new Map<string, ConsolidationDecision>();
  const changes: Array<{ index: number; decision: ConsolidationDecision }> = [];
  decisions.forEach((decision, index) => {
    const where = `decisions[${index}] ${decision.ref}`;
    const fail = (message: string) => { if (strict) problems.push(`${where}: ${message}`); };
    const ref = listedNote(batch, decision.ref);
    if (!ref) return fail(`${decision.ref} was not listed in this run (use the refs exactly as listed)`);
    if (decided.has(ref.memoryId)) return fail(`${ref.ref} has more than one decision: give one`);
    if (decision.op === 'keep') {
      if (decision.into !== null && decision.into !== '') fail('keep takes "into": null');
      decided.set(ref.memoryId, { ref: ref.ref, memoryId: ref.memoryId, op: 'keep', into: null, intoId: null });
      return;
    }
    const label = `${where} ${decision.op} into ${decision.into ?? 'null'}`;
    const reject = (message: string) => {
      if (strict) problems.push(`${label}: ${message}`);
      decided.set(ref.memoryId, { ref: ref.ref, memoryId: ref.memoryId, op: 'keep', into: null, intoId: null });
    };
    const into = listedNote(batch, decision.into);
    if (!into) return reject(`${decision.into ?? 'null'} was not listed in this run: name a note of the same group`);
    if (into.memoryId === ref.memoryId) return reject('a note does not go into itself');
    const shared = [...(groupsOf.get(ref.memoryId) ?? [])].some((group) => groupsOf.get(into.memoryId)?.has(group));
    if (!shared) return reject(`${into.ref} is not in a group with ${ref.ref}: name a note of the same group`);
    // A note gone or changed since it was listed is the commit's to skip, not the model's to fix.
    if (!(ref as ListedNote).stale && !(into as ListedNote).stale) {
      const problem = decisionProblem(decision.op, ref, into);
      if (problem) return reject(problem.message);
    }
    const normalized: ConsolidationDecision = { ref: ref.ref, memoryId: ref.memoryId, op: decision.op, into: into.ref, intoId: into.memoryId };
    decided.set(ref.memoryId, normalized);
    changes.push({ index, decision: normalized });
  });
  // Rule 5: an into is not the ref of another change (the later one becomes keep in a lenient answer).
  const changing = new Set(changes.map((change) => change.decision.memoryId));
  for (const change of changes) {
    if (!change.decision.intoId || !changing.has(change.decision.intoId)) continue;
    if (strict) problems.push(`decisions[${change.index}] ${change.decision.ref} ${change.decision.op} into ${change.decision.into}: ${change.decision.into} is changed in this answer too; put both into the same note, or keep one`);
    decided.set(change.decision.memoryId, { ...change.decision, op: 'keep', into: null, intoId: null });
    changing.delete(change.decision.memoryId);
  }
  for (const id of inputs) {
    if (decided.has(id)) continue;
    if (strict) problems.push(`${batch.notes.get(id)?.ref ?? id} (a > note) has no decision: add one (keep when unsure)`);
    const note = batch.notes.get(id);
    if (note) decided.set(id, { ref: note.ref, memoryId: id, op: 'keep', into: null, intoId: null });
  }
  // Rule 10: the run's and the day's caps.
  const cap = Math.min(runChangeCap(options.activeMichiNotes ?? 0), Math.max(0, CONSOLIDATION_LIMITS.changesPerDay - (options.appliedToday ?? 0)));
  const applied = [...decided.values()].filter((decision) => decision.op !== 'keep');
  if (applied.length > cap) {
    if (strict) problems.push(`the answer changes ${applied.length} notes; this run changes at most ${cap}: keep the rest`);
    for (const decision of applied.slice(cap)) decided.set(decision.memoryId, { ...decision, op: 'keep', into: null, intoId: null });
  }
  if (problems.length > 0) throw new ConsolidationPayloadError(problems);
  // In listing order: what the commit applies first.
  const order = new Map<string, number>();
  for (const group of batch.groups) for (const id of group.members) if (!order.has(id)) order.set(id, order.size);
  return { decisions: [...decided.values()].sort((a, b) => (order.get(a.memoryId) ?? 0) - (order.get(b.memoryId) ?? 0)) };
}

// ── the commit ───────────────────────────────────────────────────────────────

export interface ConsolidationCommitContext {
  ownerUserId: string;
  /** The run (memory_extraction_runs id) the log rows belong to; an evaluation names its own. */
  runId: string;
  /** The batch the answer was given for (as planned, or listedConsolidationBatch). */
  batch: ListedBatch | ConsolidationBatch;
  /** Where the cursor moves (the run's planned cursor; default the batch's). */
  through?: { at: number; row: number } | null;
  /** Live workspaces (as for nextConsolidationBatch): a note outside every area is skipped. */
  liveWorkspace: (workspaceId: string) => boolean;
  now: number;
}

export type ConsolidationOutcome = 'applied' | 'kept' | 'no_pair' | 'unreadable' | `skipped:${string}`;

export interface ConsolidationCommitResult {
  /** The memories put away, as stored now (superseded, with their link). */
  applied: MemoryRecord[];
  /** Each listed memory's outcome, by id. */
  outcomes: Map<string, { decision: ConsolidationOp | null; intoId: string | null; outcome: ConsolidationOutcome }>;
  skipped: number;
  kept: number;
}

function writeLog(ownerUserId: string, runId: string, batch: ListedBatch | ConsolidationBatch, outcomes: ConsolidationCommitResult['outcomes'], now: number): void {
  const insert = getDb().prepare(`INSERT OR REPLACE INTO memory_consolidation_log (run_id, memory_id, owner_user_id, role, listed_version, decision,
      into_id, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const inputs = new Set(batch.inputs);
  for (const [memoryId, note] of batch.notes) {
    const result = outcomes.get(memoryId) ?? { decision: null, intoId: null, outcome: 'kept' as const };
    insert.run(runId, memoryId, ownerUserId, inputs.has(memoryId) ? 'input' : 'neighbour', note.version, result.decision, result.intoId, result.outcome, now);
  }
}

/**
 * Commits a validated answer (spec §C8), in one transaction (a savepoint
 * inside the caller's): each change is checked again on the current rows —
 * both notes still there (gone), active at the listed versions (changed),
 * the ref not protected now (protected), its source still learning (source),
 * both in an area (area), rules 6-9 on their current text (rule:<n>), the
 * caps (cap) — then applied (memoryService.mergeMemoryInto; a duplicate's
 * profile citations move to its into, userProfile.remapProfileCitations).
 * Every listed memory's outcome is logged, and the cursor moves past the
 * batch. A throw rolls everything back, the cursor included. Nothing is
 * announced: the caller emits 'superseded' for `applied` once committed.
 */
export function commitConsolidation(payload: ConsolidationPayload, ctx: ConsolidationCommitContext): ConsolidationCommitResult {
  const { ownerUserId, batch, now } = ctx;
  return memoryTransaction(() => {
    const outcomes: ConsolidationCommitResult['outcomes'] = new Map();
    const applied: MemoryRecord[] = [];
    let skipped = 0;
    let kept = 0;
    const grouped = new Set(batch.groups.map((group) => group.members[0]));
    for (const id of batch.inputs) if (!grouped.has(id)) outcomes.set(id, { decision: null, intoId: null, outcome: 'no_pair' });
    const cap = Math.min(runChangeCap(activeMichiNoteCount(ownerUserId)),
      Math.max(0, CONSOLIDATION_LIMITS.changesPerDay - consolidationChangesToday(ownerUserId, now)));
    const area = (note: ConsolidationNote) => {
      if (note.workspaceId === null) return true;
      try { return ctx.liveWorkspace(note.workspaceId); } catch { return false; }
    };
    const merged: Array<{ ref: { id: string; version: number }; intoId: string }> = [];
    for (const decision of payload.decisions) {
      if (decision.op === 'keep' || !decision.intoId) {
        kept += 1;
        outcomes.set(decision.memoryId, { decision: decision.op, intoId: null, outcome: 'kept' });
        continue;
      }
      const skip = (reason: string) => {
        skipped += 1;
        outcomes.set(decision.memoryId, { decision: decision.op, intoId: decision.intoId, outcome: `skipped:${reason}` });
      };
      const listedRef = batch.notes.get(decision.memoryId);
      const listedInto = batch.notes.get(decision.intoId);
      const rows = new Map(consolidationRows(ownerUserId, [decision.memoryId, decision.intoId]).map((row) => [row.record.id, row]));
      const refRow = rows.get(decision.memoryId);
      const intoRow = rows.get(decision.intoId);
      if (!refRow || !intoRow || !listedRef || !listedInto) { skip('gone'); continue; }
      if (refRow.record.version !== listedRef.version || intoRow.record.version !== listedInto.version
        || refRow.record.status !== 'active' || intoRow.record.status !== 'active' || intoRow.record.sourceRisk !== null) { skip('changed'); continue; }
      const ref = consolidationNote(refRow);
      const into = consolidationNote(intoRow);
      if (ref.who !== 'michi') { skip('protected'); continue; }
      if (!ref.changeable) { skip('source'); continue; }
      if (!area(ref) || !area(into)) { skip('area'); continue; }
      const problem = decisionProblem(decision.op, ref, into);
      if (problem) { skip(`rule:${problem.rule}`); continue; }
      if (applied.length >= cap) { skip('cap'); continue; }
      const record = mergeMemoryInto(ownerUserId, { id: ref.memoryId, version: ref.version }, into.memoryId, now);
      if (!record) { skip('changed'); continue; }
      applied.push(record);
      merged.push({ ref: { id: ref.memoryId, version: ref.version }, intoId: into.memoryId });
      outcomes.set(decision.memoryId, { decision: decision.op, intoId: into.memoryId, outcome: 'applied' });
      if (decision.op === 'duplicate') {
        const target = storedMemories(ownerUserId, [into.memoryId])[0];
        if (target) remapProfileCitations(ownerUserId, [{ from: { id: ref.memoryId, version: ref.version }, into: target }]);
      }
    }
    writeLog(ownerUserId, ctx.runId, batch, outcomes, now);
    moveCursor(ownerUserId, ctx.through ?? batch.through, now);
    return { applied, outcomes, skipped, kept };
  });
}

/** An answer unreadable past its repairs: every listed memory is logged unreadable and the cursor moves past the batch (never retried unchanged). */
export function settleUnreadableConsolidation(ctx: Omit<ConsolidationCommitContext, 'liveWorkspace'>): void {
  memoryTransaction(() => {
    const outcomes: ConsolidationCommitResult['outcomes'] = new Map();
    for (const id of ctx.batch.notes.keys()) outcomes.set(id, { decision: null, intoId: null, outcome: 'unreadable' });
    writeLog(ctx.ownerUserId, ctx.runId, ctx.batch, outcomes, ctx.now);
    moveCursor(ctx.ownerUserId, ctx.through ?? ctx.batch.through, ctx.now);
  });
}

/** Announces what a commit put away (after its transaction committed). Nothing toasts: only explicit saves do. */
export function announceConsolidation(result: Pick<ConsolidationCommitResult, 'applied'>): void {
  announceMemoryChanges(result.applied, 'superseded');
}

// ── retention and revert ─────────────────────────────────────────────────────

export interface ConsolidationRevert {
  /** Memories brought back (or that would be, in a dry run). */
  reverted: string[];
  /** Applied changes left alone: the memory changed or was deleted since. */
  skipped: string[];
}

/**
 * Undoes runs' applied changes (a maintainer's script after a bug: there is
 * no route and no UI), newest first: a memory still superseded with the same
 * link, at the version the change gave it (listed + 1), becomes active again
 * with the link cleared (memoryService.restoreMergedMemory), its log row
 * marked reverted. A memory changed or deleted since is never touched, so
 * nothing removed comes back. `apply` false (the default) changes nothing and
 * reports what it would do.
 * @internal Only backend/scripts/memory-consolidation-revert.ts (and tests) call it; production code does not.
 */
export function revertConsolidation(input: { ownerUserId: string; runIds: readonly string[]; apply?: boolean; now?: number }): ConsolidationRevert {
  const now = input.now ?? Date.now();
  const result: ConsolidationRevert = { reverted: [], skipped: [] };
  const restored: MemoryRecord[] = [];
  memoryTransaction(() => {
    const rows = getDb().prepare(`SELECT run_id, memory_id, listed_version, into_id FROM memory_consolidation_log
        WHERE owner_user_id = ? AND outcome = 'applied' AND run_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC, rowid DESC`)
      .all(input.ownerUserId, JSON.stringify(input.runIds)) as Array<{ run_id: string; memory_id: string; listed_version: number; into_id: string | null }>;
    for (const row of rows) {
      const current = consolidationRows(input.ownerUserId, [row.memory_id])[0];
      const intact = !!current && current.record.status === 'superseded' && current.mergedIntoId === row.into_id
        && current.record.version === row.listed_version + 1;
      if (!intact) { result.skipped.push(row.memory_id); continue; }
      result.reverted.push(row.memory_id);
      if (!input.apply) continue;
      const back = restoreMergedMemory(input.ownerUserId, { id: row.memory_id, version: current.record.version }, now);
      if (!back) { result.reverted.pop(); result.skipped.push(row.memory_id); continue; }
      restored.push(back);
      getDb().prepare(`UPDATE memory_consolidation_log SET outcome = 'reverted' WHERE run_id = ? AND memory_id = ?`).run(row.run_id, row.memory_id);
    }
  });
  announceMemoryChanges(restored, 'updated');
  return result;
}
