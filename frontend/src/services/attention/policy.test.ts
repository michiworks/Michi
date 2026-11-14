import type React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import type { AttentionKind } from 'michi-shared';
import type { ElectronBridge } from '../../lib/electronBridge';

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { custom: vi.fn(), dismiss: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('./sound', () => ({ playAttentionSound: vi.fn(() => true) }));

import {
  attentionTargetKey,
  dismissAttention,
  presentAttention,
  resetAttentionForTests,
  setAttentionPreferences,
  type AttentionIntent,
} from './policy';
import { resetOsNotificationsForTests } from './desktop';
import { playAttentionSound } from './sound';

type CardElement = React.ReactElement<{ children: [React.ReactElement<{ children: string }>, unknown] }>;
interface ToastOptions { id?: string; duration?: number; onAutoClose?: () => void; onDismiss?: () => void }
interface Presentation { title: string; options: ToastOptions; card?: CardElement }

/** Every toast the policy raised, oldest first. */
function presentations(): Presentation[] {
  const plain = toastMock.mock.calls.map((call, index) => ({
    order: toastMock.mock.invocationCallOrder[index]!,
    title: call[0] as string,
    options: call[1] as ToastOptions,
  }));
  const cards = toastMock.custom.mock.calls.map((call, index) => {
    const card = (call[0] as (id: string) => CardElement)('toast-id');
    return {
      order: toastMock.custom.mock.invocationCallOrder[index]!,
      title: card.props.children[0].props.children,
      options: call[1] as ToastOptions,
      card,
    };
  });
  return [...plain, ...cards].sort((a, b) => a.order - b.order);
}

function intent(overrides: Partial<AttentionIntent> = {}): AttentionIntent {
  return {
    key: 'node:n1',
    kind: 'needs_input',
    title: 'Agent needs your input',
    body: 'Which database?',
    target: { type: 'node', nodeId: 'n1' },
    onOpen: vi.fn(),
    ...overrides,
  };
}

let hasFocus: MockInstance<() => boolean>;
let visibility: Mock<() => DocumentVisibilityState>;
let electron: { showNotification: Mock; onAttentionNotificationClick: Mock };
let clickListener: ((key: string) => void) | undefined;

function installElectron(): void {
  clickListener = undefined;
  electron = {
    showNotification: vi.fn(),
    onAttentionNotificationClick: vi.fn((listener: (key: string) => void) => { clickListener = listener; return () => {}; }),
  };
  window.electron = electron as unknown as ElectronBridge;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetAttentionForTests();
  resetOsNotificationsForTests();
  toastMock.mockReset();
  toastMock.custom.mockReset();
  toastMock.dismiss.mockReset();
  vi.mocked(playAttentionSound).mockReset().mockReturnValue(true);
  hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  visibility = vi.fn(() => 'visible' as DocumentVisibilityState);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility());
  installElectron();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.electron;
});

describe('when the policy speaks', () => {
  const cases = [true, false].flatMap((visible) => [true, false].flatMap((focused) =>
    (['visible', 'hidden'] as const).map((documentState) => ({ visible, focused, documentState }))));

  it.each(cases)('target visible $visible, window focused $focused, document $documentState', ({ visible, focused, documentState }) => {
    hasFocus.mockReturnValue(focused);
    visibility.mockReturnValue(documentState);
    presentAttention(intent({ isTargetVisible: () => visible }));
    vi.advanceTimersByTime(1000);
    // Quiet only while the user can see the target.
    expect(presentations()).toHaveLength(visible && focused && documentState === 'visible' ? 0 : 1);
  });

  it('waits a second, then shows the notification for as long as its kind deserves', () => {
    const durations: Record<AttentionKind, number> = { needs_input: 8000, failed: 6000, finished: 5000 };
    for (const kind of ['needs_input', 'failed', 'finished'] as const) {
      presentAttention(intent({ key: `node:${kind}`, kind, title: kind }));
    }
    vi.advanceTimersByTime(999);
    expect(presentations()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(presentations().map(({ title, options }) => [title, options.duration])).toEqual(
      Object.entries(durations),
    );
  });

  it('revalidates once the delay is over', () => {
    let current = true;
    let visible = false;
    presentAttention(intent({ key: 'node:answered', isStillCurrent: () => current }));
    presentAttention(intent({ key: 'node:opened', isTargetVisible: () => visible }));
    current = false;
    visible = true;
    vi.advanceTimersByTime(1000);
    expect(presentations()).toEqual([]);
  });

  it('presents when a caller predicate throws rather than lose the notification', () => {
    presentAttention(intent({
      isTargetVisible: () => { throw new Error('gone'); },
      isStillCurrent: () => { throw new Error('gone'); },
    }));
    vi.advanceTimersByTime(1000);
    expect(presentations()).toHaveLength(1);
  });

  it.each([
    ['all', ['needs_input', 'finished', 'failed']],
    ['approval-only', ['needs_input']],
    ['off', []],
  ] as const)('prefs %s let through %j', (level, allowed) => {
    setAttentionPreferences({ level, sounds: true });
    for (const kind of ['needs_input', 'finished', 'failed'] as const) {
      presentAttention(intent({ key: `node:${kind}`, kind, title: kind }));
    }
    vi.advanceTimersByTime(1000);
    expect(presentations().map((item) => item.title)).toEqual(allowed);
  });

  it('"Only when something needs me" reads the reason too: Needs you and a failed task pass, an update or a turn\'s error does not', () => {
    setAttentionPreferences({ level: 'approval-only', sounds: true });
    presentAttention(intent({ key: 'agent:needs-you', kind: 'needs_input', reason: 'needs_you', title: 'needs you' }));
    presentAttention(intent({ key: 'run:failed', kind: 'failed', reason: 'run_failed', title: 'task failed' }));
    presentAttention(intent({ key: 'agent:update', kind: 'finished', reason: 'update', title: 'update' }));
    presentAttention(intent({ key: 'node:error', kind: 'failed', reason: 'error', title: 'turn error' }));
    vi.advanceTimersByTime(1000);
    expect(presentations().map((item) => item.title)).toEqual(['needs you', 'task failed']);
  });

  it('applies the prefs in force when the notification is due', () => {
    presentAttention(intent({ kind: 'finished' }));
    setAttentionPreferences({ level: 'off', sounds: true });
    vi.advanceTimersByTime(1000);
    expect(presentations()).toEqual([]);
  });
});

describe('one notification per target', () => {
  it('lets a newer intent replace a pending one', () => {
    presentAttention(intent({ title: 'Tool approval needed' }));
    vi.advanceTimersByTime(600);
    presentAttention(intent({ kind: 'finished', title: 'Done' }));
    vi.advanceTimersByTime(600);
    expect(presentations()).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(presentations().map((item) => item.title)).toEqual(['Done']);
  });

  it('replaces a shown toast: the same kind refreshes quietly, a new kind alerts again', () => {
    presentAttention(intent({ body: 'Which database?' }));
    vi.advanceTimersByTime(1000);
    expect(playAttentionSound).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    presentAttention(intent({ body: 'Which table?' }));
    vi.advanceTimersByTime(1000);
    expect(toastMock.dismiss).toHaveBeenCalledWith('attention:1');
    expect(playAttentionSound).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    presentAttention(intent({ kind: 'finished', title: 'Done' }));
    vi.advanceTimersByTime(1000);
    expect(toastMock.dismiss).toHaveBeenCalledWith('attention:2');
    expect(vi.mocked(playAttentionSound).mock.calls).toEqual([['needs_input'], ['finished']]);
    expect(presentations().map((item) => item.options.id)).toEqual(['attention:1', 'attention:2', 'attention:3']);
  });

  it('alerts again for the same kind once the earlier toast has gone', () => {
    presentAttention(intent());
    vi.advanceTimersByTime(1000);
    presentations()[0]!.options.onAutoClose!();
    vi.advanceTimersByTime(2000);
    presentAttention(intent({ body: 'Which table?' }));
    vi.advanceTimersByTime(1000);
    expect(playAttentionSound).toHaveBeenCalledTimes(2);
    expect(toastMock.dismiss).not.toHaveBeenCalled();
  });

  it('withdraws the shown one even when the newer intent is not shown', () => {
    presentAttention(intent());
    vi.advanceTimersByTime(1000);
    presentAttention(intent({ kind: 'finished', isTargetVisible: () => true }));
    expect(toastMock.dismiss).toHaveBeenCalledWith('attention:1');
    vi.advanceTimersByTime(1000);
    expect(presentations()).toHaveLength(1);
  });

  it('keeps at most four toasts, dismissing the oldest', () => {
    for (let index = 1; index <= 5; index += 1) presentAttention(intent({ key: `node:${index}`, title: `${index}` }));
    vi.advanceTimersByTime(1000);
    expect(presentations()).toHaveLength(5);
    expect(toastMock.dismiss.mock.calls).toEqual([['attention:1']]);
  });

  it('bounds the queue of pending notifications, dropping the oldest', () => {
    for (let index = 1; index <= 17; index += 1) presentAttention(intent({ key: `node:${index}`, title: `${index}` }));
    vi.advanceTimersByTime(1000);
    const titles = presentations().map((item) => item.title);
    expect(titles).toHaveLength(16);
    expect(titles).not.toContain('1');
  });

  it('dismisses a pending or shown notification, or only one of the given kind', () => {
    presentAttention(intent({ key: 'node:pending' }));
    dismissAttention('node:pending');
    presentAttention(intent({ key: 'node:shown' }));
    vi.advanceTimersByTime(1000);
    expect(presentations().map((item) => item.options.id)).toEqual(['attention:1']);
    dismissAttention('node:shown', 'finished');
    expect(toastMock.dismiss).not.toHaveBeenCalled();
    dismissAttention('node:shown', 'needs_input');
    expect(toastMock.dismiss).toHaveBeenCalledWith('attention:1');
  });

  it('normalizes node targets to this window, and keeps runs on their backend', () => {
    expect(attentionTargetKey({ type: 'node', nodeId: 'n1' })).toBe('node:n1');
    expect(attentionTargetKey({ type: 'node', nodeId: 'n1', backendConnectionId: 'box' }))
      .toBe(attentionTargetKey({ type: 'node', nodeId: 'remote:box:n1', backendConnectionId: 'box' }));
    expect(attentionTargetKey({ type: 'agent_run', runId: 'r1', backendConnectionId: 'box' }))
      .not.toBe(attentionTargetKey({ type: 'agent_run', runId: 'r1' }));
  });

  it('keys Michi\'s records by their slot and a scheduled run by its run, each on its backend', () => {
    const chat = { type: 'agent' as const, ref: 'chat', open: { kind: 'companion' as const, tab: 'chat' as const } };
    // The slot, not where it opens.
    expect(attentionTargetKey(chat)).toBe(attentionTargetKey({ ...chat, open: { kind: 'companion', tab: 'today' } }));
    expect(attentionTargetKey(chat)).not.toBe(attentionTargetKey({ ...chat, ref: 'item:cmi-1' }));
    expect(attentionTargetKey(chat)).not.toBe(attentionTargetKey({ ...chat, backendConnectionId: 'box' }));
    const run = { type: 'scheduled_run' as const, runId: 'run-1', jobId: 'job-1', nodeId: null };
    expect(attentionTargetKey(run)).toBe(attentionTargetKey({ ...run, nodeId: 'n-1' }));
    expect(attentionTargetKey(run)).not.toBe(attentionTargetKey({ type: 'agent_run', runId: 'run-1' }));
  });
});

describe('OS notifications', () => {
  it('goes out only while the window is unfocused or hidden, muted for the in-app tone', () => {
    presentAttention(intent({ key: 'node:focused' }));
    vi.advanceTimersByTime(1000);
    expect(electron.showNotification).not.toHaveBeenCalled();

    hasFocus.mockReturnValue(false);
    presentAttention(intent({ key: 'node:unfocused', title: 'Unfocused' }));
    vi.advanceTimersByTime(1000);
    hasFocus.mockReturnValue(true);
    visibility.mockReturnValue('hidden');
    presentAttention(intent({ key: 'node:hidden', title: 'Hidden' }));
    vi.advanceTimersByTime(1000);
    expect(electron.showNotification.mock.calls).toEqual([
      ['Unfocused', 'Which database?', { key: 'node:unfocused', silent: true }],
      ['Hidden', 'Which database?', { key: 'node:hidden', silent: true }],
    ]);
  });

  it('lets the OS notification make the sound when this window cannot play its tone', () => {
    hasFocus.mockReturnValue(false);
    vi.mocked(playAttentionSound).mockReturnValue(false);
    presentAttention(intent({ key: 'node:blocked', title: 'Blocked' }));
    vi.advanceTimersByTime(1000);
    setAttentionPreferences({ level: 'all', sounds: false });
    vi.advanceTimersByTime(1000);
    presentAttention(intent({ key: 'node:off', title: 'Off' }));
    vi.advanceTimersByTime(1000);
    expect(electron.showNotification.mock.calls).toEqual([
      ['Blocked', 'Which database?', { key: 'node:blocked' }],
      // Sounds turned off: silent either way.
      ['Off', 'Which database?', { key: 'node:off', silent: true }],
    ]);
  });

  it('stays in the app when another window claimed it, or it already went out for this toast', () => {
    hasFocus.mockReturnValue(false);
    presentAttention(intent({ key: 'node:claimed', osNotification: 'never' }));
    presentAttention(intent({ key: 'node:repeat' }));
    vi.advanceTimersByTime(1000);
    presentAttention(intent({ key: 'node:repeat', body: 'Which table?' }));
    vi.advanceTimersByTime(1000);
    expect(presentations()).toHaveLength(3);
    expect(electron.showNotification.mock.calls.map((call) => call[2].key)).toEqual(['node:repeat']);
  });

  it('skips the toast a standing notice already shows, still chiming and notifying the OS', () => {
    hasFocus.mockReturnValue(false);
    presentAttention(intent({ key: 'node:asked', title: 'Asked', showToast: () => false }));
    vi.advanceTimersByTime(1000);
    expect(presentations()).toHaveLength(0);
    expect(playAttentionSound).toHaveBeenCalledWith('needs_input');
    expect(electron.showNotification.mock.calls).toEqual([['Asked', 'Which database?', { key: 'node:asked', silent: true }]]);
  });

  it('keeps the server copy’s claim when the same event also comes from this window', () => {
    hasFocus.mockReturnValue(false);
    presentAttention(intent({ source: 'server', osNotification: 'never' }));
    presentAttention(intent({ source: 'local' }));
    vi.advanceTimersByTime(1000);
    expect(presentations()).toHaveLength(1);
    expect(electron.showNotification).not.toHaveBeenCalled();
  });

  it('routes a desktop click back to the target, once and only while fresh', () => {
    hasFocus.mockReturnValue(false);
    const onOpen = vi.fn();
    presentAttention(intent({ onOpen }));
    vi.advanceTimersByTime(1000);
    expect(electron.onAttentionNotificationClick).toHaveBeenCalledTimes(1);
    clickListener!('node:unknown');
    expect(onOpen).not.toHaveBeenCalled();
    clickListener!('node:n1');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(toastMock.dismiss).toHaveBeenCalledWith('attention:1');
    clickListener!('node:n1');
    expect(onOpen).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    presentAttention(intent({ key: 'node:late', onOpen: late }));
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(31 * 60_000);
    clickListener!('node:late');
    expect(late).not.toHaveBeenCalled();
  });

  it('uses a browser notification without Electron, tagged by target', () => {
    delete window.electron;
    const created: Array<{ title: string; options: NotificationOptions; onclick: (() => void) | null; close: () => void }> = [];
    vi.stubGlobal('Notification', Object.assign(function FakeNotification(this: (typeof created)[number], title: string, options: NotificationOptions) {
      Object.assign(this, { title, options, onclick: null, close: vi.fn() });
      created.push(this);
    }, { permission: 'granted' }));
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const onOpen = vi.fn();
    hasFocus.mockReturnValue(false);
    presentAttention(intent({ onOpen }));
    vi.advanceTimersByTime(1000);
    expect(created.map(({ title, options }) => [title, options])).toEqual([
      ['Agent needs your input', { body: 'Which database?', tag: 'node:n1', renotify: true, silent: true }],
    ]);
    created[0]!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('sounds and the toast card', () => {
  it('chimes per kind only when shown, at most once per burst, and not when turned off', () => {
    presentAttention(intent({ key: 'node:a' }));
    presentAttention(intent({ key: 'node:b', kind: 'finished' }));
    presentAttention(intent({ key: 'node:seen', isTargetVisible: () => true }));
    vi.advanceTimersByTime(1000);
    expect(vi.mocked(playAttentionSound).mock.calls).toEqual([['needs_input']]);

    vi.advanceTimersByTime(1000);
    presentAttention(intent({ key: 'node:c', kind: 'finished' }));
    vi.advanceTimersByTime(1000);
    expect(vi.mocked(playAttentionSound).mock.calls).toEqual([['needs_input'], ['finished']]);

    setAttentionPreferences({ level: 'all', sounds: false });
    vi.advanceTimersByTime(1000);
    presentAttention(intent({ key: 'node:d', kind: 'failed' }));
    vi.advanceTimersByTime(1000);
    expect(playAttentionSound).toHaveBeenCalledTimes(2);
    expect(presentations()).toHaveLength(4);
  });

  it('opens the target from a click or Enter on the card, and plain text has no button', () => {
    const onOpen = vi.fn();
    presentAttention(intent({ onOpen }));
    presentAttention(intent({ key: 'node:plain', kind: 'finished', title: 'Plain', onOpen: undefined }));
    vi.advanceTimersByTime(1000);
    expect(toastMock.mock.calls).toEqual([['Plain', expect.objectContaining({ id: 'attention:2', duration: 5000 })]]);

    const { unmount } = render(presentations().find((item) => item.card)!.card!);
    const card = screen.getByRole('button');
    expect(card.getAttribute('data-attention-kind')).toBe('needs_input');
    fireEvent.click(card);
    expect(toastMock.dismiss).toHaveBeenCalledWith('toast-id');
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
    unmount();
  });
});
