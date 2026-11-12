import type { ChatPermissionMode, ScheduledJobSchedule, ScheduledJobSessionMode } from 'michi-shared';
import type { ToolCallState } from '../../state/chatTypes';
import { michiToolNamed, normalizeToolResultEnvelope } from '../../lib/turnPageReceipt';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../config/backendConnections';
import { describeSchedule, formatDateTime } from './scheduled/scheduleModel';
import { requestScheduledJobDetail } from './scheduled/scheduledNav';
import { ReceiptRow } from './ReceiptLedger';
import { navPageEvent } from '../../state/appEvents';

/** The job a create_scheduled_job call saved, as its result describes it (agents/scheduledJobTools.ts jobView). */
export interface CreatedScheduledJob {
  jobId: string;
  name: string;
  schedule: ScheduledJobSchedule | null;
  scheduleText: string | null;
  paused: boolean;
  nextRunAt: number | null;
  permissionMode: ChatPermissionMode | null;
  sessionMode: ScheduledJobSessionMode | null;
  /** Runs show only on the Scheduled page. */
  scheduledOnly: boolean;
  notify: boolean | null;
  timeoutSeconds: number | null;
  promptPreview: string | null;
  workspaceName: string | null;
}

const TOOL = ['create_scheduled_job'] as const;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function schedule(value: unknown): ScheduledJobSchedule | null {
  const raw = record(value);
  if (raw?.kind === 'every' && finite(raw.everySeconds) !== null) return { kind: 'every', everySeconds: raw.everySeconds as number };
  if (raw?.kind === 'at' && finite(raw.at) !== null) return { kind: 'at', at: raw.at as number };
  if (raw?.kind === 'cron' && text(raw.expression)) {
    return { kind: 'cron', expression: raw.expression as string, timezone: text(raw.timezone) };
  }
  return null;
}

/** The created job, or null for any other tool, a running or failed call, or a declined create. */
export function parseCreatedScheduledJob(tool: ToolCallState): CreatedScheduledJob | null {
  if (tool.status !== 'completed' || !michiToolNamed(tool, TOOL)) return null;
  const values = normalizeToolResultEnvelope(tool.output);
  for (let i = values.length - 1; i >= 0; i--) {
    const answer = record(values[i]);
    if (answer?.status !== 'created') continue;
    const job = record(answer.job);
    const jobId = text(job?.jobId);
    const name = text(job?.name);
    if (!job || !jobId || !name) return null;
    const permission = job.permissionMode;
    const session = job.sessionMode;
    const nextAt = text(record(job.nextRun)?.at);
    const nextRunAt = nextAt ? Date.parse(nextAt) : NaN;
    return {
      jobId,
      name,
      schedule: schedule(job.schedule),
      scheduleText: text(job.scheduleText),
      paused: job.state === 'paused',
      nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : null,
      permissionMode: permission === 'ask' || permission === 'trust' || permission === 'yolo' ? permission : null,
      sessionMode: session === 'fresh' || session === 'persistent' ? session : null,
      scheduledOnly: job.visibility === 'scheduled',
      notify: typeof job.notify === 'boolean' ? job.notify : null,
      timeoutSeconds: finite(job.timeoutSeconds),
      promptPreview: text(job.promptPreview) ?? text(job.prompt),
      workspaceName: text(record(job.workspace)?.name),
    };
  }
  return null;
}

const PERMISSION: Record<ChatPermissionMode, { name: string; text: string }> = {
  ask: { name: 'Ask', text: 'Ask · tool approvals wait for you' },
  trust: { name: 'Trust', text: 'Trust · tools run without asking' },
  yolo: { name: 'YOLO', text: 'YOLO · tools run without asking, with full access' },
};

const SESSION_TEXT: Record<ScheduledJobSessionMode, string> = {
  persistent: 'One ongoing thread',
  fresh: 'New thread',
};

function timeLimit(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h limit`;
  return `${Math.max(1, Math.round(seconds / 60))} min limit`;
}

const joined = (...parts: (string | null | false)[]) => parts.filter(Boolean).join(' · ') || null;

/** The row's note: when it runs and what it may do, the two things to check before it does. */
function scheduleNote(job: CreatedScheduledJob): string | null {
  const what = job.schedule ? describeSchedule(job.schedule) : job.scheduleText;
  return joined(job.paused ? (what ? `${what} · paused` : 'Paused') : what, job.permissionMode && PERMISSION[job.permissionMode].name);
}

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return <><dt>{label}</dt><dd>{value}</dd></>;
}

/**
 * A scheduled job a tool call created, as a row of the reply's receipts.
 * Creating may not ask the user first (Settings › Background), so this is
 * where they see what an agent scheduled: the row says when it runs and with
 * what permission, its details the rest. Jobs live on this computer's
 * backend, so View is offered only for local conversations.
 */
export function ScheduledJobRow({ job, backendConnectionId }: { job: CreatedScheduledJob; backendConnectionId?: string }) {
  const canOpen = !backendConnectionId || backendConnectionId === LOCAL_BACKEND_CONNECTION_ID;
  const open = () => {
    requestScheduledJobDetail(job.jobId);
    navPageEvent.dispatch({ page: 'scheduled' });
  };
  // A one-off job's schedule already names its time.
  const firstRun = !job.paused && job.nextRunAt !== null && job.schedule?.kind !== 'at' ? formatDateTime(job.nextRunAt) : null;
  const eachRun = joined(
    job.sessionMode && SESSION_TEXT[job.sessionMode],
    job.scheduledOnly && 'only in Scheduled',
    job.notify !== null && (job.notify ? 'notify when done' : 'no notification'),
    job.timeoutSeconds !== null && timeLimit(job.timeoutSeconds),
  );
  return (
    <ReceiptRow
      kind="scheduled-job"
      verb="Scheduled"
      object={job.name}
      meta={scheduleNote(job)}
      action={canOpen ? { label: 'View', onClick: open } : null}
      detailsName="job details"
      details={(
        <dl className="receipt-row__facts">
          <Fact label="Workspace" value={job.workspaceName} />
          <Fact label="First run" value={firstRun} />
          <Fact label="Permissions" value={job.permissionMode && PERMISSION[job.permissionMode].text} />
          <Fact label="Each run" value={eachRun} />
          <Fact label="Prompt" value={job.promptPreview && `“${job.promptPreview}”`} />
        </dl>
      )}
    />
  );
}
