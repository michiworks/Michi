import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Vitest stubs CSS imports (css: false), so sources and stylesheets are read
// from disk; a .js test, since the frontend's TypeScript has no Node types.
const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(src, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor-blocks' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function rule(css, selector) {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no ${selector} rule`);
  return css.slice(at, css.indexOf('}', at));
}

it('loops running indicators through classes, which the reduced-motion rules can stop', () => {
  const inline = /['"`](tpulse|termBreathe|pulse|tspin) [^'"`]*infinite['"`]/;
  const offenders = sources(src).filter((path) => inline.test(readFileSync(path, 'utf8')));
  expect(offenders.map((path) => relative(src, path))).toEqual([]);
});

it('colours running with --term-run, not the accent a user may pick red', () => {
  expect(rule(read('components/terminal/mobile.css'), '.mobile-pane-status')).toContain('background: var(--term-run)');
});

it('spins the area sidebar spinner at the shared pace and stops it under reduced motion', () => {
  const css = read('components/terminal/rail/rail.css');
  expect(rule(css, '.area-side__spin')).toContain('tspin var(--t-loop-fast)');
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.area-side__spin \{ animation: none; \}/);
});
