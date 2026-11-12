import { useEffect, useMemo, useState } from 'react';
import type { ReviewPaneItem } from '../../state/paneItems';
import { useChatActions, useChatProjects } from '../../state/chatStore';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { useSideColumn } from './useSideColumn';
import { getElectron, type GitChangeEntry } from '../../lib/electronBridge';
import { workspaceRoots } from './FilesPane';
import { UnifiedDiff } from './diff/UnifiedDiff';
import { useWorkspaceDiff } from './diff/useWorkspaceDiff';

type ChangesState =
  | { phase: 'loading'; changes: GitChangeEntry[] }
  | { phase: 'loaded'; changes: GitChangeEntry[] }
  | { phase: 'error'; changes: GitChangeEntry[]; message: string };

export default function ReviewPane({ item }: { item: ReviewPaneItem }) {
  const { projects } = useChatProjects();
  const { focusPane } = useChatActions();
  const project = projects.find((candidate) => candidate.id === item.projectId);
  const roots = useMemo(() => workspaceRoots(project), [project]);
  const cwd = project?.cwd ?? roots[0] ?? '';
  const shellStyle = usePaneShellStyle(item.id);
  const side = useSideColumn('review-changes');
  const [changes, setChanges] = useState<ChangesState>({ phase: 'loading', changes: [] });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const diff = useWorkspaceDiff(item.projectId, selectedPath);

  useEffect(() => {
    let active = true;
    setChanges({ phase: 'loading', changes: [] });
    const electron = getElectron();
    if (!cwd || !electron?.listGitChanges) {
      setChanges({ phase: 'error', changes: [], message: 'Review is available in the desktop app for Git workspaces' });
      return () => { active = false; };
    }
    void electron.listGitChanges(cwd, roots)
      .then((next) => { if (active) setChanges({ phase: 'loaded', changes: next }); })
      .catch((error) => { if (active) setChanges({ phase: 'error', changes: [], message: error instanceof Error ? error.message : 'Unable to read Git changes' }); });
    return () => { active = false; };
  }, [cwd, roots]);

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleChanges = changes.changes.filter((change) => !normalizedFilter || change.path.toLocaleLowerCase().includes(normalizedFilter));

  return (
    <div data-pane-id={item.id} data-pane-kind="review" className="terminal-pane" onMouseDown={() => focusPane(item.id)} style={shellStyle}>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'grid', gridTemplateColumns: side.columns }}>
        <div style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ height: 36, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderBottom: '1px solid var(--term-line)', color: 'var(--term-mid)', fontSize: 'var(--fs-sm)', flexShrink: 0 }}>
            <span aria-hidden style={{ color: 'var(--term-digest)', fontWeight: 700 }}>±</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedPath ?? 'Working tree'}</span>
            {diff.phase === 'loaded' && diff.truncated ? <span style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-xs)' }}>truncated</span> : null}
          </div>
          <div className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: diff.phase === 'loaded' ? '10px 0 24px' : '20px 22px' }}>
            {diff.phase === 'empty' ? <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>Select a changed file to review</div> : null}
            {diff.phase === 'loading' ? <div style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>loading diff…</div> : null}
            {diff.phase === 'error' ? (
              <div style={{ color: 'var(--term-danger-text)', fontSize: 'var(--fs-sm)' }}>
                {diff.status === 404 ? 'No diff is available for this file' : diff.status ? `Request failed (${diff.status})` : diff.error instanceof Error ? diff.error.message : 'Failed to load diff'}
              </div>
            ) : null}
            {diff.phase === 'loaded' ? <UnifiedDiff diff={diff.diff} /> : null}
          </div>
        </div>
        <aside ref={side.columnRef} style={{ position: 'relative', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--term-line)' }}>
          <div style={{ height: 48, display: 'flex', alignItems: 'center', padding: '0 9px', borderBottom: '1px solid var(--term-line)' }}>
            <label className="ui-search ui-search--compact">
              <span aria-hidden>⌕</span>
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter changes…" aria-label="Filter changes" />
            </label>
          </div>
          <div className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 0 14px' }}>
            {changes.phase === 'loading' ? <div style={{ padding: '8px 11px', color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>reading Git status…</div> : null}
            {changes.phase === 'error' ? <div style={{ padding: '8px 11px', color: 'var(--term-danger-text)', fontSize: 'var(--fs-sm)' }}>{changes.message}</div> : null}
            {changes.phase === 'loaded' && changes.changes.length === 0 ? <div style={{ padding: '8px 11px', color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>Working tree is clean</div> : null}
            {visibleChanges.map((change) => (
              <button key={`${change.status}:${change.path}`} type="button" onClick={() => setSelectedPath(change.path)} title={change.path} style={{ width: '100%', minHeight: 29, display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr)', alignItems: 'center', gap: 3, padding: '3px 9px', border: 0, background: selectedPath === change.path ? 'var(--term-alt)' : 'transparent', color: selectedPath === change.path ? 'var(--term-fg)' : 'var(--term-mid)', cursor: 'pointer', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', textAlign: 'left' }}>
                <span style={{ color: 'var(--term-digest)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>{change.status}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{change.path}</span>
              </button>
            ))}
          </div>
          {side.handle}
        </aside>
      </div>
    </div>
  );
}
