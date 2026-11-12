import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// A control hidden (opacity 0) until its row is hovered needs a way to show
// on a touch screen, which has no hover: the shared reveal (.t-reveal in a
// .t-reveal-host, index.css), a `(hover: hover)` gate, or a `(hover: none)` /
// `(pointer: coarse)` rule of its own. This lists the classes that have none,
// as far as a class in a selector's last compound shows (an :is() list there
// is not read). The list only shrinks: a new one fails, and so does one that
// is gone.
const KNOWN = [
  // Decorative, not a control: the step chevron and the Branch shortcut hint.
  'components/terminal/AgentLineBlocks.css .agent-line__chev',
  'index.css .t-action-kbd',
  // Rendered by nothing (no .michi-home-row producer, Home.test.tsx).
  'components/terminal/content/home/michiHome.css .michi-home-row__check',
  // Page block chrome: always shown it would clutter a document; it needs a
  // tap-to-activate design rather than the shared reveal.
  'components/terminal/content/page/michiPage.css .michi-doc-block__margin',
  'components/terminal/content/page/michiPage.css .michi-doc-editor__remove',
  'components/terminal/content/page/michiPage.css .michi-doc-slot__add-btn',
  'components/terminal/content/page/michiPage.css .michi-doc-steps__start',
  'components/terminal/content/page/michiPage.css .michi-doc-toolbar',
];

const root = dirname(fileURLToPath(import.meta.url));

function cssFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    // Vendored blocks keep their upstream CSS.
    if (name === 'node_modules' || name === 'vendor-blocks') return [];
    return statSync(path).isDirectory() ? cssFiles(path) : name.endsWith('.css') ? [path] : [];
  });
}

/** Style rules with the @media conditions around them. */
function rulesOf(css, media = []) {
  const rules = [];
  for (let at = 0; at < css.length;) {
    const open = css.indexOf('{', at);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    for (; end < css.length && depth; end++) depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0;
    const head = css.slice(at, open).trim();
    const body = css.slice(open + 1, end - 1);
    if (/^@(media|supports|layer|container)/.test(head)) rules.push(...rulesOf(body, [...media, head]));
    else if (!head.startsWith('@')) rules.push({ selectors: head.split(/,(?![^()]*\))/), body, media });
    at = end;
  }
  return rules;
}

/** The classes of the element a selector styles: its last compound, without :is()/:not()/:has() arguments. */
function subjectClasses(selector) {
  let flat = selector;
  while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, '');
  return flat.trim().split(/[\s>+~]+/).pop()?.match(/\.[\w-]+/g) ?? [];
}

function revealsWithoutTouch() {
  const found = [];
  for (const file of cssFiles(root)) {
    const hidden = new Set();
    const shown = new Set();
    const touch = new Set();
    for (const { selectors, body, media } of rulesOf(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))) {
      const opacity = /(?:^|[;\s])opacity:\s*([\d.]+)/.exec(body)?.[1];
      if (opacity === undefined || media.some((m) => /hover:\s*hover/.test(m))) continue;
      const forTouch = media.some((m) => /hover:\s*none|pointer:\s*coarse/.test(m));
      for (const selector of selectors) {
        const hover = selector.includes(':hover');
        for (const name of subjectClasses(selector)) {
          if (forTouch) touch.add(name);
          else if (Number(opacity) === 0 && !hover) hidden.add(name);
          else if (Number(opacity) > 0 && hover) shown.add(name);
        }
      }
    }
    for (const name of hidden) if (shown.has(name) && !touch.has(name)) found.push(`${relative(root, file)} ${name}`);
  }
  return found.sort();
}

it('reveals no new control on hover alone, and lists none that is gone', () => {
  expect(revealsWithoutTouch()).toEqual([...KNOWN].sort());
});
