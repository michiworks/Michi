import { projectAnswerRun } from '../../state/streamingProjection';
import type { AssistantBlock, ToolCallState } from '../../state/chatTypes';
import { isHiddenInternalTool, isRunningStatus } from './toolCallGrouping';

/**
 * A finished turn, split for the line chrome's Work fold: the work (every
 * block up to the last tool call or thought) folds into one row above the
 * final answer (what the agent wrote after it).
 */
export interface FinishedTurnSplit {
  work: AssistantBlock[];
  /** Images and questions from the work part. They stay visible under the fold. */
  lifted: AssistantBlock[];
  /** The final answer, its tool and question offsets rebased to its own run. */
  final: AssistantBlock[];
  /** The work part's tool calls, for the fold row's summary. */
  tools: ToolCallState[];
  /** Prose passages folded with the work. */
  notes: number;
}

const isLifted = (block: AssistantBlock) => block.kind === 'image' || block.kind === 'user-input';
const hasVisibleProse = (block: AssistantBlock) =>
  block.kind === 'answer' && projectAnswerRun([block]).visibleText.trim().length > 0;

/**
 * Null when the turn should stay as it is: it did no work, it has no final
 * answer (stopped or failed on a tool), a tool is still running, or the work
 * would show as a single line anyway.
 */
export function splitFinishedTurn(
  blocks: readonly AssistantBlock[] | undefined,
  toolCalls: readonly ToolCallState[],
  showThoughts: boolean,
): FinishedTurnSplit | null {
  if (!blocks || blocks.length === 0) return null;
  const byId = new Map(toolCalls.map((tool) => [tool.id, tool]));
  // A hidden metadata call after the answer (Kiro's branch overview) is not work.
  let last = -1;
  blocks.forEach((block, i) => {
    const tool = block.kind === 'tool' ? byId.get(block.toolCallId) : undefined;
    if ((tool && !isHiddenInternalTool(tool.title)) || (block.kind === 'thinking' && block.rawText.trim())) last = i;
  });
  if (last < 0) return null;
  const head = blocks.slice(0, last + 1);
  const tail = blocks.slice(last + 1);
  if (!tail.some(hasVisibleProse)) return null;
  if (tail.some((block) => {
    const tool = block.kind === 'tool' ? byId.get(block.toolCallId) : undefined;
    return !!tool && isRunningStatus(tool.status);
  })) return null;

  const work = head.filter((block) => !isLifted(block));
  const tools: ToolCallState[] = [];
  let items = 0;
  let notes = 0;
  let inActivity = false;
  for (const block of work) {
    if (block.kind === 'answer') {
      if (hasVisibleProse(block)) {
        items += 1;
        notes += 1;
        inActivity = false;
      }
      continue;
    }
    if (block.kind === 'tool') {
      const tool = byId.get(block.toolCallId);
      if (!tool) continue;
      if (isRunningStatus(tool.status)) return null;
      tools.push(tool);
      if (isHiddenInternalTool(tool.title)) continue;
    } else if (block.kind !== 'thinking' || !showThoughts) {
      continue;
    }
    if (!inActivity) items += 1;
    inActivity = true;
  }
  if (items <= 1) return null;

  // Tool and question blocks sit at a run-local raw offset: the answer text
  // since the run's last thought (assistantBlocks.currentRunRawLength). The
  // final part renders as a run of its own, so it drops the answer text left
  // behind in the work, or the weave would place its blocks mid-sentence and
  // drop those past the end of its text.
  let behind = 0;
  for (let i = head.length - 1; i >= 0; i--) {
    const block = head[i];
    if (block.kind === 'thinking') break;
    if (block.kind === 'answer') behind += block.rawText.length;
  }
  const final = tail.map((block) => ((block.kind === 'tool' || block.kind === 'user-input') && block.section === 'answer'
    ? { ...block, rawOffset: Math.max(0, block.rawOffset - behind) }
    : block));
  // Lifted out of its text, a question opens its own run.
  const lifted = head.filter(isLifted).map((block) => (block.kind === 'user-input' ? { ...block, rawOffset: 0 } : block));
  return { work, lifted, final, tools, notes };
}
