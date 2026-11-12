import { useId, useState, type CSSProperties } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  usePrefs, CORNER_RADIUS_MAX, DEFAULT_PREFS, UI_FONT_OPTS,
  type AgentBlockStyle, type CodeBlockStyle, type PhoneTextSize, type SidebarDensity, type TerminalPalette,
} from '../../../../state/prefs';
import type { VibrancyMaterial } from '../../../../lib/electronBridge';
import { Button, Switch } from '../../../ui/controls';
import { ACCENT_HUES, DARK_PALETTES, PALETTES, resolveAccent } from '../../tokens';
import { Radio, Segmented, type RadioOption } from './controls';
import { DIM_STRENGTH_MIN, dimStrength, rememberDimStrength, toggleFocusDim } from './focusDim';
import { SettingsRow, SettingsSection } from './SettingsSection';
import { useSettingsLayout, useSettingsTarget } from './settingsPhone';
import { PANE_MOTION_OPTIONS, type PaneMotion } from '../../paneMotion';
import { getElectron } from '../../../../lib/electronBridge';
import {
  SIDEBAR_ROW_STYLES,
  SIDEBAR_ROW_STYLE_LABELS,
} from '../../sidebarRowStyle';

/**
 * Live sample of what the Corner radius slider drives, built from the real
 * shared classes (menu surface + rows, button, tooltip pill) so it reads the
 * same --ui-radius tokens as the app. Menus and modals can't be open while the
 * Settings drawer is, so this is where the change is visible while dragging.
 */
function CornerRadiusPreview() {
  return (
    <div aria-hidden="true" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginTop: 10 }}>
      <div className="michi-menu" data-menu="context" style={{ width: 150, pointerEvents: 'none' }}>
        <ul className="michi-menu-list">
          <li className="ui-menu-item" data-active="true"><span className="michi-menu-label">Rename</span><span className="michi-menu-keys">R</span></li>
          <li className="ui-menu-item"><span className="michi-menu-label">Duplicate</span></li>
          <li className="ui-menu-item" data-danger="true"><span className="michi-menu-label">Delete</span></li>
        </ul>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
        <span className="ui-btn" style={{ pointerEvents: 'none' }}>Button</span>
        <span
          style={{
            padding: '3px 7px',
            fontSize: 'var(--fs-sm)',
            fontFamily: 'var(--ui-font)',
            color: 'var(--term-mid)',
            background: 'var(--ui-tooltip-bg)',
            border: 'var(--ui-tooltip-border)',
            borderRadius: 'var(--ui-tooltip-radius)',
          }}
        >
          Tooltip
        </span>
      </div>
    </div>
  );
}

/**
 * Settings under Advanced, by the names their rows show. A search result for
 * one of them opens Advanced (settingsSearch.ts lists them under 'Advanced').
 */
const ADVANCED_SETTINGS: ReadonlySet<string> = new Set([
  'Interface font', 'Message font', 'Composer size', 'Code blocks', 'Code wrap', 'Agent blocks', 'Corner radius',
  'Sidebar row style', 'Sidebar edge padding', 'Sidebar timestamps', 'Window glass', 'Sidebar glass', 'Glass blur',
  'Glass saturation', 'Sidebar material', 'Glass defaults', 'Dim strength', 'Pane width mode',
  'Pane animation', 'Default pane width', 'Single-pane reading width', 'Chrome rules',
]);

/**
 * Advanced rows its line does not name ("Fonts, code blocks, glass, corner
 * radius and N more"): those on every screen, and the rows a desktop adds:
 * Composer size (a phone's Text size covers it) and pane layout.
 */
const ADVANCED_UNNAMED = ['Code wrap', 'Agent blocks', 'Sidebar row style', 'Sidebar edge padding', 'Sidebar timestamps'];
const ADVANCED_UNNAMED_DESKTOP = ['Composer size', 'Dim strength', 'Pane width mode', 'Pane animation', 'Default pane width',
  'Single-pane reading width', 'Chrome rules'];

const PALETTE_CHOICES: ReadonlyArray<{ value: TerminalPalette; label: string }> = [
  { value: 'bone', label: 'Bone' },
  { value: 'slate', label: 'Slate' },
  { value: 'monokai', label: 'Monokai' },
  { value: 'gruvbox', label: 'Gruvbox' },
];

/**
 * A palette's colours for its thumbnail, a small window: the page, a sidebar
 * down its left side (on light palettes a shade between the page and its fill,
 * on dark ones the deeper well) and two lines of text in its ink and strong
 * rule. These are the palette's own colours, not the current theme's.
 */
function paletteThumb(palette: TerminalPalette): CSSProperties {
  const p = PALETTES[palette];
  const dark = DARK_PALETTES.has(palette);
  return {
    '--thumb-page': dark ? p.bg : p.surface,
    '--thumb-sidebar': dark ? p.bgDeep : `color-mix(in srgb, ${p.bg} 50%, ${p.alt})`,
    '--thumb-ink': p.fg,
    '--thumb-rule': p.lineS,
  } as CSSProperties;
}

const sentence = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const CODE_BLOCK_STYLES: ReadonlyArray<RadioOption<CodeBlockStyle>> = [
  { value: 'hairline', label: 'Hairline' },
  { value: 'header', label: 'Header' },
];

const AGENT_BLOCK_STYLES: ReadonlyArray<RadioOption<AgentBlockStyle>> = [
  { value: 'line', label: 'Line', description: 'One line per run of work that says what it did. The default.' },
  { value: 'plain', label: 'Plain', description: 'Bare text rows with small arrows and dots.' },
  { value: 'card', label: 'Card', description: 'A card per run, with icons and a status column on the right.' },
  { value: 'terminal', label: 'Terminal', description: 'Terminal-style marks (❯ ✓ ×) and small-capital headers.' },
];

const VIBRANCY_MATERIALS: ReadonlyArray<{ value: VibrancyMaterial; label: string }> = [
  { value: 'under-window', label: 'Under window (lightest)' },
  { value: 'sidebar', label: 'Sidebar' },
  { value: 'menu', label: 'Menu' },
  { value: 'hud', label: 'HUD (densest)' },
];

/** The glass material's settings, which Glass defaults puts back. Window glass is a fix for flicker, so it stays as set. */
const GLASS_PREFS = ['sidebarTranslucency', 'glassBlur', 'glassSaturate', 'sidebarVibrancy'] as const;

/** Text size choices, in px of message text (messageFontSize). */
const TEXT_SIZES = [14, 15, 16, 18] as const;

/**
 * A phone's Text size: a preset of its own (prefs.phoneTextSize), unrelated
 * to the desktop's text, composer and sidebar sizes. It scales the whole
 * phone UI (mobile.css).
 */
const PHONE_TEXT_SIZES: ReadonlyArray<RadioOption<PhoneTextSize>> = [
  { value: 's', label: 'Small', description: '15px messages, the densest' },
  { value: 'm', label: 'Medium', description: '16px messages; the interface steps up too' },
  { value: 'l', label: 'Large', description: '18px messages; the interface steps up again' },
];

const DENSITIES: ReadonlyArray<{ value: SidebarDensity; label: string }> = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'airy', label: 'Airy' },
];

/** What Advanced holds, for the row that opens it. */
function advancedSummary({ desktop }: { desktop: boolean }): string {
  const more = ADVANCED_UNNAMED.length + (desktop ? ADVANCED_UNNAMED_DESKTOP.length : 0);
  return `Fonts, code blocks, glass, corner radius and ${more} more`;
}

/** Px values as the segments show them: "16", "14.5". */
const sizeLabel = (size: number) => String(size);

/**
 * The sizes to offer: the usual ones, plus the current size when it is
 * another one (set before, or by the older Message size slider), so it still
 * shows as chosen.
 */
function textSizeOptions(current: number): string[] {
  const sizes: number[] = [...TEXT_SIZES];
  if (!sizes.includes(current)) sizes.push(current);
  return sizes.sort((a, b) => a - b).map(sizeLabel);
}

/**
 * A short conversation drawn with the live theme tokens and message fonts, so
 * palette, accent, fonts and sizes show here as they change.
 */
function AppearancePreview() {
  return (
    <aside className="appearance-preview" aria-label="Preview">
      <div className="appearance-preview__title">Preview</div>
      <div className="appearance-preview__frame" aria-hidden="true">
        <div className="appearance-preview__bar"><span>Michi</span><span className="appearance-preview__chip">Runtime · model</span></div>
        <div className="appearance-preview__user">Can you compare the two approaches?</div>
        <div className="appearance-preview__reply">
          <strong>Two directions</strong>
          <p>The first keeps one list; the second splits it by topic. Both read <code>settingsPages.ts</code>.</p>
        </div>
        <div className="appearance-preview__composer"><span>Reply…</span><span className="appearance-preview__send">↑</span></div>
      </div>
      <p className="appearance-preview__note">Shows the theme, accent, fonts and sizes as you change them.</p>
    </aside>
  );
}

/** The palettes as small windows in their own colours, the current one ringed. */
function PalettePicker({ value, onPick }: { value: TerminalPalette; onPick: (palette: TerminalPalette) => void }) {
  return (
    <div className="settings-themes" role="group" aria-label="Palette">
      {PALETTE_CHOICES.map(({ value: palette, label }) => (
        <button key={palette} type="button" className="settings-theme" aria-pressed={palette === value} onClick={() => onPick(palette)}>
          <span className="settings-theme__thumb" style={paletteThumb(palette)} aria-hidden="true" />
          <span className="settings-theme__name">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** Accent hues as squares, each named by its hue; the current one ringed. */
function AccentPicker({ value, onPick }: { value: string; onPick: (color: string) => void }) {
  return (
    <div className="settings-hues" role="group" aria-label="Accent">
      {ACCENT_HUES.map(([color, name]) => (
        <button key={name} type="button" className="settings-hue" style={{ '--hue': color } as CSSProperties}
          aria-label={sentence(name)} title={sentence(name)} aria-pressed={value === color} onClick={() => onPick(color)} />
      ))}
    </div>
  );
}

/** A slider and its value, for a row's control slot. */
function Range({ id, value, min, max, step, unit = 'px', onChange }: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="settings-range settings-range--row">
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <span className="settings-range__value">{value}{unit}</span>
    </div>
  );
}

/**
 * Appearance: the few decisions most people make (theme, reading, panes,
 * Home) as rows under their group labels, and every fine-tuning setting
 * under a collapsed Advanced.
 */
export function AppearancePane() {
  const { prefs, setPref } = usePrefs();
  // A phone shows one pane at a time, so pane layout settings stay on desktop.
  const layout = useSettingsLayout();
  const phone = layout === 'phone';
  const target = useSettingsTarget();
  const currentAccent = resolveAccent(prefs.terminalAccentOverrides, prefs.terminalPalette);
  const [advancedOpen, setAdvancedOpen] = useState(() => !!target && ADVANCED_SETTINGS.has(target));
  const id = useId();
  const glass = !!getElectron()?.hasVibrancy;
  const glassIsDefault = GLASS_PREFS.every((key) => prefs[key] === DEFAULT_PREFS[key]);
  const resetGlass = () => { for (const key of GLASS_PREFS) setPref(key, DEFAULT_PREFS[key]); };

  const pickPalette = (value: TerminalPalette) => {
    if (prefs.terminalPalette === value) {
      // Picking the current palette again resets its accent override.
      const next = { ...prefs.terminalAccentOverrides };
      delete next[value];
      setPref('terminalAccentOverrides', next);
      return;
    }
    setPref('terminalPalette', value);
  };

  return (
    <div className="appearance-pane" data-preview={layout === 'window' || undefined}>
    <div className="appearance-pane__settings">
      <SettingsSection title="Theme">
        <SettingsRow label="Palette" description="Pick the current palette again to reset its accent.">
          <PalettePicker value={prefs.terminalPalette} onPick={pickPalette} />
        </SettingsRow>
        <SettingsRow label="Accent" description="The highlight color of the current palette."
          control={<AccentPicker value={currentAccent}
            onPick={(color) => setPref('terminalAccentOverrides', { ...prefs.terminalAccentOverrides, [prefs.terminalPalette]: color })} />} />
      </SettingsSection>

      <SettingsSection title="Reading">
        {phone ? <SettingsRow label="Text size" description="Messages and the rest of the phone's interface.">
          <Radio label="Text size" opts={PHONE_TEXT_SIZES} value={prefs.phoneTextSize}
            onChange={(value) => setPref('phoneTextSize', value)} />
        </SettingsRow> : <>
          <SettingsRow label="Density" description="Row height and spacing in the sidebar."
            control={<Segmented label="Density" opts={DENSITIES} value={prefs.sidebarDensity} onChange={(value) => setPref('sidebarDensity', value)} />} />
          <SettingsRow label="Text size" description="Message text, in pixels."
            control={<Segmented label="Text size" opts={textSizeOptions(prefs.messageFontSize)} value={sizeLabel(prefs.messageFontSize)}
              onChange={(value) => setPref('messageFontSize', Number(value))} />} />
        </>}
      </SettingsSection>

      <SettingsSection title="Panes">
        {!phone && <SettingsRow label="Dim unfocused panes" description="Lowers the other panes when two or more are open."
          control={<Switch on={prefs.focusDim > 0} aria-label="Dim unfocused panes"
            onChange={(on) => setPref('focusDim', toggleFocusDim(prefs.focusDim, on))} />} />}
        {!phone && <SettingsRow label="Single-page mode" description="One pane at a time; the thread’s other panes become tabs."
          control={<Switch on={prefs.singlePageMode} aria-label="Single-page mode" onChange={(value) => setPref('singlePageMode', value)} />} />}
        <SettingsRow label="Reduce motion" description="Turns off drawer slides and pane transitions."
          control={<Switch on={prefs.reduceMotion} aria-label="Reduce motion" onChange={(value) => setPref('reduceMotion', value)} />} />
      </SettingsSection>

      <SettingsSection title="Home">
        <SettingsRow label="Pages recommendations"
          description="Shows Pages recommendations, or your custom Home page, with the composer. Off shows only the composer."
          control={<Switch on={prefs.homeRecommendations} aria-label="Pages recommendations on Home" onChange={(value) => setPref('homeRecommendations', value)} />} />
      </SettingsSection>

      <SettingsSection title="Features">
        <SettingsRow label="Digest"
          description="Synthesize selected chats into a source-tracked document. Off hides Digest everywhere; existing digests are kept."
          control={<Switch on={prefs.digestEnabled} aria-label="Digest" onChange={(value) => setPref('digestEnabled', value)} />} />
      </SettingsSection>

      {/* Sidebar threads per workspace is intentionally hidden: the
          sidebarThreadLimit pref still sets how many threads a workspace row
          lists. Add its row (range 1–30) and its settingsSearch entry to
          expose it again. */}

      {/* Advanced: its group label, then one row that opens it in place. */}
      <section className="settings-section appearance-advanced-section" aria-labelledby={`${id}-advanced`}>
        <div className="settings-section__head">
          <h2 id={`${id}-advanced`} className="settings-section__title">Advanced</h2>
        </div>
        <div className="settings-section__body">
          <button type="button" className="appearance-advanced" aria-expanded={advancedOpen}
            aria-controls={advancedOpen ? `${id}-advanced-body` : undefined}
            aria-labelledby={`${id}-advanced ${id}-advanced-summary`}
            onClick={() => setAdvancedOpen((open) => !open)}>
            <span id={`${id}-advanced-summary`}>{advancedSummary({ desktop: !phone })}</span>
            <ChevronRight className="appearance-advanced__chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {advancedOpen && <div className="appearance-advanced__rows" id={`${id}-advanced-body`}>
          <SettingsRow label="Interface font" description="Everything but message text."
            control={<Segmented label="Interface font" opts={UI_FONT_OPTS} value={prefs.uiFont}
              onChange={(value) => setPref('uiFont', value)} />} />
          <SettingsRow label="Message font" description="Message text in chats."
            control={<Segmented label="Message font" opts={['Source Serif 4', 'Geist']} value={prefs.messageFont}
              onChange={(value) => setPref('messageFont', value)} />} />
          {!phone && <SettingsRow label="Composer size" labelFor={`${id}-composer`} description="Text you type in the composer."
            control={<Range id={`${id}-composer`} value={prefs.composerFontSize} min={12} max={22} step={0.5}
              onChange={(value) => setPref('composerFontSize', value)} />} />}
          <SettingsRow label="Code blocks" description="Hairline shows the language as a faint label over the code; Header puts it in a bar above."
            control={<Segmented label="Code blocks" opts={CODE_BLOCK_STYLES} value={prefs.codeBlockStyle}
              onChange={(value) => setPref('codeBlockStyle', value)} />} />
          <SettingsRow label="Code wrap" description="Wrap long lines in code blocks instead of scrolling sideways."
            control={<Switch on={prefs.codeWrap} aria-label="Code wrap" onChange={(value) => setPref('codeWrap', value)} />} />
          <SettingsRow label="Agent blocks" description="How thinking, tool calls and subagents show in a reply.">
            <Radio label="Agent blocks" opts={AGENT_BLOCK_STYLES} value={prefs.agentBlockStyle}
              onChange={(value) => setPref('agentBlockStyle', value)} />
          </SettingsRow>
          <SettingsRow label="Corner radius" labelFor={`${id}-radius`} description="Menus, dialogs, buttons and cards."
            control={<Range id={`${id}-radius`} value={prefs.cornerRadius} min={0} max={CORNER_RADIUS_MAX} step={1}
              onChange={(value) => setPref('cornerRadius', value)} />}>
            <CornerRadiusPreview />
          </SettingsRow>
          <SettingsRow label="Sidebar row style" description={<>
            {SIDEBAR_ROW_STYLE_LABELS[prefs.sidebarRowStyle]}. The three card styles share one text spine (20 / 36 / 52) and
            differ only in corner radius and fill width; they set their own edge padding.
          </>}>
            <Radio
              label="Sidebar row style"
              opts={SIDEBAR_ROW_STYLES}
              value={prefs.sidebarRowStyle}
              onChange={(value) => setPref('sidebarRowStyle', value)}
            />
          </SettingsRow>
          <SettingsRow label="Sidebar edge padding" labelFor={`${id}-inset`} description="Space beside the sidebar’s rows, for the classic row style."
            control={<Range id={`${id}-inset`} value={prefs.sidebarInset} min={0} max={24} step={1}
              onChange={(value) => setPref('sidebarInset', value)} />} />
          <SettingsRow label="Sidebar timestamps" description="Show last-active time on thread rows."
            control={<Switch on={prefs.showSidebarTimestamps} aria-label="Sidebar timestamps" onChange={(value) => setPref('showSidebarTimestamps', value)} />} />
          {glass && <SettingsRow label="Window glass" description="See the desktop through the sidebar. Turn off if drawers or ⌘K flicker."
            control={<Switch on={prefs.windowGlass} aria-label="Window glass" onChange={(value) => setPref('windowGlass', value)} />} />}
          <SettingsRow label="Sidebar glass" labelFor={`${id}-translucency`} description="How much shows through the sidebar."
            control={<Range id={`${id}-translucency`} value={prefs.sidebarTranslucency} min={0} max={100} step={2} unit="%"
              onChange={(value) => setPref('sidebarTranslucency', value)} />} />
          <SettingsRow label="Glass blur" labelFor={`${id}-blur`} description="Blur behind the sidebar."
            control={<Range id={`${id}-blur`} value={prefs.glassBlur} min={0} max={40} step={1}
              onChange={(value) => setPref('glassBlur', value)} />} />
          <SettingsRow label="Glass saturation" labelFor={`${id}-saturate`} description="How vivid what shows through the sidebar is."
            control={<Range id={`${id}-saturate`} value={prefs.glassSaturate} min={100} max={220} step={5} unit="%"
              onChange={(value) => setPref('glassSaturate', value)} />} />
          {glass && <SettingsRow label="Sidebar material" labelFor={`${id}-material`} description="How dense the macOS frost behind the sidebar is."
            control={<select id={`${id}-material`} className="ui-select settings-row__select" value={prefs.sidebarVibrancy}
              onChange={(event) => setPref('sidebarVibrancy', event.target.value as VibrancyMaterial)}>
              {VIBRANCY_MATERIALS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </select>} />}
          <SettingsRow label="Glass defaults" description="Puts the glass settings above back to the tuned look."
            control={<Button size="sm" disabled={glassIsDefault} onClick={resetGlass}>Reset</Button>} />
          {!phone && <>
            <SettingsRow label="Dim strength" labelFor={`${id}-dim`} description="How much Dim unfocused panes lowers the other panes. Moving it turns dimming on."
              control={<Range id={`${id}-dim`} value={dimStrength(prefs.focusDim)} min={DIM_STRENGTH_MIN} max={100} step={5} unit="%"
                onChange={(value) => { rememberDimStrength(value); setPref('focusDim', value); }} />} />
            <SettingsRow label="Pane width mode" labelFor={`${id}-width-mode`} description="With two or more panes. A width you drag stays."
              control={<select id={`${id}-width-mode`} className="ui-select settings-row__select" value={prefs.paneWidthMode}
                onChange={(event) => setPref('paneWidthMode', event.target.value as typeof prefs.paneWidthMode)}>
                <option value="fixed">Fixed width</option>
                <option value="half">Half viewport</option>
                <option value="adaptive">Half at 2, fixed at 3+</option>
              </select>} />
            <SettingsRow label="Pane animation" labelFor={`${id}-motion`} description="How a pane enters and leaves."
              control={<select id={`${id}-motion`} className="ui-select settings-row__select" value={prefs.paneSpawnAnimation}
                onChange={(event) => setPref('paneSpawnAnimation', event.target.value as PaneMotion)}>
                {PANE_MOTION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>} />
            <SettingsRow label="Default pane width" labelFor={`${id}-pane-width`} description="For new panes that have no width of their own."
              control={<Range id={`${id}-pane-width`} value={prefs.defaultPaneWidth} min={360} max={1200} step={20}
                onChange={(value) => setPref('defaultPaneWidth', value)} />} />
            <SettingsRow label="Single-pane reading width" labelFor={`${id}-reading`} description="The widest text runs when one pane is open."
              control={<div className="settings-range settings-range--row">
                <input id={`${id}-reading`} type="range" min={480} max={1280} step={1}
                  value={prefs.singlePaneContentWidth ?? DEFAULT_PREFS.singlePaneContentWidth!}
                  disabled={prefs.singlePaneContentWidth === null}
                  onChange={(event) => setPref('singlePaneContentWidth', Number(event.target.value))} />
                <span className="settings-range__value">{prefs.singlePaneContentWidth === null ? 'full' : `${prefs.singlePaneContentWidth}px`}</span>
                <button type="button" className="ui-btn ui-btn--sm settings-range__toggle" aria-pressed={prefs.singlePaneContentWidth === null}
                  onClick={() => setPref('singlePaneContentWidth', prefs.singlePaneContentWidth === null ? DEFAULT_PREFS.singlePaneContentWidth : null)}>
                  Full width
                </button>
              </div>} />
            <SettingsRow label="Chrome rules" description="Hairline rules between panes."
              control={<Switch on={prefs.paneRules} aria-label="Chrome rules" onChange={(value) => setPref('paneRules', value)} />} />
          </>}
          </div>}
        </div>
      </section>
    </div>
    {layout === 'window' && <AppearancePreview />}
    </div>
  );
}
