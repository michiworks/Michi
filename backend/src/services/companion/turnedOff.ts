/**
 * Turning Michi off (Q29 item 4): the turn its conversation is running stops
 * at that moment, and an approval it waits for is denied first, so nothing
 * is left waiting on a panel the user no longer sees. Stopping is
 * intentional, not an error. A turn the user starts there afterwards (Pages'
 * Ask, a link into the conversation) asks for approvals as usual.
 */
import { chatHub } from '../../agents/chatHub';
import * as sessionRegistry from '../../agents/sessionRegistry';
import { answerChatPermission } from '../chatPermissionAnswers';
import { log } from '../logger';

export interface StopConversationDeps {
  hub: Pick<typeof chatHub, 'getPendingPermission' | 'cancel' | 'isOwnerTurnActive'>;
  answer: typeof answerChatPermission;
  session: (nodeId: string) => { cancel(): unknown } | null;
}

const DEFAULT_DEPS: StopConversationDeps = {
  hub: chatHub,
  answer: answerChatPermission,
  session: (nodeId) => sessionRegistry.getSession(nodeId) ?? null,
};

/** Denies the pending approval of the conversation `nodeId`, then stops its running turn. */
export async function stopConversationTurn(nodeId: string, ownerUserId: string | null, deps: StopConversationDeps = DEFAULT_DEPS): Promise<{ denied: boolean; cancelled: boolean }> {
  let denied = false;
  const pending = deps.hub.getPendingPermission(nodeId);
  if (pending) {
    // Deny as the card's Deny does (multiModel/approvalsMirror.ts); a request without one is dismissed.
    const deny = pending.options.find((option) => option.kind === 'reject_once' && !option.disabled);
    const result = deps.answer(nodeId, ownerUserId, deny ? { requestId: pending.requestId, optionId: deny.optionId } : { requestId: pending.requestId, cancel: true });
    denied = result.ok;
    if (!result.ok) log.warn('chat', 'denying the approval of a conversation turned off failed', { nodeId, error: result.error });
  }
  const cancelled = deps.hub.cancel(nodeId);
  // As POST /chats/:id/cancel: a runtime self-turn is the live session's to stop.
  const session = cancelled && !deps.hub.isOwnerTurnActive(nodeId) ? deps.session(nodeId) : null;
  if (session) await Promise.resolve(session.cancel());
  return { denied, cancelled };
}
