import {
  SCHEDULED_JOB_RUN_EVENT,
  SCHEDULED_JOBS_CHANGED_EVENT,
  type ScheduledJobRunEvent,
  type ScheduledJobsChangedEvent,
} from 'michi-shared';

/** One SSE frame for a scheduled run event. */
export function encodeScheduledJobEvent(event: ScheduledJobRunEvent): string {
  return `event: ${SCHEDULED_JOB_RUN_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** One SSE frame for a job created, edited or deleted. */
export function encodeScheduledJobsChangedEvent(event: ScheduledJobsChangedEvent): string {
  return `event: ${SCHEDULED_JOBS_CHANGED_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface ScheduledJobEventSubscriber {
  send(event: ScheduledJobRunEvent): void;
  /** Job definition changes; only renderer feeds subscribe to these. */
  sendChange?(event: ScheduledJobsChangedEvent): void;
}

/**
 * In-process fan-out for scheduled run lifecycle events: the renderer
 * background feeds, and the attention service, which alone decides the
 * notifications they deserve (services/attention, observeScheduledRun).
 */
export class ScheduledJobEventBus {
  private readonly subscribers = new Set<ScheduledJobEventSubscriber>();

  subscribe(subscriber: ScheduledJobEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }

  publish(event: ScheduledJobRunEvent): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.send(event);
      } catch {
        // One broken stream must not stop the others.
      }
    }
  }

  publishChange(event: ScheduledJobsChangedEvent): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.sendChange?.(event);
      } catch {
        // One broken stream must not stop the others.
      }
    }
  }
}

export const scheduledJobEvents = new ScheduledJobEventBus();
