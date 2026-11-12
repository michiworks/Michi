/**
 * Answering a chat's pending permission request: the body of
 * POST /chats/:chatId/permission-response (routes/michi.ts), shared with the
 * multi-model approval mirror (services/multiModel/approvalsMirror.ts), which
 * answers a branch's request from its run card.
 */
import { chatHub } from '../agents/chatHub';
import * as sessionRegistry from '../agents/sessionRegistry';
import type { AgentSession } from '../agents/types';
import { publishPermissionAnswered } from './attentionSignals';
import { getNodeSessionBinding } from './dbRepository';

export type PermissionAnswer = { requestId: number; optionId: string } | { requestId: number; cancel: true };
export type PermissionAnswerResult =
  | { ok: true; nodeId: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** The node a public chat identifier names: its live session, else its durable binding. */
export function resolvePublicNodeId(identifier: string, userId?: string | null): string | null {
  const live = sessionRegistry.getSessionForUser(identifier, userId ?? null);
  if (live) return live.id;
  return getNodeSessionBinding(identifier, userId ?? undefined)?.nodeId ?? null;
}

/** The live session of a public chat identifier, owner-checked in cloud mode. */
export function getSessionByIdentifier(identifier: string, userId?: string | null): AgentSession | null {
  const nodeId = resolvePublicNodeId(identifier, userId);
  return nodeId ? sessionRegistry.getSessionForUser(nodeId, userId ?? null) : null;
}

export function answerChatPermission(chatId: string, userId: string | null, answer: PermissionAnswer): PermissionAnswerResult {
  const session = getSessionByIdentifier(chatId, userId);
  if (!session) return { ok: false, status: 404, error: 'unknown chat' };
  const nodeId = session.id;
  const { requestId } = answer;
  const pending = chatHub.getPendingPermission(nodeId);
  if (!pending || pending.requestId !== requestId) {
    return { ok: false, status: 409, error: 'Permission request is no longer pending' };
  }
  // Answered here, not in a hub event: the attention service resolves its approval notice.
  const answered = () => publishPermissionAnswered({ nodeId, turnId: pending.turnId, requestId });
  if ('cancel' in answer) {
    session.cancelPermission?.(requestId);
    chatHub.resolvePermission(nodeId, requestId);
    answered();
    return { ok: true, nodeId };
  }
  if (!pending.options.some((option) => option.optionId === answer.optionId && !option.disabled)) {
    return { ok: false, status: 400, error: 'Invalid permission option' };
  }
  if (!session.respondToPermission) {
    return { ok: false, status: 400, error: 'Session does not support permissions' };
  }
  session.respondToPermission(requestId, answer.optionId);
  chatHub.resolvePermission(nodeId, requestId);
  answered();
  return { ok: true, nodeId };
}
