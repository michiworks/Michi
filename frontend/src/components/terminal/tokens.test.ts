import { describe, expect, it } from 'vitest';
import { ACCENT_HUES, DARK_PALETTES, PALETTES, cssVarsFor, dangerTextFor, waitingTextFor } from './tokens';
import { MANAGE_LINK_TYPE, manageFileType } from './manage/tokens';

/** A six-digit hex colour, or the sRGB channels (0–255) of a blend. */
type Color = string | readonly number[];

function relativeLuminance(color: Color): number {
  const channels = typeof color === 'string' ? color.match(/[0-9a-f]{2}/gi)?.map((channel) => parseInt(channel, 16)) : color;
  if (!channels || channels.length !== 3) throw new Error(`Expected a six-digit hex color, got ${color}`);
  const [red, green, blue] = channels.map((channel) => channel / 255).map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: Color, background: Color): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    Math.max(foregroundLuminance, backgroundLuminance) + 0.05
  ) / (
    Math.min(foregroundLuminance, backgroundLuminance) + 0.05
  );
}

describe('cssVarsFor — scrim', () => {
  it('dims with the palette’s ink on light palettes and with black on dark ones', () => {
    for (const palette of Object.keys(PALETTES) as Array<keyof typeof PALETTES>) {
      const scrim = cssVarsFor(palette, PALETTES[palette].accent)['--term-scrim'];
      expect(scrim).toBe(DARK_PALETTES.has(palette)
        ? 'color-mix(in srgb, black 42%, transparent)'
        : `color-mix(in srgb, ${PALETTES[palette].fg} 20%, transparent)`);
    }
  });
});

describe('cssVarsFor — accent resolution', () => {
  it('DARK_PALETTES contains exactly the dark palettes', () => {
    expect(DARK_PALETTES.has('monokai')).toBe(true);
    expect(DARK_PALETTES.has('gruvbox')).toBe(true);
    expect(DARK_PALETTES.has('bone')).toBe(false);
    expect(DARK_PALETTES.has('slate')).toBe(false);
  });
});

function distance(a: string, b: string): number {
  const rgb = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

describe.each(Object.entries(PALETTES))('%s palette readability', (name, p) => {
  const grounds = [p.bg, p.surface, p.alt];

  // muted carries information (timestamps, counts, hints) so it must clear AA;
  // faint is reserved for placeholders, disabled states and decorative glyphs.
  it('keeps every text level readable on every ground', () => {
    for (const g of grounds) {
      expect(contrastRatio(p.fg, g)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(p.mid, g)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.muted, g)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.faint, g)).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the four text levels visibly stepped', () => {
    const on = (c: string) => contrastRatio(c, p.bg);
    expect(on(p.fg) / on(p.mid)).toBeGreaterThan(1.2);
    expect(on(p.mid) / on(p.muted)).toBeGreaterThan(1.2);
    expect(on(p.muted) / on(p.faint)).toBeGreaterThan(1.2);
  });

  it('keeps the accent visibly apart from the node hues it would otherwise impersonate', () => {
    // select = waiting on you, digest = digests/success, mauve = tool calls.
    for (const hue of [p.select, p.digest, p.mauve]) {
      expect(distance(p.accent, hue)).toBeGreaterThan(60);
    }
  });

  it('reads --on-accent (the canvas) on accent and digest fills', () => {
    expect(contrastRatio(p.bg, p.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.bg, p.digest)).toBeGreaterThanOrEqual(4.5);
  });

  it('reads the primary button ink (the surface) on its accent fill', () => {
    // .ui-btn--primary / .t-action-btn.is-primary: Send and every text Button.
    expect(contrastRatio(p.surface, p.accent)).toBeGreaterThanOrEqual(4.5);
  });

  // The palette's own accent and every hue the user can pick instead.
  const accents = [p.accent, ...ACCENT_HUES.map(([hue]) => hue)];
  const varsFor = (accent: string) => cssVarsFor(name as keyof typeof PALETTES, accent);

  /** N of a derived accent colour: 100 for the accent itself, else its `color-mix(… N%, fg)` step. */
  function stepOf(color: string, accent: string): number {
    if (color === accent) return 100;
    const n = color.match(new RegExp(`^color-mix\\(in srgb, ${accent} (\\d+)%, ${p.fg}\\)$`))?.[1];
    if (!n) throw new Error(`Expected ${accent} or a step of it toward ${p.fg}, got ${color}`);
    return Number(n);
  }

  /** The lowest contrast, on the grounds, of the accent mixed n% with fg. */
  const lowest = (accent: string, n: number, grounds: Color[]) =>
    Math.min(...grounds.map((ground) => contrastRatio(blend(accent, p.fg, n / 100), ground)));

  it('reads accent words at 4.5:1 on every accent ground, lifting a hue only the 5% steps toward fg it needs', () => {
    for (const accent of accents) {
      // The page, cards, chrome, the pale accent fill, and the @ chip's tint
      // at rest (12%) and hovered (18%) over the page and over cards.
      const grounds = [p.bg, p.surface, p.alt, p.accentF,
        ...[0.12, 0.18].flatMap((tint) => [blend(accent, p.bg, tint), blend(accent, p.surface, tint)])];
      const n = stepOf(varsFor(accent)['--term-accent-text'], accent);
      expect(lowest(accent, n, grounds), accent).toBeGreaterThanOrEqual(4.5);
      for (let less = n + 5; less <= 100; less += 5) {
        expect(lowest(accent, less, grounds), `${accent} at ${less}%`).toBeLessThan(4.5);
      }
    }
  });

  it('rings keyboard focus at 3:1 on bg, surface and alt: the default accent plain, a hue only the steps it needs', () => {
    expect(varsFor(p.accent)['--focus-ring']).toBe(`2px solid ${p.accent}`);
    const grounds = [p.bg, p.surface, p.alt];
    for (const accent of accents) {
      const n = stepOf(varsFor(accent)['--focus-ring'].replace(/^2px solid /, ''), accent);
      expect(lowest(accent, n, grounds), accent).toBeGreaterThanOrEqual(3);
      for (let less = n + 5; less <= 100; less += 5) {
        expect(lowest(accent, less, grounds), `${accent} at ${less}%`).toBeLessThan(3);
      }
    }
  });

  it('keeps running apart from waiting, done, failed and tool calls, and readable as text', () => {
    for (const hue of [p.select, p.digest, p.danger, p.mauve]) {
      expect(distance(p.run, hue)).toBeGreaterThan(60);
    }
    // Running labels sit on the page and on cards; on alt it marks dots and bars.
    expect(contrastRatio(p.run, p.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.run, p.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.run, p.alt)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(p.run, p.runF)).toBeGreaterThanOrEqual(4.5);
  });

  it('emits running as its own variables, not the user-picked accent', () => {
    const vars = cssVarsFor(name as keyof typeof PALETTES, '#ff2d95');
    expect(vars['--term-run']).toBe(p.run);
    expect(vars['--term-run-f']).toBe(p.runF);
  });
});

/** `color-mix(in srgb, a w%, b)`: a straight per-channel blend of the encoded sRGB values, unrounded. */
function blend(a: string, b: string, weightOfA: number): number[] {
  const rgb = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return x.map((c, i) => c * weightOfA + y[i] * (1 - weightOfA));
}

/** The blend as a hex colour. */
function mixSrgb(a: string, b: string, weightOfA: number): string {
  return `#${blend(a, b, weightOfA).map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

describe('--term-danger-text', () => {
  it('mixes danger toward fg on the dark palettes and is plain danger on the light ones', () => {
    expect(dangerTextFor('monokai')).toBe(`color-mix(in srgb, ${PALETTES.monokai.danger} 55%, ${PALETTES.monokai.fg})`);
    expect(dangerTextFor('gruvbox')).toBe(`color-mix(in srgb, ${PALETTES.gruvbox.danger} 55%, ${PALETTES.gruvbox.fg})`);
    expect(dangerTextFor('bone')).toBe(PALETTES.bone.danger);
    expect(dangerTextFor('slate')).toBe(PALETTES.slate.danger);
  });

  it('is emitted with the rest of the palette', () => {
    for (const palette of ['monokai', 'gruvbox', 'bone', 'slate'] as const) {
      expect(cssVarsFor(palette, PALETTES[palette].accent)['--term-danger-text']).toBe(dangerTextFor(palette));
    }
  });

  it('draws waiting on you in the select hue, whatever accent is picked', () => {
    for (const palette of ['monokai', 'gruvbox', 'bone', 'slate'] as const) {
      const vars = cssVarsFor(palette, '#ff2d95');
      expect([vars['--term-waiting'], vars['--term-waiting-f']]).toEqual([vars['--term-select'], vars['--term-select-f']]);
    }
  });

  it.each(Object.entries(PALETTES))('reads as text on every %s ground', (name, p) => {
    const text = DARK_PALETTES.has(name as keyof typeof PALETTES) ? mixSrgb(p.danger, p.fg, 0.55) : p.danger;
    for (const g of [p.bg, p.surface, p.alt]) {
      expect(contrastRatio(text, g)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('the filled danger button', () => {
  /** A `#hex` or a `color-mix(in srgb, #a N%, #b)` of two. */
  const hex = (color: string) => {
    const mix = color.match(/^color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, (#[0-9a-f]{6})\)$/i);
    return mix ? mixSrgb(mix[1], mix[3], Number(mix[2]) / 100) : color;
  };

  it.each(Object.entries(PALETTES))('reads its words at 4.5:1 on its fill and on its hover fill in %s', (name, p) => {
    const palette = name as keyof typeof PALETTES;
    // cssVarsFor writes references; --on-accent and --term-danger-f as index.css defines them.
    const refs: Record<string, string> = {
      '--term-danger': p.danger, '--term-fg': p.fg, '--term-surface': p.surface, '--on-accent': p.bg,
      '--term-danger-f': mixSrgb(p.danger, p.surface, 0.09), '--term-danger-text': hex(dangerTextFor(palette)),
    };
    const resolve = (value: string) => hex(value.replace(/var\((--[\w-]+)\)/g, (_, ref: string) => refs[ref]));
    const vars = cssVarsFor(palette, p.accent);
    const ink = resolve(vars['--term-danger-btn-fg']);
    for (const fill of [vars['--term-danger-btn-bg'], vars['--term-danger-btn-hover']]) {
      expect(contrastRatio(ink, resolve(fill))).toBeGreaterThanOrEqual(4.5);
    }
  });
});


describe('--term-waiting-text', () => {
  it('mixes amber toward fg on the light palettes, is plain amber on the dark ones, and is emitted', () => {
    expect(waitingTextFor('bone')).toBe(`color-mix(in srgb, ${PALETTES.bone.select} 65%, ${PALETTES.bone.fg})`);
    expect(waitingTextFor('monokai')).toBe(PALETTES.monokai.select);
    for (const palette of ['monokai', 'gruvbox', 'bone', 'slate'] as const) {
      expect(cssVarsFor(palette, PALETTES[palette].accent)['--term-waiting-text']).toBe(waitingTextFor(palette));
    }
  });

  it.each(Object.entries(PALETTES))('reads as text on every %s ground, its waiting fill included', (name, p) => {
    const text = DARK_PALETTES.has(name as keyof typeof PALETTES) ? p.select : mixSrgb(p.select, p.fg, 0.65);
    for (const g of [p.bg, p.surface, p.alt, p.selectF]) {
      expect(contrastRatio(text, g)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('file-type badges', () => {
  /** A file of each badge family, and a link. */
  const badges = [...['notes.md', 'paper.pdf', 'sheet.csv', 'app.ts', 'data.json', 'photo.png'].map(manageFileType), MANAGE_LINK_TYPE];

  it.each(Object.entries(PALETTES))('reads each family label at 4.5:1 on its fill in %s, the accent family with any hue', (name, p) => {
    for (const accent of [p.accent, ...ACCENT_HUES.map(([hue]) => hue)]) {
      const vars = cssVarsFor(name as keyof typeof PALETTES, accent);
      const color = (token: string): Color => {
        const variable = token.match(/^var\((--[\w-]+)\)$/)?.[1];
        // index.css :root derives the danger fill; it is no palette variable.
        if (variable === '--term-danger-f') return blend(p.danger, p.surface, 0.09);
        const value = variable && vars[variable];
        if (!value) throw new Error(`No palette value for ${token}`);
        const mix = value.match(/^color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, (#[0-9a-f]{6})\)$/i);
        return mix ? blend(mix[1], mix[3], Number(mix[2]) / 100) : value;
      };
      for (const { label, text, fill } of badges) {
        expect(contrastRatio(color(text), color(fill)), `${label} with ${accent}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('raised selection surfaces', () => {
  function resolveColor(value: string): string {
    if (value.startsWith('#')) return value;
    const match = value.match(/^color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, (#[0-9a-f]{6})\)$/i);
    if (!match) throw new Error(`Unsupported color: ${value}`);
    return mixSrgb(match[1], match[3], Number(match[2]) / 100);
  }

  it.each(Object.entries(PALETTES))('keeps %s floating text readable and dark surfaces distinct', (name, p) => {
    const vars = cssVarsFor(name as keyof typeof PALETTES, p.accent);
    const background = resolveColor(vars['--sel-bar-bg']);
    for (const key of ['--sel-bar-fg', '--sel-bar-mid', '--sel-bar-muted']) {
      expect(contrastRatio(resolveColor(vars[key]), background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(resolveColor(vars['--sel-bar-action-fg']), resolveColor(vars['--sel-bar-action-bg']))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(resolveColor(vars['--sel-bar-focus']), background)).toBeGreaterThanOrEqual(3);
    if (DARK_PALETTES.has(name as keyof typeof PALETTES)) {
      expect(relativeLuminance(background)).toBeGreaterThan(relativeLuminance(p.surface) + 0.015);
      expect(relativeLuminance(background)).toBeLessThan(0.1);
    } else {
      expect(relativeLuminance(background)).toBeLessThan(0.1);
      expect(vars['--sel-bar-color-scheme']).toBe('dark');
      for (const key of ['--sel-bar-mid', '--sel-bar-muted']) {
        expect(contrastRatio(resolveColor(vars[key]), resolveColor(vars['--sel-bar-quote-bg']))).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(resolveColor(vars[key]), resolveColor(vars['--sel-bar-hover']))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('gives Slate a cool floating surface and Bone a warm one', () => {
    const slate = cssVarsFor('slate', PALETTES.slate.accent)['--sel-bar-bg'];
    const bone = cssVarsFor('bone', PALETTES.bone.accent)['--sel-bar-bg'];
    const rgb = (hex: string) => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
    const [sr, sg, sb] = rgb(slate);
    const [br, bg, bb] = rgb(bone);
    expect(sb).toBeGreaterThan(sg);
    expect(sg).toBeGreaterThan(sr);
    expect(br).toBeGreaterThan(bg);
    expect(bg).toBeGreaterThan(bb);
  });
});

describe('chart series', () => {
  const hex = (value: string): string => {
    if (value.startsWith('#')) return value;
    const match = value.match(/^color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, (#[0-9a-f]{6})\)$/i);
    if (!match) throw new Error(`Unsupported color: ${value}`);
    return mixSrgb(match[1], match[3], Number(match[2]) / 100);
  };
  const channels = (value: string) => [1, 3, 5].map((at) => parseInt(hex(value).slice(at, at + 2), 16));
  const apart = (a: string, b: string) => Math.hypot(...channels(a).map((c, i) => c - channels(b)[i]));
  const series = (vars: Record<string, string>) => [1, 2, 3, 4, 5].map((n) => vars[`--term-chart-${n}`]);

  it.each(Object.entries(PALETTES))('keeps every %s series apart from the accent and readable on the page', (name, p) => {
    const palette = name as keyof typeof PALETTES;
    // Series 1 is the accent itself, so a series hue the chosen accent sits on would draw two of them in one colour.
    for (const [accent, label] of [[p.accent, 'default'] as const, ...ACCENT_HUES]) {
      const hues = series(cssVarsFor(palette, accent));
      for (const hue of hues) {
        expect(apart(hue, accent), `${label} vs ${hue}`).toBeGreaterThan(39);
        for (const ground of [p.bg, p.surface, p.alt]) {
          expect(contrastRatio(hex(hue), ground), `${hue} on ${ground}`).toBeGreaterThanOrEqual(3);
        }
      }
      for (const [i, hue] of hues.entries()) {
        for (const other of hues.slice(i + 1)) expect(apart(hue, other), `${hue} vs ${other}`).toBeGreaterThan(39);
        // A series never reads as a verdict: no bar is the waiting amber, the done green or the danger red.
        for (const status of [p.select, p.digest, p.danger]) expect(apart(hue, status), `${hue} vs ${status}`).toBeGreaterThan(39);
      }
    }
  });

  it('leaves the hues alone for an accent none of them sits on, and steps the one that collides', () => {
    expect(series(cssVarsFor('bone', PALETTES.bone.accent))).toEqual(['#1b6396', '#0f766e', '#6d4aa8', '#a16207', '#8c877c']);
    expect(series(cssVarsFor('gruvbox', PALETTES.gruvbox.accent)).every((hue) => hue.startsWith('#'))).toBe(true);
    // Violet is bone's own third hue; picking it steps that series toward the text until the two stand apart.
    const violet = series(cssVarsFor('bone', '#6d4aa8'));
    expect(violet[2]).toMatch(/^color-mix\(in srgb, #6d4aa8 \d+%, #/);
    expect(violet.filter((hue) => hue.startsWith('#'))).toHaveLength(4);
  });
});
