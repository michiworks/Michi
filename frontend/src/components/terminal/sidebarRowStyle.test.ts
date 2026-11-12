import { describe, it, expect } from 'vitest';
import { rowGeom, caretKebabClearance, SIDEBAR_ROW_STYLES } from './sidebarRowStyle';

describe('caretKebabClearance', () => {
  it('never goes negative', () => {
    for (const style of SIDEBAR_ROW_STYLES) {
      for (const insetPref of [0, 2, 8, 12, 24]) {
        expect(caretKebabClearance(rowGeom(style, insetPref))).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
