import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ subscribeBackground: vi.fn() }));
vi.mock('../services/api', () => api);
import { createBackgroundTurnTransport } from './backgroundTurnTransport';

describe('structure frames on the background transport', () => {
  beforeEach(() => { vi.useFakeTimers(); api.subscribeBackground.mockReset().mockReturnValue(vi.fn()); });
  afterEach(() => vi.useRealTimers());

  it('hands every connection attempt the same structure handler', async () => {
    const onWorkspaceStructureChanged = vi.fn();
    const transport = createBackgroundTurnTransport({
      connectionId: 'local', handlersForChat: () => ({}), onWorkspaceStructureChanged, random: () => 0.5,
    });
    transport.start();
    const first = api.subscribeBackground.mock.calls[0][1];
    first.onWorkspaceStructureChanged({ epoch: 'e', seq: 0, changes: [] });
    expect(onWorkspaceStructureChanged).toHaveBeenCalledWith({ epoch: 'e', seq: 0, changes: [] });
    // A reconnect opens with a fresh cursor frame through the same handler.
    first.onDisconnect({ retryable: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.subscribeBackground).toHaveBeenCalledTimes(2);
    expect(api.subscribeBackground.mock.calls[1][1].onWorkspaceStructureChanged).toBe(onWorkspaceStructureChanged);
    transport.stop();
  });
});
