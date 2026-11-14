import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledRunTarget } from '../../../lib/electronBridge';
import { requestOpenScheduledRun } from '../../../state/attentionOpenRequests';
import { useScheduledRunOpening } from './useScheduledRunOpening';

const state = vi.hoisted(() => ({
  bridge: null as null | {
    initialScheduledRun: ScheduledRunTarget | null;
    onScheduledRunOpen: (handler: (target: ScheduledRunTarget) => void) => () => void;
  },
  openHandler: null as null | ((target: ScheduledRunTarget) => void),
  reveal: vi.fn(),
  toastError: vi.fn(),
  requestDetail: vi.fn(),
  requestRun: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock('../../../lib/electronBridge', () => ({ getElectron: () => state.bridge }));
vi.mock('../../../state/chatStore', () => ({
  useChatActions: () => ({ revealBackendNode: (...args: unknown[]) => state.reveal(...args) }),
}));
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => state.toastError(...args) } }));
vi.mock('./scheduledNav', () => ({
  requestScheduledJobDetail: (...args: unknown[]) => state.requestDetail(...args),
  requestScheduledRun: (...args: unknown[]) => state.requestRun(...args),
}));
vi.mock('../../../services/api/scheduledJobs', () => ({ getScheduledJobRun: (...args: unknown[]) => state.getRun(...args) }));

const target: ScheduledRunTarget = { runId: 'run-1', jobId: 'job-1', workspaceId: 'ws-1', nodeId: 'n-1' };

function installBridge(initial: ScheduledRunTarget | null = null): void {
  state.bridge = {
    initialScheduledRun: initial,
    onScheduledRunOpen: (handler) => { state.openHandler = handler; return () => { state.openHandler = null; }; },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.bridge = null;
  state.openHandler = null;
  state.reveal.mockResolvedValue(true);
  state.getRun.mockResolvedValue({ id: 'run-1', scheduledOnly: false });
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('useScheduledRunOpening', () => {
  it('opens the run a notification launched once the workspace hydrates, then clears the URL', async () => {
    window.history.replaceState(null, '', '/?michiWindowId=w1&michiOpenRun=run-1&michiOpenJob=job-1&michiOpenWorkspace=ws-1&michiOpenNode=n-1');
    installBridge(target);
    const onNav = vi.fn();
    const { rerender } = renderHook(({ hydrated }) => useScheduledRunOpening({ hydrated, onNav }), { initialProps: { hydrated: false } });
    expect(state.reveal).not.toHaveBeenCalled();

    rerender({ hydrated: true });
    await waitFor(() => expect(state.reveal).toHaveBeenCalledWith('ws-1', 'n-1'));
    expect(onNav).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?michiWindowId=w1');

    // A later re-render does not reopen it.
    rerender({ hydrated: true });
    expect(state.reveal).toHaveBeenCalledTimes(1);
  });

  it('falls back to the job detail when the thread is gone', async () => {
    installBridge();
    state.reveal.mockResolvedValue(false);
    const onNav = vi.fn();
    renderHook(() => useScheduledRunOpening({ hydrated: true, onNav }));

    await act(async () => { state.openHandler?.(target); });
    await waitFor(() => expect(onNav).toHaveBeenCalledWith('scheduled'));
    expect(state.toastError).toHaveBeenCalledWith('That thread is no longer available');
    expect(state.requestDetail).toHaveBeenCalledWith('job-1');
  });

  it('shows the job without an error when the run never created a thread', async () => {
    installBridge();
    const onNav = vi.fn();
    renderHook(() => useScheduledRunOpening({ hydrated: true, onNav }));

    await act(async () => { state.openHandler?.({ ...target, nodeId: null }); });
    await waitFor(() => expect(onNav).toHaveBeenCalledWith('scheduled'));
    expect(state.reveal).not.toHaveBeenCalled();
    expect(state.toastError).not.toHaveBeenCalled();
  });

  it('queues a click that arrives before hydration', async () => {
    installBridge();
    const onNav = vi.fn();
    const { rerender } = renderHook(({ hydrated }) => useScheduledRunOpening({ hydrated, onNav }), { initialProps: { hydrated: false } });

    act(() => { state.openHandler?.(target); });
    expect(state.reveal).not.toHaveBeenCalled();
    rerender({ hydrated: true });
    await waitFor(() => expect(state.reveal).toHaveBeenCalledWith('ws-1', 'n-1'));
  });

  it('opens the run a click on this window\'s own notification asks for (a scheduled_run attention record)', async () => {
    installBridge();
    renderHook(() => useScheduledRunOpening({ hydrated: true, onNav: vi.fn() }));
    await act(async () => { requestOpenScheduledRun(target); });
    expect(state.reveal).toHaveBeenCalledWith('ws-1', 'n-1');
  });

  it('opens a Scheduled-only run on the Scheduled page', async () => {
    installBridge();
    state.getRun.mockResolvedValue({ id: 'run-1', scheduledOnly: true });
    const onNav = vi.fn();
    renderHook(() => useScheduledRunOpening({ hydrated: true, onNav }));

    await act(async () => { state.openHandler?.(target); });
    await waitFor(() => expect(state.requestRun).toHaveBeenCalledWith('job-1', 'run-1'));
    expect(onNav).toHaveBeenCalledWith('scheduled');
    expect(state.reveal).not.toHaveBeenCalled();
  });

  it('detaches its bridge listeners on unmount', () => {
    installBridge();
    const { unmount } = renderHook(() => useScheduledRunOpening({ hydrated: true, onNav: vi.fn() }));
    expect(state.openHandler).not.toBeNull();
    unmount();
    expect(state.openHandler).toBeNull();
  });

  describe('in a browser, where no Electron main delivers clicks', () => {
    it('a click on a run that failed before it made a thread opens its job', async () => {
      const onNav = vi.fn();
      renderHook(() => useScheduledRunOpening({ hydrated: true, onNav }));
      await act(async () => { requestOpenScheduledRun({ ...target, nodeId: null }); });
      await waitFor(() => expect(onNav).toHaveBeenCalledWith('scheduled'));
      expect(state.requestDetail).toHaveBeenCalledWith('job-1');
      expect(state.reveal).not.toHaveBeenCalled();
      expect(state.toastError).not.toHaveBeenCalled();
    });

    it('says the thread is gone and opens the job when a click cannot reveal it', async () => {
      state.reveal.mockResolvedValue(false);
      const onNav = vi.fn();
      renderHook(() => useScheduledRunOpening({ hydrated: true, onNav }));
      await act(async () => { requestOpenScheduledRun(target); });
      await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('That thread is no longer available'));
      expect(state.requestDetail).toHaveBeenCalledWith('job-1');
    });

    it('opens a Scheduled-only run on the Scheduled page', async () => {
      state.getRun.mockResolvedValue({ id: 'run-1', scheduledOnly: true });
      const onNav = vi.fn();
      renderHook(() => useScheduledRunOpening({ hydrated: true, onNav }));
      await act(async () => { requestOpenScheduledRun(target); });
      await waitFor(() => expect(state.requestRun).toHaveBeenCalledWith('job-1', 'run-1'));
      expect(state.reveal).not.toHaveBeenCalled();
    });

    it('stops listening on unmount', async () => {
      const { unmount } = renderHook(() => useScheduledRunOpening({ hydrated: true, onNav: vi.fn() }));
      unmount();
      await act(async () => { requestOpenScheduledRun(target); });
      expect(state.reveal).not.toHaveBeenCalled();
    });
  });
});
