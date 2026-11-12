// How CodexSession maps a child (sub-agent) thread's frames onto the parent
// stream's sub-agent events. Pure; the session keeps the tracking state and
// decides which turn a frame goes into.
import {
  clampSubagentText,
  SUBAGENT_LIMITS,
  subagentInitialQuery,
  type SubagentInfo,
  type SubagentPatch,
} from 'michi-shared';
import type { NormalizedEvent } from '../../contract/events';

type ToolCallEvent = Extract<NormalizedEvent, { kind: 'tool_call' | 'tool_call_update' }>;

/** The roster entry of a child thread, from its `thread/started` Thread object. */
export function codexChildThreadInfo(thread: Record<string, unknown>, childId: string): SubagentInfo {
  // Extract agent identity from Thread object
  const agentNickname = typeof thread['agentNickname'] === 'string' ? thread['agentNickname'] : '';
  const agentRole = typeof thread['agentRole'] === 'string' ? thread['agentRole'] : '';
  const preview = typeof thread['preview'] === 'string' ? thread['preview'] : '';

  // Dig into SubAgentSource for richer metadata
  let spawnNickname = '';
  let spawnRole = '';
  const source = thread['source'];
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const subAgent = (source as Record<string, unknown>)['subAgent'];
    if (subAgent && typeof subAgent === 'object' && !Array.isArray(subAgent)) {
      const spawn = (subAgent as Record<string, unknown>)['thread_spawn'];
      if (spawn && typeof spawn === 'object' && !Array.isArray(spawn)) {
        const s = spawn as Record<string, unknown>;
        spawnNickname = typeof s['agent_nickname'] === 'string' ? s['agent_nickname'] : '';
        spawnRole = typeof s['agent_role'] === 'string' ? s['agent_role'] : '';
      }
    }
  }

  const name = agentNickname || spawnNickname || agentRole || spawnRole || childId.slice(0, 8);
  return {
    sessionId: childId,
    sessionName: name,
    agentName: agentNickname || spawnNickname || 'codex',
    initialQuery: subagentInitialQuery(preview),
    status: 'working',
    group: '',
    dependsOn: [],
    source: 'codex',
  };
}

/** A child's tool call or tool call update, as the child's activity. */
export function codexChildToolActivity(childId: string, ev: ToolCallEvent): NormalizedEvent {
  return {
    kind: 'subagent_tool_activity',
    subagentSessionId: childId,
    title: ev.title,
    status: ev.status ?? '',
    ...(ev.toolCallId ? { toolCallId: ev.toolCallId } : {}),
    ...(ev.kindType ? { toolKind: ev.kindType } : {}),
    ...(ev.kind === 'tool_call' && ev.detail ? { detail: ev.detail } : {}),
    ...(ev.kind === 'tool_call_update' && ev.output ? { output: ev.output } : {}),
  };
}

/** One of a child's earlier agent messages (narration; the last is its result), as its activity. */
export function codexChildNarration(childId: string, seq: number, text: string): NormalizedEvent {
  return {
    kind: 'subagent_tool_activity',
    subagentSessionId: childId,
    toolCallId: `${childId}:m:${seq}`,
    title: clampSubagentText(text, SUBAGENT_LIMITS.title) ?? '',
    status: '',
    activityKind: 'message',
  };
}

/** How a child's turn ended: its outcome, its final answer (`result`) and its error. */
export function codexChildTurnEndPatch(
  childId: string,
  stopReason: string | undefined,
  answer: string,
  childError: string | undefined,
): SubagentPatch {
  const failed = stopReason === 'error' || !!childError;
  const cancelled = stopReason === 'cancelled';
  return {
    sessionId: childId,
    status: 'terminated',
    outcome: failed ? 'failed' : cancelled ? 'cancelled' : 'completed',
    ...(answer.trim() ? { result: clampSubagentText(answer.trim(), SUBAGENT_LIMITS.result) } : {}),
    ...(childError ? { error: clampSubagentText(childError, SUBAGENT_LIMITS.error) } : {}),
  };
}

/** A child's `thread/closed`, or its `thread/status/changed` to idle. */
export function isCodexChildThreadClosed(method: string, params: Record<string, unknown>): boolean {
  if (method !== 'thread/closed' && method !== 'thread/status/changed') return false;
  const status = params['status'];
  return method === 'thread/closed'
    || (typeof status === 'object' && status !== null && (status as Record<string, unknown>)['type'] === 'idle');
}
