import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockSubmissionSignature, type BlockSubmission } from 'michi-shared';
import type { AssistantBlock } from '../../state/chatTypes';
import { ChatBlocksHostContext, ChatBlocksView, type ChatBlocksHost } from './ChatBlocksView';

const api = vi.hoisted(() => ({
  stored: [] as BlockSubmission[],
  list: vi.fn(),
  create: vi.fn(),
}));
vi.mock('../../services/api/blockSubmissions', () => ({
  listBlockSubmissions: api.list,
  createBlockSubmission: api.create,
}));

afterEach(() => { cleanup(); api.stored = []; api.list.mockReset(); api.create.mockReset(); });

const shown: AssistantBlock = {
  id: 'a-1-b-1',
  kind: 'blocks',
  title: 'Trip',
  fallbackText: 'Trip',
  blocks: [
    { type: 'form', id: 'cb-form', title: 'Details', prompt: 'Plan my trip', fields: [{ key: 'city', label: 'City', type: 'text', required: true }] },
    { type: 'poll', id: 'cb-poll', question: 'Which day?', options: ['Monday', 'Tuesday'] },
    { type: 'choice', id: 'cb-choice', question: 'Seat?', options: ['Window', 'Aisle'] },
    { type: 'actions', id: 'cb-actions', buttons: [{ label: 'Book it', prompt: 'Book the trip' }] },
    { type: 'stat', id: 'cb-stat', label: 'Budget left', value: '$420' },
  ],
};

function draw(host: ChatBlocksHost | null, blocks: AssistantBlock[] = [shown]) {
  return render(<ChatBlocksHostContext.Provider value={host}><ChatBlocksView blocks={blocks} messageId="a-1" /></ChatBlocksHostContext.Provider>);
}

describe('ChatBlocksView', () => {
  it('draws each block with the page renderers, under the title, keyed by the id Michi gave it', () => {
    const { container } = draw({ nodeId: 'n', send: () => true });
    const section = screen.getByRole('region', { name: 'Trip' });
    expect(within(section).getByRole('heading', { name: 'Trip' })).toBeTruthy();
    expect([...container.querySelectorAll('[data-block-id]')].map((el) => el.getAttribute('data-block-id')))
      .toEqual(['cb-form', 'cb-poll', 'cb-choice', 'cb-actions', 'cb-stat']);
    expect(screen.getByText('$420')).toBeTruthy();
    expect(container.querySelector('[data-michi-block="unknown"]')).toBeNull();
  });

  it('sends a vote, a pick, a button and a form as the user\'s message, in the shape a page sends', () => {
    const send = vi.fn((_text: string, _answer?: unknown) => true);
    draw({ nodeId: 'n', send });
    fireEvent.click(screen.getByRole('radio', { name: 'Tuesday' }));
    fireEvent.click(screen.getByRole('button', { name: 'Vote' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aisle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Book it' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'City' }), { target: { value: ' Paris ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(send.mock.calls.map(([text]) => text)).toEqual([
      'For “Which day?” I pick: Tuesday',
      'For “Seat?” I pick: Aisle',
      'Book the trip',
      'Plan my trip\n\n{"city":"Paris"}',
    ]);
    // Each send names the block it answers, under this reply, with its question or title.
    expect(send.mock.calls.map(([, answer]) => answer)).toEqual([
      { messageId: 'a-1', blockId: 'cb-poll', title: 'Which day?' },
      { messageId: 'a-1', blockId: 'cb-choice', title: 'Seat?' },
      { messageId: 'a-1', blockId: 'cb-actions', title: 'Book it' },
      { messageId: 'a-1', blockId: 'cb-form', title: 'Details' },
    ]);
    // Every send goes at once, so a form says it was sent, not handed to an assistant.
    expect(screen.getAllByRole('button', { name: 'Sent' }).length).toBeGreaterThanOrEqual(2);
  });

  it('a required field left empty sends nothing', () => {
    const send = vi.fn(() => true);
    draw({ nodeId: 'n', send });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('draws disabled where the thread cannot answer (read-only, archived), and outside a chat pane', () => {
    for (const host of [{ nodeId: 'n' }, null]) {
      const { container, unmount } = draw(host);
      expect(container.querySelector('.t-chat-blocks')?.getAttribute('data-disabled')).toBe('true');
      expect((screen.getByRole('button', { name: 'Vote' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: 'Book it' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
      expect((container.querySelector('fieldset.michi-doc-choice') as HTMLFieldSetElement).disabled).toBe(true);
      unmount();
    }
  });

  it('takes no focus when it appears', () => {
    const before = document.activeElement;
    draw({ nodeId: 'n', send: () => true });
    expect(document.activeElement).toBe(before);
  });
});

describe('ChatBlocksView with the thread\'s block submissions', () => {
  const host = (send?: (text: string) => boolean): ChatBlocksHost => ({ nodeId: 'n', workspaceId: 'ws', connectionId: 'local', ...(send ? { send } : {}) });
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const poll = (shown.blocks as Array<{ id: string }>).find((block) => block.id === 'cb-poll')!;

  it('stores a vote under this reply first, sends it, and shows it read-only, after a remount too', async () => {
    api.list.mockImplementation(async () => api.stored);
    api.create.mockImplementation(async (_connection: string, _workspace: string, input: { blockId: string; signature: string; value: unknown; text: string }) => {
      const submission = { blockId: input.blockId, signature: input.signature, value: input.value, text: input.text, submittedAt: Date.now() };
      api.stored.push(submission);
      return { status: 'created', submission };
    });
    const send = vi.fn((_text: string) => true);
    const first = draw(host(send));
    await flush();
    expect(api.list).toHaveBeenCalledWith('local', 'ws', { kind: 'chat', nodeId: 'n', messageId: 'a-1' }, expect.anything());
    fireEvent.click(screen.getByRole('radio', { name: 'Tuesday' }));
    fireEvent.click(screen.getByRole('button', { name: 'Vote' }));
    await flush();
    expect(api.create).toHaveBeenCalledWith('local', 'ws', {
      host: { kind: 'chat', nodeId: 'n', messageId: 'a-1' }, blockId: 'cb-poll', signature: blockSubmissionSignature(poll as never),
      value: [1], text: 'For “Which day?” I pick: Tuesday',
    });
    expect(send).toHaveBeenCalledExactlyOnceWith('For “Which day?” I pick: Tuesday', { messageId: 'a-1', blockId: 'cb-poll', title: 'Which day?' });
    expect(screen.queryByRole('button', { name: 'Vote' })).toBeNull();
    first.unmount();

    // A reload: the stored vote comes back, the poll is locked, and nothing can be sent again.
    draw(host(send));
    await flush();
    expect(screen.queryByRole('button', { name: 'Vote' })).toBeNull();
    expect((screen.getByRole('radio', { name: 'Tuesday' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Tuesday' }).matches(':disabled')).toBe(true);
    expect(screen.getAllByText(/Submitted ·/)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when another window answered first', async () => {
    const other = { blockId: 'cb-choice', signature: blockSubmissionSignature((shown.blocks as never[])[2]), value: 0, text: 'For “Seat?” I pick: Window', submittedAt: 1 };
    api.list.mockResolvedValue([]);
    api.create.mockResolvedValue({ status: 'exists', submission: other });
    const send = vi.fn((_text: string) => true);
    draw(host(send));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Aisle' }));
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Window' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a thread that cannot answer shows what was submitted and stores nothing', async () => {
    api.list.mockResolvedValue([{ blockId: 'cb-poll', signature: blockSubmissionSignature(poll as never), value: [0], text: 'x', submittedAt: 1 }]);
    draw(host());
    await flush();
    expect((screen.getByRole('radio', { name: 'Monday' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Submit' }).matches(':disabled')).toBe(true);
    expect(api.create).not.toHaveBeenCalled();
  });
});
