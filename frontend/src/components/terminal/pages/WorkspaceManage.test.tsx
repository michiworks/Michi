import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import WorkspaceManage from './WorkspaceManage';

const { uploadMock, downloadMock, openUrlMock } = vi.hoisted(() => ({ uploadMock: vi.fn(), downloadMock: vi.fn(), openUrlMock: vi.fn() }));
vi.mock('../../../services/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../services/api')>(),
  importWorkspaceFileUpload: uploadMock,
}));
vi.mock('../../../services/api/artifacts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../services/api/artifacts')>(),
  downloadArtifactFile: downloadMock,
}));
vi.mock('../../../services/openUrl', () => ({ openPreferredUrl: openUrlMock }));

const baseStoreShape: any = {
  projects: [],
  activeProjectId: null,
  createThread: vi.fn(),
  sendMessage: vi.fn(),
  selectProject: vi.fn(),
  updateContext: vi.fn(),
  deleteContext: vi.fn(),
  toggleAutoInject: vi.fn(),
  createContext: vi.fn(),
  activateTree: vi.fn(),
  revealNode: vi.fn(),
  refreshDigest: vi.fn().mockResolvedValue(undefined),
  agentStatus: null,
  refreshAgentStatus: vi.fn(),
  treeSelection: new Set<string>(),
  toggleTreeSelection: vi.fn(),
  clearTreeSelection: vi.fn(),
  selectAllTrees: vi.fn(),
  selectTrees: vi.fn(),
  bulkArchiveTrees: vi.fn(),
  bulkDeleteTrees: vi.fn(),
  bulkUnarchiveTrees: vi.fn(),
  archiveTree: vi.fn(),
  unarchiveTree: vi.fn(),
  pinTree: vi.fn(),
  unpinTree: vi.fn(),
  renameTree: vi.fn(),
  deleteTree: vi.fn(),
  setProjectInstructions: vi.fn(),
};

let mockNodes: Record<string, any> = {};

vi.mock('../../../state/chatStore', async () => {
  const actual: any = await vi.importActual('../../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => baseStoreShape,
    useChatNodesSnapshot: () => mockNodes,
  };
});

const prefsState = vi.hoisted(() => ({ digestEnabled: true }));
vi.mock('../../../state/prefs', async () => {
  const actual: any = await vi.importActual('../../../state/prefs');
  return { ...actual, useDigestEnabled: () => prefsState.digestEnabled };
});

vi.mock('../manage/ManageComposer', () => ({
  default: ({ onSubmitted }: { onSubmitted: () => void }) => (
    <button type="button" onClick={onSubmitted}>Submit managed prompt</button>
  ),
}));

function seedWorkspace() {
  mockNodes = {
    a: {
      nodeId: 'a',
      projectId: 'ws1',
      kind: 'chat',
      title: 'Test chat',
      status: 'idle',
      messages: [],
      followUps: [],
      createdAt: 0,
    },
  };
  baseStoreShape.activeProjectId = 'ws1';
  baseStoreShape.projects = [{
    id: 'ws1',
    name: 'web-platform',
    cwd: '~/projects/web',
    chatIds: ['a'],
    edges: [],
    createdAt: 0,
    trees: [{ id: 't1', rootNodeId: 'a', createdAt: 0, lastActiveAt: Date.now() }],
    activeTreeId: 't1',
    artifacts: [
      { id: 'ctx', name: 'a.md', filePath: 'a.md', source: 'user', createdAt: 0, updatedAt: 0 },
    ],
  }];
}

describe('WorkspaceManage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseStoreShape.projects = [];
    baseStoreShape.activeProjectId = null;
    baseStoreShape.treeSelection = new Set<string>();
    mockNodes = {};
    prefsState.digestEnabled = true;
  });

  it('offers no Digests tab while Settings › Digest is off', () => {
    seedWorkspace();
    prefsState.digestEnabled = false;
    render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);
    expect(screen.getByRole('button', { name: /Artifacts/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Digests/i })).toBeNull();
  });

  it('shows empty state when workspace not found', () => {
    baseStoreShape.projects = [];
    render(<WorkspaceManage workspaceId="missing" onNav={() => {}} />);
    expect(screen.queryByText(/workspace not found/i)).not.toBeNull();
  });

  it('shows its drop zone as "add as context" while files are dragged over it', () => {
    seedWorkspace();
    render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);
    const main = document.querySelector('main')!;
    const drag = (type: string) => fireEvent(main, Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      dataTransfer: { types: ['Files'], items: [{ kind: 'file' }], files: [], dropEffect: 'none' },
    }));
    drag('dragenter');
    drag('dragenter');
    drag('dragleave');
    expect(screen.getByText('drop 1 file · add as context')).toBeTruthy();
    drag('dragleave');
    expect(screen.queryByText(/add as context/)).toBeNull();
  });

  it('activates the managed workspace before its composer can create a thread', () => {
    seedWorkspace();
    baseStoreShape.activeProjectId = 'another-workspace';

    render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);

    expect(baseStoreShape.selectProject).toHaveBeenCalledWith('ws1');
  });

  it('selects all the threads the list shows: under the filter, no hidden helper, Trash or archive', () => {
    seedWorkspace();
    const chat = (nodeId: string, title: string, extra: Record<string, unknown> = {}) => ({
      nodeId, projectId: 'ws1', kind: 'chat', title, status: 'idle', messages: [], followUps: [], createdAt: 0, ...extra,
    });
    Object.assign(mockNodes, {
      b: chat('b', 'Test notes'),
      c: chat('c', 'Unrelated'),
      helper: chat('helper', 'Test page helper', { pageId: 'pg-1' }),
      binned: chat('binned', 'Test binned', { deletedAt: 5 }),
      old: chat('old', 'Test archived'),
    });
    const project = baseStoreShape.projects[0];
    project.chatIds.push('b', 'c', 'helper', 'binned', 'old');
    project.trees.push(
      { id: 't2', rootNodeId: 'b', createdAt: 0, lastActiveAt: 2 },
      { id: 't3', rootNodeId: 'c', createdAt: 0, lastActiveAt: 3 },
      { id: 't-helper', rootNodeId: 'helper', createdAt: 0, lastActiveAt: 4 },
      { id: 't-binned', rootNodeId: 'binned', createdAt: 0, lastActiveAt: 5 },
      { id: 't-old', rootNodeId: 'old', createdAt: 0, lastActiveAt: 6, archivedAt: 7 },
    );
    render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Select threads/ }));
    fireEvent.change(screen.getByLabelText('Search this workspace'), { target: { value: 'test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(baseStoreShape.selectTrees).toHaveBeenCalledWith(['t1', 't2']);
    expect(baseStoreShape.selectAllTrees).not.toHaveBeenCalled();
  });

  // Owner decision 15 (F23): a selection mixing archived and live threads
  // would leave only Unarchive and Delete.
  it('leaves archived threads out of Select all even with the Archived lane open', () => {
    seedWorkspace();
    mockNodes.old = { ...mockNodes.a, nodeId: 'old', title: 'Old chat' };
    const project = baseStoreShape.projects[0];
    project.chatIds.push('old');
    project.trees.push({ id: 't-old', rootNodeId: 'old', createdAt: 0, lastActiveAt: 6, archivedAt: 7 });
    render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Select threads/ }));
    fireEvent.click(screen.getByRole('button', { name: /ARCHIVED/ }));
    expect(screen.getByText('Old chat')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(baseStoreShape.selectTrees).toHaveBeenCalledWith(['t1']);
  });

  it('opens, rebuilds, and exports a digest with visible destinations', () => {
    seedWorkspace();
    mockNodes.digest = {
      nodeId: 'digest',
      projectId: 'ws1',
      kind: 'digest',
      title: 'Weekly digest',
      status: 'idle',
      messages: [],
      followUps: [],
      createdAt: 1,
      digest: {
        sources: ['a'],
        sourceCount: 1,
        content: '# Weekly digest\nSummary',
        generatedAt: 2,
        viewedAt: 0,
        status: 'idle',
        sourceFingerprints: {},
      },
    };
    baseStoreShape.projects[0].chatIds.push('digest');
    const onNav = vi.fn();
    const exportSpy = vi.fn();
    window.addEventListener('michi:toggle-export-panel', exportSpy as EventListener);
    try {
      render(<WorkspaceManage workspaceId="ws1" onNav={onNav} />);
      fireEvent.click(screen.getByRole('button', { name: /Digests/i }));

      fireEvent.click(screen.getByRole('button', { name: /open/i }));
      // revealNode opens a digest in its source's thread (navigateToNode.test).
      expect(baseStoreShape.revealNode).toHaveBeenCalledWith('digest', { workspaceId: 'ws1' });
      expect(onNav).toHaveBeenCalledWith('dashboard');

      fireEvent.click(screen.getByRole('button', { name: /rebuild/i }));
      expect(baseStoreShape.refreshDigest).toHaveBeenCalledWith('digest');

      fireEvent.click(screen.getByRole('button', { name: /export/i }));
      expect(exportSpy).toHaveBeenCalledOnce();
      const event = exportSpy.mock.calls[0][0] as CustomEvent;
      expect(event.detail).toEqual({ projectId: 'ws1', digestNodeId: 'digest' });
    } finally {
      window.removeEventListener('michi:toggle-export-panel', exportSpy as EventListener);
    }
  });
});

it('classifies uploaded remote images and unknown formats without treating them as documents', async () => {
  seedWorkspace();
  baseStoreShape.projects[0].backendConnectionId = 'remote';
  baseStoreShape.createContext.mockClear();
  uploadMock.mockResolvedValueOnce({ name: 'shot', filePath: '.artifacts/shot.png', size: 3 })
    .mockResolvedValueOnce({ name: 'data', filePath: '.artifacts/data.custom', size: 2 });
  const { container } = render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [new File(['png'], 'shot.png'), new File(['xx'], 'data.custom')] },
  });
  await waitFor(() => expect(baseStoreShape.createContext).toHaveBeenCalledTimes(2));
  expect(baseStoreShape.createContext).toHaveBeenCalledWith('shot', '.artifacts/shot.png', expect.objectContaining({ type: 'image' }));
  expect(baseStoreShape.createContext).toHaveBeenCalledWith('data', '.artifacts/data.custom', expect.objectContaining({ type: 'file' }));
});

describe('WorkspaceManage artifact open', () => {
  function openArtifactRow(name: string) {
    fireEvent.click(screen.getByRole('button', { name: /Artifacts/i }));
    fireEvent.mouseEnter(screen.getByText(name));
    fireEvent.click(screen.getByRole('button', { name: `preview ${name}` }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    seedWorkspace();
    baseStoreShape.openArtifactPane = vi.fn().mockResolvedValue('pane-1');
    downloadMock.mockResolvedValue(undefined);
  });

  it('opens a link artifact\'s URL instead of downloading an empty path', async () => {
    baseStoreShape.projects[0].artifacts = [
      { id: 'link', name: 'docs-site', filePath: '', url: 'https://example.com/docs', type: 'link', source: 'user', createdAt: 0, updatedAt: 0 },
    ];
    render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);
    openArtifactRow('docs-site');
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledWith('https://example.com/docs'));
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('opens an HTML artifact in the drawer\'s preview instead of downloading it', async () => {
    baseStoreShape.projects[0].artifacts = [
      { id: 'html', name: 'bubble', filePath: 'mocks/bubble.html', type: 'file', kind: 'embedded', source: 'agent', createdAt: 0, updatedAt: 0 },
    ];
    const onDrawer = vi.fn();
    window.addEventListener('michi:toggle-artifacts', onDrawer);
    try {
      render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);
      openArtifactRow('bubble');
      await waitFor(() => expect(onDrawer).toHaveBeenCalledTimes(1));
      expect((onDrawer.mock.calls[0][0] as CustomEvent).detail).toEqual({ artifactId: 'html' });
      expect(downloadMock).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('michi:toggle-artifacts', onDrawer);
    }
  });

  it('opens an artifact by its stored type, not its extension', async () => {
    baseStoreShape.projects[0].artifacts = [
      { id: 'readme', name: 'readme-notes', filePath: 'README', type: 'doc', source: 'user', createdAt: 0, updatedAt: 0 },
    ];
    render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);
    openArtifactRow('readme-notes');
    await waitFor(() => expect(baseStoreShape.openArtifactPane).toHaveBeenCalledWith('README'));
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('opens a Windows reference doc at its own path', async () => {
    baseStoreShape.projects[0].cwd = 'C:\\proj';
    baseStoreShape.projects[0].artifacts = [
      { id: 'win', name: 'spec', filePath: 'C:\\Users\\me\\spec.md', type: 'doc', kind: 'reference', source: 'user', createdAt: 0, updatedAt: 0 },
    ];
    render(<WorkspaceManage workspaceId="ws1" onNav={() => {}} />);
    openArtifactRow('spec');
    await waitFor(() => expect(baseStoreShape.openArtifactPane).toHaveBeenCalledWith('C:\\Users\\me\\spec.md'));
  });
});
