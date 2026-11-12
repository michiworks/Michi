import { afterEach, describe, expect, it, vi } from 'vitest';
import { putChatNotificationLevel } from './prefs';

// The chat notification level PUT (DESIGN-v2 §5.2, W3-F3-review #2 and #3): what each answer means
// for the provider's retries.

const LEVEL_URL = 'http://localhost:3000/api/companion/chat-notification-level';

afterEach(() => { vi.unstubAllGlobals(); });

function answering(status: number | Error) {
  const fetchMock = vi.fn(async () => {
    if (status instanceof Error) throw status;
    return new Response(status === 204 ? null : JSON.stringify({ level: 'off' }), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('putChatNotificationLevel', () => {
  it('PUTs {level} as JSON to the Companion route', async () => {
    const fetchMock = answering(200);
    await expect(putChatNotificationLevel('approval-only')).resolves.toBe('saved');
    expect(fetchMock).toHaveBeenCalledWith(LEVEL_URL, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'approval-only' }),
    });
  });

  it('is saved on any 2xx', async () => {
    answering(204);
    await expect(putChatNotificationLevel('off')).resolves.toBe('saved');
  });

  it.each([400, 404, 405])('is unsupported, never retried, on %i (no such route, or the body was refused)', async (status) => {
    answering(status);
    await expect(putChatNotificationLevel('off')).resolves.toBe('unsupported');
  });

  it.each([401, 403, 408, 409, 429, 500, 502, 503])('failed, worth another try, on %i', async (status) => {
    answering(status);
    await expect(putChatNotificationLevel('off')).resolves.toBe('failed');
  });

  it('failed when the backend cannot be reached', async () => {
    answering(new TypeError('Failed to fetch'));
    await expect(putChatNotificationLevel('off')).resolves.toBe('failed');
  });
});
