import { useEffect, useState } from 'react';
import { LOCAL_BACKEND_CONNECTION_ID } from '../config/backendConnections';
import { backendConnectionProvisional, backendConnectionUnavailable } from '../config/backendConnectionState';
import { searchNodesGrouped, type NodeGroupedResult, type NodeGroupedSnippet } from '../services/api';
import { getRemoteRecoveryIssues } from './remoteRecovery';

const SEARCH_LIMIT = 30;
/** A remote that has not answered by then is left out of this search. */
export const REMOTE_SEARCH_TIMEOUT_MS = 5_000;

export interface NodeSearchState {
  nodes: NodeGroupedResult[];
  totalNodes: number;
  /** idle: no query. error: the search failed, which is not "no results". */
  status: 'idle' | 'loading' | 'ready' | 'error';
}

const EMPTY: NodeSearchState = { nodes: [], totalNodes: 0, status: 'idle' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function readSnippet(raw: unknown): NodeGroupedSnippet | null {
  if (!isObject(raw) || typeof raw.snippet !== 'string') return null;
  return { messageId: text(raw.messageId), role: raw.role === 'user' ? 'user' : 'assistant', snippet: raw.snippet };
}

function readHit(raw: unknown): NodeGroupedResult | null {
  if (!isObject(raw) || typeof raw.nodeId !== 'string' || !raw.nodeId || typeof raw.workspaceId !== 'string') return null;
  return {
    nodeId: raw.nodeId,
    nodeTitle: typeof raw.nodeTitle === 'string' ? raw.nodeTitle : null,
    workspaceId: raw.workspaceId,
    workspaceName: text(raw.workspaceName),
    treeId: typeof raw.treeId === 'string' ? raw.treeId : null,
    lastMessageAt: count(raw.lastMessageAt),
    totalMatches: count(raw.totalMatches),
    breadcrumb: Array.isArray(raw.breadcrumb) ? raw.breadcrumb.filter((s): s is string => typeof s === 'string') : [],
    snippets: Array.isArray(raw.snippets) ? raw.snippets.flatMap((s) => readSnippet(s) ?? []) : [],
  };
}

/**
 * The search answer as the palette draws it. The backend may answer with
 * something else (an error body, an older shape): anything without a
 * `results` list is no results, and a hit missing what the palette needs is
 * dropped, so a bad answer never takes the palette down.
 */
export function readNodeSearchAnswer(raw: unknown): { results: NodeGroupedResult[]; totalNodes: number } {
  if (!isObject(raw) || !Array.isArray(raw.results)) return { results: [], totalNodes: 0 };
  const results = raw.results.flatMap((r) => readHit(r) ?? []);
  const total = typeof raw.totalNodes === 'number' && Number.isFinite(raw.totalNodes) ? raw.totalNodes : results.length;
  return { results, totalNodes: Math.max(total, results.length) };
}

/**
 * Whether a search may ask this backend now. A remote counts only while this
 * window holds its live data: a request to one that is not connected would
 * start its tunnel or its recovery, and the search must not.
 */
function searchableNow(connectionId: string): boolean {
  if (connectionId === LOCAL_BACKEND_CONNECTION_ID) return true;
  return !backendConnectionUnavailable(connectionId)
    && !backendConnectionProvisional(connectionId)
    && !getRemoteRecoveryIssues().some((issue) => issue.connectionId === connectionId);
}

/** Each backend's answer as one list, most recent activity first, as each backend orders its own. */
function mergeNodeSearchAnswers(
  answers: readonly { results: NodeGroupedResult[]; totalNodes: number }[],
  limit = SEARCH_LIMIT,
): { results: NodeGroupedResult[]; totalNodes: number } {
  const results = answers.flatMap((answer) => answer.results)
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, limit);
  return { results, totalNodes: answers.reduce((sum, answer) => sum + answer.totalNodes, 0) };
}

/**
 * Server-side node-grouped FTS search for the command palette, across the
 * local backend and each of `connectionIds` connected now (searchableNow).
 *
 * Returns deduplicated nodes, time-sorted (most recent activity first),
 * each with a root-first breadcrumb trail and up to 3 best-matching
 * snippets with `<mark>` tags for highlight rendering. Hits show as each
 * backend answers. A remote that fails or times out adds nothing and is
 * never reported; only a failed local search with nothing found elsewhere
 * is an error.
 */
export function useNodeSearch(debouncedQuery: string, connectionIds: readonly string[] = []): NodeSearchState {
  const q = debouncedQuery.trim();
  const backends = [LOCAL_BACKEND_CONNECTION_ID,
    ...[...new Set(connectionIds)].filter((id) => id !== LOCAL_BACKEND_CONNECTION_ID).sort()].join('\n');
  const key = JSON.stringify([backends, q]);
  const [snapshot, setSnapshot] = useState<{ key: string; value: NodeSearchState }>({ key, value: EMPTY });

  useEffect(() => {
    const setState = (value: NodeSearchState) => setSnapshot({ key, value });
    if (!q) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    const targets = backends.split('\n').filter(searchableNow);
    const answers: { results: NodeGroupedResult[]; totalNodes: number }[] = [];
    let pending = targets.length;
    let localFailed = false;

    setState({ ...EMPTY, status: 'loading' });

    const requests = targets.map((connectionId) => {
      const request = new AbortController();
      const local = connectionId === LOCAL_BACKEND_CONNECTION_ID;
      const timer = local ? undefined : setTimeout(() => request.abort(), REMOTE_SEARCH_TIMEOUT_MS);
      void searchNodesGrouped(q, undefined, SEARCH_LIMIT, { connectionId, signal: request.signal })
        .then((raw) => { if (!cancelled) answers.push(readNodeSearchAnswer(raw)); })
        .catch(() => { if (local) localFailed = true; })
        .finally(() => {
          clearTimeout(timer);
          if (cancelled) return;
          pending -= 1;
          const { results, totalNodes } = mergeNodeSearchAnswers(answers);
          const status = pending > 0 ? 'loading' : localFailed && results.length === 0 ? 'error' : 'ready';
          setState({ nodes: results, totalNodes, status });
        });
      return request;
    });

    return () => { cancelled = true; requests.forEach((request) => request.abort()); };
  }, [key, backends, q]);

  return snapshot.key === key ? snapshot.value : { ...EMPTY, status: q ? 'loading' : 'idle' };
}
