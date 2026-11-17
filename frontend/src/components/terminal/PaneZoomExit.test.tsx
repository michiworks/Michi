import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import PaneCaption from './PaneCaption';

const hiddenPanes = [
  { id: 'n2', title: 'second', status: 'streaming' as const },
  { id: 'n3', title: 'third', status: 'idle' as const },
];

function renderZoomed(onZoom = vi.fn(), onFocus = vi.fn()) {
  render(
    <PaneCaption
      nodeId="n1" title="first" focused streaming={false} error={false}
      onFocus={onFocus} onClose={() => {}} onCloseOthers={() => {}} canCloseOthers onReorder={() => {}}
      zoomed canZoom hiddenPanes={hiddenPanes} onZoom={onZoom}
    />,
  );
  return { onZoom, onFocus, pill: screen.getByTestId('pane-zoom-exit') };
}

describe('PaneZoomExit', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('lists the hidden panes on hover and moves the zoom to the one picked', () => {
    vi.useFakeTimers();
    const { onZoom, onFocus, pill } = renderZoomed();
    expect(pill.getAttribute('aria-label')).toBe('Exit zoom, 2 more panes');
    fireEvent.pointerEnter(pill);
    expect(screen.queryByRole('menu', { name: 'Hidden panes' })).toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['second', 'third']);
    expect(pill.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('menuitem', { name: 'third' }));
    expect(onZoom).toHaveBeenCalledWith('n3');
    // The portaled list's click does not reach the caption underneath.
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('opens from the keyboard and closes on Escape back to the pill', () => {
    const { onZoom, pill } = renderZoomed();
    pill.focus();
    fireEvent.keyDown(pill, { key: 'ArrowDown' });
    const rows = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Hidden panes' })).toBeNull();
    expect(document.activeElement).toBe(pill);
    expect(onZoom).not.toHaveBeenCalled();
  });

  it('still ends the zoom on a click', () => {
    const { onZoom, pill } = renderZoomed();
    fireEvent.click(pill);
    expect(onZoom).toHaveBeenCalledWith(null);
  });
});
