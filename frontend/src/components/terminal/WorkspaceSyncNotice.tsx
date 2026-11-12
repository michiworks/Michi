import { useWorkspaceSyncNotices } from '../../state/workspaceSyncNotices';
import { Button } from '../ui/controls';

/**
 * One notice per workspace whose unsaved changes the backend keeps refusing
 * (see the command flush in state/workspacePersistence.ts). Retry sends them
 * again; Discard drops them and takes the backend's state back; Reload starts
 * this window over from the backend.
 */
export default function WorkspaceSyncNotice() {
  const notices = useWorkspaceSyncNotices();
  if (notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 px-3 pt-2" aria-label="Unsaved workspace changes">
      {notices.map((notice) => (
        <div
          key={notice.workspaceId}
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-[var(--ui-radius)] border border-line bg-surface px-3 py-2 text-[length:var(--fs-lg)] text-fg"
        >
          <p className="m-0 min-w-0 flex-1">
            <span className="text-danger">Changes to {notice.workspaceName} aren’t being saved.</span>{' '}
            <span className="text-fg-muted">
              {notice.kind === 'conflict' ? 'Still retrying. ' : ''}The server said: {notice.message}
            </span>
          </p>
          <Button size="sm" onClick={notice.retry}>Retry</Button>
          <Button size="sm" danger onClick={notice.discard}>Discard my unsaved changes</Button>
          <Button size="sm" onClick={() => window.location.reload()}>Reload from server</Button>
        </div>
      ))}
    </div>
  );
}
