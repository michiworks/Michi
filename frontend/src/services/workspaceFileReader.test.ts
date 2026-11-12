import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ fetchArtifactContent: vi.fn(), getElectron: vi.fn() }));
vi.mock('./api', () => ({ fetchArtifactContent: H.fetchArtifactContent }));
vi.mock('../lib/electronBridge', () => ({ getElectron: H.getElectron }));

import { readWorkspaceFile } from './workspaceFileReader';

const text = { kind: 'text' as const, content: 'hello', size: 5, modifiedAt: 1, extension: 'md' };

function desktop(overrides: Record<string, unknown> = {}) {
  const bridge = {
    statFile: vi.fn().mockResolvedValue({ size: 5, modifiedAt: 1 }),
    readFilePreview: vi.fn().mockResolvedValue(text),
    ...overrides,
  };
  H.getElectron.mockReturnValue(bridge);
  return bridge;
}

beforeEach(() => {
  H.fetchArtifactContent.mockReset();
  H.getElectron.mockReset();
  H.getElectron.mockReturnValue(null);
});

describe('readWorkspaceFile', () => {
  it('reads a local absolute path in the desktop app, Windows paths included', async () => {
    const bridge = desktop();
    await expect(readWorkspaceFile({ workspaceId: 'p1', local: true, path: 'C:\\Users\\me\\a.md' })).resolves.toEqual(text);
    expect(bridge.readFilePreview).toHaveBeenCalledWith('C:\\Users\\me\\a.md');
    expect(H.fetchArtifactContent).not.toHaveBeenCalled();
  });

  it('tells a missing, a too large and a binary file apart', async () => {
    desktop({ statFile: vi.fn().mockResolvedValue(null) });
    await expect(readWorkspaceFile({ workspaceId: 'p1', local: true, path: '/repo/gone.md' })).rejects.toThrow('File is not readable');
    desktop({ statFile: vi.fn().mockResolvedValue({ size: 6 * 1024 * 1024, modifiedAt: 1 }) });
    await expect(readWorkspaceFile({ workspaceId: 'p1', local: true, path: '/repo/big.log' })).rejects.toThrow('File is too large (6.0 MB)');
    desktop({ readFilePreview: vi.fn().mockResolvedValue(null) });
    await expect(readWorkspaceFile({ workspaceId: 'p1', local: true, path: '/repo/app.zip' })).rejects.toThrow('This binary file cannot be previewed.');
  });

  it('reads relative, remote and browser paths through the backend preview, images as images', async () => {
    H.fetchArtifactContent.mockResolvedValue({ content: 'data:image/png;base64,AA==', imageMime: 'image/png', path: 'a.PNG', basename: 'a.PNG', extension: 'PNG', size: 1, modifiedAt: 2 });
    await expect(readWorkspaceFile({ workspaceId: 'p1', local: true, path: '/repo/a.PNG' })).resolves.toEqual({
      kind: 'image', dataUrl: 'data:image/png;base64,AA==', size: 1, modifiedAt: 2, extension: 'png',
    });
    const bridge = desktop();
    await readWorkspaceFile({ workspaceId: 'p1', local: true, path: 'docs/a.md' });
    await readWorkspaceFile({ workspaceId: 'p2', local: false, path: '/srv/a.md' });
    expect(bridge.readFilePreview).not.toHaveBeenCalled();
    expect(H.fetchArtifactContent.mock.calls).toEqual([
      ['p1', '/repo/a.PNG', true],
      ['p1', 'docs/a.md', true],
      ['p2', '/srv/a.md', true],
    ]);
  });
});
