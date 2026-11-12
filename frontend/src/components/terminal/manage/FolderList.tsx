import { useState } from 'react';
import { toast } from 'sonner';
import { getElectron } from '../../../lib/electronBridge';
import { appendFolders, FOLDER_OVERLAP_MESSAGE, MAX_WORKSPACE_FOLDERS, pathBasename } from '../../../lib/workspaceFolders';
import type { FolderEntry } from '../../../state/chatTypes';
import { InlineRenameInput } from '../../ui/InlineRenameInput';

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
          <button type="button" onClick={() => { void handleAdd(); }} style={{ border: '1px solid var(--term-line)', background: 'transparent', color: 'var(--term-mid)', padding: '4px 8px', cursor: 'pointer', fontSize: 'var(--fs-sm)' }}>
            add server path
          </button>
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
            <LockIcon />
          ) : (
            <span style={{ width: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <FolderIcon />
            </span>
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            {editingId === f.id ? (
              <InlineRenameInput
                autoFocus
                value={f.label || pathBasename(f.path)}
                onCommit={(label) => onUpdateLabel(projectId, f.id, label)}
                onEnd={() => setEditingId(null)}
                style={{
                  width: '100%',
                  fontSize: 'var(--fs-md)',
                  fontFamily: 'var(--ui-font)',
                  background: 'var(--term-alt)',
                  border: '1px solid var(--term-line)',
                  color: 'var(--term-fg)',
                  padding: '1px 4px',
                  outline: 'none',
                }}
              />
            ) : (
              <>
                <div
                  style={{
                    fontSize: 'var(--fs-md)',
                    fontWeight: 500,
                    color: 'var(--term-fg)',
                    fontFamily: 'var(--ui-font)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    cursor: idx > 0 ? 'pointer' : 'default',
                  }}
                  onClick={() => idx > 0 && setEditingId(f.id)}
                  title={idx > 0 ? 'Click to rename' : undefined}
                >
                  {f.label || pathBasename(f.path)}
                  {idx === 0 && (
                    <span style={{
                      fontSize: 'var(--fs-xs)',
                      color: 'var(--term-muted)',
                      marginLeft: 6,
                      fontWeight: 400,
                    }}>
                      (working directory)
                    </span>
                  )}
                </div>
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
            <button
              type="button"
              onClick={() => onRemoveFolder(projectId, f.id)}
              title="Remove folder"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--term-muted)',
                cursor: 'pointer',
                fontSize: 'var(--fs-xl)',
                lineHeight: 1,
                padding: '2px 4px',
                flexShrink: 0,
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}

      {/* Add folder button */}
      {!remote && <button
        type="button"
        onClick={() => { void handleAdd(); }}
        disabled={folders.length >= MAX_WORKSPACE_FOLDERS}
        style={{
          marginTop: 8,
          width: '100%',
          padding: '5px 10px',
          fontFamily: 'var(--ui-font)',
          fontSize: 'var(--fs-sm)',
          color: folders.length >= MAX_WORKSPACE_FOLDERS ? 'var(--term-muted)' : 'var(--term-fg)',
          background: 'transparent',
          border: '1px dashed var(--term-line)',
          cursor: folders.length >= MAX_WORKSPACE_FOLDERS ? 'default' : 'pointer',
          opacity: folders.length >= MAX_WORKSPACE_FOLDERS ? 0.5 : 1,
        }}
      >
        + Add folder{folders.length >= MAX_WORKSPACE_FOLDERS ? ` (limit: ${MAX_WORKSPACE_FOLDERS})` : ''}
      </button>}
    </div>
  );
}

function LockIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="var(--term-muted)"
      strokeWidth="1.4"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-label="locked"
    >
      <rect x="3" y="7" width="10" height="7" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="var(--term-muted)"
      strokeWidth="1.3"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-label="folder"
    >
      <path d="M2 4h4l1.5 1.5H14v8H2z" />
    </svg>
  );
}
