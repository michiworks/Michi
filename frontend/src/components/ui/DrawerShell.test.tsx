import React from 'react';
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { MotionConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawerShell } from './DrawerShell';
import { useBackSwipe } from '../../hooks/useBackNavigation';
import { backTarget } from '../../lib/backStack';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function finishTransform(target: HTMLElement) {
  const event = createEvent.transitionEnd(target);
  Object.defineProperty(event, 'propertyName', { value: 'transform' });
  fireEvent(target, event);
}

describe('DrawerShell presence', () => {
  it('retains a closed panel until its own transform finishes, then releases native surfaces', () => {
    const presence = vi.fn();
    const drawer = (open: boolean) => <React.StrictMode><DrawerShell open={open} onClose={vi.fn()} title="Settings" onPresenceChange={presence}><span>Content</span></DrawerShell></React.StrictMode>;
    const view = render(drawer(true));
    const panel = screen.getByRole('dialog');
    expect(presence).toHaveBeenLastCalledWith(true);
    view.rerender(drawer(false));
    expect(panel.isConnected).toBe(true);
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(presence).toHaveBeenLastCalledWith(true);
    finishTransform(screen.getByText('Content'));
    expect(panel.isConnected).toBe(true);
    finishTransform(panel);
    expect(panel.isConnected).toBe(false);
    expect(presence).toHaveBeenLastCalledWith(false);
  });

  it('keeps the closing scrim click-through while it fades with the panel', () => {
    const close = vi.fn();
    const drawer = (open: boolean) => <DrawerShell open={open} onClose={close} title="Settings">Content</DrawerShell>;
    const view = render(drawer(true));
    const scrim = document.querySelector('.drawer-shell-scrim') as HTMLElement;
    view.rerender(drawer(false));
    expect(scrim.isConnected).toBe(true);
    expect(scrim.getAttribute('data-state')).toBe('closed');
    fireEvent.mouseDown(scrim);
    expect(close).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(500));
    expect(scrim.isConnected).toBe(false);
  });

  it('closes on the spot when the in-app Reduce motion preference is on', () => {
    const presence = vi.fn();
    const drawer = (open: boolean) => <MotionConfig reducedMotion="always"><DrawerShell open={open} onClose={vi.fn()} title="Artifacts" onPresenceChange={presence}>Content</DrawerShell></MotionConfig>;
    const view = render(drawer(true));
    expect(screen.getByRole('dialog').getAttribute('data-motion')).toBe('instant');
    view.rerender(drawer(false));
    expect(document.querySelector('.drawer-shell-panel')).toBeNull();
    expect(presence).toHaveBeenLastCalledWith(false);
  });

  it('cancels stale exit timers when reopened', () => {
    const drawer = (open: boolean) => <DrawerShell open={open} onClose={vi.fn()} title="Artifacts">Content</DrawerShell>;
    const view = render(drawer(true));
    view.rerender(drawer(false));
    act(() => vi.advanceTimersByTime(100));
    view.rerender(drawer(true));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('dialog').getAttribute('data-state')).toBe('open');
    view.rerender(drawer(false));
    act(() => vi.advanceTimersByTime(500));
    expect(document.querySelector('.drawer-shell-panel')).toBeNull();
  });
});

describe('DrawerShell non-modal', () => {
  it('leaves the page usable: no scrim, no aria-modal, no outside-click close', () => {
    const close = vi.fn();
    render(
      <>
        <button type="button">Page card</button>
        <DrawerShell open modal={false} onClose={close} title="Thread">Content</DrawerShell>
      </>,
    );
    const panel = screen.getByRole('dialog', { name: 'Thread' });
    expect(panel.hasAttribute('aria-modal')).toBe(false);
    expect(document.querySelector('.drawer-shell-scrim')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Page card' }));
    expect(close).not.toHaveBeenCalled();
  });

  it('takes focus on open and returns it on close to where the user last was on the page', () => {
    const drawer = (open: boolean) => (
      <>
        <button type="button">First card</button>
        <button type="button">Second card</button>
        <DrawerShell open={open} modal={false} onClose={vi.fn()} title="Thread">Content</DrawerShell>
      </>
    );
    const view = render(drawer(false));
    screen.getByRole('button', { name: 'First card' }).focus();
    view.rerender(drawer(true));
    const panel = screen.getByRole('dialog');
    expect(document.activeElement).toBe(panel);
    // The user moves on to another card while the drawer stays open…
    screen.getByRole('button', { name: 'Second card' }).focus();
    // …then comes back into the drawer and closes it.
    panel.focus();
    view.rerender(drawer(false));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second card' }));
  });
});

describe('DrawerShell modal focus', () => {
  it('cycles Tab within the panel and returns to its opener without resetting focus on rerender', () => {
    const drawer = (open: boolean) => <><button type="button">Open settings</button><DrawerShell open={open} onClose={() => {}} title="Settings"><input aria-label="Last field" /></DrawerShell></>;
    const view = render(drawer(false));
    const opener = screen.getByRole('button', { name: 'Open settings' });
    opener.focus();
    view.rerender(drawer(true));
    const panel = screen.getByRole('dialog');
    const first = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('textbox', { name: 'Last field' });
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(panel, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    view.rerender(drawer(true));
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    view.rerender(drawer(false));
    expect(document.activeElement).toBe(opener);
  });

  it('does not trap Tab in a non-modal peek', () => {
    render(<DrawerShell open modal={false} onClose={() => {}} title="Thread"><input aria-label="Peek field" /></DrawerShell>);
    const field = screen.getByRole('textbox');
    field.focus();
    expect(fireEvent.keyDown(field, { key: 'Tab' })).toBe(true);
  });
});

describe('DrawerShell close control', () => {
  it('can offer onClose as a leading back button instead of the trailing ×', () => {
    const close = vi.fn();
    render(<DrawerShell open closeControl="back" onClose={close} title="Settings">Content</DrawerShell>);
    const header = document.querySelector('.ui-overlay-header')!;
    const back = screen.getByRole('button', { name: 'Back' });
    expect(header.firstElementChild).toBe(back);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(header.textContent).not.toContain('▸');
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    fireEvent.click(back);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('DrawerShell resize', () => {
  const handleOf = () => screen.getByTitle('Drag to resize · Double-click to reset');
  const drag = (from: number, to: number) => {
    const panel = screen.getByRole('dialog');
    panel.getBoundingClientRect = () => ({ width: 440 } as DOMRect);
    const handle = handleOf();
    handle.setPointerCapture = vi.fn();
    // jsdom has no PointerEvent; a MouseEvent carries the pointer's x.
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: from }));
    handle.dispatchEvent(new MouseEvent('pointermove', { clientX: to }));
    handle.dispatchEvent(new MouseEvent('pointerup', { clientX: to }));
  };

  it('is fixed without a resize', () => {
    render(<DrawerShell open onClose={vi.fn()} title="Task" width={440}>Content</DrawerShell>);
    expect(screen.queryByTitle('Drag to resize · Double-click to reset')).toBeNull();
  });

  it('drags the left edge wider within the minimum and three quarters of the window, and double-click resets', () => {
    const resize = { width: 560, set: vi.fn(), reset: vi.fn() };
    render(<DrawerShell open onClose={vi.fn()} title="Task" width={440} resize={resize} modal={false}>Content</DrawerShell>);
    expect(screen.getByRole('dialog').style.width).toBe('560px');
    drag(1000, 900);
    expect(resize.set).toHaveBeenLastCalledWith(540);
    drag(1000, -2000);
    expect(resize.set).toHaveBeenLastCalledWith(Math.round(window.innerWidth * 0.75));
    drag(1000, 1400);
    expect(resize.set).toHaveBeenLastCalledWith(320);
    fireEvent.doubleClick(handleOf());
    expect(resize.reset).toHaveBeenCalledTimes(1);
  });

  it('shows its own width until one is dragged', () => {
    render(<DrawerShell open onClose={vi.fn()} title="Task" width={440} resize={{ width: undefined, set: vi.fn(), reset: vi.fn() }}>Content</DrawerShell>);
    expect(screen.getByRole('dialog').style.width).toBe('440px');
  });
});

describe('DrawerShell on a phone', () => {
  const wideWidth = window.innerWidth;
  beforeEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 }); });
  afterEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: wideWidth }); });

  function BackSwipe() {
    useBackSwipe(true);
    return null;
  }
  const swipeFromEdge = (target: Element, moves: number[]) => {
    fireEvent.touchStart(target, { touches: [{ identifier: 1, clientX: 6, clientY: 300 }] });
    for (const x of moves) fireEvent.touchMove(target, { touches: [{ identifier: 1, clientX: x, clientY: 304 }] });
    fireEvent.touchEnd(target, { touches: [] });
  };

  it('fills the screen at any dragged width, with no edge to drag', () => {
    render(<DrawerShell open onClose={vi.fn()} title="Task" width={440} resize={{ width: 600, set: vi.fn(), reset: vi.fn() }}>Content</DrawerShell>);
    expect(screen.queryByTitle('Drag to resize · Double-click to reset')).toBeNull();
    expect(screen.getByRole('dialog').style.width).toBe('440px');
  });

  it('marks its panel data-phone, which steps its text up (mobile.css), and drops it in a wide window', () => {
    render(<DrawerShell open onClose={vi.fn()} title="Settings">Content</DrawerShell>);
    const panel = screen.getByRole('dialog');
    expect(panel.hasAttribute('data-phone')).toBe(true);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(panel.hasAttribute('data-phone')).toBe(false);
  });

  it('reads as a page: a back chevron leads the header instead of the trailing ×', () => {
    render(<DrawerShell open onClose={vi.fn()} title="Background work">Content</DrawerShell>);
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('follows a back swipe from the left edge, then closes, or settles back when released short', () => {
    const close = vi.fn();
    render(<><BackSwipe /><DrawerShell open onClose={close} title="Background work"><span>Content</span></DrawerShell></>);
    const panel = screen.getByRole('dialog');
    swipeFromEdge(screen.getByText('Content'), [40]);
    expect(close).not.toHaveBeenCalled();
    expect(panel.style.transform).toBe('');
    fireEvent.touchStart(panel, { touches: [{ identifier: 1, clientX: 6, clientY: 300 }] });
    fireEvent.touchMove(panel, { touches: [{ identifier: 1, clientX: 120, clientY: 300 }] });
    expect(panel.style.transform).toBe('translateX(114px)');
    fireEvent.touchMove(panel, { touches: [{ identifier: 1, clientX: 220, clientY: 300 }] });
    fireEvent.touchEnd(panel, { touches: [] });
    expect(close).toHaveBeenCalledTimes(1);
    // Its own exit transition carries it on from where the finger left it.
    expect(panel.style.transform).toBe('');
  });

  it('steps back a level inside it instead of closing, with the edge arrow', () => {
    const close = vi.fn();
    const back = vi.fn();
    render(<><BackSwipe /><DrawerShell open onClose={close} onBack={back} title="Settings"><span>Content</span></DrawerShell></>);
    swipeFromEdge(screen.getByText('Content'), [40, 90]);
    expect(back).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').style.transform).toBe('');
    act(() => backTarget()?.back());
    expect(back).toHaveBeenCalledTimes(2);
  });
});
