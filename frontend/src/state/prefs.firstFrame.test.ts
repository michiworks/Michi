import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import { PALETTES } from '../components/terminal/tokens';
import { DEFAULT_PREFS, PREFS_KEY, type TerminalPalette } from './prefs';

// index.html paints the saved palette before the bundle loads. It cannot import
// prefs.tsx, so this test runs its inline script against what prefs persists.
const head = indexHtml.slice(0, indexHtml.indexOf('</head>'));
const bootScript = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

function firstFrame(stored: Record<string, string>) {
  const attributes: Record<string, string> = {};
  const properties: Record<string, string> = {};
  const documentElement = {
    lang: '',
    style: { setProperty(name: string, value: string) { properties[name] = value; } },
    setAttribute(name: string, value: string) { attributes[name] = value; },
  };
  const localStorage = { getItem: (key: string) => stored[key] ?? null };
  const meta: Record<string, string> = {};
  const themeColor = { setAttribute(name: string, value: string) { meta[name] = value; } };
  new Function('localStorage', 'document', 'navigator', bootScript)(
    localStorage,
    { documentElement, querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? themeColor : null) },
    { language: 'en-US' },
  );
  return { background: properties['--michi-boot-bg'], palette: attributes['data-terminal-palette'], themeColor: meta.content };
}

describe('index.html first-frame palette', () => {
  it.each(Object.keys(PALETTES) as TerminalPalette[])('paints the saved %s palette background', (palette) => {
    const saved = JSON.stringify({ ...DEFAULT_PREFS, terminalPalette: palette });
    // The status-bar band starts in the palette's colour too (the Topbar then tracks itself).
    expect(firstFrame({ [PREFS_KEY]: saved })).toEqual({ background: PALETTES[palette].bg, palette, themeColor: PALETTES[palette].bg });
  });

  it('falls back to the default palette without saved or valid prefs', () => {
    const bg = PALETTES[DEFAULT_PREFS.terminalPalette].bg;
    const fallback = { background: bg, palette: DEFAULT_PREFS.terminalPalette, themeColor: bg };
    expect(firstFrame({})).toEqual(fallback);
    expect(firstFrame({ [PREFS_KEY]: JSON.stringify({ theme: 'night' }) })).toEqual(fallback);
    expect(firstFrame({ [PREFS_KEY]: JSON.stringify({ terminalPalette: 'constructor' }) })).toEqual(fallback);
    expect(firstFrame({ [PREFS_KEY]: '{not json' })).toEqual(fallback);
  });

  it('declares one theme-color, not a light/dark media pair', () => {
    expect(head.match(/<meta name="theme-color"/g)).toHaveLength(1);
    expect(head).toContain(`<meta name="theme-color" content="${PALETTES[DEFAULT_PREFS.terminalPalette].bg}" />`);
  });

  it('leaves the body background to the painted root', () => {
    expect(indexHtml).not.toMatch(/<body[^>]*background/);
  });

  it('leaves the root background to index.css so the live palette can replace it', () => {
    // An inline html background would outrank the stylesheet and freeze the boot color.
    expect(bootScript).not.toMatch(/style\.background\s*=/);
  });
});
