import React from 'react';
import { toast } from 'sonner';
import { FolderInput, History, MessageSquare } from 'lucide-react';
import { SCHEDULED_ONLY_KEPT_DAYS, SCHEDULED_ONLY_RETENTION, type ScheduledJobDto, type ScheduledJobRunDto } from 'michi-shared';
import { Button } from '../../ui/controls';
import TPane from '../TPane';
import { useChatActions, useChatNode, useChatProjects } from '../../../state/chatStore';
import { usePrefs } from '../../../state/prefs';
import { useNow } from '../../../hooks/useNow';
import { useEmbeddedChatNode } from '../../../state/useEmbeddedChatNode';
import { getScheduledJobRun, moveScheduledRunToWorkspace } from '../../../services/api/scheduledJobs';
import { openScheduledHome, setScheduledCrumb } from './scheduledNav';
import { SCHEDULED_JOB_RUN_WINDOW_EVENT } from '../../../state/scheduledRunNotice';
import { StatusDot } from './ScheduledJobDetail';
import { RUN_STATUS_LABELS, formatDateTime, formatDuration } from './scheduleModel';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../config/backendConnections';
import { useVisiblePoll } from '../../../state/visiblePoll';

/** The run, refreshed while it changes (its lifecycle frames, and a poll while it runs). */
function useRun(runId: string, jobId: string) {
  const [run, setRun] = React.useState<ScheduledJobRunDto | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback((signal?: AbortSignal) => {
    getScheduledJobRun(runId, signal)
      .then((next) => { setRun(next); setError(null); })
      .catch((reason: unknown) => {
        if (signal?.aborted) return;
        setError(reason instanceof Error ? reason.message : 'Could not load the run');
      });
  }, [runId]);
  React.useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const onRun = (event: Event) => {
      const detail = (event as CustomEvent<{ jobId?: string }>).detail;
      if (detail?.jobId === jobId) load();
    };
    window.addEventListener(SCHEDULED_JOB_RUN_WINDOW_EVENT, onRun);
    return () => {
      controller.abort();
      window.removeEventListener(SCHEDULED_JOB_RUN_WINDOW_EVENT, onRun);
    };
  }, [jobId, load]);
  const running = run?.status === 'running';
  const poll = React.useCallback(() => load(), [load]);
  useVisiblePoll(poll, { intervalMs: 10_000, enabled: running, focus: false });
  return { run, setRun, error };
}

/**
 * One run of a job, on the Scheduled page, as a conversation reads anywhere
 * else: the thread at chat width, its title in the top bar. Where the
 * composer would be, a bar says how the run went; a Scheduled-only run is
 * read-only until it is moved to its workspace, where it can be continued.
 */
export function ScheduledRunPage({ job, runId, now: pageNow, onOpenJob }: {
  job: ScheduledJobDto;
  runId: string;
  now: number;
  /** The job's details and run history. */
  onOpenJob: () => void;
}) {
  const { run, setRun, error } = useRun(runId, job.id);
  // A running run's duration counts up each second; the page's clock is coarser.
  const running = run?.status === 'running';
  const tick = useNow(1_000, running);
  const now = running ? Math.max(tick, pageNow) : pageNow;
  const { prefs } = usePrefs();
  const { projects } = useChatProjects();
  const { revealBackendNode } = useChatActions();
  const [moving, setMoving] = React.useState(false);
  const descriptor = React.useMemo(() => run?.nodeId ? {
    backendConnectionId: LOCAL_BACKEND_CONNECTION_ID, workspaceId: run.workspaceId, treeId: run.treeId ?? '', nodeId: run.nodeId,
  } : null, [run?.nodeId, run?.workspaceId, run?.treeId]);
  // Loads the thread into the store when this window does not hold it yet.
  const thread = useEmbeddedChatNode(descriptor);
  // Held, it shows at once, like a pane: a running run's thread streams in
  // before its history page lands (the pane loads that itself).
  const node = useChatNode(run?.nodeId ?? '');
  const held = !!run?.nodeId && !!node && node.projectId === run.workspaceId;
  const workspaceName = projects.find((project) => project.id === (run?.workspaceId ?? job.workspaceId))?.name ?? 'its workspace';
  const title = node?.title?.trim() || job.name;

  // The top bar names the conversation, as it does for any other.
  React.useEffect(() => {
    setScheduledCrumb(title);
    return () => setScheduledCrumb(null);
  }, [title]);

  const openInWorkspace = async (target: ScheduledJobRunDto) => {
    if (!target.nodeId) return;
    if (await revealBackendNode(target.workspaceId, target.nodeId)) openScheduledHome();
    else toast.error('That thread is no longer available');
  };
  const move = async () => {
    if (!run || moving) return;
    setMoving(true);
    try {
      const moved = await moveScheduledRunToWorkspace(run.id);
      setRun(moved);
      // The store learns the thread is visible before it is revealed there.
      await thread.refreshWorkspace(moved.nodeId ?? undefined).catch(() => false);
      toast.success(`Moved to ${workspaceName}`);
      await openInWorkspace(moved);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not move the thread');
    } finally {
      setMoving(false);
    }
  };

  const width = prefs.singlePaneContentWidth;
  let body: React.ReactNode;
  if (error && !run) {
    body = <p className="sched-detail-error sched-run-page-message" role="alert">{error}</p>;
  } else if (!run) {
    body = <div className="sched-loading sched-run-page-message" role="status" aria-label="Loading the run"><span /><span /></div>;
  } else if (!run.nodeId) {
    body = (
      <div className="sched-run-page-empty">
        <MessageSquare size={26} aria-hidden="true" />
        <p>{run.error && run.status !== 'succeeded'
          ? run.error
          : `This run’s thread was removed. Michi keeps the latest ${SCHEDULED_ONLY_RETENTION.maxRuns} runs from the past ${SCHEDULED_ONLY_KEPT_DAYS} days, and always the latest ${SCHEDULED_ONLY_RETENTION.minRuns}.`}</p>
      </div>
    );
  } else if (held) {
    body = <TPane key={run.nodeId} nodeId={run.nodeId} embedded readOnly contentMaxWidth={width} />;
  } else if (thread.state === 'failed') {
    body = (
      <div className="sched-run-page-empty" role="status">
        <p>Couldn’t load this run’s thread.</p>
        <Button size="sm" variant="ghost" onClick={thread.retry}>Retry</Button>
      </div>
    );
  } else {
    body = <div className="sched-loading sched-run-page-message" role="status" aria-label="Loading the thread"><span /><span /></div>;
  }

  return (
    <section className="sched-run-page" aria-label={`${job.name} run`}>
      <div className="sched-run-page-thread">{body}</div>
      <div className="sched-run-page-bar" style={width != null ? { maxWidth: width } : undefined}>
        <div className="sched-run-page-bar-info">
          {run && (
            <p className="sched-run-page-status">
              <StatusDot status={run.status} />
              <span className="sched-run-title">{RUN_STATUS_LABELS[run.status]}</span>
              <span className="sched-run-meta">
                {formatDateTime(run.startedAt, now)} · {formatDuration(run.startedAt, run.finishedAt, now)}{run.trigger === 'manual' ? ' · manual' : ''}
              </span>
            </p>
          )}
          <p className="sched-run-page-note">
            {run?.nodeId && !run.scheduledOnly
              ? `In ${workspaceName}`
              : `Shown only in Scheduled · move it to ${workspaceName} to reply`}
          </p>
        </div>
        <div className="sched-run-page-actions">
          <Button size="sm" variant="ghost" onClick={onOpenJob} aria-label={`${job.name} details and runs`}>
            <History size={14} aria-hidden="true" />Runs
          </Button>
          {run?.nodeId && (run.scheduledOnly
            ? (
              <Button size="sm" variant="primary" onClick={() => { void move(); }} disabled={moving}
                title={`Show this thread among ${workspaceName}’s conversations, where you can continue it`}>
                <FolderInput size={14} aria-hidden="true" />{moving ? 'Moving…' : 'Move to workspace'}
              </Button>
            ) : (
              <Button size="sm" onClick={() => { void openInWorkspace(run); }}>
                <MessageSquare size={14} aria-hidden="true" />Open in workspace
              </Button>
            ))}
        </div>
      </div>
    </section>
  );
}
