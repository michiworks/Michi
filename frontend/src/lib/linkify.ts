import { CJK_URL_STOP_CHARS } from '../components/remarkCjkAutolinkBoundary';
/**
 * Where URLs sit in plain text. The Markdown autolink pass and code blocks,
 * which link their own text after the Markdown pipeline, both find them here.
 */

interface UrlMatch {
  start: number;
  /** End of the match, including trailing sentence punctuation that `url` leaves out. */
  end: number;
  url: string;
  href: string;
}

// URL body: no whitespace, brackets or quotes, and no CJK/full-width
// punctuation, so "example.com/a，然后" links only "example.com/a".
const URL_CHAR = `[^\\s<>()'"${CJK_URL_STOP_CHARS}]`;
// domain (labels + real-ish TLD) immediately followed by a required /path.
// Lookbehind blocks matches glued to a scheme (`://`), an email (`@`), a path
// segment (`/`), or another word char — so we don't re-link inside URLs that
// GFM already handled, nor inside file paths like `src/index.css`.
const BARE_URL_RE = new RegExp(
  `(?<![@\\w./:-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,24})(\\/${URL_CHAR}*)`,
  'gi',
);
// Full scheme URLs (https://...) — needed for code spans where GFM autolink
// doesn't operate.
const FULL_URL_RE = new RegExp(`https?:\\/\\/${URL_CHAR}+`, 'gi');
// www. URLs without a scheme — treated like scheme URLs (linked in code too).
const WWW_URL_RE = new RegExp(`(?<![/@\\w.-])www\\.${URL_CHAR}+`, 'gi');
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/** URLs in `text`, in order and not overlapping. `schemeOnly` skips scheme-less domain/path URLs. */
export function findUrlMatches(text: string, { schemeOnly }: { schemeOnly: boolean }): UrlMatch[] {
  const matches: UrlMatch[] = [];

  if (!schemeOnly) {
    BARE_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BARE_URL_RE.exec(text)) !== null) {
      let url = m[0];
      const trailing = TRAILING_PUNCT_RE.exec(url)?.[0] ?? '';
      if (trailing) url = url.slice(0, url.length - trailing.length);
      if (!url.includes('/')) continue;
      matches.push({ start: m.index, end: m.index + url.length + trailing.length, url, href: `https://${url}` });
    }
  }

  FULL_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FULL_URL_RE.exec(text)) !== null) {
    let url = m[0];
    const trailing = TRAILING_PUNCT_RE.exec(url)?.[0] ?? '';
    if (trailing) url = url.slice(0, url.length - trailing.length);
    matches.push({ start: m.index, end: m.index + url.length + trailing.length, url, href: url });
  }

  WWW_URL_RE.lastIndex = 0;
  while ((m = WWW_URL_RE.exec(text)) !== null) {
    let url = m[0];
    const trailing = TRAILING_PUNCT_RE.exec(url)?.[0] ?? '';
    if (trailing) url = url.slice(0, url.length - trailing.length);
    matches.push({ start: m.index, end: m.index + url.length + trailing.length, url, href: `https://${url}` });
  }

  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const deduped: UrlMatch[] = [];
  for (const entry of matches) {
    const prev = deduped[deduped.length - 1];
    if (prev && entry.start < prev.start + prev.url.length) continue;
    deduped.push(entry);
  }
  return deduped;
}
