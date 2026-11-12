import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const rules = ['content/db/db.css', 'rail/rail.css', 'spaces/home/home.css'].flatMap((file) =>
  [...readFileSync(join(here, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body })));

it('draws waiting on you in --term-waiting, leaving the accent to selection', () => {
  const waiting = rules.filter(({ selector }) => /\[data-(tone|status|home-tone)='waiting'\]|\[data-attention|__attention\b/.test(selector));
  expect(waiting.map(({ selector }) => selector)).toEqual([
    ".michi-card[data-attention='true']",
    ".michi-card[data-attention='true'][aria-current='true']",
    '.michi-card__attention',
    ".michi-task-status[data-status='waiting']",
    ".area-side__dot[data-tone='waiting']",
    ".spaces-home tr[data-home-tone='waiting'] > td:first-child::before",
  ]);
  for (const { selector, body } of waiting) {
    expect(body, selector).toContain('var(--term-waiting)');
    // The current card's 1px ring marks selection, which is the accent's.
    expect(body.replace('0 0 0 1px var(--term-accent)', ''), selector).not.toContain('--term-accent');
  }
});
