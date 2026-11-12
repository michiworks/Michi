import { describe, expect, it } from 'vitest';

describe('DOM test environment', () => {
  it('keeps browser APIs available outside the audited logic directories', () => {
    expect(document.createElement('div')).toBeInstanceOf(HTMLElement);
    expect(typeof ResizeObserver).toBe('function');
    expect(typeof Range.prototype.getBoundingClientRect).toBe('function');
    localStorage.setItem('test-environment', 'value');
    expect(window.localStorage.getItem('test-environment')).toBe('value');
    localStorage.clear();
    expect(localStorage.length).toBe(0);
  });

  it('answers the chat notification level PUT itself, so no test reaches a real backend (W3-F3-review #2)', async () => {
    // Port 9 refuses connections: only the setup's answer can make this succeed.
    const response = await fetch('http://127.0.0.1:9/api/companion/chat-notification-level', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'off' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ level: 'off' });
    // Anything else still goes to the network.
    await expect(fetch('http://127.0.0.1:9/api/prefs', { method: 'PUT', body: '{}' })).rejects.toThrow();
  });

  it('fails immediately on a React effect loop instead of starving the test timeout', () => {
    expect(() => console.error('Warning: Maximum update depth exceeded.')).toThrow(
      /Maximum update depth exceeded: check for unstable test props/,
    );
  });
});
