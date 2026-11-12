import { describe, expect, it } from 'vitest';
import { resolvePaneLayout } from './paneLayout';

describe('pane width modes', () => {
  it('ignores invalid custom widths and handles an empty or unmeasured strip', () => {
    expect(resolvePaneLayout({ mode: 'fixed', paneCount: 3, viewportWidth: 1200, defaultPaneWidth: 800, customWidths: [NaN, -2, Infinity] }).widths).toEqual([800, 800, 800]);
    expect(resolvePaneLayout({ paneCount: 0, viewportWidth: 0, defaultPaneWidth: 800 })).toMatchObject({ widths: [], gridTemplateColumns: 'none', overflow: false, paddingRight: 0 });
  });
});

describe('pane zoom', () => {
  it('gives the zoomed pane the whole strip and the others no track', () => {
    expect(resolvePaneLayout({ mode: 'half', paneCount: 3, viewportWidth: 1220, padding: 10, gap: 4, defaultPaneWidth: 800, customWidths: [500], zoomedIndex: 1 }))
      .toEqual({ widths: [0, 1200, 0], overflow: false, paddingRight: 10, gridTemplateColumns: '1200px' });
    // One pane is already full width; an index outside the strip is no zoom.
    expect(resolvePaneLayout({ paneCount: 1, viewportWidth: 900, defaultPaneWidth: 800, zoomedIndex: 0 }).gridTemplateColumns).toBe('900px');
    expect(resolvePaneLayout({ mode: 'half', paneCount: 2, viewportWidth: 1000, defaultPaneWidth: 800, zoomedIndex: 2 }).widths).toEqual([500, 500]);
  });
});
