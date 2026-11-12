import { ModalShell } from '../ui/ModalShell';
import { UnifiedDiff } from './diff/UnifiedDiff';
import { useWorkspaceDiff } from './diff/useWorkspaceDiff';

export interface DiffModalProps {
  /** Workspace whose cwd the diff is resolved against. */
  workspaceId: string;
  /** Workspace-relative file path. Shown as the modal title. */
  filePath: string;
  onClose: () => void;
}

/**
 * Read-only unified-diff viewer on the shared ModalShell; fetches
 * the file's workspace diff on mount. Escape is captured so
 * TerminalShell's own Escape (clear selection / leave fullscreen pages)
 * does not also fire in the same keypress.
 */
export function DiffModal({ workspaceId, filePath, onClose }: DiffModalProps) {
  const state = useWorkspaceDiff(workspaceId, filePath);

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Diff"
      titleGlyph="±"
      aria-label={`diff: ${filePath}`}
      width={880}
      maxHeight="84vh"
      captureEscape
      headerTrailing={
        <>
          <span
            title={filePath}
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 'var(--fs-md)',
              color: 'var(--term-fg)',
            }}
          >
            {filePath}
          </span>
          {state.phase === 'loaded' && state.truncated && (
            <span style={{ color: 'var(--term-muted)', flexShrink: 0, fontSize: 'var(--fs-xs)' }}>truncated at 100KB</span>
          )}
        </>
      }
    >
        <div className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 0' }}>
          {state.phase === 'loading' && (
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', padding: '12px' }}>loading diff…</div>
          )}
          {state.phase === 'error' && (
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-danger-text)', padding: '12px' }}>
              ⚠ {state.status === 404 ? 'no diff available for this file' : state.status ? `request failed (${state.status})` : 'failed to fetch diff'}
            </div>
          )}
          {state.phase === 'loaded' && <UnifiedDiff diff={state.diff} wrap />}
        </div>
    </ModalShell>
  );
}
