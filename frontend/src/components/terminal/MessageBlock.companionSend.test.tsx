import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_THREAD_MESSAGE_TITLE, DEFAULT_COMPANION_SETTINGS } from 'michi-shared';
import { MessageBlock } from './MessageBlock';
import type { ChatMessage } from '../../state/chatTypes';
import { getCompanionPanelState, resetCompanionPanelForTests } from '../../state/companion/companionPanel';
import { adoptCompanionAssistant, resetCompanionStoreForTests } from '../../state/companion/companionStore';
import { assistantInfo, companionSnapshot } from '../../test/companionFixtures';

const noop = () => {};

function show(message: Partial<ChatMessage>, onMentionClick = vi.fn()) {
  const view = render(
    <MessageBlock
      m={{ id: 'u-1', role: 'user', text: 'Please also update the changelog.', toolCalls: [], streaming: false, ...message }}
      index={0}
      isDark={false}
      onEdit={noop}
      copyText={() => ''}
      showThoughts={false}
      fontFamily="inherit"
      density="comfortable"
      onMentionClick={onMentionClick}
    />,
  );
  return { ...view, onMentionClick, source: view.container.querySelector<HTMLElement>('.terminal-message-thread-source') };
}

beforeEach(() => {
  resetCompanionStoreForTests();
  resetCompanionPanelForTests();
});
afterEach(cleanup);

describe('a follow-up the agent sent into a conversation it started (DESIGN-v2 §4)', () => {
  const send: Partial<ChatMessage> = {
    threadMessage: { fromNodeId: 'companion-node', fromTitle: 'Michi' },
    companionSend: { runId: 'cmr-send-1', via: 'user' },
  };

  it('reads "From <name>", says it was sent by the agent, and shows only the body', () => {
    const { source, container } = show(send);
    expect(source?.textContent).toBe('From Michi');
    expect(source?.getAttribute('title')).toBe('Sent by Michi');
    expect(container.querySelector('.terminal-message-user')?.textContent).toContain('Please also update the changelog.');
  });

  it('names the agent by the name the user gave it now, not the one it had when it sent', () => {
    resetCompanionStoreForTests({ snapshot: companionSnapshot({ settings: { ...structuredClone(DEFAULT_COMPANION_SETTINGS), displayName: 'Robin' } }) });
    const { source } = show(send);
    expect(source?.textContent).toBe('From Robin');
    expect(source?.getAttribute('title')).toBe('Sent by Robin');
  });

  it('opens the panel when the label is clicked, never the hidden conversation as a pane', () => {
    const { getByRole, onMentionClick } = show(send);
    expect(getCompanionPanelState().open).toBe(false);
    fireEvent.click(getByRole('button', { name: 'Michi' }));
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat' });
    expect(onMentionClick).not.toHaveBeenCalled();
  });

  it('treats any relayed message from the agent’s conversation the same, with or without companionSend', () => {
    resetCompanionStoreForTests({ assistant: { status: 'ready', info: assistantInfo('companion-node') as never, error: null } });
    const { source, getByRole, onMentionClick } = show({ threadMessage: { fromNodeId: 'companion-node', fromTitle: 'Assistant' } });
    expect(source?.textContent).toBe('From Michi');
    fireEvent.click(getByRole('button', { name: 'Michi' }));
    expect(getCompanionPanelState().open).toBe(true);
    expect(onMentionClick).not.toHaveBeenCalled();
  });

  it('follows once the store learns the agent’s conversation, for a message drawn before /assistant answered (W3-F3-review #6)', () => {
    const { container } = show({ threadMessage: { fromNodeId: 'companion-node', fromTitle: 'Assistant' } });
    const line = () => container.querySelector<HTMLElement>('.terminal-message-thread-source');
    expect(line()?.textContent).toBe('From Assistant');
    act(() => { adoptCompanionAssistant(assistantInfo('companion-node')); });
    expect(line()?.textContent).toBe('From Michi');
    expect(line()?.getAttribute('title')).toBe('Sent by Michi');
  });

  it('opens the panel for a message an earlier ⌘J or Scheduled conversation sent, never that hidden conversation (W3-F3-review #6)', () => {
    const { source, getByRole, onMentionClick } = show({ threadMessage: { fromNodeId: 'n-old-cmdj', fromTitle: ASSISTANT_THREAD_MESSAGE_TITLE } });
    expect(source?.textContent).toBe('From Michi');
    fireEvent.click(getByRole('button', { name: 'Michi' }));
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat' });
    expect(onMentionClick).not.toHaveBeenCalled();
  });

  it('leaves another thread’s message as it was: its title, and a click opens that thread', () => {
    const { source, getByRole, onMentionClick } = show({ threadMessage: { fromNodeId: 'n-a', fromTitle: 'Research notes' } });
    expect(source?.textContent).toBe('From Research notes');
    expect(source?.getAttribute('title')).toBe('Written by the agent in another thread and delivered with your approval');
    fireEvent.click(getByRole('button', { name: 'Research notes' }));
    expect(onMentionClick).toHaveBeenCalledWith('Research notes', 'node', 'n-a');
    expect(getCompanionPanelState().open).toBe(false);
  });
});
