import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Hover paints only for a real pointer (DESIGN.md ST-02): a touch screen keeps
// :hover on the last element tapped, so a :hover rule sits inside
// @media (hover: hover), or (hover: hover) and (pointer: fine), and :active,
// outside the gate, gives taps their press. These are the hover selectors in
// CSS files still outside the gate, counted by file. The counts only shrink:
// a new one fails, and so does one that is gone.
const KNOWN = {
  'components/LandingPage.css': 5,
  'components/RemoteConnection.css': 1,
  'components/terminal/AgentLineBlocks.css': 2,
  'components/terminal/ReceiptLedger.css': 2,
  'components/terminal/SteeringReports.css': 1,
  'components/terminal/UserInputBanner.css': 5,
  'components/terminal/assistant/assistant.css': 6,
  'components/terminal/companion/companion.css': 6,
  'components/terminal/content/db/db.css': 20,
  'components/terminal/content/home/michiHome.css': 11,
  'components/terminal/content/michi.css': 4,
  'components/terminal/content/page/michiPage.css': 4,
  'components/terminal/content/threads/peek.css': 7,
  'components/terminal/content/threads/threads.css': 6,
  'components/terminal/home/homeCards.css': 3,
  'components/terminal/pages/Settings.css': 1,
  'components/terminal/pages/settings/history.css': 1,
  'components/terminal/pages/settings/memory.css': 1,
  'components/terminal/pages/settings/skills.css': 1,
  'components/terminal/rail/rail.css': 4,
  'components/terminal/sidebar.css': 3,
  'components/terminal/spaces/components/components.css': 1,
  'components/terminal/spaces/conversation/conversation.css': 4,
  'components/terminal/spaces/home/home.css': 6,
  'components/terminal/spaces/metaChat/metaChat.css': 4,
  'components/terminal/spaces/nativeMarkdownSegments.css': 3,
  'components/terminal/spaces/pageChanges.css': 8,
  'components/terminal/spaces/spaceSettings.css': 1,
  'components/terminal/spaces/spaces.css': 5,
  'components/terminal/spaces/spacesSidebar.css': 3,
  'components/ui/BottomSheet.css': 1,
  'index.css': 42,
};

const root = dirname(fileURLToPath(import.meta.url));

function cssFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    // Vendored blocks keep their upstream CSS.
    if (name === 'node_modules' || name === 'vendor-blocks') return [];
    return statSync(path).isDirectory() ? cssFiles(path) : name.endsWith('.css') ? [path] : [];
  });
}

/** Style rules with the at-rule conditions around them. */
function rulesOf(css, conditions = []) {
  const rules = [];
  for (let at = 0; at < css.length;) {
    const open = css.indexOf('{', at);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    for (; end < css.length && depth; end++) depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0;
    const head = css.slice(at, open).trim();
    const body = css.slice(open + 1, end - 1);
    if (/^@(media|supports|layer|container)/.test(head)) rules.push(...rulesOf(body, [...conditions, head]));
    else if (!head.startsWith('@')) rules.push({ head, conditions });
    at = end;
  }
  return rules;
}

/** A selector list split at its top-level commas, whitespace collapsed. */
function selectorsOf(head) {
  const selectors = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '(') depth++;
    else if (head[i] === ')') depth--;
    else if (head[i] === ',' && depth === 0) {
      selectors.push(head.slice(start, i));
      start = i + 1;
    }
  }
  return [...selectors, head.slice(start)].map((selector) => selector.trim().replace(/\s+/g, ' '));
}

/** Whether a selector matches on hover: a :hover that is not inside a :not(). */
function onHover(selector) {
  let flat = selector;
  for (let before; before !== flat;) {
    before = flat;
    flat = flat.replace(/(:not)?\(([^()]*)\)/g, (_, not, inner) => (not ? '' : `[${inner}]`));
  }
  return /:hover\b/.test(flat);
}

const gated = (conditions) => conditions.some((condition) => /^@media\b/.test(condition) && /(?:^|[^-\w])hover:\s*hover\b/.test(condition));

function ungatedHovers() {
  const counts = {};
  for (const file of cssFiles(root)) {
    for (const { head, conditions } of rulesOf(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))) {
      if (gated(conditions)) continue;
      const hovers = selectorsOf(head).filter(onHover).length;
      if (hovers) counts[relative(root, file)] = (counts[relative(root, file)] ?? 0) + hovers;
    }
  }
  return counts;
}

it('gates every new hover, and counts none that is gone', () => {
  expect(ungatedHovers()).toEqual(KNOWN);
});
