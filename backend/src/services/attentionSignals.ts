/**
 * Facts the attention service (services/attention/) needs from code that has
 * no business knowing about it: a focused window recorded a node's
 * completions as seen, or the user answered an approval. Producers publish;
 * server.ts subscribes the service.
 */

import { createListenerSet } from 'michi-shared';

/** The view mark advanced nodes.seen_completion_seq (domainCommands.ts). Published after the
 *  command batch commits, so a listener reads the committed row. */
export interface NodeCompletionSeen {
  workspaceId: string;
  nodeId: string;
  seenCompletionSeq: number;
}

/** The permission route answered (approved or denied) a pending request. ChatHub clears its
 *  pending state for it without broadcasting an event, so this is the only signal. */
export interface PermissionAnswered {
  nodeId: string;
  /** The turn that asked, when the pending request named it. */
  turnId?: string;
  requestId: number;
}

// A failing listener must not fail the request that produced the fact.
const completionSeen = createListenerSet<[NodeCompletionSeen]>();
const permissionAnswered = createListenerSet<[PermissionAnswered]>();

export const subscribeNodeCompletionSeen = completionSeen.subscribe;
export const publishNodeCompletionSeen = completionSeen.emit;
export const subscribePermissionAnswered = permissionAnswered.subscribe;
export const publishPermissionAnswered = permissionAnswered.emit;
