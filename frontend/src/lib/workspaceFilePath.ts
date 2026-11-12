import type { ArtifactEntry, Project } from '../state/chatTypes';

type HostProject = Pick<Project, 'cwd' | 'backendConnectionId'>;

/** A POSIX, Windows drive-letter or UNC path. */
export function isAbsoluteFilePath(filePath: string): boolean {
  const isUncPath = filePath.length >= 2 && filePath[0] === '\\' && filePath[1] === '\\';
  return filePath.startsWith('/') || isUncPath || /^[a-zA-Z]:[\\/]/.test(filePath);
}

/**
 * Where a workspace file is on this machine: an absolute path as is, a
 * relative one under the cwd. None for a remote workspace, whose paths name
 * files on its host, or for a relative path without a cwd.
 */
export function hostPathFor(filePath: string, project: HostProject | null | undefined): string | null {
  if (project?.backendConnectionId) return null;
  if (isAbsoluteFilePath(filePath)) return filePath;
  return project?.cwd ? `${project.cwd.replace(/[\\/]$/, '')}/${filePath}` : null;
}

/** hostPathFor an artifact's file. A reference stores the path it was added from. */
export function artifactHostPath(artifact: Pick<ArtifactEntry, 'filePath' | 'kind'>, project: HostProject | null | undefined): string | null {
  if (!artifact.filePath) return null;
  if (artifact.kind === 'reference') return project?.backendConnectionId ? null : artifact.filePath;
  return hostPathFor(artifact.filePath, project);
}

/** The folder that holds a file, for either separator; a root keeps its separator. */
export function parentDirectory(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (cut < 0) return filePath;
  const directory = filePath.slice(0, cut);
  return directory === '' || /^[a-zA-Z]:$/.test(directory) ? filePath.slice(0, cut + 1) : directory;
}
