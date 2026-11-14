import type { ChatMessage } from './chatTypes';

/**
 * Whether the thread's latest turn was sent by the scheduler (a scheduled job
 * or Space maintenance). Such runs report completion through their job's own
 * notify setting, so the generic "Streaming finished" notice must stay quiet,
 * including after a reload or on a feed that carries no scheduled-run events.
 */
export function latestTurnIsScheduled(messages: readonly ChatMessage[] | undefined): boolean {
  if (!messages) return false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return !!messages[i].scheduledJobId;
  }
  return false;
}

/**
 * Fired by the chat store for every scheduled run lifecycle frame, so open
 * Scheduled views refresh. What deserves a notification is the backend's
 * attention service's (scheduled_run records), not this event's.
 */
export const SCHEDULED_JOB_RUN_WINDOW_EVENT = 'michi:scheduled-job-run';

/** Fired by the chat store when a job is created, edited or deleted elsewhere. */
export const SCHEDULED_JOBS_CHANGED_WINDOW_EVENT = 'michi:scheduled-jobs-changed';
