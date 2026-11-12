/**
 * rehype plugin: autolink bare URLs and scheme URLs inside code spans.
 *
 * GFM (remark-gfm) only autolinks `http(s)://`, `www.`, and emails — and
 * never inside `<code>`. Agents frequently emit URLs in backtick-wrapped code
 * spans that end up as non-clickable plain text. This plugin fixes that:
 *
 *   - Scheme-less bare URLs (`domain.tld/path`): linked everywhere EXCEPT
 *     inside `<code>` and `<pre>` (those are likely intentional code refs).
 *   - Full `https://` URLs: linked even inside inline `<code>` spans AND
 *     `<pre>` code blocks — clickable references even in code contexts.
 *   - Text inside `<a>`, svg/math/script/style and formulas is never touched.
 *
 * Runs on the HAST after sanitize, so it operates on a clean tree.
 */

import { findUrlMatches } from '../lib/linkify';
import { mathKind, type HastNode } from './rehypeHast';

const SKIP_TAGS = new Set(['a', 'script', 'style', 'svg', 'math']);
const SCHEME_ONLY_TAGS = new Set(['code', 'pre']);

function linkifyText(value: string, schemeOnly: boolean): HastNode[] | null {
  const matches = findUrlMatches(value, { schemeOnly });
  if (!matches.length) return null;

  const out: HastNode[] = [];
  let lastIndex = 0;
  for (const { start, end, url, href } of matches) {
    if (start > lastIndex) {
      out.push({ type: 'text', value: value.slice(lastIndex, start) });
    }
    out.push({
      type: 'element',
      tagName: 'a',
      properties: { href },
      children: [{ type: 'text', value: url }],
    });
    const trailing = value.slice(start + url.length, end);
    if (trailing) out.push({ type: 'text', value: trailing });
    lastIndex = end;
  }

  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
}

function walk(node: HastNode, mode: 'full' | 'scheme-only' | 'skip'): void {
  if (!Array.isArray(node.children)) return;
  const next: HastNode[] = [];

  for (const child of node.children) {
    if (child.type === 'text' && mode !== 'skip' && typeof child.value === 'string') {
      const replaced = linkifyText(child.value, mode === 'scheme-only');
      if (replaced) {
        next.push(...replaced);
        continue;
      }
      next.push(child);
      continue;
    }

    let childMode = mode;
    if (child.type === 'element' && child.tagName) {
      if (SKIP_TAGS.has(child.tagName) || mathKind(child) !== null) childMode = 'skip';
      else if (SCHEME_ONLY_TAGS.has(child.tagName) && mode === 'full') childMode = 'scheme-only';
    }
    if (Array.isArray(child.children)) walk(child, childMode);
    next.push(child);
  }

  node.children = next;
}

/** unified/rehype plugin. */
export function rehypeAutolinkBareUrls() {
  return function transformer(tree: HastNode) {
    walk(tree, 'full');
  };
}
