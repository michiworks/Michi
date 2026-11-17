import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { DUR, EASE } from './tokens';

// Vitest stubs CSS imports (css: false), so index.css is read from disk.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function token(name) {
  const value = css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1];
  if (!value) throw new Error(`index.css has no --${name}`);
  return value.trim();
}

function seconds(name) {
  const [, amount, unit] = token(name).match(/^([\d.]+)(ms|s)$/) ?? [];
  if (!amount) throw new Error(`--${name} is not a duration`);
  return unit === 'ms' ? Number(amount) / 1000 : Number(amount);
}

it('mirrors the CSS motion tokens in motion/tokens.ts', () => {
  const oneShot = ['quick', 'soft', 'brief', 'dismiss', 'enter', 'exit', 'move', 'collapse', 'scrim-exit', 'decay', 'slow'];
  for (const name of oneShot) {
    const key = name.replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
    expect(DUR[key], `--t-${name}`).toBeCloseTo(seconds(`t-${name}`), 6);
  }
  const ease = token('t-ease').match(/cubic-bezier\(([^)]+)\)/)?.[1].split(',').map((n) => Number(n.trim()));
  expect(EASE.term).toEqual(ease);
});

it('cuts CSS motion under the OS setting exactly as under Settings › Reduce motion', () => {
  const declarations = (block) => (block ?? '').split(';').map((line) => line.trim()).filter(Boolean);
  const app = css.match(/:root\[data-reduce-motion='on'\] \*,\s*:root\[data-reduce-motion='on'\] \*::before,\s*:root\[data-reduce-motion='on'\] \*::after \{([^}]*)\}/)?.[1];
  const os = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{([^}]*)\}/)?.[1];
  expect(declarations(app)).toContain('animation-iteration-count: 1 !important');
  expect(declarations(os)).toEqual(declarations(app));
});
