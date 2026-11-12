import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ArtifactsDrawer from './ArtifactsDrawer';
import type { ArtifactEntry } from '../../state/chatTypes';

const {
  mockImportWorkspaceFile, mockUpload, mockLinkWorkspaceFile, mockOpenPath, mockGetElectron,
  mockFetchHead, mockFetchContent, mockDownload, mockNavigate,
} = vi.hoisted(() => ({
  mockImportWorkspaceFile: vi.fn(),
  mockUpload: vi.fn(),
  mockLinkWorkspaceFile: vi.fn(),
  mockOpenPath: vi.fn(),
  mockGetElectron: vi.fn(),
  mockFetchHead: vi.fn(),
  mockFetchContent: vi.fn(),
  mockDownload: vi.fn(),
  mockNavigate: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  importWorkspaceFile: mockImportWorkspaceFile,
  importWorkspaceFileUpload: mockUpload,
  linkWorkspaceFile: mockLinkWorkspaceFile,
}));
vi.mock('../../services/api/artifacts', async () => {
  const actual = await vi.importActual<typeof import('../../services/api/artifacts')>('../../services/api/artifacts');
  return {
    ...actual,
    fetchArtifactHead: mockFetchHead,
    fetchArtifactContent: mockFetchContent,
    downloadArtifactFile: mockDownload,
  };
});
vi.mock('../../lib/electronBridge', () => ({
  getElectron: mockGetElectron,
}));

const mockActions = {
  createContext: vi.fn(),
  updateContext: vi.fn(),
  deleteContext: vi.fn(),
  pinContext: vi.fn(),
  openArtifactPane: vi.fn(),
  revealNode: mockNavigate,
};

const mockContexts: ArtifactEntry[] = [];
let mockProject: { id: string; name: string; cwd?: string; artifacts: ArtifactEntry[] } | null = {
  id: 'p1',
  name: 'P1',
  cwd: '/tmp/p1',
  artifacts: mockContexts,
};
const mockNodes: Record<string, { nodeId: string; title?: string; messages: unknown[]; deletedAt?: number }> = {};

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => ({ activeProject: mockProject, projects: mockProject ? [mockProject] : [], focusedNodeId: null, ...mockActions }),
    useChatNodeReader: () => (id: string) => mockNodes[id],
  };
});

beforeEach(() => {
  mockContexts.length = 0;
  for (const id of Object.keys(mockNodes)) delete mockNodes[id];
  mockProject = { id: 'p1', name: 'P1', cwd: '/tmp/p1', artifacts: mockContexts };
  Object.values(mockActions).forEach((fn) => fn.mockReset());
  mockActions.openArtifactPane.mockResolvedValue('node-1');
  mockImportWorkspaceFile.mockReset();
  mockImportWorkspaceFile.mockResolvedValue({ name: 'note', filePath: '.artifacts/note.md', size: 5 });
  mockLinkWorkspaceFile.mockReset();
  mockLinkWorkspaceFile.mockResolvedValue({ name: 'design-notes', filePath: '.artifacts/design-notes.md', size: 10 });
  mockOpenPath.mockReset();
  mockOpenPath.mockResolvedValue({ ok: true });
  mockGetElectron.mockReset();
  mockGetElectron.mockReturnValue({ openPath: mockOpenPath });
  mockFetchHead.mockReset();
  mockFetchHead.mockResolvedValue({ status: 'error' });
  mockFetchContent.mockReset();
  mockDownload.mockReset();
  mockDownload.mockResolvedValue(undefined);
  mockNavigate.mockReset();
});

const now = Date.now();

function htmlMock(extra: Partial<ArtifactEntry> = {}): ArtifactEntry {
  return {
    id: 'bubble',
    name: 'user-bubble-mock',
    filePath: 'mocks/user-bubble/user-bubble.html',
    type: 'file',
    kind: 'embedded',
    source: 'agent',
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function openMenu(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `More actions for ${name}` }));
  return screen.getByRole('menu', { name: 'Actions' });
}

describe('ArtifactsDrawer + button', () => {
  it('closes the context menu before the drawer on Escape', () => {
    mockContexts.push({ id: 'notes', name: 'Menu notes', filePath: 'notes.md', type: 'doc', source: 'user', createdAt: 1, updatedAt: 1 });
    const onClose = vi.fn();
    render(<ArtifactsDrawer open onClose={onClose} />);
    fireEvent.contextMenu(screen.getByText('Menu notes'), { clientX: 40, clientY: 60 });
    expect(screen.getByRole('menu', { name: 'Actions' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Actions' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes a row menu on a second press of its ⋯', async () => {
    mockContexts.push({ id: 'notes', name: 'Menu notes', filePath: 'notes.md', type: 'doc', source: 'user', createdAt: 1, updatedAt: 1 });
    render(<ArtifactsDrawer open onClose={vi.fn()} />);
    openMenu('Menu notes');
    const more = screen.getByRole('button', { name: 'More actions for Menu notes' });
    // The menu listens for outside presses from its next frame.
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    fireEvent.mouseDown(more);
    fireEvent.click(more);
    expect(screen.queryByRole('menu', { name: 'Actions' })).toBeNull();
  });

  it('saves a pasted URL as a link artifact', () => {
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByTitle(/Add link or paste text/i));
    fireEvent.change(screen.getByPlaceholderText(/Paste a URL/i), {
      target: { value: 'https://stripe.com/docs/refunds' },
    });
    fireEvent.click(screen.getByText('Save'));
    expect(mockActions.createContext).toHaveBeenCalledTimes(1);
    const [name, filePath, opts] = mockActions.createContext.mock.calls[0];
    expect(filePath).toBe('');
    expect(opts).toMatchObject({ url: 'https://stripe.com/docs/refunds', type: 'link' });
    expect(name).toMatch(/stripe/);
  });

  it('saves pasted text as a doc via importWorkspaceFile', async () => {
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByTitle(/Add link or paste text/i));
    fireEvent.change(screen.getByPlaceholderText(/Paste a URL/i), {
      target: { value: 'some free text note' },
    });
    fireEvent.click(screen.getByText('Save'));
    // importWorkspaceFile is async; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockImportWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(mockActions.createContext).toHaveBeenCalledTimes(1);
  });

  it('lists favorites in their own group and unfavorites from the row menu', async () => {
    mockContexts.push({
      id: 'c1',
      name: 'brief.md',
      filePath: '.artifacts/brief.md',
      type: 'doc',
      source: 'user',
      pinnedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);

    expect(within(screen.getByRole('region', { name: 'Favorites' })).getByText('brief.md')).toBeTruthy();
    fireEvent.click(within(openMenu('brief.md')).getByRole('menuitem', { name: 'Remove from favorites' }));
    // A menu item runs after its blink.
    await waitFor(() => expect(mockActions.pinContext).toHaveBeenCalledWith('c1'));
  });
});

describe('ArtifactsDrawer list', () => {
  it('groups by day and says what each row is and where it came from', () => {
    mockNodes['n-1'] = { nodeId: 'n-1', title: 'Bubble redesign', messages: [] };
    mockContexts.push(
      htmlMock({ origin: { nodeId: 'n-1' } }),
      { id: 'old', name: 'october-plan', filePath: '.contexts/plan.md', type: 'doc', source: 'agent', createdAt: now - 60 * 86_400_000, updatedAt: now - 60 * 86_400_000 },
    );
    render(<ArtifactsDrawer open onClose={() => {}} />);

    const today = screen.getByRole('region', { name: 'Today' });
    expect(within(today).getByText('user-bubble-mock')).toBeTruthy();
    expect(within(today).getByText('HTML · from Bubble redesign')).toBeTruthy();
    expect(screen.queryByText('Documents')).toBeNull();
    expect(screen.getByText('october-plan').closest('section')?.getAttribute('aria-label')).not.toBe('Today');
    // No marker for agent-created rows: every row here is agent-created.
    expect(screen.queryByTitle('agent-created')).toBeNull();
  });

  it('names a row by its page title once the head is read, keeping the @name on hover', async () => {
    // Its own timestamp: titles stay cached for the session, keyed by path and last touch.
    mockContexts.push(htmlMock({ createdAt: now + 1, updatedAt: now + 1 }));
    mockFetchHead.mockResolvedValue({ status: 'ok', text: '<!doctype html><title>用户消息 · 保留亮条</title>' });
    render(<ArtifactsDrawer open onClose={() => {}} />);

    expect(await screen.findByText('用户消息 · 保留亮条')).toBeTruthy();
    expect(mockFetchHead).toHaveBeenCalledWith('p1', 'mocks/user-bubble/user-bubble.html', 4096, expect.any(AbortSignal));
    expect(screen.getByTitle('@user-bubble-mock')).toBeTruthy();
  });

  it('does not read heads while closed, nor for links and files outside the workspace', () => {
    mockContexts.push(
      htmlMock(),
      { id: 'ln', name: 'docs', filePath: '', url: 'https://x.dev/a', type: 'link', source: 'user', createdAt: now, updatedAt: now },
      { id: 'ref', name: 'outside', filePath: '/Users/me/a.html', type: 'file', kind: 'reference', source: 'user', createdAt: now, updatedAt: now },
    );
    const { rerender } = render(<ArtifactsDrawer open={false} onClose={() => {}} />);
    expect(mockFetchHead).not.toHaveBeenCalled();
    rerender(<ArtifactsDrawer open onClose={() => {}} />);
    expect(mockFetchHead).toHaveBeenCalledTimes(1);
    expect(mockFetchHead.mock.calls[0][1]).toBe('mocks/user-bubble/user-bubble.html');
  });

  it('marks a missing file and offers to remove it', async () => {
    mockContexts.push(htmlMock({ name: 'glass-selection-toast-mock', filePath: 'michi-mocks/glass.html' }));
    mockFetchHead.mockResolvedValue({ status: 'missing' });
    render(<ArtifactsDrawer open onClose={() => {}} />);

    expect(await screen.findByText('File missing')).toBeTruthy();
    expect(within(openMenu('glass-selection-toast-mock')).queryByRole('menuitem', { name: 'Download' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByText('glass-selection-toast-mock'));
    expect(mockFetchContent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Artifacts' }));
    expect(mockActions.deleteContext).toHaveBeenCalledWith('bubble');
  });

  it('goes to the conversation an artifact came from', async () => {
    mockNodes['n-1'] = { nodeId: 'n-1', title: 'Bubble redesign', messages: [] };
    mockContexts.push(htmlMock({ origin: { nodeId: 'n-1' } }));
    const onClose = vi.fn();
    render(<ArtifactsDrawer open onClose={onClose} />);
    fireEvent.click(within(openMenu('user-bubble-mock')).getByRole('menuitem', { name: 'Go to conversation' }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('n-1', { workspaceId: 'p1' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('offers no way to a deleted conversation', () => {
    mockNodes['n-1'] = { nodeId: 'n-1', title: 'Gone', messages: [], deletedAt: 1 };
    mockContexts.push(htmlMock({ origin: { nodeId: 'n-1' } }));
    render(<ArtifactsDrawer open onClose={() => {}} />);
    expect(screen.getByText('HTML')).toBeTruthy();
    expect(within(openMenu('user-bubble-mock')).queryByRole('menuitem', { name: 'Go to conversation' })).toBeNull();
  });
});

describe('ArtifactsDrawer HTML preview', () => {
  it('opens an HTML artifact in a sandboxed frame inside the drawer, and Escape goes back', async () => {
    mockContexts.push(htmlMock());
    mockFetchContent.mockResolvedValue({ content: '<!doctype html><title>t</title><p>hello</p>' });
    const onClose = vi.fn();
    render(<ArtifactsDrawer open onClose={onClose} />);

    fireEvent.click(screen.getByText('user-bubble-mock'));
    const frame = (await screen.findByTitle('user-bubble-mock')) as HTMLIFrameElement;
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')?.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(frame.getAttribute('srcdoc')?.endsWith('<title>t</title><p>hello</p>')).toBe(true);
    expect(mockFetchContent).toHaveBeenCalledWith('p1', 'mocks/user-bubble/user-bubble.html', false, expect.any(AbortSignal));
    expect(mockDownload).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Artifact: user-bubble-mock' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('artifact-preview')).toBeNull();
    expect(screen.getByText('user-bubble-mock')).toBeTruthy();
  });

  it('says what went wrong and offers a download when a page cannot be read', async () => {
    const { ArtifactReadError } = await import('../../services/api/artifacts');
    mockContexts.push(htmlMock());
    mockFetchContent.mockRejectedValue(new ArtifactReadError('File too large (6.1MB > 5MB) — open externally', 413));
    render(<ArtifactsDrawer open onClose={() => {}} />);

    fireEvent.click(screen.getByText('user-bubble-mock'));
    expect(await screen.findByText(/File too large/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(mockDownload).toHaveBeenCalledWith('p1', 'mocks/user-bubble/user-bubble.html');
  });

  it('shows the file missing note when the read finds the file gone', async () => {
    const { ArtifactReadError } = await import('../../services/api/artifacts');
    mockContexts.push(htmlMock());
    mockFetchContent.mockRejectedValue(new ArtifactReadError('File not found', 404));
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByText('user-bubble-mock'));
    expect(await screen.findByRole('button', { name: 'Remove from Artifacts' })).toBeTruthy();
  });

  it('still downloads files it cannot preview', async () => {
    mockContexts.push(htmlMock({ name: 'report', filePath: 'out/report.pdf' }));
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByText('report'));
    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith('p1', 'out/report.pdf'));
    expect(screen.queryByTestId('artifact-preview')).toBeNull();
  });
});

describe('ArtifactsDrawer open routing', () => {
  it('opens a reference image via the OS opener, not the lightbox', () => {
    mockContexts.push({
      id: 'ref-img',
      name: 'diagram',
      filePath: '/Users/me/Pictures/diagram.png',
      type: 'image',
      kind: 'reference',
      source: 'user',
      createdAt: now,
      updatedAt: now,
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByText('diagram'));
    expect(mockOpenPath).toHaveBeenCalledWith('/Users/me/Pictures/diagram.png');
    // No lightbox <img> rendered for a reference image.
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('reveals a Windows reference in its folder', async () => {
    mockContexts.push({
      id: 'win-ref',
      name: 'spec',
      filePath: 'C:\\Users\\me\\spec.pdf',
      type: 'file',
      kind: 'reference',
      source: 'user',
      createdAt: now,
      updatedAt: now,
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(within(openMenu('spec')).getByRole('menuitem', { name: 'Open in Folder' }));
    await waitFor(() => expect(mockOpenPath).toHaveBeenCalled());
    expect(mockOpenPath).toHaveBeenCalledWith('C:\\Users\\me');
  });

  it('says where a reference file opens when there is no desktop app', async () => {
    mockGetElectron.mockReturnValue(undefined);
    mockContexts.push({
      id: 'ref-zip',
      name: 'bundle',
      filePath: '/Users/me/bundle.zip',
      type: 'file',
      kind: 'reference',
      source: 'user',
      createdAt: now,
      updatedAt: now,
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByText('bundle'));
    expect(await screen.findByText('Open this reference on its desktop host')).toBeTruthy();
  });

  it('opens the artifact another surface asked for', async () => {
    mockContexts.push(htmlMock());
    mockFetchContent.mockResolvedValue({ content: '<p>hello</p>' });
    const onHandled = vi.fn();
    render(<ArtifactsDrawer open onClose={() => {}} openArtifactId="bubble" onOpenArtifactHandled={onHandled} />);
    expect((await screen.findByTitle('user-bubble-mock')).tagName).toBe('IFRAME');
    expect(onHandled).toHaveBeenCalledTimes(1);
  });

  it('opens an embedded doc in the in-app file pane', async () => {
    mockContexts.push({
      id: 'emb-doc',
      name: 'brief.md',
      filePath: '.artifacts/brief.md',
      type: 'doc',
      kind: 'embedded',
      source: 'user',
      createdAt: now,
      updatedAt: now,
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByText('brief.md'));
    await waitFor(() => expect(mockActions.openArtifactPane).toHaveBeenCalledWith('.artifacts/brief.md'));
    expect(mockOpenPath).not.toHaveBeenCalled();
  });

  it('opens a symlink doc artifact via the in-app pane (falls back to OS on failure)', async () => {
    // A symlinked file has a cwd-relative filePath. openArtifact resolves it to
    // an absolute path (cwd + filePath) so FilePane reads it through Electron,
    // bypassing the backend sandbox / realpath guard that would 404.
    mockContexts.push({
      id: 'sym-doc',
      name: 'design-notes',
      filePath: '.artifacts/design-notes.md',
      type: 'doc',
      kind: 'symlink',
      source: 'user',
      createdAt: now,
      updatedAt: now,
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByText('design-notes'));
    await vi.waitFor(() => {
      expect(mockActions.openArtifactPane).toHaveBeenCalledWith('/tmp/p1/.artifacts/design-notes.md');
    });
  });
});

describe('ArtifactsDrawer disk picker → symlink import', () => {
  it('symlinks a picked file into the workspace when a cwd exists', async () => {
    mockGetElectron.mockReturnValue({
      openPath: mockOpenPath,
      chooseFiles: vi.fn().mockResolvedValue({
        canceled: false,
        paths: ['/Users/me/Desktop/design-notes.md'],
      }),
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByTitle(/Add file from disk/i));
    // chooseFiles + linkWorkspaceFile are async; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockLinkWorkspaceFile).toHaveBeenCalledWith('p1', '/tmp/p1', '/Users/me/Desktop/design-notes.md');
    expect(mockActions.createContext).toHaveBeenCalledTimes(1);
    const [, filePath, opts] = mockActions.createContext.mock.calls[0];
    expect(filePath).toBe('.artifacts/design-notes.md');
    expect(opts).toMatchObject({ kind: 'symlink', type: 'doc', source: 'user' });
  });

  it('falls back to a reference when the workspace has no cwd', async () => {
    mockProject = { id: 'p1', name: 'P1', cwd: undefined, artifacts: mockContexts };
    mockGetElectron.mockReturnValue({
      openPath: mockOpenPath,
      chooseFiles: vi.fn().mockResolvedValue({
        canceled: false,
        paths: ['/Users/me/Desktop/design-notes.md'],
      }),
    });
    render(<ArtifactsDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByTitle(/Add file from disk/i));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockLinkWorkspaceFile).not.toHaveBeenCalled();
    expect(mockActions.createContext).toHaveBeenCalledTimes(1);
    const [, filePath, opts] = mockActions.createContext.mock.calls[0];
    expect(filePath).toBe('/Users/me/Desktop/design-notes.md');
    expect(opts).toMatchObject({ kind: 'reference', type: 'doc' });
  });
});

 it('uploads any file type on the web and classifies images separately', async () => {
   mockGetElectron.mockReturnValue(undefined);
   mockUpload.mockResolvedValueOnce({ name: 'shot', filePath: '.artifacts/shot.PNG', size: 3 })
     .mockResolvedValueOnce({ name: 'data', filePath: '.artifacts/data.custom', size: 2 });
   render(<ArtifactsDrawer open onClose={() => {}} />);
   const files = [new File(['png'], 'shot.PNG'), new File(['xx'], 'data.custom')];
   fireEvent.change(screen.getByLabelText('Upload artifact files'), { target: { files } });
   await waitFor(() => expect(mockActions.createContext).toHaveBeenCalledTimes(2));
   expect(mockActions.createContext).toHaveBeenCalledWith('shot', '.artifacts/shot.PNG', expect.objectContaining({ type: 'image' }));
   expect(mockActions.createContext).toHaveBeenCalledWith('data', '.artifacts/data.custom', expect.objectContaining({ type: 'file' }));
 });

describe('ArtifactsDrawer rename', () => {
  const notes = (): ArtifactEntry => ({ id: 'notes', name: 'notes', filePath: 'notes.md', type: 'doc', source: 'user', createdAt: 1, updatedAt: 1 });
  async function startRename() {
    fireEvent.click(within(openMenu('notes')).getByRole('menuitem', { name: 'Rename' }));
    return await screen.findByRole('textbox', { name: 'Rename notes' });
  }

  it('gives up the rename on Esc and keeps the drawer open', async () => {
    mockContexts.push(notes());
    const onClose = vi.fn();
    render(<ArtifactsDrawer open onClose={onClose} />);
    const field = await startRename();
    fireEvent.change(field, { target: { value: 'design' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Rename notes' })).toBeNull();
    expect(mockActions.updateContext).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('leaves Enter and Esc that end an IME composition to the field (%o)', async (ime) => {
    mockContexts.push(notes());
    const onClose = vi.fn();
    render(<ArtifactsDrawer open onClose={onClose} />);
    const field = await startRename();
    fireEvent.change(field, { target: { value: '设计' } });
    fireEvent.keyDown(field, { key: 'Enter', ...ime });
    fireEvent.keyDown(field, { key: 'Escape', ...ime });
    expect(mockActions.updateContext).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Rename notes' })).toBe(field);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(mockActions.updateContext).toHaveBeenCalledWith('notes', { name: '设计' });
  });

  it('keeps the field open on a name artifacts cannot take', async () => {
    mockContexts.push(notes());
    render(<ArtifactsDrawer open onClose={() => {}} />);
    const field = await startRename();
    fireEvent.change(field, { target: { value: 'two words' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(mockActions.updateContext).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Rename notes' })).toBe(field);
  });
});
