import type { MetaAgentChatTurnContext } from 'michi-shared';
import { provideMetaAgentTurnContext } from '../../services/api/assistant';
import { takeSentAssistantAttachments } from '../assistant/assistantComposer';
import { getCompanionAssistant, subscribeCompanion } from './companionStore';
import { getCompanionPanelState } from './companionPanel';
import { takeCompanionPostReply } from './companionReply';
import { companionScheduleWorkspace, companionSpacesScreen } from './companionScreen';
import { buildCompanionTurnContext } from './companionTurnContext';

/**
 * What each message to V carries (DESIGN-v2 §1.3), registered for V's node
 * at module level (F1a-review #1), not by the Chat tab: a message queued
 * while V answers goes out after the panel closed, and a retry or a send a
 * caller requested may run with the tab unmounted. The store reads it when
 * the user sends (captureMetaAgentTurnContext) and keeps it with the message.
 *
 * `consume`: the user's own send takes the chips it carried and the post it
 * replies to, once; a retry reads the area and target without them.
 */
function readCompanionTurnContext(nodeId: string, { consume }: { consume: boolean }): MetaAgentChatTurnContext | null {
  const onSpaces = companionSpacesScreen();
  const schedule = companionScheduleWorkspace();
  return buildCompanionTurnContext({
    area: onSpaces ? 'spaces' : schedule !== undefined ? 'scheduled' : 'conversations',
    spaces: onSpaces,
    scheduleWorkspaceId: schedule,
    target: getCompanionPanelState().target,
    attachments: consume ? takeSentAssistantAttachments(nodeId) : [],
    replyTo: consume ? takeCompanionPostReply(nodeId) : null,
  });
}

let registered: { nodeId: string; stop: () => void } | null = null;
let installed = false;

function sync(): void {
  const nodeId = getCompanionAssistant().info?.nodeId ?? null;
  if (registered?.nodeId === nodeId) return;
  registered?.stop();
  registered = nodeId
    ? { nodeId, stop: provideMetaAgentTurnContext(nodeId, (options) => readCompanionTurnContext(nodeId, options)) }
    : null;
}

/** Keeps the provider registered for whichever conversation V is now; idempotent. */
export function ensureCompanionTurnSource(): void {
  if (installed) return;
  installed = true;
  subscribeCompanion(sync);
  sync();
}

// Module level: the shell imports the panel, and with it this, before any message is sent.
ensureCompanionTurnSource();
