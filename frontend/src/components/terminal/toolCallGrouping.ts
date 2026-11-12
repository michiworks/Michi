// Public entry for the tool-call copy. The code lives in ./toolCallGrouping/, one module per
// concern; their helpers stay internal, and this file re-exports only the public surface.
import type { ToolCallState, SubagentInfo } from '../../state/chatTypes';
import { failedToolCount } from './toolCallGrouping/toolStatus';
import { subagentTitleMatches, subagentToolInfo } from './toolCallGrouping/subagentTools';
import { summarizeToolsBase } from './toolCallGrouping/toolSummary';

export {
  failedToolCount,
  isDenied,
  isFailedStatus,
  isHiddenInternalTool,
  isRunningStatus,
  isStoppedStatus,
  isTerminalStatus,
  toolErrorLine,
  toolExitCode,
} from './toolCallGrouping/toolStatus';
export { bareToolName, prettifyToolTitle, toolDisplayTitle } from './toolCallGrouping/toolTitle';
export { toolCommand, toolPurpose, toolRowDetail } from './toolCallGrouping/toolInput';
export type { SubagentToolInfo } from './toolCallGrouping/subagentTools';
export {
  delegationToolInfo,
  filterSubagentRelayedTools,
  subagentHeading,
  subagentStatusLabel,
  subagentTitleMatches,
  subagentToolInfo,
} from './toolCallGrouping/subagentTools';
export type { BucketKey, PhraseKind } from './toolCallGrouping/toolKind';
export { toolKind } from './toolCallGrouping/toolKind';
export { summarizeToolsBase, summarizeWork } from './toolCallGrouping/toolSummary';
export {
  formatDurationMs,
  formatElapsedMs,
  spokenDurationMs,
  toolDurationMs,
  toolSpanMs,
} from './toolCallGrouping/toolDuration';
export type { PayloadSubject } from './toolCallGrouping/toolPayload';
export { formatToolPayload, payloadSubject } from './toolCallGrouping/toolPayload';
export type { PhraseVerb } from './toolCallGrouping/phraseText';
export type { CommandPhrase } from './toolCallGrouping/commandPhrase';
export { commandPhrase, isSimpleCommand, readablePattern, stripHeredocs } from './toolCallGrouping/commandPhrase';
export type { ToolPhrase } from './toolCallGrouping/toolPhrase';
export { mergeToolPhrases, toolIntent, toolPhrase, toolRecord } from './toolCallGrouping/toolPhrase';
export type { OutcomeIcon } from './toolCallGrouping/toolEffect';
export { changesState, findRecoveries, toolOutcomeIcon } from './toolCallGrouping/toolEffect';
export type { StepView } from './toolCallGrouping/toolStep';
export { stepDetail, stepName, stepView } from './toolCallGrouping/toolStep';
export type { OutcomePhrase, ToolOutcome } from './toolCallGrouping/toolOutcome';
export {
  SUMMARY_MAX_PHRASES,
  capPhrases,
  joinSentence,
  sentenceOf,
  summarizeOutcome,
} from './toolCallGrouping/toolOutcome';
export { thoughtConclusion, thoughtPreview } from './toolCallGrouping/thoughtSentence';

// Only tests call these two (they are in the knip baseline under this path). They stay here
// until they are deleted, so the split does not move their file-keyed baseline entries.
export function findOwningSubagent(
  tool: ToolCallState,
  subagents: readonly SubagentInfo[] | undefined,
): SubagentInfo | undefined {
  if (!subagents || subagents.length === 0) return undefined;
  if (!subagentToolInfo(tool)) return undefined;
  return subagents.find((s) => subagentTitleMatches(tool, s));
}

export function summarizeTools(tools: ToolCallState[]): string {
  if (tools.length === 0) return '';
  const base = summarizeToolsBase(tools);
  const failed = failedToolCount(tools);
  if (failed === 0) return base;
  if (tools.length === 1) {
    // A single SubAgent's base already carries its status label ("· failed").
    return subagentToolInfo(tools[0]) ? base : `${base} · failed`;
  }
  return `${base} · ${failed} failed`;
}
