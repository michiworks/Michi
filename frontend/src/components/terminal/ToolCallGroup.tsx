import React, { useMemo } from 'react';
import type { ToolCallState, SubagentInfo } from '../../state/chatTypes';
import { LineToolGroup } from './AgentLineBlocks';
import { visibleGroupTools, withConversationTone } from './subagents/subagentPresentation';
import { useDelegationTone } from './subagents/useDelegationTone';

interface Props {
  tools: ToolCallState[];
  subagents?: readonly SubagentInfo[];
  /** The group is the newest content of a streaming turn: it stays live
   *  between its calls ("Working…") instead of settling. */
  live?: boolean;
}

function ToolCallGroupInner({ tools, subagents, live = false }: Props) {
  const ownTools = useMemo(() => visibleGroupTools(tools, subagents), [tools, subagents]);
  // A lone delegation's status as its conversation presents the agent: the
  // line's status and failure agree with it.
  const tone = useDelegationTone(ownTools, subagents);
  const visibleTools = useMemo(() => withConversationTone(ownTools, tone), [ownTools, tone]);
  if (visibleTools.length === 0) return null;
  return <LineToolGroup tools={visibleTools} subagents={subagents} live={live} />;
}

function sameTools(a: ToolCallState[], b: ToolCallState[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const ToolCallGroup = React.memo(ToolCallGroupInner, (prev, next) =>
  prev.live === next.live &&
  sameTools(prev.tools, next.tools) &&
  prev.subagents === next.subagents,
);
