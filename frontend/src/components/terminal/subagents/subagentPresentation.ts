import type { ChatNodeState, SubagentInfo, ToolCallState } from '../../../state/chatTypes';
import { conversationSubagents, type ConversationSubagentState } from '../../../state/backgroundWork';
import {
  delegationToolInfo,
  filterSubagentRelayedTools,
  isFailedStatus,
  isHiddenInternalTool,
  isRunningStatus,
  subagentTitleMatches,
  subagentToolInfo,
  type SubagentToolInfo,
} from '../toolCallGrouping';

/** One visual state per subagent, derived from roster status + outcome. */
export type SubagentTone = 'running' | 'completed' | 'failed' | 'cancelled' | 'background' | 'ended';

/**
 * `active` is the conversation's view (isSubagentRunningIn) where a caller
 * has it: a `working` entry it does not count as running reads as ended.
 * Without it, `working` is taken at its word.
 */
export function subagentTone(subagent: SubagentInfo, active?: boolean): SubagentTone {
  if (subagent.status === 'working') return active === false ? 'ended' : 'running';
  if (subagent.outcome === 'failed') return 'failed';
  if (subagent.outcome === 'cancelled') return 'cancelled';
  if (subagent.outcome === 'completed') return 'completed';
  // Its turn closed while it kept running; the outcome lands in a later turn.
  if (subagent.background) return 'background';
  return 'ended';
}

export const SUBAGENT_TONE_LABEL: Record<SubagentTone, string> = {
  running: 'working',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stopped',
  background: 'in background',
  ended: 'ended',
};

export const SUBAGENT_TONE_COLOR: Record<SubagentTone, string> = {
  running: 'var(--term-run)',
  completed: 'var(--term-digest)',
  failed: 'var(--term-danger-text)',
  cancelled: 'var(--term-muted)',
  background: 'var(--term-mid)',
  ended: 'var(--term-muted)',
};

/** Tool-status vocabulary for chrome that only understands tool states. */
export function subagentToolStatus(subagent: SubagentInfo, active?: boolean): string {
  const tone = subagentTone(subagent, active);
  if (tone === 'running') return 'in_progress';
  if (tone === 'failed') return 'failed';
  return 'completed';
}

export type ShownSubagent =
  | { folded: true; subagent: SubagentInfo; active: boolean }
  | { folded: false; subagent: SubagentInfo | undefined; active: undefined };

/**
 * The agent a message's transcript shows, given its own roster copy and the
 * conversation's (useConversationSubagent): the conversation's copy, with
 * whether it runs, when that is not the own copy (another turn holds a copy
 * too: a newer status, the launch turn's steps; or liveness stopped it).
 * Otherwise the own copy, its `working` taken at its word, and the caller's
 * status stands (it knows legacy rosters).
 */
export function shownSubagent(
  own: SubagentInfo | undefined,
  conversation: ConversationSubagentState | undefined,
): ShownSubagent {
  if (own && conversation && conversation.subagent !== own) {
    return { folded: true, subagent: conversation.subagent, active: conversation.active };
  }
  return { folded: false, subagent: own, active: undefined };
}

const PLACEHOLDER_NAMES = new Set(['', 'subagent']);

function humanize(value: string): string {
  const compact = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return compact ? compact.charAt(0).toUpperCase() + compact.slice(1) : '';
}

/** The agent's own name, or undefined when the runtime only gave a placeholder. */
function subagentOwnName(subagent: SubagentInfo): string | undefined {
  const agent = subagent.agentName?.trim() ?? '';
  if (!PLACEHOLDER_NAMES.has(agent.toLowerCase())) return humanize(agent);
  const session = subagent.sessionName?.trim() ?? '';
  if (!PLACEHOLDER_NAMES.has(session.toLowerCase()) && session !== subagent.description) return humanize(session);
  return undefined;
}

/** Runtimes that identify children only by id (Codex threads). */
const ID_NAMED_SOURCES = new Set(['codex']);

export function subagentDisplayName(subagent: SubagentInfo): string {
  const own = subagentOwnName(subagent);
  if (own) return own;
  if (subagent.source && ID_NAMED_SOURCES.has(subagent.source)) {
    return `${humanize(subagent.source)} ${subagent.sessionId.slice(0, 8)}`;
  }
  return 'Subagent';
}

/**
 * What a Background work row calls the agent: what it was asked to do, which
 * tells agents of one type apart, else its name. `kind` is its type as the
 * runtime names it ("general-purpose", "Explore"), for a quiet label beside
 * a task title; absent when the title already is the name.
 */
export function subagentRowTitle(subagent: SubagentInfo): { title: string; kind?: string } {
  const mission = summaryLine(subagentMission(subagent));
  if (!mission) return { title: subagentDisplayName(subagent) };
  const agent = subagent.agentName?.trim() ?? '';
  // A plugin agent's name carries its plugin ("Plugin:agent").
  const kind = PLACEHOLDER_NAMES.has(agent.toLowerCase()) ? undefined : agent.split(':').pop()?.trim() || undefined;
  return { title: mission, ...(kind ? { kind } : {}) };
}

/** Agent name for a delegation chip: tool-declared type first, then the roster's. */
export function delegationName(info: SubagentToolInfo, linked: readonly SubagentInfo[]): string | undefined {
  if (info.agentType) return info.agentType;
  return linked.length === 1 ? subagentOwnName(linked[0]) : undefined;
}

/** The one-line "what was it asked to do". */
export function subagentMission(subagent: SubagentInfo | undefined, fallback?: string): string | undefined {
  const firstLine = subagent?.prompt?.split('\n').find((line) => line.trim())?.trim();
  return subagent?.description || subagent?.initialQuery || fallback || firstLine || undefined;
}

/** First non-empty line of markdown, without its block and inline markers. */
export function firstPlainLine(text: string | undefined): string | undefined {
  const line = summaryLine(text);
  if (!line) return undefined;
  const plain = line
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/(\*\*|__|`)/g, '')
    .trim();
  return plain || undefined;
}

/** The one line a compact subagent row says about it. */
export type SubagentSummaryTone = 'now' | 'status' | 'result' | 'error' | 'mission';

/**
 * What the agent is doing now while it runs ("now ❯ Read a.ts" or its
 * status line), what it returned once it finished, else its mission.
 * `running` is the chip's view: a stale legacy roster can still say
 * "working" after its chip completed.
 */
export function subagentSummary(
  subagent: SubagentInfo | undefined,
  { running, fallback }: { running: boolean; fallback?: string },
): { tone: SubagentSummaryTone; text: string } | undefined {
  if (subagent && running) {
    const now = summaryLine(subagent.currentTool);
    if (now) return { tone: 'now', text: now };
    const status = summaryLine(subagent.statusMessage);
    if (status) return { tone: 'status', text: status };
  }
  if (subagent && !running) {
    const error = firstPlainLine(subagent.error);
    const result = firstPlainLine(subagent.result);
    if (error && subagent.outcome === 'failed') return { tone: 'error', text: error };
    if (result) return { tone: 'result', text: result };
    if (error) return { tone: 'error', text: error };
  }
  const mission = summaryLine(subagentMission(subagent, fallback));
  return mission ? { tone: 'mission', text: mission } : undefined;
}

const SUMMARY_MAX = 240;

/** First non-empty line, bounded: the row ellipsizes, the DOM need not hold a whole prompt. */
function summaryLine(text: string | undefined): string | undefined {
  const line = text?.split('\n').map((value) => value.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/** Wall-clock duration: measured usage first, then timestamps, live while running. */
export function subagentDurationMs(subagent: SubagentInfo, now = Date.now()): number | undefined {
  if (subagent.usage?.durationMs !== undefined) return subagent.usage.durationMs;
  if (subagent.startedAt === undefined) return undefined;
  const end = subagent.endedAt ?? (subagent.status === 'working' ? now : undefined);
  if (end === undefined || end < subagent.startedAt) return undefined;
  return end - subagent.startedAt;
}

/**
 * The duration to show, given whether the conversation counts the agent as
 * running (`active`, isSubagentRunningIn):
 * - still running in the background (its turn ended, no outcome yet): the
 *   time since it started, on the caller's live clock. Its endedAt is when
 *   the launch turn ended, not the agent's own length;
 * - `working` but no longer running: a measured or recorded duration only,
 *   never one that grows with the clock;
 * - otherwise subagentDurationMs.
 */
export function subagentShownDurationMs(subagent: SubagentInfo, active: boolean, now: number): number | undefined {
  if (active && subagent.status !== 'working') {
    if (subagent.startedAt === undefined || now < subagent.startedAt) return undefined;
    return now - subagent.startedAt;
  }
  if (!active && subagent.status === 'working') {
    if (subagent.usage?.durationMs !== undefined) return subagent.usage.durationMs;
    if (subagent.startedAt === undefined || subagent.endedAt === undefined || subagent.endedAt < subagent.startedAt) return undefined;
    return subagent.endedAt - subagent.startedAt;
  }
  return subagentDurationMs(subagent, now);
}

export function subagentToolCount(subagent: SubagentInfo): number {
  const counted = (subagent.activity ?? []).filter((item) => item.kind === 'tool').length + (subagent.activityDropped ?? 0);
  return Math.max(counted, subagent.usage?.toolUses ?? 0);
}

/**
 * Status for a delegation chip, given the roster entries it spawned.
 *
 * An exactly linked entry knows the subagent's own outcome (a backgrounded
 * agent's chip completes at launch); a heuristically matched legacy entry is
 * only trusted while the chip runs, because old rosters were never closed.
 * Several agents under one chip (Kiro crews, Codex spawns) stay working while
 * any of them works, or while the chip's own call runs (a blocking crew
 * waits for every stage, including one that stopped) — and only read as
 * failed when every one failed. The per-agent rows carry partial failures.
 */
export function delegationStatus(tool: ToolCallState, linked: readonly SubagentInfo[]): string {
  if (linked.length === 0) return tool.status;
  if (linked.length === 1) {
    const [subagent] = linked;
    if (subagent.parentToolCallId === tool.id) return subagentToolStatus(subagent);
    const chipRunning = !tool.status || ['running', 'in_progress', 'pending'].includes(tool.status);
    return chipRunning ? subagentToolStatus(subagent) : tool.status;
  }
  if (linked.some((entry) => entry.status === 'working')) return 'in_progress';
  if (isRunningStatus(tool.status)) return tool.status;
  if (isFailedStatus(tool.status)) return tool.status;
  return linked.every((entry) => subagentTone(entry) === 'failed') ? 'failed' : 'completed';
}

/**
 * Tools with each delegation chip's status replaced by its agents' status,
 * so group chrome (spinner, done count, auto-collapse) follows a
 * backgrounded agent instead of its launch receipt. Unchanged tools keep
 * their identity; an unchanged list is returned as-is.
 */
export function withDelegationStatus(
  tools: ToolCallState[],
  roster: readonly SubagentInfo[] | undefined,
): ToolCallState[] {
  if (!roster?.length) return tools;
  let changed = false;
  const next = tools.map((tool) => {
    if (!delegationToolInfo(tool, roster)) return tool;
    const status = delegationStatus(tool, subagentsForTool(tool, roster));
    if (status === tool.status) return tool;
    changed = true;
    return { ...tool, status };
  });
  return changed ? next : tools;
}

/**
 * The calls a tool group shows, for its rows and for every count and summary
 * about them: none a SubAgent relayed from its own session, no hidden
 * metadata tools.
 */
export function ownGroupTools(tools: readonly ToolCallState[], roster: readonly SubagentInfo[] | undefined): ToolCallState[] {
  return filterSubagentRelayedTools(tools, roster).filter((tool) => !isHiddenInternalTool(tool.title));
}

/** ownGroupTools as the rows show them: each delegation chip with its agents' status (withDelegationStatus). */
export function visibleGroupTools(tools: readonly ToolCallState[], roster: readonly SubagentInfo[] | undefined): ToolCallState[] {
  return withDelegationStatus(ownGroupTools(tools, roster), roster);
}

/**
 * A lone delegation's tool (after withDelegationStatus) with its status
 * agreeing with the tone its conversation presents the agent in
 * (useDelegationTone), so the group's line (spinner, failure) says what the
 * status word says:
 * failed when the conversation says it failed; running only while both
 * its own copy and the conversation say it runs, so a background agent a
 * later turn carries does not spin after its own turn, and a completed or
 * stopped one never spins; done otherwise. Without a tone (any other
 * group), and when nothing changes, the list is returned as-is.
 */
export function withConversationTone(tools: ToolCallState[], tone: SubagentTone | undefined): ToolCallState[] {
  if (!tone || tools.length !== 1) return tools;
  const [tool] = tools;
  const status = toneToolStatus(tool.status, tone);
  return status === tool.status ? tools : [{ ...tool, status }];
}

function toneToolStatus(status: string, tone: SubagentTone): string {
  if (tone === 'failed') return isFailedStatus(status) ? status : 'failed';
  if (tone === 'running' && isRunningStatus(status)) return status;
  return isRunningStatus(status) || isFailedStatus(status) ? 'completed' : status;
}

/** Roster entries a tool call spawned: exact link first, legacy heuristic second. */
export function subagentsForTool(tool: ToolCallState, roster: readonly SubagentInfo[] | undefined): SubagentInfo[] {
  if (!roster?.length) return [];
  const linked = roster.filter((entry) => entry.parentToolCallId === tool.id);
  if (linked.length > 0) return linked;
  if (!subagentToolInfo(tool)) return [];
  const legacy = roster.find((entry) => !entry.parentToolCallId && subagentTitleMatches(tool, entry));
  return legacy ? [legacy] : [];
}

/**
 * The conversation's one inline roster: the agents its tool chips do not
 * show in full, each once as the conversation knows it, in first-seen
 * order. Those are background agents, which outlive the turn their chip ran
 * in, and agents no tool call of the conversation claims (a crew's stages,
 * a chip on a page not loaded). It sits under the newest message that
 * reports any of them; a copy that only repeats an end recorded earlier
 * does not move it (ConversationSubagentEntry.reportMessageId). The
 * Background work drawer opened from it lists the same agents.
 */
export function inlineSubagentRoster(node: ChatNodeState): { messageId: string; subagents: SubagentInfo[] } | undefined {
  const entries = conversationSubagents(node);
  if (entries.length === 0) return undefined;
  const toolIds = new Set<string>();
  const delegationTools: ToolCallState[] = [];
  for (const message of node.messages) {
    for (const tool of message.toolCalls) {
      toolIds.add(tool.id);
      if (subagentToolInfo(tool)) delegationTools.push(tool);
    }
  }
  const claimed = (entry: SubagentInfo) => (entry.parentToolCallId
    ? toolIds.has(entry.parentToolCallId)
    : delegationTools.some((tool) => subagentTitleMatches(tool, entry)));
  const listed = entries.filter((entry) => entry.backgrounded || !claimed(entry.subagent));
  const reports = new Set(listed.map((entry) => entry.reportMessageId));
  for (let index = node.messages.length - 1; index >= 0; index -= 1) {
    const messageId = node.messages[index].id;
    if (reports.has(messageId)) return { messageId, subagents: listed.map((entry) => entry.subagent) };
  }
  return undefined;
}
