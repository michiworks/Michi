import type { MichiContextItem } from 'michi-shared';
import { openCompanionPanel } from '../companion/companionPanel';

/** Where the user was when they called the assistant; it answers with that page in mind. */
export interface MichiAssistantPage {
  kind: 'home' | 'page' | 'threads' | 'pane' | 'other';
  projectId?: string;
  nodeId?: string;
}

export interface OpenMichiAssistantOptions {
  /** Shown as chips above the assistant's composer. */
  attachments?: MichiContextItem[];
  /** Pre-filled composer text. */
  prompt?: string;
  /** Send `prompt` right away instead of leaving it in the composer. */
  send?: boolean;
  page?: MichiAssistantPage;
}

/**
 * Open the agent's panel on Chat (DESIGN-v2 §1.2: "Hand to agent…" and the
 * other callers are unchanged and land in the one panel): the chips above its
 * composer, the prompt left in it, or sent when the caller asked. Any surface
 * may call this. The page the caller names is not passed on: the panel names
 * what is on screen itself.
 */
export function openMichiAssistant(options: OpenMichiAssistantOptions = {}): void {
  const prompt = options.prompt?.trim();
  openCompanionPanel({
    ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    ...(prompt ? (options.send ? { send: prompt } : { draft: prompt }) : {}),
    tab: 'chat',
  });
}
