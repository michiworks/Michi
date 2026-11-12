import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PaneMessageList } from './PaneMessageList';
import type { ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';
import { applyTreeMessages } from '../../state/chatHydration';
import { reduceNodes } from '../../state/chatReducers';

const noop = () => {};
const message = (id: string, role: 'user' | 'assistant', text: string) => ({
  id, role, text, toolCalls: [],
});

function node(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'extracted', kind: 'chat', chatId: null, projectId: 'project',
    status: 'idle', followUps: [], messagesLoaded: true,
    messages: [
      message('copied-u', 'user', 'Original research question'),
      message('copied-a', 'assistant', 'Important parent background'),
      message('own-u', 'user', 'Investigate this direction'),
      message('own-a', 'assistant', 'Independent branch answer'),
    ],
    inheritedMessageCount: 2,
    forkedFromNodeId: 'parent',
    ...overrides,
  };
}

function list(overrides: Partial<ChatNodeState> = {}) {
  return <PaneMessageList
    node={node(overrides)} prefs={DEFAULT_PREFS} contentStyle={{}}
    streaming={false}
    onRetryTurn={noop} onEditUserMessage={noop} onContinueFollowUp={noop} onBranchFollowUp={noop}
  />;
}

describe('PaneMessageList inherited history', () => {
  it('separates copied parent history from the extracted thread\'s own turns', () => {
    const { container } = render(list());
    const divider = container.querySelector('.t-inherited-divider');
    expect(divider).toBeTruthy();
    expect(divider?.textContent).toContain('Inherited history');
    expect(divider?.textContent).toContain('2 messages');
    // The divider sits between the copied pair and the first own turn.
    const frames = Array.from(container.querySelectorAll('.terminal-message-frame'));
    const firstOwnFrame = frames[2];
    expect(firstOwnFrame.previousElementSibling).toBe(divider);
    expect(firstOwnFrame.textContent).toContain('Investigate this direction');
  });
});

describe('PaneMessageList inherited history on a partial page', () => {
  const page = Array.from({ length: 15 }, (_, i) => message(`m${95 + i}`, i % 2 ? 'assistant' : 'user', `row ${95 + i}`));

  it('keeps the divider at the same message after a send', () => {
    // 110 messages, 100 of them inherited; the remote's first page holds the last 15.
    const placeholder = node({ messages: [], messagesLoaded: false, messageCount: 110, inheritedMessageCount: 100 });
    let nodes: Record<string, ChatNodeState> = applyTreeMessages(
      { extracted: placeholder },
      { extracted: page },
      [{ nodeId: 'extracted', total: 110, before: { seq: 95, id: 'm95' } }],
    );
    const dividerBefore = (state: ChatNodeState) => {
      const { container, unmount } = render(list(state));
      const divider = container.querySelector('.t-inherited-divider');
      const next = divider?.nextElementSibling?.getAttribute('data-msg-id') ?? null;
      const count = divider?.getAttribute('data-inherited-count');
      unmount();
      return { next, count };
    };
    expect(dividerBefore(nodes.extracted)).toEqual({ next: 'm100', count: '5' });
    nodes = reduceNodes(nodes, { type: 'user-send', nodeId: 'extracted', userText: 'mine', assistantId: 'own-a' });
    expect(dividerBefore(nodes.extracted)).toEqual({ next: 'm100', count: '5' });
  });
});
