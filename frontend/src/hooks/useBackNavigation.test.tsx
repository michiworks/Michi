import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBackLayer, type BackLayer } from '../lib/backStack';
import { useBackSwipe, useSystemBack } from './useBackNavigation';
import type { SwipeTrack } from './useEdgeSwipe';

function Layer({ layer }: { layer: BackLayer }) {
  useBackLayer(true, layer);
  return null;
}

function SystemBack() {
  useSystemBack(true);
  return null;
}

const ours = { michiBack: true };

describe('useSystemBack', () => {
  let push: ReturnType<typeof vi.spyOn>;
  let back: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    push = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
    back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const pop = (state: unknown) => act(() => { window.dispatchEvent(new PopStateEvent('popstate', { state })); });

  it('leaves the history alone while there is nothing to go back to', () => {
    render(<SystemBack />);
    expect(push).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it('puts an entry of its own on top while a layer is open, and steps the layer on Back', () => {
    const close = vi.fn();
    render(<><SystemBack /><Layer layer={{ back: close }} /></>);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject(ours);
    pop(null);
    expect(close).toHaveBeenCalledTimes(1);
    // Still open (the mock does not close it): ours goes back on top.
    act(() => { vi.runAllTimers(); });
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('takes its entry back off once the last layer closes, and ignores that pop', () => {
    const close = vi.fn();
    const view = render(<><SystemBack /><Layer layer={{ back: close }} /></>);
    view.rerender(<SystemBack />);
    expect(back).toHaveBeenCalledTimes(1);
    pop(null);
    expect(close).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe('useBackSwipe', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  function Host({ root }: { root?: () => SwipeTrack | null }) {
    useBackSwipe(true, root);
    return <div data-testid="page">page</div>;
  }
  const swipe = (target: Element) => {
    fireEvent.touchStart(target, { touches: [{ identifier: 1, clientX: 6, clientY: 300 }] });
    fireEvent.touchMove(target, { touches: [{ identifier: 1, clientX: 40, clientY: 300 }] });
    fireEvent.touchMove(target, { touches: [{ identifier: 1, clientX: 90, clientY: 300 }] });
    fireEvent.touchEnd(target, { touches: [] });
  };

  it('steps a layer with the edge arrow, which arms on the way and goes once released', () => {
    const close = vi.fn();
    const view = render(<><Host /><Layer layer={{ back: close }} /></>);
    const page = view.getByTestId('page');
    fireEvent.touchStart(page, { touches: [{ identifier: 1, clientX: 6, clientY: 300 }] });
    fireEvent.touchMove(page, { touches: [{ identifier: 1, clientX: 90, clientY: 300 }] });
    const arrow = document.querySelector<HTMLElement>('.back-swipe-arrow');
    expect(arrow?.dataset.armed).toBe('true');
    fireEvent.touchEnd(page, { touches: [] });
    expect(close).toHaveBeenCalledTimes(1);
    expect(arrow?.dataset.state).toBe('done');
  });

  it('gives the swipe to the root with nothing to go back to, but not under a modal', () => {
    const root = vi.fn((): SwipeTrack | null => null);
    const view = render(<Host root={root} />);
    swipe(view.getByTestId('page'));
    expect(root).toHaveBeenCalledTimes(1);
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    swipe(view.getByTestId('page'));
    expect(root).toHaveBeenCalledTimes(1);
  });

  it('leaves a layer that takes no swipe alone', () => {
    const close = vi.fn();
    const root = vi.fn((): SwipeTrack | null => null);
    const view = render(<><Host root={root} /><Layer layer={{ back: close, swipe: false }} /></>);
    swipe(view.getByTestId('page'));
    expect(close).not.toHaveBeenCalled();
    expect(root).not.toHaveBeenCalled();
  });
});
