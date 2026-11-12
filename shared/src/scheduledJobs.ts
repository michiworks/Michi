import type { ChatPermissionMode } from './chatPermissions';

/**
 * Scheduled Jobs: a prompt that the backend runs on a schedule without any
 * renderer attached. Each run is an ordinary durable chat turn, so the result
 * is opened like any other thread (a Scheduled-only job's, on the Scheduled page).
 */

export type ScheduledJobSchedule =
  /** Fixed interval measured from the previous run. */
  | { kind: 'every'; everySeconds: number }
  /** Standard 5-field cron expression evaluated in `timezone` (IANA). */
  | { kind: 'cron'; expression: string; timezone: string | null }
  /** One-shot run at an epoch-ms instant. */
  | { kind: 'at'; at: number };

/** fresh: every run opens a new thread. persistent: runs append to one thread. */
export type ScheduledJobSessionMode = 'fresh' | 'persistent';

/**
 * Where a run's thread shows. workspace: among the workspace's conversations.
 * scheduled: only on the Scheduled page, read-only, until the user moves it
 * to the workspace; Michi deletes runs past SCHEDULED_ONLY_RETENTION.
 */
export type ScheduledJobVisibility = 'workspace' | 'scheduled';

/**
 * What Michi keeps of a Scheduled-only job: a run's thread stays while it is
 * one of the job's latest `minRuns` runs, or one of its latest `maxRuns` runs
 * that started within `maxAgeMs`. A thread several runs share (One ongoing
 * thread) stays until none of them is kept; that thread is replaced by a new
 * one after `rotateAfterRuns` runs.
 */
export const SCHEDULED_ONLY_RETENTION = {
  maxRuns: 20,
  maxAgeMs: 7 * 24 * 3_600_000,
  minRuns: 5,
  rotateAfterRuns: 20,
} as const;

/** SCHEDULED_ONLY_RETENTION.maxAgeMs in whole days, as the retention text states it. */
export const SCHEDULED_ONLY_KEPT_DAYS = Math.round(SCHEDULED_ONLY_RETENTION.maxAgeMs / 86_400_000);

/** Settings › Background defaults (GET and PATCH /api/scheduled-jobs/settings). */
export interface ScheduledJobSettings {
  /** Thread mode for a new job that does not name one. */
  sessionMode: ScheduledJobSessionMode;
  /** An agent asks the user before it creates a job. Off by default; other changes always ask. */
  requireCreateApproval: boolean;
}

export type ScheduledJobRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted';

export type ScheduledJobRunTrigger = 'scheduled' | 'manual';

export interface ScheduledJobDto {
  id: string;
  workspaceId: string;
  name: string;
  prompt: string;
  schedule: ScheduledJobSchedule;
  /** null = the runtime configured in Settings at run time. */
  runtimeId: string | null;
  providerId: string | null;
  modelId: string | null;
  reasoning: string | null;
  permissionMode: ChatPermissionMode;
  sessionMode: ScheduledJobSessionMode;
  /** Absent from older backends: workspace. */
  visibility?: ScheduledJobVisibility;
  notify: boolean;
  enabled: boolean;
  /** Set after repeated failures; cleared by resuming the job. */
  autoPaused: boolean;
  timeoutSeconds: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: ScheduledJobRunStatus | null;
  lastError: string | null;
  consecutiveFailures: number;
  activeRunId: string | null;
  persistentNodeId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Internal opt-in consumer progress. null/absent means an ordinary job. */
  conversationCursor?: number | null;
}

export interface ScheduledJobRunDto {
  id: string;
  jobId: string;
  workspaceId: string;
  nodeId: string | null;
  treeId: string | null;
  trigger: ScheduledJobRunTrigger;
  status: ScheduledJobRunStatus;
  scheduledFor: number | null;
  startedAt: number;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
  /** The run's thread shows only in Scheduled (not moved to its workspace). Absent: false. */
  scheduledOnly?: boolean;
}

export interface ScheduledJobInput {
  workspaceId: string;
  name: string;
  prompt: string;
  schedule: ScheduledJobSchedule;
  runtimeId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  reasoning?: string | null;
  permissionMode?: ChatPermissionMode;
  sessionMode?: ScheduledJobSessionMode;
  visibility?: ScheduledJobVisibility;
  notify?: boolean;
  enabled?: boolean;
  timeoutSeconds?: number;
  /** Start consuming newly completed turns from now; false disables consumption. */
  conversationUpdates?: boolean;
}

export type ScheduledJobPatch = Partial<ScheduledJobInput>;

export interface ScheduledJobBlockedExecution {
  runId: string;
  jobId: string;
  workspaceId: string;
  reason: string;
  since: number;
  /** When it stops blocking without confirmation: its start plus the job's time limit plus a grace. Absent from older backends. */
  releasesAt?: number;
}

export interface ScheduledJobsSchedulerStatus {
  /** Unconfirmed execution lifetimes block data-directory-wide admission until confirmed stopped or releasesAt. */
  blockedExecutions?: ScheduledJobBlockedExecution[];
  /** False when another Michi process on the same data directory owns scheduling. */
  active: boolean;
  /** True when this backend runs as the always-on background service. */
  serviceMode: boolean;
  /** Default timezone for new cron schedules. */
  timezone: string;
}

export interface ScheduledJobsListResponse {
  jobs: ScheduledJobDto[];
  scheduler: ScheduledJobsSchedulerStatus;
}

export interface ScheduledJobPreviewResponse {
  valid: boolean;
  error?: string;
  nextRuns: number[];
}

/** SSE event name shared by the renderer background feed and the Electron notification feed. */
export const SCHEDULED_JOB_RUN_EVENT = 'scheduled_job_run';

export type ScheduledJobRunEventPhase = 'started' | 'finished' | 'attention';

export interface ScheduledJobRunEvent {
  phase: ScheduledJobRunEventPhase;
  runId: string;
  jobId: string;
  jobName: string;
  workspaceId: string;
  nodeId: string | null;
  treeId: string | null;
  status: ScheduledJobRunStatus;
  summary: string | null;
  error: string | null;
  /** Whether the job asked for a completion notification. */
  notify: boolean;
  /** What a blocked run is waiting for (phase=attention only). */
  attention?: 'approval' | 'input';
  /** The run's thread shows only in Scheduled: open it there, not in the workspace. */
  scheduledOnly?: boolean;
  at: number;
}

/**
 * SSE event on the renderer background feed when a job is created, edited or
 * deleted (from any window or by an agent tool), so open Scheduled views
 * refresh. Not sent to the Electron notification feed.
 */
export const SCHEDULED_JOBS_CHANGED_EVENT = 'scheduled_jobs_changed';

export interface ScheduledJobsChangedEvent {
  change: 'created' | 'updated' | 'deleted';
  jobId: string;
  workspaceId: string;
  at: number;
}

export function isScheduledJobsChangedEvent(value: unknown): value is ScheduledJobsChangedEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (event.change === 'created' || event.change === 'updated' || event.change === 'deleted')
    && typeof event.jobId === 'string'
    && typeof event.workspaceId === 'string';
}

export const SCHEDULED_JOB_LIMITS = {
  name: 120,
  prompt: 32_000,
  cronExpression: 200,
  minEverySeconds: 60,
  maxEverySeconds: 366 * 24 * 3600,
  minTimeoutSeconds: 60,
  maxTimeoutSeconds: 24 * 3600,
  defaultTimeoutSeconds: 30 * 60,
  maxJobs: 200,
  /** Consecutive failures that pause a job automatically. */
  autoPauseThreshold: 5,
  runHistoryPerJob: 50,
} as const;

/**
 * What a new job gets for a field it does not name. sessionMode applies only
 * while the user has not chosen a default in Settings › Background.
 */
export const SCHEDULED_JOB_DEFAULTS = {
  permissionMode: 'trust' as ChatPermissionMode,
  sessionMode: 'persistent' as ScheduledJobSessionMode,
  visibility: 'workspace' as ScheduledJobVisibility,
  notify: true,
  timeoutSeconds: SCHEDULED_JOB_LIMITS.defaultTimeoutSeconds,
};

export function isScheduledJobRunStatus(value: unknown): value is ScheduledJobRunStatus {
  return value === 'running' || value === 'succeeded' || value === 'failed'
    || value === 'cancelled' || value === 'timed_out' || value === 'interrupted';
}

export function isScheduledJobRunEvent(value: unknown): value is ScheduledJobRunEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (event.phase === 'started' || event.phase === 'finished' || event.phase === 'attention')
    && typeof event.runId === 'string'
    && typeof event.jobId === 'string'
    && typeof event.jobName === 'string'
    && typeof event.workspaceId === 'string'
    && (event.nodeId === null || typeof event.nodeId === 'string')
    && isScheduledJobRunStatus(event.status);
}
