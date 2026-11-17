import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Vitest loads no CSS (css: false, which also empties a ?raw import of it), so
// the drawer's motion is read from its stylesheet; a .js test, since the
// frontend's TypeScript has no Node types.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'DrawerShell.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the rule written for exactly this selector. */
function rule(selector) {
  const match = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, head]) => head.trim() === selector);
  if (!match) throw new Error(`no ${selector} rule`);
  return match[2];
}

it('slides a closing drawer out over --t-collapse on EASE.drawer, after its --t-enter entrance', () => {
  expect(rule('.ui-drawer-panel.drawer-shell-panel')).toContain('transition: transform var(--t-enter) cubic-bezier(0.23, 1, 0.32, 1);');
  expect(rule(".drawer-shell-panel[data-state='closed']")).toContain('transition: transform var(--t-collapse) cubic-bezier(0.32, 0.72, 0, 1);');
});

it('keeps an instant drawer and a reduced-motion one from sliding either way', () => {
  expect(rule(".drawer-shell-panel[data-motion='instant']")).toContain('transition: none;');
  expect(rule(":root[data-reduce-motion='on'] .ui-drawer-panel.drawer-shell-panel")).toContain('transition: none;');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  expect(reduced).toMatch(/^@media \(prefers-reduced-motion: reduce\) \{\s*\.ui-drawer-panel\.drawer-shell-panel \{[^}]*transition: none;/);
});
