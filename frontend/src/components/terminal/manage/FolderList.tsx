import { useState } from 'react';
import { toast } from 'sonner';
import { getElectron } from '../../../lib/electronBridge';
import { appendFolders, FOLDER_OVERLAP_MESSAGE, MAX_WORKSPACE_FOLDERS, pathBasename } from '../../../lib/workspaceFolders';
import type { FolderEntry } from '../../../state/chatTypes';
import { InlineRenameInput } from '../../ui/InlineRenameInput';
import { Button } from '../../ui/controls';
import { HoverTip } from '../../ui/Popover';
import { CloseIcon, FolderIcon, LockIcon } from '../icons';
import './manage.css';

interface Props {
  folders: FolderEntry[];
  projectId: string;
  remote?: boolean;
  onAddFolder: (projectId: string, path: string, label?: string) => void;
  onRemoveFolder: (projectId: string, folderId: string) => void;
  onUpdateLabel: (projectId: string, folderId: string, label: string) => void;
}

export default function FolderList({
  folders,
  projectId,
  remote = false,
  onAddFolder,
  onRemoveFolder,
  onUpdateLabel,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [remotePath, setRemotePath] = useState('');

  const handleAdd = async () => {
    if (folders.length >= MAX_WORKSPACE_FOLDERS) {
      toast.error(`Maximum ${MAX_WORKSPACE_FOLDERS} folders reached`);
      return;
    }
    if (remote) {
      const path = remotePath.trim();
      if (!path) {
        toast.error('Enter an absolute path on the remote server');
        return;
      }
      onAddFolder(projectId, path, pathBasename(path));
      setRemotePath('');
      return;
    }
    const electron = getElectron();

    // Prefer multi-select picker when available
    if (electron?.chooseFolders) {
      try {
        const result = await electron.chooseFolders();
        if (result.canceled || result.folders.length === 0) return;
        // The store's addFolder checks each one again.
        const { added, skipped, limitHit } = appendFolders(folders, result.folders);
        for (const picked of added) onAddFolder(projectId, picked.path, picked.name);
        for (const _skipped of skipped) toast.error(FOLDER_OVERLAP_MESSAGE);
        if (limitHit) toast.error(`Maximum ${MAX_WORKSPACE_FOLDERS} folders reached — some selections were skipped`);
      } catch (err) {
        toast.error(`Failed to add folder: ${(err as Error).message}`);
      }
      return;
    }

    // Fallback: single-select chooseFolder (older Electron builds)
    if (electron?.chooseFolder) {
      try {
        const result = await electron.chooseFolder();
        if (!result.canceled && result.path) {
          onAddFolder(projectId, result.path, result.name);
        }
      } catch (err) {
        toast.error(`Failed to add folder: ${(err as Error).message}`);
      }
      return;
    }

    // Browser fallback: showDirectoryPicker
    try {
      const handle = await (window as unknown as { showDirectoryPicker: () => Promise<{ name: string }> })
        .showDirectoryPicker();
      if (handle?.name) {
        toast.info('Browser mode: folder path may be incomplete. Use the desktop app for full path access.');
        onAddFolder(projectId, handle.name);
      }
    } catch {
      // User cancelled
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      {remote && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <input
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            placeholder="/remote/path"
            aria-label="Remote folder path"
            style={{ flex: 1, minWidth: 0, border: '1px solid var(--term-line)', background: 'var(--term-alt)', color: 'var(--term-fg)', padding: '5px 7px', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}
          />
          <Button size="sm" onClick={() => { void handleAdd(); }}>
            add server path
          </Button>
        </div>
      )}
      {folders.map((f, idx) => (
        <div
          key={f.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 0',
            borderBottom: idx < folders.length - 1 ? '1px solid var(--term-line)' : undefined,
          }}
        >
          {/* Lock icon for first (cwd) folder */}
          {idx === 0 ? (
            <LockIcon size="sm" aria-label="locked" style={{ flexShrink: 0, color: 'var(--term-muted)' }} />
          ) : (
            <span style={{ width: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <FolderIcon size="sm" aria-label="folder" style={{ flexShrink: 0, color: 'var(--term-muted)' }} />
            </span>
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            {editingId === f.id ? (
              <InlineRenameInput
                autoFocus
                aria-label="Folder name"
                value={f.label || pathBasename(f.path)}
                onCommit={(label) => onUpdateLabel(projectId, f.id, label)}
                onEnd={() => setEditingId(null)}
                style={{
                  width: '100%',
                  fontSize: 'var(--fs-md)',
                  fontFamily: 'var(--ui-font)',
                  background: 'var(--term-alt)',
                  // Mounted only while it holds focus: the accent border is its focus cue.
                  border: '1px solid var(--term-accent)',
                  color: 'var(--term-fg)',
                  padding: '1px 4px',
                  outline: 'none',
                }}
              />
            ) : (
              <>
                {idx > 0 ? (
                  <button type="button" className="manage-folder__name" title="Click to rename" onClick={() => setEditingId(f.id)}>
                    {f.label || pathBasename(f.path)}
                  </button>
                ) : (
                  <div className="manage-folder__name">
                    {f.label || pathBasename(f.path)}
                    <span style={{
                      fontSize: 'var(--fs-xs)',
                      color: 'var(--term-muted)',
                      marginLeft: 6,
                      fontWeight: 400,
                    }}>
                      (working directory)
                    </span>
                  </div>
                )}
                <div
                  style={{
                    fontSize: 'var(--fs-sm)',
                    color: 'var(--term-muted)',
                    fontFamily: 'var(--font-mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={f.path}
                >
                  {f.path}
                </div>
              </>
            )}
          </div>

          {/* Delete button (not for index 0) */}
          {idx > 0 && editingId !== f.id && (
            <HoverTip label="Remove folder">
              <button
                type="button"
                className="t-icon-btn manage-icon-btn"
                onClick={() => onRemoveFolder(projectId, f.id)}
                aria-label="Remove folder"
                style={{ flexShrink: 0 }}
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </HoverTip>
          )}
        </div>
      ))}

      {/* Add folder button */}
      {!remote && <Button
        className="manage-folder__add"
        onClick={() => { void handleAdd(); }}
        disabled={folders.length >= MAX_WORKSPACE_FOLDERS}
      >
        + Add folder{folders.length >= MAX_WORKSPACE_FOLDERS ? ` (limit: ${MAX_WORKSPACE_FOLDERS})` : ''}
      </Button>}
    </div>
  );
}
