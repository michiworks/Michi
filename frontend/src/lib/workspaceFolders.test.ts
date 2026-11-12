import { describe, expect, it } from 'vitest';
import { appendFolders, folderConflict, MAX_WORKSPACE_FOLDERS, pathBasename } from './workspaceFolders';

const entries = (...paths: string[]) => paths.map((path) => ({ path }));

describe('folderConflict', () => {
  it('rejects the same folder, a child and a parent, and keeps a sibling', () => {
    expect(folderConflict('/a/b', entries('/a/b'))).toBe('duplicate');
    expect(folderConflict('/a/b/c', entries('/a/b'))).toBe('overlap');
    expect(folderConflict('/a', entries('/a/b'))).toBe('overlap');
    expect(folderConflict('/a/bc', entries('/a/b'))).toBeNull();
    expect(folderConflict('/x', [])).toBeNull();
  });

  it('reads Windows paths, whatever their case or separator', () => {
    expect(folderConflict('C:\\Users\\me\\proj\\sub', entries('C:\\Users\\me\\proj'))).toBe('overlap');
    expect(folderConflict('C:\\Users\\me', entries('C:\\Users\\me\\proj'))).toBe('overlap');
    expect(folderConflict('c:\\users\\ME\\proj', entries('C:\\Users\\me\\proj'))).toBe('duplicate');
    expect(folderConflict('C:/Users/me/proj', entries('C:\\Users\\me\\proj\\'))).toBe('duplicate');
    expect(folderConflict('C:\\Users\\me\\project', entries('C:\\Users\\me\\proj'))).toBeNull();
    expect(folderConflict('\\\\server\\share\\a', entries('\\\\SERVER\\share'))).toBe('overlap');
  });

  it('ignores a trailing separator on a stored folder', () => {
    expect(folderConflict('/srv/app/sub', entries('/srv/app/'))).toBe('overlap');
    expect(folderConflict('/srv/app', entries('/srv/app/'))).toBe('duplicate');
  });
});

describe('pathBasename', () => {
  it('takes the last segment on either separator', () => {
    expect(pathBasename('/home/me/proj')).toBe('proj');
    expect(pathBasename('C:\\Users\\me\\proj')).toBe('proj');
    expect(pathBasename('/srv/app/')).toBe('app');
    expect(pathBasename('browser-project')).toBe('browser-project');
  });
});

describe('appendFolders', () => {
  it('counts only the folders it takes against the limit', () => {
    const existing = entries(...Array.from({ length: MAX_WORKSPACE_FOLDERS - 2 }, (_, i) => `/w/${i}`));
    const plan = appendFolders(existing, entries('/w/0', '/w/1/sub', '/new', '/new/inner'));
    expect(plan.added.map((pick) => pick.path)).toEqual(['/new']);
    expect(plan.skipped).toEqual([
      { pick: { path: '/w/0' }, reason: 'duplicate' },
      { pick: { path: '/w/1/sub' }, reason: 'overlap' },
      { pick: { path: '/new/inner' }, reason: 'overlap' },
    ]);
    expect(plan.limitHit).toBe(false);
  });

  it('stops at the limit', () => {
    const existing = entries(...Array.from({ length: MAX_WORKSPACE_FOLDERS - 1 }, (_, i) => `/w/${i}`));
    const plan = appendFolders(existing, entries('/x', '/y'));
    expect(plan.added.map((pick) => pick.path)).toEqual(['/x']);
    expect(plan.limitHit).toBe(true);
  });
});
