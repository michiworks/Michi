import { describe, expect, it } from 'vitest';
import { migrateAssistantToBlocks } from './assistantBlocks';
import type { ChatMessage } from './chatTypes';

describe('assistant block migration', () => {
  it('preserves same-offset tool order and appends offsetless tools at the end', () => {
    const legacy: ChatMessage = {
      id: 'a2',
      role: 'assistant',
      text: 'abcd',
      toolCalls: [
        { id: 't2', title: 'second', status: 'completed', textOffset: 2 },
        { id: 't1', title: 'first', status: 'completed', textOffset: 2 },
        { id: 't3', title: 'tail', status: 'completed' },
      ],
    };

    const tools = migrateAssistantToBlocks(legacy).blocks?.filter((b) => b.kind === 'tool');
    expect(tools).toEqual([
      { id: 'a2-legacy-tool-t2', kind: 'tool', toolCallId: 't2', section: 'answer', rawOffset: 2 },
      { id: 'a2-legacy-tool-t1', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 2 },
      { id: 'a2-legacy-tool-t3', kind: 'tool', toolCallId: 't3', section: 'answer', rawOffset: 4 },
    ]);
  });
});
