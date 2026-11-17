import { createContext, createElement, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { fetchMessageToolCalls, MAX_TOOL_CALL_MESSAGES } from '../services/api/persistence';
import { backendConnectionGeneration } from '../config/backendConnectionState';
import { projectConnectionId } from '../config/backendConnections';
import { parseStoredToolCalls } from './chatHydration';
import { findTreeIdForNode } from './tree';
import type { ChatAction, ChatNodeState, Project, ToolCallState } from './chatTypes';

/** A message whose deferred calls are on their way, or whose last read failed. */
export type DeferredToolCallsStatus = 'loading' | 'failed';

/** Reads in flight at once: prefetches must not crowd the turn's own stream. */
const CONCURRENCY = 2;

const keyOf = (nodeId: string, messageId: string) => `${nodeId}\u0000${messageId}`;
const hasDeferred = (tools: readonly ToolCallState[]) => tools.some((tool) => tool.deferred);

/**
 * Loads what display pages left on the server (ToolCallState.deferred), one
 * message's calls at a time; reads asked for in the same tick go out as one
 * per node. Scoped to one ChatProvider. A message that comes back without a
 * call leaves that call deferred: the row shows it is unavailable.
 */
export class DeferredToolCalls {
  private statuses = new Map<string, DeferredToolCallsStatus>();
  private listeners = new Set<() => void>();
  private queued = new Map<string, Set<string>>();
  private running = 0;
  private flushing = false;
  private controllers = new Set<AbortController>();
  private stopped = false;

  constructor(private readonly deps: {
    nodes: () => Record<string, ChatNodeState>;
    projects: () => Project[];
    dispatch: (action: ChatAction) => void;
  }) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  status = (nodeId: string, messageId: string): DeferredToolCallsStatus | undefined =>
    this.statuses.get(keyOf(nodeId, messageId));

  load = (nodeId: string, messageId: string): void => {
    if (this.stopped) return;
    const key = keyOf(nodeId, messageId);
    if (this.statuses.get(key) === 'loading') return;
    const message = this.deps.nodes()[nodeId]?.messages.find((item) => item.id === messageId);
    if (!message || !hasDeferred(message.toolCalls)) return;
    this.statuses.set(key, 'loading');
    let ids = this.queued.get(nodeId);
    if (!ids) this.queued.set(nodeId, ids = new Set());
    ids.add(messageId);
    this.emit();
    if (!this.flushing) {
      this.flushing = true;
      queueMicrotask(() => { this.flushing = false; this.pump(); });
    }
  };

  /** The provider mounted (again: StrictMode remounts it). */
  start(): void {
    this.stopped = false;
  }

  /** The provider unmounted: reads in flight are dropped. */
  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.queued.clear();
    this.statuses.clear();
    this.emit();
  }

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }

  private pump() {
    while (!this.stopped && this.running < CONCURRENCY && this.queued.size > 0) {
      const [nodeId, ids] = this.queued.entries().next().value!;
      const batch = [...ids].slice(0, MAX_TOOL_CALL_MESSAGES);
      for (const id of batch) ids.delete(id);
      if (ids.size === 0) this.queued.delete(nodeId);
      void this.read(nodeId, batch);
    }
  }

  private settle(nodeId: string, ids: readonly string[], status?: DeferredToolCallsStatus) {
    for (const id of ids) {
      if (status) this.statuses.set(keyOf(nodeId, id), status);
      else this.statuses.delete(keyOf(nodeId, id));
    }
  }

  private async read(nodeId: string, ids: string[]) {
    const node = this.deps.nodes()[nodeId];
    const project = node ? this.deps.projects().find((item) => item.id === node.projectId) : undefined;
    const treeId = project ? findTreeIdForNode(nodeId, project) : null;
    if (!project || !treeId) {
      this.settle(nodeId, ids);
      this.emit();
      return;
    }
    const connectionId = projectConnectionId(project);
    const generation = backendConnectionGeneration(connectionId);
    const controller = new AbortController();
    this.controllers.add(controller);
    this.running += 1;
    try {
      const rows = await fetchMessageToolCalls(project.id, treeId, project.backendConnectionId, nodeId, ids, controller.signal);
      if (this.stopped) return;
      if (generation !== backendConnectionGeneration(connectionId)) throw new DOMException('Remote connection changed', 'AbortError');
      const asked = new Set(ids);
      const byMessage: Record<string, ToolCallState[]> = {};
      for (const row of rows) if (asked.has(row.id)) byMessage[row.id] = parseStoredToolCalls(row.tool_calls);
      if (Object.keys(byMessage).length > 0) this.deps.dispatch({ type: 'tool-calls-loaded', nodeId, byMessage });
      this.settle(nodeId, ids);
    } catch {
      if (this.stopped) return;
      this.settle(nodeId, ids, 'failed');
    } finally {
      this.controllers.delete(controller);
      this.running -= 1;
      if (!this.stopped) {
        this.emit();
        this.pump();
      }
    }
  }
}

export const DeferredToolCallsContext = createContext<DeferredToolCalls | null>(null);

const MessageContext = createContext<{ nodeId: string; messageId: string } | null>(null);

/** Names the message whose calls the tool rows inside load (useDeferredToolBodies). */
export function DeferredToolCallsScope({ nodeId, messageId, children }: { nodeId: string; messageId: string; children: ReactNode }) {
  const value = useMemo(() => ({ nodeId, messageId }), [nodeId, messageId]);
  return createElement(MessageContext.Provider, { value }, children);
}

const noSubscription = () => () => {};

/**
 * The enclosing message's deferred calls: `load` asks for them (a no-op once
 * they came), `status` says where that read is. Null outside a scope or a
 * ChatProvider, where nothing can be loaded.
 */
export function useDeferredToolBodies(): { load: () => void; status: DeferredToolCallsStatus | undefined } | null {
  const loader = useContext(DeferredToolCallsContext);
  const target = useContext(MessageContext);
  const status = useSyncExternalStore(loader?.subscribe ?? noSubscription,
    () => (loader && target ? loader.status(target.nodeId, target.messageId) : undefined));
  const load = useCallback(() => {
    if (loader && target) loader.load(target.nodeId, target.messageId);
  }, [loader, target]);
  return useMemo(() => (loader && target ? { load, status } : null), [loader, target, load, status]);
}
