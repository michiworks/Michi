import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserLauncher from './BrowserLauncher';

const state = vi.hoisted(() => ({
  openBrowserPane: vi.fn(() => 'web'), setPaneWidth: vi.fn(), focusPane: vi.fn(),
  panes: { openPanes: ['chat'], focusedPane: 'chat', paneItems: {} as Record<string, { kind: string }> },
}));
vi.mock('../../state/chatStore', () => ({ useChatPanes: () => state.panes, useChatActions: () => state }));
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: { defaultPaneWidth: 600 } }) }));

beforeEach(() => {
  vi.clearAllMocks();
  state.panes.openPanes = ['chat'];
  state.panes.paneItems = {};
  vi.stubGlobal('electron', { browserCreate: vi.fn() });
});

afterEach(() => vi.unstubAllGlobals());

function setup(width: number) {
  const result = render(<div className="terminal-shell"><BrowserLauncher /><div className="terminal-dashboard"><div data-node-id="chat" /></div></div>);
  const strip = result.container.querySelector('.terminal-dashboard')!;
  vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ width: 1000 } as DOMRect);
  vi.spyOn(strip.firstElementChild!, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect);
  return result;
}

describe('BrowserLauncher', () => {
  it('copies a custom pane width instead of using a fixed browser width', () => {
    const { container } = setup(340);
    container.querySelector('.terminal-dashboard')!.appendChild(document.createElement('div')).setAttribute('data-node-id', 'another');
    fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
    expect(state.setPaneWidth.mock.calls).toEqual([['chat', 340], ['web', 340]]);
  });

  it('focuses an existing browser without creating another pane or changing widths', () => {
    state.panes.openPanes = ['chat', 'web'];
    state.panes.paneItems = { web: { kind: 'browser' } };
    setup(340);
    fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
    expect(state.focusPane).toHaveBeenCalledWith('web');
    expect(state.openBrowserPane).not.toHaveBeenCalled();
    expect(state.setPaneWidth).not.toHaveBeenCalled();
  });

  it('is absent outside the desktop app, where no native browser surface exists', () => {
    vi.stubGlobal('electron', undefined);
    setup(340);
    expect(screen.queryByRole('button', { name: 'Browser' })).toBeNull();
  });
});
