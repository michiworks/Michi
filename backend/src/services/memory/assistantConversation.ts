import { isAssistantWorkspaceSettings, isSystemWorkspaceSettings } from 'michi-shared';
import { assistantPurposeOf } from '../../assistant/identity';
import { getWorkspace } from '../dbRepository';

/**
 * V, the user's conversation with their Michi assistant, is the one
 * conversation of a system workspace Michi Memory learns from, as from any
 * other: extraction enrolls and reads it, recall indexes it, other
 * conversations' Recent shows it and its replies get reply sources. V is a
 * 'main' conversation of the assistant's hidden workspace, the current one or
 * one New conversation archived (assistant/identity.assistantPurposeOf, which
 * fails closed). A check-in's throwaway node (`n-cmph-…`), the MVP's closed
 * conversation and every other node of a system workspace stay out, and so
 * does every system workspace in the cloud, where the assistant does not
 * exist. That workspace is never a memory scope: what V's turns yield is the
 * user's (holdsWorkspaceMemories).
 */

function assistantWorkspace(settings: string | null | undefined): boolean {
  return process.env.MICHI_CLOUD !== '1' && isAssistantWorkspaceSettings(settings);
}

/** Whether memory reads conversations of a workspace with these settings: an ordinary one, or the assistant's (V's alone). */
export function learnsInWorkspace(settings: string | null | undefined): boolean {
  return !isSystemWorkspaceSettings(settings) || assistantWorkspace(settings);
}

/** Whether memory learns from this conversation as far as its workspace goes: any of an ordinary workspace; of a system one, V alone. */
export function learnsFromConversation(nodeId: string, workspaceSettings: string | null | undefined): boolean {
  if (!isSystemWorkspaceSettings(workspaceSettings)) return true;
  return assistantWorkspace(workspaceSettings) && assistantPurposeOf(nodeId) === 'main';
}

/** Whether a workspace is a memory scope of its own: a system one never is (V's memories are the user's). */
export function holdsWorkspaceMemories(workspaceId: string): boolean {
  return !isSystemWorkspaceSettings(getWorkspace(workspaceId)?.settings);
}
