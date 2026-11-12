import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BrowserDock from './BrowserDock';
import type { BrowserPaneItem } from '../../state/paneItems';

const closePane = vi.fn();
const focusPane = vi.fn();
const setPaneWidth = vi.fn();
vi.mock('../../state/chatStore', () => ({ useChatActions: () => ({ closePane, focusPane, reorderPane: vi.fn(), setPaneWidth }) }));
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: { focusDim: 20, paneRules: true } }) }));
vi.mock('./BrowserPane', () => ({ default: ({ item, active }: { item: BrowserPaneItem; active: boolean }) => <div data-testid={item.id} data-active={String(active)} /> }));
const items: BrowserPaneItem[] = ['one', 'two'].map(id => ({ id, kind: 'browser', projectId: 'p', treeId: 't', createdAt: 1, surfaceId: id, url: 'https://example.com', title: id }));
const wrapper = ({ children }: { children: React.ReactNode }) => <div className="terminal-shell"><div className="terminal-topbar"><div data-browser-caption-host /></div>{children}</div>;

describe('BrowserDock', () => {
  it('uses the standard caption in the topbar and keeps background pages mounted', () => {
    const { container } = render(<BrowserDock items={items} focusedPane="one" />, { wrapper });
    const caption = screen.getByLabelText('one pane, focused');
    expect(container.querySelector('[data-browser-caption-host]')?.contains(caption)).toBe(true);
    expect(container.querySelector('[data-browser-dock]')?.contains(caption)).toBe(false);
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Browser pages' }), { target: { value: 'two' } });
    expect(focusPane).toHaveBeenCalledWith('two');
    expect(screen.getByTestId('one').getAttribute('data-active')).toBe('false');
    expect(screen.getByTestId('two').getAttribute('data-active')).toBe('true');
  });

  it('keeps the page visible while the dock is being resized', () => {
    render(<BrowserDock items={items} focusedPane="one" />, { wrapper });
    const handle = screen.getByTitle('Drag to resize · Double-click to reset');
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400 });
    expect(screen.getByTestId('one').getAttribute('data-active')).toBe('true');
  });

  it('holds a drag width locally and saves it once on release', async () => {
    setPaneWidth.mockClear();
    const { container } = render(<BrowserDock items={items} focusedPane="one" />, { wrapper });
    const dock = container.querySelector<HTMLElement>('[data-browser-dock]')!;
    dock.getBoundingClientRect = () => ({ width: 600 } as DOMRect);
    Object.defineProperty(dock.parentElement!, 'clientWidth', { configurable: true, value: 1600 });
    const handle = screen.getByTitle('Drag to resize · Double-click to reset');
    handle.setPointerCapture = vi.fn();
    // The handle is on the dock's left edge: moving left widens it.
    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 1000 }));
    for (const x of [990, 980, 970]) {
      await act(async () => {
        handle.dispatchEvent(new MouseEvent('pointermove', { clientX: x }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    }
    expect(dock.getAttribute('style')).toContain('630px');
    expect(setPaneWidth).not.toHaveBeenCalled();
    act(() => { handle.dispatchEvent(new MouseEvent('pointerup', { clientX: 970 })); });
    expect(setPaneWidth).toHaveBeenCalledTimes(1);
    expect(setPaneWidth).toHaveBeenCalledWith('one', 630);
  });

  it('puts the dock width on the topbar, which alone reads it, not on the shell', () => {
    const { container } = render(<BrowserDock items={items} focusedPane="one" />, { wrapper });
    const shell = container.querySelector<HTMLElement>('.terminal-shell')!;
    const topbar = container.querySelector<HTMLElement>('.terminal-topbar')!;
    expect(topbar.style.getPropertyValue('--browser-dock-width')).toBe('0px');
    expect(shell.style.getPropertyValue('--browser-dock-width')).toBe('');
  });

  it('selects a newly converted browser even when its launcher already had focus', () => {
    const { rerender } = render(<BrowserDock items={[items[0]]} focusedPane="two" />, { wrapper });
    rerender(<BrowserDock items={items} focusedPane="two" />);
    expect(screen.getByTestId('two').getAttribute('data-active')).toBe('true');
    fireEvent.mouseEnter(screen.getByLabelText('two pane, focused'));
    fireEvent.click(screen.getByRole('button', { name: 'Close two' }));
    expect(closePane).toHaveBeenCalledWith('two');
    rerender(<BrowserDock items={[items[0]]} focusedPane="one" />);
    expect(screen.getByTestId('one').getAttribute('data-active')).toBe('true');
  });
});
