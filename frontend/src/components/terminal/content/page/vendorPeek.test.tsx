import { afterEach, describe, expect, it, vi } from 'vitest';
import { DUR } from '../../../../motion/tokens';
import { flashBlock } from './vendor-blocks/src/desk/peek/use-peek';

describe('the Contents block’s flash', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('lights a block for as long as the page’s slow transition, which a reduced-motion tint lasts too', () => {
    vi.useFakeTimers();
    const block = document.createElement('div');
    flashBlock(block);
    expect(block.hasAttribute('data-flash')).toBe(true);
    vi.advanceTimersByTime(DUR.slow * 1000 - 1);
    expect(block.hasAttribute('data-flash')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(block.hasAttribute('data-flash')).toBe(false);
  });
});
