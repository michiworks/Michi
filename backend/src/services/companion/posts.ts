/**
 * What a check-in leaves in the conversation V (DESIGN-v2 §3.3, §3.4): one
 * message `cmp-post-<runId>` that Michi posts through chatHub.postSelfMessage
 * (queued behind V's running turn, one transaction, broadcast to the open
 * windows, idempotent per run, recorded untrusted), carrying
 * `companionPost {runId, kind, changes}`: the receipt of what the check-in
 * changed in the user's Pages, databases, Today and goals, with Undo all.
 *
 * - It spoke: its reply (its visible text, as S stored it).
 * - It changed something but has nothing to post (quiet, superseded,
 *   stopped): Michi's receipt (prompts.ts companionPostReceipt), e.g. "Michi
 *   updated "Tasks" (3 changes), snoozed 1 item and reworded 1 goal." A
 *   follow-up it sent itself (Q1) counts as such a change (`send`, D21): the
 *   user always hears of it.
 * - Quiet and changed nothing: no post at all.
 * - What its Michi Memory pack showed changed while it ran (D5,
 *   checkinNode.ts checkinMemoryHolds, asked as the post's turn in V comes
 *   up): withdrawn silently, with no notice, and what it changed undone (Undo
 *   all's); the caller hears CompanionCheckinWithdrawn. A follow-up it sent
 *   itself went out while its pack held and cannot be undone: Michi's receipt
 *   of the sends alone still goes into V (D21).
 *
 * What it changed comes from storage, never from the turn's memory, so a
 * restart can still post it (§3.7): page_changes with S's source (the run's
 * applied and proposed changes, by page or database) and
 * companion_run_changes (its Today and goal changes), plus the pages it made
 * (their first revision). A title is given only to a page or database that
 * existed before the check-in and whose title no check-in chose (§2.8 T1),
 * never from the turn's register.
 */

import {
  checkinNodeId,
  companionCheckinTurnId,
  companionPostId,
  isCheckinNodeId,
  type CompanionCheckinKind,
  type CompanionPostChange,
  type CompanionRunUndoResult,
} from 'michi-shared';
import type { PostSelfMessageArgs, PostSelfMessageResult } from '../../agents/chatHub';
import { assistantPurposeKey } from '../../assistant/identity';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { getDb } from '../db';
import { log } from '../logger';
import { listCheckinRunChanges } from '../pages/historyRepository';
import { revertRunPageChanges } from '../pages/pageChanges';
import { pagesMadeBy } from '../pages/repository';
import { checkinMemoryHolds } from './checkinNode';
import { companionEvents, type CompanionEventBus } from './delivery';
import { checkinRunSends, getRun, markRunUndone, recordRunPost, runItemAndGoalChanges, undoRunChanges } from './repository';
import { companionPostReceipt } from './prompts';
import { getCompanionSettings } from './settings';
import type { CompanionClock, CompanionMessageNotifier } from './types';

/** The slice of ChatHub a post needs. */
export interface CompanionPostChatHub {
  postSelfMessage(args: PostSelfMessageArgs): Promise<PostSelfMessageResult>;
}

/**
 * A write source of a check-in's (§2.8 T1): its node is a check-in node, by
 * the `n-cmph-` prefix (S is purged after its run, so never by its row), or
 * an assistant conversation whose purpose is closed (`checkin`, or the MVP's
 * `companion`).
 */
function checkinSourceNode(nodeId: unknown): boolean {
  if (typeof nodeId !== 'string' || !nodeId) return false;
  if (isCheckinNodeId(nodeId)) return true;
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(assistantPurposeKey(nodeId)) as { value: string } | undefined;
  return row?.value === 'checkin' || row?.value === 'companion';
}

/**
 * The title a page had just before `before` (its latest revision then), when
 * someone other than a check-in gave it that title: null for a page made
 * after it, and for one whose title a check-in chose, by creating the page or
 * renaming it, in this run or an earlier one (§2.8 T1). Who gave the title is
 * the source of the first revision of the latest stretch that has it.
 */
function pageTitleBefore(pageId: string, before: number): string | null {
  const db = getDb();
  const latest = db.prepare(`SELECT revision, json_extract(snapshot, '$.title') AS title FROM page_revisions
      WHERE page_id = ? AND created_at < ? ORDER BY revision DESC LIMIT 1`).get(pageId, before) as { revision: number; title: unknown } | undefined;
  if (!latest || typeof latest.title !== 'string' || !latest.title.trim()) return null;
  const changed = db.prepare(`SELECT MAX(revision) AS revision FROM page_revisions
      WHERE page_id = ? AND revision < ? AND json_extract(snapshot, '$.title') IS NOT ?`).get(pageId, latest.revision, latest.title) as { revision: number | null } | undefined;
  const named = db.prepare(`SELECT json_extract(source, '$.nodeId') AS nodeId FROM page_revisions
      WHERE page_id = ? AND revision > ? AND revision <= ? ORDER BY revision ASC LIMIT 1`)
    .get(pageId, changed?.revision ?? 0, latest.revision) as { nodeId: unknown } | undefined;
  if (!named || checkinSourceNode(named.nodeId)) return null;
  return latest.title;
}

/**
 * A database's title, when it existed before `before`, a check-in did not
 * make it (in this run or an earlier one: its first change ever is a
 * check-in's schema change at revision 1, as createAgentDatabase records the
 * database it makes) and the run's first change to its schema did not rename
 * it. Agents cannot rename a database (no write tool takes its title), so
 * whoever made it chose its title.
 */
function databaseTitleBefore(databaseId: string, before: number, renamedFrom: string | null): string | null {
  const db = getDb();
  const row = db.prepare('SELECT title, created_at FROM page_databases WHERE id = ?').get(databaseId) as { title: string; created_at: number } | undefined;
  if (!row || row.created_at >= before) return null;
  const first = db.prepare(`SELECT source_node_id, json_extract(target, '$.kind') AS kind, json_extract(before_json, '$.database.revision') AS revision
      FROM page_changes WHERE database_id = ? ORDER BY seq ASC LIMIT 1`).get(databaseId) as { source_node_id: string | null; kind: unknown; revision: unknown } | undefined;
  if (first && first.kind === 'database' && first.revision === 1 && checkinSourceNode(first.source_node_id)) return null;
  const title = renamedFrom ?? row.title;
  return title.trim() ? title : null;
}

/**
 * What run `runId` changed, as its receipt lists it: one entry per page and
 * database (applied and proposed counts, from its page_changes; a page it
 * made and never edited, which only its first revision records, counts one),
 * per Today item and goal (companion_run_changes), and per conversation it
 * sent a follow-up into itself (`send`, recorded on the run when it went:
 * repository recordCheckinSend, w3-fix D21). `startedAt` (default: the
 * run's) tells which pages and databases were there before it.
 */
export function checkinRunChanges(runId: string, startedAt?: number): CompanionPostChange[] {
  const since = startedAt ?? getRun(runId)?.startedAt ?? 0;
  const targets = new Map<string, CompanionPostChange & { renamedFrom?: string | null }>();
  for (const change of listCheckinRunChanges(runId, LOCAL_AGENT_OWNER_ID)) {
    const page = change.target.kind === 'block';
    const id = change.target.kind === 'block' ? change.target.pageId : change.target.databaseId;
    const key = `${page ? 'page' : 'database'}:${id}`;
    const entry = targets.get(key) ?? { kind: page ? 'page' as const : 'database' as const, id, applied: 0, proposed: 0 };
    // Counted as the check-in left them (a suggestion is one whatever the user did with it since): a later undo does not rewrite its receipt.
    if (change.proposalState !== null) entry.proposed += 1; else entry.applied += 1;
    if (!page && entry.renamedFrom === undefined && change.target.kind === 'database') {
      const before = change.before as { kind?: string; exists?: boolean; database?: { title?: unknown } } | null;
      entry.renamedFrom = before?.kind === 'database' && before.exists && typeof before.database?.title === 'string' ? before.database.title : null;
    }
    targets.set(key, entry);
  }
  // createPage writes pages and page_revisions only: without these, a restart would find nothing to post for a page it made and never edited (§3.4, §3.7).
  for (const made of pagesMadeBy({ nodeId: checkinNodeId(runId), turnId: companionCheckinTurnId(runId) }, LOCAL_AGENT_OWNER_ID)) {
    if (!targets.has(`page:${made.id}`)) targets.set(`page:${made.id}`, { kind: 'page', id: made.id, applied: 1, proposed: 0 });
  }
  const changes: CompanionPostChange[] = [];
  for (const { renamedFrom, ...entry } of targets.values()) {
    const title = entry.kind === 'page' ? pageTitleBefore(entry.id, since) : databaseTitleBefore(entry.id, since, renamedFrom ?? null);
    changes.push({ ...entry, ...(title ? { title } : {}) });
  }
  return [...changes, ...runItemAndGoalChanges(runId), ...checkinRunSends(runId)];
}

/**
 * The changes a post lists: what storage says the run changed (`stored`,
 * checkinRunChanges, the source of truth that also survives a restart), and
 * anything the turn's own register has (`noted`, checkinWrites.ts) that
 * storage does not. Titles are storage's only: where storage gives none (a
 * page or database the check-in made, or whose title a check-in chose) none
 * is taken from the register, whose later writes carry the title the
 * check-in picked (§2.8 T1); an entry only the register has gets none either.
 */
export function mergeCheckinChanges(stored: readonly CompanionPostChange[], noted: readonly CompanionPostChange[]): CompanionPostChange[] {
  const key = (change: CompanionPostChange) => `${change.kind}:${change.id}`;
  const fromRegister = new Map(noted.map((change) => [key(change), change]));
  const merged = stored.map((change) => {
    fromRegister.delete(key(change));
    return { ...change };
  });
  return [...merged, ...[...fromRegister.values()].map(({ title: _title, ...change }) => change)];
}

/**
 * Michi's deterministic receipt for a check-in that changed something and has
 * nothing of its own to post (§3.4; prompts.ts companionPostReceipt, the
 * `post.receipt` template). `stoppedEarly`: it did not finish (a restart, a
 * failure, a stop) after it had changed these (§3.7).
 */
function receiptText(changes: readonly CompanionPostChange[], stoppedEarly: boolean): string {
  const name = getCompanionSettings().displayName;
  // Every change a run records counts at least one, so the template always has words for it.
  return companionPostReceipt(name, changes, { stopped: stoppedEarly }) ?? `${name} changed something.`;
}

export interface CompanionPostInput {
  runId: string;
  kind: CompanionCheckinKind;
  /** The conversation V. */
  nodeId: string;
  /** The check-in's own reply; null or empty: the receipt, when it changed something. */
  text: string | null;
  /** What it changed (default: checkinRunChanges(runId)). */
  changes?: CompanionPostChange[];
  /** The receipt says it stopped early (§3.7). */
  stoppedEarly?: boolean;
  /** The items its material was about, for the notification gate. */
  itemIds?: readonly string[];
  /** Its reply's follow-up chips (its `[FOLLOW-UPS: …]`); a receipt has none. */
  followUps?: readonly string[];
}

export interface CompanionPostDeps {
  chatHub: CompanionPostChatHub;
  clock: CompanionClock;
  notifier?: CompanionMessageNotifier | null;
  events?: Pick<CompanionEventBus, 'emitChanged'>;
}

export interface CompanionPostResult {
  messageId: string;
  /** `existing`: the run had posted already (a retry after a restart). */
  result: Exclude<PostSelfMessageResult, 'withdrawn'>;
  changes: CompanionPostChange[];
}

/** postCompanionMessage withdrew the check-in's result (D5): nothing of its own was posted, and what it changed is undone. */
export class CompanionCheckinWithdrawn extends Error {
  constructor(readonly runId: string) {
    super(`check-in ${runId} withdrawn: Michi Memory changed while it ran`);
    this.name = 'CompanionCheckinWithdrawn';
  }
}

/** A withdrawn check-in's changes, undone as Undo all undoes them; what cannot be (a send) stays, and its receipt still goes into V. */
function withdrawChanges(runId: string, deps: CompanionPostDeps): void {
  try {
    undoCompanionRun(runId, deps.clock.now());
  } catch (error) {
    log.warn('chat', 'companion withdrawn check-in not undone', { runId, error: error instanceof Error ? error.message : String(error) });
  }
  for (const reason of ['items', 'goals'] as const) {
    try {
      (deps.events ?? companionEvents).emitChanged(reason);
    } catch {
      // A broken subscriber never fails the withdrawal.
    }
  }
}

/**
 * postCompanionMessage (§3.3): posts run `runId`'s message into V, records
 * it on the run (posted_message_id, posted_at, the receipt's changes),
 * tells the snapshot's subscribers (`conversation`, for the unread count)
 * and hands it to the notification gate (companionSpoke; its rules decide
 * whether a notice goes out). Null when there is nothing to post (no text,
 * nothing changed). Throws CompanionCheckinWithdrawn when what the
 * check-in's memory pack showed no longer holds as its turn in V comes up
 * (its changes undone first, the receipt of its follow-ups posted), and what
 * postSelfMessage throws.
 */
export async function postCompanionMessage(input: CompanionPostInput, deps: CompanionPostDeps): Promise<CompanionPostResult | null> {
  const changes = input.changes ?? checkinRunChanges(input.runId);
  const own = input.text?.trim() ?? '';
  if (!own && changes.length === 0) return null;
  const text = own || receiptText(changes, input.stoppedEarly === true);
  const messageId = companionPostId(input.runId);
  const followUps = own ? input.followUps?.filter((label) => label.trim()) ?? [] : [];
  const post = (body: string, listed: CompanionPostChange[], extra: Partial<PostSelfMessageArgs> = {}) => deps.chatHub.postSelfMessage({
    chatId: input.nodeId,
    nodeId: input.nodeId,
    turnId: messageId,
    messageId,
    text: body,
    metadata: { companionPost: { runId: input.runId, kind: input.kind, changes: listed } },
    untrusted: { tool: 'companion_post', detail: 'checkin' },
    ownerUserId: null,
    ...extra,
  });
  const recordPosted = (listed: CompanionPostChange[]) => {
    recordRunPost(input.runId, { messageId, at: deps.clock.now(), changes: listed });
    try {
      (deps.events ?? companionEvents).emitChanged('conversation');
    } catch {
      // A broken subscriber never fails the post.
    }
  };
  const result = await post(text, changes, {
    ...(followUps.length > 0 ? { followUps: [...followUps] } : {}),
    shouldPost: () => checkinMemoryHolds(input.runId),
  });
  if (result === 'withdrawn') {
    if (changes.length > 0) withdrawChanges(input.runId, deps);
    // A follow-up it sent itself went out while its pack held and cannot be taken back: the user still hears of it (D21),
    // from Michi's receipt of the sends alone, with no model text and no notice.
    const sends = changes.filter((change) => change.kind === 'send');
    if (sends.length > 0) {
      try {
        await post(receiptText(sends, input.stoppedEarly === true), sends);
        recordPosted(sends);
      } catch (error) {
        log.warn('chat', 'companion withdrawn check-in: receipt of its follow-up not posted', {
          runId: input.runId, error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw new CompanionCheckinWithdrawn(input.runId);
  }
  recordPosted(changes);
  if (result === 'posted') {
    try {
      deps.notifier?.companionSpoke({ runId: input.runId, runKind: input.kind, itemIds: input.itemIds ?? [] });
    } catch (error) {
      log.warn('chat', 'companion post notice failed', { runId: input.runId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { messageId, result, changes };
}

/**
 * "Undo all" on a check-in's receipt or Activity row (POST
 * /companion/runs/:runId/undo, DESIGN-v2 §2.7): first its Pages and database
 * changes (pages/pageChanges revertRunPageChanges: newest first, stopping at
 * the first conflict, its pending suggestions dismissed, what it made taken
 * away while nobody touched it), then its Today and goal changes
 * (companion_run_changes). `reverted` lists page_changes ids (the changes
 * put back, the suggestions dismissed), then the Today and goal changes
 * (CompanionRunUndoResult); `undone` once nothing of the run stands (the run's
 * undoneAt). A follow-up the check-in sent itself (D21) went out and stays:
 * it is listed last among the conflicts, `send:<nodeId>`, and the run is
 * never all undone. Safe to repeat. Null for a run that is not a check-in's
 * (a poll, a send, an MVP turn) or not there.
 */
export function undoCompanionRun(runId: string, now: number): (CompanionRunUndoResult & { undone: boolean }) | null {
  const run = getRun(runId);
  if (!run?.checkinNodeId) return null;
  const pages = revertRunPageChanges(runId, LOCAL_AGENT_OWNER_ID, now);
  const today = undoRunChanges(runId, now);
  const sent = checkinRunSends(runId).map((send) => ({
    changeId: `send:${send.id}`,
    message: `The follow-up to ${send.title ? `"${send.title}"` : 'that conversation'} already went out, so it cannot be taken back`,
  }));
  const undone = pages.remaining === 0 && today.remaining === 0 && sent.length === 0;
  if (undone && run.undoneAt == null) markRunUndone(runId, now);
  return {
    reverted: [...pages.reverted, ...pages.dismissed, ...today.reverted],
    conflicts: [...pages.conflicts, ...today.conflicts, ...sent],
    undone,
  };
}
