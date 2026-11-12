import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ContextMenu, { MenuPresence, menuOpenKey, type MenuSection } from '../ContextMenu';
import { installTouchContextMenu, LONG_PRESS_MS } from '../../lib/touchContextMenu';

class TestPointerEvent extends MouseEvent {
  pointerType: string;
  isPrimary: boolean;
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
    this.isPrimary = init.isPrimary ?? false;
    this.pointerId = init.pointerId ?? 1;
  }
}
const hadPointerEvent = 'PointerEvent' in window;
const desktopWidth = window.innerWidth;

/** A row with a box, as a browser would lay it out. */
function rowElement(): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-context-target', '');
  row.setAttribute('data-testid', 'the-row');
  row.innerHTML = '<span>Fix tunnel sign-in expiry</span>';
  row.getBoundingClientRect = () => ({ left: 0, top: 300, right: 320, bottom: 340, width: 320, height: 40, x: 0, y: 300, toJSON: () => ({}) });
  Object.defineProperty(row, 'offsetWidth', { configurable: true, value: 320 });
  Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 40 });
  document.body.append(row);
  return row;
}

function Harness({ anchor, sections, onClose }: { anchor: HTMLElement | null; sections: MenuSection[]; onClose?: () => void }) {
  const [open, setOpen] = React.useState(true);
  return (
    <MenuPresence>
      {open && (
        <ContextMenu x={40} y={320} anchor={anchor} sections={sections} onClose={() => { setOpen(false); onClose?.(); }} />
      )}
    </MenuPresence>
  );
}

describe('ContextMenu on a phone', () => {
  let run: Mock<(what: string) => void>;
  let sections: MenuSection[];

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    if (!hadPointerEvent) Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: TestPointerEvent });
    run = vi.fn<(what: string) => void>();
    sections = [
      { items: [
        { id: '0-0', label: 'Rename…', keys: 'R', run: () => run('rename') },
        { id: '0-1', label: 'Pin', keys: 'P', run: () => run('pin') },
      ] },
      { items: [
        { id: 'delete', label: 'Delete subtree (root protected)', danger: true, disabled: true, run: () => run('delete') },
      ] },
    ];
  });
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth });
    if (!hadPointerEvent) delete (window as { PointerEvent?: unknown }).PointerEvent;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('lifts the row out in its own shape and opens the menu beside it', () => {
    const row = rowElement();
    render(<Harness anchor={row} sections={sections} />);
    const menu = screen.getByRole('menu', { name: 'Actions' });
    expect(menu.classList.contains('phone-menu')).toBe(true);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Rename…', 'Pin', 'Delete subtree (root protected)']);
    // Glyphs by label (index ids carry none); no keyboard chips on a phone.
    expect(screen.getByRole('menuitem', { name: 'Pin' }).querySelector('svg')).not.toBeNull();
    expect(menu.querySelector('.michi-menu-keys')).toBeNull();
    expect((screen.getByRole('menuitem', { name: /Delete subtree/ }) as HTMLButtonElement).disabled).toBe(true);
    // The row hides behind a copy of itself that carries no test ids or names.
    expect(row.style.visibility).toBe('hidden');
    const lift = document.querySelector<HTMLElement>('.phone-menu-lift')!;
    expect(lift.getAttribute('aria-hidden')).toBe('true');
    expect(lift.textContent).toBe('Fix tunnel sign-in expiry');
    expect(screen.getAllByTestId('the-row')).toHaveLength(1);
    // Square row, square copy, at the row's own width.
    expect([lift.style.left, lift.style.width, lift.style.borderRadius]).toEqual(['0px', '320px', '0px']);
  });

  it('runs a chosen item in the same tap and shows the row again first', () => {
    const row = rowElement();
    const onClose = vi.fn();
    render(<Harness anchor={row} sections={sections} onClose={onClose} />);
    const seenAtRun: string[] = [];
    run.mockImplementation(() => seenAtRun.push(row.style.visibility));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
    expect(run).toHaveBeenCalledWith('pin');
    expect(seenAtRun).toEqual(['']);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.querySelector('.phone-menu-lift')).toBeNull();
  });

  it('closes on Escape or a tap on the scrim without running anything', () => {
    const row = rowElement();
    const onClose = vi.fn();
    const { unmount } = render(<Harness anchor={row} sections={sections} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(row.style.visibility).toBe('');
    unmount();

    render(<Harness anchor={row} sections={sections} onClose={onClose} />);
    const scrim = document.querySelector('.phone-menu-scrim')!;
    // The release of the press that opened it is not a tap on the scrim.
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it('shows the row again if the menu goes away underneath', () => {
    const row = rowElement();
    const { unmount } = render(<Harness anchor={row} sections={sections} />);
    expect(row.style.visibility).toBe('hidden');
    unmount();
    expect(row.style.visibility).toBe('');
  });

  it('chooses the item a held finger slides onto and lifts from', () => {
    vi.useFakeTimers();
    const uninstall = installTouchContextMenu();
    const row = rowElement();
    function Opener() {
      const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
      React.useEffect(() => {
        const open = (event: MouseEvent) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); };
        row.addEventListener('contextmenu', open);
        return () => row.removeEventListener('contextmenu', open);
      }, []);
      return <MenuPresence>{menu && <ContextMenu x={menu.x} y={menu.y} sections={sections} onClose={() => setMenu(null)} />}</MenuPresence>;
    }
    render(<Opener />);
    const finger = { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 40, clientY: 320 };
    fireEvent.pointerDown(row.querySelector('span')!, finger);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    const pin = screen.getByRole('menuitem', { name: 'Pin' });
    document.elementFromPoint = vi.fn(() => pin);
    const touchAt = (type: string, key: 'touches' | 'changedTouches') => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, key, { value: [{ clientX: 40, clientY: 400 }] });
      if (key === 'changedTouches') Object.defineProperty(event, 'touches', { value: [] });
      return event;
    };
    act(() => { document.dispatchEvent(touchAt('touchmove', 'touches')); });
    expect(pin.hasAttribute('data-hot')).toBe(true);
    act(() => { document.dispatchEvent(touchAt('touchend', 'changedTouches')); });
    expect(run).toHaveBeenCalledWith('pin');
    expect(screen.queryByRole('menu')).toBeNull();
    uninstall();
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  describe('reopened during its fade-out', () => {
    let animations: { cancel: Mock; effect: Element }[];
    beforeEach(() => {
      vi.useFakeTimers();
      animations = [];
      // jsdom has no Web Animations: record each so the fade-out has a window.
      HTMLElement.prototype.animate = vi.fn(function animate(this: HTMLElement) {
        const animation = { cancel: vi.fn(), effect: this };
        animations.push(animation);
        return animation as unknown as Animation;
      });
      HTMLElement.prototype.getAnimations = function getAnimations(this: HTMLElement) {
        return animations.filter((animation) => animation.effect === this && !animation.cancel.mock.calls.length) as unknown as Animation[];
      };
    });
    afterEach(() => {
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
      delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
    });

    function tapScrimAndClose() {
      const scrim = document.querySelector('.phone-menu-scrim')!;
      fireEvent.pointerDown(scrim);
      fireEvent.click(scrim);
      act(() => { vi.advanceTimersByTime(300); });
    }

    it('closes again on a scrim tap after a same-key reopen', () => {
      const row = rowElement();
      const onClose = vi.fn();
      const menu = (open: boolean) => <MenuPresence>{open && <ContextMenu key="same" x={40} y={320} anchor={row} sections={sections} onClose={onClose} />}</MenuPresence>;
      const view = render(menu(true));
      tapScrimAndClose();
      expect(onClose).toHaveBeenCalledTimes(1);
      view.rerender(menu(false));
      // The ⋯ is tapped again inside the 170 ms fade: the same instance comes back.
      view.rerender(menu(true));
      expect(document.querySelector<HTMLElement>('.phone-menu-layer')!.style.pointerEvents).toBe('');
      expect(document.querySelector<HTMLElement>('.phone-menu')!.getAnimations()).toHaveLength(0);
      tapScrimAndClose();
      expect(onClose).toHaveBeenCalledTimes(2);
      view.rerender(menu(false));
      view.rerender(menu(true));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
      expect(run).toHaveBeenCalledWith('pin');
    });

    it('opens a new menu for each opening keyed by menuOpenKey', () => {
      const row = rowElement();
      const onClose = vi.fn();
      const menu = (anchor: { x: number; y: number } | null) => <MenuPresence>{anchor && <ContextMenu key={menuOpenKey(anchor)} {...anchor} anchor={row} sections={sections} onClose={onClose} />}</MenuPresence>;
      const view = render(menu({ x: 40, y: 320 }));
      tapScrimAndClose();
      view.rerender(menu(null));
      // Same ⋯, same place, a new anchor object: a new menu beside the fading one.
      view.rerender(menu({ x: 40, y: 320 }));
      const layers = document.querySelectorAll<HTMLElement>('.phone-menu-layer');
      expect([...layers].map((layer) => layer.style.pointerEvents)).toEqual(['none', '']);
      fireEvent.click(within(layers[1]).getByRole('menuitem', { name: 'Pin' }));
      expect(run).toHaveBeenCalledWith('pin');
    });
  });

  it('stays the desktop menu without a phone screen or an element to lift', () => {
    render(<Harness anchor={null} sections={sections} />);
    expect(screen.getByRole('menu').classList.contains('phone-menu')).toBe(false);
  });
});
