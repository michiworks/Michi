import React, { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ResizeHandle from './ResizeHandle';

function Edge({ width, side, max, onResize, onReset, onResizeEnd }: {
  width: number;
  side?: 'left' | 'right';
  max?: () => number;
  onResize: (width: number) => void;
  onReset: () => void;
  onResizeEnd?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={(el) => {
      ref.current = el;
      if (el) el.getBoundingClientRect = () => ({ width } as DOMRect);
    }}>
      <ResizeHandle paneRef={ref} label="Resize list" side={side} min={300} max={max}
        onResize={onResize} onReset={onReset} onResizeEnd={onResizeEnd} />
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ResizeHandle', () => {
  it('is a focusable separator whose arrow keys move the edge one step, each step committed', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const view = render(<Edge width={400} onResize={onResize} onReset={vi.fn()} onResizeEnd={onResizeEnd} />);
    const edge = screen.getByRole('separator', { name: 'Resize list' });
    expect(edge.tabIndex).toBe(0);
    expect(edge.getAttribute('aria-orientation')).toBe('vertical');
    fireEvent.focus(edge);
    expect(edge.getAttribute('aria-valuenow')).toBe('400');
    fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(424);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    // On a left edge, ← widens; the minimum still holds.
    view.rerender(<Edge width={310} side="left" onResize={onResize} onReset={vi.fn()} />);
    fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(334);
    fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(300);
  });

  it('switches between the widest and narrowest widths on a click, and a double-click only resets', () => {
    vi.useFakeTimers();
    const onResize = vi.fn();
    const onReset = vi.fn();
    const view = render(<Edge width={400} max={() => 640} onResize={onResize} onReset={onReset} />);
    const edge = screen.getByRole('separator', { name: 'Resize list' });
    fireEvent.click(edge, { detail: 1 });
    expect(onResize).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(onResize).toHaveBeenLastCalledWith(640);
    view.rerender(<Edge width={640} max={() => 640} onResize={onResize} onReset={onReset} />);
    fireEvent.click(edge, { detail: 1 });
    act(() => { vi.advanceTimersByTime(300); });
    expect(onResize).toHaveBeenLastCalledWith(300);

    onResize.mockClear();
    fireEvent.click(edge, { detail: 1 });
    fireEvent.click(edge, { detail: 2 });
    fireEvent.doubleClick(edge);
    act(() => { vi.advanceTimersByTime(300); });
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onResize).not.toHaveBeenCalled();
  });
});
