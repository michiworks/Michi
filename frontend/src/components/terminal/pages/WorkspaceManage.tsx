import { artifactTypeForPath } from 'michi-shared';
import React from 'react';
import { Lightbox } from '../Lightbox';
import { toast } from 'sonner';
import type { PageId } from '../../../state/commands';
import { useChatStore, useChatNodesSnapshot } from '../../../state/chatStore';
import { getElectron } from '../../../lib/electronBridge';
import { openArtifact, showArtifactInDrawer } from '../artifacts/artifactOpen';
import { importWorkspaceFileUpload, type UploadProgress } from '../../../services/api';
import { sanitizeContextName } from '../../../lib/sanitizeContextName';
import UploadProgressBar, { type UploadProgressViewState } from '../../UploadProgressBar';
import { deriveDigests, deriveHeaderCounts, deriveTreeRows } from '../manage/derive';
import ManageHeader from '../manage/ManageHeader';
import ManageComposer from '../manage/ManageComposer';
import ManageTabs from '../manage/ManageTabs';
import ChatTreeList from '../manage/ChatTreeList';
import ContextList from '../manage/ContextList';
import DigestList from '../manage/DigestList';
import ManageSidebar from '../manage/ManageSidebar';
import { usePhoneLayout } from '../../../hooks/usePhoneLayout';
import { exportPanelEvent } from '../../../state/appEvents';
import { isFileDrag, useFileDropZone } from '../useFileDropZone';
import { FileDropOverlay } from '../PaneDragOverlays';
import { isLocalProject } from '../../../config/backendConnections';
import { useDigestEnabled } from '../../../state/prefs';

interface Props {
  workspaceId: string | null;
  onNav: (p: PageId) => void;
}

type Tab = 'chats' | 'artifacts' | 'digests';

export default function WorkspaceManage({ workspaceId, onNav }: Props) {
  const store = useChatStore();
  const { activeProjectId, selectProject } = store;
  const nodes = useChatNodesSnapshot();
  const project = workspaceId
    ? store.projects.find((p) => p.id === workspaceId && !p.deletedAt) ?? null
    : null;

  const [lightbox, setLightbox] = React.useState<{ src: string; name: string } | null>(null);
  const [selectedTab, setTab] = React.useState<Tab>('chats');
  // Settings › Digest off hides the Digests tab; one left open falls back to Chats.
  const digestEnabled = useDigestEnabled();
  const tab: Tab = selectedTab === 'digests' && !digestEnabled ? 'chats' : selectedTab;
  const [filter, setFilter] = React.useState('');
  const [selectedContextId, setSelectedContextId] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState<UploadProgressViewState | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const {
    visible: dropzoneVisible,
    fileCount: droppedFileCount,
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    endDrag,
  } = useFileDropZone();
  const [manageMode, setManageMode] = React.useState(false);
  const managedProjectId = project?.id ?? null;
  // A phone has no room for the 360px side column: the page becomes one
  // scrolling column with the side panels after the lists.
  const phone = usePhoneLayout();

  // ManageComposer creates a thread through the active-workspace action. The
  // manager can be opened from the all-workspaces page without activating its
  // project first, so align the active workspace on entry before the user can
  // submit into the wrong project.
  React.useEffect(() => {
    if (managedProjectId && activeProjectId !== managedProjectId) {
      selectProject(managedProjectId);
    }
  }, [activeProjectId, managedProjectId, selectProject]);

  const handleAddContext = React.useCallback(async () => {
    if (importing || !project) return;
    const electron = getElectron();
    if (electron?.chooseFiles && isLocalProject(project)) {
      setImporting(true);
      try {
        const r = await electron.chooseFiles();
        if (!r.canceled && r.paths) {
          const existing = (project.artifacts ?? []).map((c) => c.name);
          for (const p of r.paths) {
            const base = p.split('/').pop() ?? p;
            const name = sanitizeContextName(base, existing);
            existing.push(name);
            store.createContext(name, p, { kind: 'reference', type: artifactTypeForPath(p) });
          }
        }
      } catch (err) {
        toast.error(`Add source failed: ${(err as Error).message}`);
      } finally {
        setImporting(false);
      }
      return;
    }
    fileInputRef.current?.click();
  }, [importing, project, store]);

  const progressForFile = React.useCallback(
    (fileName: string, fileIndex: number, fileCount: number) =>
      (progress: UploadProgress) => {
        setUploadProgress({
          fileName,
          fileIndex,
          fileCount,
          phase: progress.phase,
          percent: progress.percent,
        });
      },
    [],
  );

  const handleImportFiles = React.useCallback(async (files: File[]) => {
    if (files.length === 0 || !project) return;
    const electron = getElectron();
    setImporting(true);
    try {
      const existing = (project.artifacts ?? []).map((c) => c.name);
      for (const [fileIndex, file] of files.entries()) {
        const electronPath = electron?.getPathForFile?.(file) ?? null;
        if (electronPath && isLocalProject(project)) {
          const base = electronPath.split('/').pop() ?? electronPath;
          const name = sanitizeContextName(base, existing);
          existing.push(name);
          store.createContext(name, electronPath, { kind: 'reference', type: artifactTypeForPath(electronPath) });
          continue;
        }
        const cwd = project.cwd;
        if (!cwd) {
          toast.error('Workspace has no folder set');
          return;
        }
        const result = await importWorkspaceFileUpload(project.id, cwd, file, {
          onProgress: progressForFile(file.name, fileIndex, files.length),
        });
        store.createContext(result.name, result.filePath, { size: result.size, type: artifactTypeForPath(result.filePath) });
      }
    } catch (err) {
      toast.error(`Add source failed: ${(err as Error).message}`);
    } finally {
      setImporting(false);
      setUploadProgress(null);
    }
  }, [progressForFile, project, store]);

  const handleWebFiles = React.useCallback(async (files: FileList | null) => {
    try {
      await handleImportFiles(files ? Array.from(files) : []);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [handleImportFiles]);

  const handleDrop = React.useCallback(async (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    endDrag();
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    // Auto-switch to artifacts tab so the user sees the new entries.
    setTab('artifacts');
    await handleImportFiles(files);
  }, [endDrag, handleImportFiles]);

  if (!project) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          fontFamily: 'var(--ui-font)',
          fontSize: 'var(--fs-lg)',
          color: 'var(--term-muted)',
          background: 'var(--term-page-bg, var(--term-bg))',
        }}
      >
        <span>{workspaceId ? 'workspace not found' : 'select a workspace'}</span>
        <button
          type="button"
          onClick={() => onNav('workspaces')}
          style={{
            border: '1px solid var(--term-line)',
            background: 'transparent',
            color: 'var(--term-fg)',
            padding: '4px 10px',
            fontFamily: 'inherit',
            fontSize: 'var(--fs-sm)',
            cursor: 'pointer',
          }}
        >
          ← back to workspaces
        </button>
      </div>
    );
  }

  const counts = deriveHeaderCounts(project, nodes);
  const digests = deriveDigests(project, nodes);
  // Select all takes the threads the chat list shows, under its filter.
  const selectListedTrees = () => store.selectTrees(
    deriveTreeRows(project, nodes, tab === 'chats' ? filter : '').flatMap((row) => (row.kind === 'root' ? [row.treeId] : [])),
  );
  const tabCounts = {
    chats: counts.chats,
    artifacts: counts.artifacts,
    digests: digests.length,
  };

  const handleOpenNode = (nodeId: string) => {
    store.revealNode(nodeId, { workspaceId: project.id });
    onNav('dashboard');
  };

  const handleSubmitted = () => onNav('dashboard');

  return (
    <div
      data-testid="workspace-manage"
      className={phone ? 'term-scrollbar' : undefined}
      style={phone ? {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        background: 'var(--term-page-bg, var(--term-bg))',
      } : {
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '1fr 360px',
        minHeight: 0,
        background: 'var(--term-page-bg, var(--term-bg))',
      }}
    >
      <main
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => { void handleDrop(e); }}
        style={{
          padding: phone ? '16px 16px 24px' : '20px 56px 60px',
          overflowY: phone ? 'visible' : 'auto',
          minWidth: 0,
          position: 'relative',
        }}
      >
        <ManageHeader
          name={project.name}
          cwd={project.cwd}
          backendConnectionId={project.backendConnectionId}
          chatsCount={counts.chats}
          contextsCount={counts.artifacts}
          branchesCount={counts.branches}
          lastActiveAt={counts.lastActiveAt}
          compact={phone}
        />
        <ManageComposer
          workspaceId={project.id}
          workspaceName={project.name}
          onSubmitted={handleSubmitted}
        />
        <ManageTabs
          activeTab={tab}
          onChange={(t) => { setTab(t); setFilter(''); }}
          counts={tabCounts}
          filter={filter}
          onFilterChange={setFilter}
          compact={phone}
          showDigests={digestEnabled}
        />
        {tab === 'chats' && (
          <ChatTreeList
            workspace={project}
            nodes={nodes}
            filter={filter}
            manageMode={manageMode}
            onOpen={handleOpenNode}
            menuActions={{
              activateTree: store.activateTree,
              archiveTree: store.archiveTree,
              unarchiveTree: store.unarchiveTree,
              pinTree: store.pinTree,
              unpinTree: store.unpinTree,
              renameTree: store.renameTree,
              deleteTree: store.deleteTree,
              exportTree: (treeId) =>
                exportPanelEvent.dispatch({ projectId: project.id, treeId }),
            }}
            bulkActions={{
              treeSelection: store.treeSelection,
              toggleTreeSelection: store.toggleTreeSelection,
              clearTreeSelection: store.clearTreeSelection,
              selectAllTrees: selectListedTrees,
              bulkArchiveTrees: store.bulkArchiveTrees,
              bulkDeleteTrees: store.bulkDeleteTrees,
              bulkUnarchiveTrees: store.bulkUnarchiveTrees,
            }}
          />
        )}
        {tab === 'artifacts' && (
          <>
            {lightbox && <Lightbox src={lightbox.src} filename={lightbox.name} onClose={() => setLightbox(null)} />}
            <UploadProgressBar progress={uploadProgress} compact />
            <ContextList
              artifacts={project.artifacts ?? []}
              filter={filter}
              selectedContextId={selectedContextId}
              onSelect={setSelectedContextId}
              onAdd={handleAddContext}
              onPin={(id) => store.pinContext?.(id)}
              onDelete={(id) => store.deleteContext?.(id)}
              onOpen={(artifact) => void openArtifact(artifact, {
                project,
                openArtifactPane: store.openArtifactPane,
                onLightbox: (src) => setLightbox({ src, name: artifact.name }),
                onPreview: () => showArtifactInDrawer(artifact.id),
                onError: (message) => toast.error(`Could not open ${artifact.name}: ${message}`),
              })}
            />
          </>
        )}
        {tab === 'digests' && (
          <DigestList
            digests={digests}
            filter={filter}
            onOpen={handleOpenNode}
            onRebuild={(id) => { void store.refreshDigest(id); }}
            onExport={(id) =>
              exportPanelEvent.dispatch({ projectId: project.id, digestNodeId: id })
            }
          />
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(e) => handleWebFiles(e.target.files)}
          style={{ display: 'none' }}
        />
        <FileDropOverlay visible={dropzoneVisible} fileCount={droppedFileCount} label="add as context" />
      </main>
      <ManageSidebar
        workspace={project}
        stacked={phone}
        onSaveInstructions={(text) => store.setProjectInstructions(project.id, text)}
        onAddFolder={store.addFolder}
        onRemoveFolder={store.removeFolder}
        onUpdateFolderLabel={store.updateFolderLabel}
        manageMode={manageMode}
        onToggleManageMode={() => {
          if (manageMode) {
            store.clearTreeSelection();
          }
          setManageMode((v) => !v);
        }}
        bulkActions={{
          treeSelection: store.treeSelection,
          toggleTreeSelection: store.toggleTreeSelection,
          clearTreeSelection: store.clearTreeSelection,
          selectAllTrees: selectListedTrees,
          bulkArchiveTrees: store.bulkArchiveTrees,
          bulkDeleteTrees: store.bulkDeleteTrees,
          bulkUnarchiveTrees: store.bulkUnarchiveTrees,
        }}
        hasArchivedSelection={
          Array.from(store.treeSelection).some((id) =>
            project.trees.some((t) => t.id === id && !!t.archivedAt),
          )
        }
      />
    </div>
  );
}
