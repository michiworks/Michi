import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS, PREFS_KEY, PrefsProvider, usePrefs, type Prefs } from './prefs';

const api = vi.hoisted(() => ({ fetchPrefs: vi.fn(), savePrefs: vi.fn() }));
vi.mock('../services/api', () => api);

// GET /prefs always carries the backend's permission settings.
const PERMISSIONS = { globalPermissions: false, permissionMode: 'ask', permissionApproveForMe: false, bypassPermissions: false };

let current: Prefs | undefined;
let setPref: ReturnType<typeof usePrefs>['setPref'];
function Probe() {
  const context = usePrefs();
  current = context.prefs;
  setPref = context.setPref;
  return null;
}
const mount = () => render(<PrefsProvider><Probe /></PrefsProvider>);
const answered = () => act(async () => {});
const debounce = (ms = 500) => act(async () => { vi.advanceTimersByTime(ms); });
const stored = () => localStorage.getItem(PREFS_KEY);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  current = undefined;
  api.savePrefs.mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("a browser without its own prefs (a new port, the phone's tunnel)", () => {
  it("starts from the backend's Settings, trash retention included", async () => {
    api.fetchPrefs.mockResolvedValue({ trashTTLDays: 0, paneWidthMode: 'fixed', cornerRadius: 8, homeRecommendations: false });
    await act(async () => { mount(); });
    expect(current).toMatchObject({ trashTTLDays: 0, paneWidthMode: 'fixed', cornerRadius: 8, homeRecommendations: false });
  });

  it('saves nothing before the backend answers, so a slow answer is not overwritten with defaults', async () => {
    vi.useFakeTimers();
    let answer!: (prefs: Record<string, unknown>) => void;
    api.fetchPrefs.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    mount();
    await debounce(2000);
    window.dispatchEvent(new Event('beforeunload'));
    expect(api.savePrefs).not.toHaveBeenCalled();
    expect(stored()).toBeNull();

    await act(async () => { answer({ trashTTLDays: 0, ...PERMISSIONS }); });
    await debounce();
    expect(JSON.parse(stored()!).trashTTLDays).toBe(0);
    expect(api.savePrefs).not.toHaveBeenCalled();
  });

  it('keeps a change made while the backend has not answered, and sends it once it has', async () => {
    vi.useFakeTimers();
    let answer!: (prefs: Record<string, unknown>) => void;
    api.fetchPrefs.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    mount();
    act(() => setPref('trashTTLDays', 90));
    await debounce();
    expect(JSON.parse(stored()!).trashTTLDays).toBe(90);
    expect(api.savePrefs).not.toHaveBeenCalled();

    await act(async () => { answer({ trashTTLDays: 0, cornerRadius: 8, ...PERMISSIONS }); });
    await debounce();
    expect(current).toMatchObject({ trashTTLDays: 90, cornerRadius: 8 });
    expect(api.savePrefs.mock.calls).toEqual([[{ trashTTLDays: 90 }]]);
  });

  it('sends no defaults when the backend cannot be read, and keeps no copy, so the next load reads it again', async () => {
    vi.useFakeTimers();
    api.fetchPrefs.mockResolvedValue(null);
    const view = mount();
    await answered();
    await debounce(2000);
    window.dispatchEvent(new Event('beforeunload'));
    expect(api.savePrefs).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    view.unmount();

    api.fetchPrefs.mockResolvedValue({ trashTTLDays: 0, ...PERMISSIONS });
    mount();
    await answered();
    expect(current?.trashTTLDays).toBe(0);
  });

  it('still saves what the user changes there, sending only that', async () => {
    vi.useFakeTimers();
    api.fetchPrefs.mockResolvedValue(null);
    mount();
    await answered();
    act(() => setPref('trashTTLDays', 90));
    await debounce();
    expect(api.savePrefs.mock.calls).toEqual([[{ trashTTLDays: 90 }]]);
    expect(JSON.parse(stored()!).trashTTLDays).toBe(90);
  });
});

describe("a browser with its own prefs, which only caches the backend's", () => {
  it("takes the backend's Settings over its copy, trash retention included, and keeps its per-device prefs", async () => {
    vi.useFakeTimers();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, trashTTLDays: 30, terminalPalette: 'bone', reduceMotion: true, sidebarCollapsed: true }));
    api.fetchPrefs.mockResolvedValue({ trashTTLDays: 0, terminalPalette: 'monokai', ...PERMISSIONS });
    mount();
    await answered();
    await debounce();
    expect(current).toMatchObject({ trashTTLDays: 0, terminalPalette: 'monokai', reduceMotion: true, sidebarCollapsed: true });
    expect(JSON.parse(stored()!)).toMatchObject({ trashTTLDays: 0, terminalPalette: 'monokai' });
    expect(api.savePrefs).not.toHaveBeenCalled();
  });

  it('gives the backend the server prefs it lacks from its copy, but not untouched defaults', async () => {
    vi.useFakeTimers();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, trashTTLDays: 0, paneWidthMode: 'fixed', terminalPalette: 'bone' }));
    api.fetchPrefs.mockResolvedValue({ terminalPalette: 'monokai', ...PERMISSIONS });
    mount();
    await answered();
    await debounce();
    expect(api.savePrefs.mock.calls).toEqual([[{ trashTTLDays: 0, paneWidthMode: 'fixed' }]]);
    expect(current).toMatchObject({ trashTTLDays: 0, paneWidthMode: 'fixed', terminalPalette: 'monokai' });
  });

  it('keeps a change made before the backend answers, and sends it', async () => {
    vi.useFakeTimers();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, trashTTLDays: 30 }));
    let answer!: (prefs: Record<string, unknown>) => void;
    api.fetchPrefs.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    mount();
    act(() => setPref('trashTTLDays', 90));
    await act(async () => { answer({ trashTTLDays: 0, terminalPalette: 'monokai', ...PERMISSIONS }); });
    await debounce();
    expect(current).toMatchObject({ trashTTLDays: 90, terminalPalette: 'monokai' });
    expect(api.savePrefs.mock.calls).toEqual([[{ trashTTLDays: 90 }]]);
  });

  it('keeps using its copy when the backend cannot be read', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ trashTTLDays: 0, terminalPalette: 'bone' }));
    api.fetchPrefs.mockResolvedValue(null);
    await act(async () => { mount(); });
    expect(current).toMatchObject({ trashTTLDays: 0, terminalPalette: 'bone' });
  });
});

describe('saving to the backend', () => {
  it('sends only the server prefs that changed', async () => {
    vi.useFakeTimers();
    api.fetchPrefs.mockResolvedValue({ trashTTLDays: 0, terminalPalette: 'bone', ...PERMISSIONS });
    mount();
    await answered();
    act(() => { setPref('trashTTLDays', 90); setPref('sidebarCollapsed', true); });
    await debounce();
    expect(api.savePrefs.mock.calls).toEqual([[{ trashTTLDays: 90 }]]);
    expect(JSON.parse(stored()!)).toMatchObject({ trashTTLDays: 90, sidebarCollapsed: true, terminalPalette: 'bone' });
  });

  it('sends a change again with the next one when its save failed', async () => {
    vi.useFakeTimers();
    api.fetchPrefs.mockResolvedValue({ ...PERMISSIONS });
    api.savePrefs.mockResolvedValueOnce(false);
    mount();
    await answered();
    act(() => setPref('trashTTLDays', 90));
    await debounce();
    act(() => setPref('cornerRadius', 8));
    await debounce();
    expect(api.savePrefs.mock.calls).toEqual([[{ trashTTLDays: 90 }], [{ trashTTLDays: 90, cornerRadius: 8 }]]);
  });
});
