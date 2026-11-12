import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { MessageBlock } from './MessageBlock';
import { AgentBlockStyleOverride, type AgentBlockStyle } from '../../state/prefs';
import type { AssistantBlock, ChatMessage, SubagentInfo, ToolCallState } from '../../state/chatTypes';

const NOTE = 'No file overlap with dev. Committing and merging.';
const FINAL = 'Merged into dev as abc12345.';

const bash = (id: string, description: string): ToolCallState => ({
  id, title: 'Bash', kind: 'bash', status: 'completed', startedAt: 1_000, endedAt: 2_000,
  inputJson: JSON.stringify({ command: `git ${id}`, description }),
});
const tools = [bash('t1', 'Check git status'), bash('t2', 'Merge the fix branch')];
const blocks: AssistantBlock[] = [
  { id: 'b0', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 0 },
  { id: 'b1', kind: 'answer', rawText: NOTE },
  { id: 'b2', kind: 'tool', toolCallId: 't2', section: 'answer', rawOffset: NOTE.length },
  { id: 'b3', kind: 'answer', rawText: `\n\n[TITLE: Merge the fix]\n\n${FINAL}` },
];
const message: ChatMessage = { id: 'a1', role: 'assistant', text: NOTE + FINAL, toolCalls: tools, blocks, streaming: false };

function renderTurn(m: ChatMessage, opts: { variant?: AgentBlockStyle; hideActions?: boolean; subagents?: SubagentInfo[] } = {}) {
  return render(
    <AgentBlockStyleOverride.Provider value={opts.variant ?? 'line'}>
      <MessageBlock
        m={m}
        index={1}
        isDark={false}
        copyText={() => ''}
        showThoughts
        fontFamily="inherit"
        density="comfortable"
        usageInfo={m.streaming ? undefined : { durationMs: 64_900 }}
        hideActions={opts.hideActions}
        subagents={opts.subagents}
      />
    </AgentBlockStyleOverride.Provider>,
  );
}

describe('MessageBlock — Work fold', () => {
  it('folds a finished turn’s work into one row above its final answer', () => {
    const { getByRole, queryByText, getByText } = renderTurn(message);
    const row = getByRole('button', { name: /Worked for/ });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    const words = row.textContent!.replace(/\u00A0/g, ' ');
    expect(words).toContain('Worked for 1m 5s');
    expect(words).toContain('ran 2 commands · 1 note');
    getByText(FINAL);
    expect(queryByText(NOTE)).toBeNull();
    expect(queryByText('[TITLE: Merge the fix]', { exact: false })).toBeNull();

    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    const note = getByText(NOTE);
    expect(note.closest('.agent-line-workfold__work')).not.toBeNull();
    expect(getByText(FINAL).closest('.agent-line-workfold')).toBeNull();
  });

  it('shows the work as it runs and folds it once the turn is over', () => {
    const live: ChatMessage = { ...message, streaming: true, blocks: blocks.map((b) => (b.id === 'b3' ? { ...b, streaming: true } : b)) };
    const { queryByRole, getByText, rerender } = renderTurn(live);
    getByText(NOTE);
    expect(queryByRole('button', { name: /Worked for/ })).toBeNull();

    rerender(
      <AgentBlockStyleOverride.Provider value="line">
        <MessageBlock m={message} index={1} isDark={false} copyText={() => ''} showThoughts fontFamily="inherit" density="comfortable" usageInfo={{ durationMs: 64_900 }} />
      </AgentBlockStyleOverride.Provider>,
    );
    expect(queryByRole('button', { name: /Worked for/ })).not.toBeNull();
  });

  it('waits while the conversation still runs the turn, or an agent it started runs on', () => {
    expect(renderTurn(message, { hideActions: true }).queryByRole('button', { name: /Worked for/ })).toBeNull();
    const agent: SubagentInfo = {
      sessionId: 's1', sessionName: 'Explore', agentName: 'Explore', initialQuery: 'Run the suite', status: 'terminated',
      background: true, group: 'g', dependsOn: [],
    };
    expect(renderTurn(message, { subagents: [agent] }).queryByRole('button', { name: /Worked for/ })).toBeNull();
  });

  it('says nothing failed when the failed call was a SubAgent\'s own, relayed to the parent', () => {
    const relayed: ToolCallState = { ...bash('r1', 'Run the subagent check'), status: 'failed', output: 'Exit code 1' };
    const agent: SubagentInfo = {
      sessionId: 's1', sessionName: 'Explore', agentName: 'Explore', initialQuery: 'Check', status: 'terminated', group: 'g', dependsOn: [],
      activity: [{ id: 'r1', kind: 'tool', title: 'Bash', status: 'failed' }],
    };
    const withRelayed: ChatMessage = {
      ...message,
      toolCalls: [tools[0], relayed, tools[1]],
      blocks: [blocks[0], blocks[1], { id: 'br', kind: 'tool', toolCallId: 'r1', section: 'answer', rawOffset: NOTE.length }, blocks[2], blocks[3]],
    };
    const row = renderTurn(withRelayed, { subagents: [agent] }).getByRole('button', { name: /Worked for/ });
    expect(row.textContent).not.toMatch(/failed/);
  });

  it('leaves the other chromes as they were', () => {
    const { queryByRole, getByText } = renderTurn(message, { variant: 'card' });
    expect(queryByRole('button', { name: /Worked for/ })).toBeNull();
    getByText(NOTE);
  });
});
