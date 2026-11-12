import { backendFetch } from './backendRequest';
import { activeBackendApiBase, backendApiBase, workspaceBackendApiBase } from '../../config/backendConnections';

// ── Node-grouped search types ──

export interface NodeGroupedSnippet {
  messageId: string;
  role: 'user' | 'assistant';
  snippet: string;
}

export interface NodeGroupedResult {
  nodeId: string;
  nodeTitle: string | null;
  workspaceId: string;
  workspaceName: string;
  treeId: string | null;
  lastMessageAt: number;
  totalMatches: number;
  breadcrumb: string[];
  snippets: NodeGroupedSnippet[];
}

export async function searchNodesGrouped(
  query: string,
  workspaceId?: string,
  limit = 30,
  options?: { connectionId?: string; signal?: AbortSignal },
): Promise<{ results: NodeGroupedResult[]; totalNodes: number }> {
  const params = new URLSearchParams({ q: query, mode: 'grouped', limit: String(limit) });
  if (workspaceId) params.set('workspaceId', workspaceId);
  const base = options?.connectionId !== undefined ? backendApiBase(options.connectionId)
    : workspaceId ? workspaceBackendApiBase(workspaceId) : activeBackendApiBase();
  const res = await backendFetch(`${base}/search?${params}`, { signal: options?.signal });
  if (!res.ok) throw new Error(`searchNodesGrouped failed: ${res.status}`);
  return res.json();
}
