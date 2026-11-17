import { describe, expect, it } from 'vitest';
import { PANE_ENTER_MS, paneEntrance } from './paneMotion';

describe('paneEntrance', () => {
  it('raises the content of a new pane 4px over the track time', () => {
    const { frames: [from, to], duration } = paneEntrance();
    expect(from.transform).toBe('translateY(4px)');
    expect(to.transform).toBe('translate(0px, 0px)');
    expect(duration).toBe(PANE_ENTER_MS);
  });

  it('never fades: the populated content stays opaque over the pane', () => {
    expect(paneEntrance().frames.every((frame) => frame.opacity === 1)).toBe(true);
  });
});
