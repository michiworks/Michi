import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_ACCESS_UNREACHABLE, mobileAccessRequest, setPhoneTerminal } from './mobileAccess';

afterEach(() => { vi.unstubAllGlobals(); });

describe('mobileAccessRequest', () => {
  it('sends the browser default credentials, which the loopback API allows from the dev server', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: 'stopped' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(mobileAccessRequest('local')).resolves.toEqual({ state: 'stopped' });
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('GET');
    expect(init.credentials).toBeUndefined();
  });

  it('says in a sentence that Michi could not be reached instead of "Failed to fetch"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(mobileAccessRequest('local')).rejects.toThrow(MOBILE_ACCESS_UNREACHABLE);
  });

  it('lets an abort through as an abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')));
    await expect(mobileAccessRequest('local')).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('setPhoneTerminal', () => {
  it('sends the browser default credentials, like the status request above it', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: 'running' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(setPhoneTerminal('local', true)).resolves.toEqual({ state: 'running' });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/mobile-access\/terminal$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
    expect(init.credentials).toBeUndefined();
  });

  it('says in a sentence that Michi could not be reached instead of "Failed to fetch"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(setPhoneTerminal('local', false)).rejects.toThrow(MOBILE_ACCESS_UNREACHABLE);
  });
});
