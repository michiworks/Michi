import { SERVER_PREF_KEYS } from 'michi-shared';
import { CORNER_RADIUS_MAX, DEFAULT_PREFS, PREF_STORAGE, normalizeCornerRadius } from './prefs';

describe('DEFAULT_PREFS', () => {
  it('has slate as default terminal palette', () => {
    expect(DEFAULT_PREFS.terminalPalette).toBe('slate');
  });

  it('defaults singlePaneContentWidth to 676', () => {
    expect(DEFAULT_PREFS.singlePaneContentWidth).toBe(676);
  });

  it('has empty per-palette accent overrides by default', () => {
    expect(DEFAULT_PREFS.terminalAccentOverrides).toEqual({});
  });

  it('has compact density by default', () => {
    expect(DEFAULT_PREFS.terminalDensity).toBe('compact');
  });

  it('has pane hairline rules enabled by default', () => {
    expect(DEFAULT_PREFS.paneRules).toBe(true);
  });

  it('starts with the sidebar expanded (sidebarCollapsed = false)', () => {
    expect(DEFAULT_PREFS.sidebarCollapsed).toBe(false);
  });

  it('gives a new profile a 252px sidebar', () => {
    expect(DEFAULT_PREFS.terminalSidebarWidth).toBe(252);
  });

  it('keeps window glass on until the user turns it off', () => {
    expect(DEFAULT_PREFS.windowGlass).toBe(true);
  });

  it('keeps Digest off until the user turns it on', () => {
    expect(DEFAULT_PREFS.digestEnabled).toBe(false);
  });
});

describe('Kiro sidecar title preference', () => {
  it('is disabled by default', () => {
    expect(DEFAULT_PREFS.enableKiroSidecarTitles).toBe(false);
  });
});

describe('Corner radius preference', () => {
  it('clamps and rounds persisted values, falling back on malformed ones', () => {
    expect(normalizeCornerRadius(-3)).toBe(0);
    expect(normalizeCornerRadius(99)).toBe(CORNER_RADIUS_MAX);
    expect(normalizeCornerRadius(6.6)).toBe(7);
    expect(normalizeCornerRadius('8')).toBe(DEFAULT_PREFS.cornerRadius);
    expect(normalizeCornerRadius(Number.NaN)).toBe(DEFAULT_PREFS.cornerRadius);
  });
});

describe('where prefs are kept', () => {
  it('keeps on the backend exactly the keys it persists', () => {
    const server = Object.entries(PREF_STORAGE).filter(([, where]) => where === 'server').map(([key]) => key);
    expect(server.sort()).toEqual([...SERVER_PREF_KEYS].sort());
  });
});
