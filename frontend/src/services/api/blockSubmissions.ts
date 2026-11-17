import { blockSubmissionHostKey, readApiError, type BlockSubmission, type BlockSubmissionHost } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { serverEntityId } from '../../config/backendIdentity';
import { backendFetch } from './backendRequest';
import { PageApiError, pageApiError } from './pages';

/**
 * Interactive block submissions on the backend `connectionId` names. Values
 * are the person's own answers, opaque to the id mapping: requests and
 * answers are not mapped by field name, and the host's ids are given to the
 * server as its own here.
 */

function serverHost(host: BlockSubmissionHost, connectionId: string): BlockSubmissionHost {
  return host.kind === 'page'
    ? { kind: 'page', pageId: serverEntityId(host.pageId, connectionId) }
    : { kind: 'chat', nodeId: serverEntityId(host.nodeId, connectionId), messageId: serverEntityId(host.messageId, connectionId) };
}

const workspacePath = (connectionId: string, workspaceId: string) =>
  `${backendApiBase(connectionId)}/workspaces/${encodeURIComponent(serverEntityId(workspaceId, connectionId))}/block-submissions`;

export async function listBlockSubmissions(connectionId: string, workspaceId: string, host: BlockSubmissionHost, signal?: AbortSignal): Promise<BlockSubmission[]> {
  const query = new URLSearchParams({ host: blockSubmissionHostKey(serverHost(host, connectionId)) });
  const response = await backendFetch(`${workspacePath(connectionId, workspaceId)}?${query}`, { signal }, { mapPayload: false });
  if (!response.ok) throw await pageApiError(response, 'block_submissions_failed', 'Block submissions');
  const body = await response.json() as { submissions?: BlockSubmission[] };
  return Array.isArray(body.submissions) ? body.submissions : [];
}

/** `created`: stored now. `exists`: the block already had one for this signature, which comes back instead. */
export type BlockSubmissionWrite = { status: 'created' | 'exists'; submission: BlockSubmission };

export async function createBlockSubmission(connectionId: string, workspaceId: string, input: {
  host: BlockSubmissionHost; blockId: string; signature: string; value: unknown; text: string;
}, signal?: AbortSignal): Promise<BlockSubmissionWrite> {
  const response = await backendFetch(workspacePath(connectionId, workspaceId), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ ...input, host: serverHost(input.host, connectionId) }),
  }, { mapPayload: false });
  if (response.status !== 201 && response.status !== 409) throw await pageApiError(response, 'block_submission_failed', 'Block submission');
  const body = await response.json().catch(() => null) as { code?: string; submission?: BlockSubmission } | null;
  if (body?.submission && (response.status === 201 || body.code === 'already_submitted')) {
    return { status: response.status === 201 ? 'created' : 'exists', submission: body.submission };
  }
  const { code, message } = readApiError(body);
  throw new PageApiError(response.status, code ?? 'block_submission_failed', message ?? `Block submission request failed (${response.status})`);
}
