import React, { useMemo } from 'react';
import { Clock, Loader2, Sparkles } from 'lucide-react';
import { useChatProjects } from '../../../state/chatStore';
import { useCompanionName } from '../../../state/companion/companionName';
import { useScheduledJobs } from '../scheduled/useScheduledJobs';
import { describeSchedule } from '../scheduled/scheduleModel';
import { closeMetaAgentDetail, openMetaAgentDetail, useMetaAgentDetailOpen } from '../scheduled/metaAgent/metaAgentNav';
import { pagesUpkeepTitle } from '../scheduled/metaAgent/metaAgentCopy';
import { META_AGENT_PAGE_POLL_MS, useMetaAgentOverview, type MetaAgentOverviewLoad } from '../../../state/metaAgent/useMetaAgentOverview';
import { useMetaAgentSnapshot } from '../../../state/metaAgent/useMetaAgent';
import { META_AGENT_ROW_WORD, metaAgentStatus } from '../../../state/metaAgent/metaAgentStatus';
import type { MetaAgentInfo } from '../../../services/api/metaAgent';
import { SidebarScroller } from '../SidebarScroller';

function rowKeys(action: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    action();
  };
}

/** The system row's sub-line: what Pages upkeep, the background maintenance, is doing now. */
function systemSubline(load: MetaAgentOverviewLoad, info: MetaAgentInfo | null): string {
  if (load.kind === 'loading') return 'Checks every 60 s';
  if (load.kind !== 'ready') return load.kind === 'unavailable' ? 'Not set up yet' : 'Status unavailable';
  const { cursors } = load.overview;
  // The same status the Spaces sidebar, the Home and the detail page read.
  const word = META_AGENT_ROW_WORD[metaAgentStatus({ info, overview: load.overview }).kind];
  if (word) return word.text;
  if (cursors.length === 0) return 'Running · no workspace yet';
  const waiting = cursors.filter((cursor) => cursor.state === 'next').length;
  return waiting > 0 ? `Running · ${waiting} need${waiting === 1 ? 's' : ''} reading`
    : `Running · ${cursors.length} ${cursors.length === 1 ? 'workspace' : 'workspaces'}`;
}

/**
 * Scheduled area sidebar: the system task "<name> · Pages upkeep" pinned
 * first, then every ordinary job. The per-workspace managed maintenance jobs
 * are that one system task, so they are not listed again.
 */
export function ScheduledSidebar({ selectedJobId, onSelectJob, onNavigate, systemTask }: {
  selectedJobId: string | null;
  onSelectJob: (jobId: string) => void;
  /** After a row opened its page in the main column. */
  onNavigate?: () => void;
  /** The Pages upkeep task; a placeholder row until it exists. */
  systemTask?: React.ReactNode;
}) {
  const { jobs, loading, unavailable } = useScheduledJobs();
  const descriptionId = React.useId();
  const { projects } = useChatProjects();
  const overview = useMetaAgentOverview(META_AGENT_PAGE_POLL_MS);
  const agent = useMetaAgentSnapshot();
  const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name] as const)), [projects]);
  const managed = overview.kind === 'ready' ? overview.overview.managedJobIds : undefined;
  const sorted = useMemo(() => {
    const hidden = new Set(managed ?? []);
    return jobs.filter((job) => !hidden.has(job.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [jobs, managed]);
  const metaAgentOpen = useMetaAgentDetailOpen();
  const upkeep = pagesUpkeepTitle(useCompanionName());
  const openMetaAgent = () => { openMetaAgentDetail(); onNavigate?.(); };
  return (
    <div className="area-side scheduled-side" aria-label="Scheduled jobs">
      <SidebarScroller className="area-side__grow">
        <div className="area-side__section">Scheduled</div>
        {systemTask ?? (
          <div className="area-side__item" data-pinned="">
            <div className="area-side__row is-strong" role="button" tabIndex={0} aria-current={metaAgentOpen ? 'true' : undefined}
              aria-label={`${upkeep} System`} aria-describedby={`${descriptionId}-system`}
              onClick={openMetaAgent} onKeyDown={rowKeys(openMetaAgent)}>
              <Sparkles size={15} strokeWidth={1.5} aria-hidden="true" />
              <span className="area-side__text">
                <span className="area-side__label">{upkeep}</span>
                <span className="area-side__sub" id={`${descriptionId}-system`}>{systemSubline(overview, agent.info)}</span>
              </span>
              <span className="area-side__tag">System</span>
            </div>
          </div>
        )}
        {loading && jobs.length === 0 && <div className="area-side__note" role="status">Loading jobs…</div>}
        {unavailable && <div className="area-side__note">This Michi server does not run scheduled jobs.</div>}
        {sorted.map((job) => {
          const current = !metaAgentOpen && job.id === selectedJobId;
          const select = () => { closeMetaAgentDetail(); onSelectJob(job.id); onNavigate?.(); };
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
