import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyPageChanged, subscribePageChanges } from './pageEvents';

describe('page change events', () => {
  const stops: Array<() => void> = [];
  afterEach(() => { for (const stop of stops.splice(0)) stop(); });

  it('reach subscribers once, without a second window channel', () => {
    const heard = vi.fn();
    const onWindow = vi.fn();
    stops.push(subscribePageChanges({ backendConnectionId: 'local', pageId: 'p1' }, heard));
    window.addEventListener('michi:page-changed', onWindow);
    stops.push(() => window.removeEventListener('michi:page-changed', onWindow));
    notifyPageChanged({ backendConnectionId: 'local', pageId: 'p1' });
    expect(heard).toHaveBeenCalledOnce();
    expect(onWindow).not.toHaveBeenCalled();
  });

  it('take a window event dispatched from outside (an E2E test) as one more change, dropping a malformed one', () => {
    const heard = vi.fn();
    stops.push(subscribePageChanges({ backendConnectionId: 'local', pageId: 'p1' }, heard));
    window.dispatchEvent(new CustomEvent('michi:page-changed', { detail: { backendConnectionId: 'local', pageId: 'p1' } }));
    window.dispatchEvent(new CustomEvent('michi:page-changed', { detail: { pageId: 'p1' } }));
    window.dispatchEvent(new CustomEvent('michi:page-changed', { detail: { backendConnectionId: 'remote', pageId: 'p1' } }));
    expect(heard.mock.calls).toEqual([[{ backendConnectionId: 'local', pageId: 'p1' }]]);
  });
});
