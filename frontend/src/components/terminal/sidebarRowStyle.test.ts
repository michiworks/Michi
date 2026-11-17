import { describe, it, expect } from 'vitest';
import { rowGeom, caretKebabClearance, SIDEBAR_ROW_STYLES } from './sidebarRowStyle';

describe('caretKebabClearance', () => {
  it('never goes negative', () => {
    for (const style of SIDEBAR_ROW_STYLES) {
      expect(caretKebabClearance(rowGeom(style))).toBeGreaterThanOrEqual(0);
    }
  });
});
