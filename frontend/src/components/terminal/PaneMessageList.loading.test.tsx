import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';
import { markBackendConnectionReady, markBackendConnectionUnavailable } from '../../config/backendConnectionState';
import { setKnownBackendConnections } from '../../config/backendConnections';
import { NodeMessagesContext, type EnsureNodeMessages } from '../../state/nodeMessagesSelfHeal';
import { PaneMessageList } from './PaneMessageList';

const placeholder: ChatNodeState = {
  nodeId: 'remote:box:n1', projectId: 'remote:box:ws', kind: 'chat', chatId: null, status: 'idle', followUps: [],
  messages: [], messagesLoaded: false, messageCount: 4,
};
const noop = () => {};

function renderList(node: ChatNodeState, ensure: EnsureNodeMessages | null) {
  return render(
    <NodeMessagesContext.Provider value={ensure}>
      <PaneMessageList node={node} prefs={DEFAULT_PREFS} contentStyle={{}} streaming={false}
        onRetryTurn={noop} onEditUserMessage={noop} onContinueFollowUp={noop} onBranchFollowUp={noop} />
    </NodeMessagesContext.Provider>,
  );
}

describe('conversation loading skeleton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setKnownBackendConnections([{ id: 'box', name: 'Build box', transport: 'ssh', hasToken: true, createdAt: 1, updatedAt: 1 }]);
  });
  afterEach(() => {
    markBackendConnectionReady('box');
    setKnownBackendConnections([]);
    vi.useRealTimers();
  });

  it('asks for its own node after a few seconds without content', () => {
    const ensure = vi.fn<EnsureNodeMessages>(() => new Promise(() => {}));
    renderList(placeholder, ensure);
    expect(screen.getByTestId('messages-loading').getAttribute('aria-busy')).toBe('true');
    act(() => { vi.advanceTimersByTime(2900); });
    expect(ensure).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(100); });
    expect(ensure).toHaveBeenCalledExactlyOnceWith('remote:box:n1', { signal: expect.any(AbortSignal) });
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('says it is still loading after eight seconds and retries at once on request', () => {
    const ensure = vi.fn<EnsureNodeMessages>(() => new Promise(() => {}));
    renderList(placeholder, ensure);
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.getByRole('status').textContent).toBe('Still loading…');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(ensure).toHaveBeenLastCalledWith('remote:box:n1', { signal: expect.any(AbortSignal), immediate: true });
    expect(screen.getByRole('button', { name: 'Retrying…' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('names the connection it is waiting for instead of offering a retry', () => {
    renderList(placeholder, vi.fn<EnsureNodeMessages>(() => new Promise(() => {})));
    act(() => { markBackendConnectionUnavailable('box'); });
    expect(screen.getByRole('status').textContent).toBe('Reconnecting to Build box…');
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    act(() => { markBackendConnectionReady('box'); });
    expect(screen.getByRole('status').textContent).toBe('Still loading…');
  });

  it('cancels its request when the history arrives', () => {
    const ensure = vi.fn<EnsureNodeMessages>(() => new Promise(() => {}));
    const view = renderList(placeholder, ensure);
    act(() => { vi.advanceTimersByTime(3000); });
    const { signal } = ensure.mock.calls[0][1]!;
    view.rerender(
      <NodeMessagesContext.Provider value={ensure}>
        <PaneMessageList node={{ ...placeholder, messagesLoaded: true,
          messages: [{ id: 'm', role: 'user', text: 'hello', toolCalls: [] }] }}
        prefs={DEFAULT_PREFS} contentStyle={{}} streaming={false}
        onRetryTurn={noop} onEditUserMessage={noop} onContinueFollowUp={noop} onBranchFollowUp={noop} />
      </NodeMessagesContext.Provider>,
    );
    expect(screen.queryByTestId('messages-loading')).toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it('only waits without a loader (provider-free renders)', () => {
    renderList(placeholder, null);
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.getByRole('status').textContent).toBe('Still loading…');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
