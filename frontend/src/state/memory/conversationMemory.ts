/**
 * Whether memory is on at a backend, as Settings › Memory last turned it, for
 * what shows memory in this window (replySources.ts). No chat has a memory
 * choice of its own any more: a chat that keeps out of memory is a temporary
 * chat, chosen on Home before its first message (ChatNodeState.temporary).
 */

const memoryOnListeners = new Set<(apiBase: string, on: boolean) => void>();

/** Settings › Memory turned memory on or off at this backend. */
export function noteMemoryOn(apiBase: string, on: boolean): void {
  for (const listener of [...memoryOnListeners]) listener(apiBase, on);
}

/** Calls `listener` whenever Settings › Memory turns memory on or off at a backend (noteMemoryOn). Returns unsubscribe. */
export function onMemoryOnChange(listener: (apiBase: string, on: boolean) => void): () => void {
  memoryOnListeners.add(listener);
  return () => { memoryOnListeners.delete(listener); };
}
