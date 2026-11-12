import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalSidebar from './Sidebar';
import TerminalTopbar from './Topbar';
import { AREA_RAIL_WIDTH } from './rail/AreaRail';
import { ChatProvider } from '../../state/chatStore';
import { PrefsProvider, usePrefs } from '../../state/prefs';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    fetchPrefs: vi.fn().mockResolvedValue(null),
    savePrefs: vi.fn(),
    checkVersion: vi.fn().mockResolvedValue({ updateAvailable: false }),
    listAgentModes: vi.fn().mockResolvedValue({ availableModes: [], defaultModeId: null }),
  };
});
vi.mock('../../lib/electronBridge', () => ({ getElectron: () => null }));

function SavedWidth() {
  return <output data-testid="saved-width">{usePrefs().prefs.terminalSidebarWidth}</output>;
}

beforeEach(() => { localStorage.clear(); });
afterEach(cleanup);

describe('sidebar drag-resize', () => {
  it('follows the pointer without a pref write or a root restyle per frame, and saves the width on release', async () => {
    const { container } = render(
      <PrefsProvider>
        <ChatProvider>
          <TerminalTopbar page="dashboard" onNav={() => {}} sidebarCollapsed={false} onToggleSidebar={() => {}}
            navigation={{ canBack: false, canForward: false, onBack: () => {}, onForward: () => {} }} />
          <TerminalSidebar activePage="dashboard" onNav={() => {}} />
          <SavedWidth />
        </ChatProvider>
      </PrefsProvider>,
    );
    const rootWidth = () => document.documentElement.style.getPropertyValue('--term-sidebar-width');
    const spacer = container.querySelector<HTMLElement>('.terminal-topbar-sidebar-spacer')!;
    const aside = container.querySelector<HTMLElement>('aside.terminal-sidebar')!;
    const before = rootWidth();
    expect(before).toBe(`${252 + AREA_RAIL_WIDTH}px`);

    // jsdom has no layout or PointerEvent; a MouseEvent carries the pointer's x.
    aside.getBoundingClientRect = () => ({ width: 252 } as DOMRect);
    const handle = screen.getByTitle('Drag to resize · Double-click to reset');
    handle.setPointerCapture = vi.fn();
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 300 }));
    for (const x of [320, 340, 360]) {
      await act(async () => {
        handle.dispatchEvent(new MouseEvent('pointermove', { clientX: x }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    }

    expect(aside.style.width).toBe('312px');
    expect(spacer.style.getPropertyValue('--term-sidebar-width')).toBe(`${312 + AREA_RAIL_WIDTH}px`);
    expect(screen.getByTestId('saved-width').textContent).toBe('252');
    expect(rootWidth()).toBe(before);

    act(() => { handle.dispatchEvent(new MouseEvent('pointerup', { clientX: 360 })); });

    expect(screen.getByTestId('saved-width').textContent).toBe('312');
    expect(rootWidth()).toBe(`${312 + AREA_RAIL_WIDTH}px`);
    expect(spacer.style.getPropertyValue('--term-sidebar-width')).toBe('');
    expect(aside.style.width).toBe('312px');
  });
});
