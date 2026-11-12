import { describe, expect, it } from 'vitest';
import type { ArtifactEntry } from '../../../state/chatTypes';
import { planArtifactOpen } from './artifactOpen';

function artifact(overrides: Partial<ArtifactEntry>): ArtifactEntry {
  return { id: 'a1', name: 'a', filePath: 'notes.md', source: 'user', createdAt: 1, updatedAt: 1, ...overrides };
}

const local = { id: 'p1', cwd: '/cwd' };
const remote = { id: 'p1', cwd: '/cwd', backendConnectionId: 'remote-1' };
const desktop = { project: local, missing: false, hasDesktop: true };

describe('planArtifactOpen', () => {
  it.each<[string, Partial<ArtifactEntry>, ReturnType<typeof planArtifactOpen>]>([
    ['a link opens its URL', { type: 'link', filePath: '', url: 'https://example.com' }, { kind: 'url', url: 'https://example.com' }],
    ['an embedded doc opens in a pane', { type: 'doc', filePath: '.artifacts/brief.md' },
      { kind: 'pane', path: '.artifacts/brief.md', external: '/cwd/.artifacts/brief.md', confirmLarge: false }],
    ['a legacy row without a type is a doc by its path', { filePath: 'notes.md' },
      { kind: 'pane', path: 'notes.md', external: '/cwd/notes.md', confirmLarge: false }],
    ['the stored type wins over the path', { type: 'doc', filePath: 'README' },
      { kind: 'pane', path: 'README', external: '/cwd/README', confirmLarge: false }],
    ['a symlink doc opens at its absolute path', { type: 'doc', kind: 'symlink', filePath: '.artifacts/x.md' },
      { kind: 'pane', path: '/cwd/.artifacts/x.md', external: '/cwd/.artifacts/x.md', confirmLarge: true }],
    ['a POSIX reference doc opens as stored', { type: 'doc', kind: 'reference', filePath: '/Users/me/a.md' },
      { kind: 'pane', path: '/Users/me/a.md', external: '/Users/me/a.md', confirmLarge: true }],
    ['a Windows reference doc opens as stored', { type: 'doc', kind: 'reference', filePath: 'C:\\Users\\me\\a.md' },
      { kind: 'pane', path: 'C:\\Users\\me\\a.md', external: 'C:\\Users\\me\\a.md', confirmLarge: true }],
    ['a UNC reference doc opens as stored', { type: 'doc', kind: 'reference', filePath: '\\\\srv\\share\\a.md' },
      { kind: 'pane', path: '\\\\srv\\share\\a.md', external: '\\\\srv\\share\\a.md', confirmLarge: true }],
    ['a reference image goes to the OS opener', { type: 'image', kind: 'reference', filePath: '/Users/me/a.png' },
      { kind: 'os', path: '/Users/me/a.png' }],
    ['an embedded image opens in the lightbox', { type: 'image', filePath: '.attachments/shot.png' }, { kind: 'lightbox', workspaceId: 'p1' }],
    ['an image without a preview format downloads', { type: 'image', filePath: '.attachments/shot.heic' }, { kind: 'download', workspaceId: 'p1' }],
    ['an HTML file opens in the drawer preview', { type: 'file', filePath: 'mocks/a.html' }, { kind: 'web-preview' }],
    ['a PDF downloads', { type: 'file', filePath: 'out/report.pdf' }, { kind: 'download', workspaceId: 'p1' }],
  ])('%s', (_name, overrides, expected) => {
    expect(planArtifactOpen(artifact(overrides), desktop)).toEqual(expected);
  });

  it('opens the missing note for a file that is gone', () => {
    expect(planArtifactOpen(artifact({ type: 'file', filePath: 'mocks/a.html' }), { ...desktop, missing: true })).toEqual({ kind: 'missing' });
  });

  it('opens a reference doc in a pane without the desktop app', () => {
    expect(planArtifactOpen(artifact({ type: 'doc', kind: 'reference', filePath: '/Users/me/a.md' }), { ...desktop, hasDesktop: false }))
      .toEqual({ kind: 'pane', path: '/Users/me/a.md', external: '/Users/me/a.md', confirmLarge: true });
  });

  it('reads a remote workspace\'s symlink doc on its host', () => {
    expect(planArtifactOpen(artifact({ type: 'doc', kind: 'symlink', filePath: '.artifacts/x.md' }), { ...desktop, project: remote }))
      .toEqual({ kind: 'pane', path: '.artifacts/x.md', external: null, confirmLarge: true });
  });

  it.each([
    ['without the desktop app', { ...desktop, hasDesktop: false }],
    ['in a remote workspace', { ...desktop, project: remote }],
  ])('sends a reference file to its desktop host %s', (_name, context) => {
    expect(planArtifactOpen(artifact({ type: 'file', kind: 'reference', filePath: '/Users/me/a.zip' }), context))
      .toEqual({ kind: 'unavailable', message: 'Open this reference on its desktop host' });
  });
});
