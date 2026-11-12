import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import type { MemoryChangedEvent, ReplyMemorySource } from 'michi-shared';
import { API_BASE_URL } from '../../config/env';
import { fetchReplyMemorySources, isMemoryUnavailable, MemoryApiError } from '../../services/api/memories';
import { onConversationMemoryModeChange, onMemoryOnChange } from './conversationMemory';
import { onMemoryChanged } from './memoryNotifications';

/**
 * What each reply was based on (GET /api/nodes/:nodeId/memory-sources on the
 * conversation's backend), for the quiet line under it
 * (components/terminal/ReplyMemorySources.tsx). No stream change: a settled
 * reply asks once its turn is done (not while it still runs after its visible
 * answer: the backend stores what it was based on when the turn ends).
 * Requests are batched per conversation (one GET for the replies that ask
 * within BATCH_MS, at most BATCH_MAX ids), answers are cached per message (an
 * empty one too) for the page's lifetime, unless something changes what they
 * would say: a memory deleted, updated or put away on this machine (the
 * change feed), a past chat no longer recalled from any footer, this chat's
 * or a source chat's memory setting,
 * memory turned on or off. Opening a footer asks again, so what it lists is
 * current even when the change happened elsewhere (another backend, the
 * agent). A backend without the route is not asked again.
 */

/** Where a conversation's replies ask (PaneMessageList provides it; the assistant and meta chats do not). */
export interface ReplySourcesTarget {
  /** The conversation's backend API (workspaceBackendApiBase). */
  apiBase: string;
  nodeId: string;
  backendConnectionId: string;
  workspaceId: string;
  /** The conversation is on this machine's backend: its memories are the ones Settings › Memory lists. */
  local: boolean;
  /** The reply whose turn still runs after its visible answer (ChatNodeState.backgroundTurnAssistantId): it asks once the turn is done. */
  runningMessageId?: string | null;
}

export const ReplySourcesContext = createContext<ReplySourcesTarget | null>(null);

const BATCH_MS = 30;
const BATCH_MAX = 100;
/** Conversations whose answers stay cached (least recently used go). */
const CACHED_NODES = 30;

interface NodeCache {
  apiBase: string;
  nodeId: string;
  /** Answers by message id; [] when it has none. */
  answers: Map<string, ReplyMemorySource[]>;
  waiting: Set<string>;
  asking: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

const EMPTY: readonly ReplyMemorySource[] = Object.freeze([]);
const caches = new Map<string, NodeCache>();
const unsupported = new Set<string>();
/** Items forgotten on a backend (from a footer, or the change feed): an answer asked before that never brings them back. */
const forgottenOn = new Map<string, Set<string>>();

function sourceKey(source: ReplyMemorySource): string {
  return source.kind === 'memory' ? `m:${source.memoryId}` : `c:${source.docId}`;
}

function noteForgotten(apiBase: string, key: string): void {
  const keys = forgottenOn.get(apiBase) ?? new Set<string>();
  keys.add(key);
  forgottenOn.set(apiBase, keys);
}
/** Subscribers by cache key and message id. */
const subscribers = new Map<string, Set<() => void>>();

const cacheKey = (apiBase: string, nodeId: string) => `${apiBase}\n${nodeId}`;
const messageKey = (apiBase: string, nodeId: string, messageId: string) => `${cacheKey(apiBase, nodeId)}\n${messageId}`;

function cacheOf(apiBase: string, nodeId: string): NodeCache {
  const key = cacheKey(apiBase, nodeId);
  let cache = caches.get(key);
  if (cache) {
    caches.delete(key);
  } else {
    cache = { apiBase, nodeId, answers: new Map(), waiting: new Set(), asking: new Set(), timer: null };
  }
  caches.set(key, cache);
  while (caches.size > CACHED_NODES) {
    const [oldest, dropped] = caches.entries().next().value as [string, NodeCache];
    if (dropped.timer) clearTimeout(dropped.timer);
    caches.delete(oldest);
  }
  ensureInvalidation();
  return cache;
}

function notify(apiBase: string, nodeId: string, messageId: string): void {
  for (const listener of [...(subscribers.get(messageKey(apiBase, nodeId, messageId)) ?? [])]) listener();
}

function notifyAll(cache: NodeCache, messageIds: Iterable<string>): void {
  for (const messageId of messageIds) notify(cache.apiBase, cache.nodeId, messageId);
}

async function flush(cache: NodeCache): Promise<void> {
  cache.timer = null;
  const ids = [...cache.waiting].slice(0, BATCH_MAX);
  for (const id of ids) {
    cache.waiting.delete(id);
    cache.asking.add(id);
  }
  if (cache.waiting.size > 0) cache.timer = setTimeout(() => { void flush(cache); }, BATCH_MS);
  if (ids.length === 0) return;
  try {
    const response = await fetchReplyMemorySources(cache.apiBase, cache.nodeId, ids);
    const answered = new Map(response.messages.map((message) => [message.messageId, message.sources]));
    const forgotten = forgottenOn.get(cache.apiBase);
    for (const id of ids) {
      const next = (answered.get(id) ?? []).filter((item) => !forgotten?.has(sourceKey(item)));
      // An answer asked again that says the same keeps its object, so a mounted line does not render again.
      const known = cache.answers.get(id);
      if (!known || !sameSources(known, next)) cache.answers.set(id, next);
    }
  } catch (error) {
    // A backend without the route (an older one) is not asked again. Any failure answers nothing for these replies (a
    // conversation the backend lacks, an unreachable backend), so a mounted line never asks again in a loop; what
    // changes them later (the feed, a chat's setting, memory on or off) asks anew.
    if (isMemoryUnavailable(error) || (error instanceof MemoryApiError && error.status === 405)) unsupported.add(cache.apiBase);
    for (const id of ids) if (!cache.answers.has(id)) cache.answers.set(id, []);
  } finally {
    for (const id of ids) cache.asking.delete(id);
    notifyAll(cache, ids);
  }
}

/** The settled reply asks what it was based on, once (batched with the conversation's other replies); `again`: even when answered. */
export function requestReplySources(target: Pick<ReplySourcesTarget, 'apiBase' | 'nodeId'>, messageId: string, again = false): void {
  if (!messageId || unsupported.has(target.apiBase)) return;
  const cache = cacheOf(target.apiBase, target.nodeId);
  if ((!again && cache.answers.has(messageId)) || cache.waiting.has(messageId) || cache.asking.has(messageId)) return;
  cache.waiting.add(messageId);
  if (cache.waiting.size >= BATCH_MAX) {
    if (cache.timer) clearTimeout(cache.timer);
    void flush(cache);
  } else if (!cache.timer) {
    cache.timer = setTimeout(() => { void flush(cache); }, BATCH_MS);
  }
}

/** What the message's reply was based on, when answered; undefined while unknown. */
export function readReplySources(target: Pick<ReplySourcesTarget, 'apiBase' | 'nodeId'>, messageId: string): readonly ReplyMemorySource[] | undefined {
  return caches.get(cacheKey(target.apiBase, target.nodeId))?.answers.get(messageId);
}

export function subscribeReplySources(target: Pick<ReplySourcesTarget, 'apiBase' | 'nodeId'>, messageId: string, listener: () => void): () => void {
  const key = messageKey(target.apiBase, target.nodeId, messageId);
  const set = subscribers.get(key) ?? new Set();
  set.add(listener);
  subscribers.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) subscribers.delete(key);
  };
}

/** An opened footer asks again: what it lists may have changed elsewhere (another pane, the agent, another backend). */
export function refreshReplySources(target: Pick<ReplySourcesTarget, 'apiBase' | 'nodeId'>, messageId: string): void {
  requestReplySources(target, messageId, true);
}

/** The footer forgot one of its items (Forget, Don't recall): it leaves that message's cached answer at once, and every other reply's of that backend. */
export function removeReplySource(target: Pick<ReplySourcesTarget, 'apiBase' | 'nodeId'>, messageId: string, source: ReplyMemorySource): void {
  noteForgotten(target.apiBase, sourceKey(source));
  const cache = caches.get(cacheKey(target.apiBase, target.nodeId));
  const answer = cache?.answers.get(messageId);
  if (cache && answer) {
    cache.answers.set(messageId, answer.filter((item) => !sameSource(item, source)));
    notify(cache.apiBase, cache.nodeId, messageId);
  }
  for (const other of caches.values()) {
    if (other.apiBase !== target.apiBase) continue;
    if (source.kind === 'memory') dropMemory(other, source.memoryId, 'remove');
    else dropItems(other, (item) => item.kind === 'conversation' && item.docId === source.docId, 'remove');
  }
}

function sameSource(a: ReplyMemorySource, b: ReplyMemorySource): boolean {
  return a.kind === 'memory' ? b.kind === 'memory' && a.memoryId === b.memoryId : b.kind === 'conversation' && a.docId === b.docId;
}

function sameSources(a: readonly ReplyMemorySource[], b: readonly ReplyMemorySource[]): boolean {
  return a.length === b.length && a.every((item, index) => JSON.stringify(item) === JSON.stringify(b[index]));
}

/** The cached answers holding a matching item lose it (remove) or ask again (refetch: mounted lines re-request). */
function dropItems(cache: NodeCache, matches: (item: ReplyMemorySource) => boolean, how: 'remove' | 'refetch'): void {
  for (const [messageId, answer] of [...cache.answers]) {
    if (!answer.some(matches)) continue;
    if (how === 'remove') cache.answers.set(messageId, answer.filter((item) => !matches(item)));
    else cache.answers.delete(messageId);
    notify(cache.apiBase, cache.nodeId, messageId);
  }
}

/** A memory changed: its messages lose it (deleted) or ask again (updated, put away). */
function dropMemory(cache: NodeCache, memoryId: string, how: 'remove' | 'refetch'): void {
  dropItems(cache, (item) => item.kind === 'memory' && item.memoryId === memoryId, how);
}

function dropCache(cache: NodeCache): void {
  const messages = [...cache.answers.keys()];
  cache.answers.clear();
  notifyAll(cache, messages);
}

let invalidation: Array<() => void> | null = null;

/** The feeds that change what a cached answer would say, listened to once a footer asked. */
function ensureInvalidation(): void {
  if (invalidation) return;
  invalidation = [
    // This machine's change feed: only answers from this machine's backend name its memories.
    onMemoryChanged((event: MemoryChangedEvent) => {
      if (event.action === 'created') return;
      const removed = event.action === 'deleted' || event.action === 'rejected';
      if (removed) noteForgotten(API_BASE_URL, `m:${event.memoryId}`);
      for (const cache of caches.values()) {
        if (cache.apiBase !== API_BASE_URL) continue;
        dropMemory(cache, event.memoryId, removed ? 'remove' : 'refetch');
      }
    }),
    onConversationMemoryModeChange((apiBase, nodeId) => {
      const cache = caches.get(cacheKey(apiBase, nodeId));
      if (cache) dropCache(cache);
      // A chat that stops learning is no longer a past chat any reply may name.
      for (const other of caches.values()) {
        if (other.apiBase === apiBase) dropItems(other, (item) => item.kind === 'conversation' && item.from.nodeId === nodeId, 'refetch');
      }
    }),
    onMemoryOnChange((apiBase) => {
      for (const cache of caches.values()) if (cache.apiBase === apiBase) dropCache(cache);
    }),
  ];
}

/**
 * What a settled reply (an assistant message) was based on, in its
 * conversation (ReplySourcesContext): asks once it is settled and its turn is
 * done, and follows the cache. [] while unknown, with none, outside a
 * conversation that offers it, or before the reply settled.
 */
export function useReplyMemorySources(messageId: string, settled: boolean): { target: ReplySourcesTarget | null; sources: readonly ReplyMemorySource[] } {
  const target = useContext(ReplySourcesContext);
  const apiBase = target?.apiBase ?? '';
  const nodeId = target?.nodeId ?? '';
  // A reply whose turn still runs (its hidden tail after the visible answer) asks once the turn is done.
  const active = !!target && settled && !!messageId && target.runningMessageId !== messageId;
  const subscribe = useCallback((listener: () => void) => (active ? subscribeReplySources({ apiBase, nodeId }, messageId, listener) : () => {}),
    [active, apiBase, nodeId, messageId]);
  const snapshot = useCallback(() => (active ? readReplySources({ apiBase, nodeId }, messageId) : undefined), [active, apiBase, nodeId, messageId]);
  const sources = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (active && sources === undefined) requestReplySources({ apiBase, nodeId }, messageId);
  }, [active, apiBase, nodeId, messageId, sources]);
  return { target: active ? target : null, sources: sources ?? EMPTY };
}

/**
 * Forget every answer and subscription between test cases.
 * @testonly
 */
export function resetReplySources(): void {
  for (const cache of caches.values()) if (cache.timer) clearTimeout(cache.timer);
  caches.clear();
  unsupported.clear();
  forgottenOn.clear();
  subscribers.clear();
  for (const stop of invalidation ?? []) stop();
  invalidation = null;
}
