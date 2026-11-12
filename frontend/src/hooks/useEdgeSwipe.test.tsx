import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { swipeCommits, useSwipeTrack, type SwipeTrack } from './useEdgeSwipe';
import { DbPopover } from '../components/terminal/content/db/DbPopover';

function recorder(distance = 200) {
  const moves: number[] = [];
  const track = {
    distance,
    move: (travel: number) => { moves.push(travel); },
    commit: vi.fn(),
    cancel: vi.fn(),
  };
  return { track, moves, begin: vi.fn((): SwipeTrack | null => track) };
}

function Harness({ enabled = true, direction = 1, from = 'edge', begin }: {
  enabled?: boolean;
  direction?: 1 | -1;
  from?: 'edge' | 'anywhere';
  begin: () => SwipeTrack | null;
}) {
  useSwipeTrack(enabled, direction, from, begin);
  return (
    <div>
      <div data-testid="content">content</div>
      <div data-testid="map"><span data-testid="inside-map">map</span></div>
    </div>
  );
}

const point = (x: number, y: number) => ({ identifier: 1, clientX: x, clientY: y });

function swipe(target: Element, path: Array<[number, number]>, end: 'end' | 'cancel' = 'end') {
  const [first, ...rest] = path;
  fireEvent.touchStart(target, { touches: [point(...first)] });
  for (const p of rest) fireEvent.touchMove(target, { touches: [point(...p)] });
  if (end === 'end') fireEvent.touchEnd(target, { touches: [] });
  else fireEvent.touchCancel(target, { touches: [] });
}

describe('useSwipeTrack', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('follows a swipe from the left edge and completes it past the commit share', () => {
    const { track, moves, begin } = recorder(200);
    const view = render(<Harness begin={begin} />);
    swipe(view.getByTestId('content'), [[8, 300], [30, 302], [70, 305], [120, 306]]);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(moves).toEqual([22, 62, 112]);
    expect(track.commit).toHaveBeenCalledTimes(1);
    expect(track.cancel).not.toHaveBeenCalled();
  });

  it('settles back when released short of the commit share', () => {
    const { track, begin } = recorder(200);
    const view = render(<Harness begin={begin} />);
    swipe(view.getByTestId('content'), [[8, 300], [30, 300], [50, 300]]);
    expect(track.cancel).toHaveBeenCalledTimes(1);
    expect(track.commit).not.toHaveBeenCalled();
  });

  it('settles back when the browser takes the touch', () => {
    const { track, begin } = recorder(200);
    const view = render(<Harness begin={begin} />);
    swipe(view.getByTestId('content'), [[8, 300], [60, 300], [150, 300]], 'cancel');
    expect(track.cancel).toHaveBeenCalledTimes(1);
    expect(track.commit).not.toHaveBeenCalled();
  });

  it('ignores swipes that start away from the edge', () => {
    const { begin } = recorder();
    const view = render(<Harness begin={begin} />);
    swipe(view.getByTestId('content'), [[60, 300], [140, 300]]);
    expect(begin).not.toHaveBeenCalled();
  });

  it('leaves a vertical scroll from the edge alone', () => {
    const { begin } = recorder();
    const view = render(<Harness begin={begin} />);
    swipe(view.getByTestId('content'), [[8, 300], [12, 330], [70, 340]]);
    expect(begin).not.toHaveBeenCalled();
  });

  it('ignores a second finger', () => {
    const { begin } = recorder();
    const view = render(<Harness begin={begin} />);
    const target = view.getByTestId('content');
    fireEvent.touchStart(target, { touches: [point(8, 300), { identifier: 2, clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(target, { touches: [point(80, 300), { identifier: 2, clientX: 260, clientY: 300 }] });
    expect(begin).not.toHaveBeenCalled();
  });

  it('leaves content that takes every touch to that content', () => {
    const { begin } = recorder();
    const view = render(<Harness begin={begin} />);
    // jsdom does not implement touch-action; browsers report it as computed style.
    const map = view.getByTestId('map');
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el === map ? ({ touchAction: 'none' } as CSSStyleDeclaration) : real(el, pseudo));
    try {
      swipe(view.getByTestId('inside-map'), [[8, 300], [80, 300]]);
      expect(begin).not.toHaveBeenCalled();
      swipe(view.getByTestId('content'), [[8, 300], [80, 300]]);
      expect(begin).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('gives the tap that closed a menu to the menu', () => {
    const { begin } = recorder();
    const view = render(<Harness begin={begin} />);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    // The menu closes on the pointerdown, before the touch starts.
    // jsdom has no PointerEvent: an Event with the touch pointer's type.
    const down = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(down, 'pointerType', { value: 'touch' });
    view.getByTestId('content').dispatchEvent(down);
    menu.remove();
    swipe(view.getByTestId('content'), [[8, 300], [80, 300]]);
    expect(begin).not.toHaveBeenCalled();
  });

  it('gives the tap that closed a panel hung from a button to the panel', () => {
    const { begin } = recorder();
    function Page() {
      const [anchor, setAnchor] = React.useState<HTMLButtonElement | null>(null);
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <Harness begin={begin} />
          <button type="button" ref={setAnchor}>Filter</button>
          {open && anchor && <DbPopover anchor={anchor} label="Filter" onClose={() => setOpen(false)}><input aria-label="Value" /></DbPopover>}
        </>
      );
    }
    const view = render(<Page />);
    expect(view.getByRole('dialog', { name: 'Filter' })).toBeTruthy();
    const down = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(down, 'pointerType', { value: 'touch' });
    act(() => { view.getByTestId('content').dispatchEvent(down); });
    expect(view.queryByRole('dialog', { name: 'Filter' })).toBeNull();
    swipe(view.getByTestId('content'), [[8, 300], [80, 300]]);
    expect(begin).not.toHaveBeenCalled();
  });

  it('does nothing when begin declines or when disabled', () => {
    const declined = vi.fn((): SwipeTrack | null => null);
    const view = render(<Harness begin={declined} />);
    swipe(view.getByTestId('content'), [[8, 300], [80, 300]]);
    expect(declined).toHaveBeenCalledTimes(1);
    view.unmount();
    const { begin } = recorder();
    const off = render(<Harness enabled={false} begin={begin} />);
    swipe(off.getByTestId('content'), [[8, 300], [80, 300]]);
    expect(begin).not.toHaveBeenCalled();
  });

  it('tracks a leftward swipe from anywhere', () => {
    const { track, moves, begin } = recorder(300);
    const view = render(<Harness direction={-1} from="anywhere" begin={begin} />);
    swipe(view.getByTestId('content'), [[260, 300], [230, 302], [190, 305], [120, 306]]);
    expect(moves).toEqual([30, 70, 140]);
    expect(track.commit).toHaveBeenCalledTimes(1);
    swipe(view.getByTestId('content'), [[100, 300], [200, 300]]);
    expect(begin).toHaveBeenCalledTimes(1);
  });
});

describe('swipeCommits', () => {
  it('completes past the share, or on a forward fling, never while pulling back', () => {
    expect(swipeCommits(70, 200, 0)).toBe(true);
    expect(swipeCommits(40, 200, 0)).toBe(false);
    expect(swipeCommits(40, 200, 0.6)).toBe(true);
    expect(swipeCommits(15, 200, 0.6)).toBe(false);
    expect(swipeCommits(150, 200, -0.3)).toBe(false);
  });
});
