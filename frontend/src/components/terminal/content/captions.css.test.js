import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(join(here, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (file) => [...read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ file, selector: selector.trim(), body }));

it('sizes and spaces Michi’s caps captions with the type tokens, so a rescale of them reaches every caption', () => {
  const files = ['michi.css', 'page/michiPage.css', 'threads/peek.css', 'threads/threads.css', 'db/db.css', 'home/michiHome.css'];
  const literal = files.flatMap(rules)
    .filter(({ body }) => /text-transform:\s*uppercase/.test(body) && /font-size:\s*10px|letter-spacing:\s*0?\.14em/.test(body))
    .map(({ file, selector }) => `${file} ${selector}`);
  expect(literal).toEqual([]);
});

it('gives the caps tracking token no fallback: it is always defined, so a fallback only misleads', () => {
  for (const file of ['../spaces/spaces.css', '../spaces/metaChat/metaChat.css']) expect(read(file)).not.toMatch(/var\(--ls-caps-wide,/);
});
