import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatNotificationLevel } from 'michi-shared';
import type { ChatNotificationLevelWrite } from '../services/api/prefs';
import { PrefsProvider, noteNotificationLevelChanged, usePrefs } from './prefs';

// DESIGN-v2 §5.2 (W3: F3 → H): the renderer tells the backend its chat notification level at
// start and on every change, so the backend can notify by it while no Michi window is open.
// The PUT is services/api/prefs putChatNotificationLevel (W3-F3-review #2), mocked here: a
// provider that sent it some other way would send nothing these tests can see.

const api = vi.hoisted(() => ({
  fetchPrefs: vi.fn(),
  savePrefs: vi.fn(),
  putChatNotificationLevel: vi.fn<(level: ChatNotificationLevel) => Promise<ChatNotificationLevelWrite>>(),
}));
vi.mock('../services/api', () => ({ fetchPrefs: api.fetchPrefs, savePrefs: api.savePrefs }));
vi.mock('../services/api/prefs', () => ({ savePermissionSettings: vi.fn(), putChatNotificationLevel: api.putChatNotificationLevel }));

function Probe() {
  const { prefs, setPref } = usePrefs();
  return (
    <>
      <output>{prefs.notifications}</output>
      <button onClick={() => setPref('notifications', 'off')}>Off</button>
      <button onClick={() => setPref('notifications', 'approval-only')}>Approvals</button>
    </>
  );
}

/** The levels PUT to the backend, in order. */
const sent = () => api.putChatNotificationLevel.mock.calls.map(([level]) => level);
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const withLocalLevel = (level: string) => localStorage.setItem('michi:v1:prefs', JSON.stringify({ notifications: level }));
/** Mounts the provider and lets /prefs answer (its first PUT waits for that). */
async function mount() {
  const view = render(<PrefsProvider><Probe /></PrefsProvider>);
  await advance(0);
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  api.fetchPrefs.mockReset().mockResolvedValue(null);
  api.savePrefs.mockReset().mockResolvedValue(undefined);
  api.putChatNotificationLevel.mockReset().mockResolvedValue('saved');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('sends the level this device starts with, once /prefs answered and it settled', async () => {
  withLocalLevel('approval-only');
  render(<PrefsProvider><Probe /></PrefsProvider>);
  await advance(0);
  expect(sent()).toEqual([]);
  await advance(500);
  expect(sent()).toEqual(['approval-only']);
});

it('waits for /prefs before the first PUT, and sends the level it brought to a window with none of its own (W3-F3-review #3)', async () => {
  let answer!: (prefs: Record<string, unknown> | null) => void;
  api.fetchPrefs.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
  render(<PrefsProvider><Probe /></PrefsProvider>);
  await advance(5_000);
  expect(sent()).toEqual([]);
  await act(async () => { answer({ notifications: 'off' }); });
  await advance(500);
  expect(screen.getByRole('status').textContent).toBe('off');
  expect(sent()).toEqual(['off']);
});

it('does not send its default when /prefs failed in a window with no level of its own, only what the user picks (W3-F3-review #3)', async () => {
  render(<PrefsProvider><Probe /></PrefsProvider>);
  await advance(5_000);
  expect(sent()).toEqual([]);
  fireEvent.click(screen.getByText('Approvals'));
  await advance(500);
  expect(sent()).toEqual(['approval-only']);
});

it('sends every change, the last of a quick run of them only', async () => {
  withLocalLevel('all');
  await mount();
  await advance(500);
  expect(sent()).toEqual(['all']);
  fireEvent.click(screen.getByText('Off'));
  await advance(100);
  fireEvent.click(screen.getByText('Approvals'));
  await advance(500);
  expect(sent()).toEqual(['all', 'approval-only']);
});

it('never lets a slow write land after a newer one: writes go one at a time, the newest last', async () => {
  withLocalLevel('all');
  let finishFirst!: () => void;
  api.putChatNotificationLevel.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = () => resolve('saved'); }));
  await mount();
  await advance(500);
  fireEvent.click(screen.getByText('Off'));
  await advance(500);
  // 'off' waits for 'all' to finish.
  expect(sent()).toEqual(['all']);
  await act(async () => { finishFirst(); await vi.advanceTimersByTimeAsync(0); });
  expect(sent()).toEqual(['all', 'off']);
});

it('tries a write that did not get through again on its own, waiting longer each time, until it does (W3-F3-review #3)', async () => {
  withLocalLevel('off');
  api.putChatNotificationLevel.mockResolvedValueOnce('failed').mockResolvedValueOnce('failed');
  await mount();
  await advance(500);
  expect(sent()).toEqual(['off']);
  await advance(1_999);
  expect(sent()).toHaveLength(1);
  await advance(1);
  expect(sent()).toHaveLength(2);
  // The second failure waits twice as long.
  await advance(3_999);
  expect(sent()).toHaveLength(2);
  await advance(1);
  expect(sent()).toEqual(['off', 'off', 'off']);
  // It got through: nothing more.
  await advance(120_000);
  expect(sent()).toHaveLength(3);
});

it('tries again at once when the window is focused, and leaves no timer behind once unmounted', async () => {
  withLocalLevel('off');
  api.putChatNotificationLevel.mockResolvedValue('failed');
  const view = await mount();
  await advance(500);
  expect(sent()).toHaveLength(1);
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); });
  expect(sent()).toHaveLength(2);
  view.unmount();
  await advance(10 * 60_000);
  expect(sent()).toHaveLength(2);
});

it('does not keep asking a backend that has no such route or refused the body', async () => {
  withLocalLevel('off');
  api.putChatNotificationLevel.mockResolvedValue('unsupported');
  await mount();
  await advance(500);
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(120_000); });
  expect(sent()).toHaveLength(1);
});

it('takes the level Michi set on the backend when told, and on focus; a change made here and not saved yet wins', async () => {
  api.fetchPrefs.mockResolvedValue({ notifications: 'all' });
  await mount();
  await advance(500);
  api.fetchPrefs.mockResolvedValue({ notifications: 'off' });
  await act(async () => { noteNotificationLevelChanged(); });
  expect(screen.getByRole('status').textContent).toBe('off');
  await advance(1_000);
  expect(api.savePrefs).not.toHaveBeenCalled();
  api.fetchPrefs.mockResolvedValue({ notifications: 'approval-only' });
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(screen.getByRole('status').textContent).toBe('approval-only');
  // Picked here, then the backend answers with an older change: the user's pick stays and is saved.
  fireEvent.click(screen.getByText('Off'));
  api.fetchPrefs.mockResolvedValue({ notifications: 'all' });
  await act(async () => { noteNotificationLevelChanged(); });
  expect(screen.getByRole('status').textContent).toBe('off');
  await advance(500);
  expect(api.savePrefs).toHaveBeenLastCalledWith({ notifications: 'off' });
});

it('sends nothing for a stored level that is not one', async () => {
  withLocalLevel('loud');
  render(<PrefsProvider><Probe /></PrefsProvider>);
  await advance(5_000);
  expect(sent()).toEqual([]);
});
