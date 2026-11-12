import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Error words take --term-danger-text, which the dark palettes lift toward
// the foreground so it reads at 4.5:1 (tokens.ts dangerTextFor); the dimmer
// --term-danger is for glyphs, borders and fills. These are the glyphs and
// icons still coloured with it, by file. The list only shrinks: a new use
// fails, and so does one that is gone.
const KNOWN = {
  // × and ⚠ marks beside error words.
  'components/terminal/AgentBlockVariants.tsx': 1,
  'components/terminal/PaneCaption.tsx': 1,
  'components/terminal/PaneMessageList.tsx': 1,
  'components/terminal/backgroundWork/workCardParts.tsx': 1,
  'components/terminal/subagents/SubagentDetail.tsx': 1,
  'components/terminal/subagents/SubagentRoster.tsx': 1,
  'components/terminal/workflows/WorkflowRunPane.tsx': 1,
  'components/terminal/content/page/michiPage.css': 1,
  // Icons: the failed step's svg and ×, a bad payload's svg, an alert icon, Delete.
  'components/terminal/AgentLineBlocks.css': 3,
  'components/terminal/settings/metaAgent/metaAgentSettings.css': 1,
  'components/terminal/pages/Trash.css': 1,
  // Remove (×) buttons under the pointer.
  'index.css': 3,
};

const root = dirname(fileURLToPath(import.meta.url));
const DIM_COLOR = /(?<![-\w])color: ?'?var\(--term-danger\)/g;

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    // Vendored blocks keep their upstream styles.
    if (name === 'node_modules' || name === 'vendor-blocks') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(css|tsx?)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

function dimDangerUses() {
  const found = {};
  for (const file of sources(root)) {
    const count = readFileSync(file, 'utf8').match(DIM_COLOR)?.length ?? 0;
    if (count) found[relative(root, file)] = count;
  }
  return found;
}

it('colours no new text with --term-danger, and lists no glyph that is gone', () => {
  expect(dimDangerUses()).toEqual(KNOWN);
});
