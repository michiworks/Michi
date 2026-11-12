import { useCallback, useContext, useMemo, useRef, useSyncExternalStore } from 'react';
import { ChatNodeStoreContext } from '../../../state/chatStore';
import type { SubagentInfo } from '../../../state/chatTypes';
import { conversationSubagentState, type ConversationSubagentState } from '../../../state/backgroundWork';
import { selectLiveBackgroundSubagents, useOptionalWorkflowDomain } from '../../../state/workflowDomain';
import { shownSubagent, subagentTone, type SubagentTone } from '../subagents/subagentPresentation';

const noSubscription = () => () => {};

/**
 * A conversation's node and its liveness: a subscription to that node (and
 * the workflow domain, for liveness) only, and a read of both. Without a
 * node id there is nothing to subscribe to.
 */
function useConversationSource(nodeId: string | null) {
  const store = useContext(ChatNodeStoreContext);
  const workflows = useOptionalWorkflowDomain()?.store;
  const subscribe = useCallback((listener: () => void) => {
    if (!store || !nodeId) return noSubscription();
    const unsubscribeNode = store.subscribeNode(nodeId, listener);
    const unsubscribeLiveness = workflows?.subscribe(listener);
    return () => { unsubscribeNode(); unsubscribeLiveness?.(); };
  }, [store, workflows, nodeId]);
  const read = useCallback(() => {
    const node = store && nodeId ? store.getNode(nodeId) : undefined;
    // The node's workspace is its project: the feed its liveness comes on.
    const live = node && workflows ? selectLiveBackgroundSubagents(workflows.getState(), node.projectId, node.nodeId) : undefined;
    return { node, live };
  }, [store, workflows, nodeId]);
  return { subscribe, read };
}

/**
 * One subagent as its conversation knows it (copies from every turn folded,
 * whether it runs now, stopped once no live process tracks it), for the
 * transcript line of the message that holds one copy. Undefined without a
 * conversation or a chat store (specimens, provider-free tests).
 *
 * Subagent updates are HIGH_FREQ actions, so this subscribes to that node
 * (and the workflow domain, for liveness) only and returns the previous
 * value until the folded agent or its running state changes: stream chunks
 * and workflow progress do not re-render the line.
 */
export function useConversationSubagent(nodeId: string | null, sessionId: string | undefined): ConversationSubagentState | undefined {
  const { subscribe, read } = useConversationSource(sessionId ? nodeId : null);
  const last = useRef<ConversationSubagentState | undefined>(undefined);
  const getSnapshot = useCallback(() => {
    const { node, live } = read();
    const next = node && sessionId ? conversationSubagentState(node, sessionId, live) : undefined;
    const previous = last.current;
    if (previous && next
      && previous.subagent === next.subagent
      && previous.messageId === next.messageId
      && previous.active === next.active) {
      return previous;
    }
    last.current = next;
    return next;
  }, [read, sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * How many of these roster entries are in each tone, judged as their lines
 * judge them (SubagentSummaryLine): the conversation's folded copy when
 * another turn holds one, the entry's own copy otherwise. An agent its line
 * shows `in background` (its turn ended, its outcome has not landed) is
 * `background`; an agent no live process tracks reads `cancelled`.
 *
 * The snapshot is the tones joined into one string, so stream frames that
 * leave every tone as it is do not re-render the roster.
 */
export function useSubagentToneCounts(nodeId: string | null, subagents: readonly SubagentInfo[]): Readonly<Record<SubagentTone, number>> {
  const { subscribe, read } = useConversationSource(subagents.length > 0 ? nodeId : null);
  const getSnapshot = useCallback(() => {
    const { node, live } = read();
    return subagents.map((own) => {
      const shown = shownSubagent(own, node ? conversationSubagentState(node, own.sessionId, live) : undefined);
      return shown.folded ? subagentTone(shown.subagent, shown.active) : subagentTone(own);
    }).join(' ');
  }, [read, subagents]);
  const tones = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    const counts: Record<SubagentTone, number> = { running: 0, background: 0, completed: 0, ended: 0, failed: 0, cancelled: 0 };
    for (const tone of tones.split(' ')) if (tone) counts[tone as SubagentTone] += 1;
    return counts;
  }, [tones]);
}
