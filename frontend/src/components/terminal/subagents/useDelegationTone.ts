import type { SubagentInfo, ToolCallState } from '../../../state/chatTypes';
import { useBackgroundWorkNodeId } from '../backgroundWork/backgroundWorkEvents';
import { useConversationSubagent } from '../backgroundWork/useConversationSubagent';
import { subagentToolInfo } from '../toolCallGrouping';
import {
  shownSubagent,
  subagentsForTool,
  subagentTone,
  type SubagentTone,
} from './subagentPresentation';

/** The roster entry a group's lone delegation chip spawned, linked exactly (parentToolCallId). */
function linkedDelegationSubagent(
  tools: readonly ToolCallState[],
  roster: readonly SubagentInfo[] | undefined,
): SubagentInfo | undefined {
  if (tools.length !== 1 || !subagentToolInfo(tools[0])) return undefined;
  const linked = subagentsForTool(tools[0], roster);
  return linked.length === 1 && linked[0].parentToolCallId === tools[0].id ? linked[0] : undefined;
}

/**
 * The tone of a tool group whose one tool is a subagent delegation linked to
 * its roster entry: the agent as its conversation presents it (copies folded
 * across turns, liveness), as its SubagentSummaryLine shows it. A background
 * agent reads "in background", not its launch receipt's "completed";
 * "stopped" once no live process tracks it; a later turn's outcome once that
 * arrives. The tone keeps the group's status in agreement with it
 * (withConversationTone).
 *
 * Undefined, which leaves the tool status, without a conversation
 * (provider-free tests), for any other group, or when the conversation does
 * not hold the agent. Subscribes like useConversationSubagent: only that
 * agent's changes re-render.
 */
export function useDelegationTone(
  tools: readonly ToolCallState[],
  roster: readonly SubagentInfo[] | undefined,
): SubagentTone | undefined {
  const nodeId = useBackgroundWorkNodeId();
  const linked = linkedDelegationSubagent(tools, roster);
  const conversation = useConversationSubagent(nodeId, linked?.sessionId);
  if (!linked || !conversation) return undefined;
  const shown = shownSubagent(linked, conversation);
  return subagentTone(shown.subagent ?? linked, shown.active);
}
