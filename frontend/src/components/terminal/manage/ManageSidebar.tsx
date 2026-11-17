import React from 'react';
import { estimateTokens } from 'michi-shared';
import type { Project } from '../../../state/chatTypes';
import type { BulkActions } from './ChatTreeList';
import FolderList from './FolderList';
import { Button } from '../../ui/controls';
import { EditIcon } from '../icons';
import { isLocalProject } from '../../../config/backendConnections';

interface Props {
  workspace: Project;
  /** Below the lists in one column (a phone) instead of beside them. */
  stacked?: boolean;
  onSaveInstructions: (text: string) => void;
  onAddFolder: (projectId: string, path: string, label?: string) => void;
  onRemoveFolder: (projectId: string, folderId: string) => void;
  onUpdateFolderLabel: (projectId: string, folderId: string, label: string) => void;
  manageMode: boolean;
  onToggleManageMode: () => void;
  bulkActions?: BulkActions;
  hasArchivedSelection?: boolean;
}

const panelStyle: React.CSSProperties = {
  background: 'var(--term-surface)',
  border: '1px solid var(--term-line)',
  padding: '16px 18px 14px',
  marginBottom: 14,
};

const panelHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const panelTitle: React.CSSProperties = {
  fontFamily: 'var(--ui-font)',
  fontSize: 'var(--fs-2xl)',
  lineHeight: 1.3,
  fontWeight: 500,
  color: 'var(--term-fg)',
  margin: 0,
};

const subtleBadge: React.CSSProperties = {
  fontFamily: 'var(--ui-font)',
  fontSize: 'var(--fs-sm)',
  color: 'var(--term-muted)',
  padding: '2px 6px',
  background: 'var(--term-alt)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

const bodyText: React.CSSProperties = {
  fontFamily: 'var(--ui-font)',
  fontSize: 'var(--fs-lg)',
  lineHeight: 1.55,
  color: 'var(--term-mid, var(--term-fg))',
};

const faintMeta: React.CSSProperties = {
  fontFamily: 'var(--ui-font)',
  fontSize: 'var(--fs-sm)',
  color: 'var(--term-muted)',
  marginTop: 2,
};

export default function ManageSidebar({
  workspace,
  stacked = false,
  onSaveInstructions,
  onAddFolder,
  onRemoveFolder,
  onUpdateFolderLabel,
  manageMode,
  onToggleManageMode,
  bulkActions,
  hasArchivedSelection,
}: Props) {
  const saved = workspace.instructions ?? '';
  const [instr, setInstr] = React.useState(saved);
  // Reset the draft whenever we navigate to a different workspace, or the
  // hydrated value changes underneath us (e.g. another tab saved it).
  React.useEffect(() => {
    setInstr(saved);
  }, [workspace.id, saved]);
  const dirty = instr !== saved;

  return (
    <aside
      aria-label="Workspace settings"
      style={stacked ? {
        padding: '8px 16px calc(40px + env(safe-area-inset-bottom, 0px))',
        minWidth: 0,
      } : {
        padding: '24px 36px 60px 8px',
        overflowY: 'auto',
        minHeight: 0,
      }}
    >
      <div style={panelStyle}>
        <div style={panelHeader}>
          <h3 style={panelTitle}>Instructions</h3>
          <span style={{ flex: 1 }} />
          <EditIcon style={{ color: 'var(--term-muted)' }} />
        </div>
        <textarea
          rows={9}
          value={instr}
          onChange={(e) => setInstr(e.target.value)}
          placeholder="System prompt for this workspace…"
          style={{
            width: '100%',
            border: 'none',
            background: 'transparent',
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-lg)',
            lineHeight: 1.55,
            color: 'var(--term-mid, var(--term-fg))',
            padding: 0,
            marginTop: 10,
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            ...faintMeta,
            marginTop: 8,
          }}
        >
          <span>
            {instr.length} chars · ~{estimateTokens(instr)} tokens
            {dirty && (
              <span style={{ color: 'var(--term-accent-text)', marginLeft: 6 }}>· unsaved</span>
            )}
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="primary" size="sm" onClick={() => onSaveInstructions(instr)} disabled={!dirty}>
            Save
          </Button>
        </div>
      </div>
      {/* Folders panel */}
      <div style={panelStyle}>
        <div style={panelHeader}>
          <h3 style={panelTitle}>Folders</h3>
          <span style={{ flex: 1 }} />
          <span style={subtleBadge}>{(workspace.folders ?? []).length}</span>
        </div>
        <FolderList
          folders={workspace.folders ?? []}
          projectId={workspace.id}
          remote={!isLocalProject(workspace)}
          onAddFolder={onAddFolder}
          onRemoveFolder={onRemoveFolder}
          onUpdateLabel={onUpdateFolderLabel}
        />
      </div>
      {/* Manage panel */}
      <div style={panelStyle}>
        <div style={panelHeader}>
          <h3 style={panelTitle}>Manage</h3>
        </div>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!manageMode ? (
            <Button onClick={onToggleManageMode} style={{ width: '100%', justifyContent: 'flex-start' }}>
              ☐ Select threads…
            </Button>
          ) : (
            <>
              <div style={{ ...bodyText, fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--term-fg)' }}>
                {bulkActions?.treeSelection.size ?? 0} selected
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <SidebarManageBtn label="Select all" onClick={() => bulkActions?.selectAllTrees()} />
                {(bulkActions?.treeSelection.size ?? 0) > 0 && (
                  <>
                    {hasArchivedSelection ? (
                      <SidebarManageBtn label="Unarchive" onClick={() => bulkActions?.bulkUnarchiveTrees()} />
                    ) : (
                      <SidebarManageBtn label="Archive" onClick={() => bulkActions?.bulkArchiveTrees()} />
                    )}
                    <SidebarManageBtn label="Delete" danger onClick={() => bulkActions?.bulkDeleteTrees()} />
                  </>
                )}
              </div>
              <Button size="sm" onClick={onToggleManageMode} style={{ width: '100%', marginTop: 4 }}>
                Done
              </Button>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

function SidebarManageBtn({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return <Button size="sm" danger={danger} onClick={onClick}>{label}</Button>;
}
