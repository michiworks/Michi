import { fetchTreeMessageSnapshot, fetchTreeMessagePage, type TreeMessagePage } from '../services/api';
import type { ChatNodeState, Project } from './chatTypes';
import { findTreeIdForNode } from './tree';
import { noteMessageRequest } from './messageLoadDiagnostics';
import { isLocalConnectionId, LOCAL_BACKEND_CONNECTION_ID, projectConnectionId } from '../config/backendConnections';

export const TREE_PREFETCH_LIMIT = 4;
export const TREE_PREFETCH_CONCURRENCY = 2;
export const TREE_PREFETCH_TTL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Messages per node on a remote tree's first page. Over a tunnel the bytes are
 * the wait (tool calls dominate them), and a pane shows the last screenful
 * first; older history pages in on scroll (historyBefore) or when a send needs
 * all of it (ensureCompleteHistory).
 */
export const REMOTE_FIRST_PAGE_LIMIT = 15;

/** A remote tree's first page, with the per-node limit above. */
export function fetchRemoteTreeFirstPage(workspaceId: string, treeId: string, connectionId: string, signal?: AbortSignal) {
  return fetchTreeMessagePage(workspaceId, treeId, connectionId, signal, { limit: REMOTE_FIRST_PAGE_LIMIT });
}

interface TreeRequest {
  promise: Promise<TreeMessagePage>;
  nodes: Map<string, ChatNodeState>;
  controller: AbortController;
  expiresAt: number;
  pending: boolean;
  foreground: boolean;
  /** Foreground acquisitions still awaiting this read. */
  holders: number;
  /** Handed over before its nodes were known: the first caller's waiting nodes are what it covers. */
  seeded?: boolean;
  settle?: (error?: unknown, unclaimed?: boolean) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

// Activating a tree stamps viewedAt (and the seen completion count) before its
// pending read resolves. That presentation-only change must not invalidate an
// otherwise identical snapshot.
export function sameTreeMessageNode(before: ChatNodeState | undefined, after: ChatNodeState | undefined): boolean {
  if (!before || !after) return false;
  return (Object.keys({ ...before, ...after }) as Array<keyof ChatNodeState>)
    .every((key) => key === 'viewedAt' || key === 'seenCompletionSeq' || before[key] === after[key]);
}

/** What a tree read answers for: the node's messages, where it is, and its replay cursors. */
const MESSAGE_ANCHOR_FIELDS = [
  'projectId', 'messagesLoaded', 'historyBefore', 'deletedAt', 'activeTurnId',
  'lastAppliedTurnId', 'lastAppliedSeq', 'lastAppliedBackgroundTurnId', 'lastAppliedBackgroundSeq',
] as const satisfies ReadonlyArray<keyof ChatNodeState>;

/**
 * True when a read that began at `before` still answers for the node as it is
 * now: only fields beside its messages changed (status, title, counts, follow
 * ups: what the watch feed and structure re-reads update). A local send, a
 * trim, a loaded page or an applied turn event (cursors) is a change.
 */
export function sameTreeMessageAnchor(before: ChatNodeState | undefined, after: ChatNodeState | undefined): boolean {
  if (!before || !after) return false;
  if (before.messages !== after.messages && (before.messages.length !== after.messages.length
    || before.messages.some((message, index) => message.id !== after.messages[index]?.id))) return false;
  return MESSAGE_ANCHOR_FIELDS.every((key) => before[key] === after[key]);
}

function unloadedNodes(project: Project, treeId: string, nodes: Record<string, ChatNodeState>) {
  return new Map(project.chatIds.flatMap((id) => {
    const node = nodes[id];
    return node && node.messagesLoaded === false && !node.historyBefore && !node.deletedAt
      && !(node.status === 'streaming' && node.messages.length > 0)
      && findTreeIdForNode(id, project) === treeId ? [[id, node] as const] : [];
  }));
}

function requestKey(connectionId: string | undefined, projectId: string, treeId: string): string {
  return JSON.stringify([connectionId ?? LOCAL_BACKEND_CONNECTION_ID, projectId, treeId]);
}

export interface TreeMessageRequestsOptions {
  /** Every remote tree page this pool reads, as received (the remote snapshot cache keeps the recent ones). */
  onRemotePage?: (project: Project, treeId: string, page: TreeMessagePage) => void;
}

/** Short-lived speculative reads, scoped to one ChatProvider/user, never UI state. */
export class TreeMessageRequests {
  private entries = new Map<string, TreeRequest>();

  constructor(private readonly options: TreeMessageRequestsOptions = {}) {}

  private drop(key: string, entry: TreeRequest) {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    clearTimeout(entry.timeout);
    entry.controller.abort();
    entry.settle?.(new DOMException('Aborted', 'AbortError'));
  }

  private request(project: Project, treeId: string, nodes: Record<string, ChatNodeState>, foreground: boolean) {
    if (project.deletedAt || !project.trees.some((tree) => tree.id === treeId)) return null;
    const snapshot = unloadedNodes(project, treeId, nodes);
    if (snapshot.size === 0) return null;
    // Live checkpoints must be read on activation, not speculatively cached.
    if (!foreground && [...snapshot.values()].some((node) => node.status === 'streaming')) return null;
    const key = requestKey(project.backendConnectionId, project.id, treeId);
    for (const [id, entry] of this.entries) {
      if (!entry.foreground && entry.expiresAt <= Date.now()) this.drop(id, entry);
    }
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.seeded) {
        // Started before these nodes were in the store: it reads them as they are now.
        existing.seeded = false;
        existing.nodes = snapshot;
      }
      const covers = (same: typeof sameTreeMessageNode) => [...snapshot].every(([id, node]) => same(existing.nodes.get(id), node));
      // The read already covers every node still waiting, as they were when
      // it started (nodes it loaded since have simply left the snapshot). One
      // still on its way answers for the server as it is now: a change beside
      // the messages (status, title, a count) is reconciled when it lands
      // (installTreeMessagePage), never by dropping a read half done.
      if (covers(sameTreeMessageNode) || (existing.pending && covers(sameTreeMessageAnchor))) {
        existing.foreground ||= foreground;
        if (foreground) clearTimeout(existing.timeout);
        return { key, entry: existing };
      }
      // An intent event must never cancel a foreground read.
      if (existing.foreground && !foreground) return null;
      this.drop(key, existing);
    }
    const speculative = [...this.entries].filter(([, entry]) => !entry.foreground);
    if (!foreground && speculative.filter(([, entry]) => entry.pending).length >= TREE_PREFETCH_CONCURRENCY) return null;
    if (speculative.length >= TREE_PREFETCH_LIMIT) {
      const oldest = speculative.find(([, entry]) => !entry.pending) ?? speculative[0];
      this.drop(...oldest);
    }

    const controller = new AbortController();
    const entry: TreeRequest = {
      controller, nodes: snapshot, expiresAt: Date.now() + TREE_PREFETCH_TTL_MS,
      pending: true, foreground, holders: 0, promise: Promise.resolve({ messages: [] }),
    };
    if (!foreground) entry.timeout = setTimeout(() => this.drop(key, entry), REQUEST_TIMEOUT_MS);
    this.entries.set(key, entry);
    entry.settle = noteMessageRequest(snapshot.keys(), foreground ? 'tree' : 'prefetch');
    entry.promise = (async () => {
      try {
        const connectionId = projectConnectionId(project);
        const remote = !isLocalConnectionId(connectionId);
        const rows = remote
          ? await fetchRemoteTreeFirstPage(project.id, treeId, connectionId, controller.signal)
          : await fetchTreeMessageSnapshot(project.id, treeId, project.backendConnectionId, controller.signal);
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        entry.settle?.(undefined, !entry.foreground);
        if (remote) {
          try { this.options.onRemotePage?.(project, treeId, rows); } catch { /* the cache is best effort */ }
        }
        return rows;
      } catch (error) {
        entry.settle?.(error);
        this.drop(key, entry);
        throw error;
      } finally {
        entry.pending = false;
        clearTimeout(entry.timeout);
      }
    })();
    // A hover-only request has no awaiting component to handle its rejection.
    void entry.promise.catch(() => {});
    return { key, entry };
  }

  prefetch(project: Project, treeId: string, nodes: Record<string, ChatNodeState>): void {
    this.request(project, treeId, nodes, false);
  }

  /**
   * A foreground read for the tree's waiting nodes, shared by every caller
   * whose nodes it covers. It is cancelled on the microtask after the last of
   * their signals aborts: a caller that restarts synchronously (an effect
   * re-run for the same placeholders) picks the same read back up instead of
   * starting over.
   */
  acquire(project: Project, treeId: string, nodes: Record<string, ChatNodeState>, signal: AbortSignal) {
    if (signal.aborted) return null;
    const request = this.request(project, treeId, nodes, true);
    if (!request) return null;
    const { key, entry } = request;
    entry.holders += 1;
    signal.addEventListener('abort', () => {
      entry.holders -= 1;
      if (entry.holders === 0) queueMicrotask(() => { if (entry.holders === 0) this.drop(key, entry); });
    }, { once: true });
    return entry;
  }

  /**
   * Hand over a read begun before its nodes were in the store (boot reads the
   * visible thread alongside its metadata). The first caller for that tree
   * takes it as covering its waiting nodes as they are then, so the tree is
   * not read twice; unclaimed, it expires like a speculative read.
   */
  seed(connectionId: string | undefined, projectId: string, treeId: string, promise: Promise<TreeMessagePage>,
    controller = new AbortController()): void {
    const key = requestKey(connectionId, projectId, treeId);
    if (this.entries.has(key)) return;
    const entry: TreeRequest = {
      controller, nodes: new Map(), expiresAt: Date.now() + TREE_PREFETCH_TTL_MS,
      pending: true, foreground: false, holders: 0, seeded: true, promise,
    };
    this.entries.set(key, entry);
    void promise.then(() => { entry.pending = false; }, () => {
      entry.pending = false;
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
  }

  /** A read in flight that covers `nodeId` as it is now, foreground or speculative. */
  pendingFor(nodeId: string, node: ChatNodeState): Pick<TreeRequest, 'promise' | 'nodes'> | null {
    for (const entry of this.entries.values()) {
      if (entry.pending && sameTreeMessageAnchor(entry.nodes.get(nodeId), node)) return entry;
    }
    return null;
  }

  clear(): void {
    for (const [key, entry] of this.entries) this.drop(key, entry);
  }
}
