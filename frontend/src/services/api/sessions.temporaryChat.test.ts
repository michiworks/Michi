import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureSession } from './sessions';

describe('ensure-session for a temporary chat', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('asks for one only while the chat has no session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ chatId: 'n-1', currentModeId: null, resumeStrategy: 'fresh' }), { status: 200 }));
    const body = (call: number) => JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body)) as Record<string, unknown>;

    await ensureSession({ nodeId: 'n-1', temporary: true });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/nodes\/n-1\/ensure-session$/);
    expect(body(0).temporary).toBe(true);
    await ensureSession({ nodeId: 'n-1', chatId: 'n-1', temporary: true });
    expect(body(1)).not.toHaveProperty('temporary');
    await ensureSession({ nodeId: 'n-2' });
    expect(body(2)).not.toHaveProperty('temporary');
  });
});
