/**
 * The Companion's cleanup passes.
 *
 * runDailyCleanup (DESIGN R2.10): once per local day, repository.purgeExpired
 * over its own tables, the tool outputs kept in the Companion's conversations'
 * messages, V's current and archived ones included (purgeCompanionToolOutputs,
 * B18), and a cap on the
 * run log (pruneRuns). The coordinator calls it on every tick of the process
 * that holds the scheduler lease, whether or not the Companion is on, so
 * retention keeps working after the user turns the Companion off.
 *
 * cleanUpCheckins (DESIGN-v2 §3.7): what a stopped Michi left of its
 * check-ins, by the process that holds the lease before its first tick. It
 * works from the runs that have a check-in node (companion_runs ∩ the
 * assistant workspace's nodes, never a bare id prefix: a run whose node sits
 * anywhere else is left alone):
 * - a check-in cut short (its run still `running`): when it had posted
 *   already, the run ends as what it posted; else when it had finished and
 *   is less than 30 minutes old, and the user has not written since it began,
 *   its reply is posted now (the same post id: idempotent); otherwise, when it
 *   changed the user's things, Michi's receipt ("stopped early" unless it had
 *   finished); its run ends with what happened ("not posted: Michi
 *   restarted");
 * - a check-in that ended without a post while S is still there (its turn
 *   would not stop, or its post failed): its receipt, when it changed
 *   something;
 * - its native record is discarded (from S's binding, or from what the run
 *   recorded once S is gone): `deferred` leaves the run pending, never
 *   recorded as gone; `unsupported` is final (D11): the run records that its
 *   runtime keeps it, says so in Activity, and is not asked about again;
 * - S is purged once its session let go, before the run records its native
 *   record as settled, so a purge that fails is retried at the next start.
 * discardMvpCompanionSessions: the native sessions the MVP's Companion
 * conversation ran on (its ledger, assistant_native_sessions) are discarded
 * once each; any answer but discarded or absent keeps the entry for the next
 * start.
 */

import { companionCheckinTurnId, companionPostId, extractTurnMetadata, type CompanionPostChange } from 'michi-shared';
import { chatOwner } from '../../agents/ownerMapping';
import { getRuntime } from '../../agents/registry';
import { assistantCwd, isAssistantNode } from '../../assistant/store';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { getDb } from '../db';
import { log } from '../logger';
import { stripSentinelsStreamingSafe } from '../messageSerialization';
import { checkinNodeExists, purgeCheckinNode } from './checkinNode';
import { localDateKey } from './clock';
import { COMPANION_WITHDRAWN_NOTE, isCheckinWindingDown, storedFollowUps, type CompanionTurnChatHub, type CompanionTurnChatManager } from './conversation';
import type { CompanionEventBus } from './delivery';
import { CompanionCheckinWithdrawn, checkinRunChanges, postCompanionMessage } from './posts';
import {
  finishRun,
  getCompanionMetaNumber,
  listCheckinRunsToClean,
  markRunDiscarded,
  markRunNativeKept,
  pruneRuns,
  purgeCompanionToolOutputs,
  purgeExpired,
  setCompanionMetaNumber,
  setRunReplyChars,
  userWroteInConversation,
  type CompanionPurgeResult,
  type CompanionRunRecord,
} from './repository';
import type { CompanionClock, CompanionMessageNotifier, CompanionTurnKind } from './types';

/**
 * Runs kept at most, newest first (running ones, and the check-ins whose
 * native record is still to be discarded, always stay and do not count).
 * Outside polls that changed nothing keep only their latest row per source,
 * so this is mostly turns, changes and failures; purgeExpired drops the rest
 * after 30 days.
 */
export const COMPANION_RUN_LOG_CAP = 10_000;

export interface CompanionDailyCleanupResult extends CompanionPurgeResult {
  /** Messages of the Companion's conversations whose tool outputs were replaced. */
  toolOutputs: number;
  /** Runs past the log's cap. */
  prunedRuns: number;
}

/** Purges once per local day; null when today's pass already ran. */
export function runDailyCleanup(now: number): CompanionDailyCleanupResult | null {
  const last = getCompanionMetaNumber('companion:last_purge_at');
  if (last !== null && last <= now && localDateKey(last) === localDateKey(now)) return null;
  const result = purgeExpired(now);
  const toolOutputs = purgeCompanionToolOutputs(now);
  const prunedRuns = pruneRuns(COMPANION_RUN_LOG_CAP);
  setCompanionMetaNumber('companion:last_purge_at', Math.floor(now));
  return { ...result, toolOutputs, prunedRuns };
}

// ── What a stopped Michi left of its check-ins (DESIGN-v2 §3.7) ─────────────

/** A finished check-in a restart cut off before it posted is posted this long after it finished, no later. */
export const COMPANION_LATE_POST_MS = 30 * 60_000;

export interface CompanionCheckinCleanupDeps {
  chatHub: Pick<CompanionTurnChatHub, 'postSelfMessage'>;
  chatManager: Pick<CompanionTurnChatManager, 'discardEphemeralSession'>;
  clock: CompanionClock;
  /** The conversation V posts go into; null: nothing is posted. */
  conversationNodeId: () => string | null;
  notifier?: CompanionMessageNotifier | null;
  events?: Pick<CompanionEventBus, 'emitChanged'>;
  /** Runs left alone: one this process runs, or another process may still be running. */
  skip?: (runId: string) => boolean;
}

/** A check-in run cleanup finished, with how it ended. */
export interface CompanionCheckinSettled {
  runId: string;
  kind: CompanionTurnKind;
  /** `quiet`: its receipt, not a reply, was posted before Michi stopped. */
  outcome: 'spoke' | 'quiet' | 'superseded' | 'error';
  postedMessageId: string | null;
}

export interface CompanionCheckinCleanupResult {
  /** Runs it found still running and ended. */
  settled: CompanionCheckinSettled[];
  purged: number;
  discarded: number;
  /** Runs whose native record is still not known to be gone (deferred, or S still busy): asked again at the next start. */
  pending: number;
  /** Runs whose runtime answered that it keeps the native record (unsupported): final, never asked again (D11). */
  kept: number;
}

interface TurnRow {
  status: string;
  updated_at: number;
  assistant_message_id: string;
}

/** S's own durable turn and its reply, while S's rows are there. */
function checkinTurn(nodeId: string, runId: string): { status: string; endedAt: number; reply: string | null; followUps: string[] } | null {
  const turn = getDb().prepare('SELECT status, updated_at, assistant_message_id FROM turns WHERE turn_id = ? AND node_id = ?')
    .get(companionCheckinTurnId(runId), nodeId) as TurnRow | undefined;
  if (!turn) return null;
  const message = getDb().prepare('SELECT content FROM messages WHERE id = ? AND node_id = ?').get(turn.assistant_message_id, nodeId) as { content: string | null } | undefined;
  const reply = message?.content ? stripSentinelsStreamingSafe(message.content).trim() : '';
  const stored = storedFollowUps(nodeId, turn.assistant_message_id);
  const followUps = stored.length > 0 ? stored : message?.content ? extractTurnMetadata(message.content).followUps ?? [] : [];
  return { status: turn.status, endedAt: turn.updated_at, reply: reply || null, followUps };
}

/**
 * Ends a run a restart cut off: its reply when it had finished in the last
 * 30 minutes and the user has not written since, else its receipt when it
 * changed something. Returns how it ended.
 */
async function settleInterrupted(run: CompanionRunRecord, deps: CompanionCheckinCleanupDeps, now: number): Promise<CompanionCheckinSettled> {
  const kind = run.kind as CompanionTurnKind;
  const nodeId = run.checkinNodeId!;
  const turn = checkinNodeExists(nodeId) ? checkinTurn(nodeId, run.id) : null;
  const finished = turn?.status === 'completed';
  if (run.postedAt !== null) return settlePosted(run, kind, finished && !!turn?.reply, finished, now);
  const conversation = deps.conversationNodeId();
  const userWrote = conversation ? userWroteInConversation(conversation, run.startedAt) : false;
  let changes: CompanionPostChange[] = [];
  try {
    changes = checkinRunChanges(run.id, run.startedAt);
  } catch (error) {
    log.warn('scheduler', 'companion check-in changes not read', { runId: run.id, err: error instanceof Error ? error.message : String(error) });
  }
  const reply = finished && turn?.reply && now - turn.endedAt <= COMPANION_LATE_POST_MS && !userWrote ? turn.reply : null;
  let outcome: CompanionCheckinSettled['outcome'] = 'error';
  let detail = finished ? 'Not posted: Michi restarted' : 'Interrupted: Michi stopped while it ran';
  if (reply) {
    outcome = 'spoke';
    detail = 'Posted after Michi restarted';
  } else if (finished && turn?.reply && userWrote) {
    outcome = 'superseded';
    const chars = Array.from(turn.reply).length;
    setRunReplyChars(run.id, chars);
    detail = `Your message came first, so its reply (${chars} characters) was not posted`;
  }
  let postedMessageId: string | null = null;
  if (conversation && (reply || changes.length > 0)) {
    try {
      const post = await postCompanionMessage({
        runId: run.id, kind, nodeId: conversation, text: reply, changes, stoppedEarly: !finished, ...(reply ? { followUps: turn?.followUps ?? [] } : {}),
      },
        { chatHub: deps.chatHub, clock: deps.clock, notifier: deps.notifier, events: deps.events });
      postedMessageId = post?.messageId ?? null;
    } catch (error) {
      log.warn('scheduler', 'companion check-in not posted after the restart', { runId: run.id, err: error instanceof Error ? error.message : String(error) });
      if (error instanceof CompanionCheckinWithdrawn) {
        outcome = 'error';
        detail = COMPANION_WITHDRAWN_NOTE;
      } else if (outcome === 'spoke') {
        outcome = 'error';
        detail = 'Not posted: Michi restarted';
      }
    }
  }
  finishRun(run.id, { outcome, finishedAt: now, detail });
  return { runId: run.id, kind, outcome, postedMessageId };
}

/**
 * A run a restart cut off after its post went into V (posted_at is set once
 * postSelfMessage committed it) and before its run ended: nothing is posted
 * again, and the run ends as what it posted (G1a-review #8): its reply
 * (`spoke`), the receipt of a reply the user's message superseded, or its
 * receipt alone (`quiet` when the turn had finished, else stopped early).
 */
function settlePosted(run: CompanionRunRecord, kind: CompanionTurnKind, replied: boolean, finished: boolean, now: number): CompanionCheckinSettled {
  const postedMessageId = run.postedMessageId ?? companionPostId(run.id);
  let outcome: CompanionCheckinSettled['outcome'];
  let detail: string;
  if (run.replyChars !== null) {
    outcome = 'superseded';
    detail = `Your message came first, so its reply (${run.replyChars} characters) was not posted`;
  } else if (replied) {
    outcome = 'spoke';
    detail = 'Posted before Michi restarted';
  } else if (finished) {
    outcome = 'quiet';
    detail = 'Its receipt was posted before Michi restarted';
  } else {
    outcome = 'error';
    detail = 'Stopped early: Michi stopped while it ran, after it posted its receipt';
  }
  finishRun(run.id, { outcome, finishedAt: now, detail });
  return { runId: run.id, kind, outcome, postedMessageId };
}

/**
 * A run that ended without a post while its node S is still there: its turn
 * would not stop in time (conversation.ts posts its receipt once the turn
 * ends, and a restart came first), or its post failed. When it changed the
 * user's things, its receipt goes into V now (§3.4: a check-in that wrote
 * must post); the run's own outcome stays as it was recorded.
 */
async function postLateReceipt(run: CompanionRunRecord, deps: CompanionCheckinCleanupDeps): Promise<void> {
  const conversation = deps.conversationNodeId();
  if (!conversation) return;
  const changes = checkinRunChanges(run.id, run.startedAt);
  if (changes.length === 0) return;
  await postCompanionMessage({
    runId: run.id, kind: run.kind as CompanionTurnKind, nodeId: conversation, text: null, changes,
    stoppedEarly: run.outcome === 'error' || run.outcome === 'preempted',
  }, { chatHub: deps.chatHub, clock: deps.clock, notifier: deps.notifier, events: deps.events });
}

/**
 * cleanUpCheckins (see the module comment). Runs `skip` names are left
 * alone, and so are the check-ins this process still winds down
 * (conversation.ts isCheckinWindingDown). Never throws for one run: each
 * failure is logged and the next run still gets its turn.
 */
export async function cleanUpCheckins(deps: CompanionCheckinCleanupDeps): Promise<CompanionCheckinCleanupResult> {
  const result: CompanionCheckinCleanupResult = { settled: [], purged: 0, discarded: 0, pending: 0, kept: 0 };
  for (const run of listCheckinRunsToClean()) {
    if (deps.skip?.(run.id) || isCheckinWindingDown(run.id)) continue;
    const now = deps.clock.now();
    const nodeId = run.checkinNodeId!;
    try {
      const exists = checkinNodeExists(nodeId);
      if (exists && !isAssistantNode(nodeId)) {
        // S lives in the assistant's workspace (runs ∩ workspace): a node with its id anywhere else is not the check-in's, and is left alone.
        result.pending += 1;
        log.warn('scheduler', 'companion check-in node outside the assistant workspace: left alone', { runId: run.id });
        continue;
      }
      if (run.outcome === 'running') result.settled.push(await settleInterrupted(run, deps, now));
      else if (exists && run.postedAt === null) {
        try {
          await postLateReceipt(run, deps);
        } catch (error) {
          log.warn('scheduler', 'companion check-in receipt not posted after the restart', { runId: run.id, err: error instanceof Error ? error.message : String(error) });
        }
      }
      if (run.discardedAt !== null || run.nativeKeptAt !== null) {
        // Its native record is settled; S is only still there because its purge failed.
        if (exists && purgeCheckinNode(nodeId)) result.purged += 1;
        continue;
      }
      let answer: Awaited<ReturnType<CompanionCheckinCleanupDeps['chatManager']['discardEphemeralSession']>>;
      if (exists || run.session) {
        answer = await deps.chatManager.discardEphemeralSession({
          ownerUserId: LOCAL_AGENT_OWNER_ID, nodeId, ...(exists || !run.session ? {} : { recorded: run.session }),
        });
      } else {
        // Neither S nor a recorded session: it never opened one, so no native record exists.
        answer = 'absent';
      }
      if (answer === 'busy') { result.pending += 1; continue; }
      // S first: the run records its native record as settled only once nothing of S is left (G1a-review #5).
      if (exists && purgeCheckinNode(nodeId)) result.purged += 1;
      if (answer === 'discarded' || answer === 'absent') {
        markRunDiscarded(run.id, deps.clock.now());
        result.discarded += 1;
      } else if (answer === 'unsupported') {
        markRunNativeKept(run.id, deps.clock.now());
        result.kept += 1;
      } else {
        result.pending += 1;
      }
    } catch (error) {
      result.pending += 1;
      log.warn('scheduler', 'companion check-in not cleaned up', { runId: run.id, err: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

// ── The MVP's Companion conversation (DESIGN-v2 §3.7, §7 step 3) ────────────

/** What one native session of the MVP's Companion conversation needs to be discarded. */
export interface CompanionMvpSession {
  nodeId: string;
  nativeSessionId: string;
  /** The runtimes the conversation ran on: the session is one of theirs. */
  runtimeIds: string[];
}

/** The MVP Companion conversations' recorded native sessions still on the ledger (meta purpose `companion`, not a check-in node). */
export function listMvpCompanionSessions(): CompanionMvpSession[] {
  const db = getDb();
  const nodes = db.prepare(`SELECT n.id, n.runtime_id FROM nodes n JOIN meta m ON m.key = 'assistant:purpose:' || n.id
      WHERE m.value = 'companion' AND substr(n.id, 1, 7) <> 'n-cmph-'`).all() as Array<{ id: string; runtime_id: string | null }>;
  const sessions: CompanionMvpSession[] = [];
  for (const node of nodes) {
    const runtimes = new Set<string>(node.runtime_id ? [node.runtime_id] : []);
    for (const row of db.prepare('SELECT previous_runtime_id, runtime_id FROM assistant_runtime_switches WHERE node_id = ?').all(node.id) as Array<{ previous_runtime_id: string; runtime_id: string }>) {
      runtimes.add(row.previous_runtime_id);
      runtimes.add(row.runtime_id);
    }
    for (const row of db.prepare('SELECT native_id FROM assistant_native_sessions WHERE node_id = ? ORDER BY recorded_at, native_id').all(node.id) as Array<{ native_id: string }>) {
      sessions.push({ nodeId: node.id, nativeSessionId: row.native_id, runtimeIds: [...runtimes] });
    }
  }
  return sessions;
}

export type CompanionMvpDiscard = (input: { session: CompanionMvpSession; runtimeId: string }) => Promise<'discarded' | 'absent' | 'deferred' | 'unsupported'>;

/** Asks the runtime to discard one MVP session from the cwd every assistant conversation ran in. */
const discardWithRuntime: CompanionMvpDiscard = async ({ session, runtimeId }) => {
  const runtime = getRuntime(runtimeId);
  if (!runtime?.discardNativeSession) return 'unsupported';
  return runtime.discardNativeSession({
    sessionId: session.nodeId,
    owner: chatOwner(session.nodeId),
    nativeSessionId: session.nativeSessionId,
    cwd: assistantCwd(),
    profileHash: null,
    ownerUserId: LOCAL_AGENT_OWNER_ID,
  });
};

/**
 * Discards each MVP Companion session once (see the module comment): a
 * session is gone when a runtime it may belong to discarded it, or every one
 * of them found none; its ledger entry goes then. Anything else (deferred,
 * unsupported: Kiro keeps the MVP's in `~/.kiro`, a runtime error) keeps the
 * entry, so the next start asks again; nothing records it as gone.
 */
export async function discardMvpCompanionSessions(discard: CompanionMvpDiscard = discardWithRuntime): Promise<{ discarded: number; pending: number }> {
  let discarded = 0;
  let pending = 0;
  for (const session of listMvpCompanionSessions()) {
    const answers: string[] = [];
    for (const runtimeId of session.runtimeIds) {
      try {
        answers.push(await discard({ session, runtimeId }));
      } catch (error) {
        answers.push('deferred');
        log.warn('scheduler', 'companion MVP session not discarded', { err: error instanceof Error ? error.message : String(error) });
      }
    }
    const gone = answers.includes('discarded') || (answers.length > 0 && answers.every((answer) => answer === 'absent'));
    if (!gone) { pending += 1; continue; }
    getDb().prepare('DELETE FROM assistant_native_sessions WHERE native_id = ? AND node_id = ?').run(session.nativeSessionId, session.nodeId);
    discarded += 1;
  }
  if (pending > 0) log.warn('scheduler', 'companion MVP transcripts still on disk', { pending });
  return { discarded, pending };
}
