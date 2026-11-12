import { blockLocation, changeTargetKey, parsePageBlockInput, parsePageDatabaseOps, retainUserPageSegmentSources, pageViewProblem, rowLocation } from 'michi-shared';
import type { PageBlock, PageBlockInput, PageDatabase, PageDatabaseRow, PageDatabaseView } from 'michi-shared';
import { checkinNodeId, companionCheckinTurnId } from 'michi-shared';
import type {
  BlockLocation, ChangeTarget, CompanionRunUndoResult, DatabaseTargetSnapshot, PageChangeDto, RowLocation, TargetMutation, TargetSnapshot,
} from 'michi-shared';
import { presentChange } from './checkinSources';
import { invalidateDatabasePages, invalidatePages, PageWriteError, pageTimestamp, pagesTransaction } from './core';
import {
  databaseShown, deletePage, getDatabase, getPage, hasChildPages, pageOwnDatabaseIds, pagesMadeBy, requireDatabaseRecord, requirePageRecord,
  saveDatabase, savePageContent, setAsideUnshownDatabase, type MadePage,
} from './repository';
import {
  dismissPendingProposals, getChange, getTargetHead, hasEarlierChanges, hasStandingChanges, listChangeBatch, listCheckinRunChanges, setTargetHead, updateChange,
} from './historyRepository';
import { pageComponents } from './components';
import { pinHumanDatabaseViews, pinHumanPageComponentBlocks } from './componentReferences';
import { canonical, sameCanonical } from './canonicalJson';
import { blockSnapshot, dbSnapshot, rowSnapshot } from './changeSnapshots';

export { dismissPendingProposals };

type SafeTarget = ChangeTarget;
type EditableProposal =
  | { kind: 'block'; block: PageBlockInput }
  | { kind: 'row'; values?: Record<string, PageDatabaseRow['values'][string]>; body?: string }
  | { kind: 'view'; config: Record<string, unknown> };

const conflict = (message = 'The change can no longer be applied safely'): PageWriteError =>
  new PageWriteError(409, 'undo_conflict', message);

function readCurrent(target: SafeTarget, owner: string): { snapshot: TargetSnapshot; workspaceId: string } {
  if (target.kind === 'block') {
    const page = getPage(target.pageId, owner, { write: true });
    const index = page.blocks.findIndex((block) => block.id === target.blockId);
    return { snapshot: blockSnapshot(page.blocks[index], index < 0 ? null : blockLocation(page.blocks, index), target.blockId), workspaceId: page.workspaceId };
  }
  const record = requireDatabaseRecord(target.databaseId, owner, { write: true });
  const database = getDatabase(target.databaseId, owner, { write: true });
  if (target.kind === 'row') return { snapshot: rowSnapshot(database, target.rowId), workspaceId: record.workspace_id };
  return { snapshot: dbSnapshot(database), workspaceId: record.workspace_id };
}

function assertExpected(current: TargetSnapshot, expected: TargetSnapshot | null): void {
  if (!expected || current.kind !== expected.kind || current.exists !== expected.exists) throw conflict();
  if (!current.exists || !expected.exists) {
    if (current.kind !== expected.kind || current.exists !== expected.exists ||
      (!current.exists && !expected.exists && current.id !== expected.id)) throw conflict();
    return;
  }
  if (current.kind === 'block' && expected.kind === 'block') {
    if (!sameCanonical(current.location, expected.location) || !sameCanonical({ ...current.block, rev: undefined }, { ...expected.block, rev: undefined })) throw conflict();
  } else if (current.kind === 'row' && expected.kind === 'row') {
    // Order is compared through `location`; stored positions are not renumbered after a delete.
    const strip = (row: PageDatabaseRow) => ({ ...row, rev: undefined, updatedAt: undefined, position: undefined });
    if (!sameCanonical(current.location, expected.location) || !sameCanonical(strip(current.row), strip(expected.row))) throw conflict();
  } else if (current.kind === 'database' && expected.kind === 'database') {
    const strip = (database: TargetSnapshot & { kind: 'database'; exists: true }) => {
      const { revision: _revision, updatedAt: _updatedAt, ...content } = database.database;
      return content;
    };
    if (!sameCanonical(strip(current), strip(expected))) throw conflict();
  } else throw conflict();
}

function insertionPosition(blocks: readonly PageBlock[], location: BlockLocation): number {
  if (location.parentId !== null || location.slot !== null) throw conflict('The block location is invalid');
  const previous = location.previousId === null ? -1 : blocks.findIndex((block) => block.id === location.previousId);
  const next = location.nextId === null ? -1 : blocks.findIndex((block) => block.id === location.nextId);
  if ((location.previousId !== null && previous < 0) || (location.nextId !== null && next < 0)) throw conflict('A block restoration anchor is missing');
  if (location.previousId === null && location.nextId === null) {
    if (blocks.length) throw conflict('The block restoration location is no longer empty');
    return 0;
  }
  if (location.previousId === null) {
    if (next !== 0) throw conflict('The block restoration anchors changed');
    return 0;
  }
  if (location.nextId === null) {
    if (previous !== blocks.length - 1) throw conflict('The block restoration anchors changed');
    return blocks.length;
  }
  if (next !== previous + 1) throw conflict('The block restoration anchors changed');
  return next;
}

function ensureBlockLocation(blocks: readonly PageBlock[], id: string, expected: BlockLocation): void {
  const index = blocks.findIndex((block) => block.id === id);
  if (index < 0 || !sameCanonical(blockLocation(blocks, index), expected)) throw conflict('The block location changed');
}

function writePageMutation(target: Extract<SafeTarget, {kind:'block'}>, owner: string, mutation: TargetMutation,
  expected: TargetSnapshot | null, now: number, deferViewValidation = false): void {
  const page = getPage(target.pageId, owner, { write: true });
  const current = readCurrent(target, owner).snapshot;
  assertExpected(current, expected);
  const blocks = [...page.blocks];
  const index = blocks.findIndex((block) => block.id === target.blockId);
  if (mutation.kind !== 'block') throw conflict('The recorded mutation has the wrong target kind');
  if (mutation.op === 'delete') {
    if (mutation.id !== target.blockId || index < 0) throw conflict();
    ensureBlockLocation(blocks, target.blockId, mutation.expectedLocation);
    blocks.splice(index, 1);
  } else {
    if (mutation.block.id !== target.blockId) throw conflict();
    const without = blocks.filter((block) => block.id !== target.blockId);
    const at = insertionPosition(without, mutation.location);
    const changed: PageBlock = { ...mutation.block, rev: page.revision + 1 };
    if (index >= 0) blocks.splice(index, 1);
    blocks.splice(at, 0, changed);
  }
  const viewProblem = deferViewValidation ? null : pageViewProblem(blocks);
  if (viewProblem) throw conflict(viewProblem);
  savePageContent(page.id, owner, { ...page, blocks, revision: page.revision + 1 }, {
    source: { kind: 'user' }, now, expectedRevision: page.revision, deferViewValidation,
  });
  invalidatePages([page.id], now, 'user');
}

function insertRow(database: PageDatabase, row: PageDatabaseRow, location: RowLocation, revision: number, now: number): PageDatabase {
  const rows = database.rows.filter((item) => item.id !== row.id);
  let position: number;
  if (location.after === null) position = 0;
  else {
    const anchor = rows.findIndex((item) => item.id === location.after);
    if (anchor < 0) throw conflict('A row restoration anchor is missing');
    position = anchor + 1;
  }
  // The row must still occupy the recorded gap; do not silently choose a new location.
  if (location.after === null && location.position > 0) throw conflict('The row restoration anchor changed');
  if (location.after !== null && position !== location.position) throw conflict('The row restoration anchor changed');
  rows.splice(position, 0, { ...structuredClone(row), position, rev: revision, updatedAt: now });
  return { ...database, rows: rows.map((item, index) => ({ ...item, position: index })), revision, updatedAt: now };
}

function saveDatabaseMutation(target: Extract<SafeTarget, {kind:'row'|'database'}>, owner: string, mutation: TargetMutation,
  expected: TargetSnapshot | null, now: number, restore = false): void {
  const dbRecord = requireDatabaseRecord(target.databaseId, owner, { write: true });
  const database = getDatabase(target.databaseId, owner, { write: true });
  const current = readCurrent(target, owner).snapshot;
  assertExpected(current, expected);
  if (mutation.kind === 'database' && target.kind === 'database') {
    if (mutation.op !== 'replace' || mutation.database.id !== database.id || mutation.database.workspaceId !== database.workspaceId) throw conflict('Unsupported database mutation');
    saveDatabase({ ...database, title: mutation.database.title, columns: structuredClone(mutation.database.columns),
      views: structuredClone(mutation.database.views), revision: database.revision + 1, updatedAt: now }, owner, { now, restore });
  } else if (mutation.kind === 'row' && target.kind === 'row') {
    if (target.databaseId !== dbRecord.id) throw conflict();
    const revision = database.revision + 1;
    const index = database.rows.findIndex((row) => row.id === target.rowId);
    let next: PageDatabase;
    if (mutation.op === 'delete') {
      if (mutation.id !== target.rowId || index < 0 || !sameCanonical(rowLocation(database, target.rowId), mutation.expectedLocation)) throw conflict('The row location changed');
      const rows = database.rows.filter((row) => row.id !== target.rowId).map((row, i) => ({ ...row, position: i, rev: row.rev }));
      next = { ...database, rows, revision, updatedAt: now };
    } else if (mutation.op === 'upsert') {
      if (mutation.row.id !== target.rowId) throw conflict();
      next = insertRow(database, mutation.row, mutation.location, revision, now);
    } else {
      if (mutation.id !== target.rowId || index < 0) throw conflict();
      const prior = database.rows[index]!;
      const values = { ...prior.values, ...structuredClone(mutation.values) };
      const edited = { ...prior.edited, ...mutation.edited };
      const body = mutation.body === undefined ? prior.body : mutation.body;
      const bodyEditedAt = mutation.bodyEditedAt === undefined ? prior.bodyEditedAt : mutation.bodyEditedAt;
      const rows = [...database.rows];
      rows[index] = { ...prior, values, body, edited, bodyEditedAt, rev: revision, updatedAt: now };
      next = { ...database, rows, revision, updatedAt: now };
    }
    saveDatabase(next, owner, { now, restore });
  } else throw conflict('The recorded mutation has the wrong target kind');
  invalidateDatabasePages(target.databaseId, now, 'user');
}

function applyMutation(change: PageChangeDto, owner: string, mutation: TargetMutation, expected: TargetSnapshot | null, now: number, deferViewValidation = false): void {
  if (change.target.kind === 'block') {
    writePageMutation(change.target, owner, mutation, expected, now, deferViewValidation);
  } else {
    saveDatabaseMutation(change.target, owner, mutation, expected, now, true);
  }
}

function transitionGuard(change: PageChangeDto, owner: string, action: 'undo' | 'redo'): { workspaceId: string; head: {headId:string|null;targetRevision:number} } {
  const info = readCurrent(change.target, owner);
  const head = getTargetHead(info.workspaceId, change.target) ?? { headId: null, targetRevision: 1 };
  if (action === 'undo' && head.headId !== change.id) throw conflict('A newer change owns this target');
  if (action === 'redo' && head.headId !== change.previousHeadId) throw conflict('The preceding target head has changed');
  return { workspaceId: info.workspaceId, head };
}

function resourceRevision(target: ChangeTarget, owner: string): number {
  const current = readCurrent(target, owner).snapshot;
  if (current.kind === 'block' && current.exists) return current.block.rev;
  if (current.kind === 'row' && current.exists) return current.row.rev;
  if (current.kind === 'database' && current.exists) return current.database.revision;
  if (target.kind === 'block') return getPage(target.pageId, owner).revision;
  return getDatabase(target.databaseId, owner).revision;
}

/**
 * Puts back one applied change. A person's own change is put back only by
 * Undo of the batch it made (`allowUser`); reverting one change from the
 * history stays for agent changes.
 */
export function revertChange(changeId: string, ownerUserId: string, now?: number, options: { allowUser?: boolean } = {}): PageChangeDto {
  return presentChange(revertRecordedChange(changeId, ownerUserId, now, options), ownerUserId);
}

function revertRecordedChange(changeId: string, ownerUserId: string, now?: number, options: { allowUser?: boolean; deferViewValidation?: boolean } = {}): PageChangeDto {
  return pagesTransaction(() => {
    const timestamp = pageTimestamp(now);
    const change = getChange(changeId, ownerUserId, { write: true });
    if (change.applicationState === 'reverted') return change;
    if (change.applicationState !== 'applied' || (change.proposalState !== null && change.proposalState !== 'accepted') || (change.source.kind === 'user' && !options.allowUser)) throw conflict('Only applied agent changes can be reverted');
    const { workspaceId, head } = transitionGuard(change, ownerUserId, 'undo');
    applyMutation(change, ownerUserId, change.inverse, change.after, timestamp, options.deferViewValidation);
    setTargetHead(workspaceId, change.target, { headId: change.previousHeadId, targetRevision: Math.max(head.targetRevision + 1, resourceRevision(change.target, ownerUserId)) });
    return updateChange(change.id, ownerUserId, { applicationState: 'reverted' });
  });
}

/** Puts back a reverted change; a person's own change only through the batch redo (`allowUser`). */
export function redoChange(changeId: string, ownerUserId: string, now?: number, options: { allowUser?: boolean } = {}): PageChangeDto {
  return presentChange(redoRecordedChange(changeId, ownerUserId, now, options), ownerUserId);
}

function redoRecordedChange(changeId: string, ownerUserId: string, now?: number, options: { allowUser?: boolean; deferViewValidation?: boolean } = {}): PageChangeDto {
  return pagesTransaction(() => {
    const timestamp = pageTimestamp(now);
    const change = getChange(changeId, ownerUserId, { write: true });
    if (change.applicationState === 'applied') return change;
    if (change.applicationState !== 'reverted' || (change.proposalState !== null && change.proposalState !== 'accepted') || (change.source.kind === 'user' && !options.allowUser)) throw conflict('Only reverted agent changes can be redone');
    const { workspaceId, head } = transitionGuard(change, ownerUserId, 'redo');
    applyMutation(change, ownerUserId, change.forward, change.before, timestamp, options.deferViewValidation);
    setTargetHead(workspaceId, change.target, { headId: change.id, targetRevision: Math.max(head.targetRevision + 1, resourceRevision(change.target, ownerUserId)) });
    return updateChange(change.id, ownerUserId, { applicationState: 'applied' });
  });
}

/**
 * The order in which a batch's changes are put back: newest first, except that a deleted
 * row or block that is another deleted item's restoration anchor goes first.
 */
function revertOrder(records: PageChangeDto[]): PageChangeDto[] {
  // Reverse change order is normally right, but a deleted row or block may be
  // the recorded restoration anchor for another deleted item in the same batch.
  // Restore those anchors first, while retaining newest-first order otherwise.
  const byTarget = new Map(records.map((record) => [changeTargetKey(record.target), record]));
  const dependencies = new Map(records.map((record) => [record.id, new Set<string>()]));
  for (const record of records) {
    const inverse = record.inverse;
    if ((inverse.kind !== 'block' && inverse.kind !== 'row') || inverse.op !== 'upsert') continue;
    const anchors = inverse.kind === 'block'
      ? [inverse.location.previousId, inverse.location.nextId]
      : [inverse.location.after];
    for (const anchor of anchors) {
      if (anchor === null) continue;
      const anchorKey = record.target.kind === 'block'
        ? changeTargetKey({ kind: 'block', pageId: record.target.pageId, blockId: anchor })
        : record.target.kind === 'row' ? changeTargetKey({ kind: 'row', databaseId: record.target.databaseId, rowId: anchor }) : null;
      const anchorChange = anchorKey ? byTarget.get(anchorKey) : undefined;
      if (!anchorChange || anchorChange.id === record.id) continue;
      const anchorInverse = anchorChange.inverse;
      if ((anchorInverse.kind === 'block' || anchorInverse.kind === 'row') && anchorInverse.op === 'upsert') {
        dependencies.get(record.id)!.add(anchorChange.id);
      }
    }
  }
  const ordered: PageChangeDto[] = [];
  const remaining = new Map(records.map((record) => [record.id, record]));
  while (remaining.size) {
    const ready = [...remaining.values()]
      .filter((record) => [...dependencies.get(record.id)!].every((dependency) => !remaining.has(dependency)))
      .sort((a, b) => b.seq - a.seq);
    // A cycle cannot be safely restored by ordering these independent writes;
    // leave normal conflict checks to report it instead of looping forever.
    if (!ready.length) {
      ordered.push(...[...remaining.values()].sort((a, b) => b.seq - a.seq));
      break;
    }
    for (const record of ready) {
      ordered.push(record);
      remaining.delete(record.id);
    }
  }
  return ordered;
}

export function revertBatch(batchId: string, ownerUserId: string, workspaceId: string, now?: number): { reverted: string[]; conflicts: Array<{changeId:string;message:string}> } {
  const records = listChangeBatch(batchId, ownerUserId, workspaceId).filter((record) => record.applicationState === 'applied');
  const result = applyHistoryBatch(revertOrder(records), ownerUserId, 'undo', now);
  return { reverted: result.applied, conflicts: result.conflicts };
}

/** Redoes what `revertBatch` undid, in the reverse of its order, reporting changes that no longer apply. */
export function redoBatch(batchId: string, ownerUserId: string, workspaceId: string, now?: number): { redone: string[]; conflicts: Array<{changeId:string;message:string}> } {
  // The reverse of the order Undo used, so anchors are redone after what they anchor.
  const records = revertOrder(listChangeBatch(batchId, ownerUserId, workspaceId).filter((record) => record.applicationState === 'reverted')).reverse();
  const result = applyHistoryBatch(records, ownerUserId, 'redo', now);
  return { redone: result.applied, conflicts: result.conflicts };
}

/** What revertRunPageChanges did; `reverted` lists the applied changes it put back (page_changes ids). */
export interface RunPageChangesUndo extends CompanionRunUndoResult {
  /** The suggestions it dismissed (page_changes ids). */
  dismissed: string[];
  /**
   * What the run made and this took away, once nothing else had touched it:
   * a page (to the Trash, with the databases only it shows) or a database no
   * page shows (set aside, its data kept). A conflict on one of these names
   * the page or database id as its `changeId`.
   */
  removed: Array<{ kind: 'page' | 'database'; id: string }>;
  /**
   * The run's applied changes left as they are: suggestions the person
   * accepted (theirs now, with any edits they made), and changes on a page or
   * database that is in the trash or gone, which no longer show. Restoring
   * the page brings those back, and Undo all can then put them back too.
   */
  skipped: string[];
  /** What of the run still stands afterwards: its changes and suggestions, and what it made. 0 = everything is undone. */
  remaining: number;
}

type MadeDatabase = { id: string; firstSeq: number; createdAt: number; made: DatabaseTargetSnapshot['database'] };
/** One thing to undo; `key` places it in change-sequence order, `at` (when it happened) breaks a tie. */
type UndoStep =
  | { kind: 'batch'; key: number; at: number; records: PageChangeDto[] }
  | { kind: 'page'; key: number; at: number; page: MadePage }
  | { kind: 'database'; key: number; at: number; database: MadeDatabase };
type TakeBack = 'removed' | 'gone' | { message: string };

const standing = (record: PageChangeDto): boolean => record.applicationState === 'applied' && record.proposalState !== 'accepted';

/** Whether a change's page or database is still there to show it: not in the trash, not gone. */
function targetShown(target: ChangeTarget, owner: string): boolean {
  try {
    const record = target.kind === 'block'
      ? requirePageRecord(target.pageId, owner, { includeDeleted: true })
      : requireDatabaseRecord(target.databaseId, owner, { includeDeleted: true });
    return record.deleted_at === null;
  } catch (error) {
    if (error instanceof PageWriteError && error.status === 404) return false;
    throw error;
  }
}

/**
 * The databases a run made (databaseWrites.ts createAgentDatabase): its first
 * change to one is the first change anyone made to it, starts from revision 1
 * and was recorded as the database was created. A database a page template
 * made goes with its page instead.
 */
function databasesMadeBy(records: readonly PageChangeDto[], pages: readonly MadePage[], owner: string): MadeDatabase[] {
  const first = new Map<string, PageChangeDto>();
  for (const record of records) if (record.target.kind !== 'block' && !first.has(record.target.databaseId)) first.set(record.target.databaseId, record);
  const pageBlocks = pages.map((page) => JSON.stringify(page.made.blocks));
  const made: MadeDatabase[] = [];
  for (const [id, record] of first) {
    const before = record.before;
    if (record.target.kind !== 'database' || before?.kind !== 'database' || !before.exists || before.database.revision !== 1) continue;
    if (hasEarlierChanges(id, record.seq) || pageBlocks.some((blocks) => blocks.includes(JSON.stringify(id)))) continue;
    let createdAt: number;
    try { createdAt = requireDatabaseRecord(id, owner, { includeDeleted: true }).created_at; } catch (error) {
      if (error instanceof PageWriteError && error.status === 404) continue;
      throw error;
    }
    if (createdAt === record.createdAt) made.push({ id, firstSeq: record.seq, createdAt, made: before.database });
  }
  return made;
}

const blocksWithoutRevisions = (blocks: readonly PageBlock[]): unknown => canonical(blocks.map(({ rev: _rev, ...block }) => block));

/** Puts a page the run made in the Trash when it is as the run left it once its own changes are undone; anything else keeps it. */
function takeBackPage(page: MadePage, owner: string, now: number): TakeBack {
  try {
    if (requirePageRecord(page.id, owner, { includeDeleted: true }).deleted_at !== null) return 'gone';
    const current = getPage(page.id, owner, { write: true });
    const untouched = current.title === page.made.title && current.color === page.made.color && current.parentId === page.made.parentId
      && sameCanonical(blocksWithoutRevisions(current.blocks), blocksWithoutRevisions(page.made.blocks))
      && !hasChildPages(page.id) && !hasStandingChanges({ pageId: page.id }, owner)
      && pageOwnDatabaseIds(page.id).every((databaseId) => !hasStandingChanges({ databaseId }, owner));
    if (!untouched) return { message: `"${current.title}", which this check-in made, was changed since, so it stays` };
    deletePage(page.id, owner, { now });
    return 'removed';
  } catch (error) {
    if (error instanceof PageWriteError && error.status === 404) return 'gone';
    if (error instanceof PageWriteError) return { message: error.message };
    throw error;
  }
}

/** Sets aside a database the run made when nothing else touched it: no rows, no page shows it, as the run first made it. */
function takeBackDatabase(database: MadeDatabase, owner: string, now: number): TakeBack {
  try {
    if (requireDatabaseRecord(database.id, owner, { includeDeleted: true }).deleted_at !== null) return 'gone';
    const current = getDatabase(database.id, owner, { write: true });
    const shape = (value: Pick<PageDatabase, 'title' | 'columns' | 'views'>) => ({ title: value.title, columns: value.columns, views: value.views });
    const untouched = !current.rows.length && !databaseShown(database.id) && !hasStandingChanges({ databaseId: database.id }, owner)
      && sameCanonical(shape(current), shape(database.made));
    if (!untouched) return { message: `The database "${current.title}", which this check-in made, was changed since, so it stays` };
    setAsideUnshownDatabase(database.id, owner, { now });
    return 'removed';
  } catch (error) {
    if (error instanceof PageWriteError && error.status === 404) return 'gone';
    if (error instanceof PageWriteError) return { message: error.message };
    throw error;
  }
}

/** Whether something the run made is still there. */
function madeStands(kind: 'page' | 'database', id: string, owner: string): boolean {
  return targetShown(kind === 'page' ? { kind: 'block', pageId: id, blockId: '' } : { kind: 'database', databaseId: id }, owner);
}

/**
 * "Undo all" on a check-in's receipt (DESIGN-v2 §2.7): puts back what run
 * `runId` did to the owner's pages and databases, newest first, and stops at
 * the first thing that no longer undoes cleanly (it changed since, or its
 * page is read-only), leaving older things as they are:
 * - each batch of its applied changes is reverted;
 * - a page or database it made is taken away once the changes made in it are
 *   undone, if nobody touched it since (takeBackPage, takeBackDatabase);
 * - suggestions the person accepted, and changes on a page or database in
 *   the trash, are skipped (RunPageChangesUndo.skipped).
 * Its suggestions still waiting for review are dismissed either way. What is
 * already undone, reviewed or taken away is skipped, so calling it again is
 * safe and may clear what a conflict left once the person sorts it out.
 * W2-G1a's POST /companion/runs/:runId/undo calls it, then reverts the run's
 * Today and goal changes.
 */
export function revertRunPageChanges(runId: string, ownerUserId: string, now?: number): RunPageChangesUndo {
  const timestamp = pageTimestamp(now);
  const records = listCheckinRunChanges(runId, ownerUserId);
  const pages = pagesMadeBy({ nodeId: checkinNodeId(runId), turnId: companionCheckinTurnId(runId) }, ownerUserId);
  const databases = databasesMadeBy(records, pages, ownerUserId);
  const skipped: string[] = [];
  const batches = new Map<string, PageChangeDto[]>();
  for (const record of records) {
    if (record.applicationState !== 'applied') continue;
    if (!standing(record) || !targetShown(record.target, ownerUserId)) { skipped.push(record.id); continue; }
    batches.set(record.batchId, [...(batches.get(record.batchId) ?? []), record]);
  }
  // One order for everything, by change sequence: a page sits just before the
  // first change recorded at or after it was made; a database just before its first change.
  const seqAt = (at: number): number => records.find((record) => record.createdAt >= at)?.seq ?? Number.MAX_SAFE_INTEGER;
  const steps: UndoStep[] = [
    ...[...batches.values()].map((batch): UndoStep => ({ kind: 'batch', key: Math.max(...batch.map((record) => record.seq)),
      at: Math.max(...batch.map((record) => record.createdAt)), records: batch })),
    ...pages.map((page): UndoStep => ({ kind: 'page', key: seqAt(page.createdAt) - 0.5, at: page.createdAt, page })),
    ...databases.map((database): UndoStep => ({ kind: 'database', key: database.firstSeq - 0.5, at: database.createdAt, database })),
  ].sort((a, b) => b.key - a.key || b.at - a.at);
  const reverted: string[] = [];
  const conflicts: Array<{ changeId: string; message: string }> = [];
  const removed: RunPageChangesUndo['removed'] = [];
  // Its suggestions go first: they change nothing, and once dismissed they no longer count as someone working on what it made.
  const dismissed: string[] = [];
  for (const record of records) {
    if (record.proposalState !== 'pending') continue;
    try {
      resolveProposal(record.id, ownerUserId, timestamp, undefined, 'dismiss');
      dismissed.push(record.id);
    } catch (error) {
      if (!(error instanceof PageWriteError)) throw error;
      conflicts.push({ changeId: record.id, message: error.message });
    }
  }
  for (const step of steps) {
    if (step.kind === 'batch') {
      const result = applyHistoryBatch(revertOrder(step.records), ownerUserId, 'undo', timestamp, { stopAtConflict: true });
      reverted.push(...result.applied);
      if (result.conflicts.length) { conflicts.push(...result.conflicts); break; }
      continue;
    }
    const id = step.kind === 'page' ? step.page.id : step.database.id;
    const outcome = pagesTransaction(() => (step.kind === 'page' ? takeBackPage(step.page, ownerUserId, timestamp) : takeBackDatabase(step.database, ownerUserId, timestamp)));
    if (outcome === 'removed') removed.push({ kind: step.kind, id });
    else if (outcome !== 'gone') { conflicts.push({ changeId: id, message: outcome.message }); break; }
  }
  const remaining = listCheckinRunChanges(runId, ownerUserId)
    .filter((record) => record.proposalState === 'pending' || (standing(record) && targetShown(record.target, ownerUserId))).length
    + pages.filter((page) => madeStands('page', page.id, ownerUserId)).length
    + databases.filter((database) => madeStands('database', database.id, ownerUserId)).length;
  return { reverted, dismissed, conflicts, removed, skipped, remaining };
}

/** View definitions and their entries may be mutually dependent with the recorded
 * structural anchors. Replay that page's group atomically, checking its final graph;
 * ordinary pages and databases retain independent per-target undo behavior.
 * `stopAtConflict` (a check-in run's Undo all) stops at the first group that
 * fails and counts any page write error as its conflict, the target being gone included. */
function applyHistoryBatch(records: PageChangeDto[], owner: string, action: 'undo' | 'redo', now?: number, options: { stopAtConflict?: boolean } = {}) {
  const pageGroups = new Map<string, PageChangeDto[]>();
  for (const record of records) if (record.target.kind === 'block') {
    const id = record.target.pageId;
    pageGroups.set(id, [...(pageGroups.get(id) ?? []), record]);
  }
  const liveBlocks = (pageId: string): PageBlock[] => {
    try { return getPage(pageId, owner).blocks; } catch (error) {
      // A page that is gone fails each of its changes as a conflict below.
      if (options.stopAtConflict && error instanceof PageWriteError) return [];
      throw error;
    }
  };
  const atomicPages = new Set([...pageGroups].filter(([id, group]) =>
    liveBlocks(id).some(block => block.type === 'view') || group.some(record =>
      [record.before, record.after].some(snapshot => snapshot?.kind === 'block' && snapshot.exists && snapshot.block.type === 'view')),
  ).map(([id]) => id));
  const visited = new Set<string>();
  const applied: string[] = [];
  const conflicts: Array<{changeId:string;message:string}> = [];
  for (const record of records) {
    const pageId = record.target.kind === 'block' && atomicPages.has(record.target.pageId) ? record.target.pageId : null;
    if (pageId && visited.has(pageId)) continue;
    if (pageId) visited.add(pageId);
    const group = pageId ? pageGroups.get(pageId)! : [record];
    try {
      pagesTransaction(() => {
        for (const item of group) (action === 'undo' ? revertRecordedChange : redoRecordedChange)(item.id, owner, now, { allowUser: true, deferViewValidation: !!pageId });
        if (pageId) {
          const problem = pageViewProblem(getPage(pageId, owner).blocks);
          if (problem) throw conflict(problem);
        }
      });
      applied.push(...group.map(item => item.id));
    }
    catch (error) {
      if (error instanceof PageWriteError && (options.stopAtConflict || error.status === 409 || error.code === 'task_board_needs_workspace')) conflicts.push(...group.map(item => ({ changeId: item.id, message: error.message })));
      else throw error;
      if (options.stopAtConflict) break;
    }
  }
  return { applied, conflicts };
}

function parseEditedContent(value: unknown): EditableProposal | undefined {
  if (value === undefined) return undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    if (raw.kind === 'block' && Object.keys(raw).every((key) => ['kind','block','content'].includes(key)) && !(raw.block !== undefined && raw.content !== undefined)) {
      const block = parsePageBlockInput(raw.block ?? raw.content);
      if (block) return { kind: 'block', block };
      throw new PageWriteError(400, 'invalid', 'Invalid edited block content');
    }
    if (raw.kind === 'row' && Object.keys(raw).every((key) => ['kind','values','body'].includes(key)) &&
      (raw.values !== undefined || raw.body !== undefined)) {
      const parsed = parsePageDatabaseOps([{ op: 'row.update', id: 'proposal-row',
        ...(raw.values === undefined ? {} : { values: raw.values }), ...(raw.body === undefined ? {} : { body: raw.body }) }], 'user');
      if (parsed.ok) return { kind: 'row', ...(raw.values === undefined ? {} : { values: raw.values as Record<string, PageDatabaseRow['values'][string]> }), ...(raw.body === undefined ? {} : { body: raw.body as string }) };
    }
    if (raw.kind === 'view' && Object.keys(raw).every((key) => ['kind','config'].includes(key)) &&
      raw.config !== null && typeof raw.config === 'object' && !Array.isArray(raw.config)) {
      return { kind: 'view', config: raw.config as Record<string, unknown> };
    }
    const block = parsePageBlockInput(value);
    if (block) return { kind: 'block', block };
  }
  throw new PageWriteError(400, 'invalid', 'Invalid edited proposal content');
}

function resolveProposal(changeId: string, owner: string, now?: number, editedInput?: unknown, action: 'accept'|'dismiss'|'reopen' = 'accept'): PageChangeDto {
  return pagesTransaction(() => {
    const timestamp = pageTimestamp(now);
    const change = getChange(changeId, owner, { write: true });
    if (action === 'dismiss') {
      if (change.proposalState === 'dismissed') return change;
      if (change.proposalState !== 'pending') throw conflict('Only pending proposals can be dismissed');
      const next = updateChange(change.id, owner, { proposalState: 'dismissed', resolvedAt: timestamp });
      invalidateTarget(change.target, owner, timestamp);
      return next;
    }
    if (action === 'reopen') {
      if (change.proposalState === 'pending') return change;
      if (change.proposalState !== 'dismissed') throw conflict('Only dismissed proposals can be reopened');
      const next = updateChange(change.id, owner, { proposalState: 'pending', resolvedAt: timestamp });
      invalidateTarget(change.target, owner, timestamp);
      return next;
    }
    if (change.proposalState === 'accepted' && change.applicationState === 'applied') return change;
    if (change.proposalState !== 'pending' || change.applicationState !== null) throw conflict('Only pending proposals can be accepted');
    const edited = parseEditedContent(editedInput);
    const current = readCurrent(change.target, owner);
    const head = getTargetHead(current.workspaceId, change.target) ?? { headId: null, targetRevision: currentRevision(current.snapshot) };
    if (currentRevision(current.snapshot) !== change.baseRev) throw new PageWriteError(409, 'proposal_stale', 'The proposed target has changed');
    const accepted = acceptedMutations(change, current.snapshot, edited, timestamp, owner);
    const appliedRev = applyAccepted(change, owner, accepted.forward, current.snapshot, timestamp);
    const afterCurrent = readCurrent(change.target, owner).snapshot;
    const forward = mutationForAccepted(change.target, accepted.forward, afterCurrent);
    // The target's revision moved on, so the other suggestions waiting on it can never be accepted.
    dismissPendingProposals(current.workspaceId, change.target, timestamp, change.id);
    setTargetHead(current.workspaceId, change.target, { headId: change.id, targetRevision: Math.max(head.targetRevision + 1, resourceRevision(change.target, owner)) });
    return updateChange(change.id, owner, {
      before: accepted.before, after: afterCurrent, forward, inverse: accepted.inverse,
      appliedRev, previousHeadId: head.headId,
      proposalState: 'accepted', applicationState: 'applied', resolvedAt: timestamp,
    });
  });
}

/** The review actions answer with the change as its owner is shown it (checkinSources.ts presentChange). */
export function acceptProposal(changeId: string, ownerUserId: string, now?: number, editedContent?: unknown): PageChangeDto {
  return presentChange(resolveProposal(changeId, ownerUserId, now, editedContent, 'accept'), ownerUserId);
}
export function dismissProposal(changeId: string, ownerUserId: string, now?: number): PageChangeDto {
  return presentChange(resolveProposal(changeId, ownerUserId, now, undefined, 'dismiss'), ownerUserId);
}
export function reopenProposal(changeId: string, ownerUserId: string, now?: number): PageChangeDto {
  return presentChange(resolveProposal(changeId, ownerUserId, now, undefined, 'reopen'), ownerUserId);
}

function currentRevision(snapshot: TargetSnapshot): number {
  if (snapshot.kind === 'block' && snapshot.exists) return snapshot.block.rev;
  if (snapshot.kind === 'row' && snapshot.exists) return snapshot.row.rev;
  if (snapshot.kind === 'database' && snapshot.exists) return snapshot.database.revision;
  return 1;
}

function mutationForAccepted(target: ChangeTarget, mutation: TargetMutation, snapshot: TargetSnapshot): TargetMutation {
  if (snapshot.kind === 'block' && snapshot.exists && mutation.kind === 'block' && mutation.op === 'upsert') {
    return { ...mutation, block: snapshot.block, location: snapshot.location };
  }
  if (snapshot.kind === 'row' && snapshot.exists && mutation.kind === 'row' && mutation.op !== 'delete') {
    return { kind: 'row', op: 'upsert', row: snapshot.row, location: snapshot.location };
  }
  if (target.kind === 'database' && snapshot.kind === 'database' && snapshot.exists && mutation.kind === 'database' && mutation.op === 'replace') {
    return { kind: 'database', op: 'replace', database: { id: snapshot.database.id, workspaceId: snapshot.database.workspaceId,
      title: snapshot.database.title, columns: structuredClone(snapshot.database.columns), views: structuredClone(snapshot.database.views) } };
  }
  return mutation;
}

function invalidateTarget(target: ChangeTarget, owner: string, now: number): void {
  if (target.kind === 'block') invalidatePages([target.pageId], now, 'user');
  else invalidateDatabasePages(target.databaseId, now, 'user');
}

function acceptedMutations(change: PageChangeDto, before: TargetSnapshot, edited: EditableProposal | undefined, now: number, owner: string): {
  before: TargetSnapshot; after: TargetSnapshot; forward: TargetMutation; inverse: TargetMutation;
} {
  if (change.target.kind === 'block') {
    const target = change.target;
    if (change.forward.kind !== 'block') throw conflict();
    const current = before;
    if (current.kind !== 'block') throw conflict();
    const original = current.exists ? current.block : null;
    if (edited && edited.kind !== 'block') throw new PageWriteError(400, 'invalid', 'Edited content does not match this proposal');
    if (change.forward.op === 'delete') {
      if (!original || edited) throw conflict('This block proposal cannot be edited');
      if (!current.exists || !sameCanonical(current.location, change.forward.expectedLocation)) throw new PageWriteError(409, 'proposal_stale', 'The proposed block location has changed');
      return { before, after: { kind: 'block', exists: false, id: target.blockId, location: null },
        forward: change.forward, inverse: { kind: 'block', op: 'upsert', block: original, location: current.location } };
    }
    if (change.forward.block.id !== target.blockId) throw conflict();
    try {
      const page = getPage(target.pageId, owner, { write: true });
      const withoutTarget = page.blocks.filter((block) => block.id !== target.blockId);
      insertionPosition(withoutTarget, change.forward.location);
    } catch {
      throw new PageWriteError(409, 'proposal_stale', 'The proposed block location has changed');
    }
    if (original && current.exists && !sameCanonical(current.location, change.forward.location)) {
      throw new PageWriteError(409, 'proposal_stale', 'The proposed block location has changed');
    }
    const content = edited?.kind === 'block' ? retainUserPageSegmentSources(edited.block, change.forward.block) : stripBlock(change.forward.block);
    if (original && content.type !== original.type) throw new PageWriteError(400, 'invalid', 'Edited block must retain its type');
    let block: PageBlock = { ...content, id: target.blockId,
      rev: original?.rev ?? change.forward.block.rev, ...(change.forward.block.sources ? { sources: change.forward.block.sources } : {}), edit: { at: now } } as PageBlock;
    block = pinHumanPageComponentBlocks([block], getPage(target.pageId, owner).workspaceId, owner)[0]!;
    const afterLocation = original ? change.forward.location : change.forward.location;
    const after: TargetSnapshot = { kind: 'block', exists: true, block, location: afterLocation };
    const forward: TargetMutation = { kind: 'block', op: 'upsert', block, location: afterLocation };
    const inverse: TargetMutation = original && current.exists
      ? { kind: 'block', op: 'upsert', block: original, location: current.location }
      : { kind: 'block', op: 'delete', id: target.blockId, expectedLocation: afterLocation };
    return { before, after, forward, inverse };
  }
  if (change.target.kind === 'database') {
    if (change.op === 'schema') {
      if (edited) throw new PageWriteError(400, 'invalid', 'Accept or dismiss database configuration proposals without edited content');
      if (change.forward.kind !== 'database' || change.forward.op !== 'replace' ||
        change.inverse.kind !== 'database' || change.inverse.op !== 'replace' || before.kind !== 'database' || !before.exists ||
        change.after?.kind !== 'database' || !change.after.exists) throw conflict('Unsupported database configuration proposal');
      assertExpected(before, change.before);
      const original = before.database, proposed = change.forward.database;
      const { revision: _revision, updatedAt: _updatedAt, ...storedAfter } = change.after.database;
      const { revision: _beforeRevision, updatedAt: _beforeUpdatedAt, ...originalContent } = original;
      if (proposed.id !== original.id || proposed.workspaceId !== original.workspaceId || proposed.title !== original.title ||
        !sameCanonical(storedAfter, proposed) || !sameCanonical(change.inverse.database, originalContent) ||
        original.columns.some((column) => !proposed.columns.some((next) => next.id === column.id)) ||
        original.views.some((view) => !proposed.views.some((next) => next.id === view.id)) ||
        proposed.columns.some((column) => column.type === 'threads') ||
        proposed.views.some((view) => view.type === 'custom' && !sameCanonical(view, original.views.find((old) => old.id === view.id))) ||
        original.views.some((view) => view.type === 'custom' && !sameCanonical(view, proposed.views.find((next) => next.id === view.id)))) {
        throw conflict('The configuration proposal changed unsupported database content');
      }
      const live = getDatabase(change.target.databaseId, owner, { write: true });
      if (live.role) throw conflict('Task database configuration stays in the UI');
      const database = { ...proposed, views: proposed.views.map((view) =>
        sameCanonical(view, original.views.find((old) => old.id === view.id)) ? view : { ...view, edit: { at: now } }) };
      // saveDatabase validates the resulting schema against the live rows before committing.
      return { before, after: { kind: 'database', exists: true, database: { ...database, revision: original.revision + 1, updatedAt: now } },
        forward: { kind: 'database', op: 'replace', database }, inverse: change.inverse };
    }
    if (change.op !== 'view' || change.forward.kind !== 'database' || change.forward.op !== 'replace' ||
      change.inverse.kind !== 'database' || change.inverse.op !== 'replace' || before.kind !== 'database' || !before.exists ||
      !change.after || change.after.kind !== 'database' || !change.after.exists) throw conflict('Unsupported database proposal');
    assertExpected(before, change.before);
    const originalDatabase = before.database;
    const proposedDatabase = change.forward.database;
    const storedAfter = change.after.database;
    if (proposedDatabase.id !== originalDatabase.id || proposedDatabase.workspaceId !== originalDatabase.workspaceId ||
      !sameCanonical(proposedDatabase.title, originalDatabase.title) || !sameCanonical(proposedDatabase.columns, originalDatabase.columns) ||
      storedAfter.id !== proposedDatabase.id || storedAfter.workspaceId !== proposedDatabase.workspaceId ||
      !sameCanonical(storedAfter.title, proposedDatabase.title) || !sameCanonical(storedAfter.columns, proposedDatabase.columns) ||
      !sameCanonical(proposedDatabase.views, storedAfter.views) || !sameCanonical(change.inverse.database.views, originalDatabase.views)) {
      throw conflict('The view proposal changed unrelated database content');
    }
    const beforeViews = new Map(originalDatabase.views.map((view) => [view.id, view]));
    const proposedViews = new Map(proposedDatabase.views.map((view) => [view.id, view]));
    if (beforeViews.size !== originalDatabase.views.length || proposedViews.size !== proposedDatabase.views.length || beforeViews.size !== proposedViews.size) {
      throw conflict('The view proposal changed the view set');
    }
    const changedViews = originalDatabase.views.filter((view) => !sameCanonical(view, proposedViews.get(view.id)));
    if (changedViews.length !== 1) throw conflict('The view proposal must change exactly one view');
    const originalView = changedViews[0]!;
    const proposedView = proposedViews.get(originalView.id);
    const stripComponentConfig = (view: PageDatabaseView) => ({ ...view, type: 'custom', config: {
      ...view.config, componentId: undefined, pinnedVersion: undefined, props: undefined, height: undefined,
    } });
    if (!proposedView || originalView.edit === undefined || proposedView.type !== 'custom' || !proposedView.config.componentId ||
      !sameCanonical(stripComponentConfig(originalView), stripComponentConfig(proposedView))) {
      throw conflict('The protected view proposal changed fields outside its component configuration');
    }
    if (edited && edited.kind !== 'view') throw new PageWriteError(400, 'invalid', 'Edited content does not match this proposal');
    const configPatch = edited?.kind === 'view' ? edited.config : {};
    const proposedConfigKeys = ['componentId', 'pinnedVersion', 'props', 'height']
      .filter((key) => !sameCanonical(originalView.config[key as keyof PageDatabaseView['config']], proposedView.config[key as keyof PageDatabaseView['config']]));
    if (Object.keys(configPatch).some((key) => !['componentId', 'pinnedVersion', 'props', 'height'].includes(key)) ||
      Object.keys(configPatch).some((key) => !proposedConfigKeys.includes(key))) {
      throw new PageWriteError(400, 'invalid', 'Edited fields must be a subset of the proposed view configuration');
    }
    const candidate = { ...proposedView, config: { ...proposedView.config, ...configPatch } };
    const parsed = parsePageDatabaseOps([{ op: 'view.save', view: {
      id: candidate.id, name: candidate.name, type: candidate.type, config: candidate.config,
    } }], 'user');
    if (!parsed.ok) throw new PageWriteError(400, 'invalid', 'Invalid edited view configuration');
    const config = candidate.config;
    const componentId = config.componentId;
    const propsInput = config.props;
    if (!componentId || propsInput === undefined) throw new PageWriteError(400, 'invalid', 'Invalid custom view component configuration');
    const version = pageComponents.read(
      before.database.workspaceId, owner, componentId, config.pinnedVersion,
    ).version;
    const props = pageComponents.validateProps(before.database.workspaceId, owner, componentId, version, propsInput);
    if (props === null) throw new PageWriteError(400, 'invalid', 'Invalid custom view component props');
    const acceptedView: PageDatabaseView = { ...candidate, config: { ...config, pinnedVersion: version, props }, edit: { at: now } };
    const liveDatabase = getDatabase(change.target.databaseId, owner, { write: true });
    const preNormalized = { ...liveDatabase, views: liveDatabase.views.map((view) => view.id === acceptedView.id ? acceptedView : view) };
    const afterDatabase = pinHumanDatabaseViews(preNormalized, owner);
    const normalizedView = afterDatabase.views.find((view) => view.id === acceptedView.id);
    if (!normalizedView || normalizedView.type !== 'custom') throw conflict('The accepted view could not be normalized');
    return {
      before,
      after: { kind: 'database', exists: true, database: { ...afterDatabase, revision: before.database.revision + 1, updatedAt: now } },
      forward: { kind: 'database', op: 'replace', database: afterDatabase },
      inverse: { kind: 'database', op: 'replace', database: { id: originalDatabase.id, workspaceId: originalDatabase.workspaceId,
        title: originalDatabase.title, columns: originalDatabase.columns, views: originalDatabase.views } },
    };
  }
  if (change.target.kind !== 'row' || change.forward.kind !== 'row') throw conflict();
  if (before.kind !== 'row' || !before.exists || change.forward.op === 'delete') {
    if (change.forward.kind === 'row' && change.forward.op === 'delete' && before.kind === 'row' && before.exists && !edited) {
      return { before, after: { kind: 'row', exists: false, id: change.target.rowId, location: null }, forward: change.forward,
        inverse: { kind: 'row', op: 'upsert', row: before.row, location: before.location } };
    }
    throw conflict('This row proposal cannot be edited');
  }
  if (edited && edited.kind !== 'row') throw new PageWriteError(400, 'invalid', 'Edited content does not match this proposal');
  if (change.forward.op === 'patch') {
    const proposedValues = change.forward.values;
    const proposedKeys = Object.keys(proposedValues);
    const editedValues = edited?.kind === 'row' ? edited.values ?? {} : proposedValues;
    if (Object.keys(editedValues).some((key) => !proposedKeys.includes(key))) throw new PageWriteError(400, 'invalid', 'Edited cells must be a subset of the proposal');
    const proposesBody = change.forward.body !== undefined;
    if (edited?.kind === 'row' && edited.body !== undefined && !proposesBody) throw new PageWriteError(400, 'invalid', 'Edited body is outside the proposal');
    const values = { ...before.row.values, ...editedValues };
    const editedCells = { ...before.row.edited, ...Object.fromEntries(Object.keys(editedValues).map((key) => [key, now])) };
    const body = edited?.kind === 'row' && edited.body !== undefined ? edited.body : change.forward.body;
    const bodyEditedAt = body === undefined ? before.row.bodyEditedAt : now;
    const row: PageDatabaseRow = { ...before.row, values, ...(body === undefined ? {} : { body }), edited: editedCells, bodyEditedAt, updatedAt: now };
    const after: TargetSnapshot = { kind: 'row', exists: true, row, location: before.location };
    return { before, after, forward: { kind: 'row', op: 'upsert', row, location: before.location },
      inverse: { kind: 'row', op: 'upsert', row: before.row, location: before.location } };
  }
  if (change.forward.op === 'upsert') {
    const proposed = change.forward.row;
    const editedValues = edited?.kind === 'row' ? edited.values ?? {} : {};
    if (Object.keys(editedValues).some((key) => !(key in proposed.values)) || (edited?.kind === 'row' && edited.body !== undefined && proposed.body === undefined)) {
      throw new PageWriteError(400, 'invalid', 'Edited fields must be a subset of the proposal');
    }
    const row: PageDatabaseRow = { ...proposed, values: { ...proposed.values, ...editedValues }, ...(edited?.kind === 'row' && edited.body !== undefined ? { body: edited.body } : {}),
      edited: { ...proposed.edited, ...Object.fromEntries(Object.keys(editedValues).map((key) => [key, now])) },
      bodyEditedAt: edited?.kind === 'row' && edited.body !== undefined ? now : proposed.bodyEditedAt, updatedAt: now };
    const after: TargetSnapshot = { kind: 'row', exists: true, row, location: change.forward.location };
    return { before, after, forward: { kind: 'row', op: 'upsert', row, location: change.forward.location }, inverse: { kind: 'row', op: 'upsert', row: before.row, location: before.location } };
  }
  throw conflict('Unsupported row proposal');
}

function stripBlock(block: PageBlock): PageBlockInput {
  const { id: _id, rev: _rev, edit: _edit, sources: _sources, ...content } = block;
  return content as PageBlockInput;
}

function applyAccepted(change: PageChangeDto, owner: string, forward: TargetMutation, before: TargetSnapshot, now: number): number {
  if (change.target.kind === 'block') {
    writePageMutation(change.target, owner, forward, before, now);
    return getPage(change.target.pageId, owner).revision;
  }
  saveDatabaseMutation(change.target, owner, forward, before, now);
  return getDatabase(change.target.databaseId, owner).revision;
}
