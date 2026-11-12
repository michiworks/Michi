import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markBackendConnectionReady } from '../../config/backendConnectionState';
import { backendEntityId } from '../../config/backendIdentity';
import { markRemoteFirstPaint, resetRemoteFirstPaint } from '../../state/remoteFirstPaint';
import { listAgentModes, warmCwd } from './sessions';

const connectionId = 'remote-sessions-defer';

describe('remote boot reads in sessions', () => {
  let fetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    markBackendConnectionReady(connectionId);
    fetch = vi.fn(async () => new Response(JSON.stringify({ availableModes: [], defaultModeId: null })));
    vi.stubGlobal('fetch', fetch);
  });
  afterEach(() => { vi.unstubAllGlobals(); resetRemoteFirstPaint(); });

  it('holds the mode catalog and the warm request until the remote paints', async () => {
    const modes = listAgentModes(backendEntityId(connectionId, 'ws'));
    const warm = warmCwd('/tmp', connectionId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    markRemoteFirstPaint(connectionId);
    await Promise.all([modes, warm]);
    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.endsWith('/modes'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/warm'))).toBe(true);
  });

  it('stops a held read whose caller left', async () => {
    const controller = new AbortController();
    const modes = listAgentModes(backendEntityId(connectionId, 'ws'), controller.signal);
    controller.abort();
    markRemoteFirstPaint(connectionId);
    await expect(modes).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
