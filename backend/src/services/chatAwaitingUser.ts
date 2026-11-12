import type { ChatHub } from '../agents/chatHub';

/** What a chat's turn waits on the user for. `detail` is the runtime's own words, unsanitized. */
export interface ChatAwaitingUser {
  kind: 'approval' | 'question';
  /** The tool's title, or the question (its header when it has no text). */
  detail?: string;
}

/**
 * The chat's unresolved approval, else its unanswered question, in this
 * process's ChatHub. ChatHub drops both when the turn ends, so only a running
 * turn has one. Read by the Spaces Home (chatHubLiveWait), progress cards
 * (chatHubLiveTurn) and send_to_thread (ThreadMessagingDeps.awaitingUser).
 */
export function chatHubAwaitingUser(hub: Pick<ChatHub, 'getPendingPermission' | 'getPendingUserInput'>, chatId: string): ChatAwaitingUser | null {
  const permission = hub.getPendingPermission(chatId);
  if (permission) return { kind: 'approval', detail: permission.title };
  const input = hub.getPendingUserInput(chatId);
  if (!input) return null;
  const first = input.questions?.[0];
  return { kind: 'question', detail: first?.question || first?.header };
}
