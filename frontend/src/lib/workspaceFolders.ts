/**
 * A workspace's folder rules: at most MAX_WORKSPACE_FOLDERS, none inside
 * another. Pickers return native paths, so Windows paths use '\' and a
 * drive letter or UNC prefix in any case.
 */
export const MAX_WORKSPACE_FOLDERS = 10;

export const FOLDER_OVERLAP_MESSAGE = 'This folder overlaps with an existing folder (nested or parent)';

export type FolderConflict = 'duplicate' | 'overlap';

function comparablePath(path: string): string {
  let p = path.trim().replace(/\\/g, '/');
  while (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  return /^([A-Za-z]:|\/\/)/.test(p) ? p.toLowerCase() : p;
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/** How `candidate` collides with a folder the workspace has; null when it does not. */
export function folderConflict(candidate: string, existing: readonly { path: string }[]): FolderConflict | null {
  const path = comparablePath(candidate);
  let overlap = false;
  for (const folder of existing) {
    const other = comparablePath(folder.path);
    if (other === path) return 'duplicate';
    if (isInside(path, other) || isInside(other, path)) overlap = true;
  }
  return overlap ? 'overlap' : null;
}

export function pathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Which picks join `existing`, in order: the ones that fit under the limit
 * and collide with nothing already there or taken before them.
 */
export function appendFolders<T extends { path: string }>(existing: readonly { path: string }[], picks: readonly T[]): {
  added: T[];
  skipped: { pick: T; reason: FolderConflict }[];
  limitHit: boolean;
} {
  const added: T[] = [];
  const skipped: { pick: T; reason: FolderConflict }[] = [];
  for (const pick of picks) {
    if (existing.length + added.length >= MAX_WORKSPACE_FOLDERS) return { added, skipped, limitHit: true };
    const reason = folderConflict(pick.path, [...existing, ...added]);
    if (reason) skipped.push({ pick, reason });
    else added.push(pick);
  }
  return { added, skipped, limitHit: false };
}
