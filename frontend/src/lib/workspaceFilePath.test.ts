import { describe, expect, it } from 'vitest';
import type { ArtifactEntry } from '../state/chatTypes';
import { artifactHostPath, hostPathFor, isAbsoluteFilePath, parentDirectory } from './workspaceFilePath';

function artifact(overrides: Partial<ArtifactEntry> = {}): ArtifactEntry {
  return { id: 'a1', name: 'notes', filePath: 'docs/notes.md', source: 'user', createdAt: 1, updatedAt: 1, ...overrides };
}

describe('isAbsoluteFilePath', () => {
  it.each([
    ['/repo/a.md', true],
    ['C:\\Users\\me\\a.md', true],
    ['c:/Users/me/a.md', true],
    ['\\\\srv\\share\\a.md', true],
    ['docs/a.md', false],
    ['.artifacts/a.md', false],
    ['C:a.md', false],
    ['', false],
  ])('%s → %s', (filePath, expected) => {
    expect(isAbsoluteFilePath(filePath)).toBe(expected);
  });
});

describe('hostPathFor', () => {
  it('keeps an absolute path and joins a relative one onto the cwd', () => {
    expect(hostPathFor('C:\\Users\\me\\a.md', { cwd: 'C:\\proj' })).toBe('C:\\Users\\me\\a.md');
    expect(hostPathFor('\\\\srv\\share\\a.md', { cwd: '/repo' })).toBe('\\\\srv\\share\\a.md');
    expect(hostPathFor('docs/a.md', { cwd: '/repo/' })).toBe('/repo/docs/a.md');
    expect(hostPathFor('docs/a.md', { cwd: 'C:\\proj\\' })).toBe('C:\\proj/docs/a.md');
  });

  it('has no host path for a relative file without a cwd', () => {
    expect(hostPathFor('docs/a.md', {})).toBeNull();
    expect(hostPathFor('docs/a.md', undefined)).toBeNull();
    expect(hostPathFor('/repo/a.md', undefined)).toBe('/repo/a.md');
  });

  it('has no host path in a remote workspace: its files are on the other machine', () => {
    expect(hostPathFor('/repo/a.md', { cwd: '/repo', backendConnectionId: 'remote-1' })).toBeNull();
    expect(hostPathFor('docs/a.md', { cwd: '/repo', backendConnectionId: 'remote-1' })).toBeNull();
  });
});

describe('artifactHostPath', () => {
  it('returns a reference path as stored', () => {
    expect(artifactHostPath(artifact({ kind: 'reference', filePath: 'C:\\Users\\me\\a.md' }), { cwd: 'C:\\proj' })).toBe('C:\\Users\\me\\a.md');
  });

  it('resolves a symlink artifact onto the cwd', () => {
    expect(artifactHostPath(artifact({ kind: 'symlink', filePath: '.artifacts/x.md' }), { cwd: '/cwd' })).toBe('/cwd/.artifacts/x.md');
  });

  it('has none for a link or a remote workspace', () => {
    expect(artifactHostPath(artifact({ type: 'link', filePath: '', url: 'https://example.com' }), { cwd: '/cwd' })).toBeNull();
    expect(artifactHostPath(artifact({ kind: 'reference', filePath: '/Users/me/a.md' }), { cwd: '/cwd', backendConnectionId: 'remote-1' })).toBeNull();
  });
});

describe('parentDirectory', () => {
  it.each([
    ['/Users/me/a.md', '/Users/me'],
    ['/a.md', '/'],
    ['C:\\Users\\me\\a.md', 'C:\\Users\\me'],
    ['C:\\a.md', 'C:\\'],
    ['\\\\srv\\share\\a.md', '\\\\srv\\share'],
  ])('%s → %s', (filePath, expected) => {
    expect(parentDirectory(filePath)).toBe(expected);
  });
});
