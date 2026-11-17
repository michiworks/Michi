import React, { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRowSwipe, type RowSwipeActions } from './useRowSwipe';

function Row({ enabled = true, actions }: { enabled?: boolean; actions: RowSwipeActions }) {
  const ref = useRef<HTMLDivElement>(null);
  useRowSwipe(ref, enabled, actions);
  return <div ref={ref} data-testid="row">row</div>;
}

const point = (x: number, y: number) => ({ identifier: 1, clientX: x, clientY: y });

function swipe(target: Element, path: Array<[number, number]>) {
  const [first, ...rest] = path;
  fireEvent.touchStart(target, { touches: [point(...first)] });
  for (const p of rest) fireEvent.touchMove(target, { touches: [point(...p)] });
  fireEvent.touchEnd(target, { touches: [] });
}

function setup(enabled = true) {
  const actions = { left: vi.fn(() => Promise.resolve()), right: vi.fn(() => Promise.resolve()) };
  render(<Row enabled={enabled} actions={actions} />);
  return { actions, row: screen.getByTestId('row') };
}

describe('useRowSwipe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300 } as DOMRect);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('slides the row out on a swipe left, then acts; a row still there comes back', async () => {
    const { actions, row } = setup();
    fireEvent.touchStart(row, { touches: [point(250, 100)] });
    fireEvent.touchMove(row, { touches: [point(230, 101)] });
    expect(row.dataset.swipe).toBe('left');
    expect(row.style.getPropertyValue('--swipe-x')).toBe('-20px');
    expect(row.dataset.swipeArmed).toBeUndefined();
    fireEvent.touchMove(row, { touches: [point(130, 102)] });
    expect(row.dataset.swipeArmed).toBe('');
    fireEvent.touchEnd(row, { touches: [] });
    expect(row.style.getPropertyValue('--swipe-x')).toBe('-300px');
    expect(actions.left).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    expect(actions.left).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(row.dataset.swipe).toBeUndefined();
    expect(row.style.getPropertyValue('--swipe-x')).toBe('');
  });

  it('slides the row out the other way on a swipe right, then acts', async () => {
    const { actions, row } = setup();
    swipe(row, [[100, 100], [120, 100], [220, 100]]);
    expect(row.dataset.swipe).toBe('right');
    expect(row.style.getPropertyValue('--swipe-x')).toBe('300px');
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    expect(actions.right).toHaveBeenCalledTimes(1);
    expect(actions.left).not.toHaveBeenCalled();
  });

  it('settles back without acting when released short', () => {
    const { actions, row } = setup();
    swipe(row, [[100, 100], [120, 100], [140, 100]]);
    act(() => { vi.advanceTimersByTime(200); });
    expect(row.dataset.swipe).toBeUndefined();
    expect(actions.left).not.toHaveBeenCalled();
    expect(actions.right).not.toHaveBeenCalled();
  });

  it('leaves a scroll, the back swipe at the left edge and a disabled row alone', () => {
    const { actions, row } = setup();
    swipe(row, [[100, 100], [104, 130], [250, 140]]);
    swipe(row, [[10, 100], [40, 100], [250, 100]]);
    expect(row.dataset.swipe).toBeUndefined();
    act(() => { vi.advanceTimersByTime(400); });
    expect(actions.right).not.toHaveBeenCalled();

    document.body.innerHTML = '';
    const disabled = setup(false);
    swipe(disabled.row, [[100, 100], [120, 100], [250, 100]]);
    expect(disabled.row.dataset.swipe).toBeUndefined();
  });
});
