import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MotionConfig, MotionGlobalConfig } from 'motion/react';
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
    onSendQueuedNow: vi.fn(),
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

  it('a queue a Stop paused says so and offers Send now', () => {
    const props = renderQueue({ node: {
      nodeId: 'n1', kind: 'chat', chatId: 'chat-1', projectId: 'p1', messages: [], followUps: [], status: 'idle',
      queueErrored: true, queueStopped: true,
      pendingQueued: [{ id: 'q1', value: 'then push it', mentions: [], attachments: [], queuedAt: 1 }],
    } });
    expect(screen.getByText(/paused after Stop/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    expect(props.onSendQueuedNow).toHaveBeenCalled();
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

  function mount(entries = [entry], nodeId = 'n1', chat: { runtimeId?: string; slashEntries?: readonly SlashEntry[]; reducedMotion?: boolean } = {}) {
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
      onSendQueuedNow: vi.fn(),
      onEditPendingComment: vi.fn(),
      onRemovePendingComment: vi.fn(),
      onDismissQuote: vi.fn(),
      onRemovePendingAttachment: vi.fn(),
    });
    const ui = (node: ChatNodeState) => (chat.reducedMotion
      ? <MotionConfig reducedMotion="always"><PaneComposerPreBlocks {...props(node)} /></MotionConfig>
      : <PaneComposerPreBlocks {...props(node)} />);
    const view = render(ui(queuedNode(entries, nodeId, chat.runtimeId)));
    return {
      drain: () => view.rerender(ui(queuedNode([], nodeId, chat.runtimeId))),
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

  it('under reduced motion only fades: its height, margin and padding never move', async () => {
    MotionGlobalConfig.skipAnimations = false;
    try {
      const { drain } = mount([entry], 'n1', { reducedMotion: true });
      const block = screen.getByText('Refine the running turn').closest('.t-pre-block') as HTMLElement;
      const styles: string[] = [];
      const observer = new MutationObserver(() => styles.push(block.getAttribute('style') ?? ''));
      observer.observe(block, { attributes: true, attributeFilter: ['style'] });
      drain();
      await waitFor(() => expect(block.isConnected).toBe(false));
      observer.disconnect();
      expect(styles.join(';')).not.toMatch(/height|margin|padding/);
    } finally {
      MotionGlobalConfig.skipAnimations = true;
    }
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

describe('PaneComposerPreBlocks entrance', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts what the composer opens with settled and fades in only blocks created while it shows', () => {
    const queued = (id: string, queuedAt: number) => ({ id, value: `queued ${id}`, mentions: [], attachments: [], queuedAt });
    const comment = (id: string, createdAt: number) => ({ id, quotedText: `passage ${id}`, body: `reply ${id}`, createdAt });
    const props = (node: Partial<ChatNodeState>, quotedText: string | null): React.ComponentProps<typeof PaneComposerPreBlocks> => ({
      node: { nodeId: 'n1', kind: 'chat', chatId: 'chat-1', projectId: 'p1', messages: [], followUps: [], status: 'streaming', ...node },
      quoteMaxLines: 2,
      quotedText,
      pendingAttachments: [],
      canSteerQueued: false,
      steeringQueueId: null,
      onSteerQueued: vi.fn(),
      onRestoreQueued: vi.fn(),
      onSendQueuedNow: vi.fn(),
      onEditPendingComment: vi.fn(),
      onRemovePendingComment: vi.fn(),
      onDismissQuote: vi.fn(),
      onRemovePendingAttachment: vi.fn(),
    });
    const restored = { pendingQueued: [queued('q1', 1)], pendingComments: [comment('c1', 1)] };
    const { container, rerender } = render(<PaneComposerPreBlocks {...props(restored, 'restored quote')} />);
    const blocks = '.t-pre-block, .t-ctx-chip';
    const fresh = () => [...container.querySelectorAll(blocks)].filter((el) => el.hasAttribute('data-fresh')).map((el) => el.textContent);
    expect(container.querySelectorAll(blocks)).toHaveLength(3);
    expect(fresh()).toEqual([]);

    const now = Date.now();
    const added = { pendingQueued: [queued('q1', 1), queued('q2', now)], pendingComments: [comment('c1', 1), comment('c2', now)] };
    rerender(<PaneComposerPreBlocks {...props(added, null)} />);
    rerender(<PaneComposerPreBlocks {...props(added, 'picked later')} />);
    expect(fresh()).toEqual([
      expect.stringContaining('queued q2'),
      expect.stringContaining('reply c2'),
      expect.stringContaining('picked later'),
    ]);
  });
});

describe('PaneComposerPreBlocks pending comment edit', () => {
  afterEach(() => {
    // Unmount first: the tray's card is portaled to <body>.
    cleanup();
    document.body.innerHTML = '';
  });

  it.each([
    ['saved with ⌘↵', { key: 'Enter', metaKey: true }],
    ['cancelled with Esc', { key: 'Escape' }],
  ])('hands the keyboard back to the comment reply when the edit is %s', (_how, key) => {
    const onEditPendingComment = vi.fn();
    const node: ChatNodeState = {
      nodeId: 'n1', kind: 'chat', chatId: 'chat-1', projectId: 'p1', messages: [], followUps: [], status: 'idle',
      pendingComments: [{ id: 'c1', quotedText: 'the passage', body: 'first reply', createdAt: 1 }],
    };
    render(
      <div className="terminal-pane">
        <div className="terminal-composer">
          <PaneComposerPreBlocks node={node} quoteMaxLines={2} quotedText={null} pendingAttachments={[]} canSteerQueued={false}
            steeringQueueId={null} onSteerQueued={vi.fn()} onRestoreQueued={vi.fn()} onSendQueuedNow={vi.fn()} onEditPendingComment={onEditPendingComment}
            onRemovePendingComment={vi.fn()} onDismissQuote={vi.fn()} onRemovePendingAttachment={vi.fn()} />
          <div role="textbox" aria-label="Message" contentEditable suppressContentEditableWarning tabIndex={0} />
        </div>
      </div>,
    );
    // The tray's chip opens the card where the note is edited.
    fireEvent.click(screen.getByRole('button', { name: 'Comment: first reply' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit comment: first reply' }));
    const field = document.querySelector('textarea.t-ctx-edit') as HTMLTextAreaElement;
    field.focus();
    fireEvent.change(field, { target: { value: 'second reply' } });
    fireEvent.keyDown(field, key);
    expect(document.querySelector('textarea.t-ctx-edit')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit comment: first reply' }));
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

describe('PaneComposerPreBlocks comments and quote', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('carries the pending comments and the quote in one tray row, above the attachments', () => {
    renderQueue({
      node: {
        nodeId: 'n1', kind: 'chat', chatId: 'chat-1', projectId: 'p1', messages: [], followUps: [], status: 'idle',
        pendingComments: [{ id: 'c1', quotedText: 'the passage', body: 'tighten this', createdAt: 1 }],
        composerDraft: { value: '', mentions: [], quotedText: 'a warm cache', quoteSource: { type: 'artifact', filePath: 'docs/notes.md', name: 'notes.md' } },
      },
      quotedText: 'a warm cache',
      pendingAttachments: [{ id: 'att1', name: 'log.txt', absPath: '/tmp/log.txt' }],
    });
    const tray = screen.getByRole('group', { name: 'Sent with your message' });
    expect([...tray.querySelectorAll('.t-ctx-chip')].map((el) => el.getAttribute('data-ctx-key'))).toEqual(['c1', 'quote']);
    expect(tray.querySelector('.t-ctx-chip.is-quote .t-ctx-chip-label')!.textContent).toBe('Replying to · notes.md');
    // The stacked rows are gone from the composer itself.
    expect(document.querySelector('.terminal-composer .t-ctx, .t-ctx-list')).toBeNull();
    expect(tray.compareDocumentPosition(document.querySelector('.t-att-pending-row')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
