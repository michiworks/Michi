#!/usr/bin/env node
// Landing smoke test (owner: engine). No screenshots.
//
//   node landing/src/smoke.mjs [page ...] [--page page] [--strict]
//
// Serves landing/ on 127.0.0.1 (ephemeral port) and loads each page (default:
// index.html and every palette page, i.e. each top-level *.html whose <html>
// carries data-palette, such as monokai.html) with Playwright Chromium:
//   1. 1440x900, 1280x800, 1024x768, 768x1024, 375x812 and 320x640 (touch): the hero plays to
//      its hold, every take plays once at 4x (__michi.playAll), every section is
//      scrolled through, then __michi.finishAll(). Asserts: no console errors or
//      page errors, no failed or cross-origin requests, data-hero-ready set, every
//      data-take / data-take-for names a registered take, every take held at least
//      once with no step errors, no horizontal overflow (offending elements listed).
//   2. Reduced motion (1440x900): every take at tB, nothing playing, Play shown
//      where a take has one, steps playback reaches hold, no overflow.
//   3. JavaScript disabled (1440x900, 768x1024, 375x812, 320x640): every section heading and every
//      replica box present and visible, take controls not shown, no overflow.
//   Every run also checks the palette: <html data-palette> is the page's own,
//   theme-color equals the painted ground, the page's CSS has rules for its
//   own palette only (none on index.html: palette blocks stay out of
//   styles.css), and (motion runs where the hero played) the hero's
//   once-per-session key is the palette's own (michi:hero, michi:hero:monokai)
//   and no other palette's key was set.
// Prints a JSON report; exits 1 on any failure. --strict also fails on console
// warnings. The server is always stopped.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const named = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--page') named.push(args[++i] || '');
  else if (!args[i].startsWith('--')) named.push(args[i]);
}
// A page's palette is whatever its <html> tag declares (null: the default, Slate).
const paletteOf = (page) => {
  try { return (/<html\b[^>]*\sdata-palette="([^"]+)"/i.exec(fs.readFileSync(path.join(ROOT, page), 'utf8').slice(0, 2000)) || [])[1] || null; } catch { return null; }
};
const PAGES = (named.length ? named : ['index.html', ...fs.readdirSync(ROOT).filter((f) => f.endsWith('.html') && f !== 'index.html' && paletteOf(f)).sort()])
  .map((p) => p.replace(/^\/+/, ''));
let PAGE = PAGES[0];
let PALETTE = null;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain',
};
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280', width: 1280, height: 800 },
  { name: '1024', width: 1024, height: 768 },
  { name: '768', width: 768, height: 1024 },
  { name: '375', width: 375, height: 812, touch: true },
  { name: '320', width: 320, height: 640, touch: true },
];

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

const report = { pages: PAGES, ok: true, runs: [], failures: [] };
const fail = (run, msg, detail) => {
  run.failures.push(detail === undefined ? msg : { msg, detail });
  report.failures.push(`[${run.page} ${run.name}] ${msg}`);
  report.ok = false;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-page helpers (serialised into the page).
function overflowProbe() {
  // Mobile Chrome widens innerWidth to the content when it overflows, so the
  // layout viewport's clientWidth is the honest bound there.
  const vw = Math.min(window.innerWidth, document.documentElement.clientWidth);
  const sw = document.documentElement.scrollWidth;
  const out = { scrollWidth: sw, innerWidth: vw, offenders: [] };
  if (sw <= vw) return out;
  const clips = (el) => {
    // body's overflow propagates to the viewport, so body and html clip nothing.
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox !== 'visible' && p.getBoundingClientRect().right <= vw + 0.5) return true;
    }
    return false;
  };
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= vw + 0.5) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (clips(el)) continue;
    // Report the outermost offender of a chain only.
    const parent = el.parentElement;
    if (parent && parent.getBoundingClientRect().right > vw + 0.5 && !clips(parent) && parent !== document.body) continue;
    const chain = [];
    for (let p = el; p && p !== document.body && chain.length < 4; p = p.parentElement) chain.unshift(name(p));
    out.offenders.push({ el: chain.join(' > '), right: Math.round(r.right), width: Math.round(r.width) });
    if (out.offenders.length >= 12) break;
  }
  return out;
}
function visibleProbe() {
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    }
    return true;
  };
  const label = (el) => (el.id ? '#' + el.id : '') + (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const headings = [...document.querySelectorAll('h1, main section h2')];
  const replicas = [...document.querySelectorAll('.mk-fit, [data-take]')];
  const controls = [...document.querySelectorAll('[data-take-control]')];
  return {
    sections: document.querySelectorAll('main section').length,
    headings: headings.length,
    hiddenHeadings: headings.filter((h) => !vis(h)).map(label),
    replicas: replicas.length,
    hiddenReplicas: replicas.filter((r) => !vis(r)).map((r) => r.getAttribute('data-take') || r.className),
    shownControls: controls.filter((c) => vis(c)).length,
    tokens: document.querySelectorAll('.w, .c').length,
    heroT0: document.documentElement.getAttribute('data-take-hero'),
    js: document.documentElement.classList.contains('js'),
  };
}

function paletteProbe() {
  const h = document.documentElement;
  const meta = (n) => (document.querySelector(`meta[name="${n}"]`) || {}).content || null;
  const c = document.createElement('canvas').getContext('2d');
  const hex = (v) => { c.fillStyle = '#000'; c.fillStyle = v; return c.fillStyle.toLowerCase(); };
  const keys = [];
  try { for (let i = 0; i < sessionStorage.length; i++) keys.push(sessionStorage.key(i)); } catch (e) { /* private mode */ }
  // Palettes named by any selector in the page's CSS (styles.css and inline
  // blocks). Every sheet is same-origin, so one that cannot be read is a failure,
  // not a silent pass.
  const cssPalettes = new Set();
  const unreadable = [];
  const walk = (rules) => {
    for (const r of rules) {
      for (const m of (r.selectorText || '').matchAll(/data-palette="?([\w-]+)/g)) cssPalettes.add(m[1]);
      if (r.cssRules) walk(r.cssRules);
    }
  };
  // stageshow.html's bundle (assets/ss/) carries the stageshow kit, whose
  // .ss-stage[data-palette] is the stage's own palette, not a page palette.
  for (const s of document.styleSheets) { if (/\/assets\/ss\//.test(s.href || '')) continue; try { walk(s.cssRules); } catch (e) { unreadable.push(s.href || 'inline'); } }
  return {
    palette: h.getAttribute('data-palette'), scheme: meta('color-scheme'),
    theme: meta('theme-color') && hex(meta('theme-color')), ground: hex(getComputedStyle(h).backgroundColor),
    cssPalettes: [...cssPalettes].sort(), cssSheets: document.styleSheets.length, cssUnreadable: unreadable,
    heroKeys: keys.filter((k) => /^michi:hero/.test(k)).sort(),
  };
}
function checkPalette(run, p, heroPlayed) {
  run.palette = p;
  if (p.palette !== PALETTE) fail(run, `html[data-palette] is ${JSON.stringify(p.palette)}, expected ${JSON.stringify(PALETTE)}`);
  if (!p.theme || p.theme !== p.ground) fail(run, `theme-color ${p.theme} is not the painted ground ${p.ground}`);
  if (!p.scheme) fail(run, 'no color-scheme meta');
  const own = PALETTE ? [PALETTE] : [];
  if (!p.cssSheets || p.cssUnreadable.length) fail(run, `could not read the page's CSS (${p.cssSheets} sheets)`, p.cssUnreadable);
  else if (JSON.stringify(p.cssPalettes) !== JSON.stringify(own)) {
    fail(run, `the page's CSS has rules for palettes ${JSON.stringify(p.cssPalettes)}, expected ${JSON.stringify(own)}`);
  }
  const key = 'michi:hero' + (PALETTE ? ':' + PALETTE : '');
  if (heroPlayed && !p.heroKeys.includes(key)) fail(run, `hero played but sessionStorage has no ${key}`, p.heroKeys);
  if (p.heroKeys.some((k) => k !== key)) fail(run, `another palette's hero key is set (${key} expected)`, p.heroKeys);
}

async function newPage(browser, vp, extra) {
  const context = await browser.newContext(Object.assign({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: !!vp.touch,
    hasTouch: !!vp.touch,
  }, extra || {}));
  const page = await context.newPage();
  const log = { errors: [], warnings: [], failedRequests: [], foreign: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') log.errors.push(m.text());
    else if (m.type() === 'warning') log.warnings.push(m.text());
  });
  page.on('pageerror', (e) => log.errors.push('pageerror: ' + (e && e.message)));
  page.on('requestfailed', (r) => log.failedRequests.push(r.url() + ' ' + (r.failure() && r.failure().errorText)));
  page.on('response', (r) => { if (r.status() >= 400) log.failedRequests.push(r.url() + ' ' + r.status()); });
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('about:')) log.foreign.push(u);
  });
  return { context, page, log };
}

function checkLog(run, log) {
  if (log.errors.length) fail(run, 'console errors', log.errors.slice(0, 20));
  if (strict && log.warnings.length) fail(run, 'console warnings (--strict)', log.warnings.slice(0, 20));
  if (log.failedRequests.length) fail(run, 'failed requests', log.failedRequests.slice(0, 20));
  if (log.foreign.length) fail(run, 'requests outside the page origin', log.foreign.slice(0, 20));
  if (log.warnings.length) run.warnings = log.warnings.slice(0, 20);
}

async function scrollThrough(page) {
  const tops = await page.evaluate(() => [...document.querySelectorAll('main section, main > *')]
    .map((s) => Math.round(s.getBoundingClientRect().top + scrollY)).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b));
  for (const y of tops) {
    await page.evaluate((y) => window.scrollTo(0, y), y);
    await sleep(160);
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await sleep(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
}

let origin = '';

async function fullRun(browser, vp) {
  const run = { page: PAGE, name: vp.name, mode: 'motion', viewport: `${vp.width}x${vp.height}${vp.touch ? ' touch' : ''}`, failures: [] };
  report.runs.push(run);
  const { context, page, log } = await newPage(browser, vp);
  try {
    await page.goto(`${origin}/${PAGE}`, { waitUntil: 'load' });
    const hasEngine = await page.waitForFunction(() => !!window.__michi, null, { timeout: 10000 }).then(() => true, () => false);
    if (!hasEngine) { fail(run, 'window.__michi never appeared (engine did not boot)'); return; }
    run.heroReady = await page.evaluate(() => document.documentElement.hasAttribute('data-hero-ready'));
    if (!run.heroReady) fail(run, 'data-hero-ready not set after boot');
    run.boot = await page.evaluate(() => window.__michi.list().map((t) => `${t.name}:${t.state}`));
    // Every take root and every take-for reference must name a registered take.
    const orphans = await page.evaluate(() => {
      const names = new Set(window.__michi.list().map((t) => t.name));
      const refs = [...document.querySelectorAll('[data-take]')].map((e) => e.getAttribute('data-take'))
        .concat([...document.querySelectorAll('[data-take-for]')].map((e) => e.getAttribute('data-take-for')));
      return [...new Set(refs.filter((n) => !names.has(n)))];
    });
    if (orphans.length) fail(run, 'take markup with no registered take', orphans);
    // Let the hero reach its own hold first (if it autoplayed).
    const heroPlaying = await page.evaluate(() => { const h = window.__michi.state('hero'); return !!h && h.state !== 'held' && h.state !== 'armed'; });
    if (heroPlaying) {
      const held = await page.waitForFunction(() => window.__michi.state('hero').state === 'held', null, { timeout: 15000 }).then(() => true, () => false);
      if (!held) fail(run, 'hero did not reach its hold within 15 s', await page.evaluate(() => window.__michi.state('hero')));
    }
    run.played = await page.evaluate(() => window.__michi.playAll(4, 30000));
    await scrollThrough(page);
    run.takes = await page.evaluate(() => window.__michi.finishAll());
    for (const t of run.takes) {
      if (t.state !== 'held') fail(run, `take ${t.name} not held after finishAll (${t.state})`);
      if (!(t.holds >= 1)) fail(run, `take ${t.name} never reached its hold`);
      if (t.errors.length) fail(run, `take ${t.name} step errors`, t.errors);
    }
    const busy = await page.evaluate(() => window.__michi.list().filter((t) => t.state !== 'held').map((t) => t.name));
    if (busy.length) fail(run, 'takes still busy at the end', busy);
    await sleep(100);
    const top = await page.evaluate(overflowProbe);
    if (top.scrollWidth > top.innerWidth) fail(run, `horizontal overflow ${top.scrollWidth} > ${top.innerWidth}`, top.offenders);
    checkPalette(run, await page.evaluate(paletteProbe), heroPlaying);
  } catch (e) {
    fail(run, 'exception', String(e && e.stack || e));
  } finally {
    checkLog(run, log);
    await context.close();
  }
}

async function reducedRun(browser) {
  const vp = VIEWPORTS[0];
  const run = { page: PAGE, name: 'reduced', mode: 'reduced-motion', viewport: `${vp.width}x${vp.height}`, failures: [] };
  report.runs.push(run);
  const { context, page, log } = await newPage(browser, vp, { reducedMotion: 'reduce' });
  try {
    await page.goto(`${origin}/${PAGE}`, { waitUntil: 'load' });
    const hasEngine = await page.waitForFunction(() => !!window.__michi, null, { timeout: 10000 }).then(() => true, () => false);
    if (!hasEngine) { fail(run, 'window.__michi never appeared'); return; }
    await sleep(300);
    const boot = await page.evaluate(() => ({
      t0: document.documentElement.getAttribute('data-take-hero'),
      motion: document.documentElement.getAttribute('data-motion'),
      takes: window.__michi.list(),
      play: [...document.querySelectorAll('[data-take-control="play"]')].map((b) => ({ hidden: b.hidden })),
      replayShown: [...document.querySelectorAll('[data-take-control="replay"]')].filter((b) => !b.hidden).length,
    }));
    run.boot = boot;
    if (boot.t0) fail(run, 'head script set data-take-hero under reduced motion');
    if (boot.motion !== 'reduce') fail(run, 'html[data-motion] is not "reduce"');
    for (const t of boot.takes) if (t.state !== 'held' || t.starts) fail(run, `take ${t.name} not at tB at boot (${t.state}, starts ${t.starts})`);
    if (boot.play.some((p) => p.hidden)) fail(run, 'a Play control is hidden under reduced motion');
    if (boot.replayShown) fail(run, 'Replay shown under reduced motion');
    await scrollThrough(page);
    const after = await page.evaluate(() => window.__michi.list().filter((t) => t.starts > 0).map((t) => t.name));
    if (after.length) fail(run, 'takes autoplayed under reduced motion', after);
    run.played = await page.evaluate(() => window.__michi.playAll(10, 30000));
    for (const t of run.played) {
      if (t.state !== 'held') fail(run, `steps playback of ${t.name} did not hold (${t.state})`);
      if (t.mode !== 'steps') fail(run, `take ${t.name} did not play as steps (${t.mode})`);
      if (t.errors.length) fail(run, `take ${t.name} step errors`, t.errors);
    }
    const ov = await page.evaluate(overflowProbe);
    if (ov.scrollWidth > ov.innerWidth) fail(run, `horizontal overflow ${ov.scrollWidth} > ${ov.innerWidth}`, ov.offenders);
    checkPalette(run, await page.evaluate(paletteProbe), false);
  } catch (e) {
    fail(run, 'exception', String(e && e.stack || e));
  } finally {
    checkLog(run, log);
    await context.close();
  }
}

async function noJsRun(browser, vp) {
  const run = { page: PAGE, name: 'nojs-' + vp.name, mode: 'no-js', viewport: `${vp.width}x${vp.height}${vp.touch ? ' touch' : ''}`, failures: [] };
  report.runs.push(run);
  const { context, page, log } = await newPage(browser, vp, { javaScriptEnabled: false });
  try {
    await page.goto(`${origin}/${PAGE}`, { waitUntil: 'load' });
    await sleep(300);
    const v = await page.evaluate(visibleProbe);
    run.probe = v;
    if (v.js) fail(run, 'html.js present without JavaScript');
    if (v.heroT0) fail(run, 'data-take-hero set without JavaScript');
    if (v.tokens) fail(run, 'tokens (.w/.c) present without JavaScript');
    if (!v.headings) fail(run, 'no headings found');
    if (v.hiddenHeadings.length) fail(run, 'headings not visible', v.hiddenHeadings);
    if (v.hiddenReplicas.length) fail(run, 'replicas not visible', v.hiddenReplicas);
    if (v.shownControls) fail(run, `${v.shownControls} take controls visible without JavaScript`);
    const ov = await page.evaluate(overflowProbe);
    if (ov.scrollWidth > ov.innerWidth) fail(run, `horizontal overflow ${ov.scrollWidth} > ${ov.innerWidth}`, ov.offenders);
    // evaluate() runs even with JavaScript disabled in the page.
    checkPalette(run, await page.evaluate(paletteProbe), false);
  } catch (e) {
    fail(run, 'exception', String(e && e.stack || e));
  } finally {
    checkLog(run, log);
    await context.close();
  }
}

server.listen(0, '127.0.0.1', async () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    for (const p of PAGES) if (!fs.existsSync(path.join(ROOT, p))) throw new Error(`no ${p} under ${ROOT} (run node landing/src/build.mjs)`);
    browser = await chromium.launch();
    for (const p of PAGES) {
      PAGE = p;
      PALETTE = paletteOf(p);
      for (const vp of VIEWPORTS) await fullRun(browser, vp);
      await reducedRun(browser);
      for (const i of [0, 3, 4, 5]) await noJsRun(browser, VIEWPORTS[i]);
    }
  } catch (e) {
    report.ok = false;
    report.failures.push('fatal: ' + String(e && e.message || e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
    report.summary = (report.ok ? 'PASS' : `FAIL (${report.failures.length})`) + `: ${report.runs.length} runs over ${PAGES.join(', ')}`;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  }
});
