import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReplyMemorySource } from 'michi-shared';
import type { ChatMessage } from '../../state/chatTypes';

// What a reply was based on, in its message (MessageBlock): where the line
// sits, which messages get one, that the store's updates never re-render the
// block, and that a tap on it never reveals the message's action row.

const api = vi.hoisted(() => ({ fetchReplyMemorySources: vi.fn() }));
const renders = vi.hoisted(() => ({ blocks: 0 }));
vi.mock('../../services/api/memories', async (original) => ({
  ...(await original<typeof import('../../services/api/memories')>()),
  fetchReplyMemorySources: api.fetchReplyMemorySources,
}));
// Every render of the message block reads its turn's info once: a count of its renders.
vi.mock('./AgentLineBlocks', async (original) => {
  const actual = await original<typeof import('./AgentLineBlocks')>();
  return {
    ...actual,
    useAgentTurnInfo: (...args: Parameters<typeof actual.useAgentTurnInfo>) => {
      renders.blocks += 1;
      return actual.useAgentTurnInfo(...args);
    },
  };
});

import { MessageBlock } from './MessageBlock';
import { ReplySourcesContext, removeReplySource, resetReplySources, type ReplySourcesTarget } from '../../state/memory/replySources';

// jsdom has no PointerEvent, so fireEvent would drop pointerType.
class TestPointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

const TARGET: ReplySourcesTarget = { apiBase: 'http://localhost:3000/api', nodeId: 'n-1', backendConnectionId: 'local', workspaceId: 'ws-1', local: true };
const SAVED: ReplyMemorySource = { kind: 'memory', memoryId: 'mem-1', text: 'Use pnpm, never npm.', savedBy: 'user', at: Date.now(), from: null };
const reply = { id: 'a-1', role: 'assistant' as const, text: 'Install it with pnpm.', toolCalls: [], streaming: false } satisfies Partial<ChatMessage> as ChatMessage;

function block(m: ChatMessage, extra: { hideActions?: boolean; isErrorTail?: boolean } = {}) {
  return (
    <ReplySourcesContext.Provider value={TARGET}>
      <MessageBlock m={m} index={0} isDark={false} copyText={() => ''} showThoughts={false} fontFamily="inherit" density="comfortable"
        hideActions={extra.hideActions} isErrorTail={extra.isErrorTail} errorMessage={extra.isErrorTail ? 'It failed' : undefined} />
    </ReplySourcesContext.Provider>
  );
}

beforeEach(() => {
  api.fetchReplyMemorySources.mockReset();
  api.fetchReplyMemorySources.mockImplementation(async (_apiBase: string, _nodeId: string, ids: string[]) => ({
    messages: ids.map((messageId) => ({ messageId, sources: [SAVED] })),
  }));
  resetReplySources();
  renders.blocks = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe('MessageBlock and what a reply was based on', () => {
  it('a settled reply shows it under its receipts and before its actions and error; a user message, a streaming reply or a running turn shows none', async () => {
    const { container, rerender } = render(block(reply, { isErrorTail: true }));
    const region = await screen.findByRole('region', { name: 'What this reply was based on' });
    const copy = screen.getByRole('button', { name: 'copy message' });
    const errorTail = screen.getByText('It failed');
    expect(region.compareDocumentPosition(container.querySelector('.terminal-message-assistant')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(region.compareDocumentPosition(errorTail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(region.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    rerender(block({ ...reply, streaming: true }));
    expect(screen.queryByRole('region', { name: 'What this reply was based on' })).toBeNull();
    rerender(block(reply, { hideActions: true }));
    expect(screen.queryByRole('region', { name: 'What this reply was based on' })).toBeNull();
    rerender(block({ ...reply, id: 'u-1', role: 'user' }));
    expect(screen.queryByRole('region', { name: 'What this reply was based on' })).toBeNull();
    expect(api.fetchReplyMemorySources.mock.calls.flatMap((call) => call[2] as string[])).toEqual(['a-1']);
  });

  it('a store update re-renders the line only, never the message block', async () => {
    render(block(reply));
    await screen.findByRole('button', { name: 'Based on 1 thing you told me' });
    const before = renders.blocks;
    act(() => removeReplySource(TARGET, 'a-1', SAVED));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'What this reply was based on' })).toBeNull());
    expect(renders.blocks).toBe(before);
  });

  it('a tap on the line reveals nothing of the message\'s actions; a mouse over the reply still does', async () => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    const { container } = render(block(reply));
    const toggle = await screen.findByRole('button', { name: /^Based on/ });
    const actions = screen.getByRole('button', { name: 'copy message' }).parentElement!;
    expect(actions.style.opacity).toBe('0');
    fireEvent.pointerOver(toggle, { pointerType: 'touch' });
    fireEvent.pointerDown(toggle, { pointerType: 'touch' });
    fireEvent.mouseOver(toggle);
    fireEvent.click(toggle);
    // The tap went to the toggle alone.
    expect(actions.style.opacity).toBe('0');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = container.querySelector('.terminal-message-assistant')!;
    fireEvent.pointerOver(body, { pointerType: 'mouse' });
    fireEvent.mouseOver(body);
    expect(actions.style.opacity).toBe('1');
  });
});
