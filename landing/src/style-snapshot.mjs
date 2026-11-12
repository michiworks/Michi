#!/usr/bin/env node
// Computed-style snapshot of the landing page (owner: theme work). No screenshots.
//
// Dump (default mode):
//   node landing/src/style-snapshot.mjs [--page index.html] [--viewport 1440x900[,375x812t]] --out file.json
//
//   Serves landing/ on 127.0.0.1 (ephemeral port), opens --page (default
//   index.html) at each --viewport (default 1440x900 and 375x812 with touch; a
//   trailing "t" means touch/mobile), waits for boot and the hero's hold, calls
//   window.__michi.finishAll(), waits two frames, then freezes the remaining
//   CSS/WAAPI animations (finite ones finished; infinite loops removed with
//   animation:none on the looping element, so it shows its un-animated base
//   value) so the dump is deterministic (two runs are byte-identical). It records, for every element
//   and its ::before/::after (when content is not none/normal), a stable key
//   (path from the nearest unique-id ancestor; each segment is
//   tag#id.classes:nth-of-type(n)) with the computed colour properties listed
//   in PROPS, font-size/weight, render facts and the element's own text (first
//   40 chars). With one viewport, --out is written as given; with several,
//   "{vp}" in --out is replaced by the viewport width, or "-<width>" is
//   inserted before ".json". The server is always stopped.
//
// Compare / analyse a dump (no browser):
//   --diff a.json b.json          every key/property that differs, and keys present
//                                 in only one; exit 1 when anything differs.
//   --scan a.json --forbid "#6d4aa8,#5b408e"
//                                 elements whose computed colours equal a forbidden
//                                 colour (RGB match, alpha reported). Inert values
//                                 (0-width borders/outlines, no text-decoration, fill/
//                                 stroke on HTML elements, text-fill = color) are
//                                 skipped unless --all. --rendered-only drops
//                                 unrendered elements. Exit 1 when any match.
//   --contrast a.json             text contrast: text colour (x own/ancestor opacity
//                                 below the backdrop) over the nearest ancestor with an
//                                 opaque background-color, translucent layers between
//                                 alpha-composited. Lists text below 4.5:1 (3:1 when
//                                 the rendered size is >= 24px, or >= 18.66px at
//                                 weight >= 700; rendered size = font-size x the
//                                 replica scale k). SVG text uses fill. "approx" marks
//                                 SVG text, or a backdrop that also has a gradient
//                                 background-image or a filter on the way. It
//                                 cannot see overlapping non-ancestor layers. Exit 1
//                                 when any text fails. --min N overrides 4.5.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const VERSION = 1;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; };

const PROPS = [
  'color', 'background-color', 'background-image',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'box-shadow', 'fill', 'stroke', 'stop-color',
  'text-decoration-color', 'caret-color', '-webkit-text-fill-color',
  'opacity', 'filter', 'mask-image',
];

// ---------------------------------------------------------------------------
// Colour helpers (Node side)
// ---------------------------------------------------------------------------
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
function parseColor(s) {
  if (!s) return null;
  s = s.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = s.match(/^rgba?\(([^)]*)\)$/);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (p) => (p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p));
    const al = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return { r: clamp255(ch(parts[0])), g: clamp255(ch(parts[1])), b: clamp255(ch(parts[2])), a: al };
  }
  m = s.match(/^color\(srgb\s+([^)]*)\)$/);
  if (m) {
    const parts = m[1].split(/[\s/]+/).filter(Boolean);
    const al = parts[3] === undefined ? 1 : parseFloat(parts[3]);
    return { r: clamp255(parseFloat(parts[0]) * 255), g: clamp255(parseFloat(parts[1]) * 255), b: clamp255(parseFloat(parts[2]) * 255), a: al };
  }
  return null;
}
const COLOR_TOKEN = /rgba?\([^)]*\)|color\([^)]*\)|(?:ok)?la[b]\([^)]*\)|(?:ok)?lch\([^)]*\)|hsla?\([^)]*\)|hwb\([^)]*\)|#[0-9a-f]{3,8}\b/gi;
function colorTokens(value) {
  if (!value || value === 'none') return [];
  const stripped = value.replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, '');
  return stripped.match(COLOR_TOKEN) || [];
}
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''); // composites are fractional
const fmt = (c) => (c.a >= 1 ? hex(c) : `${hex(c)}@${+c.a.toFixed(3)}`);
function over(top, bottom) { // source-over, bottom assumed opaque
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}
function lum(c) {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

function loadDump(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!j || !j.elements) throw new Error(`${file}: not a style-snapshot dump`);
  return j;
}

// ---------------------------------------------------------------------------
// --diff
// ---------------------------------------------------------------------------
function runDiff(fa, fb) {
  const A = loadDump(fa).elements, B = loadDump(fb).elements;
  const out = [];
  let onlyA = 0, onlyB = 0, changed = 0;
  for (const k of Object.keys(A)) {
    if (!(k in B)) { out.push(`- only in a: ${k}`); onlyA++; continue; }
    const a = A[k], b = B[k];
    const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const f of fields) {
      if (f === 'props') continue;
      if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) { out.push(`~ ${k}  [${f}] ${JSON.stringify(a[f])} -> ${JSON.stringify(b[f])}`); changed++; }
    }
    const props = new Set([...Object.keys(a.props || {}), ...Object.keys(b.props || {})]);
    for (const p of props) {
      const va = (a.props || {})[p], vb = (b.props || {})[p];
      if (va !== vb) { out.push(`~ ${k}  ${p}: ${va} -> ${vb}`); changed++; }
    }
  }
  for (const k of Object.keys(B)) if (!(k in A)) { out.push(`+ only in b: ${k}`); onlyB++; }
  for (const l of out) console.log(l);
  const total = onlyA + onlyB + changed;
  console.log(`diff: ${Object.keys(A).length} vs ${Object.keys(B).length} keys; ${changed} changed values, ${onlyA} only in a, ${onlyB} only in b`);
  process.exitCode = total ? 1 : 0;
}

// ---------------------------------------------------------------------------
// --scan
// ---------------------------------------------------------------------------
function inert(e, prop) {
  const p = e.props;
  const side = prop.match(/^border-(top|right|bottom|left)-color$/);
  if (side) return !(e.bw && e.bw[['top', 'right', 'bottom', 'left'].indexOf(side[1])] > 0);
  if (prop === 'outline-color') return !(e.ow > 0);
  if (prop === 'text-decoration-color') return !e.td;
  if (prop === 'fill' || prop === 'stroke' || prop === 'stop-color') return !e.svg;
  if (prop === '-webkit-text-fill-color') return p[prop] === p.color;
  if (prop === 'caret-color') return !e.editable;
  return false;
}
function runScan(file) {
  const dump = loadDump(file);
  const forbidRaw = (opt('--forbid', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!forbidRaw.length) throw new Error('--scan needs --forbid "#hex,#hex"');
  const forbid = forbidRaw.map((s) => { const c = parseColor(s); if (!c) throw new Error(`bad colour ${s}`); return { s, c }; });
  const all = flag('--all'), renderedOnly = flag('--rendered-only');
  const hits = [];
  const unparsed = new Set();
  for (const [key, e] of Object.entries(dump.elements)) {
    if (renderedOnly && !e.rendered) continue;
    for (const prop of PROPS) {
      if (prop === 'opacity') continue;
      if (!all && inert(e, prop)) continue;
      for (const tok of colorTokens(e.props[prop])) {
        const c = parseColor(tok);
        if (!c) { unparsed.add(tok); continue; }
        if (c.a === 0) continue;
        for (const f of forbid) {
          if (c.r === f.c.r && c.g === f.c.g && c.b === f.c.b) {
            hits.push({ key, prop, colour: fmt(c), forbidden: f.s, rendered: !!e.rendered, text: e.text || undefined });
          }
        }
      }
    }
  }
  const byColour = {};
  for (const h of hits) byColour[h.forbidden] = (byColour[h.forbidden] || 0) + 1;
  for (const h of hits) console.log(`${h.forbidden}  ${h.prop}=${h.colour}${h.rendered ? '' : ' (not rendered)'}  ${h.key}${h.text ? `  "${h.text}"` : ''}`);
  console.log(`scan: ${hits.length} matches ${JSON.stringify(byColour)} in ${Object.keys(dump.elements).length} keys${unparsed.size ? `; unparsed colour tokens: ${[...unparsed].slice(0, 10).join(' | ')}` : ''}`);
  process.exitCode = hits.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// --contrast
// ---------------------------------------------------------------------------
function runContrast(file) {
  const dump = loadDump(file);
  const E = dump.elements;
  const min = parseFloat(opt('--min', '4.5'));
  const fails = [];
  let checked = 0, skipped = 0, approxN = 0;
  const white = { r: 255, g: 255, b: 255, a: 1 };
  for (const [key, e] of Object.entries(E)) {
    if (!e.text || !e.rendered) continue;
    // SVG text paints with fill; HTML text with -webkit-text-fill-color (= color unless set).
    let fg = e.svg ? parseColor(e.props.fill) : (parseColor(e.props['-webkit-text-fill-color']) || parseColor(e.props.color));
    if (!fg) { skipped++; continue; }
    if (fg.a === 0) { skipped++; continue; } // clipped/gradient text, not measurable here
    // Walk up: self first (pseudo: its own box, then its host element).
    const layers = [];
    let backdrop = null, approx = !!e.svg, alpha = fg.a; // SVG: the backdrop may be a sibling shape
    let cur = key, node = e;
    while (node) {
      const bg = parseColor(node.props['background-color']);
      if (node.props['background-image'] && node.props['background-image'] !== 'none' && colorTokens(node.props['background-image']).length) approx = true;
      if (node.props.filter && node.props.filter !== 'none') approx = true;
      if (bg && bg.a >= 1) { backdrop = bg; break; }
      if (bg && bg.a > 0) layers.push(bg);
      alpha *= parseFloat(node.props.opacity || '1');
      cur = node.parent; node = cur ? E[cur] : null;
    }
    if (!backdrop) backdrop = white;
    let bgc = backdrop;
    for (let i = layers.length - 1; i >= 0; i--) bgc = over(layers[i], bgc);
    if (alpha < 0.05) { skipped++; continue; }
    const text = over({ ...fg, a: Math.min(1, alpha) }, bgc);
    const r = ratio(text, bgc);
    const size = e.fs * (e.k || 1);
    const large = size >= 24 || (size >= 18.66 && e.fw >= 700);
    const need = large ? Math.min(3, min) : min;
    checked++;
    if (approx) approxN++;
    if (r < need) fails.push({ key, text: e.text, fg: fmt(fg), alpha: +alpha.toFixed(3), bg: fmt(bgc), ratio: +r.toFixed(2), need, px: +size.toFixed(1), fs: e.fs, fw: e.fw, approx });
  }
  fails.sort((a, b) => a.ratio - b.ratio);
  for (const f of fails) {
    console.log(`${f.ratio.toFixed(2)} < ${f.need}  fg ${f.fg}${f.alpha < 1 ? ` x${f.alpha}` : ''} on ${f.bg}  ${f.px}px/${f.fw}${f.approx ? ' approx' : ''}  "${f.text}"  ${f.key}`);
  }
  console.log(`contrast: ${checked} text runs checked, ${fails.length} below threshold, ${skipped} skipped (transparent/invisible), ${approxN} approximate backdrops`);
  process.exitCode = fails.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Dump (browser side)
// ---------------------------------------------------------------------------
function collect(PROPS) {
  const SKIP = new Set(['head', 'script', 'style', 'link', 'meta', 'title', 'template', 'noscript', 'base']);
  const origin = location.origin;
  const clean = (v) => (typeof v === 'string' ? v.split(origin).join('') : v);
  const keys = new Map();
  const uniqueId = (el) => el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1;
  const seg = (el) => {
    const tag = el.tagName.toLowerCase();
    let s = tag;
    if (el.id) s += '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
    if (cls.length) s += '.' + cls.join('.');
    const p = el.parentElement;
    if (p) {
      const same = [...p.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return s;
  };
  const keyOf = (el) => {
    if (keys.has(el)) return keys.get(el);
    let k;
    if (el === document.documentElement) k = 'html';
    else if (el === document.body) k = 'body';
    else if (uniqueId(el)) k = seg(el);
    else k = keyOf(el.parentElement) + ' > ' + seg(el);
    keys.set(el, k);
    return k;
  };
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const out = {};
  const record = (el, pseudo, cs, parentKey, k, extra) => {
    if (out[k]) throw new Error('style-snapshot: duplicate key ' + k);
    const props = {};
    for (const p of PROPS) props[p] = clean(cs.getPropertyValue(p));
    const bw = ['top', 'right', 'bottom', 'left'].map((s) => (cs.getPropertyValue(`border-${s}-style`) === 'none' ? 0 : parseFloat(cs.getPropertyValue(`border-${s}-width`)) || 0));
    const ow = cs.getPropertyValue('outline-style') === 'none' ? 0 : parseFloat(cs.getPropertyValue('outline-width')) || 0;
    const td = cs.getPropertyValue('text-decoration-line') !== 'none';
    out[k] = Object.assign({
      parent: parentKey,
      tag: pseudo ? el.tagName.toLowerCase() + pseudo : el.tagName.toLowerCase(),
      fs: parseFloat(cs.fontSize) || 0,
      fw: parseInt(cs.fontWeight, 10) || 400,
      bw, ow, td,
    }, extra, { props });
  };
  const walk = (el) => {
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    const k = keyOf(el);
    const cs = getComputedStyle(el);
    const svg = el.namespaceURI === 'http://www.w3.org/2000/svg';
    let text = '';
    for (const n of el.childNodes) if (n.nodeType === 3) text += n.nodeValue;
    text = text.replace(/\s+/g, ' ').trim().slice(0, 40);
    const rects = el.getClientRects();
    const rendered = rects.length > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    let kk = 1;
    if (!svg && el.offsetWidth > 0) kk = el.getBoundingClientRect().width / el.offsetWidth;
    else if (el.parentElement && out[keyOf(el.parentElement)]) kk = out[keyOf(el.parentElement)].k;
    const extra = { rendered, k: r3(kk), svg: svg || undefined, editable: (el.isContentEditable || /^(input|textarea|select)$/.test(tag)) || undefined };
    if (text) extra.text = text;
    record(el, '', cs, el === document.documentElement ? null : keyOf(el.parentElement), k, extra);
    for (const ps of ['::before', '::after']) {
      const pcs = getComputedStyle(el, ps);
      const content = pcs.getPropertyValue('content');
      if (!content || content === 'none' || content === 'normal') continue;
      const m = content.match(/^"((?:[^"\\]|\\.)*)"$/);
      const ptext = m ? m[1].replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      const pex = { rendered: rendered && pcs.display !== 'none' && pcs.visibility !== 'hidden', k: r3(kk), content: clean(content).slice(0, 80) };
      if (ptext) pex.text = ptext;
      record(el, ps, pcs, k, k + ps, pex);
    }
    for (const c of el.children) walk(c);
  };
  walk(document.documentElement);
  return out;
}

async function settle(page) {
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  await page.evaluate(() => document.fonts && document.fonts.ready);
  const heroBusy = await page.evaluate(() => { const h = window.__michi.state('hero'); return !!h && h.state !== 'held' && h.state !== 'armed'; });
  if (heroBusy) await page.waitForFunction(() => window.__michi.state('hero').state === 'held', null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => window.__michi.finishAll());
  await frames();
  await page.waitForTimeout(400);
  const takes = await page.evaluate(() => window.__michi.finishAll());
  await frames();
  const anim = await page.evaluate(() => {
    let finished = 0, paused = 0;
    const names = new Set();
    for (const a of document.getAnimations()) {
      const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {};
      if (t.iterations === Infinity) {
        a.pause(); a.currentTime = 0; paused++;
        if (a.animationName) names.add(a.animationName);
      } else {
        try { a.finish(); finished++; } catch { a.cancel(); }
      }
    }
    // document.getAnimations() misses some running CSS animations (e.g. inside
    // subtrees Chrome treats as not relevant), so infinite CSS loops are also
    // removed by style: such elements render their un-animated base value.
    const tagged = [];
    for (const el of document.querySelectorAll('*')) {
      const parts = [];
      if (/infinite/.test(getComputedStyle(el).animationIterationCount)) parts.push('self');
      for (const ps of ['before', 'after']) if (/infinite/.test(getComputedStyle(el, '::' + ps).animationIterationCount)) parts.push(ps);
      if (!parts.length) continue;
      el.setAttribute('data-ss-freeze', parts.join(' '));
      tagged.push(el);
      const n = getComputedStyle(el).animationName;
      if (n && n !== 'none') names.add(n);
    }
    const st = document.createElement('style');
    st.textContent = '[data-ss-freeze~=self]{animation:none!important}[data-ss-freeze~=before]::before{animation:none!important}[data-ss-freeze~=after]::after{animation:none!important}';
    document.head.appendChild(st);
    return { finished, paused, removed: tagged.length, infinite: [...names].sort() };
  });
  await frames();
  return { takes: takes.map((t) => `${t.name}:${t.state}`), animations: anim };
}

function outPath(base, vp, many) {
  if (base.includes('{vp}')) return base.replace('{vp}', String(vp.width));
  if (!many) return base;
  return base.replace(/(\.json)?$/i, `-${vp.width}.json`);
}

async function runDump() {
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  const PAGE = opt('--page', 'index.html').replace(/^\/+/, '');
  const OUT = opt('--out');
  if (!OUT) throw new Error('--out file.json is required');
  const vps = opt('--viewport', '1440x900,375x812t').split(',').map((s) => {
    const m = s.trim().match(/^(\d+)x(\d+)(t|:touch)?$/i);
    if (!m) throw new Error(`bad --viewport ${s}`);
    return { width: +m[1], height: +m[2], touch: !!m[3] };
  });
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain',
  };
  // Static server, loopback only, never outside ROOT.
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch { rel = '/'; }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    if (!fs.existsSync(path.join(ROOT, PAGE))) throw new Error(`no ${PAGE} under ${ROOT} (run node landing/src/build.mjs)`);
    browser = await chromium.launch();
    for (const vp of vps) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.touch, hasTouch: vp.touch,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e && e.message)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(`${origin}/${PAGE}`, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.__michi, null, { timeout: 10000 });
      const state = await settle(page);
      const elements = await page.evaluate(collect, PROPS);
      const palette = await page.evaluate(() => document.documentElement.getAttribute('data-palette'));
      await context.close();
      const meta = {
        tool: 'style-snapshot', version: VERSION, page: PAGE,
        viewport: `${vp.width}x${vp.height}${vp.touch ? ' touch' : ''}`,
        palette, keys: Object.keys(elements).length, takes: state.takes, animations: state.animations, errors,
      };
      const file = outPath(OUT, vp, vps.length > 1);
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      const lines = Object.entries(elements).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
      fs.writeFileSync(file, `{"meta":${JSON.stringify(meta)},\n"elements":{\n${lines.join(',\n')}\n}}\n`);
      console.log(`${file}: ${meta.keys} keys, ${state.animations.removed} elements with infinite animations frozen, ${errors.length} page errors`);
      if (errors.length) process.exitCode = 1;
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
}

// ---------------------------------------------------------------------------
try {
  if (flag('--diff')) {
    const i = argv.indexOf('--diff');
    const [a, b] = [argv[i + 1], argv[i + 2]];
    if (!a || !b) throw new Error('--diff a.json b.json');
    runDiff(a, b);
  } else if (flag('--scan')) {
    runScan(opt('--scan'));
  } else if (flag('--contrast')) {
    runContrast(opt('--contrast'));
  } else {
    await runDump();
  }
} catch (e) {
  console.error('style-snapshot: ' + (e && e.message || e));
  process.exitCode = 2;
}
