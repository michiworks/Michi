import { describe, expect, it } from 'vitest';
import { reduceNodes } from './chatReducers';
import { mapMessageRow } from './chatHydration';
import type { ChatNodeState } from './chatTypes';
import { buildResumePrompt } from './turnInterruption';
import { serializeMessageRowsForNode } from './workspacePersistence';

function streamingNode(): Record<string, ChatNodeState> {
  return {
    n1: {
      nodeId: 'n1', kind: 'chat', chatId: 'n1', projectId: 'ws', followUps: [], status: 'streaming',
      messages: [
        { id: 'u1', role: 'user', text: 'Fix the build', toolCalls: [] },
        { id: 'a1', role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true },
      ],
    },
  };
}

describe('the turn-end mark on an answer', () => {
  it('comes from the server\'s stop reason on done', () => {
    let nodes = reduceNodes(streamingNode(), { type: 'chunk', nodeId: 'n1', assistantId: 'a1', text: 'Half done.' });
    nodes = reduceNodes(nodes, { type: 'done', nodeId: 'n1', assistantId: 'a1', stopReason: 'max_turn_requests' });
    expect(nodes.n1.messages[1].turnEnd).toBe('max_turn_requests');
    const finished = reduceNodes(streamingNode(), { type: 'done', nodeId: 'n1', assistantId: 'a1', stopReason: 'end_turn' });
    expect(finished.n1.messages[1].turnEnd).toBeUndefined();
  });

  it('shows "Stopped" only once the server confirms the Stop', () => {
    // This window's Stop ends the stream at once, before the server answers.
    let nodes = reduceNodes(streamingNode(), { type: 'done', nodeId: 'n1', assistantId: 'a1', aborted: true });
    expect(nodes.n1.messages[1].turnEnd).toBeUndefined();
    nodes = reduceNodes(nodes, { type: 'cancel-recovery', nodeId: 'n1', assistantId: 'a1', state: 'pending', detail: 'Waiting' });
    expect(nodes.n1.messages[1].turnEnd).toBeUndefined();
    nodes = reduceNodes(nodes, { type: 'cancel-recovery', nodeId: 'n1', assistantId: 'a1', state: 'settled', stopReason: 'cancelled' });
    expect(nodes.n1.messages[1].turnEnd).toBe('stopped');
  });

  it('a Stop that came too late leaves a finished answer unmarked', () => {
    let nodes = reduceNodes(streamingNode(), { type: 'done', nodeId: 'n1', assistantId: 'a1', aborted: true });
    nodes = reduceNodes(nodes, { type: 'cancel-recovery', nodeId: 'n1', assistantId: 'a1', state: 'settled', stopReason: 'end_turn' });
    expect(nodes.n1.messages[1].turnEnd).toBeUndefined();
  });

  it('a done relayed from another window marks it too', () => {
    const nodes = reduceNodes(streamingNode(), { type: 'done', nodeId: 'n1', assistantId: 'a1', aborted: true, stopReason: 'cancelled' });
    expect(nodes.n1.messages[1].turnEnd).toBe('stopped');
  });

  it('is read back from the stored row, and a write-back keeps it', () => {
    const assistant = mapMessageRow({ id: 'a1', node_id: 'n1', role: 'assistant', content: 'Half done.', metadata: JSON.stringify({ turnEnd: 'max_tokens', plan: [] }) });
    expect(assistant.turnEnd).toBe('max_tokens');
    const continuation = mapMessageRow({
      id: 'u2', node_id: 'n1', role: 'user', content: '[auto-continue 1/3 · max_tokens] Continue from where you stopped.',
      metadata: JSON.stringify({ autoContinue: { n: 1, of: 3, reason: 'max_tokens', fromTurnId: 't1' } }),
    });
    expect(continuation.autoContinue?.n).toBe(1);
    const [row] = serializeMessageRowsForNode({ n1: { ...streamingNode().n1, messages: [assistant] } }, 'n1');
    expect(JSON.parse(row.metadata!)).toMatchObject({ turnEnd: 'max_tokens' });
  });
});

describe('Continue', () => {
  it('asks to carry on a turn that ended early, without restoring what the session holds', () => {
    const prompt = buildResumePrompt([
      { id: 'u1', role: 'user', text: 'Fix the build', toolCalls: [] },
      { id: 'a1', role: 'assistant', text: 'Half done.', toolCalls: [], turnEnd: 'max_turn_requests' },
    ], 'max_turn_requests');
    expect(prompt?.displayText).toBe('Continue');
    expect(prompt?.text).toMatch(/^Your previous turn stopped before it finished: it reached its step limit\. The user pressed Continue\./);
  });

  it('restores a stopped turn, which the agent session may not hold', () => {
    const prompt = buildResumePrompt([
      { id: 'u1', role: 'user', text: 'Fix the build', toolCalls: [] },
      { id: 'a1', role: 'assistant', text: 'Started.', toolCalls: [], turnEnd: 'stopped' },
    ], 'stopped');
    expect(prompt?.displayText).toBe('Continue');
    expect(prompt?.text).toMatch(/Interrupted request:\nFix the build/);
    expect(prompt?.text).toMatch(/The user pressed Continue\./);
  });
});
