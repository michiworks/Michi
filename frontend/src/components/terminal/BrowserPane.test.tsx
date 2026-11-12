import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserShellChord } from 'michi-shared';
import type { BrowserSurfaceState } from '../../lib/electronBridge';
import BrowserPane from './BrowserPane';

const closePane = vi.fn();
const focusPane = vi.fn();
const setFocusedNodeId = vi.fn();
const updatePaneItem = vi.fn();
const browserCreate = vi.fn();
const browserSetBounds = vi.fn();
let closeRequest: ((surfaceId: string) => void) | undefined;
let shortcut: ((surfaceId: string, chord: BrowserShellChord) => void) | undefined;
let resolveBrowserCreate: ((state: BrowserSurfaceState) => void) | undefined;

const createdState: BrowserSurfaceState = {
  surfaceId: 'surface-browser-1',
  url: 'https://www.google.com/',
  title: 'Google',
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

const electronBridge = {
  browserCreate,
  browserSetBounds,
  onBrowserState: vi.fn(() => vi.fn()),
  onBrowserFocus: vi.fn(() => vi.fn()),
  onBrowserCloseRequest: vi.fn((handler: (surfaceId: string) => void) => {
    closeRequest = handler;
    return vi.fn();
  }),
  onBrowserShortcut: vi.fn((handler: (surfaceId: string, chord: BrowserShellChord) => void) => {
    shortcut = handler;
    return vi.fn();
  }),
};

vi.mock('../../state/chatStore', () => ({
  useChatActions: () => ({
    closePane,
    focusPane,
    setFocusedNodeId,
    updatePaneItem,
  }),
}));

// Report the unfocused dim so tests can verify the browser chrome opts out.
const paneShellOptions = vi.hoisted(() => [] as Array<{ dim?: boolean } | undefined>);
vi.mock('../../hooks/usePaneShellStyle', () => ({
  usePaneShellStyle: (_id: string, options?: { dim?: boolean }) => {
    paneShellOptions.push(options);
    return { '--pane-dim': options?.dim === false ? 0 : 0.24 };
  },
}));

vi.mock('../../lib/electronBridge', () => ({
  getElectron: () => electronBridge,
}));

const item = {
  id: 'pane-browser-1',
  kind: 'browser' as const,
  projectId: 'project-1',
  treeId: 'tree-1',
  createdAt: 1,
  surfaceId: 'surface-browser-1',
  url: 'https://www.google.com/',
  title: 'Browser',
};

describe('BrowserPane native bridge', () => {
  beforeEach(() => {
    closePane.mockReset();
    browserSetBounds.mockReset();
    browserCreate.mockReset();
    browserCreate.mockImplementation(() => new Promise<BrowserSurfaceState>((resolve) => {
      resolveBrowserCreate = resolve;
    }));
    closeRequest = undefined;
    resolveBrowserCreate = undefined;
  });

  afterEach(() => vi.unstubAllGlobals());

  it('styles the address field as the shared input, so keyboard focus shows its ring', () => {
    const { getByRole } = render(<BrowserPane item={item} />);
    const address = getByRole('textbox', { name: 'Browser address' });
    expect(address.className).toBe('ui-input');
    expect(address.style.outline).toBe('');
  });

  it('never takes the unfocused dim: the native page cannot share it', () => {
    paneShellOptions.length = 0;
    const { container } = render(<BrowserPane item={item} />);
    expect(paneShellOptions.every((options) => options?.dim === false)).toBe(true);
    const root = container.querySelector('[data-pane-kind="browser"]') as HTMLElement;
    expect(root.style.getPropertyValue('--pane-dim')).toBe('0');
  });

  it('closes only the pane that owns the requested native surface', () => {
    render(<BrowserPane item={item} />);
    expect(closeRequest).toBeTypeOf('function');

    act(() => closeRequest?.('another-surface'));
    expect(closePane).not.toHaveBeenCalled();

    act(() => closeRequest?.('surface-browser-1'));
    expect(closePane).toHaveBeenCalledOnce();
    expect(closePane).toHaveBeenCalledWith('pane-browser-1');
  });

  it('replays a shell chord its own surface passed on as a keydown for the shell', () => {
    const keys: KeyboardEvent[] = [];
    const listen = (event: KeyboardEvent) => { keys.push(event); };
    window.addEventListener('keydown', listen);
    try {
      render(<BrowserPane item={item} />);
      const chord = { key: 'Tab', meta: false, control: true, shift: true, alt: false };
      act(() => shortcut?.('another-surface', chord));
      expect(keys).toHaveLength(0);
      act(() => shortcut?.('surface-browser-1', chord));
      expect(keys.map((e) => [e.key, e.metaKey, e.ctrlKey, e.shiftKey, e.altKey])).toEqual([['Tab', false, true, true, false]]);
    } finally {
      window.removeEventListener('keydown', listen);
    }
  });

  it('publishes bounds as soon as the viewport resizes, so a dock drag does not lag a frame', () => {
    let resized: ResizeObserverCallback | undefined;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resized = callback; }
      observe() {}
      disconnect() {}
    });
    // Frames never run, so any bounds published below came from the observer itself.
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    render(<BrowserPane item={item} />);
    browserSetBounds.mockClear();
    act(() => resized?.([], {} as ResizeObserver));
    expect(browserSetBounds).toHaveBeenCalledWith('surface-browser-1', expect.any(Object), expect.any(Boolean));
  });

  it('republishes the current viewport bounds after native surface creation', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { container, rerender } = render(<BrowserPane item={item} />);
    const viewport = container.querySelector('[data-pane-kind="browser"] > div:last-child');
    expect(viewport).toBeInstanceOf(HTMLElement);
    vi.spyOn(viewport as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      x: 420,
      y: 160,
      top: 160,
      left: 420,
      right: 1020,
      bottom: 660,
      width: 600,
      height: 500,
      toJSON: () => ({}),
    });

    act(() => frames.shift()?.(0));
    browserSetBounds.mockClear();

    await act(async () => {
      resolveBrowserCreate?.(createdState);
      await Promise.resolve();
    });

    // After creation resolves, publishBounds fires synchronously and then on
    // subsequent rAF ticks.  The synchronous call uses visible=true because
    // creationDoneRef is now true.
    expect(browserSetBounds).toHaveBeenCalledWith('surface-browser-1', {
      x: 420,
      y: 160,
      width: 600,
      height: 500,
    }, true);

    browserSetBounds.mockClear();
    act(() => frames.shift()?.(16));
    // Additional rAF publishes continue to emit correct bounds.
    expect(browserSetBounds).toHaveBeenCalledWith('surface-browser-1', {
      x: 420,
      y: 160,
      width: 600,
      height: 500,
    }, true);
    rerender(<BrowserPane item={item} active={false} />);
    expect(browserSetBounds.mock.calls.at(-1)?.[2]).toBe(false);
    rerender(<BrowserPane item={item} active />);
    expect(browserSetBounds.mock.calls.at(-1)?.[2]).toBe(true);
    expect(browserCreate).toHaveBeenCalledTimes(1);

    // A creation/resize must not reveal web contents over an open modal.
    document.documentElement.dataset.nativeSurfacesVisible = 'false';
    rerender(<BrowserPane item={item} active={false} />);
    rerender(<BrowserPane item={item} active />);
    expect(browserSetBounds.mock.calls.at(-1)?.[2]).toBe(false);
    delete document.documentElement.dataset.nativeSurfacesVisible;

    // Fail closed if native content escapes its allocated dock.
    container.setAttribute('data-browser-dock', '');
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 500, top: 0, right: 1020, bottom: 700,
    } as DOMRect);
    rerender(<BrowserPane item={item} active={false} />);
    rerender(<BrowserPane item={item} active />);
    expect(browserSetBounds.mock.calls.at(-1)?.[2]).toBe(false);

  });
});
