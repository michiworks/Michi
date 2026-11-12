import { backendConnectionIdForWorkspace } from '../config/backendConnections';
import { invalidateTurnPageReceipt, parseTurnPageInvalidation } from '../lib/turnPageReceipt';
import { reportRemoteCredentialError, reportRemoteRuntimeReady } from './remoteAuthentication';

interface ToolFrame {
  toolCallId: string;
  title?: string;
  status?: string;
  output?: string;
  inputJson?: string;
}

/** How a done frame ends its turn: an error the user inspects (never re-sends), or done, aborted for a cancel. */
export function doneOutcome(stopReason?: string, persisted?: boolean):
  { error: { message: string; errorKind: 'turn_persistence_failed' | 'turn_outcome_unknown' }; aborted?: undefined } | { error?: undefined; aborted: true | undefined } {
  if (persisted === false) {
    return { error: { message: 'The turn finished but the backend did not confirm durable persistence.', errorKind: 'turn_persistence_failed' } };
  }
  if (stopReason === 'error') return { error: { message: 'Agent process exited before completing the turn.', errorKind: 'turn_outcome_unknown' } };
  return { aborted: stopReason === 'cancel' || stopReason === 'cancelled' || undefined };
}

export interface TurnStreamEffects {
  /** A tool call or its update: a completed page, database, component or task-database write refreshes what shows it. */
  tool(tool: ToolFrame, turnId: string): void;
  /** Warning, MCP server error or error text: a remote credential error asks for sign-in. */
  runtimeMessage(text: string): void;
  /** The turn ended: one that completed without a credential error clears its connection's sign-in notice. The next turn starts clean. */
  end(completed: boolean): void;
}

/**
 * What a turn's stream does outside chat state, run alike by the sending
 * window's runner and by the binding of a turn it observes.
 */
export function createTurnStreamEffects({ nodeId, workspaceId }: {
  nodeId: string;
  workspaceId: () => string | undefined;
}): TurnStreamEffects {
  let credentialFailed = false;
  // A tool's title, input and output can arrive in separate frames.
  const toolStates = new Map<string, Omit<ToolFrame, 'toolCallId'>>();
  return {
    tool(tool, turnId) {
      const workspace = workspaceId();
      if (!workspace) return;
      const key = JSON.stringify([turnId, tool.toolCallId]);
      const complete = { ...toolStates.get(key),
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.status ? { status: tool.status } : {}),
        ...(tool.output !== undefined ? { output: tool.output } : {}),
        ...(tool.inputJson ? { inputJson: tool.inputJson } : {}),
      };
      toolStates.set(key, complete);
      const backendConnectionId = backendConnectionIdForWorkspace(workspace);
      const receipt = parseTurnPageInvalidation(complete, backendConnectionId);
      if (receipt) invalidateTurnPageReceipt(receipt, { backendConnectionId, workspaceId: workspace, nodeId, turnId }, tool.toolCallId);
    },
    runtimeMessage(text) {
      credentialFailed = reportRemoteCredentialError(nodeId, text) || credentialFailed;
    },
    end(completed) {
      if (completed && !credentialFailed) reportRemoteRuntimeReady(nodeId);
      credentialFailed = false;
      toolStates.clear();
    },
  };
}
