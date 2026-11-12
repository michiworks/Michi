import { backendEntityId } from '../../config/backendIdentity';
import { requestMessageJump } from '../sourceNav/sourceNav';

export interface ExactPageSource {
  kind: 'chat' | 'helper';
  nodeId: string;
  turnId: string;
  assistantId: string;
}

/**
 * Reveal the source chat, then ask its pane to load/scroll to the exact answer
 * message. A former page helper's source opens the same way: it is a chat.
 */
export async function revealPageSource(
  identity: { backendConnectionId: string; workspaceId: string },
  source: Pick<ExactPageSource, 'nodeId' | 'assistantId'>,
  revealBackendNode: (workspaceId: string, nodeId: string) => Promise<boolean>,
): Promise<boolean> {
  const workspaceId = backendEntityId(identity.backendConnectionId, identity.workspaceId);
  const nodeId = backendEntityId(identity.backendConnectionId, source.nodeId);
  if (!await revealBackendNode(workspaceId, nodeId)) return false;
  requestMessageJump(nodeId, source.assistantId);
  return true;
}
