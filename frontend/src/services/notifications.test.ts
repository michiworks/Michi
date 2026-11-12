import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronBridge } from '../lib/electronBridge';

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { custom: vi.fn(), dismiss: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { resetOsNotificationsForTests } from './attention/desktop';
import { notify } from './notifications';

let clickListener: ((key: string) => void) | undefined;
const showNotification = vi.fn();

beforeEach(() => {
  resetOsNotificationsForTests();
  toastMock.mockReset();
  toastMock.custom.mockReset();
  showNotification.mockReset();
  window.electron = {
    showNotification,
    onAttentionNotificationClick: (listener: (key: string) => void) => { clickListener = listener; return () => {}; },
  } as unknown as ElectronBridge;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.electron;
});

describe('notify', () => {
  it('toasts right away, without an OS notification while the window is focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    notify({ title: 'Ping check · Succeeded', body: 'PONG' });
    expect(toastMock).toHaveBeenCalledWith('Ping check · Succeeded', expect.objectContaining({ description: 'PONG', duration: 4000 }));
    notify({ title: 'Open me', onClick: () => {} });
    expect(toastMock.custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ duration: 4000 }));
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('adds an OS notification while unfocused whose click runs onClick', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const onClick = vi.fn();
    notify({ title: 'Ping check · Failed', body: 'timeout', onClick });
    expect(showNotification).toHaveBeenCalledWith('Ping check · Failed', 'timeout', { key: expect.stringMatching(/^notify:/) });
    const { key } = showNotification.mock.calls[0]![2] as { key: string };
    clickListener!(key);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("uses the caller's key, so a newer notification for the target replaces the older one", () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    notify({ title: 'Digest · Needs your approval', key: 'scheduled:run-1' });
    notify({ title: 'Digest · Scheduled job finished', key: 'scheduled:run-1' });
    expect(showNotification.mock.calls.map((call) => call[2])).toEqual([{ key: 'scheduled:run-1' }, { key: 'scheduled:run-1' }]);
  });
});
