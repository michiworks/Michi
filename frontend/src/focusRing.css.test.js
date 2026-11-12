import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// The 2px keyboard focus ring is var(--focus-ring) (index.css); a rule may
// set its own outline-offset, but a literal accent ring drifts from it. Rings
// in a contrast colour on a filled background (--term-fg, --sel-bar-fg) and
// the thinner 1px rings are not this ring.
const root = dirname(fileURLToPath(import.meta.url));
const ACCENT_RING = /outline:\s*2px\s+solid\s+(?:var\(--term-accent\)|color-mix\(in srgb,\s*var\(--term-accent\))/;

function cssFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    // Vendored blocks keep their upstream CSS.
    if (name === 'node_modules' || name === 'vendor-blocks') return [];
    return statSync(path).isDirectory() ? cssFiles(path) : name.endsWith('.css') ? [path] : [];
  });
}

/** Innermost style rules: their selector text and declarations. */
function rulesOf(css) {
  const rules = [];
  for (let at = 0; at < css.length;) {
    const open = css.indexOf('{', at);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    for (; end < css.length && depth; end++) depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0;
    const head = css.slice(at, open).trim();
    const body = css.slice(open + 1, end - 1);
    if (head.startsWith('@')) rules.push(...rulesOf(body));
    else rules.push({ head, body });
    at = end;
  }
  return rules;
}

const read = (file) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

it('defines the focus ring once and the baseline rule uses it', () => {
  const index = read(join(root, 'index.css'));
  expect(index).toMatch(/--focus-ring:\s*2px solid color-mix\(in srgb, var\(--term-accent\) 62%, transparent\);/);
  const base = rulesOf(index).find(({ head }) => head.startsWith(":where(button, [role='button'], a[href], input, select, textarea):focus-visible"));
  expect(base?.body).toMatch(/outline:\s*var\(--focus-ring\);/);
});

it('uses var(--focus-ring) for every 2px accent focus ring', () => {
  const literal = [];
  for (const file of cssFiles(root)) {
    for (const { head, body } of rulesOf(read(file))) {
      if (/:focus(-visible|-within)?\b/.test(head) && ACCENT_RING.test(body)) {
        literal.push(`${relative(root, file)} ${head.replace(/\s+/g, ' ')}`);
      }
    }
  }
  expect(literal).toEqual([]);
});
