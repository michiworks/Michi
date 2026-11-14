/**
 * The check-in lane's execution identity (unification D11, P6): one
 * `scheduled_jobs` row per owner, execution kind `maintenance`, in the
 * assistant's workspace, found through companion_checkin_jobs as automatic
 * memory's are through its cursors. Its configuration is fixed. The
 * maintenance coordinator never starts it (maintenanceExecutionHasWork), a
 * person cannot (scheduler.startNow), the Scheduled page does not list it, and
 * code from before P6 finds no work for it: no Pages configuration names it
 * and its workspace is a system one. Only the check-in lane starts it
 * (checkinLane.ts), and only while `companion:engine` is `scheduler`.
 *
 * The scheduler's admission keeps the lane apart (repository.claimRun): a
 * check-in claim takes neither the one maintenance slot nor one of the
 * maxConcurrentRuns, and an unconfirmed claim holds back only its own side.
 */

import type { ScheduledJobSchedule } from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { getDb } from '../db';
import { log } from '../logger';

/** What the identity is: fixed, and no control a person has changes it (requirePromptJob). */
export const CHECKIN_IDENTITY = Object.freeze({
  name: 'Michi check-ins',
  prompt: 'Michi check-in',
  everySeconds: 60,
  /** The runner's own 180 s, plus the minute the coordinator gives a turn to wind down (turnGuardMs). */
  timeoutSeconds: 240,
});

export function isCheckinIdentityJob(jobId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM companion_checkin_jobs WHERE job_id = ?').get(jobId);
}

export function checkinIdentityJobId(ownerUserId: string): string | null {
  const row = getDb().prepare(`SELECT c.job_id FROM companion_checkin_jobs c JOIN scheduled_jobs j ON j.id = c.job_id
    WHERE c.owner_user_id = ?`).get(ownerUserId) as { job_id: string } | undefined;
  return row?.job_id ?? null;
}

/** The scheduler's part the sweep uses. */
export interface CheckinIdentityScheduler {
  createMaintenanceExecution(raw: unknown, ownerUserId: string): { id: string };
  deleteJob(id: string): void;
}

/**
 * From each scheduler tick (the check-in lane's hook): the local owner gets its
 * identity in the assistant's workspace (`workspaceId`, null while there is
 * none yet), and again when its job went.
 */
export function sweepCheckinIdentity(scheduler: CheckinIdentityScheduler, now: number, workspaceId: string | null): void {
  const owner = LOCAL_AGENT_OWNER_ID;
  if (!workspaceId || checkinIdentityJobId(owner)) return;
  try {
    getDb().prepare('DELETE FROM companion_checkin_jobs WHERE owner_user_id = ?').run(owner);
    const job = scheduler.createMaintenanceExecution({
      workspaceId, name: CHECKIN_IDENTITY.name, prompt: CHECKIN_IDENTITY.prompt,
      schedule: { kind: 'every', everySeconds: CHECKIN_IDENTITY.everySeconds } satisfies ScheduledJobSchedule,
      runtimeId: null, providerId: null, modelId: null, reasoning: null,
      permissionMode: 'trust', sessionMode: 'fresh', notify: false, enabled: true,
      timeoutSeconds: CHECKIN_IDENTITY.timeoutSeconds, conversationUpdates: false,
    }, owner);
    const added = getDb().prepare('INSERT OR IGNORE INTO companion_checkin_jobs (owner_user_id, job_id, created_at) VALUES (?, ?, ?)')
      .run(owner, job.id, Math.floor(now));
    if (Number(added.changes) !== 1) scheduler.deleteJob(job.id);
  } catch (error) {
    log.warn('scheduler', 'the check-in identity was not made', { error: error instanceof Error ? error.message : String(error) });
  }
}
