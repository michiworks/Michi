import { describe, expect, it } from 'vitest';
import { projectAnswerRun, weaveRunToolBlocks } from './streamingProjection';
import type { AssistantBlock, ToolCallState } from './chatTypes';

describe('block-first streaming projection', () => {
  it('uses final fallback and groups same-offset tools without cloning tool refs', () => {
    const tool1: ToolCallState = { id: 't1', title: 'one', status: 'completed' };
    const tool2: ToolCallState = { id: 't2', title: 'two', status: 'completed' };
    const tools = new Map<string, ToolCallState>([
      [tool1.id, tool1],
      [tool2.id, tool2],
    ]);
    const blocks: AssistantBlock[] = [
      { id: 'a1', kind: 'answer', rawText: 'abc', streaming: false },
      { id: 'tb1', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 3 },
      { id: 'tb2', kind: 'tool', toolCallId: 't2', section: 'answer', rawOffset: 3 },
    ];

    const projection = projectAnswerRun(blocks);
    const segments = weaveRunToolBlocks(
      projection.visibleText,
      projection.rawText.length,
      blocks,
      tools,
      projection.remapOffset,
      { forceFinal: true },
    );

    expect(segments).toEqual([
      { kind: 'text', text: 'abc' },
      { kind: 'tool-group', tools: [tool1, tool2] },
    ]);
  });

  it('keeps tools separated only by blank text in one group', () => {
    const tool1: ToolCallState = { id: 't1', title: 'one', status: 'completed' };
    const tool2: ToolCallState = { id: 't2', title: 'two', status: 'completed' };
    const tools = new Map<string, ToolCallState>([
      [tool1.id, tool1],
      [tool2.id, tool2],
    ]);
    // A tool-only API message after one with text: the adapter's "\n\n"
    // separator lands between the two messages' tools.
    const blocks: AssistantBlock[] = [
      { id: 'a1', kind: 'answer', rawText: 'abc', streaming: false },
      { id: 'tb1', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 3 },
      { id: 'a2', kind: 'answer', rawText: '\n\n', streaming: false },
      { id: 'tb2', kind: 'tool', toolCallId: 't2', section: 'answer', rawOffset: 5 },
      { id: 'a3', kind: 'answer', rawText: '\n\ndone', streaming: false },
    ];

    const projection = projectAnswerRun(blocks);
    const segments = weaveRunToolBlocks(
      projection.visibleText,
      projection.rawText.length,
      blocks,
      tools,
      projection.remapOffset,
      { forceFinal: true },
    );

    expect(segments).toEqual([
      { kind: 'text', text: 'abc' },
      { kind: 'tool-group', tools: [tool1, tool2] },
      { kind: 'text', text: '\n\ndone' },
    ]);
  });
});
