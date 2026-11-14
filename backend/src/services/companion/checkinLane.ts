/**
 * The scheduler's check-in lane (unification D11, P6): what each scheduler
 * tick does for the Companion, and how a check-in run the scheduler admitted
 * runs.
 *
 * Each tick keeps the lane's execution identity (checkinIdentity.ts). Then,
 * by the engine (checkinEngine.ts):
 *   coordinator  the lane only shadows the coordinator, which starts the
 *                check-ins on its own timer (checkinShadow.ts, P6a);
 *   scheduler    the tick runs the coordinator's deterministic step (polls,
 *                reminders, notices, the welcome; it starts polls and never
 *                waits on them), releases the claims a stopped Michi left
 *                once their check-ins are cleaned up, and starts the identity's
 *                run when the planner has a check-in (hasWork). The run asks
 *                the coordinator to start the check-in the planner picks then
 *                and ends with it (runAsLane).
 * A check-in the user's typing preempted is a cancelled run, never a failure.
 */

import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import type { ScheduledCheckinOutcome } from '../scheduledJobs/scheduler';
import { checkinEngine } from './checkinEngine';
import { checkinIdentityJobId, sweepCheckinIdentity, type CheckinIdentityScheduler } from './checkinIdentity';
import type { CompanionCoordinator, LaneCheckinResult } from './coordinator';

/** The scheduler's part the lane uses. */
export interface CheckinLaneScheduler extends CheckinIdentityScheduler {
  startCheckin(jobId: string, now: number): boolean;
  releaseSettledCheckinClaims(now: number): number;
}

export interface CheckinLane {
  tick(scheduler: CheckinLaneScheduler, now: number): void;
  run(input: { runId: string; signal: AbortSignal; cancel: () => void }): Promise<ScheduledCheckinOutcome>;
}

/** The scheduler's record of a check-in: kind and outcome, never its text. */
export function laneOutcome(result: LaneCheckinResult): ScheduledCheckinOutcome {
  if (result.kind === null || result.outcome === null) return { status: 'succeeded', summary: 'Nothing to check in about', error: null };
  const summary = `${result.kind}: ${result.outcome}`;
  switch (result.outcome) {
    case 'spoke':
    case 'quiet':
    case 'skipped':
      return { status: 'succeeded', summary, error: null };
    case 'preempted':
    case 'superseded':
      return { status: 'cancelled', summary, error: null };
    case 'error':
      return { status: 'failed', summary, error: result.detail ?? 'The check-in failed' };
  }
}

export function createCheckinLane(coordinator: Pick<CompanionCoordinator, 'tick' | 'lookAsLane' | 'laneSettled' | 'laneHasWork' | 'runAsLane'>, deps: {
  /** The assistant's workspace, where the identity lives; null while there is none. */
  workspaceId: () => string | null;
  /** The lane stops looking (the Companion is stopping). */
  stopped?: () => boolean;
}): CheckinLane {
  return {
    tick(scheduler, now) {
      if (deps.stopped?.()) return;
      sweepCheckinIdentity(scheduler, now, deps.workspaceId());
      if (checkinEngine() !== 'scheduler') {
        coordinator.lookAsLane(now);
        return;
      }
      void coordinator.tick();
      if (coordinator.laneSettled()) scheduler.releaseSettledCheckinClaims(now);
      const jobId = checkinIdentityJobId(LOCAL_AGENT_OWNER_ID);
      if (jobId && coordinator.laneHasWork(now)) scheduler.startCheckin(jobId, now);
    },
    async run(input) {
      return laneOutcome(await coordinator.runAsLane({ signal: input.signal, cancel: input.cancel }));
    },
  };
}
