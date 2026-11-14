import React, { useMemo } from 'react';
import { Clock, Loader2 } from 'lucide-react';
import { useChatProjects } from '../../../state/chatStore';
import { useScheduledJobs } from '../scheduled/useScheduledJobs';
import { describeSchedule } from '../scheduled/scheduleModel';
import { useMetaAgentOverview } from '../../../state/metaAgent/useMetaAgentOverview';
import { SidebarScroller } from '../SidebarScroller';

function rowKeys(action: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    action();
  };
}

/**
 * Scheduled area sidebar: every ordinary job. Pages upkeep's per-workspace
 * managed maintenance jobs run when conversations go quiet, not on a
 * schedule, so they are not listed (Q8).
 */
export function ScheduledSidebar({ selectedJobId, onSelectJob, onNavigate }: {
  selectedJobId: string | null;
  onSelectJob: (jobId: string) => void;
  /** After a row opened its page in the main column. */
  onNavigate?: () => void;
}) {
  const { jobs, loading, unavailable } = useScheduledJobs();
  const descriptionId = React.useId();
  const { projects } = useChatProjects();
  const overview = useMetaAgentOverview();
  const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name] as const)), [projects]);
  const managed = overview.kind === 'ready' ? overview.overview.managedJobIds : undefined;
  const sorted = useMemo(() => {
    const hidden = new Set(managed ?? []);
    return jobs.filter((job) => !hidden.has(job.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [jobs, managed]);
  return (
    <div className="area-side scheduled-side" aria-label="Scheduled jobs">
      <SidebarScroller className="area-side__grow">
        <div className="area-side__section">Scheduled</div>
        {loading && jobs.length === 0 && <div className="area-side__note" role="status">Loading jobs…</div>}
        {unavailable && <div className="area-side__note">This Michi server does not run scheduled jobs.</div>}
        {sorted.map((job) => {
          const current = job.id === selectedJobId;
          const select = () => { onSelectJob(job.id); onNavigate?.(); };
          return (
            <div className="area-side__item" key={job.id}>
              <div className="area-side__row is-strong" role="button" tabIndex={0} aria-current={current ? 'true' : undefined} onClick={select} onKeyDown={rowKeys(select)}
                aria-label={job.name} aria-describedby={`${descriptionId}-${job.id}`}>
                {job.activeRunId
                  ? <Loader2 size={15} strokeWidth={1.5} className="area-side__spin" aria-hidden="true" />
                  : <Clock size={15} strokeWidth={1.5} aria-hidden="true" />}
                <span className="area-side__text">
                  <span className="area-side__label">{job.name}</span>
                  <span className="area-side__sub" id={`${descriptionId}-${job.id}`}>{describeSchedule(job.schedule)}{names.get(job.workspaceId) ? ` · ${names.get(job.workspaceId)}` : ''}</span>
                </span>
              </div>
            </div>
          );
        })}
      </SidebarScroller>
    </div>
  );
}
