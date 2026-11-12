import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

const H = vi.hoisted(() => {
  const ReactMod = require('react') as typeof import('react');
  return {
    mockFetchArtifactContent: vi.fn(),
    mockGetElectron: vi.fn(),
    mockUpdatePaneItem: vi.fn(),
    ChatNodeStoreContext: ReactMod.createContext<unknown>({ getNode: () => undefined }),
  };
});

declare const require: (id: string) => unknown;
const { webcrypto } = require('node:crypto') as { webcrypto: Crypto };

vi.mock('../../services/api', () => ({
  fetchArtifactContent: H.mockFetchArtifactContent,
}));
vi.mock('../../lib/electronBridge', () => ({
  getElectron: H.mockGetElectron,
}));
vi.mock('../../hooks/usePaneShellStyle', () => ({
  usePaneShellStyle: () => ({}),
}));
vi.mock('../MarkdownContent', () => ({ default: () => null }));
vi.mock('../SelectionActions', () => ({ default: () => null }));

vi.mock('../../state/chatStore', () => ({
  ChatNodeStoreContext: H.ChatNodeStoreContext,
  useChatStore: () => ({ focusedNodeId: null }),
  useChatProjects: () => ({
    projects: [{ id: 'p1', name: 'P1', cwd: '/repo' }],
  }),
  useChatActions: () => ({
    focusPane: vi.fn(),
    setFocusedNodeId: vi.fn(),
    updatePaneItem: H.mockUpdatePaneItem,
    createChildChat: vi.fn(),
    addPendingComment: vi.fn(),
    setComposerDraft: vi.fn(),
  }),
}));

vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({ prefs: { terminalPalette: 'dark' } }),
}));

import FilePane from './FilePane';
import type { FilePaneItem } from '../../state/paneItems';

function makeItem(overrides: Partial<FilePaneItem> = {}): FilePaneItem {
  return {
    id: 'pane:file:1',
    kind: 'file',
    projectId: 'p1',
    treeId: 't1',
    title: 'foo.ts',
    createdAt: 1,
    filePath: '/repo/src/foo.ts',
    viewMode: 'source',
    ...overrides,
  };
}

function renderPane(item: FilePaneItem) {
  return render(
    <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
      <FilePane item={item} />
    </H.ChatNodeStoreContext.Provider>,
  );
}

function rect(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 100,
    bottom: top + 20,
    left: 0,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  } as DOMRect;
}

function prepareScrollGeometry(container: HTMLElement) {
  const scrollContainer = container.querySelector('.term-scrollbar') as HTMLDivElement;
  const pre = container.querySelector('pre') as HTMLPreElement;
  Object.defineProperty(scrollContainer, 'clientHeight', { configurable: true, value: 200 });
  scrollContainer.getBoundingClientRect = vi.fn(() => rect(0));
  pre.getBoundingClientRect = vi.fn(() => rect(20 - scrollContainer.scrollTop));
  scrollContainer.scrollTop = 0;
  return { pre, scrollContainer };
}

const FILE_CONTENT = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');

function textFile(content: string, extension = '') {
  return { kind: 'text' as const, content, size: content.length, modifiedAt: 1, extension };
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  H.mockFetchArtifactContent.mockReset();
  H.mockGetElectron.mockReset();
  H.mockUpdatePaneItem.mockReset();
  H.mockGetElectron.mockReturnValue(null);
  H.mockFetchArtifactContent.mockResolvedValue({
    content: FILE_CONTENT,
    size: FILE_CONTENT.length,
    modifiedAt: Date.now(),
    extension: 'ts',
  });
});

describe('FilePane source locations', () => {
  it('repositions when the same location returns from rendered to source mode', async () => {
    H.mockFetchArtifactContent.mockResolvedValue({
      content: FILE_CONTENT,
      size: FILE_CONTENT.length,
      modifiedAt: Date.now(),
      extension: 'md',
    });
    const view = renderPane(makeItem({ filePath: '/repo/doc.md' }));
    await waitFor(() => expect(view.container.querySelector('pre')).toBeTruthy());
    const { scrollContainer } = prepareScrollGeometry(view.container);
    const location = { line: 100 };

    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({ filePath: '/repo/doc.md', sourceLocation: location })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(scrollContainer.scrollTop).toBeGreaterThan(0));

    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({ filePath: '/repo/doc.md', sourceLocation: location, viewMode: 'rendered' })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    scrollContainer.scrollTop = 0;
    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({ filePath: '/repo/doc.md', sourceLocation: location })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(scrollContainer.scrollTop).toBeGreaterThan(0));
  });

  it('does not reinterpret a failed numeric-colon path as another file', async () => {
    const rawPath = '/repo/report:2024';
    const statFile = vi.fn(async (filePath: string) => (filePath === rawPath ? null : { size: 10, modifiedAt: 1 }));
    const readFilePreview = vi.fn().mockResolvedValue(textFile('wrong file'));
    H.mockGetElectron.mockReturnValue({ statFile, readFilePreview });

    const { container } = renderPane(makeItem({ filePath: rawPath, title: 'report:2024' }));
    await waitFor(() => expect(container.textContent).toContain('File is not readable'));
    expect(statFile).toHaveBeenCalledTimes(1);
    expect(statFile).toHaveBeenCalledWith(rawPath);
    expect(readFilePreview).not.toHaveBeenCalled();
  });

  it('re-resolves changed source candidates and re-navigates repeated source links', async () => {
    const cleanPath = '/repo/src/foo.ts';
    const firstRawPath = `${cleanPath}:100`;
    const secondRawPath = `${cleanPath}:200`;
    const statFile = vi.fn(async (filePath: string) => (
      filePath === cleanPath ? { size: FILE_CONTENT.length, modifiedAt: 1 } : null
    ));
    H.mockGetElectron.mockReturnValue({
      statFile,
      readFilePreview: vi.fn().mockResolvedValue(textFile(FILE_CONTENT, 'ts')),
    });

    const view = renderPane(makeItem({
      filePath: cleanPath,
      sourceLocation: { line: 100 },
      sourceReferencePath: firstRawPath,
    }));
    await waitFor(() => expect(view.container.querySelector('pre')).toBeTruthy());
    let geometry = prepareScrollGeometry(view.container);

    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({
          filePath: cleanPath,
          sourceLocation: { line: 100 },
          sourceReferencePath: firstRawPath,
        })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(geometry.scrollContainer.scrollTop).toBeGreaterThan(0));
    const firstLineTop = geometry.scrollContainer.scrollTop;

    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({
          filePath: cleanPath,
          sourceLocation: { line: 200 },
          sourceReferencePath: secondRawPath,
        })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(statFile).toHaveBeenCalledWith(secondRawPath));
    await waitFor(() => expect(view.container.querySelector('pre')).toBeTruthy());
    geometry = prepareScrollGeometry(view.container);
    view.rerender(
      <H.ChatNodeStoreContext.Provider value={{ getNode: () => undefined }}>
        <FilePane item={makeItem({
          filePath: cleanPath,
          sourceLocation: { line: 200 },
          sourceReferencePath: secondRawPath,
        })} />
      </H.ChatNodeStoreContext.Provider>,
    );
    await waitFor(() => expect(geometry.scrollContainer.scrollTop).toBeGreaterThan(firstLineTop));
    expect(statFile.mock.calls.map(([filePath]) => filePath)).toEqual([
      firstRawPath,
      cleanPath,
      secondRawPath,
      cleanPath,
    ]);
  });

  it('says a binary file cannot be previewed instead of showing its bytes', async () => {
    H.mockGetElectron.mockReturnValue({
      statFile: vi.fn().mockResolvedValue({ size: 5, modifiedAt: 1 }),
      readFilePreview: vi.fn().mockResolvedValue(null),
    });

    const { container } = renderPane(makeItem({ filePath: '/repo/out/app.zip', title: 'app.zip' }));
    await waitFor(() => expect(container.textContent).toContain('This binary file cannot be previewed.'));
    expect(container.querySelector('pre')).toBeNull();
  });

  it('treats a Windows UNC path as local and opens it unchanged', async () => {
    const filePath = '\\\\server\\share\\foo.ts';
    const openPath = vi.fn();
    const readFilePreview = vi.fn().mockResolvedValue(textFile('content', 'ts'));
    H.mockGetElectron.mockReturnValue({
      statFile: vi.fn().mockResolvedValue({ size: 7, modifiedAt: 1 }),
      readFilePreview,
      openPath,
    });

    const { container, getByRole } = renderPane(makeItem({ filePath, title: 'foo.ts' }));
    await waitFor(() => expect(container.querySelector('pre')?.textContent).toBe('content'));
    expect(readFilePreview).toHaveBeenCalledWith(filePath);
    fireEvent.click(getByRole('button', { name: 'Open externally' }));
    expect(openPath).toHaveBeenCalledWith(filePath);
  });

  it('reads an absolute path itself before the workspace has loaded', async () => {
    const readFilePreview = vi.fn().mockResolvedValue(textFile('outside', 'ts'));
    H.mockGetElectron.mockReturnValue({
      statFile: vi.fn().mockResolvedValue({ size: 7, modifiedAt: 1 }),
      readFilePreview,
    });

    const { container } = renderPane(makeItem({ projectId: 'p-not-loaded', filePath: '/elsewhere/foo.ts' }));
    await waitFor(() => expect(container.querySelector('pre')?.textContent).toBe('outside'));
    expect(readFilePreview).toHaveBeenCalledWith('/elsewhere/foo.ts');
    expect(H.mockFetchArtifactContent).not.toHaveBeenCalled();
  });

  it('asks the remote for a remote workspace that has not loaded yet', async () => {
    const readFilePreview = vi.fn();
    H.mockGetElectron.mockReturnValue({ statFile: vi.fn(), readFilePreview });

    renderPane(makeItem({ projectId: 'remote:backend-1:p9', filePath: '/srv/foo.ts' }));
    await waitFor(() => expect(H.mockFetchArtifactContent).toHaveBeenCalledWith('remote:backend-1:p9', '/srv/foo.ts', true));
    expect(readFilePreview).not.toHaveBeenCalled();
  });
});
