import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantNode } from './useAssistantNode';
import type { AssistantInfo } from '../../services/api/assistant';

const mocks = vi.hoisted(() => {
  const mocks = {
    workspace: vi.fn(), messages: vi.fn(), install: vi.fn(), dispatch: vi.fn(),
    node: undefined as { nodeId: string; projectId: string; messagesLoaded: boolean; messages: unknown[]; messageCount?: number; title?: string; lastAppliedSeq?: number } | undefined,
    // The store's reader is one function for the provider's life.
    readNode: () => mocks.node,
  };
  return mocks;
});
vi.mock('../../services/api/persistence', () => ({ fetchWorkspaceStructure: mocks.workspace, fetchTreeMessagePage: mocks.messages }));
vi.mock('../chatStore', () => ({
  useChatNode: () => mocks.node,
  useChatNodeReader: () => mocks.readNode,
  useChatProjects: () => ({ projects: [] }),
  useChatActions: () => ({ installWorkspaceSnapshot: mocks.install, dispatch: mocks.dispatch }),
}));
const info: AssistantInfo = {
  workspaceId: 'sys', nodeId: 'n1', treeId: 't1',
  settings: { runtimeId: 'kiro', modelId: null, reasoning: null }, supportedRuntimes: ['kiro'],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.node = undefined;
  mocks.workspace.mockImplementation(() => new Promise(() => {}));
  mocks.messages.mockImplementation(() => new Promise(() => {}));
});

describe('assistant loading during unrelated renders', () => {
  it('keeps a pending workspace read alive and cancels it when the conversation changes', () => {
    const view = renderHook(({ current }) => useAssistantNode(current), { initialProps: { current: info } });
    const signal = mocks.workspace.mock.calls[0][1] as AbortSignal;
    view.rerender({ current: { ...info } });
    view.rerender({ current: { ...info, settings: { ...info.settings, modelId: 'another-model' } } });
    expect(mocks.workspace).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    view.rerender({ current: { ...info, nodeId: 'n2', treeId: 't2' } });
    expect(signal.aborted).toBe(true);
    expect(mocks.workspace).toHaveBeenCalledTimes(2);
  });

  it('lets a slow history read finish across renders', async () => {
    mocks.node = { nodeId: 'n1', projectId: 'sys', messagesLoaded: false, messages: [] };
    let finish!: (page: unknown) => void;
    mocks.messages.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = renderHook(({ current }) => useAssistantNode(current), { initialProps: { current: info } });
    const signal = mocks.messages.mock.calls[0][3] as AbortSignal;
    view.rerender({ current: { ...info } });
    view.rerender({ current: { ...info } });
    expect(mocks.messages).toHaveBeenCalledTimes(1);
    // One page of this conversation, never its thread's other bodies.
    expect(mocks.messages).toHaveBeenCalledWith('sys', 't1', undefined, signal, { nodeId: 'n1', limit: 200 });
    expect(signal.aborted).toBe(false);
    await act(async () => finish({ messages: [] }));
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'messages-loaded', nodeIds: ['n1'], messagesByNode: { n1: [] } }));
  });

  it('installs the page bounds and the turn row read with the bodies', async () => {
    mocks.node = { nodeId: 'n1', projectId: 'sys', messagesLoaded: false, messages: [] };
    const page = { nodeId: 'n1', total: 300, before: { seq: 100, id: 'm100' } };
    const turn = { node_id: 'n1', turn_id: 'turn-9', status: 'active', last_seq: 41, error: null, completed_at: null };
    mocks.messages.mockResolvedValue({
      messages: [{ id: 'm100', node_id: 'n1', role: 'assistant', content: 'latest', seq: 100 }],
      pages: [page], turns: [turn],
    });
    renderHook(() => useAssistantNode(info));
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'messages-loaded', nodeIds: ['n1'], pages: [page], turns: [turn],
    })));
  });

  it('installs a page read while only the conversation\'s title changed, and reads again after its cursor moved', async () => {
    mocks.node = { nodeId: 'n1', projectId: 'sys', messagesLoaded: false, messages: [], messageCount: 1 };
    const page = (content: string) => ({ messages: [{ id: 'm1', node_id: 'n1', role: 'assistant', content, seq: 1 }], pages: [{ nodeId: 'n1', total: 1, before: null }] });
    mocks.messages.mockImplementationOnce(async () => {
      mocks.node = { ...mocks.node!, lastAppliedSeq: 4 };
      return page('stale');
    }).mockImplementationOnce(async () => {
      mocks.node = { ...mocks.node!, title: 'Named meanwhile' };
      return page('fresh');
    });
    renderHook(() => useAssistantNode(info));
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
    expect(mocks.messages).toHaveBeenCalledTimes(2);
    const [action] = mocks.dispatch.mock.calls[0];
    expect(action.messagesByNode.n1.map((message: { blocks?: Array<{ rawText?: string }> }) => message.blocks?.[0]?.rawText)).toEqual(['fresh']);
  });

  it('never installs an empty conversation for one that has messages', async () => {
    mocks.node = { nodeId: 'n1', projectId: 'sys', messagesLoaded: false, messages: [], messageCount: 3 };
    mocks.messages.mockResolvedValue({ messages: [], pages: [{ nodeId: 'n1', total: 3, before: null }] });
    const view = renderHook(() => useAssistantNode(info));
    await waitFor(() => expect(view.result.current.state).toBe('failed'));
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('still retries a failed read explicitly', async () => {
    mocks.workspace.mockRejectedValueOnce(new Error('offline'));
    const view = renderHook(() => useAssistantNode(info));
    await waitFor(() => expect(view.result.current.state).toBe('failed'));
    act(() => view.result.current.retry());
    expect(mocks.workspace).toHaveBeenCalledTimes(2);
    expect(view.result.current.state).toBe('loading');
  });
});
