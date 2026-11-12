import { render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatNodeState, SubagentInfo } from '../../state/chatTypes';
import { AgentBlockStyleOverride, DEFAULT_PREFS } from '../../state/prefs';
import { PaneMessageList } from './PaneMessageList';

vi.mock('../MarkdownContent', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));

/** Kiro V2 crew stages, launched by a chip of a turn this window has not loaded. */
const stage = (sessionId: string, patch: Partial<SubagentInfo> = {}): SubagentInfo => ({
  sessionId, sessionName: sessionId, agentName: 'kiro_default', initialQuery: `Research ${sessionId}`,
  status: 'terminated', group: 'crew', dependsOn: [], parentToolCallId: 'toolu_crew', ...patch,
});

const node = (latest: ChatNodeState['messages'][number]): ChatNodeState => ({
  nodeId: 'carry-node', kind: 'chat', chatId: null, projectId: 'carry-ws', status: 'streaming', messagesLoaded: true, followUps: [],
  messages: [
    { id: 'u1', role: 'user', text: 'Research the runtimes.', toolCalls: [] },
    { id: 'a1', role: 'assistant', text: 'Here is what the crew found.', toolCalls: [], subagents: [stage('kiro', { outcome: 'cancelled' }), stage('codex', { outcome: 'cancelled' })] },
    { id: 'u2', role: 'user', text: 'Rebase it onto dev.', toolCalls: [] },
    latest,
  ],
});

/** The list's frame for one message: its MessageBlock and inline roster. */
const frame = (messageId: string) => document.querySelector(`.terminal-message-frame[data-msg-id="${messageId}"]`) as HTMLElement;

function inlineRoster(state: ChatNodeState, messageId: string) {
  render(
    <AgentBlockStyleOverride.Provider value="card">
      <PaneMessageList
        node={state}
        prefs={DEFAULT_PREFS}
        contentStyle={{}}
        streaming
        onRetryTurn={() => {}}
        onEditUserMessage={() => {}}
        onContinueFollowUp={() => {}}
        onBranchFollowUp={() => {}}
      />
    </AgentBlockStyleOverride.Provider>,
  );
  return within(frame(messageId)).queryByTestId('message-subagents');
}

describe('PaneMessageList inline subagents', () => {
  it('the latest turn does not list agents that ended in an earlier turn', () => {
    const state = node({ id: 'a2', role: 'assistant', text: 'Rebasing.', toolCalls: [], streaming: true, subagents: [stage('codex'), stage('kiro')] });
    expect(inlineRoster(state, 'a2')).toBeNull();
    expect(within(frame('a1')).getByTestId('message-subagents').textContent).toContain('2 stopped');
  });

  it('moves the one roster down to the turn that set an agent working again', () => {
    const state = node({ id: 'a2', role: 'assistant', text: 'Asking again.', toolCalls: [], streaming: true, subagents: [stage('codex'), stage('kiro', { status: 'working' })] });
    const roster = inlineRoster(state, 'a2');
    expect(roster?.textContent).toContain('1 working');
    // codex keeps the outcome its earlier turn recorded.
    expect(roster?.textContent).toContain('1 stopped');
    expect(within(frame('a1')).queryByTestId('message-subagents')).toBeNull();
  });

  it('shows background agents reporting one turn at a time as one roster under the newest report', () => {
    const agent = (sessionId: string, patch: Partial<SubagentInfo> = {}): SubagentInfo => ({
      sessionId, sessionName: sessionId, agentName: 'Explore', initialQuery: `Check ${sessionId}`, description: `Check ${sessionId}`,
      status: 'terminated', background: true, group: '', dependsOn: [], parentToolCallId: `t-${sessionId}`, ...patch,
    });
    const done = (sessionId: string) => agent(sessionId, { outcome: 'completed', result: `${sessionId} is in dev` });
    const ids = ['w', 'x', 'y', 'z'];
    const state: ChatNodeState = {
      nodeId: 'bg-node', kind: 'chat', chatId: null, projectId: 'bg-ws', status: 'idle', messagesLoaded: true, followUps: [],
      messages: [
        { id: 'u1', role: 'user', text: 'Check the worktrees.', toolCalls: [] },
        {
          id: 'a1', role: 'assistant', text: 'Four agents are reading them.', subagents: ids.map((id) => agent(id)),
          toolCalls: ids.map((id) => ({ id: `t-${id}`, title: 'Agent', kind: 'tool', status: 'completed' })),
        },
        { id: 'a2', role: 'assistant', text: 'w is summarized.', toolCalls: [], subagents: [done('w'), agent('x'), agent('y'), agent('z')] },
        { id: 'a3', role: 'assistant', text: 'x reported.', toolCalls: [], subagents: [done('x'), agent('y'), agent('z')] },
        { id: 'a4', role: 'assistant', text: 'y reported.', toolCalls: [], subagents: [done('y'), agent('z')] },
      ],
    };
    const roster = inlineRoster(state, 'a4');
    expect(document.querySelectorAll('[data-testid="message-subagents"]')).toHaveLength(1);
    // Each agent counted once, from its newest copy: three reported, one still runs.
    expect(roster?.textContent).toContain('1 working');
    expect(roster?.textContent).toContain('3 done');
  });
});
