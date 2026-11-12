import { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHoldHeightWhileLive } from './useHoldHeightWhileLive';

// jsdom has no layout: drive offsetHeight and ResizeObserver by hand.
let height = 0;
let notify: (() => void) | null = null;

class FakeResizeObserver {
  constructor(cb: () => void) { notify = cb; }
  observe() {}
  disconnect() { notify = null; }
}

function Probe({ live, reduce = false }: { live: boolean; reduce?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useHoldHeightWhileLive(ref, live, reduce);
  return <div ref={ref} data-testid="probe" style={{ boxSizing: 'border-box' }} />;
}

beforeEach(() => {
  height = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useHoldHeightWhileLive', () => {
  it('holds the tallest height while live, so a fold never shortens it', () => {
    height = 120;
    const { getByTestId } = render(<Probe live />);
    const el = getByTestId('probe');
    expect(el.style.minHeight).toBe('120px');

    height = 300;
    act(() => notify?.());
    expect(el.style.minHeight).toBe('300px');

    // A fold: the content is shorter, but the hold keeps the room.
    height = 180;
    act(() => notify?.());
    expect(el.style.minHeight).toBe('300px');
  });

  it('eases the held room away when the turn ends, then clears it', () => {
    vi.useFakeTimers();
    height = 200;
    const { getByTestId, rerender } = render(<Probe live />);
    const el = getByTestId('probe');
    rerender(<Probe live={false} />);
    expect(el.style.minHeight).toBe('0px');
    expect(el.style.transition).toContain('min-height');
    act(() => { vi.advanceTimersByTime(400); });
    expect(el.style.minHeight).toBe('');
    expect(el.style.transition).toBe('');
  });

  it('lets go at once under reduced motion', () => {
    height = 200;
    const { getByTestId, rerender } = render(<Probe live reduce />);
    rerender(<Probe live={false} reduce />);
    expect(getByTestId('probe').style.minHeight).toBe('');
  });

  it('never holds a message that is not live', () => {
    height = 200;
    const { getByTestId } = render(<Probe live={false} />);
    expect(getByTestId('probe').style.minHeight).toBe('');
  });
});
