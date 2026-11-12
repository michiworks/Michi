/**
 * The notices the backend's gate sends over GET /companion/events, end to
 * end through this window: the API's frame parsing, the change feed and the
 * toasts. A browser shows each once; the desktop app never shows them, since
 * Electron main has already shown each one as a toast or a banner (no notice
 * appears twice).
 */
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionNotice } from 'michi-shared';
import { resetCompanionFeedForTests } from '../../../state/companion/companionFeed';
import { getCompanionPanelState, resetCompanionPanelForTests } from '../../../state/companion/companionPanel';
import { resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import { companionSnapshotDto, jsonResponse } from '../../../test/companionFixtures';
import { CompanionNotifications, resetCompanionNotificationsForTests } from './CompanionNotifications';

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  electron: null as null | Record<string, unknown>,
  fetchStream: vi.fn(),
}));
vi.mock('../../../services/notifications', () => ({ notify: mocks.notify }));
vi.mock('../../../lib/electronBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/electronBridge')>()),
  getElectron: () => mocks.electron,
}));
vi.mock('../../../services/api/streamTransport', () => ({ fetchStream: mocks.fetchStream }));
vi.mock('../../../state/companion/companionPresence', () => ({ startCompanionPresence: () => () => {} }));
vi.mock('../../../state/chatStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/chatStore')>()),
  useChatActions: () => ({ revealBackendNode: vi.fn(async () => true) }),
}));

/** The change feed as the backend streams it: frames go out when the test sends them. */
function feed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(stream) { controller = stream; } });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    send: (event: string, data: unknown) => controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
  };
}

const notice: CompanionNotice = {
  id: 'cmn-1', title: 'Companion', body: 'CR-9 needs attention — 1 unresolved comment',
  target: { kind: 'companion', tab: 'today', itemId: 'cmi-9' }, itemIds: ['cmi-9'], createdAt: 1, expiresAt: Date.now() + 60_000,
};

let fetchMock: ReturnType<typeof vi.fn>;
let hasFocus: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mocks.notify.mockReset();
  // Each test counts its own feed connection (the previous test's must not stand in for it).
  mocks.fetchStream.mockReset();
  mocks.electron = null;
  resetCompanionFeedForTests();
  resetCompanionStoreForTests();
  resetCompanionPanelForTests();
  resetCompanionNotificationsForTests();
  fetchMock = vi.fn(async () => jsonResponse(companionSnapshotDto()));
  vi.stubGlobal('fetch', fetchMock);
  hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => {
  resetCompanionFeedForTests();
  resetCompanionStoreForTests();
  hasFocus.mockRestore();
  vi.unstubAllGlobals();
});

/** Mounts the notifications, waits for the feed to open, and returns it. */
async function connected() {
  const stream = feed();
  mocks.fetchStream.mockResolvedValue(stream.response);
  const view = render(<CompanionNotifications />);
  await waitFor(() => expect(mocks.fetchStream).toHaveBeenCalledTimes(1));
  expect(String(mocks.fetchStream.mock.calls[0][0])).toMatch(/\/companion\/events$/);
  return { ...stream, view };
}

/** A later frame the store answers with a snapshot read: once it is read, every frame before it was handled. */
async function drained(stream: Awaited<ReturnType<typeof connected>>) {
  const reads = fetchMock.mock.calls.length;
  stream.send('companion_changed', { type: 'companion_changed', revision: 99, reason: 'items' });
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(reads));
}

describe('Companion notices from the change feed', () => {
  it('a browser toasts each once, and its click opens Today at the item', async () => {
    const stream = await connected();
    stream.send('companion_notice', notice);
    stream.send('companion_notice', notice);
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    await drained(stream);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][0]).toMatchObject({ title: 'Companion', body: notice.body });
    act(() => mocks.notify.mock.calls[0][0].onClick());
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'today', focusItem: { id: 'cmi-9' } });
    stream.view.unmount();
  });

  it('the desktop app does not toast them: main already showed each one', async () => {
    let toast: ((value: CompanionNotice) => void) | null = null;
    mocks.electron = {
      initialCompanionTarget: null,
      onCompanionNotice: (handler: (value: CompanionNotice) => void) => { toast = handler; return () => {}; },
      onCompanionOpen: () => () => {},
    };
    const stream = await connected();
    stream.send('companion_notice', notice);
    await drained(stream);
    expect(mocks.notify).not.toHaveBeenCalled();
    // The same notice from main (this window had focus): shown, once.
    act(() => toast!(notice));
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    stream.view.unmount();
  });
});
