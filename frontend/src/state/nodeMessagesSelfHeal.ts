import { createContext } from 'react';
import { fetchNodeWorkspace, fetchTreeMessagePage, type TreeMessagePage } from '../services/api';
import { BACKEND_CONNECTION_READY, backendConnectionGeneration, backendConnectionUnavailable } from '../config/backendConnectionState';
import { backendConnectionIdForNode, LOCAL_BACKEND_CONNECTION_ID, projectConnectionId } from '../config/backendConnections';
import type { ChatNodeState, Project } from './chatTypes';
import { noteMessageRequest, noteMessageRetry } from './messageLoadDiagnostics';
import { findTreeIdForNode } from './tree';
import { installTreeMessagePage, type TreeMessageInstallTarget } from './treeMessageInstall';
import type { TreeMessageRequests } from './treeMessageRequests';

/** A pane's skeleton asks for its own node after this long without content. */
export const SKELETON_SELF_HEAL_MS = 3000;
/** ...and says it is still loading, with a Retry, after this long. */
export const SKELETON_STILL_LOADING_MS = 8000;
/** How long a self-heal waits on a read already covering its node before reading the node itself. */
const JOIN_WAIT_MS = 5000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15_000;

export type NodeMessagesResult = 'loaded' | 'failed' | 'gone' | 'cancelled';
/** `immediate`: a user's Retry, which skips any wait and starts a fresh retry budget. */
export type EnsureNodeMessages = (nodeId: string, options?: { signal?: AbortSignal; immediate?: boolean }) => Promise<NodeMessagesResult>;

/** Provider-free renders (tests, isolated surfaces) have no loader: the skeleton just waits. */
export const NodeMessagesContext = createContext<EnsureNodeMessages | null>(null);

/** The node shows the messages skeleton: history on the server, none here yet. */
function showsSkeleton(node: ChatNodeState | undefined): node is ChatNodeState {
  return !!node && !node.deletedAt && node.messagesLoaded === false && node.messages.length === 0
    && (node.messageCount ?? 0) > 0;
}

interface Job {
  holders: number;
  controller: AbortController;
  promise: Promise<NodeMessagesResult>;
  attempts: number;
  skipJoin: boolean;
  /** Ends the current wait (join or back-off) early. */
  wakeUp?: () => void;
}

type AttemptResult = 'loaded' | 'gone' | 'failed' | 'retry';

/**
 * Loads one node's latest page when its pane has shown the skeleton too long,
 * whatever the tree loader made of it: a node the active tree does not match
 * locally, one a tree read left out, one whose read failed or stalled.
 *
 * It first waits (briefly) on a pool read already covering the node, then
 * reads the node through its local thread and, when the server does not have
 * it there, asks the server which workspace and thread hold it. Bodies install
 * through installTreeMessagePage, like the tree loader's. Failed reads retry
 * with back-off a bounded number of times; a connection outage pauses the
 * count until it is back.
 */
export class NodeMessagesSelfHeal {
  private jobs = new Map<string, Job>();

  constructor(private readonly deps: TreeMessageInstallTarget & {
    projects: () => Project[];
    requests: TreeMessageRequests;
  }) {}

  ensure: EnsureNodeMessages = (nodeId, { signal, immediate = false } = {}) => {
    if (signal?.aborted) return Promise.resolve('cancelled');
    if (!showsSkeleton(this.deps.nodesRef.current[nodeId])) return Promise.resolve('loaded');
    let job = this.jobs.get(nodeId);
    if (!job) job = this.start(nodeId, immediate);
    else if (immediate) {
      job.skipJoin = true;
      job.attempts = 0;
      job.wakeUp?.();
    }
    const held = job;
    held.holders += 1;
    signal?.addEventListener('abort', () => {
      held.holders -= 1;
      // A remounted skeleton asks again before this runs and keeps the job.
      if (held.holders === 0) queueMicrotask(() => { if (held.holders === 0) held.controller.abort(); });
    }, { once: true });
    return held.promise;
  };

  clear(): void {
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
  }

  private start(nodeId: string, immediate: boolean): Job {
    const job: Job = {
      holders: 0, controller: new AbortController(), promise: Promise.resolve('cancelled'),
      attempts: 0, skipJoin: immediate,
    };
    this.jobs.set(nodeId, job);
    job.promise = this.run(nodeId, job)
      .catch((): NodeMessagesResult => (job.controller.signal.aborted ? 'cancelled' : 'failed'))
      .finally(() => { if (this.jobs.get(nodeId) === job) this.jobs.delete(nodeId); });
    return job;
  }

  private async run(nodeId: string, job: Job): Promise<NodeMessagesResult> {
    const { signal } = job.controller;
    const first = this.deps.nodesRef.current[nodeId];
    const owner = first && this.deps.projects().find((project) => project.id === first.projectId);
    const connectionId = owner ? projectConnectionId(owner) : backendConnectionIdForNode(nodeId);
    while (!signal.aborted) {
      const node = this.deps.nodesRef.current[nodeId];
      if (!showsSkeleton(node)) return 'loaded';
      let result: AttemptResult;
      try {
        result = await this.attempt(nodeId, node, job, connectionId);
      } catch {
        if (signal.aborted) break;
        result = 'retry';
      }
      if (result !== 'retry') return result;
      const unavailable = backendConnectionUnavailable(connectionId);
      // An outage is not this node's failure: wait for the connection instead.
      if (!unavailable && ++job.attempts >= MAX_ATTEMPTS) return 'failed';
      noteMessageRetry([nodeId]);
      await this.wait(job, unavailable ? RETRY_MAX_MS : Math.min(RETRY_BASE_MS * 2 ** (job.attempts - 1), RETRY_MAX_MS),
        { connectionId });
    }
    return 'cancelled';
  }

  private async attempt(nodeId: string, node: ChatNodeState, job: Job, connectionId: string): Promise<AttemptResult> {
    const { signal } = job.controller;
    const target = this.deps;
    let localTreeMissed = false;
    const skipJoin = job.skipJoin;
    job.skipJoin = false;
    if (!skipJoin) {
      // Never stack a second read on one already on its way for this node.
      const pending = this.deps.requests.pendingFor(nodeId, node);
      if (pending) {
        const page = await this.wait(job, JOIN_WAIT_MS, { promise: pending.promise });
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (page) {
          const result = installTreeMessagePage(target, page, [nodeId], pending.nodes);
          if (result.installed.length || !showsSkeleton(this.deps.nodesRef.current[nodeId])) return 'loaded';
          if (result.changed.length) return 'retry';
          localTreeMissed = true;
        }
      }
    }

    const startNodes = new Map([[nodeId, node]]);
    const project = this.deps.projects().find((candidate) => candidate.id === node.projectId);
    const localTreeId = project && !localTreeMissed ? findTreeIdForNode(nodeId, project) : null;
    const tried = localTreeId ? { workspaceId: node.projectId, treeId: localTreeId } : null;
    if (tried) {
      const page = await this.read(tried, nodeId, connectionId, signal);
      const result = installTreeMessagePage(target, page, [nodeId], startNodes);
      if (result.installed.length) return 'loaded';
      if (result.changed.length) return 'retry';
      // The server's thread for this node is not the one this window thinks.
    }
    const located = await this.track(nodeId, signal, () => fetchNodeWorkspace(nodeId, signal));
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    // No thread on the server (an untreed legacy node) leaves no read to try.
    if (!located?.treeId) return located ? 'failed' : 'gone';
    if (tried && located.workspaceId === tried.workspaceId && located.treeId === tried.treeId) return 'retry';
    const page = await this.read({ workspaceId: located.workspaceId, treeId: located.treeId }, nodeId, connectionId, signal);
    const result = installTreeMessagePage(target, page, [nodeId], startNodes);
    return result.installed.length ? 'loaded' : 'retry';
  }

  private async read(where: { workspaceId: string; treeId: string }, nodeId: string, connectionId: string,
    signal: AbortSignal): Promise<TreeMessagePage> {
    const generation = backendConnectionGeneration(connectionId);
    const page = await this.track(nodeId, signal, () => fetchTreeMessagePage(where.workspaceId, where.treeId,
      connectionId === LOCAL_BACKEND_CONNECTION_ID ? undefined : connectionId, signal, { nodeId }));
    if (signal.aborted || generation !== backendConnectionGeneration(connectionId)) {
      throw new DOMException('Aborted', 'AbortError');
    }
    return page;
  }

  /** Notes the read for diagnostics; settles on abort even if the read never does. */
  private async track<T>(nodeId: string, signal: AbortSignal, request: () => Promise<T>): Promise<T> {
    const settle = noteMessageRequest([nodeId], 'node');
    let onAbort = () => {};
    try {
      const value = await Promise.race([request(), new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      })]);
      settle();
      return value;
    } catch (error) {
      settle(error);
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Resolves with `promise`'s value, or null after `ms`, on abort, on wake-up
   * (a user's Retry) or when `connectionId` reports ready again.
   */
  private wait<T>(job: Job, ms: number, { promise, connectionId }: { promise?: Promise<T>; connectionId?: string }): Promise<T | null> {
    const { signal } = job.controller;
    return new Promise((resolve) => {
      const cleanups: Array<() => void> = [];
      let done = false;
      function finish(value: T | null) {
        if (done) return;
        done = true;
        for (const cleanup of cleanups) cleanup();
        resolve(value);
      }
      const stop = () => finish(null);
      const timer = setTimeout(stop, ms);
      cleanups.push(() => clearTimeout(timer));
      signal.addEventListener('abort', stop, { once: true });
      cleanups.push(() => signal.removeEventListener('abort', stop));
      if (connectionId && typeof window !== 'undefined') {
        const onReady = (event: Event) => {
          if ((event as CustomEvent<{ connectionId?: string }>).detail?.connectionId === connectionId) stop();
        };
        window.addEventListener(BACKEND_CONNECTION_READY, onReady);
        cleanups.push(() => window.removeEventListener(BACKEND_CONNECTION_READY, onReady));
      }
      job.wakeUp = stop;
      cleanups.push(() => { if (job.wakeUp === stop) job.wakeUp = undefined; });
      promise?.then(finish, stop);
    });
  }
}
