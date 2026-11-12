import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { paneDimOpacity, usePaneShellStyle } from './usePaneShellStyle';

// --- Mocks ---

const mockPrefs = { paneRules: true, focusDim: 40 };
vi.mock('../state/prefs', () => ({
  usePrefs: () => ({ prefs: mockPrefs }),
}));

let mockFocusedPane: string | null = null;
vi.mock('../state/chatStore', () => ({
  useChatStore: () => ({ focusedPane: mockFocusedPane }),
}));

const dimOf = (style: React.CSSProperties) => (style as Record<string, unknown>)['--pane-dim'];

describe('usePaneShellStyle', () => {
  beforeEach(() => {
    mockFocusedPane = null;
    mockPrefs.paneRules = true;
    mockPrefs.focusDim = 40;
  });

  it('dims an unfocused pane with the veil, not a filter or opacity on the pane', () => {
    mockFocusedPane = 'other-node';
    const { result } = renderHook(() => usePaneShellStyle('node-1'));
    // The filter re-ran over the whole subtree; the veil (.terminal-pane::after) reads this.
    expect(result.current.filter).toBeUndefined();
    expect(result.current.opacity).toBeUndefined();
    // 40% focus dim at the old brightness factor: brightness(0.76) is a 0.24 black veil.
    expect(dimOf(result.current)).toBeCloseTo(0.24);
    expect(result.current.isolation).toBe('isolate');
    expect(result.current.position).toBe('relative');
  });

  it('leaves the focused pane, and every pane while none is focused, without a veil', () => {
    mockFocusedPane = 'node-1';
    expect(dimOf(renderHook(() => usePaneShellStyle('node-1')).result.current)).toBe(0);
    mockFocusedPane = null;
    expect(dimOf(renderHook(() => usePaneShellStyle('node-1')).result.current)).toBe(0);
  });

  it('never dims a pane that opts out', () => {
    mockFocusedPane = 'other-node';
    const { result } = renderHook(() => usePaneShellStyle('node-1', { dim: false }));
    expect(dimOf(result.current)).toBe(0);
  });

  it('matches the brightness() the Topbar caption cell keeps', () => {
    for (const focusDim of [0, 20, 40, 100]) {
      // A black veil at opacity a over color c leaves c * (1 - a): brightness(1 - a).
      expect(1 - paneDimOpacity(focusDim)).toBeCloseTo(1 - (focusDim / 100) * 0.6);
    }
  });
});
// The veil itself (.terminal-pane::after in index.css: black, pointer-events
// none, over the pane's raised children) is checked in a real browser by
// e2e/specs/pane-focus-dim.spec.ts; Vitest loads no CSS.
