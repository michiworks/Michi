import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import AskUserNotice from './AskUserNotice';
import type { ChatNodeState } from '../../state/chatTypes';

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../state/chatStore')>('../../state/chatStore');
  return {
    isAssistantConversation: actual.isAssistantConversation,
    useChatProjects: vi.fn(),
    useChatActions: vi.fn(),
    useChatPanes: vi.fn(),
    useStructuralSelector: vi.fn(),
  };
});

import * as chatStore from '../../state/chatStore';
import { setPanePresenceDashboardVisible } from '../../state/panePresenceVisibility';

const actions = { revealNode: vi.fn() };

function askingNode(nodeId: string, title: string, requestId: number): ChatNodeState {
  return {
    nodeId,
    kind: 'chat',
    chatId: nodeId,
    projectId: 'p-1',
    title,
    messages: [{ id: `${nodeId}-m1`, role: 'assistant', text: '' }],
    followUps: [],
    status: 'streaming',
    pendingUserInput: {
      requestId,
      questions: [{ question: `Pick one for ${title}?`, options: [], multiSelect: false }],
      answers: [],
    },
  } as unknown as ChatNodeState;
}

/** Feed a nodes map through the REAL selector the component passes in. */
function withNodes(nodes: Record<string, ChatNodeState>) {
  vi.mocked(chatStore.useStructuralSelector).mockImplementation(
    ((selector: (n: Record<string, ChatNodeState>) => unknown) => selector(nodes)) as never,
  );
}

describe('AskUserNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.mocked(chatStore.useChatActions).mockReturnValue(actions as never);
    vi.mocked(chatStore.useChatProjects).mockReturnValue({ projects: [] } as never);
    vi.mocked(chatStore.useChatPanes).mockReturnValue({ focusedPane: null } as never);
    setPanePresenceDashboardVisible(false);
  });

  it('leaves out the conversation the user is in, and brings it back once they leave unanswered', async () => {
    withNodes({
      child: askingNode('child', 'A', 1),
      root: askingNode('root', 'B', 2),
    });
    vi.mocked(chatStore.useChatPanes).mockReturnValue({ focusedPane: 'child' } as never);
    act(() => setPanePresenceDashboardVisible(true));
    const { container, rerender } = render(<AskUserNotice />);
    const card = screen.getByRole('region', { name: 'Agent question' });
    expect(card.textContent).toContain('Pick one for B?');
    expect(card.textContent).not.toContain('+1 more');

    // Answer took the user to the last one: the notice has nothing left to say.
    vi.mocked(chatStore.useChatPanes).mockReturnValue({ focusedPane: 'root' } as never);
    withNodes({ root: askingNode('root', 'B', 2) });
    rerender(<AskUserNotice />);
    expect(screen.queryByRole('region', { name: 'Agent question' })).toBeNull();
    await waitFor(() => expect(container.querySelector('.ask-notice')).toBeNull());

    // Off the Dashboard page the pane is not in front of the user.
    act(() => setPanePresenceDashboardVisible(false));
    expect((await screen.findByRole('region', { name: 'Agent question' })).textContent).toContain('Pick one for B?');
  });

  it('counts the extra asks beyond the first', () => {
    withNodes({
      child: askingNode('child', 'A', 1),
      root: askingNode('root', 'B', 2),
    });
    render(<AskUserNotice />);
    expect(screen.getByRole('region', { name: 'Agent question' }).textContent).toContain('+1 more');
  });

  it('clicking reveals the asking node at its ask', () => {
    withNodes({ child: askingNode('child', 'Deploy plan', 4) });
    render(<AskUserNotice />);
    fireEvent.click(screen.getByRole('region', { name: 'Agent question' }));
    expect(actions.revealNode).toHaveBeenCalledWith('child', { messageId: 'child-m1' });
  });

  it('names an ask in the agent’s conversation after the agent, and reveals it through revealNode', () => {
    const system = { id: 'sys', name: 'Assistant', system: 'assistant', chatIds: ['n-sys'], edges: [], trees: [{ id: 't-sys', rootNodeId: 'n-sys' }], activeTreeId: 't-sys', createdAt: 0 };
    vi.mocked(chatStore.useChatProjects).mockReturnValue({ projects: [system] } as never);
    withNodes({ 'n-sys': { ...askingNode('n-sys', 'Assistant conversation', 7), projectId: 'sys' } as ChatNodeState });
    render(<AskUserNotice />);
    fireEvent.click(screen.getByRole('button', { name: "Open Michi and answer the agent's question" }));
    expect(actions.revealNode).toHaveBeenCalledWith('n-sys', { messageId: 'n-sys-m1' });
  });

  it('slides in when an ask arrives; one pending at mount shows at once', () => {
    withNodes({});
    const { container, rerender, unmount } = render(<AskUserNotice />);
    expect(container.firstChild).toBeNull();
    withNodes({ child: askingNode('child', 'Deploy plan', 4) });
    rerender(<AskUserNotice />);
    const arriving = screen.getByRole('region', { name: 'Agent question' }).parentElement as HTMLElement;
    expect(arriving.style.transform).toContain('translateX(100%)');
    unmount();

    render(<AskUserNotice />);
    const shell = screen.getByRole('region', { name: 'Agent question' }).parentElement as HTMLElement;
    expect(shell.style.transform).not.toContain('100%');
    expect(shell.style.opacity).toBe('1');
  });

  it('shrinks to a tab without navigating, and a new question opens it again', async () => {
    withNodes({ child: askingNode('child', 'Deploy plan', 4) });
    const { rerender } = render(<AskUserNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'Shrink the question notice' }));
    expect(actions.revealNode).not.toHaveBeenCalled();
    const tab = await screen.findByRole('button', { name: "Show the agent's question" });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Agent question' })).toBeNull());
    expect(tab.textContent).toContain('1');

    withNodes({ child: askingNode('child', 'Deploy plan', 4), root: askingNode('root', 'Release', 5) });
    rerender(<AskUserNotice />);
    expect(await screen.findByRole('region', { name: 'Agent question' })).toBeTruthy();
  });

  it('closes when the last ask is answered, no longer a target while it leaves', async () => {
    withNodes({ child: askingNode('child', 'Deploy plan', 4) });
    const { container, rerender } = render(<AskUserNotice />);
    withNodes({});
    rerender(<AskUserNotice />);

    const leaving = container.querySelector('.ask-notice') as HTMLElement;
    expect(leaving).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Agent question' })).toBeNull();
    expect(leaving.getAttribute('aria-hidden')).toBe('true');
    expect(leaving.hasAttribute('inert')).toBe(true);
    fireEvent.click(leaving);
    fireEvent.click(leaving.querySelector('.ask-notice-cta') as HTMLElement);
    expect(actions.revealNode).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector('.ask-notice')).toBeNull());
  });

  it('exposes a keyboard/AT-reachable Answer button that navigates exactly once', () => {
    withNodes({ child: askingNode('child', 'Deploy plan', 4) });
    render(<AskUserNotice />);

    fireEvent.click(screen.getByRole('button', { name: /answer the agent's question/i }));

    // stopPropagation keeps the card's onClick from firing a second navigation.
    expect(actions.revealNode).toHaveBeenCalledTimes(1);
  });

  it('keeps the keyboard: shrinking lands on the tab, opening on the title, and Esc shrinks', async () => {
    withNodes({ child: askingNode('child', 'Deploy plan', 4) });
    render(<AskUserNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'Shrink the question notice' }));
    const tab = await screen.findByRole('button', { name: "Show the agent's question" });
    await waitFor(() => expect(document.activeElement).toBe(tab));
    expect(tab.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(tab);
    const title = await screen.findByRole('heading', { name: 'Deploy plan' });
    await waitFor(() => expect(document.activeElement).toBe(title));
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(await screen.findByRole('button', { name: "Show the agent's question" })).toBeTruthy();
  });

  it('stays shrunk for the same questions after a reload of the window', async () => {
    withNodes({ child: askingNode('child', 'Deploy plan', 4) });
    const { unmount } = render(<AskUserNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'Shrink the question notice' }));
    await screen.findByRole('button', { name: "Show the agent's question" });
    unmount();
    render(<AskUserNotice />);
    expect(screen.getByRole('button', { name: "Show the agent's question" })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Agent question' })).toBeNull();
  });
});
