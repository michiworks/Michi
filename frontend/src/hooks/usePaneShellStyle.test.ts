import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { paneRecedeOpacity, paneSurface, usePaneShellStyle } from './usePaneShellStyle';

// --- Mocks ---

const mockPrefs = { paneRules: true, focusDim: 40 };
vi.mock('../state/prefs', () => ({
  usePrefs: () => ({ prefs: mockPrefs }),
}));

let mockFocusedPane: string | null = null;
vi.mock('../state/chatStore', () => ({
  useChatStore: () => ({ focusedPane: mockFocusedPane }),
}));

/** How far the shell's recede element has sunk, or null when it renders none. */
const dimOf = (shell: ReturnType<typeof usePaneShellStyle>) =>
  shell.recede ? (shell.recede.props as { style: React.CSSProperties }).style.opacity : null;

describe('paneRecedeOpacity', () => {
  it('doubles the strength and holds at a surface fully sunk', () => {
    expect(paneRecedeOpacity(0)).toBe(0);
    expect(paneRecedeOpacity(20)).toBeCloseTo(0.4);
    expect(paneRecedeOpacity(30)).toBeCloseTo(0.6);
    expect(paneRecedeOpacity(50)).toBe(1);
    expect(paneRecedeOpacity(100)).toBe(1);
  });
});

describe('paneSurface', () => {
  it('mixes the recede fill into the pane, and leaves a focused pane its own colour', () => {
    expect(paneSurface(0)).toBe('var(--term-pane-bg, var(--term-surface))');
    expect(paneSurface(0.4)).toBe(
      'color-mix(in srgb, var(--term-recede-fill) 40%, var(--term-pane-bg, var(--term-surface)))',
    );
  });
});

describe('usePaneShellStyle', () => {
  beforeEach(() => {
    mockFocusedPane = null;
    mockPrefs.paneRules = true;
    mockPrefs.focusDim = 40;
  });

  it('sinks an unfocused pane with its recede element, not a filter, opacity or property on the pane', () => {
    mockFocusedPane = 'other-node';
    const { result } = renderHook(() => usePaneShellStyle('node-1'));
    // The filter re-ran over the whole subtree, and so would an inherited
    // property on the root: the recede element carries the sink itself.
    const { style } = result.current;
    expect(style.filter).toBeUndefined();
    expect(style.opacity).toBeUndefined();
    expect(Object.keys(style).filter((key) => key.startsWith('--'))).toEqual([]);
    expect(result.current.recede?.props).toMatchObject({ className: 'terminal-pane__recede', 'aria-hidden': true });
    expect(dimOf(result.current)).toBeCloseTo(0.8);
    // Bands that paint over the pane's content take the sunk colour themselves.
    expect(result.current.surface).toContain('var(--term-recede-fill) 80%');
    // The recede sits on a negative rung, so the pane must be its stacking context.
    expect(style.isolation).toBe('isolate');
    expect(style.position).toBe('relative');
  });

  it('keeps the root style when focus moves, so only the recede restyles', () => {
    mockFocusedPane = 'other-node';
    const { result, rerender } = renderHook(() => usePaneShellStyle('node-1'));
    const before = result.current.style;
    mockFocusedPane = 'node-1';
    rerender();
    expect(result.current.style).toBe(before);
    expect(dimOf(result.current)).toBe(0);
  });

  it('leaves the focused pane, and every pane while none is focused, at its own surface', () => {
    mockFocusedPane = 'node-1';
    const focused = renderHook(() => usePaneShellStyle('node-1')).result.current;
    expect(dimOf(focused)).toBe(0);
    expect(focused.surface).toBe('var(--term-pane-bg, var(--term-surface))');
    mockFocusedPane = null;
    expect(dimOf(renderHook(() => usePaneShellStyle('node-1')).result.current)).toBe(0);
  });

  it('never sinks a pane that opts out', () => {
    mockFocusedPane = 'other-node';
    const { result } = renderHook(() => usePaneShellStyle('node-1', { dim: false }));
    expect(result.current.recede).toBeNull();
    expect(result.current.surface).toBe('var(--term-pane-bg, var(--term-surface))');
  });
});
// The recede itself (.terminal-pane__recede in index.css: the palette's deep
// surface, under the pane's content, pointer-events none) is checked in a real
// browser by e2e/specs/pane-focus-dim.spec.ts; Vitest loads no CSS.
