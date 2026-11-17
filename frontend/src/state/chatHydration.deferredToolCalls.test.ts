import { describe, expect, it } from 'vitest';
import { buildMessagesByNode } from './chatHydration';

describe('deferred tool calls in display pages', () => {
  it('keep their markers, and a whole call gets none', () => {
    const [message] = buildMessagesByNode([{ id: 'a1', node_id: 'n', role: 'assistant', content: '', seq: 1, created_at: 1,
      tool_calls: JSON.stringify([
        { id: 'stub', title: 'Bash', status: 'completed', inputJson: '{"command":"ls"}', deferred: true, hasOutput: true },
        { id: 'whole', title: 'Bash', status: 'completed', output: 'ok' },
      ]) }]).n;
    expect(message.toolCalls[0]).toMatchObject({ id: 'stub', deferred: true, hasOutput: true });
    expect(message.toolCalls[0].output).toBeUndefined();
    expect('deferred' in message.toolCalls[1] || 'hasOutput' in message.toolCalls[1]).toBe(false);
  });
});
