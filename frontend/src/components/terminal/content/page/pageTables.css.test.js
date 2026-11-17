import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(join(here, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** The rules outside any @media or @container block: what applies at every width. */
const topLevel = (css) => css.replace(/@(?:media|container)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
const rules = (css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
const page = read('michiPage.css');

it('breaks a long sentence inside its cell at every width, and never cuts a one-word cell (a ticket number, a CR) in two', () => {
  const cells = rules(topLevel(page)).filter(({ selector }) => /^\.michi-doc-table td\b/.test(selector));
  const breaking = cells.filter(({ body }) => /overflow-wrap:\s*anywhere/.test(body));
  // Breaking is not left to a width: overflow-wrap: break-word would keep a long word's full width
  // and widen the table, so a wide pane would scroll where it could have wrapped.
  expect(breaking.map(({ selector }) => selector)).toEqual(['.michi-doc-table td:not([data-one-line])']);
  expect(cells.find(({ selector }) => selector === '.michi-doc-table td[data-one-line]')?.body).toMatch(/white-space:\s*nowrap/);
  // No container query decides a table's wrapping, so nothing here depends on a container that may go away.
  const narrow = [...page.matchAll(/@container[^{]*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)].flatMap(([, inner]) => rules(inner));
  expect(narrow.filter(({ selector }) => /\.michi-doc-table\b/.test(selector))).toEqual([]);
});

it('draws page table headers in the words’ own case, at the size of the cells below them', () => {
  const heads = rules(topLevel(page)).filter(({ selector }) =>
    selector === '[data-native-page] .michi-doc-table th' || selector === ".space-doc [data-michi-block='markdown'] .prose th");
  expect(heads).toHaveLength(2);
  for (const { selector, body } of heads) {
    expect(body, selector).not.toMatch(/text-transform:\s*uppercase/);
    expect(body, selector).toMatch(/font(?:-size)?:\s*[^;]*var\(--fs-md\)/);
  }
});

it('gives a block its tone wherever the block is drawn, not only on a page', () => {
  const tones = rules(topLevel(page)).filter(({ body }) => /--tone:/.test(body));
  expect(tones.map(({ selector }) => selector)).toEqual([
    ":is([data-michi-block], [data-michi-block] *)[data-tone='info']",
    ":is([data-michi-block], [data-michi-block] *)[data-tone='warn']",
    ":is([data-michi-block], [data-michi-block] *)[data-tone='success']",
    ":is([data-michi-block], [data-michi-block] *)[data-tone='danger']",
  ]);
  // A chat answer renders the same blocks under .t-chat-blocks, with no .michi-doc above them: a host-scoped
  // tone would leave every callout and badge there on the neutral tint, telling warn from danger by nothing.
  for (const { selector, body } of tones) {
    expect(selector, body).not.toMatch(/\.michi-doc\b/);
    expect(body, selector).toMatch(/--tone-text:/);
  }
  // The tone a block reads: the callout's tint, a badge's tint, every dot and the track's words.
  expect(rules(topLevel(page)).filter(({ body }) => /var\(--tone[,)]/.test(body)).length).toBeGreaterThan(4);
});
