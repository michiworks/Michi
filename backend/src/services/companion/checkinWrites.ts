/**
 * What one check-in changed in the user's content (DESIGN-v2 §2.6.6, §3.4):
 * every write a check-in's tools make is noted here under its turn
 * (`cmp-<runId>`), by the tool that made it:
 * - pages and databases: W2-E's checkin page guard (assistant/checkinPageGuard.ts),
 *   once per write call, with what the engine applied and what it left as
 *   proposals, and the title only for a page or database that existed
 *   before the check-in (§2.8 T1);
 * - Today items and goals: companion_update_item and companion_edit_goal
 *   (tools.ts), with what they did and the check-in's reason.
 * The register drives "wrote something, so it must post" (§3.4): a check-in
 * that changed anything cannot end with nothing_to_do (tools.ts), and W2-G1a
 * reads checkinWritesOf(turnId) when the turn ends (§3.1 step 7) to post the
 * reply or the deterministic receipt (prompts.ts companionPostReceipt).
 *
 * In memory, per process: a crash loses it, and the boot cleanup (§3.7)
 * reads what a run changed from page_changes and companion_run_changes
 * instead. Bounded, so a turn nobody forgets cannot grow it for ever.
 * Notes, goal readings, briefs and cards are the agent's own state and are
 * never noted (§3.4: no post needed for them).
 */

import {
  COMPANION_LIMITS,
  COMPANION_POST_CHANGE_KINDS,
  companionChangeActionsFor,
  type CompanionPostChange,
  type CompanionPostChangeAction,
  type CompanionPostChangeKind,
} from 'michi-shared';

/** One write a check-in made: §2.6.6's `{kind, id, title, applied, proposed}`, plus an item's or goal's action and reason. */
export interface CheckinWrite {
  kind: CompanionPostChangeKind;
  /** The page, database, Today item or goal. */
  id: string;
  /** Pages and databases that existed before the check-in only; never one the check-in created or renamed. */
  title?: string | null;
  /** Changes the write applied directly. */
  applied: number;
  /** Changes it left as proposals for the user. */
  proposed: number;
  /** Items and goals: what the check-in did (companionChangeActionsFor(kind)). */
  action?: CompanionPostChangeAction;
  /** Items and goals: the check-in's reason, at most COMPANION_LIMITS.maxChangeReasonChars. */
  reason?: string | null;
}

/** Turns this process keeps a register for. */
const MAX_TRACKED_TURNS = 64;
/** Targets one turn's register keeps (a check-in may change at most checkinMaxChangedTargets blocks and rows). */
const MAX_TARGETS_PER_TURN = 200;

const writesByTurn = new Map<string, Map<string, CompanionPostChange>>();

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Notes a write of the check-in turn `turnId`. Writes to one target add up
 * (counts summed); its title is the first write's and only the first's: a
 * target first noted without one (a page or database the check-in created)
 * never gets one from a later write, which would be the title the check-in
 * itself chose (§2.8 T1). An item's or a goal's latest action and reason win,
 * except that a goal the check-in added stays "added" when it rewords it
 * afterwards. A write that changed nothing (0 applied, 0 proposed) is not
 * noted. Throws on a malformed write: it is a caller's bug.
 */
export function noteCheckinWrite(turnId: string, write: CheckinWrite): void {
  if (!turnId) throw new Error('noteCheckinWrite needs the check-in turn id');
  if (!(COMPANION_POST_CHANGE_KINDS as readonly string[]).includes(write.kind)) throw new Error(`noteCheckinWrite: unknown kind ${String(write.kind)}`);
  if (!write.id) throw new Error('noteCheckinWrite needs the target id');
  if (!isCount(write.applied) || !isCount(write.proposed)) throw new Error('noteCheckinWrite: applied and proposed are counts');
  const action = write.action && (companionChangeActionsFor(write.kind) as readonly string[]).includes(write.action) ? write.action : undefined;
  if (write.action && !action) throw new Error(`noteCheckinWrite: a ${write.kind} cannot be ${write.action}`);
  if (write.applied === 0 && write.proposed === 0) return;
  const reason = typeof write.reason === 'string' && write.reason.trim()
    ? write.reason.trim().slice(0, COMPANION_LIMITS.maxChangeReasonChars) : undefined;
  const title = typeof write.title === 'string' && write.title.trim() ? write.title.trim() : undefined;

  let writes = writesByTurn.get(turnId);
  if (writes) writesByTurn.delete(turnId);
  else writes = new Map();
  writesByTurn.set(turnId, writes);
  while (writesByTurn.size > MAX_TRACKED_TURNS) writesByTurn.delete(writesByTurn.keys().next().value as string);

  const key = `${write.kind}\u0000${write.id}`;
  const existing = writes.get(key);
  if (!existing) {
    if (writes.size >= MAX_TARGETS_PER_TURN) return;
    writes.set(key, {
      kind: write.kind,
      id: write.id,
      ...(title && (write.kind === 'page' || write.kind === 'database') ? { title } : {}),
      applied: write.applied,
      proposed: write.proposed,
      ...(action ? { action } : {}),
      ...(action && reason ? { reason } : {}),
    });
    return;
  }
  existing.applied += write.applied;
  existing.proposed += write.proposed;
  if (action && !(existing.action === 'add' && action === 'reword')) {
    existing.action = action;
    if (reason) existing.reason = reason;
    else delete existing.reason;
  }
}

/**
 * What the check-in turn `turnId` changed so far, one entry per target in
 * the order it first changed them; empty when it changed nothing. A copy:
 * the register stays until forgetCheckinWrites.
 */
export function checkinWritesOf(turnId: string): CompanionPostChange[] {
  return [...(writesByTurn.get(turnId)?.values() ?? [])].map((change) => ({ ...change }));
}

/** The check-in is over and its post is written: drop its register (W2-G1a, in the run's finally). */
export function forgetCheckinWrites(turnId: string): void {
  writesByTurn.delete(turnId);
}
