/**
 * The CompanionService routes use while the coordinator does not run in this
 * process (before boot.ts starts it, without a scheduler, with
 * MICHI_DISABLE_COMPANION=1): nothing polls and no check-in runs, so there
 * is no welcome or catch-up; Check now answers as the real one does in a
 * process without the scheduler lease.
 *
 * Also here: how an applied conversation.start card starts its conversation
 * (startCompanionDelegation, given to cards.ts by server.ts).
 */

import { currentAssistantNodeId, ensureAssistant } from '../../assistant/store';
import { startConversationTool } from '../metaAgent/startConversation';
import type { CompanionStartedConversation } from './cards';
import { notOwner } from './errors';
import type { CompanionService } from './types';

export interface NoopCompanionServiceDeps {
  /**
   * True while the conversation answers or its runtime still cleans up:
   * chatHub.isActive, isOwnerTurnActive or hasPendingSelfTurn.
   */
  conversationBusy(nodeId: string): boolean;
  /**
   * Whether this process holds the scheduler lease, and so is the one that
   * runs the Companion (R2.14). Without it every check is accepted.
   */
  holdsSchedulerLease?(): boolean;
}

/**
 * CompanionService contract notes the coordinator keeps too: checkNow
 * throws notOwner() (errors.ts; the route answers 409 `not_owner`) in a
 * process that does not hold the scheduler lease. Without catchUp the
 * snapshot shows the stored "Since you left" (repository.latestCatchUp).
 */
export function createNoopCompanionService(deps: NoopCompanionServiceDeps): CompanionService {
  return {
    checkNow: () => {
      if (deps.holdsSchedulerLease && !deps.holdsSchedulerLease()) throw notOwner();
    },
    onPresence: async () => {},
    requestWelcome: async () => ({ started: false }),
    isBusy: () => {
      const nodeId = currentAssistantNodeId();
      return nodeId !== null && deps.conversationBusy(nodeId);
    },
  };
}

/** `CODE: message` (a start_conversation refusal) as the message alone. */
function refusalMessage(text: string): string {
  return text.replace(/^[A-Z_]+: /, '').trim() || 'The conversation could not start';
}

/**
 * Starts the conversation of an applied conversation.start card (R2.1) with
 * the Meta agent's start_conversation logic, as the agent's conversation V
 * (the one the user talks to it in): the same workspace checks, the user's
 * global runtime settings, and the brief as its first message. The user's
 * Apply on the card is the approval, so none is asked again. Rejects with
 * the reason it could not start.
 */
export async function startCompanionDelegation(input: { workspaceId: string; title: string; text: string }): Promise<CompanionStartedConversation> {
  const agent = ensureAssistant();
  const result = await startConversationTool(
    { ownerUserId: null, workspaceId: agent.workspaceId, nodeId: agent.nodeId },
    { workspaceId: input.workspaceId, title: input.title, text: input.text },
    async () => ({ approved: true }),
  );
  const text = result.content.map((part) => part.text).join('\n');
  if (result.isError) throw new Error(refusalMessage(text));
  let answer: { conversation?: { nodeId?: unknown; workspaceId?: unknown; title?: unknown } };
  try {
    answer = JSON.parse(text) as typeof answer;
  } catch {
    throw new Error('The conversation did not report how it started');
  }
  const conversation = answer.conversation;
  if (!conversation || typeof conversation.nodeId !== 'string' || typeof conversation.workspaceId !== 'string') {
    throw new Error('The conversation did not report how it started');
  }
  return {
    workspaceId: conversation.workspaceId,
    nodeId: conversation.nodeId,
    title: typeof conversation.title === 'string' ? conversation.title : input.title,
  };
}
