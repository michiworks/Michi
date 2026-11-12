import { OPEN_SETTINGS_SECTION_EVENT } from '../../scheduled/metaAgent/metaAgentNav';

/**
 * Edit from what a reply was based on (ReplyMemorySources.tsx): opens
 * Settings › Memory with that memory found and marked. MemoryPane takes the
 * request when it mounts, or at once when it is open already. Settings lists
 * this machine's memories only, so the footer offers it only for a
 * conversation on this machine's backend. It lives with the pane, not in
 * state/, because state/ never imports components.
 */

export interface MemoryRevealRequest {
  id: string;
  /** What the pane searches by when the memory is not on its first page. */
  body: string;
}

let pending: MemoryRevealRequest | null = null;
const listeners = new Set<(request: MemoryRevealRequest) => void>();

export function requestMemoryReveal(request: MemoryRevealRequest): void {
  pending = { id: request.id, body: request.body };
  for (const listener of [...listeners]) listener(pending);
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'memory' } }));
}

/** The request waiting for the pane, taken once. */
export function takeMemoryReveal(): MemoryRevealRequest | null {
  const request = pending;
  pending = null;
  return request;
}

/** A mounted pane takes later requests at once. Returns unsubscribe. */
export function onMemoryReveal(listener: (request: MemoryRevealRequest) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
