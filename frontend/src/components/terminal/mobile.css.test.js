import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'mobile.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

it('rounds every workflow card, the shell notices and the anchor and interrupted lists like the composer on the phone', () => {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, selectors, body]) => /--term-composer-radius:/.test(body) && selectors.includes('.terminal-composer'));
  const selectors = rule[1].split(',').map((selector) => selector.trim());
  expect(selectors).toEqual(expect.arrayContaining([
    '.terminal-composer', '.workflow-run-card', '.mm-card', '.background-workflow-card', '.background-subagent-card',
    '.shell-notice', '.shell-notice-tab', '.t-branch-anchors-list', '.interrupted-notice-list',
  ]));
});
