import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVEAL_FLASH_MS, flashRevealed } from '../../../../state/pages/revealPageTarget';
import { flashBlock } from './vendor-blocks/src/desk/peek/use-peek';

function block() {
  const el = document.createElement('div');
  el.scrollIntoView = vi.fn();
  return el;
}

describe('the Contents block’s pick', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.reduceMotion;
  });

  it('glides to the block it lands on, inside the page being read (TR-27)', () => {
    const el = block();
    flashBlock(el)();
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('lands at once under either reduced-motion trigger (MO-14)', () => {
    const byApp = block();
    document.documentElement.dataset.reduceMotion = 'on';
    flashBlock(byApp)();
    expect(byApp.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
    delete document.documentElement.dataset.reduceMotion;
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    const byOs = block();
    flashBlock(byOs)();
    expect(byOs.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
  });

  it('holds the Pages outline’s flash while the block arrives, as long as a reveal from elsewhere (MO-24)', () => {
    vi.useFakeTimers();
    const el = block();
    flashBlock(el);
    expect(el.hasAttribute('data-reveal-flash')).toBe(true);
    expect(el.hasAttribute('data-flash')).toBe(false);
    vi.advanceTimersByTime(REVEAL_FLASH_MS - 1);
    expect(el.hasAttribute('data-reveal-flash')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute('data-reveal-flash')).toBe(false);
  });

  it('puts out the block lit before, so a second pick lights only its own', () => {
    vi.useFakeTimers();
    const first = block();
    const second = block();
    flashBlock(first);
    vi.advanceTimersByTime(200);
    flashBlock(second);
    expect(first.hasAttribute('data-reveal-flash')).toBe(false);
    expect(second.hasAttribute('data-reveal-flash')).toBe(true);
    vi.advanceTimersByTime(REVEAL_FLASH_MS);
    expect(second.hasAttribute('data-reveal-flash')).toBe(false);
  });

  it('restarts the flash on a second pick of the same block, which the first pick’s put-out cannot cut short', () => {
    vi.useFakeTimers();
    const el = block();
    const firstOut = flashBlock(el);
    vi.advanceTimersByTime(1000);
    flashBlock(el);
    firstOut();
    expect(el.hasAttribute('data-reveal-flash')).toBe(true);
    vi.advanceTimersByTime(REVEAL_FLASH_MS - 1);
    expect(el.hasAttribute('data-reveal-flash')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute('data-reveal-flash')).toBe(false);
  });

  it('shares one flash with a reveal from elsewhere, so whichever lands last holds its full length', () => {
    vi.useFakeTimers();
    const el = block();
    flashRevealed(el);
    vi.advanceTimersByTime(1000);
    flashBlock(el);
    vi.advanceTimersByTime(REVEAL_FLASH_MS - 1);
    expect(el.hasAttribute('data-reveal-flash')).toBe(true);
    flashRevealed(el);
    vi.advanceTimersByTime(REVEAL_FLASH_MS - 1);
    expect(el.hasAttribute('data-reveal-flash')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute('data-reveal-flash')).toBe(false);
  });
});
