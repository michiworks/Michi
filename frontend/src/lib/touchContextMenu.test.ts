import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import {
  contextMenuAnchor,
  installTouchContextMenu,
  isLongPressHolding,
  LONG_PRESS_MS,
  onLongPressHold,
} from './touchContextMenu';

// jsdom has no PointerEvent; a MouseEvent carrying the two pointer fields will do.
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
const touch = { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 30, clientY: 40 };
/** A touch event as a phone sends it while a finger is down or lifting. */
function touchEvent(type: 'touchmove' | 'touchend', clientX: number, clientY: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, type === 'touchmove' ? 'touches' : 'changedTouches', { value: [{ clientX, clientY }] });
  if (type === 'touchend') Object.defineProperty(event, 'touches', { value: [] });
  return event;
}

describe('touch long press → context menu', () => {
  let uninstall: () => void;
  let row: HTMLElement;
  let label: HTMLElement;
  let menus: MouseEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    if (!hadPointerEvent) Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: TestPointerEvent });
    document.body.innerHTML = '<div data-context-target><span>Row title</span><input aria-label="name"></div><p>outside</p>';
    row = document.querySelector('[data-context-target]')!;
    label = row.querySelector('span')!;
    menus = [];
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); menus.push(event); });
    uninstall = installTouchContextMenu();
  });
  afterEach(() => {
    uninstall();
    vi.useRealTimers();
    if (!hadPointerEvent) delete (window as { PointerEvent?: unknown }).PointerEvent;
    document.body.innerHTML = '';
  });

  it('opens the menu where the finger is, after the hold, from the element it pressed', () => {
    fireEvent.pointerDown(label, touch);
    vi.advanceTimersByTime(80);
    expect(row.hasAttribute('data-press')).toBe(false);
    vi.advanceTimersByTime(20);
    // The pressed fill shows while the finger is down.
    expect(row.hasAttribute('data-press')).toBe(true);
    vi.advanceTimersByTime(LONG_PRESS_MS - 101);
    expect(menus).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(menus).toHaveLength(1);
    expect(menus[0].target).toBe(label);
    expect([menus[0].clientX, menus[0].clientY]).toEqual([30, 40]);
    expect(row.hasAttribute('data-press')).toBe(false);
  });

  it('lets a finger that drifts scroll instead, and leaves the mouse to its right button', () => {
    fireEvent.pointerDown(label, touch);
    fireEvent.pointerMove(label, { ...touch, clientY: 52 });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(menus).toHaveLength(0);
    expect(row.hasAttribute('data-press')).toBe(false);

    fireEvent.pointerDown(label, { ...touch, pointerType: 'mouse' });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(menus).toHaveLength(0);
  });

  it('leaves a field its own long press', () => {
    fireEvent.pointerDown(row.querySelector('input')!, touch);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(menus).toHaveLength(0);
  });

  it('drops the click that ends a long press, wherever it lands, and only that one', () => {
    const clicks = vi.fn();
    document.body.addEventListener('click', clicks);
    fireEvent.pointerDown(label, touch);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fireEvent.pointerUp(label, touch);
    fireEvent.click(document.querySelector('p')!);
    expect(clicks).not.toHaveBeenCalled();
    // The next tap is the user's.
    fireEvent.pointerDown(label, touch);
    fireEvent.pointerUp(label, touch);
    fireEvent.click(label);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('opens one menu when the browser fires its own long press too', () => {
    // Ours first: the browser's is dropped.
    fireEvent.pointerDown(label, touch);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    const late = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    label.dispatchEvent(late);
    expect(menus).toHaveLength(1);
    expect(late.defaultPrevented).toBe(true);
    fireEvent.pointerUp(label, touch);

    // The browser's first: it opens the menu and the timer stays quiet.
    fireEvent.pointerDown(label, touch);
    vi.advanceTimersByTime(LONG_PRESS_MS - 50);
    const early = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
    label.dispatchEvent(early);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(menus).toHaveLength(2);
    expect(menus[1]).toBe(early);
  });

  it('follows the finger that opened a menu until it lifts', () => {
    const hold = vi.fn();
    const off = onLongPressHold(hold);
    fireEvent.pointerDown(label, touch);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(isLongPressHolding()).toBe(true);
    // Touch events keep coming even once the browser takes the slide as a
    // scroll and cancels the pointer.
    fireEvent.pointerCancel(label, touch);
    document.dispatchEvent(touchEvent('touchmove', 30, 90));
    expect(isLongPressHolding()).toBe(true);
    document.dispatchEvent(touchEvent('touchend', 30, 90));
    expect(hold.mock.calls.map(([point, phase]) => [phase, point.clientY])).toEqual([['move', 90], ['up', 90]]);
    expect(isLongPressHolding()).toBe(false);
    off();
  });

  it('keeps the browser from selecting text under the finger that opened a menu', () => {
    const outside = document.querySelector('p')!;
    const selectOutside = () => {
      document.getSelection()!.selectAllChildren(outside);
      document.dispatchEvent(new Event('selectionchange'));
    };
    fireEvent.pointerDown(label, touch);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    const start = new Event('selectstart', { bubbles: true, cancelable: true });
    outside.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);
    selectOutside();
    expect(document.getSelection()!.isCollapsed).toBe(true);

    // Once the finger lifts, selecting is the user's again.
    document.dispatchEvent(touchEvent('touchend', 30, 40));
    fireEvent.pointerUp(label, touch);
    const later = new Event('selectstart', { bubbles: true, cancelable: true });
    outside.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
    selectOutside();
    expect(document.getSelection()!.isCollapsed).toBe(false);
    document.getSelection()!.removeAllRanges();
  });

  it('anchors a menu to the target the opening press went down on', () => {
    row.getBoundingClientRect = () => ({ left: 0, top: 20, right: 300, bottom: 60, width: 300, height: 40, x: 0, y: 20, toJSON: () => ({}) });
    fireEvent.pointerDown(label, { ...touch, pointerType: 'mouse' });
    expect(contextMenuAnchor(280, 62)).toBe(row);
    // A menu opening far from it does not belong to it.
    expect(contextMenuAnchor(280, 400)).toBeNull();
  });
});
