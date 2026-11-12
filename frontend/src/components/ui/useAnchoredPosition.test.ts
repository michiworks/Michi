import { describe, expect, it } from 'vitest';
import { pickMenuSide, placeBelowAnchor } from './useAnchoredPosition';

// jsdom's viewport: 1024 × 768. Each row is what one panel computed for itself
// before they shared this rule, for a 240 × 200 surface.
const SIZE = { width: 240, height: 200 };
const NEAR_TOP = { left: 20, right: 60, top: 10, bottom: 30 };
const NEAR_BOTTOM = { left: 300, right: 340, top: 700, bottom: 720 };
const NEAR_RIGHT = { left: 1000, right: 1020, top: 300, bottom: 320 };

describe('placeBelowAnchor', () => {
  it.each([
    ['DbPopover, MichiMenu (start, gap 4)', { align: 'start', gap: 4 }, [20, 34], [300, 496], [776, 324]],
    ['DbPopover, MichiMenu, LayoutRulesPopover (end, gap 4)', { align: 'end', gap: 4 }, [8, 34], [100, 496], [776, 324]],
    ['SourcesPopover, AskPopover (end, gap 6)', { align: 'end', gap: 6 }, [8, 36], [100, 494], [776, 326]],
    ['SourcePopover (start, lead 40, gap 6)', { align: 'start', lead: 40, gap: 6 }, [8, 36], [260, 494], [776, 326]],
  ] as const)('%s', (_name, options, top, bottom, right) => {
    expect(placeBelowAnchor(NEAR_TOP, SIZE, options)).toEqual({ left: top[0], top: top[1] });
    expect(placeBelowAnchor(NEAR_BOTTOM, SIZE, options)).toEqual({ left: bottom[0], top: bottom[1] });
    expect(placeBelowAnchor(NEAR_RIGHT, SIZE, options)).toEqual({ left: right[0], top: right[1] });
  });

  it('stays below when it fits on neither side, and hangs from a point', () => {
    expect(placeBelowAnchor({ left: 100, right: 140, top: 300, bottom: 320 }, { width: 240, height: 740 }, { gap: 4 })).toEqual({ left: 100, top: 324 });
    expect(placeBelowAnchor({ left: 500, right: 500, top: 400, bottom: 400 }, SIZE, { gap: 4 })).toEqual({ left: 500, top: 404 });
  });
});

describe('pickMenuSide', () => {
  it.each([
    // aboveSpace, belowSpace, wanted, preferBelow, side
    [400, 300, 350, false, 'above'], // fits above, the preferred side
    [200, 400, 350, false, 'below'], // fits only below
    [300, 200, 350, false, 'above'], // fits nowhere: the roomier side
    [200, 300, 350, false, 'below'],
    [436, 352, 300, true, 'below'], // fits below, the preferred side
    [436, 352, 372, true, 'above'], // fits only above
    [300, 340, 372, true, 'below'], // fits nowhere: the roomier side
  ] as const)('above %d, below %d, %dpx wanted, preferBelow %s: %s', (aboveSpace, belowSpace, wanted, preferBelow, side) => {
    expect(pickMenuSide({ aboveSpace, belowSpace, wanted, preferBelow })).toBe(side);
  });
});
