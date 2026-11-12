/**
 * What a check-in may not write into Pages (DESIGN-v2 §2.6.2): anything that
 * reaches outside Michi when the page shows (a picture, a video, an embedded
 * page) and any link the user could click to somewhere other than Michi and
 * the work sites the user's agent watches.
 *
 * The inventory below is keyed by the code's own catalogs (PAGE_BLOCK_TYPES,
 * MICHI_DB_COLUMN_TYPES, MICHI_DB_VIEW_TYPES), so a new block, column or view
 * type does not compile until it is registered here, and the ratchet test
 * (backend/test/pagesRemoteMedia.test.ts) fails when a URL field or a list of
 * nested blocks appears in a block schema without being classified. Every
 * string a check-in writes is also read as the page renders Markdown (the same
 * GFM and math parser, plus its bare-address autolinker): pictures and raw
 * HTML media are refused anywhere, links only to the allowed places. This
 * errs towards refusing: a check-in that hits it proposes the content to the
 * user instead.
 *
 * W2-E's checkinPageGuard calls checkinWriteProblem for the six page write
 * tools a check-in has; a problem refuses the whole call. Storage checks a
 * check-in's page content once more as it is saved (repository.ts
 * savePageContent and createPage, checkinBlocksProblem), whatever tool wrote it.
 */
import {
  PAGE_TEMPLATES, taskDatabaseColumns, taskDatabaseViews,
  type MichiDbColumnType, type MichiDbViewType, type PageBlock, type PageBlockType, type PageTemplateKey,
} from 'michi-shared';
import { fromMarkdown, type Options as MarkdownOptions } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import { parseFragment } from 'parse5';
import { canonical } from './canonicalJson';
import { PageWriteError, requirePagesWorkspace } from './core';
import { getDb } from '../db';

/**
 * How one block type reaches outside Michi when it renders.
 * - `inert`: never (its strings are still scanned as Markdown);
 * - `urls`: `loads` are fields fetched as soon as the block shows (refused
 *   whenever set), `links` fields the user may click (allowed links only);
 * - `container`: nested blocks at these paths, each checked by its own type;
 * - `blocked`: the type can load or link to what it likes (library code, or a
 *   link its renderer builds from the block's text), so a check-in may not write it.
 * Paths are dot-separated; `[]` steps into every item of a list.
 */
export type BlockRemoteRule =
  | { kind: 'inert' }
  | { kind: 'urls'; loads: readonly string[]; links: readonly string[] }
  | { kind: 'container'; children: readonly string[] }
  | { kind: 'blocked'; why: string };

const INERT: BlockRemoteRule = Object.freeze({ kind: 'inert' });
const urls = (loads: readonly string[], links: readonly string[] = []): BlockRemoteRule => Object.freeze({ kind: 'urls', loads, links });
const container = (...children: string[]): BlockRemoteRule => Object.freeze({ kind: 'container', children });

export const BLOCK_REMOTE_RULES: { readonly [T in PageBlockType]: BlockRemoteRule } = Object.freeze({
  heading: INERT, markdown: INERT, callout: INERT, checklist: INERT, metrics: INERT, 'next-steps': INERT, timeline: INERT,
  'plan-actual': INERT, compare: INERT, conflict: INERT, table: INERT, criteria: INERT, chart: INERT,
  gallery: urls(['items[].url']),
  forgot: INERT, threads: INERT, 'database-ref': INERT, 'home-section': INERT, 'task-view': INERT, 'page-link': INERT,
  component: Object.freeze({ kind: 'blocked', why: 'a library component can load anything its props name' }),
  quote: INERT, divider: INERT, toc: INERT, code: INERT, diff: INERT, math: INERT, mermaid: INERT, keyvalue: INERT, tags: INERT,
  status: INERT, stat: INERT, progress: INERT, ring: INERT, gauge: INERT, leaderboard: INERT, rating: INERT, 'pros-cons': INERT,
  choice: INERT, milestones: INERT, stepper: INERT, agenda: INERT, calendar: INERT, gantt: INERT, countdown: INERT, clocks: INERT,
  image: urls(['url']),
  'before-after': urls(['before', 'after']),
  carousel: urls(['items[].url']),
  video: urls(['url']),
  audio: urls(['url']),
  embed: urls(['url']),
  link: urls(['image'], ['url']),
  file: INERT,
  person: urls(['avatar'], ['links[].url']),
  // PlaceBlock (vendor-blocks .../media/cards.tsx) always links "Open in maps" to
  // https://maps.apple.com/?q=<address or name>: a click sends text the check-in chose.
  place: Object.freeze({ kind: 'blocked', why: 'its card always links to Apple Maps with the name or address in the link' }),
  actions: INERT, form: INERT, poll: INERT,
  toggle: container('blocks[]'),
  columns: container('columns[][]'),
  grid: container('regions[].blocks[]'),
  tabs: container('tabs[].blocks[]'),
  view: INERT, 'view-link': INERT,
});

/** A column type: `loads` = its cells render as pictures; `link` = as links the user may click. */
export type ColumnRemoteRule = 'inert' | 'loads' | 'link';

export const COLUMN_REMOTE_RULES: { readonly [T in MichiDbColumnType]: ColumnRemoteRule } = Object.freeze({
  text: 'inert', number: 'inert', date: 'inert', select: 'inert', multi: 'inert', checkbox: 'inert',
  url: 'link', progress: 'inert', app: 'inert', image: 'loads', threads: 'inert',
});

/** A view type: `loads` = config fields that, when set, make the view draw pictures; `blocked` = a library component's view. */
export type ViewRemoteRule =
  | { kind: 'inert' }
  | { kind: 'urls'; loads: readonly string[] }
  | { kind: 'blocked'; why: string };

const INERT_VIEW: ViewRemoteRule = Object.freeze({ kind: 'inert' });

export const VIEW_REMOTE_RULES: { readonly [T in MichiDbViewType]: ViewRemoteRule } = Object.freeze({
  table: INERT_VIEW, board: INERT_VIEW, list: INERT_VIEW, calendar: INERT_VIEW, timeline: INERT_VIEW,
  // A gallery draws a picture on every card from its cover column, which is
  // `config.cover` when that names an image column and otherwise the first
  // image column (shared/src/database/viewModel.ts coverColumn). Setting a
  // cover is refused; without one a gallery can only show pictures the person
  // put in an image column, since a check-in can neither add an image column
  // nor write an image cell.
  gallery: Object.freeze({ kind: 'urls', loads: ['config.cover'] }),
  custom: Object.freeze({ kind: 'blocked', why: 'a custom view is a library component that can load anything its props name' }),
});

/**
 * The https sites a check-in may link to: the work sites it watches, the same
 * list the conversation's link renderer allows for the Companion's posts
 * (frontend/src/state/companion/companionLinks.ts COMPANION_LINK_HOSTS; the
 * test holds the two equal). `michi://` links and in-page `#` anchors are allowed too.
 */
export const CHECKIN_LINK_HOSTS: readonly string[] = Object.freeze([
  'reviews.example.com',
  'builds.example.com',
  'outlook.office.com',
  'outlook.office365.com',
]);

/** The page write tools a check-in has (DESIGN-v2 §2.3), each checked by checkinWriteProblem before it writes. */
export const CHECKIN_PAGE_WRITE_TOOLS = Object.freeze([
  'edit_page', 'create_page', 'edit_database', 'create_database', 'configure_database', 'open_task_database',
] as const);
export type CheckinPageWriteTool = typeof CHECKIN_PAGE_WRITE_TOOLS[number];

export interface RemoteContentProblem {
  /** Where in the tool's arguments: `ops[0].block.url`. */
  path: string;
  /** `loads`: fetched when the page shows; `link`: a link outside the allowed places; `blocked`: a type a check-in may not write. */
  kind: 'loads' | 'link' | 'blocked';
  /** The tool error the model reads; it ends by telling it to propose the content to the user. */
  message: string;
}

const PROPOSE = 'A check-in cannot write this into the user\'s pages; propose it to the user instead.';
const MAX_SHOWN = 80;
/** Values nested deeper than this are refused rather than left unread. */
const MAX_VALUE_DEPTH = 32;

type Json = Record<string, unknown>;
type Found = RemoteContentProblem | null;
const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const shown = (value: string): string => (value.length > MAX_SHOWN ? `${value.slice(0, MAX_SHOWN)}…` : value);
const join = (base: string, step: string | number): string => (typeof step === 'number' ? `${base}[${step}]` : base ? `${base}.${step}` : step);
const present = (value: unknown): boolean => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim());

function problem(path: string, kind: RemoteContentProblem['kind'], detail: string): RemoteContentProblem {
  return { path, kind, message: `${path || 'The content'} ${detail}. ${PROPOSE}` };
}

function linkProblem(path: string, target: string): RemoteContentProblem {
  return problem(path, 'link', `links to ${shown(target)}; a check-in may link only to Michi and ${CHECKIN_LINK_HOSTS.join(', ')}`);
}

/**
 * A link the user may click: Michi's own, an in-page anchor, or https to an
 * allowed site. The address as written must name the site exactly (no user
 * name, port, escape, quote or percent sign before the path), and so must the
 * URL the browser makes of it: renderers percent-encode a link before the
 * browser reads it, which turns `\` into `%5C` and moves the host after an `@`.
 */
export function isAllowedCheckinLink(target: string): boolean {
  const value = target.trim();
  if (!value || value.startsWith('#')) return true;
  if (/^michi:\/\//i.test(value)) return true;
  const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (authority === undefined || !CHECKIN_LINK_HOSTS.includes(authority.toLowerCase())) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && CHECKIN_LINK_HOSTS.includes(url.hostname.toLowerCase());
}

// ── Text as the page renders it ────────────────────────────────────────────

// Raw text first: whatever parses as Markdown, these never get through.
const MARKDOWN_PICTURE = /!\[[^\]\n]*\]\s*[([]/;
const HTML_MEDIA = /<\s*\/?\s*(?:img|image|picture|source|video|audio|track|iframe|frame|frameset|embed|object|applet|svg|use|link|script|style|meta|base|input|portal)\b/i;
const HTML_FETCH_ATTRIBUTE = /<[a-z][^>]*?\s(?:src|srcset|lowsrc|dynsrc|poster|background|data|ping|xlink:href)\s*=/i;
const HTML_STYLE_URL = /<[a-z][^>]*?\sstyle\s*=[^>]*url\s*\(/i;

/**
 * What the page's autolinker links in text (frontend/src/components/
 * rehypeAutolinkBareUrls.ts, the same expressions): scheme-less
 * `domain.tld/path` outside code, and http(s) and www addresses everywhere,
 * code included. A scheme-less or www address opens as https.
 */
const AUTOLINK_BARE = /(?<![@\w./:-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(\/[^\s<>()'"]*)/gi;
const AUTOLINK_FULL = /https?:\/\/[^\s<>()'"]+/gi;
const AUTOLINK_WWW = /(?<![/@\w.-])www\.[^\s<>()'"]+/gi;
const AUTOLINK_TRAILING = /[.,;:!?]+$/;
/**
 * Wider than any renderer: an address with a scheme, or starting `www.`, as
 * far as GFM's autolinks reach (they do not stop at a quote or bracket), less
 * the punctuation that closes a sentence.
 */
const WIDE_SCHEME = /[a-z][a-z0-9+.-]*:\/\/[^\s<>]*/gi;
const WIDE_WWW = /(?<![\w@/.-])www\.[^\s<>]*/gi;
const WIDE_TRAILING = /[.,;:!?)\]}*_~'"]+$/;

/** Every address in a run of text that could become a link. `code`: the text is code, which the autolinker leaves scheme-less addresses alone in. */
function* textAddresses(text: string, code: boolean): Generator<string> {
  if (!code) {
    for (const match of text.matchAll(AUTOLINK_BARE)) {
      const url = match[0].replace(AUTOLINK_TRAILING, '');
      if (url.includes('/')) yield `https://${url}`;
    }
  }
  for (const match of text.matchAll(AUTOLINK_FULL)) yield match[0].replace(AUTOLINK_TRAILING, '');
  for (const match of text.matchAll(AUTOLINK_WWW)) yield `https://${match[0].replace(AUTOLINK_TRAILING, '')}`;
  for (const match of text.matchAll(WIDE_SCHEME)) yield match[0].replace(WIDE_TRAILING, '');
  for (const match of text.matchAll(WIDE_WWW)) yield `https://${match[0].replace(WIDE_TRAILING, '')}`;
}

function addressProblem(text: string, path: string, code: boolean): Found {
  for (const address of textAddresses(text, code)) if (!isAllowedCheckinLink(address)) return linkProblem(path, address);
  return null;
}

/** Raw HTML as the page renders it (rehype-raw parses it with parse5): what loads, where it links, and the text it shows. */
const HTML_MEDIA_TAGS = new Set(['img', 'image', 'picture', 'source', 'video', 'audio', 'track', 'iframe', 'frame', 'frameset', 'embed',
  'object', 'applet', 'svg', 'use', 'link', 'script', 'style', 'meta', 'base', 'input', 'portal']);
const HTML_FETCH_ATTRIBUTES = new Set(['src', 'srcset', 'lowsrc', 'dynsrc', 'poster', 'background', 'data', 'ping', 'action', 'formaction',
  'codebase', 'archive', 'longdesc', 'manifest', 'icon']);
type HtmlNode = { nodeName: string; value?: string; attrs?: Array<{ name: string; value: string }>; childNodes?: HtmlNode[]; content?: HtmlNode };

function htmlProblem(html: string, path: string): Found {
  const loads = (): RemoteContentProblem => problem(path, 'loads', 'holds HTML that loads from the internet when the page shows');
  if (HTML_MEDIA.test(html) || HTML_FETCH_ATTRIBUTE.test(html) || HTML_STYLE_URL.test(html)) return loads();
  const stack: Array<[HtmlNode, boolean, number]> = [[parseFragment(html) as unknown as HtmlNode, false, 0]];
  while (stack.length) {
    const [node, code, depth] = stack.pop()!;
    if (depth > MAX_VALUE_DEPTH) return problem(path, 'blocked', 'nests HTML too deeply to check');
    if (node.nodeName === '#text') {
      const found = addressProblem(node.value ?? '', path, code);
      if (found) return found;
      continue;
    }
    if (HTML_MEDIA_TAGS.has(node.nodeName)) return loads();
    for (const { name, value } of node.attrs ?? []) {
      const attribute = name.toLowerCase();
      if (HTML_FETCH_ATTRIBUTES.has(attribute) || (attribute === 'style' && /url\s*\(|image-set|@import/i.test(value))) return loads();
      if ((attribute === 'href' || attribute.endsWith(':href')) && !isAllowedCheckinLink(value)) return linkProblem(path, value);
    }
    const inCode = code || node.nodeName === 'code' || node.nodeName === 'pre';
    for (const child of [...(node.childNodes ?? []), ...(node.content ? [node.content] : [])]) stack.push([child, inCode, depth + 1]);
  }
  return null;
}

/** The pieces of an mdast tree this reads. */
type MdNode = { type: string; url?: string; value?: string; children?: MdNode[] };

/**
 * The two readings of a string: the page's own (MarkdownContent: GFM and
 * math), and GFM alone, since math can hide or move a link the other reading
 * finds. Both are checked; either may refuse.
 */
let readings: MarkdownOptions[] | null = null;
function markdownReadings(): MarkdownOptions[] {
  readings ??= [
    { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] },
    { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] },
  ];
  return readings;
}

const PICTURE_NODES = new Set(['image', 'imageReference']);
const LINK_NODES = new Set(['link', 'definition']);
const CODE_NODES = new Set(['inlineCode', 'code']);
const TEXT_NODES = new Set(['text', 'inlineMath', 'math']);
/** Runs of text the renderer can join into one across inline HTML it drops (a stray `</b>`), so each is also read whole. */
const TEXT_RUNS = new Set(['paragraph', 'heading', 'tableCell']);

/** The text of a run with its inline HTML left out. */
function runText(node: MdNode): string {
  if (node.type === 'html') return '';
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(runText).join('');
}

function markdownTreeProblem(tree: MdNode, path: string): Found {
  const stack: Array<[MdNode, number]> = [[tree, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (depth > 4 * MAX_VALUE_DEPTH) return problem(path, 'blocked', 'nests Markdown too deeply to check');
    if (PICTURE_NODES.has(node.type)) return problem(path, 'loads', 'holds a Markdown picture, which loads from the internet when the page shows');
    if (LINK_NODES.has(node.type) && !isAllowedCheckinLink(node.url ?? '')) return linkProblem(path, node.url ?? '');
    if (node.type === 'html') {
      const found = htmlProblem(node.value ?? '', path);
      if (found) return found;
    }
    if (CODE_NODES.has(node.type) || TEXT_NODES.has(node.type)) {
      const found = addressProblem(node.value ?? '', path, CODE_NODES.has(node.type));
      if (found) return found;
    }
    if (TEXT_RUNS.has(node.type)) {
      const found = addressProblem(runText(node), path, false);
      if (found) return found;
    }
    for (const child of node.children ?? []) stack.push([child, depth + 1]);
  }
  return null;
}

/**
 * Why a string a check-in writes would reach outside Michi when drawn as
 * Markdown, or null. It is read the way the page reads it (a Markdown parser
 * with GFM and math, raw HTML through an HTML parser, the bare-address
 * autolinker), so escapes, entities and quotes are seen as the browser will
 * see them; raw-text checks refuse a little more on top.
 */
export function remoteTextProblem(text: string, path: string): Found {
  // Nothing without one of these can make a link or a picture.
  if (!/[[<:.&@]/.test(text)) return null;
  if (MARKDOWN_PICTURE.test(text)) return problem(path, 'loads', 'holds a Markdown picture, which loads from the internet when the page shows');
  if (HTML_MEDIA.test(text) || HTML_FETCH_ATTRIBUTE.test(text) || HTML_STYLE_URL.test(text)) {
    return problem(path, 'loads', 'holds HTML that loads from the internet when the page shows');
  }
  for (const match of text.matchAll(WIDE_SCHEME)) {
    const address = match[0].replace(WIDE_TRAILING, '');
    if (!isAllowedCheckinLink(address)) return linkProblem(path, address);
  }
  for (const options of markdownReadings()) {
    let tree: MdNode;
    try { tree = fromMarkdown(text, options) as unknown as MdNode; } catch {
      return problem(path, 'blocked', 'could not be read as Markdown');
    }
    const found = markdownTreeProblem(tree, path);
    if (found) return found;
  }
  return null;
}

/** Every string in a value with its path, leaving out the subtrees at `skip`; a value nested deeper than MAX_VALUE_DEPTH is a problem, not skipped. */
function stringsOf(value: unknown, path: string, skip: ReadonlySet<string> = new Set()): Array<[string, string]> | RemoteContentProblem {
  const out: Array<[string, string]> = [];
  const stack: Array<[unknown, string, number]> = [[value, path, 0]];
  while (stack.length) {
    const [item, at, depth] = stack.pop()!;
    if (skip.has(at) || item === null || (typeof item !== 'string' && typeof item !== 'object')) continue;
    if (depth > MAX_VALUE_DEPTH) return problem(at, 'blocked', 'nests values too deeply to check');
    if (typeof item === 'string') { out.push([item, at]); continue; }
    const entries: Array<[string, unknown]> = Array.isArray(item)
      ? item.map((child, index): [string, unknown] => [join(at, index), child])
      : Object.entries(item as Json).map(([key, child]): [string, unknown] => [join(at, key), child]);
    for (const [childPath, child] of entries.reverse()) stack.push([child, childPath, depth + 1]);
  }
  return out;
}

function firstTextProblem(value: unknown, path: string, skip?: ReadonlySet<string>): Found {
  const found = stringsOf(value, path, skip);
  if (!Array.isArray(found)) return found;
  for (const [text, at] of found) {
    const textProblem = remoteTextProblem(text, at);
    if (textProblem) return textProblem;
  }
  return null;
}

// ── Blocks, columns, views and cells ───────────────────────────────────────

/** The values at a rule path (`items[].url`, `columns[][]`), each with its concrete path under `base`. */
export function valuesAtPath(root: unknown, path: string, base = ''): Array<[unknown, string]> {
  let current: Array<[unknown, string]> = [[root, base]];
  for (const step of path.split('.')) {
    const name = step.replace(/(\[\])+$/, '');
    const lists = (step.length - name.length) / 2;
    current = current.flatMap(([value, at]): Array<[unknown, string]> =>
      (!name ? [[value, at]] : isRecord(value) && Object.hasOwn(value, name) ? [[value[name], join(at, name)]] : []));
    for (let level = 0; level < lists; level += 1) {
      current = current.flatMap(([value, at]): Array<[unknown, string]> =>
        (Array.isArray(value) ? value.map((item, index): [unknown, string] => [item, join(at, index)]) : []));
    }
  }
  return current;
}

/** Why a block (page content, as a tool sends it or as stored) would reach outside Michi when drawn, or null. */
export function blockRemoteProblem(block: unknown, path = 'block', depth = 0): Found {
  if (!isRecord(block) || typeof block.type !== 'string' || !Object.hasOwn(BLOCK_REMOTE_RULES, block.type)) {
    return problem(path, 'blocked', 'is not a block type a check-in may write');
  }
  if (depth > 8) return problem(path, 'blocked', 'nests blocks too deeply');
  const rule = BLOCK_REMOTE_RULES[block.type as PageBlockType];
  if (rule.kind === 'blocked') return problem(path, 'blocked', `is a ${block.type} block: ${rule.why}`);
  if (rule.kind === 'urls') {
    for (const field of rule.loads) {
      for (const [value, at] of valuesAtPath(block, field, path)) {
        if (present(value)) return problem(at, 'loads', `loads ${typeof value === 'string' ? shown(value) : 'a picture'} from the internet when the page shows`);
      }
    }
    for (const field of rule.links) {
      for (const [value, at] of valuesAtPath(block, field, path)) {
        if (present(value) && (typeof value !== 'string' || !isAllowedCheckinLink(value))) return linkProblem(at, String(value));
      }
    }
  }
  if (rule.kind !== 'container') return firstTextProblem(block, path);
  const children = new Set<string>();
  for (const field of rule.children) {
    for (const [child, at] of valuesAtPath(block, field, path)) {
      children.add(at);
      const found = blockRemoteProblem(child, at, depth + 1);
      if (found) return found;
    }
  }
  return firstTextProblem(block, path, children);
}

/** A block's content, without what saving it again changes: its revision and where it came from. */
function blockContent(block: PageBlock): string {
  const { rev: _rev, sources: _sources, ...content } = block as PageBlock & { sources?: unknown };
  if ('segmentSources' in content) delete (content as { segmentSources?: unknown }).segmentSources;
  return JSON.stringify(canonical(content));
}

/**
 * Why page content a check-in saves would reach outside Michi, or null:
 * every block it adds or changes is checked; blocks it leaves as they were
 * (a person's picture further down the page) are not. Storage calls this for
 * any save whose source is a check-in's node, after the tool's own check.
 */
export function checkinBlocksProblem(next: readonly PageBlock[], prior: readonly PageBlock[]): Found {
  const before = new Map(prior.map((block) => [block.id, blockContent(block)]));
  for (const [index, block] of next.entries()) {
    if (before.get(block.id) === blockContent(block)) continue;
    const found = blockRemoteProblem(block, `blocks[${index}]`);
    if (found) return found;
  }
  return null;
}

/** Why a column (as a tool adds it, or a patch of one) would draw pictures or text that reaches outside Michi, or null. */
export function columnRemoteProblem(column: unknown, path: string): Found {
  if (!isRecord(column)) return null;
  if (column.type !== undefined) {
    if (typeof column.type !== 'string' || !Object.hasOwn(COLUMN_REMOTE_RULES, column.type)) {
      return problem(join(path, 'type'), 'blocked', 'is not a column type a check-in may write');
    }
    if (COLUMN_REMOTE_RULES[column.type as MichiDbColumnType] === 'loads') {
      return problem(join(path, 'type'), 'loads', `makes a ${column.type} column, whose cells load pictures from the internet`);
    }
  }
  return firstTextProblem(column, path);
}

/** Why a view (as a tool saves it) would draw pictures or run a library component, or null. */
export function viewRemoteProblem(view: unknown, path: string): Found {
  if (!isRecord(view)) return null;
  if (typeof view.type !== 'string' || !Object.hasOwn(VIEW_REMOTE_RULES, view.type)) {
    return problem(join(path, 'type'), 'blocked', 'is not a view type a check-in may write');
  }
  const rule = VIEW_REMOTE_RULES[view.type as MichiDbViewType];
  if (rule.kind === 'blocked') return problem(path, 'blocked', `is a ${view.type} view: ${rule.why}`);
  if (rule.kind === 'urls') {
    for (const field of rule.loads) {
      for (const [value, at] of valuesAtPath(view, field, path)) {
        if (present(value)) return problem(at, 'loads', `makes the ${view.type} view draw pictures from the internet`);
      }
    }
  }
  return firstTextProblem(view, path);
}

/** Why a cell value would load or link outside Michi in a column of this type, or null. Unknown columns are scanned as text. */
export function cellRemoteProblem(type: string | undefined, value: unknown, path: string): Found {
  const rule = type !== undefined && Object.hasOwn(COLUMN_REMOTE_RULES, type) ? COLUMN_REMOTE_RULES[type as MichiDbColumnType] : 'inert';
  if (rule === 'loads' && present(value)) return problem(path, 'loads', 'is a picture cell, which loads from the internet when the database shows');
  if (rule === 'link') {
    const found = stringsOf(value, path);
    if (!Array.isArray(found)) return found;
    for (const [text, at] of found) if (present(text) && !isAllowedCheckinLink(text)) return linkProblem(at, text);
  }
  return firstTextProblem(value, path);
}

function rowRemoteProblem(row: Json, typeOf: ReadonlyMap<string, string | undefined>, path: string): Found {
  if (isRecord(row.values)) {
    for (const [columnId, value] of Object.entries(row.values)) {
      const found = cellRemoteProblem(typeOf.get(columnId), value, join(join(path, 'values'), columnId));
      if (found) return found;
    }
  }
  return firstTextProblem(row.body, join(path, 'body'));
}

/** Why a whole database (a template's, or the task database's) would reach outside Michi when drawn, or null. */
export function databaseRemoteProblem(database: { title?: unknown; columns?: readonly unknown[]; views?: readonly unknown[]; rows?: readonly unknown[] }, path = 'database'): Found {
  const titleProblem = firstTextProblem(database.title, join(path, 'title'));
  if (titleProblem) return titleProblem;
  const columns = database.columns ?? [];
  for (const [index, column] of columns.entries()) {
    const found = columnRemoteProblem(column, `${join(path, 'columns')}[${index}]`);
    if (found) return found;
  }
  for (const [index, view] of (database.views ?? []).entries()) {
    const found = viewRemoteProblem(view, `${join(path, 'views')}[${index}]`);
    if (found) return found;
  }
  const typeOf = new Map(columns.filter(isRecord).map((column) => [String(column.id), typeof column.type === 'string' ? column.type : undefined]));
  for (const [index, row] of (database.rows ?? []).entries()) {
    const found = isRecord(row) ? rowRemoteProblem(row, typeOf, `${join(path, 'rows')}[${index}]`) : null;
    if (found) return found;
  }
  return null;
}

/** Why a title a check-in gives a page or database would reach outside Michi, or null. */
export function titleRemoteProblem(title: unknown, path = 'title'): Found {
  return firstTextProblem(title, path);
}

/** A page template's content: its blocks and the database it makes. */
function templateRemoteProblem(template: unknown): Found {
  if (typeof template !== 'string' || !Object.hasOwn(PAGE_TEMPLATES, template)) return null;
  const definition = PAGE_TEMPLATES[template as PageTemplateKey];
  for (const [index, block] of definition.blocks.entries()) {
    const found = blockRemoteProblem(block, `template.blocks[${index}]`);
    if (found) return found;
  }
  if (!definition.database) return null;
  const { title, columns, view } = definition.database;
  return databaseRemoteProblem({ title, columns: columns.map(({ placeholder, ...column }) => ({ ...column, id: placeholder })), views: [view] }, 'template.database');
}

function opsOf(args: Json): Array<[Json, string]> {
  return Array.isArray(args.ops) ? args.ops.flatMap((op, index): Array<[Json, string]> => (isRecord(op) ? [[op, `ops[${index}]`]] : [])) : [];
}

/** The column types of a live database of this owner's, read straight from storage (this module sits below repository.ts). */
function columnTypes(databaseId: unknown, ownerUserId: string): Map<string, string | undefined> | RemoteContentProblem {
  const unreadable = problem('databaseId', 'blocked', 'does not name a database this check-in can read');
  if (typeof databaseId !== 'string' || !databaseId) return problem('databaseId', 'blocked', 'does not name a database');
  const row = getDb().prepare('SELECT workspace_id,columns_json FROM page_databases WHERE id=? AND owner_user_id=? AND deleted_at IS NULL')
    .get(databaseId, ownerUserId) as { workspace_id: string; columns_json: string } | undefined;
  if (!row) return unreadable;
  try {
    requirePagesWorkspace(row.workspace_id, ownerUserId);
    const columns: unknown = JSON.parse(row.columns_json);
    if (!Array.isArray(columns)) return unreadable;
    return new Map(columns.filter(isRecord).map((column) => [String(column.id), typeof column.type === 'string' ? column.type : undefined]));
  } catch (error) {
    if (error instanceof PageWriteError || error instanceof SyntaxError) return unreadable;
    throw error;
  }
}

/**
 * Why a check-in's call of a page write tool would put content into the
 * user's pages that loads from, or links to, the outside, or null when it
 * may go ahead. Any other tool name is refused: call it for the write tools
 * only (CHECKIN_PAGE_WRITE_TOOLS).
 */
export function checkinWriteProblem(tool: string, args: unknown, ownerUserId: string): Found {
  const input: Json = isRecord(args) ? args : {};
  switch (tool as CheckinPageWriteTool) {
    case 'edit_page':
      for (const [op, at] of opsOf(input)) {
        const found = op.block === undefined ? null : blockRemoteProblem(op.block, `${at}.block`);
        if (found) return found;
      }
      return null;
    case 'create_page':
      return titleRemoteProblem(input.title) ?? templateRemoteProblem(input.template);
    case 'create_database': {
      const titleProblem = titleRemoteProblem(input.title);
      if (titleProblem) return titleProblem;
      for (const [index, column] of (Array.isArray(input.columns) ? input.columns : []).entries()) {
        const found = columnRemoteProblem(column, `columns[${index}]`);
        if (found) return found;
      }
      return null;
    }
    case 'configure_database':
      for (const [op, at] of opsOf(input)) {
        const found = op.op === 'column.add' ? columnRemoteProblem(op.column, `${at}.column`)
          : op.op === 'column.update' ? columnRemoteProblem(op.patch, `${at}.patch`)
            : op.op === 'view.save' ? viewRemoteProblem(op.view, `${at}.view`)
              : firstTextProblem(op, at);
        if (found) return found;
      }
      return null;
    case 'edit_database': {
      const ops = opsOf(input);
      if (!ops.length) return null;
      const types = columnTypes(input.databaseId, ownerUserId);
      if (!(types instanceof Map)) return types;
      for (const [op, at] of ops) {
        const found = rowRemoteProblem(op, types, at);
        if (found) return found;
      }
      return null;
    }
    case 'open_task_database':
      // It writes only the task database's own columns and views, which the ratchet test keeps clean.
      return databaseRemoteProblem({ columns: taskDatabaseColumns(), views: taskDatabaseViews() }, 'taskDatabase');
    default:
      return problem(tool, 'blocked', 'is not a page write tool a check-in has');
  }
}
