import type { ToolCallState } from '../../../state/chatTypes';
import type { BucketKey, PhraseKind } from './toolKind';
import { KINDS, toolKind } from './toolKind';
import { subagentHeading, subagentStatusLabel, subagentToolInfo } from './subagentTools';
import { failedToolCount, isRunningStatus } from './toolStatus';
import { toolDisplayTitle } from './toolTitle';

function pluralize(noun: string, count: number): string {
  if (count === 1) return noun;
  return `${noun}s`;
}

/**
 * Base summary without the failed-count suffix, so renderers can color the
 * failure fragment independently (color marks state, never whole rows).
 *
 * `subagentStatus` replaces a lone SubAgent's status word ("in background",
 * "stopped"), which the tool status alone cannot say; see
 * useDelegationStatusLabel. Other summaries ignore it.
 */
export function summarizeToolsBase(tools: ToolCallState[], subagentStatus?: string): string {
  if (tools.length === 0) return '';

  const subagentInfos = tools.map(subagentToolInfo);
  if (tools.length === 1 && subagentInfos[0]) {
    return `${subagentHeading(subagentInfos[0])} · ${subagentStatus ?? subagentStatusLabel(tools[0].status)}`;
  }
  if (tools.length > 1 && subagentInfos.every(Boolean)) {
    const running = tools.filter((t) => isRunningStatus(t.status)).length;
    const failed = failedToolCount(tools);
    if (running > 0) return `${tools.length} SubAgents · ${running} working`;
    if (failed > 0) return `${tools.length} SubAgents`;
    return `${tools.length} SubAgents · completed`;
  }

  if (tools.length === 1) {
    return toolDisplayTitle(tools[0]) || KINDS[toolKind(tools[0])].verb;
  }

  const counts = new Map<PhraseKind, number>();
  for (const tool of tools) {
    const key = toolKind(tool);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // "read 3 files"; "read 2 files, ran 1 command"
  const phrases: string[] = [];
  for (const [key, count] of counts.entries()) {
    const def = KINDS[key];
    phrases.push(`${def.verb} ${count} ${pluralize(def.noun, count)}`);
  }
  return phrases.join(', ');
}

/** Phrase order for the agent block header: changes first, then commands
 *  and delegation, then lookups, so a long run's edits survive truncation. */
const WORK_PHRASE_ORDER: ReadonlyArray<BucketKey | 'subagent'> = [
  'edit', 'write', 'bash', 'subagent', 'grep', 'read', 'glob', 'unknown',
];
const WORK_SUMMARY_MAX_PHRASES = 3;

/**
 * What an agent block did, for its collapsed header: "Edited 3 files, ran 5
 * commands, read 12 files". `visible` is what the block shows
 * (subagentPresentation.ownGroupTools); `failed` counts among them so the
 * caller can color it apart.
 */
export function summarizeWork(visible: readonly ToolCallState[]): { text: string; failed: number } {
  const failed = failedToolCount(visible);
  if (visible.length === 0) return { text: '', failed };

  const counts = new Map<PhraseKind, number>();
  for (const tool of visible) {
    const key = toolKind(tool);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // A lone tool we can't classify reads better by name than as "used 1 tool".
  if (visible.length === 1 && counts.has('unknown')) {
    return { text: toolDisplayTitle(visible[0]), failed };
  }

  const phrases: string[] = [];
  let rest = 0;
  for (const key of WORK_PHRASE_ORDER) {
    const count = counts.get(key);
    if (!count) continue;
    if (phrases.length === WORK_SUMMARY_MAX_PHRASES) {
      rest += count;
      continue;
    }
    phrases.push(`${KINDS[key].verb} ${count} ${pluralize(KINDS[key].noun, count)}`);
  }
  if (rest > 0) phrases.push(`+${rest} more`);
  const text = phrases.join(', ');
  return { text: text.charAt(0).toUpperCase() + text.slice(1), failed };
}
