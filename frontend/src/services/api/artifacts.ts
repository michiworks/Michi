import { serverEntityId } from '../../config/backendIdentity';
import { backendFetch } from './backendRequest';
import { workspaceBackendApiBase } from '../../config/backendConnections';
import { downloadBlob } from '../../lib/download';
import { HttpResponseError } from './httpError';

// ----- Artifact file reader -----

export interface ArtifactReadResult {
  content: string;
  imageMime?: string;
  path: string;
  basename: string;
  extension: string;
  size: number;
  modifiedAt: number;
}

/** A failed read, with the HTTP status: 404 is a missing file, 413 one over the 5 MB limit. */
export class ArtifactReadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ArtifactReadError';
  }
}

export async function fetchArtifactContent(
  workspaceId: string,
  filePath: string,
  preview = false,
  signal?: AbortSignal,
): Promise<ArtifactReadResult> {
  const url = `${workspaceBackendApiBase(workspaceId)}/artifacts/${encodeURIComponent(serverEntityId(workspaceId))}/read?path=${encodeURIComponent(filePath)}${preview ? '&preview=1' : ''}`;
  const res = signal ? await backendFetch(url, { signal }) : await backendFetch(url);
  if (!res.ok) {
    // Missing and out-of-workspace files are bodyless 404s.
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ArtifactReadError(body?.error || (res.status === 404
      ? `File not found in this workspace: ${filePath}`
      : `Failed to load file (status ${res.status})`), res.status);
  }
  return res.json() as Promise<ArtifactReadResult>;
}

export type ArtifactHead =
  | { status: 'ok'; text: string }
  | { status: 'missing' }
  | { status: 'error' };

/**
 * The first `bytes` of a workspace file, for its title. A Range request on
 * the download route; reading stops at `bytes` even when a server sends the
 * whole file. A 404 is a file that is gone (or outside the workspace).
 */
export async function fetchArtifactHead(
  workspaceId: string,
  filePath: string,
  bytes = 4096,
  signal?: AbortSignal,
): Promise<ArtifactHead> {
  const url = `${workspaceBackendApiBase(workspaceId)}/artifacts/${encodeURIComponent(serverEntityId(workspaceId))}/download?path=${encodeURIComponent(filePath)}`;
  let response: Response;
  try {
    response = await backendFetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, signal });
  } catch {
    return { status: 'error' };
  }
  if (response.status === 404) return { status: 'missing' };
  if (!response.ok || !response.body) return { status: 'error' };
  const reader = response.body.getReader();
  const head = new Uint8Array(bytes);
  let length = 0;
  try {
    while (length < bytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, bytes - length);
      head.set(value.subarray(0, take), length);
      length += take;
    }
  } catch {
    return { status: 'error' };
  } finally {
    void reader.cancel().catch(() => {});
  }
  return { status: 'ok', text: new TextDecoder().decode(head.subarray(0, length)) };
}

// ----- Artifact live-refresh watch channel -----
//
// A persistent SSE channel notifies an open FilePane that a watched file
// changed on disk (from any source). `useArtifactWatch` opens the stream and
// declares which paths to watch; the backend maps changes back to the stored
// path so the frontend can string-match against open panes.

/** Persistent SSE endpoint for a workspace's artifact-change notifications. */
export function artifactWatchStreamUrl(workspaceId: string): string {
  return `${workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(serverEntityId(workspaceId))}/watch/stream`;
}

/**
 * Declare/replace the set of stored paths to watch for a workspace. Returns the
 * subset the backend accepted (paths escaping the cwd sandbox are dropped).
 * Idempotent — safe to re-declare on every stream `open` and registry change.
 */
export async function postArtifactWatchPaths(
  workspaceId: string,
  paths: string[],
): Promise<string[]> {
  const url = `${workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(serverEntityId(workspaceId))}/watch`;
  const res = await backendFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) {
    throw new Error(`Failed to declare artifact watch paths: ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as { watching?: string[] };
  return body.watching ?? [];
}

export interface WorkspaceDiff {
  diff: string;
  truncated: boolean;
}

/** A file's working-tree diff (or its last commit's); a non-ok status is an HttpResponseError for the caller to word. */
export async function fetchWorkspaceDiff(workspaceId: string, filePath: string, signal?: AbortSignal): Promise<WorkspaceDiff> {
  const response = await backendFetch(
    `${workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(serverEntityId(workspaceId))}/diff?path=${encodeURIComponent(filePath)}`,
    { signal },
  );
  if (!response.ok) throw new HttpResponseError(`Diff request failed (${response.status})`, response.status);
  const body = (await response.json()) as { diff: string; truncated?: boolean };
  return { diff: body.diff, truncated: !!body.truncated };
}

/** Authenticated download also works for remote gateways requiring headers. */
export async function downloadArtifactFile(workspaceId: string, filePath: string): Promise<void> {
  const url = `${workspaceBackendApiBase(workspaceId)}/artifacts/${encodeURIComponent(serverEntityId(workspaceId))}/download?path=${encodeURIComponent(filePath)}`;
  const response = await backendFetch(url);
  if (!response.ok) throw new Error(`Could not download file (${response.status})`);
  downloadBlob(await response.blob(), filePath.split('/').pop() || 'artifact');
}

export function artifactImageUrl(workspaceId: string, filePath: string): string {
  return `${workspaceBackendApiBase(workspaceId)}/files/${encodeURIComponent(serverEntityId(workspaceId))}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Image URL for an uploaded attachment, from its relPath or else the
 *  .attachments/ part of its absPath. Always the backend /files route:
 *  file:// URLs are blocked when the renderer loads from http://. */
export function attachmentImageUrl(workspaceId: string | undefined, attachment: { absPath: string; relPath?: string }): string | null {
  if (!workspaceId) return null;
  if (attachment.relPath) return artifactImageUrl(workspaceId, attachment.relPath);
  const marker = '/.attachments/';
  const idx = attachment.absPath.indexOf(marker);
  return idx === -1 ? null : artifactImageUrl(workspaceId, `.attachments/${attachment.absPath.slice(idx + marker.length)}`);
}
