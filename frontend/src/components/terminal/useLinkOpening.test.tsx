import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLinkOpening } from './useLinkOpening';
import { openPreferredUrl } from '../../services/openUrl';
import { backendEntityId } from '../../config/backendIdentity';
import { markRemoteFirstPaint, resetRemoteFirstPaint } from '../../state/remoteFirstPaint';

const mocks = vi.hoisted(() => ({
  openBrowserPane: vi.fn(), openExternal: vi.fn(), browserCreate: vi.fn(),
  onOpenUrl: vi.fn((_handler: (url: string) => void) => vi.fn()),
  prefs: { linkOpenTarget: 'internal' },
  project: { id: 'p', activeTreeId: 'tree', backendConnectionId: 'local' },
}));
vi.mock('../../state/chatStore', () => ({
  useChatProjects: () => ({ activeProject: mocks.project }),
  useChatActions: () => ({ openBrowserPane: mocks.openBrowserPane }),
}));
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: mocks.prefs }) }));
vi.mock('../../lib/electronBridge', () => ({ getElectron: () => mocks }));
// Stands in for the composer, which prevents navigation and opens on Cmd/Ctrl+click itself.
const surfaceClick = vi.fn((event: React.MouseEvent) => event.preventDefault());
function Harness() {
  useLinkOpening();
  return <><a href="https://example.com/a">Link</a><a href="#section">Anchor</a>
    <div data-handles-links="" onClick={surfaceClick}><a href="https://example.com/c">Composer link</a></div></>;
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.prefs.linkOpenTarget = 'internal';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ request: null }) }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('preferred link opening', () => {
  it('routes anchors, programmatic links and native window opens to internal Browser by default', () => {
    const { getByText } = render(<Harness />);
    fireEvent.click(getByText('Link'));
    act(() => openPreferredUrl('https://example.com/b'));
    const handler = mocks.onOpenUrl.mock.calls[0]?.[0] as unknown as (url: string) => void;
    act(() => handler('http://localhost:8080/'));
    expect(mocks.openBrowserPane.mock.calls).toEqual([['https://example.com/a'], ['https://example.com/b'], ['http://localhost:8080/']]);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
  it('ignores non-web requests and fragment navigation', () => {
    const { getByText } = render(<Harness />);
    fireEvent.click(getByText('Anchor'));
    act(() => openPreferredUrl('javascript:alert(1)'));
    expect(mocks.openBrowserPane).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
  it('leaves links inside a data-handles-links surface to that surface', () => {
    const { getByText } = render(<Harness />);
    const link = getByText('Composer link');
    fireEvent.click(link);
    fireEvent.click(link, { metaKey: true });
    expect(surfaceClick).toHaveBeenCalledTimes(2);
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(mocks.openBrowserPane).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
  it('delivers an agent URL through the same preference', async () => {
    mocks.prefs.linkOpenTarget = 'external';
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ request: { id: 'request', url: 'https://example.com/agent' } }) } as Response);
    await act(async () => { render(<Harness />); });
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/agent');
    expect(mocks.openBrowserPane).not.toHaveBeenCalled();
  });
  it('starts a remote claim poll only after the remote paints', async () => {
    vi.useFakeTimers();
    const original = { ...mocks.project };
    try {
      mocks.project.id = backendEntityId('remote-claim', 'ws');
      mocks.project.backendConnectionId = 'remote-claim';
      await act(async () => { render(<Harness />); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(fetch).not.toHaveBeenCalled();
      await act(async () => { markRemoteFirstPaint('remote-claim'); });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/open-url/claim');
    } finally {
      Object.assign(mocks.project, original);
      resetRemoteFirstPaint();
      vi.useRealTimers();
    }
  });
});
