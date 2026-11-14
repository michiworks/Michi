/**
 * Home's composer for a temporary chat: dashed, with its own placeholder; its
 * send starts the thread as a temporary chat (marked at once, and asked for
 * with the first message) and turns Home's switch off. A regular send and a
 * digest follow-up ask for nothing.
 */
import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ManageComposer, { __resetManageComposerSessionStateForTests } from './ManageComposer';
import { resetTemporaryChatDraft, setTemporaryChatDraft, useTemporaryChatDraft } from '../../../state/temporaryChatDraft';

vi.mock('../../../state/prefs', async () => {
  const actual = await vi.importActual<typeof import('../../../state/prefs')>('../../../state/prefs');
  return { ...actual, usePrefs: () => ({ prefs: actual.DEFAULT_PREFS }) };
});

const store = vi.hoisted(() => ({
  createThread: vi.fn((..._args: unknown[]) => 'new-node-id'),
  createChildChat: vi.fn(async (..._args: unknown[]) => 'child-node-id'),
  sendMessage: vi.fn(),
}));
vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => ({
    ...store,
    setChatUltracode: vi.fn(),
    selectProject: vi.fn(),
    agentStatus: null,
    refreshAgentStatus: vi.fn(),
    availableModes: [],
    defaultModeId: null,
    projects: [{ id: 'ws1', name: 'Workspace', cwd: '/tmp', artifacts: [] }],
  }),
  useStructuralSelector: () => [],
  shallowArrayEqual: Object.is,
  chatLabel: () => 'New thread',
}));
vi.mock('../../../services/api', () => ({
  listPrimaryAgentDefinitions: vi.fn(async () => []),
  bindPendingPrimaryAgent: vi.fn(),
  fetchRuntimeCatalog: vi.fn(async () => ({ models: [], providers: [], capabilities: null })),
  saveAgentOptions: vi.fn(async () => ({})),
  getWebUploadCwd: vi.fn(async () => '/tmp'),
  importWorkspaceFileUpload: vi.fn(),
  copyWorkspaceFile: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
// A plain textarea for the editor, showing the placeholder it was given.
vi.mock('../../MentionEditor', () => ({
  default: React.forwardRef<any, any>(function MentionStub(props, ref) {
    React.useImperativeHandle(ref, () => ({ focus: () => {}, editor: null }));
    return <textarea placeholder={props.placeholder} value={props.value} onChange={(e) => props.onChange({ value: e.target.value, mentions: [] })} />;
  }),
}));

async function type(text: string) {
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: text } });
}
const send = () => fireEvent.click(screen.getByRole('button', { name: /send/i }));
const frame = (container: HTMLElement) => container.querySelector('[data-temporary-chat]');

beforeEach(() => {
  __resetManageComposerSessionStateForTests();
  store.createThread.mockClear();
  store.createChildChat.mockClear();
  store.sendMessage.mockClear();
  act(() => resetTemporaryChatDraft());
});

describe('Home’s composer for a temporary chat', () => {
  it('is dashed with its own placeholder; its send starts a temporary chat and turns the switch off', async () => {
    act(() => setTemporaryChatDraft(true));
    const draft = renderHook(() => useTemporaryChatDraft());
    const onSubmitted = vi.fn();
    const { container } = render(<ManageComposer workspaceId="ws1" temporary onSubmitted={onSubmitted} />);
    expect(frame(container)?.querySelector('.terminal-composer')).not.toBeNull();
    expect((await screen.findByRole('textbox')).getAttribute('placeholder')).toBe('Ask in a temporary chat');
    await type('Compare two job offers');
    send();
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    // Marked at once, and asked for with its first message.
    expect(store.createThread).toHaveBeenCalledWith(undefined, { temporary: true });
    expect(store.sendMessage).toHaveBeenCalledWith('new-node-id', 'Compare two job offers', { temporary: true });
    expect(draft.result.current).toBe(false);
  });

  it('asks for nothing on a regular Home send', async () => {
    const { container } = render(<ManageComposer workspaceId="ws1" onSubmitted={vi.fn()} />);
    expect(frame(container)).toBeNull();
    expect((await screen.findByRole('textbox')).getAttribute('placeholder')).toBe('What would you like to explore?');
    await type('Plan the trip');
    send();
    await waitFor(() => expect(store.sendMessage).toHaveBeenCalledOnce());
    expect(store.createThread).toHaveBeenCalledWith(undefined);
    expect(store.sendMessage).toHaveBeenCalledWith('new-node-id', 'Plan the trip', undefined);
  });

  it('never makes a digest follow-up temporary', async () => {
    act(() => setTemporaryChatDraft(true));
    const draft = renderHook(() => useTemporaryChatDraft());
    const { container } = render(<ManageComposer workspaceId="ws1" parentNodeId="digest-1" temporary onSubmitted={vi.fn()} />);
    expect(frame(container)).toBeNull();
    await type('Explain this');
    send();
    await waitFor(() => expect(store.createChildChat).toHaveBeenCalledOnce());
    expect((store.createChildChat.mock.calls[0]![2] as { temporary?: boolean } | undefined)?.temporary).toBeUndefined();
    expect(draft.result.current).toBe(true);
  });
});
