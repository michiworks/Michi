import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotionGlobalConfig } from 'motion/react';
import { SEND_GLIDE, glideToTail } from './sendScroll';

// setupTests skips motion's animations; these tests are about the frames between.
const skip = MotionGlobalConfig.skipAnimations;
beforeEach(() => { MotionGlobalConfig.skipAnimations = false; });
afterEach(() => { MotionGlobalConfig.skipAnimations = skip; });

/** A scroller with a writable scrollTop and a fixed viewport, as jsdom lays out nothing. */
function scroller(scrollTop: number, clientHeight = 600): HTMLElement {
  const el = document.createElement('div');
  let top = scrollTop;
  Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = v; }, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  document.body.appendChild(el);
  return el;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SEND_GLIDE.duration * 1000 + 200));

describe('glideToTail', () => {
  it('lands at once under reduced motion', () => {
    const el = scroller(100);
    const onDone = vi.fn();
    glideToTail(el, { target: () => 220, reduce: true, onDone });
    expect(el.scrollTop).toBe(220);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('finishes at once when there is nothing to travel', () => {
    const el = scroller(300);
    const onDone = vi.fn();
    glideToTail(el, { target: () => 300, onDone });
    expect(el.scrollTop).toBe(300);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('glides to an end that moves while it travels', async () => {
    const el = scroller(1000);
    let end = 1100;
    const onDone = vi.fn();
    const onFrame = vi.fn();
    glideToTail(el, { target: () => end, onDone, onFrame });
    // The first reply token lands mid-glide and grows the transcript
    setTimeout(() => { end = 1140; }, 120);
    await settle();
    expect(el.scrollTop).toBe(1140);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls.length).toBeGreaterThan(1);
  });

  it('runs on the timing it is given: a send that rides the keyboard', async () => {
    const keyboard = scroller(1000);
    const glide = scroller(1000);
    const keyboardDone = vi.fn();
    const glideDone = vi.fn();
    glideToTail(keyboard, { target: () => 1100, onDone: keyboardDone, timing: { duration: 0.08, ease: [0.38, 0.7, 0.125, 1] } });
    glideToTail(glide, { target: () => 1100, onDone: glideDone });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(keyboardDone).toHaveBeenCalledTimes(1);
    expect(keyboard.scrollTop).toBe(1100);
    // SEND_GLIDE is still travelling.
    expect(glideDone).not.toHaveBeenCalled();
    await settle();
    expect(glideDone).toHaveBeenCalledTimes(1);
  });

  it('starts a send from far up the history close to the end', () => {
    const el = scroller(0, 600);
    glideToTail(el, { target: () => 5000 });
    // A third of the viewport short, not the whole history away
    expect(el.scrollTop).toBe(4800);
  });

  it('leaves the scroll with the reader when they wheel mid-glide', async () => {
    const el = scroller(1000);
    const onDone = vi.fn();
    const onInterrupt = vi.fn();
    glideToTail(el, { target: () => 1200, onDone, onInterrupt });
    await new Promise((resolve) => setTimeout(resolve, 60));
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -80 }));
    const at = el.scrollTop;
    await settle();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(el.scrollTop).toBe(at);
  });

  it('cancels without reporting either ending', async () => {
    const el = scroller(1000);
    const onDone = vi.fn();
    const onInterrupt = vi.fn();
    const cancel = glideToTail(el, { target: () => 1200, onDone, onInterrupt });
    cancel();
    await settle();
    expect(onDone).not.toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(el.scrollTop).toBeLessThan(1200);
  });
});
