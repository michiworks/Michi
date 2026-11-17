export type TerminalPalette = 'bone' | 'slate' | 'monokai' | 'gruvbox';

export interface TerminalTokens {
  /** Canvas background — the paper. */
  bg: string;
  /**
   * Recessed surface — darker than `bg`, used for focused inputs / inset
   * wells on dark themes (the composer sinks in when focused). On light
   * themes this is unused (light composer focus is hardcoded near-white).
   */
  bgDeep: string;
  /** Raised surface (cards, sidebar, top/status bars). */
  surface: string;
  /** Alt-surface (subtle fill — focused row, active tab bg). */
  alt: string;
  /** Slightly darker alt, rarely used. */
  alt2: string;
  /** Hairline divider color. */
  line: string;
  /** Strong divider (header underlines, SVG strokes). */
  lineS: string;
  /** Primary foreground / text. */
  fg: string;
  /** Secondary text that must stay easy to read. ≥4.5:1 on bg/surface/alt. */
  mid: string;
  /** Quiet text that still carries information: captions, timestamps, counts,
   *  hints, metadata. ≥4.5:1 on bg/surface/alt. */
  muted: string;
  /** Not for information: placeholders, disabled states, decorative glyphs
   *  (· › ▸) and idle icon affordances. ≥3:1 on bg/surface/alt. */
  faint: string;
  /** Brand accent (focus ring, prompt glyph, brand mark). */
  accent: string;
  /** Accent fill — pale tinted background for accent-bordered chips. */
  accentF: string;
  /** Amber — waiting on the person, selection. */
  select: string;
  /** Selection fill — pale amber background. */
  selectF: string;
  /** Emerald — digest nodes and sections. */
  digest: string;
  /** Digest fill — pale green background. */
  digestF: string;
  /** Violet — tool calls, merge edges, synthesize. */
  mauve: string;
  /** Mauve fill — pale violet background. */
  mauveF: string;
  /** Error / destructive. */
  danger: string;
  /**
   * Something is running right now: a streaming turn, a working agent, a
   * running workflow. Fixed per palette, not the user's accent, so a picked
   * accent never makes running read as failed, waiting or done.
   */
  run: string;
  /** Run fill — pale tinted background for running chips. */
  runF: string;
}

export const BONE: TerminalTokens = {
  bg: '#fdfdfc', bgDeep: '#ffffff', surface: '#ffffff', alt: '#efece5', alt2: '#e8e4d8',
  line: '#d8d2c4', lineS: '#b5ac98', fg: '#1a1916', mid: '#5a544a',
  muted: '#70695d', faint: '#8c877c',
  accent: '#b8451f', accentF: '#f4dccf',
  select: '#c48300', selectF: '#f8eccf',
  digest: '#2f6b4e', digestF: '#d7e7df',
  mauve: '#6d4aa8', mauveF: '#ebe4f6',
  danger: '#a8261a',
  // Blue: Bone's accent is rust, too close to danger to mark running.
  run: '#1b6396', runF: '#ddeaf4',
};

export const SLATE: TerminalTokens = {
  bg: '#f3f4f6', bgDeep: '#ffffff', surface: '#ffffff', alt: '#e5e7eb', alt2: '#d8dbe1',
  line: '#d1d5db', lineS: '#9ca3af', fg: '#111827', mid: '#4b5563',
  muted: '#616876', faint: '#7d8491',
  accent: '#1a4d8f', accentF: '#dbeafe',
  select: '#c48300', selectF: '#fef3c7',
  digest: '#2f6b4e', digestF: '#d1fae5',
  mauve: '#6d4aa8', mauveF: '#ede9fe',
  danger: '#b91c1c',
  run: '#1b6396', runF: '#ddeaf4',
};

export const MONOKAI: TerminalTokens = {
  bg: '#272822', bgDeep: '#1d1e19', surface: '#2d2e28', alt: '#383930', alt2: '#3e3f38',
  line: '#49483e', lineS: '#75715e', fg: '#f8f8f2', mid: '#c0c0b8',
  muted: '#a2a298', faint: '#868371',
  // Accent is Monokai's own cyan, not its green: green is already the digest
  // hue, and sharing it made the active item, digest nodes and success/info
  // toasts indistinguishable.
  accent: '#66d9ef', accentF: '#12292e',
  select: '#e6db74', selectF: '#2a2810',
  digest: '#a6e22e', digestF: '#1a2210',
  mauve: '#ae81ff', mauveF: '#1e1428',
  danger: '#f92672',
  run: '#66d9ef', runF: '#12292e',
};

export const GRUVBOX: TerminalTokens = {
  bg: '#282828', bgDeep: '#1d1d1d', surface: '#2e2e2e', alt: '#3c3836', alt2: '#504945',
  line: '#504945', lineS: '#665c54', fg: '#ebdbb2', mid: '#cabb9b',
  muted: '#afa088', faint: '#8d816f',
  // Accent is Gruvbox's own blue, not its yellow: yellow is the streaming /
  // selection hue, and sharing it hid which node was streaming vs. focused.
  accent: '#83a598', accentF: '#1e2826',
  select: '#fabd2f', selectF: '#2a2410',
  digest: '#b8bb26', digestF: '#1e2210',
  mauve: '#d3869b', mauveF: '#281a20',
  danger: '#fb4934',
  run: '#83a598', runF: '#1e2826',
};

export const PALETTES: Record<TerminalPalette, TerminalTokens> = {
  bone: BONE,
  slate: SLATE,
  monokai: MONOKAI,
  gruvbox: GRUVBOX,
};

/** How far two of a chart's colours must stand apart to read as two (see apart). */
const SERIES_APART = 40;

/**
 * A chart's series after the first, which takes the accent: five hues per
 * palette that sit with it and stay apart from each other, each at least 3:1
 * on the page and its surface. No series takes a status hue (amber, green,
 * red), and each stands at least as far from one as two series stand from
 * each other, so a bar never reads as a warning; the last is the palette's
 * grey. Emitted as --term-chart-1…5, through chartSeriesFor.
 */
const CHART_SERIES: Record<TerminalPalette, readonly [string, string, string, string, string]> = {
  bone: ['#1b6396', '#0f766e', '#6d4aa8', '#a16207', '#8c877c'],
  slate: ['#0f766e', '#6d4aa8', '#c2410c', '#be185d', '#7d8491'],
  monokai: ['#fd971f', '#ae81ff', '#5fd7a7', '#f4a6c0', '#a2a298'],
  gruvbox: ['#fe8019', '#d3869b', '#8ec07c', '#bdae93', '#928374'],
};

/**
 * Those hues for the accent in force. Series 1 is the accent itself, and an accent can be picked (violet is bone's
 * and slate's own third hue, mint sits on Monokai's green), which would draw two series in one colour. A hue the
 * accent sits on steps toward the foreground until it stands apart: its family is kept, and a step that way only
 * raises its contrast on the page. tokens.test.ts checks every palette against every accent on offer.
 */
function chartSeriesFor(palette: TerminalPalette, accent: string): string[] {
  const p = PALETTES[palette];
  const [chosen, fg] = [channels(accent), channels(p.fg)];
  return CHART_SERIES[palette].map((series) => {
    const hue = channels(series);
    if (apart(hue, chosen) >= SERIES_APART) return series;
    for (let n = 95; n > 0; n -= 5) {
      if (apart(blend(hue, fg, n / 100), chosen) >= SERIES_APART) {
        return `color-mix(in srgb, ${series} ${n}%, ${p.fg})`;
      }
    }
    return `color-mix(in srgb, ${series} 50%, ${p.fg})`;
  });
}

/**
 * Palettes with dark backgrounds. Used by callers that need to flip a UI
 * element between light-mode and dark-mode variants (e.g. Tailwind's
 * `prose-invert` for markdown rendering).
 */
/** Accent hues offered for every palette, as [color, name]. */
export const ACCENT_HUES: ReadonlyArray<readonly [string, string]> = [
  ['#b8451f', 'rust'],
  ['#1a4d8f', 'ink'],
  ['#2f6b4e', 'moss'],
  ['#6d4aa8', 'violet'],
  ['#c48300', 'amber'],
  ['#a8261a', 'red'],
  ['#58c6a5', 'mint'],
  ['#10a37f', 'green'],
  ['#c15f3c', 'clay'],
  ['#00d9ff', 'cyan'],
  ['#ff2d95', 'pink'],
];

/** Resolve the active accent for a palette: user override or palette default. */
export function resolveAccent(
  overrides: Partial<Record<TerminalPalette, string>>,
  palette: TerminalPalette,
): string {
  return overrides[palette] ?? PALETTES[palette].accent;
}

export const DARK_PALETTES: ReadonlySet<TerminalPalette> = new Set<TerminalPalette>([
  'monokai',
  'gruvbox',
]);

// Light pages use dark floating surfaces with a matching color temperature.
// Keep these separate from page tokens so text and native controls remain legible.
const LIGHT_FLOATING_COLORS = {
  slate: {
    bg: '#2f3a49', fg: '#eef3f9', mid: '#c2cfdf', muted: '#aabacd',
    line: '#4f6075', hover: '#3c4b5d', quote: '#26303d', action: '#bfcee2',
  },
  bone: {
    bg: '#39342f', fg: '#f5f0e7', mid: '#d0c5b6', muted: '#bcb0a1',
    line: '#595147', hover: '#484039', quote: '#302b26', action: '#d9cdbb',
  },
} as const;

/**
 * Error TEXT colour. On the dark palettes danger reads only 3.1–4.3:1 on
 * bg/surface/alt (Monokai 3.1–3.9, Gruvbox 3.4–4.3) — fine for icons and
 * fills, too dim for words — so there it mixes 55:45 toward the foreground
 * (4.8:1 or better). The light palettes' danger already clears 5.2:1 and is
 * used as is. tokens.test.ts checks the 4.5:1 floor.
 */
export function dangerTextFor(palette: TerminalPalette): string {
  const p = PALETTES[palette];
  return DARK_PALETTES.has(palette) ? `color-mix(in srgb, ${p.danger} 55%, ${p.fg})` : p.danger;
}

/**
 * Waiting TEXT colour (the Needs you and Paused chips, an asking count; icons
 * and fills keep --term-waiting). The light palettes' amber reads only
 * 2.6–3.2:1 on surface, alt and its own waiting fill, so there it mixes 65:35
 * toward the foreground (4.7:1 or better). The dark palettes' amber already
 * clears the floor and is used as is. tokens.test.ts checks the 4.5:1 floor.
 */
export function waitingTextFor(palette: TerminalPalette): string {
  const p = PALETTES[palette];
  return DARK_PALETTES.has(palette) ? p.select : `color-mix(in srgb, ${p.select} 65%, ${p.fg})`;
}

/** sRGB channels (0–255) of a #rrggbb colour: the palettes and every accent on offer. */
function channels(hex: string): number[] {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
}

/** `color-mix(in srgb, a w, b)` as the browser blends it: the encoded channels, unrounded. */
function blend(a: number[], b: number[], weightOfA: number): number[] {
  return a.map((channel, i) => channel * weightOfA + b[i] * (1 - weightOfA));
}

/** How far apart two hues read, as plain sRGB distance: violet and bone's own third hue are 0 apart, Monokai's green
 * and mint 18, bone's blue and ink 23, slate's orange and rust 22. Under SERIES_APART two series read as one colour. */
function apart(a: number[], b: number[]): number {
  return Math.hypot(...a.map((channel, i) => channel - b[i]));
}

/** WCAG 2 contrast ratio of two sRGB colours. */
function contrast(a: number[], b: number[]): number {
  const luminance = (rgb: number[]) => {
    const [red, green, blue] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The accent itself where it reaches `floor` on every ground, else the least
 * step toward the foreground that does, in 5% steps, so a picked hue keeps
 * its look: `color-mix(in srgb, <accent> 95%, <fg>)`, then 90% and on.
 */
function liftedAccent(p: TerminalTokens, accent: string, grounds: number[][], floor: number): string {
  const [hue, fg] = [channels(accent), channels(p.fg)];
  for (let n = 100; n > 0; n -= 5) {
    const color = blend(hue, fg, n / 100);
    if (grounds.every((ground) => contrast(color, ground) >= floor)) {
      return n === 100 ? accent : `color-mix(in srgb, ${accent} ${n}%, ${p.fg})`;
    }
  }
  return p.fg;
}

/**
 * Accent TEXT colour: links, the active label, @ and michi:// chips. Fills,
 * borders, bars and glyphs keep --term-accent. Several accents miss 4.5:1 as
 * words (Bone's rust on its chip fill, most picked hues on the dark palettes),
 * so the accent lifts toward the foreground until it reaches 4.5:1 on every
 * ground accent words sit on: bg, surface, alt, the pale accent fill, and the
 * @ chip's accent tint at rest (12%) and hovered (18%) over bg and surface.
 */
function accentTextFor(palette: TerminalPalette, accent: string): string {
  const p = PALETTES[palette];
  const hue = channels(accent);
  const [bg, surface] = [channels(p.bg), channels(p.surface)];
  const chips = [0.12, 0.18].flatMap((tint) => [blend(hue, bg, tint), blend(hue, surface, tint)]);
  return liftedAccent(p, accent, [bg, surface, channels(p.alt), channels(p.accentF), ...chips], 4.5);
}

/**
 * The keyboard focus ring: opaque and in the accent, at 3:1 against bg,
 * surface and alt. Every default accent draws it plain; a picked hue that
 * misses 3:1 lifts toward the foreground, the way accentTextFor reaches 4.5:1.
 */
function focusRingFor(palette: TerminalPalette, accent: string): string {
  const p = PALETTES[palette];
  return `2px solid ${liftedAccent(p, accent, [p.bg, p.surface, p.alt].map(channels), 3)}`;
}

/**
 * Build a CSS custom-property map for a palette + user overrides.
 * Apply these as `style={cssVarsFor(...)}` on the shell root; all terminal
 * components read `var(--term-fg)` etc.
 *
 * Font tokens are NOT emitted here — `--ui-font` is set on :root by
 * prefs.tsx (driven by prefs.uiFont) and message typography is handled by
 * the .terminal-message CSS scope in index.css.
 */
export function cssVarsFor(
  palette: TerminalPalette,
  accent: string,
): Record<string, string> {
  const p = PALETTES[palette];
  const isLight = !DARK_PALETTES.has(palette);
  const floating = palette === 'slate' || palette === 'bone' ? LIGHT_FLOATING_COLORS[palette] : null;
  return {
    '--term-bg': p.bg,
    '--term-page-bg': p.bg,
    // Native controls on page-colored surfaces (the phone selection sheet).
    '--term-color-scheme': isLight ? 'light' : 'dark',
    // A recessed well below the page (agent-block payload output).
    '--term-bg-deep': p.bgDeep,
    '--term-surface': p.surface,
    '--term-sidebar-tint': `color-mix(in srgb, ${p.surface} 88%, #ffffff)`,
    '--term-alt': p.alt,
    '--term-alt2': p.alt2,
    // What an unfocused pane's surface sinks toward (usePaneShellStyle's
    // recede): the well below the page on the dark palettes, and the darkest
    // alternate surface on the light ones, whose bgDeep is white and would
    // lift the pane instead. Only the surface sinks; the text it holds does
    // not change.
    '--term-recede-fill': isLight ? p.alt2 : p.bgDeep,
    '--term-hover-bg': p.alt,
    '--term-composer-bg': isLight ? 'rgb(254, 254, 254)' : p.bg,
    '--term-composer-bg-focus': isLight ? 'rgba(255, 255, 255, 1)' : p.bgDeep,
    '--term-composer-border': isLight
      ? '1px solid rgba(0, 0, 0, 0.08)'
      : '1px solid var(--term-line-s)',
    '--term-composer-border-focus': isLight
      ? '1px solid rgba(0, 0, 0, 0.18)'
      : '1px solid var(--term-line-s)',
    '--term-composer-shadow': isLight
      ? '0 1px 2px rgba(0, 0, 0, 0.08), 0 12px 34px rgba(0, 0, 0, 0.08)'
      : 'inset 0 1px 0 rgba(255, 255, 255, 0.05), inset 0 1px 3px rgba(0, 0, 0, 0.5)',
    '--term-composer-shadow-muted': isLight
      ? '0 1px 2px rgba(0, 0, 0, 0.04), 0 10px 28px rgba(0, 0, 0, 0.035)'
      : 'none',
    // Elevation for FLOATING overlays (selection bar, its morph composer) that
    // sit *above* content — always an OUTER drop, never inset. Distinct from
    // --term-composer-shadow, whose dark variant is intentionally `inset`
    // (a recessed input well) because the Pane Composer is embedded in the pane,
    // not floating. Reusing the composer token here made the popup read as
    // carved-inward in dark. Light matches the composer's approved soft drop.
    '--term-float-shadow': isLight
      ? '0 1px 2px rgba(0, 0, 0, 0.08), 0 12px 34px rgba(0, 0, 0, 0.08)'
      : '0 2px 8px rgba(0, 0, 0, 0.55), 0 16px 40px rgba(0, 0, 0, 0.4)',
    // Surface of a floating card over reading text (the branch hover card),
    // worn with --term-float-shadow: the pane surface in light themes, one
    // step lighter in dark ones, where a raised surface reads as lighter.
    '--term-float-bg': isLight ? p.surface : `color-mix(in srgb, ${p.surface} 40%, ${p.alt})`,
    // The dim behind modals and drawers (index.css --scrim-modal). It darkens
    // what is behind: the palette's own ink on light pages, so it stays warm
    // on Bone and cool on Slate, and black on dark pages, where a wash of the
    // page colour would only fade the text.
    '--term-scrim': isLight
      ? `color-mix(in srgb, ${p.fg} 20%, transparent)`
      : 'color-mix(in srgb, black 42%, transparent)',
    '--term-line': p.line,
    '--term-line-s': p.lineS,
    '--term-fg': p.fg,
    '--term-mid': p.mid,
    '--term-muted': p.muted,
    '--term-faint': p.faint,
    // Accent is an override (user-picked) layered over palette default.
    '--term-accent': accent,
    // Accent words (fills, borders and glyphs keep --term-accent); see accentTextFor.
    '--term-accent-text': accentTextFor(palette, accent),
    // The one keyboard focus ring (index.css holds its fallback); see focusRingFor.
    '--focus-ring': focusRingFor(palette, accent),
    '--term-accent-f': p.accentF,
    '--term-run': p.run,
    '--term-run-f': p.runF,
    '--term-select': p.select,
    '--term-select-f': p.selectF,
    // Waiting on you: the select hue, which also marks selection and pins in the sidebar.
    '--term-waiting': p.select,
    '--term-waiting-f': p.selectF,
    // Waiting text (icons and fills keep --term-waiting); see waitingTextFor.
    '--term-waiting-text': waitingTextFor(palette),
    '--term-digest': p.digest,
    '--term-digest-f': p.digestF,
    '--term-mauve': p.mauve,
    '--term-mauve-f': p.mauveF,
    ...Object.fromEntries(chartSeriesFor(palette, accent).map((color, i) => [`--term-chart-${i + 1}`, color])),
    '--term-danger': p.danger,
    // Error text (icons and fills keep --term-danger); see dangerTextFor.
    '--term-danger-text': dangerTextFor(palette),
    // The filled danger button (<Button variant="primary" danger>): solid
    // danger under --on-accent on the light palettes; on the dark ones, where
    // that ink reads about 4:1, the soft danger fill with danger words.
    '--term-danger-btn-bg': isLight ? 'var(--term-danger)' : 'var(--term-danger-f)',
    '--term-danger-btn-fg': isLight ? 'var(--on-accent)' : 'var(--term-danger-text)',
    '--term-danger-btn-hover': isLight
      ? 'color-mix(in srgb, var(--term-danger) 88%, var(--term-fg))'
      : 'color-mix(in srgb, var(--term-danger) 14%, var(--term-surface))',
    // Override Tailwind prose body/heading colors so markdown content inside
    // the terminal shell uses the palette foreground instead of the default
    // gray (which is nearly invisible on light palettes like bone/slate).
    '--tw-prose-body': p.fg,
    '--tw-prose-headings': p.fg,
    '--tw-prose-bold': p.fg,
    '--tw-prose-code': p.fg,
    // Links are accent words: the picked accent's text form, not the palette default.
    '--tw-prose-links': 'var(--term-accent-text)',
    // Motion tokens (--t-*) are palette-independent and live only in index.css :root.
    // Floating surfaces stay dark: cool blue-gray on Slate, warm graphite on Bone,
    // and a raised shade of the page on the dark palettes.
    // Shared by selection bars/composers, batch actions and transient notices.
    '--sel-bar-bg': floating?.bg ?? `color-mix(in srgb, ${p.surface} 92%, ${p.fg})`,
    '--sel-bar-fg': floating?.fg ?? p.fg,
    '--sel-bar-mid': floating?.mid ?? p.mid,
    // Raising a dark surface reduces contrast; use the brighter text level for metadata.
    '--sel-bar-muted': floating?.muted ?? p.mid,
    '--sel-bar-line': floating?.line ?? `color-mix(in srgb, ${p.surface} 80%, ${p.fg})`,
    '--sel-bar-hover': floating?.hover ?? `color-mix(in srgb, ${p.fg} 8%, transparent)`,
    // A focus mark on the bar: the accent at 3:1 on it. The light palettes'
    // accents are dark hues that vanish on their dark bar, so they take its ink.
    '--sel-bar-focus': floating?.fg ?? liftedAccent(p, accent, [blend(channels(p.surface), channels(p.fg), 0.92)], 3),
    '--sel-bar-shadow': isLight
      ? '0 2px 6px rgba(16, 24, 32, 0.09), 0 12px 26px rgba(16, 24, 32, 0.14)'
      : 'var(--term-float-shadow)',
    '--sel-bar-color-scheme': 'dark',
    '--sel-bar-quote-bg': floating?.quote ?? 'color-mix(in srgb, var(--term-bg) 45%, var(--sel-bar-bg))',
    '--sel-bar-action-bg': floating?.action ?? `color-mix(in srgb, ${accent} 35%, ${p.fg})`,
    '--sel-bar-action-fg': floating?.bg ?? p.bg,
  };
}
