import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu } from './ActionMenu';
import { ModalShell } from './ModalShell';

function setup() {
  const onClose = vi.fn();
  const selected = vi.fn();
  const view = render(<button type="button">More</button>);
  const anchor = screen.getByRole('button') as HTMLButtonElement;
  view.rerender(<><button type="button">More</button><ActionMenu anchor={anchor} onClose={onClose} label="Row actions" items={[
    { id: 'first', label: 'First', onSelect: selected },
    { id: 'disabled', label: 'Disabled', disabled: true, onSelect: selected },
    { id: 'last', label: 'Last', onSelect: selected, dividerBefore: true, danger: true },
  ]} /></>);
  return { anchor, onClose, selected };
}

describe('ActionMenu', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('opens above a button near the bottom edge instead of covering it', () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      if (this.textContent === 'More') return { left: 900, right: 924, top: 700, bottom: 724, width: 24, height: 24, x: 900, y: 700, toJSON() {} };
      if (this.classList.contains('trash-menu')) return { left: 0, right: 208, top: 0, bottom: 120, width: 208, height: 120, x: 0, y: 0, toJSON() {} };
      return original.call(this);
    });
    setup();
    const menu = screen.getByRole('menu', { name: 'Row actions' });
    expect(menu.style.left).toBe('716px');
    expect(menu.style.top).toBe('575px');
  });

  it('focuses enabled actions and navigates with arrows, Home and End', () => {
    setup();
    const first = screen.getByRole('menuitem', { name: 'First' });
    const last = screen.getByRole('menuitem', { name: 'Last' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Home' });
    expect(document.activeElement).toBe(first);
  });

  it('returns focus before running an action or dismissing with Escape', () => {
    const { anchor, onClose, selected } = setup();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Last' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(anchor);
    onClose.mockClear();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(anchor);
  });

  it('keeps the Escape that closes it from the window it opened in', () => {
    // A window under the menu (Settings, a drawer) closes on Escape from a window listener of its own.
    const underneath = vi.fn();
    window.addEventListener('keydown', underneath);
    try {
      const { onClose } = setup();
      fireEvent.keyDown(screen.getByRole('menuitem', { name: 'First' }), { key: 'Escape' });
      expect(onClose).toHaveBeenCalledOnce();
      expect(underneath).not.toHaveBeenCalled();
      fireEvent.keyDown(screen.getByRole('menuitem', { name: 'First' }), { key: 'ArrowDown' });
      expect(underneath).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('keydown', underneath);
    }
  });

  it.each(['resize', 'scroll', 'outside', 'Tab'])('dismisses on %s', (reason) => {
    const { onClose } = setup();
    if (reason === 'outside') fireEvent.pointerDown(document.body);
    else if (reason === 'Tab') fireEvent.keyDown(window, { key: 'Tab' });
    else fireEvent(window, new Event(reason));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Esc before the window it opened over, and only itself', () => {
    // Settings: a modal with menus of its own; its Esc listener is older than the menu's.
    function Settings() {
      const [open, setOpen] = useState(true);
      const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
      return (
        <ModalShell open={open} onClose={() => setOpen(false)} layer="window" motion="none" glass="live" aria-label="Settings">
          <button type="button" onClick={(event) => setAnchor(event.currentTarget)}>More actions</button>
          {anchor && <ActionMenu anchor={anchor} onClose={() => setAnchor(null)} label="Row actions" items={[{ id: 'restore', label: 'Restore', onSelect: () => {} }]} />}
        </ModalShell>
      );
    }
    render(<Settings />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    const item = screen.getByRole('menuitem', { name: 'Restore' });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: 'Escape', isComposing: true });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });
});

describe('ActionMenu on a phone', () => {
  const desktopWidth = window.innerWidth;
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth });
  });

  it('lifts the row it belongs to, as the row\'s long-press menu does, and runs a tapped entry', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const onClose = vi.fn();
    const edit = vi.fn();
    const view = render(<div data-testid="row"><span>Nightly digest</span><button type="button">More</button></div>);
    const row = screen.getByTestId('row');
    row.getBoundingClientRect = () => ({ left: 0, top: 300, right: 390, bottom: 356, width: 390, height: 56, x: 0, y: 300, toJSON: () => ({}) });
    const anchor = screen.getByRole('button', { name: 'More' }) as HTMLButtonElement;
    view.rerender(<><div data-testid="row"><span>Nightly digest</span><button type="button">More</button></div>
      <ActionMenu anchor={anchor} liftTarget={row} onClose={onClose} label="Scheduled job actions" items={[
        { id: 'edit', label: 'Edit', onSelect: edit },
        { id: 'toggle', label: 'Pause', onSelect: () => {} },
        { id: 'delete', label: 'Delete…', danger: true, dividerBefore: true, onSelect: () => {} },
      ]} /></>);
    expect(document.querySelector('[data-phone-menu]')).not.toBeNull();
    expect(screen.queryByRole('menu', { name: 'Scheduled job actions' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Edit' }).querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Pause' }).querySelector('svg')).not.toBeNull();
    expect(document.querySelectorAll('.phone-menu__sep')).toHaveLength(1);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(edit).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the popover for a menu without a row to lift', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    setup();
    expect(screen.getByRole('menu', { name: 'Row actions' })).toBeTruthy();
    expect(document.querySelector('[data-phone-menu]')).toBeNull();
  });
});
