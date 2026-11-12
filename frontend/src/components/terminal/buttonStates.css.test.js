import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Vitest stubs CSS imports (css: false), so the stylesheets are read from
// disk; a .js test, since the frontend's TypeScript has no Node types.
const here = dirname(fileURLToPath(import.meta.url));
const css = (path) => readFileSync(join(here, path), 'utf8');
/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(sheet, selector) {
  const escaped = selector.replace(/[.():-]/g, '\\$&');
  const body = new RegExp(`(?:^|\\n)\\s*${escaped} \\{([^}]*)\\}`).exec(sheet)?.[1];
  if (body === undefined) throw new Error(`no ${selector} rule`);
  return body.trim();
}

describe('button states', () => {
  it('dims the drawer card\'s buttons and links while a command is in flight, as the chat card it copies does', () => {
    const drawer = css('backgroundWork/MultiModelWorkCard.css');
    const card = css('multiModel/MultiModelRunCard.css');
    expect(rule(drawer, '.mm-dbtn:disabled')).toBe(rule(card, '.mm-card .qbtn:disabled'));
    expect(rule(drawer, '.mm-dlink:disabled')).toBe(rule(card, '.mm-card .linkbtn:disabled'));
  });

  it('rounds the chat card\'s buttons by the Corner radius setting, like every other button', () => {
    expect(rule(css('multiModel/MultiModelRunCard.css'), '.mm-card .qbtn')).toContain('border-radius: var(--ui-radius);');
  });

  it('shows a disabled database primary (Creating…) as nothing to do yet, the way a disabled primary Button does', () => {
    const db = css('content/db/db.css');
    expect(rule(db, '.michi-db-btn:disabled')).toContain('cursor: not-allowed;');
    expect(rule(db, '.michi-db-btn--primary:disabled')).toMatch(/background: var\(--term-alt2\);[\s\S]*color: var\(--term-muted\);/);
    expect(db).not.toContain('.michi-db-btn--primary:hover {');
  });
});
