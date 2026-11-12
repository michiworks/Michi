import { fetchArtifactContent } from './api';
import { getElectron, type FilePreviewResult } from '../lib/electronBridge';
import { isAbsoluteFilePath } from '../lib/workspaceFilePath';
import { formatBytes } from '../lib/formatBytes';

/** The largest file a viewer shows; the backend read route and Electron's preview reader stop at the same size. */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

export function fileTooLargeMessage(size: number): string {
  return `File is too large (${formatBytes(size)})`;
}

/**
 * Read a workspace file for a viewer: text, or an image as a data URL.
 * Binary files and files over MAX_PREVIEW_BYTES are refused with a message.
 *
 * The desktop app reads an absolute path of a local workspace itself, so a
 * file outside the workspace (a reference, or a symlink's target) opens.
 * Everything else goes through the backend's preview read, which resolves
 * a relative path in the workspace.
 */
export async function readWorkspaceFile({ workspaceId, local, path }: {
  workspaceId: string;
  /** The workspace lives on this machine's backend, not a remote gateway. */
  local: boolean;
  path: string;
}): Promise<FilePreviewResult> {
  const electron = getElectron();
  if (local && isAbsoluteFilePath(path) && electron?.readFilePreview) {
    // readFilePreview answers null for every refusal; the stat tells them apart.
    const stat = await electron.statFile?.(path);
    if (stat === null) throw new Error('File is not readable');
    if (stat && stat.size > MAX_PREVIEW_BYTES) throw new Error(fileTooLargeMessage(stat.size));
    const result = await electron.readFilePreview(path);
    if (!result) throw new Error('This binary file cannot be previewed.');
    return result;
  }
  const result = await fetchArtifactContent(workspaceId, path, true);
  const file = { size: result.size, modifiedAt: result.modifiedAt, extension: result.extension.toLowerCase() };
  return result.imageMime
    ? { kind: 'image', dataUrl: result.content, ...file }
    : { kind: 'text', content: result.content, ...file };
}
