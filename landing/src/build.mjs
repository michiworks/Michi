#!/usr/bin/env node
// Michi landing page build. Node only, no dependencies.
//
//   node landing/src/build.mjs [--keep-comments]
//
// Concatenates, in filename order:
//   src/html/NN-*.html  ->  index.html, and one page per palette (PALETTES:
//                           monokai.html), identical but for <html data-palette>,
//                           color-scheme, theme-color (the palette's --ground)
//                           and the palette's own partial, inlined in a <style>
//                           right after the styles.css link
//   src/css/NN-*.css    ->  styles.css, shared by every page; it leaves out the
//                           palette partials, so index.html never downloads them
//   src/js/NN-*.js      ->  main.js, inside ONE strict-mode IIFE, each file
//                           preceded by a "/* file: NN-name.js */" comment
// The outputs are generated: edit the partials, never the outputs.
// Source comments are stripped from all three (the HTML and JS file markers
// stay), CSS is minified to one line per partial, and JS loses its
// indentation and blank lines, so the brief §10 budgets measure shipped bytes.
// --keep-comments ships the partials as written.
//
// Before reading, every partial in the ownership list that does not exist yet
// is created as a one-line placeholder, so the build always runs. A missing
// src/html, src/css or src/js directory is an error (exit 1). A syntax error in
// main.js is reported with its source file and line (exit 1, outputs written),
// and so is a palette page whose head could not be rewritten.
// Everything else (duplicate ids, dangling #refs, em dashes in copy, unwrapped
// JS, unbalanced CSS braces, budgets) is a warning.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.dirname(SRC);

// Ownership list (see the team brief). [file, owner]
const PARTIALS = {
  html: [
    ['00-head.html', 'shell'], ['10-nav.html', 'shell'], ['20-hero.html', 'hero'],
    ['30-why.html', 'figures'], ['35-inherit.html', 'figures'], ['40-how.html', 'verbs'],
    ['50-map.html', 'map'], ['60-recall.html', 'verbs'], ['65-away.html', 'away'], ['70-local.html', 'shell'],
    ['80-notes.html', 'shell'], ['90-get.html', 'verbs'], ['95-keys.html', 'figures'],
    ['99-footer.html', 'shell'],
  ],
  css: [
    ['00-fonts.css', 'shell'], ['01-tokens.css', 'shell'], ['10-base.css', 'shell'],
    ['20-components.css', 'shell'], ['30-kit.css', 'engine'], ['31-kit-motion.css', 'engine'],
    ['40-hero.css', 'hero'], ['45-figures.css', 'figures'], ['46-footnotes-keys.css', 'figures'],
    ['50-how.css', 'verbs'], ['55-map.css', 'map'], ['60-recall.css', 'verbs'],
    ['62-away.css', 'away'], ['65-close.css', 'verbs'], ['90-global.css', 'shell'], ['95-monokai.css', 'theme'],
  ],
  js: [
    ['00-core.js', 'engine'], ['05-ops.js', 'engine'], ['10-boot.js', 'engine'],
    ['20-hero.js', 'hero'], ['30-figures.js', 'figures'], ['40-how.js', 'verbs'],
    ['50-map.js', 'map'], ['60-recall.js', 'verbs'], ['62-away.js', 'away'], ['65-close.js', 'verbs'],
    ['80-footnotes.js', 'figures'], ['85-keys.js', 'figures'], ['88-copylink.js', 'figures'],
    ['99-start.js', 'engine'],
  ],
};

const BUDGET_GZIP = { 'index.html': 60, 'styles.css': 16, 'main.js': 22 }; // KB, brief §10

// Palette pages (the Monokai variant). Each is index.html with
// <html lang="en" data-palette="NAME">, <meta name="color-scheme" content=SCHEME>,
// theme-color = the --ground its CSS partial sets under html[data-palette="NAME"]
// (one source of truth), and that partial inlined in a <style> right after the
// styles.css link, the cascade position it would have as the last partial of
// styles.css. Every page shares styles.css, main.js and assets/; a palette's
// block ships only on its own page.
const PALETTES = [{ name: 'monokai', file: 'monokai.html', scheme: 'dark', css: '95-monokai.css' }];
const PALETTE_CSS = new Set(PALETTES.map((p) => p.css));

// The stageshow comparison page (the stageshow pilot): index.html
// with <html lang="en" data-hero="stageshow">, the stageshow stage's container
// at the <!-- stageshow:mount --> marker in html/20-hero.html (a comment, so
// every other page drops it), and assets/ss/ (built from landing/stageshow/ by
// Vite) loaded on this page only. Slate only.
const STAGESHOW = {
  file: 'stageshow.html',
  marker: /<!--\s*stageshow:mount\b[\s\S]*?-->/,
  mount: '<div class="ss-hero-mount" data-ss-hero aria-hidden="true"></div>',
  css: '<link rel="stylesheet" href="assets/ss/stageshow-hero.css">',
  js: '<script src="assets/ss/stageshow-hero.js" defer onerror="document.documentElement.setAttribute(\'data-ss-failed\',\'\')"></script>',
};

const warnings = [];
const warn = (msg) => warnings.push(msg);
let failed = false;

// 1. Directories must exist.
const dirs = { html: path.join(SRC, 'html'), css: path.join(SRC, 'css'), js: path.join(SRC, 'js') };
const missing = Object.values(dirs).filter((d) => !isDir(d));
if (missing.length) {
  for (const d of missing) console.error(`build: missing directory ${path.relative(OUT, d)}/`);
  process.exit(1);
}

// 2. Placeholders for owned partials that do not exist yet (never overwrites).
const created = [];
for (const [kind, list] of Object.entries(PARTIALS)) {
  for (const [file, owner] of list) {
    const p = path.join(dirs[kind], file);
    try {
      fs.writeFileSync(p, placeholder(kind, file, owner) + '\n', { flag: 'wx' });
      created.push(`${kind}/${file}`);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

// 3. Read partials in filename order.
const parts = {};
for (const [kind, dir] of Object.entries(dirs)) {
  const re = new RegExp(`^\\d{2}-[\\w.-]+\\.${kind}$`);
  parts[kind] = fs.readdirSync(dir).filter((f) => re.test(f)).sort()
    .map((f) => ({ name: f, text: withNewline(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

// 4. Assemble. Source comments are documentation for the team: they are
// stripped from the outputs (the brief §10 budgets count shipped bytes); the
// file markers stay. --keep-comments keeps everything as written.
const keepComments = process.argv.includes('--keep-comments');
const leanH = keepComments ? (s) => s : leanHtml;
const leanC = keepComments ? (s) => s : (s) => minifyCss(leanCss(s));
const leanJ = keepComments ? (s) => s : leanJs;

// The stageshow mount marker goes with its whole line, so these pages stay
// byte-identical to a build without it (stageshowPage makes it real).
const unmarked = (p) => p.text.replace(new RegExp(`^[ \\t]*${STAGESHOW.marker.source}[ \\t]*\\r?\\n`, 'm'), '');
let html = parts.html.map((p, i) => (i === 0 ? '' : `<!-- file: ${p.name} -->\n`) + leanH(unmarked(p))).join('');
html = html.replace(/^(<!doctype html>)[ \t]*\r?\n?/i,
  '$1\n<!-- Generated by src/build.mjs from src/html/. Edit the partials, not this file. -->\n');

// Minified CSS keeps one line per partial in filename order; its file markers
// ship only with --keep-comments (they cost the budget about 0.1 KB gzip).
// Palette partials go to their own pages instead (palettePage).
const cssPart = (p) => (keepComments ? `/* file: ${p.name} */\n` : '') + leanC(p.text);
const css = '/* Michi landing page: generated by src/build.mjs; edit src/css/. */\n'
  + parts.css.filter((p) => !PALETTE_CSS.has(p.name)).map(cssPart).join('');

// main.js: the verbatim assembly keeps a line map, so syntax errors point
// back to the partial; the shipped file is the lean one.
const jsHead = '/* Michi landing page. Generated by src/build.mjs from src/js/; edit the partials. */\n'
  + '(function(){"use strict";\n';
let jsFull = jsHead;
let js = jsHead;
let line = lineCount(jsHead) + 1; // 1-based line of the next line written
const lineMap = [];
for (const p of parts.js) {
  jsFull += `/* file: ${p.name} */\n`;
  js += `/* file: ${p.name} */\n`;
  line += 1;
  lineMap.push({ name: p.name, start: line, lines: lineCount(p.text) });
  jsFull += p.text;
  js += leanJ(p.text);
  line += lineCount(p.text);
}
jsFull += '})();\n';
js += '})();\n';

// 5. Checks. A lean main.js that stops parsing (a stripper bug) ships verbatim.
checkHtml(html);
checkCss(parts.css);
const fullOk = checkJs(jsFull, parts.js, lineMap);
if (fullOk && js !== jsFull && !parses(js)) {
  warn('main.js: the comment stripper broke the code; shipping it verbatim');
  js = jsFull;
}
if (!fullOk) js = jsFull;

const pages = [['index.html', html]];
for (const pal of PALETTES) pages.push([pal.file, palettePage(html, pal)]);
pages.push([STAGESHOW.file, stageshowPage()]);

for (const [name, text] of pages) write(name, text);
write('styles.css', css);
write('main.js', js);

// 6. Report.
if (created.length) console.log(`placeholders created: ${created.join(', ')}`);
console.log(`partials: ${parts.html.length} html, ${parts.css.length} css, ${parts.js.length} js`);
const pending = [];
for (const [kind, list] of Object.entries(PARTIALS)) {
  for (const [file, owner] of list) {
    const p = parts[kind].find((x) => x.name === file);
    if (p && p.text.trim() === placeholder(kind, file, owner)) pending.push(`${kind}/${file} (${owner})`);
  }
}
if (pending.length) console.log(`still placeholders: ${pending.join(', ')}`);
for (const [name, text] of [...pages, ['styles.css', css], ['main.js', js]]) {
  const raw = Buffer.byteLength(text);
  const gz = zlib.gzipSync(text).length;
  const budget = BUDGET_GZIP[name] ?? BUDGET_GZIP['index.html'];
  const over = gz / 1024 > budget;
  if (over) warn(`${name} is over its gzip budget (${kb(gz)} > ${budget} KB)`);
  console.log(`${name.padEnd(12)} raw ${kb(raw).padStart(9)}   gzip ${kb(gz).padStart(9)}   budget ${budget} KB${over ? '  OVER' : ''}`);
}
// What each palette block costs its own page (no other page carries it).
{
  const gzIndex = zlib.gzipSync(html).length;
  for (const [name, text] of pages.slice(1)) {
    const pal = PALETTES.find((p) => p.file === name);
    if (!pal) continue;
    console.log(`${'palette'.padEnd(12)} css/${pal.css} inline in ${name}: +${zlib.gzipSync(text).length - gzIndex} B gzip over index.html; not in styles.css`);
  }
}
for (const w of warnings) console.warn(`warning: ${w}`);
if (failed) process.exit(1);

// ---------------------------------------------------------------------------

// index.html -> a palette page: the four head edits, each found exactly once.
function palettePage(src, pal) {
  const part = parts.css.find((p) => p.name === pal.css);
  const block = part && new RegExp(`html\\[data-palette="${pal.name}"\\]\\s*\\{([^}]*)\\}`).exec(part.text.replace(/\/\*[\s\S]*?\*\//g, ''));
  const ground = block && /--ground:\s*(#[0-9a-fA-F]{3,8})\b/.exec(block[1]);
  let out = src;
  const swap = (re, to, what) => {
    const n = (out.match(re) || []).length;
    if (n !== 1) { failed = true; console.error(`build: ${pal.file}: expected one ${what} in html/00-head.html, found ${n}`); return; }
    out = out.replace(re, () => to);
  };
  swap(/<html lang="en">/g, `<html lang="en" data-palette="${pal.name}">`, '<html lang="en">');
  swap(/<meta name="color-scheme" content="light">/g, `<meta name="color-scheme" content="${pal.scheme}">`, 'color-scheme meta (light)');
  if (ground) swap(/<meta name="theme-color" content="#[0-9a-fA-F]{3,8}">/g, `<meta name="theme-color" content="${ground[1]}">`, 'theme-color meta');
  else { failed = true; console.error(`build: ${pal.file}: no --ground under html[data-palette="${pal.name}"] in css/${pal.css}`); }
  // The palette's block, right after the shared sheet: where it would sit as
  // the last partial of styles.css, so the cascade is unchanged.
  const sheet = part ? cssPart(part).trim() : '';
  if (/<\/style/i.test(sheet)) { failed = true; console.error(`build: ${pal.file}: css/${pal.css} contains "</style"`); }
  else if (sheet) swap(/<link rel="stylesheet" href="styles\.css">/g, `<link rel="stylesheet" href="styles.css">\n<style>${sheet}</style>`, 'styles.css link');
  return out;
}

// index.html -> stageshow.html: the same partials with the hero's mount
// marker made real, then three head edits, each found exactly once.
function stageshowPage() {
  const hero = parts.html.find((p) => p.name === '20-hero.html');
  if (!hero || !STAGESHOW.marker.test(hero.text)) {
    failed = true;
    console.error(`build: ${STAGESHOW.file}: no <!-- stageshow:mount --> marker in html/20-hero.html`);
    return html;
  }
  let out = parts.html.map((p, i) => (i === 0 ? '' : `<!-- file: ${p.name} -->\n`)
    + leanH(p === hero ? p.text.replace(STAGESHOW.marker, () => STAGESHOW.mount) : p.text)).join('');
  out = out.replace(/^(<!doctype html>)[ \t]*\r?\n?/i,
    '$1\n<!-- Generated by src/build.mjs from src/html/. Edit the partials, not this file. -->\n');
  const swap = (re, to, what) => {
    const n = (out.match(re) || []).length;
    if (n !== 1) { failed = true; console.error(`build: ${STAGESHOW.file}: expected one ${what} in html/00-head.html, found ${n}`); return; }
    out = out.replace(re, () => to);
  };
  swap(/<html lang="en">/g, '<html lang="en" data-hero="stageshow">', '<html lang="en">');
  // The page's own take must not arm: without the head script's t0 it boots
  // held at tB (10-boot.js), the static replica the stage stands in for.
  swap(/<link rel="stylesheet" href="styles\.css">/g,
    `<script>document.documentElement.removeAttribute('data-take-hero')</script>\n<link rel="stylesheet" href="styles.css">\n${STAGESHOW.css}`, 'styles.css link');
  swap(/<script src="main\.js" defer><\/script>/g, `<script src="main.js" defer></script>\n${STAGESHOW.js}`, 'main.js script');
  if (!fs.existsSync(path.join(OUT, 'assets/ss/stageshow-hero.js'))) warn(`${STAGESHOW.file}: assets/ss/stageshow-hero.js is missing; build landing/stageshow first `);
  return out;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function placeholder(kind, file, owner) {
  const note = `placeholder: ${file} (${owner}); replace with the real partial`;
  if (kind === 'html') return `<!-- ${note} -->`;
  // 00-core.js owns the shared namespace; the placeholder keeps M defined.
  if (file === '00-core.js') return `/* ${note} */ const M = {};`;
  return `/* ${note} */`;
}

function withNewline(s) {
  return s.endsWith('\n') ? s : s + '\n';
}

function lineCount(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function write(name, text) {
  fs.writeFileSync(path.join(OUT, name), text);
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function stripHtmlComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '');
}

// Drops HTML comments outside raw-text elements. Whitespace is untouched:
// replica text is pre-laid-out and inline whitespace is significant.
function leanHtml(s) {
  return s.replace(/(<(script|style|textarea)\b[\s\S]*?<\/\2\s*>)|<!--[\s\S]*?-->/gi, (m, raw) => raw || '');
}

// Drops CSS comments (string-aware), indentation and blank lines. Comments
// never produce whitespace tokens in CSS, so removing them keeps the meaning.
function leanCss(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out.split('\n').map((l) => l.trim()).filter(Boolean).join('\n') + '\n';
}

function checkHtml(src) {
  const doc = stripHtmlComments(src);
  // Copy text only: drop script and style bodies for the text checks.
  const text = doc.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');

  const ids = new Map();
  for (const m of doc.matchAll(/\sid\s*=\s*"([^"]*)"/g)) ids.set(m[1], (ids.get(m[1]) || 0) + 1);
  const dupes = [...ids].filter(([, n]) => n > 1).map(([id, n]) => `${id} (${n}x)`);
  if (dupes.length) warn(`index.html: duplicate ids: ${dupes.join(', ')}`);

  const dangling = new Set();
  for (const m of doc.matchAll(/\shref\s*=\s*"#([^"]*)"/g)) {
    const id = decodeURIComponent(m[1]);
    if (id === '') warn('index.html: bare href="#" (placeholder links start with #todo-)');
    else if (!id.startsWith('todo-') && !ids.has(id)) dangling.add(`href #${id}`);
  }
  for (const m of doc.matchAll(/\s(aria-labelledby|aria-describedby|aria-controls|aria-owns|for|list)\s*=\s*"([^"]*)"/g)) {
    for (const id of m[2].split(/\s+/).filter(Boolean)) if (!ids.has(id)) dangling.add(`${m[1]} ${id}`);
  }
  if (dangling.size) warn(`index.html: references to missing ids: ${[...dangling].join(', ')}`);

  // No em dashes in page copy, attributes included (brief \u00a73).
  const dash = /\u2014|&mdash;|&#8212;|&#x2014;/i.exec(text);
  if (dash) {
    const near = text.slice(Math.max(0, dash.index - 40), dash.index + 40).replace(/\s+/g, ' ').trim();
    warn(`index.html: em dash in page copy near "${near}"`);
  }
  const count = (re) => (doc.match(re) || []).length;
  if (count(/<main\b/gi) !== 1 || count(/<\/main>/gi) !== 1) warn('index.html: expected exactly one <main> and one </main>');
  if (count(/<h1\b/gi) > 1) warn('index.html: more than one <h1>');
  if (!/^<!doctype html>/i.test(src)) warn('index.html: does not start with <!doctype html> (00-head.html)');
}

function checkCss(list) {
  for (const p of list) {
    const s = p.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
    const open = (s.match(/\{/g) || []).length;
    const close = (s.match(/\}/g) || []).length;
    if (open !== close) warn(`css/${p.name}: unbalanced braces ({ ${open}, } ${close})`);
  }
}

function checkJs(src, list, map) {
  for (const p of list) {
    if (p.name === '00-core.js') continue;
    const body = p.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').trim();
    if (body && !(body.startsWith('{') && body.endsWith('}'))) {
      warn(`js/${p.name}: wrap the file's code in a block { ... } and share only through M`);
    }
  }
  try {
    new vm.Script(src, { filename: 'main.js' });
    return true;
  } catch (e) {
    failed = true;
    const m = /main\.js:(\d+)/.exec(String(e.stack));
    const at = m ? Number(m[1]) : 0;
    const hit = map.find((f) => at >= f.start && at < f.start + f.lines);
    const where = hit ? `src/js/${hit.name}:${at - hit.start + 1}` : `main.js:${at || '?'}`;
    console.error(`build: main.js does not parse: ${e.name}: ${e.message} (at ${where})`);
    return false;
  }
}

function parses(src) {
  try { new vm.Script(src, { filename: 'main.js' }); return true; } catch { return false; }
}

// CSS whitespace (after leanCss): runs collapse to one space; spaces around
// { } ; , > and after : go; so does the last ; of a block. Strings are kept.
// The space before ":" stays (".a :is(.b)" is a descendant selector), as do
// the spaces around + - * / (calc) and "and"/"not" in media queries.
function minifyCss(s) {
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (/\s/.test(c)) {
      while (i < s.length && /\s/.test(s[i])) i++;
      const next = s[i] || '';
      const last = out[out.length - 1] || '';
      if (!'{};,>:'.includes(last) && !'{};,>'.includes(next) && last !== '' && next !== '') out += ' ';
    } else {
      if ('{};,>'.includes(c) && out[out.length - 1] === ' ') out = out.slice(0, -1);
      if (c === '}' && out[out.length - 1] === ';') out = out.slice(0, -1);
      out += c;
      i += 1;
    }
  }
  return out.trim() + '\n';
}

// JS: comments, indentation, trailing spaces and blank lines go. A small
// lexer keeps strings, template literals (with ${} nesting) and regular
// expression literals intact; a block comment that spans lines becomes a
// line break, so automatic semicolon insertion sees the same code.
function leanJs(src) {
  const KW = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do',
    'else', 'yield', 'await']);
  let i = 0, out = '', last = ''; // last significant token: '' | 'x' (value: name, number, ) ] }) | 'p' (other)
  const emit = (s) => { out += s; };
  const nl = () => {
    out = out.replace(/[ \t]+$/, '');
    if (out !== '' && !out.endsWith('\n')) out += '\n';
  };
  const space = () => { if (out !== '' && !/[\s]$/.test(out)) out += ' '; };
  const quoted = (q) => { // from src[i] === q, past the closing quote
    let j = i + 1;
    while (j < src.length && src[j] !== q) {
      if (src[j] === '\\') j++;
      else if (q !== '`' && src[j] === '\n') break;
      else if (q === '`' && src[j] === '$' && src[j + 1] === '{') { emit(src.slice(i, j + 2)); i = j + 2; code(true); j = i - 1; }
      j++;
    }
    emit(src.slice(i, j + 1));
    i = j + 1;
  };
  const regex = () => {
    let j = i + 1, cls = false;
    while (j < src.length && src[j] !== '\n') {
      const ch = src[j];
      if (ch === '\\') j++;
      else if (ch === '[') cls = true;
      else if (ch === ']') cls = false;
      else if (ch === '/' && !cls) break;
      j++;
    }
    j++;
    while (j < src.length && /[a-z]/i.test(src[j])) j++;
    emit(src.slice(i, j));
    i = j;
  };
  function code(inTemplate) { // returns at the } that closes a ${ when inTemplate
    let depth = 0;
    while (i < src.length) {
      const c = src[i], d = src[i + 1];
      if (c === '\n') { nl(); i++; while (src[i] === ' ' || src[i] === '\t') i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { space(); i++; continue; }
      if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') {
        const end = src.indexOf('*/', i + 2), stop = end < 0 ? src.length : end + 2;
        if (src.slice(i, stop).includes('\n')) nl(); else space();
        i = stop;
        while (src[i] === ' ' || src[i] === '\t') i++;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quoted(c); last = 'x'; continue; }
      if (c === '/') { if (last === 'x') { emit(c); i++; last = 'p'; } else { regex(); last = 'x'; } continue; }
      if (/[\w$]/.test(c) || c > '\x7f' || (c === '.' && /\d/.test(d))) { // a name or a number
        const num = /[\d.]/.test(c);
        let j = i + 1;
        while (j < src.length && ((num ? /[\w.]/ : /[\w$]/).test(src[j]) || src[j] > '\x7f')) j++;
        const word = src.slice(i, j);
        emit(word);
        i = j;
        last = KW.has(word) ? 'p' : 'x';
        continue;
      }
      if (inTemplate) {
        if (c === '{') depth++;
        else if (c === '}' && depth-- === 0) return;
      }
      emit(c);
      i++;
      last = c === ')' || c === ']' || c === '}' ? 'x' : 'p';
    }
  }
  code(false);
  nl();
  return out.replace(/^\n+/, '');
}
