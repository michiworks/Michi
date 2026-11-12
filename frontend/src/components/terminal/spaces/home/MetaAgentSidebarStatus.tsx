import type { FirstRunProgressDto } from 'michi-shared';
import './sidebarStatus.css';

/** First-read execution progress only; completed homes do not show reminders. */
export function WorkspaceFirstRunBadge({ run }: { run: FirstRunProgressDto | null | undefined }) {
  if (!run) return null;
  if (run.state === 'reading' || run.state === 'writing') {
    return <>
      <span className="agent-spinner" aria-hidden="true" />
      <span className="spaces-side-progress" aria-label={`Reading ${run.readCount} of ${run.total}`}>{run.readCount}/{run.total}</span>
    </>;
  }
  if (run.state === 'queued') return <span className="spaces-side-progress">Queued</span>;
  if (run.state === 'failed') return <span className="spaces-side-progress" data-tone="danger">Not written</span>;
  return null;
}
