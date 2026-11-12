import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ArtifactEntry, Project } from '../../state/chatTypes';

const H = vi.hoisted(() => ({
  fetchArtifactContent: vi.fn(),
  getElectron: vi.fn(),
  project: null as unknown as Project,
}));

vi.mock('../../services/api', () => ({ fetchArtifactContent: H.fetchArtifactContent }));
vi.mock('../../lib/electronBridge', () => ({ getElectron: H.getElectron }));
vi.mock('../../hooks/usePaneShellStyle', () => ({ usePaneShellStyle: () => ({}) }));
vi.mock('./useSideColumn', () => ({ useSideColumn: () => ({ columns: '1fr 200px', columnRef: { current: null }, handle: null }) }));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock('../../state/chatStore', () => ({
  useChatProjects: () => ({ projects: [H.project] }),
  useChatActions: () => ({ focusPane: vi.fn(), setFocusedNodeId: vi.fn() }),
}));

import FilesPane from './FilesPane';

function artifact(overrides: Partial<ArtifactEntry>): ArtifactEntry {
  return { id: 'a1', name: 'shot', filePath: '.attachments/shot.png', type: 'image', source: 'user', createdAt: 1, updatedAt: 1, ...overrides };
}

function renderWith(artifacts: ArtifactEntry[]) {
  H.project = { id: 'p1', name: 'P', cwd: '/repo', chatIds: [], edges: [], createdAt: 1, trees: [], activeTreeId: null, artifacts };
  render(<FilesPane item={{ id: 'pane:files:1', kind: 'files', projectId: 'p1', title: 'Files', createdAt: 1 } as never} />);
}

beforeEach(() => {
  H.fetchArtifactContent.mockReset();
  H.getElectron.mockReset();
  H.getElectron.mockReturnValue(undefined);
});

describe('FilesPane preview in a browser session', () => {
  it('shows an image artifact as an image', async () => {
    H.fetchArtifactContent.mockResolvedValue({
      content: 'data:image/png;base64,iVBORw0KGgo=', imageMime: 'image/png', path: '.attachments/shot.png',
      basename: 'shot.png', extension: 'png', size: 8, modifiedAt: 1,
    });
    renderWith([artifact({})]);
    fireEvent.click(screen.getByRole('button', { name: 'shot' }));
    const image = await screen.findByRole('img', { name: 'shot' });
    expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(H.fetchArtifactContent).toHaveBeenCalledWith('p1', '/repo/.attachments/shot.png', true);
  });

  it('reads a reference outside the workspace through the backend preview', async () => {
    H.fetchArtifactContent.mockResolvedValue({
      content: '# Notes', path: '/Users/me/notes.md', basename: 'notes.md', extension: 'md', size: 7, modifiedAt: 1,
    });
    renderWith([artifact({ name: 'notes', filePath: '/Users/me/notes.md', type: 'doc', kind: 'reference' })]);
    fireEvent.click(screen.getByRole('button', { name: 'notes' }));
    expect(await screen.findByText('# Notes')).toBeTruthy();
    expect(H.fetchArtifactContent).toHaveBeenCalledWith('p1', '/Users/me/notes.md', true);
  });
});

describe('FilesPane filter', () => {
  it('is the shared search field, so keyboard focus shows its ring', () => {
    renderWith([]);
    const input = screen.getByRole('textbox', { name: 'Filter files' });
    expect(input.closest('label')?.className).toBe('ui-search ui-search--compact');
    expect(input.getAttribute('style')).toBeNull();
  });
});
