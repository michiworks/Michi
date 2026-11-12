/**
 * The posted check-in a message replies to (DESIGN-v2 §1.3, §2.8 T4): a
 * post's chip filled the composer (T3), so the message the user sends next
 * carries `{kind:'post', messageId}` in metaAgentContext.refs and its turn
 * starts in Ask. Per node, in memory only; taken by the send that carries it.
 */
const replies = new Map<string, string>();

export function noteCompanionPostReply(nodeId: string, postMessageId: string): void {
  replies.set(nodeId, postMessageId);
}

/** The post the next send to `nodeId` replies to, once. */
export function takeCompanionPostReply(nodeId: string): string | null {
  const id = replies.get(nodeId) ?? null;
  replies.delete(nodeId);
  return id;
}

/** @testonly */
export function resetCompanionRepliesForTests(): void {
  replies.clear();
}
