import type { ToolCallState, SubagentInfo } from '../../../state/chatTypes';
import { compactWhitespace, detailField, parseDetailObject } from './toolInput';
import { isFailedStatus, isRunningStatus } from './toolStatus';

const SUBAGENT_TOOL_TITLES = new Set(['agent', 'task', 'subagent']);

export interface SubagentToolInfo {
  agentType?: string;
  description?: string;
  prompt?: string;
  model?: string;
}

function humanizeIdentifier(value: string | undefined): string | undefined {
  const compact = compactWhitespace(value?.replace(/[_-]+/g, ' '));
  if (!compact) return undefined;
  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

export function subagentToolInfo(tool: ToolCallState): SubagentToolInfo | null {
  const title = tool.title.trim().toLowerCase();
  const kind = tool.kind?.trim().toLowerCase();
  const detail = tool.detail;
  const detailObject = parseDetailObject(detail);
  // Only explicit subagent-type keys count. A bare `type` key must NOT be
  // treated as a subagent signal: a completed tool's `detail` is overwritten
  // with its result content (e.g. `[{"type":"text",...}]` for MCP tools), and
  // matching that `"type":"text"` would mislabel every MCP tool as
  // "SubAgent · Text".
  const agentTypeKeys = ['subagent_type', 'subagentType', 'agent_type', 'agentType'];
  const rawAgentType = detailField(detail, detailObject, agentTypeKeys);
  const hasSignal =
    SUBAGENT_TOOL_TITLES.has(title) ||
    kind === 'subagent' ||
    !!rawAgentType ||
    /"subagent_type"\s*:/.test(detail ?? '');

  if (!hasSignal) return null;

  // Runtimes that keep `detail` for purpose text carry the delegation input in
  // `inputJson` (Kiro V3, Codex). Explicit subagent tools may name the agent
  // with a plain `name` key there; other tools never reach this point.
  const input = tool.inputJson;
  const inputObject = parseDetailObject(input);
  const fromEither = (keys: string[]) => detailField(detail, detailObject, keys) ?? detailField(input, inputObject, keys);
  const agentType = rawAgentType
    ?? detailField(input, inputObject, agentTypeKeys)
    ?? (kind === 'subagent' ? detailField(input, inputObject, ['name']) : undefined);
  return {
    agentType: humanizeIdentifier(agentType),
    description: fromEither(['description', 'summary', 'goal', 'task', 'explanation']),
    prompt: fromEither(['prompt', 'query', 'instructions']),
    model: fromEither(['model']),
  };
}

/**
 * A tool that delegates: a recognised subagent tool, or any tool a roster
 * entry names as its parent (Kiro V2 crews report under "Spawning agent crew").
 */
export function delegationToolInfo(
  tool: ToolCallState,
  roster: readonly SubagentInfo[] | undefined,
): SubagentToolInfo | null {
  const info = subagentToolInfo(tool);
  if (info) return info;
  return roster?.some((entry) => entry.parentToolCallId === tool.id) ? {} : null;
}

export function subagentHeading(info: SubagentToolInfo): string {
  return info.agentType ? `SubAgent · ${info.agentType}` : 'SubAgent';
}

export function subagentStatusLabel(status: string | undefined): string {
  if (isFailedStatus(status)) return 'failed';
  if (isRunningStatus(status)) return 'working';
  return 'completed';
}

/**
 * Returns true if `tool` is a SubAgent tool-call (parent-session) that
 * plausibly corresponds to `subagent`. Match is best-effort: agentType
 * equality OR text overlap between the tool's description/prompt and the
 * subagent's `initialQuery`. False for non-subagent tools.
 */
export function subagentTitleMatches(tool: ToolCallState, subagent: SubagentInfo): boolean {
  const info = subagentToolInfo(tool);
  if (!info) return false;

  const agentTypeNorm = info.agentType?.toLowerCase().trim();
  const subAgentName = subagent.agentName?.toLowerCase().trim();
  if (agentTypeNorm && subAgentName && agentTypeNorm === subAgentName) return true;

  const initial = subagent.initialQuery?.trim();
  if (!initial) return false;

  const description = info.description?.trim();
  const prompt = info.prompt?.trim();

  return description === initial || prompt === initial;
}

/**
 * Drops parent-stream tool-calls that a subagent reported as its own
 * activity (same tool-call id), so a relayed child tool renders once — in
 * the subagent's trail — not again as a parent row. Delegation tool-calls
 * themselves are always kept; they ARE the card.
 *
 * Matching is exact. Runtimes route child tools to subagent activity, so the
 * parent's own tools — including ones running in parallel with a subagent or
 * after a backgrounded one — always stay visible. (An earlier heuristic hid
 * every running peer while any subagent worked; with rosters on every
 * runtime that hid the parent's real work.)
 *
 * If `subagents` is empty/undefined the input is returned as-is, so this
 * is safe to call unconditionally on every tool group.
 */
export function filterSubagentRelayedTools(
  tools: readonly ToolCallState[],
  subagents: readonly SubagentInfo[] | undefined,
): ToolCallState[] {
  if (!subagents || subagents.length === 0) return [...tools];
  const relayed = new Set<string>();
  for (const subagent of subagents) {
    for (const item of subagent.activity ?? []) {
      if (item.kind === 'tool') relayed.add(item.id);
    }
  }
  if (relayed.size === 0) return [...tools];
  return tools.filter((tool) => !relayed.has(tool.id) || !!delegationToolInfo(tool, subagents));
}
