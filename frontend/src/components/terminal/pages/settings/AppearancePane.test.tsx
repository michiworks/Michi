import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS, type Prefs } from '../../../../state/prefs';
import { settingsSearchIndex } from '../../rail/settingsSearch';
import { AppearancePane } from './AppearancePane';
import { SettingsLayoutContext, SettingsTargetContext } from './settingsPhone';

const setPref = vi.fn();
const state = vi.hoisted(() => ({ prefs: null as Prefs | null }));
vi.mock('../../../../state/prefs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../state/prefs')>();
  return { ...actual, usePrefs: () => ({ prefs: state.prefs ?? actual.DEFAULT_PREFS, setPref }) };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); state.prefs = null; delete window.electron; });

/** The names of the rows shown, in order. */
const rowNames = () => Array.from(document.querySelectorAll('.settings-row__label')).map((label) => label.textContent);
/** Group headings, in order. */
const groups = () => Array.from(document.querySelectorAll('.settings-section__title')).map((title) => title.textContent);
const advanced = () => screen.getByRole('button', { name: /Advanced/i });

describe('Appearance pane heading', () => {
  it('leaves the page heading to the Settings column', () => {
    render(<AppearancePane />);
    expect(screen.queryByRole('heading', { name: 'Appearance' })).toBeNull();
  });
});

describe('Appearance at a glance', () => {
  it('shows the few decisions as rows under their groups, and keeps everything else in a closed Advanced', () => {
    render(<AppearancePane />);
    expect(groups()).toEqual(['Theme', 'Reading', 'Panes', 'Home', 'Features', 'Advanced']);
    expect(rowNames()).toEqual(['Palette', 'Accent', 'Density', 'Text size', 'Dim unfocused panes', 'Single-page mode', 'Reduce motion', 'Pages recommendations', 'Digest']);
    expect(advanced().getAttribute('aria-expanded')).toBe('false');
    expect(advanced().getAttribute('aria-controls')).toBeNull();
    // One row under the Advanced label says what it holds, and names itself by both.
    expect(advanced().textContent).toBe('Fonts, code blocks, glass, corner radius and 12 more');
    expect(advanced().closest('.settings-section')!.querySelector('.settings-section__title')!.textContent).toBe('Advanced');
    fireEvent.click(advanced());
    expect(advanced().getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(advanced().getAttribute('aria-controls')!)).toBeTruthy();
    expect(rowNames().slice(9)).toEqual(['Interface font', 'Message font', 'Composer size', 'Code blocks', 'Code wrap', 'Agent blocks',
      'Corner radius', 'Sidebar row style', 'Sidebar edge padding', 'Sidebar timestamps', 'Sidebar glass', 'Glass blur',
      'Glass saturation', 'Glass defaults', 'Dim strength', 'Pane width mode', 'Pane animation', 'Default pane width',
      'Single-pane reading width', 'Chrome rules']);
    fireEvent.click(advanced());
    expect(rowNames()).toHaveLength(9);
  });

  it('counts in its "N more" the Advanced rows its line does not name', () => {
    const named = new Set(['Interface font', 'Message font', 'Code blocks', 'Corner radius', 'Window glass', 'Sidebar glass', 'Glass blur',
      'Glass saturation', 'Sidebar material', 'Glass defaults']);
    for (const layout of ['window', 'phone'] as const) {
      const { unmount } = render(<SettingsLayoutContext.Provider value={layout}><AppearancePane /></SettingsLayoutContext.Provider>);
      const shown = rowNames().length;
      fireEvent.click(advanced());
      const unnamed = rowNames().slice(shown).filter((name) => !named.has(name!));
      expect(advanced().textContent).toBe(`Fonts, code blocks, glass, corner radius and ${unnamed.length} more`);
      unmount();
    }
  });

  it('picks the code and agent block styles under Advanced', () => {
    render(<AppearancePane />);
    fireEvent.click(advanced());
    const code = screen.getByRole('radiogroup', { name: 'Code blocks' });
    expect((within(code).getByRole('radio', { name: 'Hairline' }) as HTMLInputElement).checked).toBe(DEFAULT_PREFS.codeBlockStyle === 'hairline');
    fireEvent.click(within(code).getByRole('radio', { name: 'Header' }));
    expect(setPref).toHaveBeenCalledWith('codeBlockStyle', 'header');
    const agent = screen.getByRole('radiogroup', { name: 'Agent blocks' });
    expect(within(agent).getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual(['line', 'plain', 'card', 'terminal']);
    expect((within(agent).getByRole('radio', { name: 'Line' }) as HTMLInputElement).checked).toBe(DEFAULT_PREFS.agentBlockStyle === 'line');
    fireEvent.click(within(agent).getByRole('radio', { name: 'Terminal' }));
    expect(setPref).toHaveBeenCalledWith('agentBlockStyle', 'terminal');
  });

  it('tunes the glass and puts it back to its defaults, leaving Window glass as set', () => {
    state.prefs = { ...DEFAULT_PREFS, glassBlur: 30, sidebarTranslucency: 20, windowGlass: false };
    window.electron = { hasVibrancy: true } as unknown as typeof window.electron;
    render(<AppearancePane />);
    fireEvent.click(advanced());
    expect((screen.getByRole('slider', { name: 'Glass blur' }) as HTMLInputElement).value).toBe('30');
    fireEvent.change(screen.getByRole('slider', { name: 'Glass saturation' }), { target: { value: '180' } });
    expect(setPref).toHaveBeenCalledWith('glassSaturate', 180);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sidebar material' }), { target: { value: 'hud' } });
    expect(setPref).toHaveBeenCalledWith('sidebarVibrancy', 'hud');
    setPref.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(Object.fromEntries(setPref.mock.calls)).toEqual({
      sidebarTranslucency: DEFAULT_PREFS.sidebarTranslucency, glassBlur: DEFAULT_PREFS.glassBlur, glassSaturate: DEFAULT_PREFS.glassSaturate,
      sidebarVibrancy: DEFAULT_PREFS.sidebarVibrancy,
    });
  });

  it('offers no glass reset while the glass is as tuned, and no material picker without vibrancy', () => {
    render(<AppearancePane />);
    fireEvent.click(advanced());
    expect((screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('combobox', { name: 'Sidebar material' })).toBeNull();
  });

  it('keeps Window glass under Advanced where the window can be see-through', () => {
    window.electron = { hasVibrancy: true } as unknown as typeof window.electron;
    render(<AppearancePane />);
    expect(screen.queryByText('Window glass')).toBeNull();
    fireEvent.click(advanced());
    fireEvent.click(screen.getByRole('switch', { name: 'Window glass' }));
    expect(setPref).toHaveBeenCalledWith('windowGlass', !DEFAULT_PREFS.windowGlass);
  });

  it('sets the sidebar density and the message text size', () => {
    render(<AppearancePane />);
    const density = screen.getByRole('radiogroup', { name: 'Density' });
    expect((within(density).getByRole('radio', { name: 'Comfortable' }) as HTMLInputElement).checked).toBe(DEFAULT_PREFS.sidebarDensity === 'comfortable');
    fireEvent.click(within(density).getByRole('radio', { name: 'Compact' }));
    expect(setPref).toHaveBeenCalledWith('sidebarDensity', 'compact');
    const size = screen.getByRole('radiogroup', { name: 'Text size' });
    expect(within(size).getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual(['14', '15', '16', '18']);
    expect((within(size).getByRole('radio', { name: '16' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(size).getByRole('radio', { name: '18' }));
    expect(setPref).toHaveBeenCalledWith('messageFontSize', 18);
  });

  it('shows a text size set elsewhere as the chosen one', () => {
    state.prefs = { ...DEFAULT_PREFS, messageFontSize: 17.5 };
    render(<AppearancePane />);
    const size = screen.getByRole('radiogroup', { name: 'Text size' });
    expect(within(size).getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual(['14', '15', '16', '17.5', '18']);
    expect((within(size).getByRole('radio', { name: '17.5' }) as HTMLInputElement).checked).toBe(true);
  });

  it('turns the switches on and off', () => {
    render(<AppearancePane />);
    fireEvent.click(screen.getByRole('switch', { name: 'Reduce motion' }));
    expect(setPref).toHaveBeenCalledWith('reduceMotion', !DEFAULT_PREFS.reduceMotion);
    fireEvent.click(screen.getByRole('switch', { name: 'Pages recommendations on Home' }));
    expect(setPref).toHaveBeenCalledWith('homeRecommendations', !DEFAULT_PREFS.homeRecommendations);
  });
});

describe('Appearance focus dimming', () => {
  afterEach(() => window.localStorage.removeItem('michi:focusDimStrength'));
  const dimSwitch = () => screen.getByRole('switch', { name: 'Dim unfocused panes' });
  const strength = () => screen.getByRole('slider', { name: 'Dim strength' }) as HTMLInputElement;

  it('is a switch on the page and a strength under Advanced, both reading the one focusDim pref', () => {
    state.prefs = { ...DEFAULT_PREFS, focusDim: 35 };
    render(<AppearancePane />);
    expect(dimSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('slider', { name: 'Dim strength' })).toBeNull();
    fireEvent.click(advanced());
    expect(strength().value).toBe('35');
    expect(strength().min).toBe('5');
  });

  it('turns off to 0 and back on to the strength it had', () => {
    state.prefs = { ...DEFAULT_PREFS, focusDim: 45 };
    const { rerender } = render(<AppearancePane />);
    fireEvent.click(dimSwitch());
    expect(setPref).toHaveBeenLastCalledWith('focusDim', 0);
    state.prefs = { ...DEFAULT_PREFS, focusDim: 0 };
    rerender(<AppearancePane />);
    expect(dimSwitch().getAttribute('aria-checked')).toBe('false');
    // While off, Advanced shows the strength it comes back with.
    fireEvent.click(advanced());
    expect(strength().value).toBe('45');
    fireEvent.click(dimSwitch());
    expect(setPref).toHaveBeenLastCalledWith('focusDim', 45);
  });

  it('comes on at 20% when no strength was chosen', () => {
    state.prefs = { ...DEFAULT_PREFS, focusDim: 0 };
    render(<AppearancePane />);
    fireEvent.click(dimSwitch());
    expect(setPref).toHaveBeenCalledExactlyOnceWith('focusDim', 20);
  });

  it('turns dimming on when its strength is moved, and keeps that strength for the next time it is turned on', () => {
    state.prefs = { ...DEFAULT_PREFS, focusDim: 0 };
    const { rerender } = render(<AppearancePane />);
    fireEvent.click(advanced());
    fireEvent.change(strength(), { target: { value: '60' } });
    expect(setPref).toHaveBeenLastCalledWith('focusDim', 60);
    state.prefs = { ...DEFAULT_PREFS, focusDim: 60 };
    rerender(<AppearancePane />);
    expect(dimSwitch().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(dimSwitch());
    expect(setPref).toHaveBeenLastCalledWith('focusDim', 0);
    state.prefs = { ...DEFAULT_PREFS, focusDim: 0 };
    rerender(<AppearancePane />);
    fireEvent.click(dimSwitch());
    expect(setPref).toHaveBeenLastCalledWith('focusDim', 60);
  });
});

describe('Appearance pane width modes', () => {

  it('uses the reading width default without rounding it to a 20px step', () => {
    render(<AppearancePane />);
    fireEvent.click(advanced());
    const slider = screen.getByRole('slider', { name: 'Single-pane reading width' });
    expect((slider as HTMLInputElement).value).toBe('676');
    fireEvent.change(slider, { target: { value: '720' } });
    expect(setPref).toHaveBeenCalledExactlyOnceWith('singlePaneContentWidth', 720);
  });

  it('retains the shared width slider', () => {
    render(<AppearancePane />);
    fireEvent.click(advanced());
    fireEvent.change(screen.getByRole('slider', { name: 'Default pane width' }), { target: { value: '800' } });
    expect(setPref).toHaveBeenCalledExactlyOnceWith('defaultPaneWidth', 800);
  });
});

describe('Appearance swatches', () => {
  const name = (palette: string) => palette.charAt(0).toUpperCase() + palette.slice(1);

  it('show the palettes as named buttons, saying which one is chosen', () => {
    render(<AppearancePane />);
    const palettes = within(screen.getByRole('group', { name: 'Palette' })).getAllByRole('button');
    expect(palettes.map((button) => button.textContent)).toEqual(['Bone', 'Slate', 'Monokai', 'Gruvbox']);
    for (const button of palettes) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('aria-pressed')).toBe(String(button.textContent === name(DEFAULT_PREFS.terminalPalette)));
    }
    // Each is a small window in its own palette's colours, not the current theme's.
    const thumb = screen.getByRole('button', { name: 'Monokai' }).querySelector<HTMLElement>('.settings-theme__thumb')!;
    expect(thumb.style.getPropertyValue('--thumb-page')).toBe('#272822');
    expect(thumb.style.getPropertyValue('--thumb-ink')).toBe('#f8f8f2');
    expect(thumb.style.getPropertyValue('--thumb-rule')).toBe('#75715e');
    fireEvent.click(screen.getByRole('button', { name: 'Gruvbox' }));
    if (DEFAULT_PREFS.terminalPalette !== 'gruvbox') expect(setPref).toHaveBeenCalledWith('terminalPalette', 'gruvbox');
  });

  it('show the accents as squares named by their hue, the current one pressed', () => {
    state.prefs = { ...DEFAULT_PREFS, terminalAccentOverrides: { [DEFAULT_PREFS.terminalPalette]: '#58c6a5' } };
    render(<AppearancePane />);
    const hues = within(screen.getByRole('group', { name: 'Accent' })).getAllByRole('button');
    expect(hues).toHaveLength(11);
    expect(hues.every((hue) => hue.textContent === '' && hue.title === hue.getAttribute('aria-label'))).toBe(true);
    expect(hues.filter((hue) => hue.getAttribute('aria-pressed') === 'true').map((hue) => hue.title)).toEqual(['Mint']);
    fireEvent.click(screen.getByRole('button', { name: 'Pink' }));
    expect(setPref).toHaveBeenCalledWith('terminalAccentOverrides', expect.objectContaining({ [DEFAULT_PREFS.terminalPalette]: '#ff2d95' }));
  });

  it('resets the accent when the current palette is picked again', () => {
    state.prefs = { ...DEFAULT_PREFS, terminalAccentOverrides: { [DEFAULT_PREFS.terminalPalette]: '#ff2d95' } };
    render(<AppearancePane />);
    expect(screen.getByText('Pick the current palette again to reset its accent.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: name(DEFAULT_PREFS.terminalPalette) }));
    expect(setPref).toHaveBeenCalledExactlyOnceWith('terminalAccentOverrides', {});
  });
});

describe('Appearance on a phone', () => {
  const phone = () => render(<SettingsLayoutContext.Provider value="phone"><AppearancePane /></SettingsLayoutContext.Provider>);

  it('leaves out pane layout, which a one-pane screen does not use, and preference keys', () => {
    phone();
    expect(screen.queryByText('Dim unfocused panes')).toBeNull();
    expect(screen.queryByText('Single-page mode')).toBeNull();
    expect(screen.queryByText('theme.palette')).toBeNull();
    expect(advanced().textContent).toBe('Fonts, code blocks, glass, corner radius and 5 more');
    fireEvent.click(advanced());
    expect(screen.queryByRole('slider', { name: 'Default pane width' })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Single-pane reading width' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Pane width mode' })).toBeNull();
    expect(screen.queryByText('Chrome rules')).toBeNull();
    // What a phone does use stays.
    expect(screen.getByRole('slider', { name: 'Corner radius' })).toBeTruthy();
    expect(screen.getByText('Code wrap')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gruvbox' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Reduce motion' })).toBeTruthy();
    expect(screen.queryByRole('slider', { name: 'Dim strength' })).toBeNull();
  });

  it('keeps pane layout in the desktop window, beside a live preview, still without preference keys', () => {
    render(<AppearancePane />);
    expect(screen.getByText('Dim unfocused panes')).toBeTruthy();
    expect(screen.queryByText('theme.palette')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Preview' })).toBeTruthy();
  });

  it('offers its own Text size instead of the desktop text, composer and sidebar sizes', () => {
    phone();
    expect(rowNames()).toEqual(['Palette', 'Accent', 'Text size', 'Reduce motion', 'Pages recommendations', 'Digest']);
    const size = screen.getByRole('radiogroup', { name: 'Text size' });
    expect(within(size).getAllByRole('radio').map((radio) => (radio as HTMLInputElement).checked)).toEqual([true, false, false]);
    fireEvent.click(within(size).getByRole('radio', { name: 'Large' }));
    expect(setPref).toHaveBeenCalledWith('phoneTextSize', 'l');
    fireEvent.click(advanced());
    expect(screen.queryByText('Composer size')).toBeNull();
  });

  it('has no preview on a phone', () => {
    phone();
    expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull();
  });
});

describe('Appearance opened from a search result', () => {
  const advancedEntries = settingsSearchIndex('Michi').filter((entry) => entry.page === 'appearance' && entry.group === 'Advanced').map((entry) => entry.label);

  it.each(advancedEntries)('opens Advanced for %s', (label) => {
    window.electron = { hasVibrancy: true } as unknown as typeof window.electron;
    render(<SettingsTargetContext.Provider value={label}><AppearancePane /></SettingsTargetContext.Provider>);
    expect(advanced().getAttribute('aria-expanded')).toBe('true');
    expect(rowNames()).toContain(label);
  });

  it('leaves Advanced closed for a setting at the top', () => {
    render(<SettingsTargetContext.Provider value="Palette"><AppearancePane /></SettingsTargetContext.Provider>);
    expect(advanced().getAttribute('aria-expanded')).toBe('false');
  });
});
