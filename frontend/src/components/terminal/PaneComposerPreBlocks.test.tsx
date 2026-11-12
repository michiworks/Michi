import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatNodeState } from '../../state/chatTypes';
import { buildSlashEntries, type SlashEntry } from '../../state/slashEntries';
import { API_BASE_URL } from '../../config/env';
import { PaneComposerPreBlocks } from './PaneComposerPreBlocks';

// The shell's active workspace; a pane's attachments live in the pane's own one.
vi.mock('../../state/chatStore', () => ({
  useChatProjects: () => ({ activeProject: { id: 'ws-user' } }),
}));

function renderQueue(overrides: Partial<React.ComponentProps<typeof PaneComposerPreBlocks>> = {}) {
  const node: ChatNodeState = {
    nodeId: 'n1',
    kind: 'chat',
    chatId: 'chat-1',
    projectId: 'p1',
    messages: [],
    followUps: [],
    status: 'streaming',
    pendingQueued: [{
      id: 'q1',
      value: 'Refine the running turn',
      mentions: [],
      attachments: [],
      queuedAt: 1,
    }],
  };
  const props: React.ComponentProps<typeof PaneComposerPreBlocks> = {
    node,
    quoteMaxLines: 2,
    quotedText: null,
    pendingAttachments: [],
    canSteerQueued: true,
    steeringQueueId: null,
    onSteerQueued: vi.fn(),
    onRestoreQueued: vi.fn(),
    onEditPendingComment: vi.fn(),
    onRemovePendingComment: vi.fn(),
    onDismissQuote: vi.fn(),
    onRemovePendingAttachment: vi.fn(),
    ...overrides,
  };
  render(<PaneComposerPreBlocks {...props} />);
  return props;
}

describe('PaneComposerPreBlocks queued steer', () => {
  it('keeps the message queued and offers an explicit Steer now action', () => {
    const props = renderQueue();
    expect(screen.getByText(/sends when stream ends/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Steer now' }));
    expect(props.onSteerQueued).toHaveBeenCalledWith('q1');
  });
});

describe('PaneComposerPreBlocks queued block leaving', () => {
  const queuedNode = (pendingQueued: ChatNodeState['pendingQueued'], nodeId = 'n1', runtimeId?: string): ChatNodeState => ({
    nodeId,
    kind: 'chat',
    chatId: 'chat-1',
    projectId: 'p1',
    ...(runtimeId ? { runtimeId } : {}),
    messages: [],
    followUps: [],
    status: 'streaming',
    pendingQueued,
  });
  const queuedEntry = (id: string, value: string) => ({ id, value, mentions: [], attachments: [], queuedAt: 1 });
  const entry = queuedEntry('q1', 'Refine the running turn');

  function mount(entries = [entry], nodeId = 'n1', chat: { runtimeId?: string; slashEntries?: readonly SlashEntry[] } = {}) {
    const onRestoreQueued = vi.fn();
    const props = (node: ChatNodeState): React.ComponentProps<typeof PaneComposerPreBlocks> => ({
      node,
      quoteMaxLines: 2,
      quotedText: null,
      pendingAttachments: [],
      canSteerQueued: true,
      slashEntries: chat.slashEntries,
      steeringQueueId: null,
      onSteerQueued: vi.fn(),
      onRestoreQueued,
      onEditPendingComment: vi.fn(),
      onRemovePendingComment: vi.fn(),
      onDismissQuote: vi.fn(),
      onRemovePendingAttachment: vi.fn(),
    });
    const view = render(<PaneComposerPreBlocks {...props(queuedNode(entries, nodeId, chat.runtimeId))} />);
    return {
      drain: () => view.rerender(<PaneComposerPreBlocks {...props(queuedNode([], nodeId, chat.runtimeId))} />),
      onRestoreQueued,
      container: view.container,
    };
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('a drained block folds away out of reach', async () => {
    const { drain } = mount();
    const block = screen.getByText('Refine the running turn').closest('.t-pre-block') as HTMLElement;
    drain();
    // Still on screen while it folds away, but not reachable.
    expect(block.getAttribute('aria-hidden')).toBe('true');
    expect(block.hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(block.isConnected).toBe(false));
  });

  it('a queued skill is a turn of its own: never steered', () => {
    const slashEntries = buildSlashEntries({ runtimeId: 'kiro', catalog: { commands: [], skills: [
      { id: 'library:review', name: 'review', description: 'Review', origin: 'library', userInvocable: true, modelInvocable: true, enabled: true },
    ] } });
    const { container } = mount([queuedEntry('q1', '/review the diff')], 'n-skill', { runtimeId: 'kiro', slashEntries });
    expect(within(container).queryByRole('button', { name: 'Steer now' })).toBeNull();
  });

  it('× takes it back into the composer', () => {
    const { onRestoreQueued } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dequeue message' }));
    expect(onRestoreQueued).toHaveBeenCalledWith('q1');
  });
});

describe('PaneComposerPreBlocks pending attachments', () => {
  const diagram = {
    id: 'a1', name: 'diagram.png',
    absPath: '/data/assistant/.michi/.attachments/diagram.png', relPath: '.attachments/diagram.png',
  };

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each([
    ['ws-assistant', `${API_BASE_URL}/files/ws-assistant/.attachments/diagram.png`],
    ['remote:c1:ws', `${API_BASE_URL}/backend-connections/c1/proxy/files/ws/.attachments/diagram.png`],
  ])('builds the thumbnail from the workspace the pane uploaded to (%s), not the shell\'s', (workspaceId, src) => {
    renderQueue({ workspaceId, pendingAttachments: [diagram] });
    expect(screen.getByRole('img', { name: 'diagram.png' }).getAttribute('src')).toBe(src);
  });

  it('falls back to a file chip when the thumbnail fails to load', () => {
    renderQueue({ workspaceId: 'ws-assistant', pendingAttachments: [diagram] });
    fireEvent.error(screen.getByRole('img', { name: 'diagram.png' }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByTitle(diagram.absPath).textContent).toContain('diagram.png');
  });

  it('treats a name without an extension as a file, not an image', () => {
    renderQueue({ workspaceId: 'ws-assistant', pendingAttachments: [{ ...diagram, name: 'png' }] });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByTitle(diagram.absPath).textContent).toContain('png');
  });

  it.each([
    ['an image', { id: 'a1', name: 'diagram.png', absPath: '/w/.attachments/diagram.png', relPath: '.attachments/diagram.png' }],
    ['a file', { id: 'a1', name: 'notes.txt', absPath: '/w/.attachments/notes.txt', relPath: '.attachments/notes.txt' }],
  ])('removes %s with a named button the keyboard reaches, revealed by its row', (_kind, attachment) => {
    const props = renderQueue({ node: { nodeId: 'n1', kind: 'chat', chatId: 'chat-1', projectId: 'ws1', messages: [], followUps: [], status: 'idle' }, workspaceId: 'ws1', pendingAttachments: [attachment] });
    const remove = screen.getByRole('button', { name: `Remove ${attachment.name}` });
    expect(remove.tabIndex).toBe(0);
    expect(remove.classList.contains('t-reveal')).toBe(true);
    expect(remove.closest('.t-att-pending-item')?.classList.contains('t-reveal-host')).toBe(true);
    fireEvent.click(remove);
    expect(props.onRemovePendingAttachment).toHaveBeenCalledWith('a1');
  });
});
