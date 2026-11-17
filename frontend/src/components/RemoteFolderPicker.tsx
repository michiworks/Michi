import { useEffect, useId, useRef, useState } from 'react';
import { browseRemoteDirectory, type RemoteDirectory } from '../services/api/backendConnections';
import { Button } from './ui/controls';
import { ChevronRightIcon, FolderIcon } from './terminal/icons';
import { isImeComposing } from '../lib/ime';
import './RemoteConnection.css';

export function RemoteFolderPicker({ connectionId, onSelect }: {
  connectionId: string; onSelect: (path: string) => void;
}) {
  const pathInputId = useId();
  const [path, setPath] = useState('~');
  const [location, setLocation] = useState({ path: '~', revision: 0 });
  const [directory, setDirectory] = useState<RemoteDirectory | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<HTMLDivElement>(null);
  /** Where focus goes once a folder loads, if the control that navigated lost it. */
  const refocusRef = useRef<HTMLElement | 'entries' | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void browseRemoteDirectory(connectionId, location.path, controller.signal).then(result => {
      if (!controller.signal.aborted) { setDirectory(result); setPath(result.path); }
    }).catch(failure => {
      if (!controller.signal.aborted) setError((failure as Error).message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [connectionId, location]);
  const navigate = (nextPath: string) => {
    // A folder unmounts and the field and Go disable while the folder loads:
    // a folder hands focus to the new list, the field or Go take it back.
    const active = document.activeElement;
    refocusRef.current = active instanceof HTMLElement && pickerRef.current?.contains(active)
      ? (entriesRef.current?.contains(active) ? 'entries' : active)
      : null;
    setLoading(true); setError(''); setDirectory(null);
    setLocation(previous => ({ path: nextPath, revision: previous.revision + 1 }));
  };
  useEffect(() => {
    const target = refocusRef.current;
    if (loading || !target) return;
    refocusRef.current = null;
    if (document.activeElement !== document.body) return;
    const next = target === 'entries' || !target.isConnected
      ? entriesRef.current?.querySelector<HTMLElement>('button:not(:disabled)') ?? pickerRef.current?.querySelector('input')
      : target;
    next?.focus();
  }, [loading]);

  return <div ref={pickerRef} className="remote-folder-picker" aria-busy={loading}>
    <label className="remote-folder-picker__label" htmlFor={pathInputId}>Choose a remote folder</label>
    <div className="remote-folder-picker__entry">
      <input className="ui-input" id={pathInputId} aria-label="Browse remote folder" value={path} disabled={loading}
        spellCheck={false} autoCapitalize="none" autoCorrect="off" onChange={event => setPath(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !isImeComposing(event)) { event.preventDefault(); navigate(path); } }} />
      <Button onClick={() => navigate(path)} disabled={loading}>Go</Button>
    </div>
    {loading && <div role="status" className="remote-folder-picker__status">Loading remote folders…</div>}
    {error && <div role="alert" className="remote-connection-notice" data-tone="error">{error}</div>}
    <div ref={entriesRef} className="remote-folder-picker__entries">
      {directory?.parent && <Button variant="ghost" size="sm" disabled={loading} onClick={() => navigate(directory.parent!)}>↑ Parent folder</Button>}
      {directory?.entries.map(entry => <Button variant="ghost" key={entry.path} disabled={loading}
        onClick={() => navigate(entry.path)} aria-label={`${entry.name} /`}>
        <FolderIcon />{entry.name}<ChevronRightIcon />
      </Button>)}
      {directory && !loading && directory.entries.length === 0 && <span className="remote-folder-picker__empty">No subfolders</span>}
    </div>
    {directory && <Button variant="primary" disabled={loading || !!error} onClick={() => onSelect(directory.path)}>Use this folder</Button>}
  </div>;
}
