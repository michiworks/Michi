import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { findTreeIdForNode } from './tree';
import type { ChatAction, ChatNodeState, Project } from './chatTypes';
import { noteMessageRetry } from './messageLoadDiagnostics';
import { NodeMessagesSelfHeal, type EnsureNodeMessages } from './nodeMessagesSelfHeal';
import { installTreeMessagePage } from './treeMessageInstall';
import { TreeMessageRequests } from './treeMessageRequests';
import { markRemoteFirstPaint } from './remoteFirstPaint';

/** Which tree each node of `project` belongs to, each node looked up once. */
function treeMembership(project: Project): (nodeId: string) => string | null {
  const cache = new Map<string, string | null>();
  return (nodeId) => {
    if (!cache.has(nodeId)) cache.set(nodeId, findTreeIdForNode(nodeId, project));
    return cache.get(nodeId)!;
  };
}

/**
 * The active tree's nodes this loader reads: unloaded placeholders without
 * partial history, minus live turns (a streaming node with content) and the
 * nodes an earlier read of this tree did not include (`missing`: left to
 * their pane's self-heal, which finds the server's thread for them).
 */
function loadableNodeIds(
  project: Project,
  treeId: string,
  nodes: Record<string, ChatNodeState>,
  treeOf: (nodeId: string) => string | null,
  missing: ReadonlyMap<string, string>,
): string[] {
  const key = `${project.id}::${treeId}`;
  return project.chatIds.filter((nid) => {
    const n = nodes[nid];
    if (!n || n.deletedAt || n.messagesLoaded !== false || n.historyBefore) return false;
    if (n.status === 'streaming' && n.messages.length > 0) return false;
    return missing.get(nid) !== key && treeOf(nid) === treeId;
  });
}

/**
 * Lazy-load the ACTIVE tree's message bodies on demand, and let a pane's
 * skeleton load its own node (`ensureNodeMessages`).
 *
 * Hydration loads structure + per-node counts for every workspace but message
 * bodies for only the initially-active tree. Whenever the active (project,
 * tree) changes to one whose nodes are still placeholders (`messagesLoaded ===
 * false`), this hook fetches that tree's bodies once and dispatches
 * `messages-loaded` to install them.
 *
 * Design notes:
 * - The read is keyed on (project id, tree id, the waiting node ids), not on
 *   the project object: touching a tree or re-reading structure makes a new
 *   object without changing what to load, and must not restart a read. A
 *   restarted effect picks its in-flight read back up from the pool.
 * - Loaded bodies stay in node state. Pending/short-lived speculative reads
 *   share a provider-scoped request pool, isolated by backend/workspace/tree.
 * - The `messages-loaded` action is NOT in NODE_ACTIVITY_ACTIONS and installs
 *   backend-authored bodies, so it never dirties the node for write-back.
 * - Failed reads retry with bounded backoff while this tree stays active;
 *   they never install an empty snapshot or throw into render. A node the
 *   read leaves out is not retried here: its pane's self-heal locates it.
 * - A deferred retry (500ms) runs after the initial effect to catch cases
 *   where hydration's eager-load silently fails but marks the key as done
 *   before the nodes are installed with their true messagesLoaded state.
 */
export function useLazyTreeMessages({
  hydrated,
  activeProjectId,
  projects,
  nodesRef,
  dispatch,
  reconnectStreamingRef,
  requests: sharedRequests,
}: {
  hydrated: boolean;
  activeProjectId: string | null;
  projects: Project[];
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  dispatch: (action: ChatAction) => void;
  // Called with each streaming node whose checkpoint body was just installed,
  // so the foreground-replay path can reattach its live SSE stream. Stable ref
  // so this hook's effect deps stay quiet.
  reconnectStreamingRef?: MutableRefObject<(nodeId: string) => void>;
  /** The provider's read pool, shared with hydration (which hands it the boot read). Stable. */
  requests?: TreeMessageRequests;
}): { prefetchNode: (nodeId: string) => void; ensureNodeMessages: EnsureNodeMessages } {
  const requestsRef = useRef<TreeMessageRequests | null>(sharedRequests ?? null);
  if (!requestsRef.current) requestsRef.current = new TreeMessageRequests();
  const requests = requestsRef.current;
  const latest = useRef({ hydrated, projects });
  latest.current = { hydrated, projects };
  const selfHealRef = useRef<NodeMessagesSelfHeal | null>(null);
  if (!selfHealRef.current) {
    selfHealRef.current = new NodeMessagesSelfHeal({
      nodesRef, dispatch, reconnectStreamingRef, requests,
      projects: () => latest.current.projects,
    });
  }
  const selfHeal = selfHealRef.current;
  useEffect(() => () => { requests.clear(); selfHeal.clear(); }, [requests, selfHeal]);
  const prefetchNode = useCallback((nodeId: string) => {
    if (!latest.current.hydrated) return;
    const node = nodesRef.current[nodeId];
    if (!node || node.deletedAt) return;
    const project = latest.current.projects.find((candidate) => candidate.id === node.projectId);
    if (!project) return;
    const treeId = findTreeIdForNode(nodeId, project);
    if (treeId) requests.prefetch(project, treeId, nodesRef.current);
  }, [nodesRef, requests]);
  // Keys (project::tree) already loaded or in-flight this mount.
  const loadedKeysRef = useRef<Set<string>>(new Set());
  // Node id → the project::tree key whose read did not include it.
  const missingRef = useRef<Map<string, string>>(new Map());

  const activeProject = activeProjectId
    ? projects.find((p) => p.id === activeProjectId) ?? null
    : null;
  const activeTreeId = activeProject?.activeTreeId ?? null;
  const projectId = activeProject?.id ?? null;
  const treeOf = useMemo(() => (activeProject ? treeMembership(activeProject) : null), [activeProject]);
  // Read from the ref during render: the provider re-renders on every node
  // change, and the ref is never behind the rendered state.
  const loadSignature = hydrated && activeProject && activeTreeId && treeOf
    ? loadableNodeIds(activeProject, activeTreeId, nodesRef.current, treeOf, missingRef.current).join('\n')
    : '';

  useEffect(() => {
    if (!hydrated || !projectId || !activeTreeId) return;
    const key = `${projectId}::${activeTreeId}`;
    const loadedKeys = loadedKeysRef.current;
    const missing = missingRef.current;
    let cancelled = false;
    let inFlight = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let retryDelay = 500;
    const controller = new AbortController();
    // The newest project object: it changes without restarting this effect.
    const currentProject = () => latest.current.projects.find((p) => p.id === projectId) ?? null;
    const pendingIds = (project: Project) =>
      loadableNodeIds(project, activeTreeId, nodesRef.current, treeMembership(project), missing);

    const attemptLoad = () => {
      if (cancelled || inFlight) return;
      const project = currentProject();
      if (!project) return;
      for (const nid of missing.keys()) {
        if (nodesRef.current[nid]?.messagesLoaded !== false) missing.delete(nid);
      }
      const treeNodeIds = pendingIds(project);
      // The visible conversation of a remote is on screen: its boot barrier opens.
      const painted = () => { if (project.backendConnectionId) markRemoteFirstPaint(project.backendConnectionId); };
      if (loadedKeys.has(key)) {
        // Already loaded or in-flight — but verify the nodes actually have
        // their messages. If not (e.g. hydration eager-load silently failed
        // but installed placeholder nodes), clear the key and retry.
        if (treeNodeIds.length === 0) return;
        loadedKeys.delete(key);
      }
      // A streaming node with content is a live foreground turn — never install
      // a stale DB snapshot over its in-flight text. But a streaming node with
      // NO messages is a hydrated reconnect target (backend marked it streaming
      // at turn-start; meta mode left the body unloaded): load its checkpoint so
      // the pane shows progress and recover() can reattach. Empty ⇒ nothing to
      // clobber, so it is safe. (loadableNodeIds keeps exactly those.)
      if (treeNodeIds.length === 0) {
        loadedKeys.add(key);
        painted();
        return;
      }
      const request = requests.acquire(project, activeTreeId, nodesRef.current, controller.signal);
      if (!request) return;

      loadedKeys.add(key);
      inFlight = true;
      (async () => {
        try {
          const page = await request.promise;
          if (cancelled) return;
          const result = installTreeMessagePage({ nodesRef, dispatch, reconnectStreamingRef }, page,
            treeNodeIds, request.nodes);
          if (result.installed.length > 0) painted();
          for (const nid of result.missing) missing.set(nid, key);
          // The snapshot comparison catches user-send changes while ignoring
          // only viewedAt; a changed node is read again.
          if (result.changed.length > 0) loadedKeys.delete(key);
        } catch {
          if (!cancelled) loadedKeys.delete(key);
        } finally {
          inFlight = false;
          if (!cancelled && !loadedKeys.has(key)) {
            clearTimeout(retryTimer);
            noteMessageRetry(treeNodeIds);
            retryTimer = setTimeout(attemptLoad, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 10_000);
          }
        }
      })();
    };

    attemptLoad();

    // Deferred retry: if the initial attempt found no placeholders (because
    // hydration's eager-load appeared to succeed), re-check after a short
    // delay. This catches the race where installNodes sets messagesLoaded:true
    // on the ref but the rendered component hasn't received the update yet,
    // or where the eager-load result was silently lost.
    retryTimer = setTimeout(() => {
      if (cancelled || inFlight) return;
      const project = currentProject();
      if (project && pendingIds(project).length > 0) {
        loadedKeys.delete(key);
        attemptLoad();
      }
    }, 500);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(retryTimer);
      loadedKeys.delete(key);
    };
  }, [hydrated, projectId, activeTreeId, loadSignature, nodesRef, dispatch, reconnectStreamingRef, requests]);
  return useMemo(() => ({ prefetchNode, ensureNodeMessages: selfHeal.ensure }), [prefetchNode, selfHeal]);
}
