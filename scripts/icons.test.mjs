import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  MASTER_ICON, TRAY_GLYPH_MASTER, TRAY_ICOS, TRAY_ICO_SIZES, TRAY_TEMPLATE_PNGS, generateIcons, staleIcons,
} from './generate-icons.mjs';
import { decodeIcns, decodeIco, decodePng, pngSize } from './lib/image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const require = createRequire(import.meta.url);

function matches(file, pattern, toPath) {
  const found = [...read(file).matchAll(pattern)].map((m) => toPath(m[1]));
  assert.ok(found.length > 0, `no icon reference found in ${file}; update this test if the reference moved`);
  return found;
}

function packageIcons() {
  const found = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      if (/icon$/i.test(key) && typeof v === 'string') found.push(v);
      else walk(v);
    }
  };
  walk(JSON.parse(read('package.json')).build);
  assert.ok(found.length > 0, 'no icon in package.json build config');
  return found;
}

const manifest = () => JSON.parse(read('frontend/public/manifest.json'));

test('every icon path the app references exists', () => {
  const referenced = [
    ...packageIcons(),
    ...manifest().icons.map((icon) => `frontend/public/${icon.src}`),
    ...matches('electron/main.ts', /'assets',\s*'icons',\s*'([^']+)'/g, (name) => `assets/icons/${name}`),
    ...(fs.existsSync(path.join(root, 'install.ps1'))
      ? matches('install.ps1', /"assets"\s+"icons"\s+"([^"]+)"/g, (name) => `assets/icons/${name}`)
      : []),
    ...matches('frontend/index.html', /<link rel="icon"[^>]*href="\/([^"]+)"/g, (name) => `frontend/public/${name}`),
  ];
  for (const file of referenced) assert.ok(fs.existsSync(path.join(root, file)), `${file} is referenced but missing`);
});

test('the web manifest lists 192 and 512 px PNG icons with their real sizes', () => {
  const declared = new Set();
  for (const icon of manifest().icons) {
    const { width, height } = pngSize(fs.readFileSync(path.join(root, 'frontend/public', icon.src)));
    assert.equal(icon.type, 'image/png', icon.src);
    assert.equal(icon.sizes, `${width}x${height}`, icon.src);
    declared.add(icon.sizes);
  }
  assert.ok(declared.has('192x192') && declared.has('512x512'), `manifest sizes: ${[...declared].join(', ')}`);
});

test('the macOS icon carries every iconset size', () => {
  const sizes = new Set(decodeIcns(fs.readFileSync(path.join(root, 'assets/icons/icon.icns'))).map(([, img]) => img.width));
  assert.deepEqual([...sizes].sort((a, b) => a - b), [16, 32, 64, 128, 256, 512, 1024]);
});

test('the Windows icon carries the shell sizes from 16 to 256 px', () => {
  const sizes = decodeIco(fs.readFileSync(path.join(root, 'assets/icons/icon.ico'))).map((img) => img.width);
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256]);
});

test(`generated icons match ${MASTER_ICON} and ${TRAY_GLYPH_MASTER}`, () => {
  assert.deepEqual(staleIcons(root), [], 'run npm run icons:generate and commit the result');
});

// ── Tray icons (DESIGN-v2 §5.1) ──────────────────────────────────────────────

const pixelsOf = (img) => Array.from({ length: img.width * img.height }, (_, i) => img.data.subarray(i * 4, i * 4 + 4));

test('the tray glyph master is 1024 px, black on transparency', () => {
  const glyph = decodePng(fs.readFileSync(path.join(root, TRAY_GLYPH_MASTER)));
  assert.equal(glyph.width, 1024);
  assert.equal(glyph.height, 1024);
  const visible = pixelsOf(glyph).filter((px) => px[3] > 0);
  assert.ok(visible.length > 1024 * 64, 'the glyph has a shape');
  assert.ok(visible.every((px) => px[0] === 0 && px[1] === 0 && px[2] === 0), 'only black');
});

test('macOS tray icons are template images: black and alpha only, 16 pt, each with an exact @2x', () => {
  for (const [file, , size] of TRAY_TEMPLATE_PNGS) {
    assert.match(path.basename(file), /Template(@2x)?\.png$/, `${file}: macOS treats only *Template names as template images`);
    const img = decodePng(fs.readFileSync(path.join(root, file)));
    assert.deepEqual([img.width, img.height], [size, size], file);
    const visible = pixelsOf(img).filter((px) => px[3] > 0);
    assert.ok(visible.length > size * size / 8, `${file} shows the glyph`);
    assert.ok(visible.every((px) => px[0] === 0 && px[1] === 0 && px[2] === 0), `${file}: every visible pixel is black`);
  }
  for (const [file, , size] of TRAY_TEMPLATE_PNGS.filter(([name]) => !name.includes('@2x'))) {
    const retina = file.replace(/\.png$/, '@2x.png');
    assert.equal(pngSize(fs.readFileSync(path.join(root, retina))).width, size * 2, `${retina} is twice ${file}`);
  }
});

test('Windows tray icons carry the notification-area sizes, 16 to 48 px', () => {
  for (const [file] of TRAY_ICOS) {
    const sizes = decodeIco(fs.readFileSync(path.join(root, file))).map((img) => img.width);
    assert.deepEqual(sizes, TRAY_ICO_SIZES, file);
    assert.deepEqual([...sizes].sort((a, b) => a - b), [16, 20, 24, 32, 40, 48], file);
  }
  // A dark glyph for a light taskbar, a light one for a dark taskbar.
  const meanInk = (file) => {
    const visible = pixelsOf(decodeIco(fs.readFileSync(path.join(root, file)))[0]).filter((px) => px[3] === 255);
    return visible.reduce((sum, px) => sum + px[0] + px[1] + px[2], 0) / visible.length / 3;
  };
  assert.ok(meanInk('assets/icons/tray-light.ico') < 32);
  assert.ok(meanInk('assets/icons/tray-dark.ico') > 223);
});

test('an attention icon is its glyph with a dot in the top-right corner, and nothing else changed elsewhere', () => {
  const pairs = [
    ['assets/icons/trayTemplate@2x.png', 'assets/icons/trayAttentionTemplate@2x.png', (file) => decodePng(fs.readFileSync(path.join(root, file)))],
    ['assets/icons/tray-light.ico', 'assets/icons/tray-attention-light.ico', (file) => decodeIco(fs.readFileSync(path.join(root, file)))[0]],
  ];
  for (const [normalFile, attentionFile, load] of pairs) {
    const normal = load(normalFile);
    const attention = load(attentionFile);
    const size = normal.width;
    const alphaAt = (img, x, y) => img.data[(y * size + x) * 4 + 3];
    // The dot's centre (80%, 20%) is solid in the attention icon only.
    const cx = Math.floor(size * 0.8);
    const cy = Math.floor(size * 0.2);
    assert.equal(alphaAt(attention, cx, cy), 255, attentionFile);
    assert.ok(alphaAt(normal, cx, cy) < 255, normalFile);
    // The bottom-left half, far from the dot, is the same glyph.
    for (let y = Math.floor(size / 2); y < size; y++) {
      for (let x = 0; x < Math.floor(size / 2); x++) assert.equal(alphaAt(attention, x, y), alphaAt(normal, x, y), `${attentionFile} at ${x},${y}`);
    }
  }
});

/** electron-builder's `files` globs (minimatch): `**` any depth, `*` within a segment, `!` excludes. */
function globMatches(pattern, file) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${source}$`).test(file);
}

function packaged(file) {
  const patterns = JSON.parse(read('package.json')).build.files;
  const included = patterns.filter((p) => !p.startsWith('!')).some((p) => globMatches(p, file));
  const excluded = patterns.filter((p) => p.startsWith('!')).some((p) => globMatches(p.slice(1), file));
  return included && !excluded;
}

test('the build.files check matches the way electron-builder reads its globs', () => {
  assert.equal(globMatches('electron/dist/**', 'electron/dist/tray.js'), true);
  assert.equal(globMatches('**/*.map', 'electron/dist/tray.js.map'), true);
  assert.equal(globMatches('assets/icons/tray*Template*.png', 'assets/icons/trayTemplate@2x.png'), true);
  assert.equal(globMatches('assets/icons/tray*Template*.png', 'assets/icons/tray-glyph.png'), false);
  assert.equal(packaged('electron/dist/tray.js'), true);
  assert.equal(packaged('electron/dist/tray.js.map'), false);
  assert.equal(packaged('assets/icons/icon.png'), false, 'the app icon ships inside the .icns/.ico, not as a file');
});

test('every tray icon the app can load exists and ships in the package; the glyph master does not', () => {
  // The names main.ts loads (electron/dist/tray.js; run `npm run electron:build-main` first).
  const tray = require('../electron/dist/tray.js');
  const dto = (badge) => ({
    displayName: 'Michi', enabled: true, paused: false, welcomeWanted: false, conversationWaiting: false,
    statusLine: { text: 'Watching', tone: 'ok' }, badge, needsYou: [], needsYouTotal: 0, briefReady: false, revision: 1,
  });
  const states = [{ kind: 'loading' }, { kind: 'ready', dto: dto(0) }, { kind: 'ready', dto: dto(3) }];
  const loaded = new Set();
  for (const platform of ['darwin', 'win32']) {
    for (const dark of [false, true]) {
      for (const data of states) {
        const file = `assets/icons/${tray.trayIconFile(data, platform, dark)}`;
        loaded.add(file);
        // nativeImage loads a template's @2x sibling with it.
        if (file.endsWith('.png')) loaded.add(file.replace(/\.png$/, '@2x.png'));
      }
    }
  }
  const generated = [...TRAY_TEMPLATE_PNGS, ...TRAY_ICOS].map(([file]) => file).sort();
  assert.deepEqual([...loaded].sort(), generated, 'the app loads exactly the generated tray icons');
  for (const file of loaded) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} is loaded but missing`);
    assert.ok(packaged(file), `${file} is loaded but package.json build.files leaves it out`);
  }
  assert.equal(packaged(TRAY_GLYPH_MASTER), false, 'the glyph master is a source, not shipped');
  // main.ts resolves them beside electron/dist, which is assets/icons in the repo and in app.asar alike.
  assert.match(read('electron/main.ts'), /path\.join\(__dirname, '\.\.', '\.\.', 'assets', 'icons'\)/);
});

test('the icon check reports missing and replaced outputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-icons-'));
  try {
    for (const sub of ['assets/icons', 'frontend/public']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.copyFileSync(path.join(root, MASTER_ICON), path.join(dir, MASTER_ICON));
    fs.copyFileSync(path.join(root, TRAY_GLYPH_MASTER), path.join(dir, TRAY_GLYPH_MASTER));
    const written = generateIcons(dir);
    assert.deepEqual(staleIcons(dir), []);
    fs.rmSync(path.join(dir, written[0]));
    fs.copyFileSync(path.join(dir, 'frontend/public/icon-192.png'), path.join(dir, 'frontend/public/favicon.png'));
    // A tray icon swapped for its attention variant is stale too.
    fs.copyFileSync(path.join(dir, 'assets/icons/trayAttentionTemplate.png'), path.join(dir, 'assets/icons/trayTemplate.png'));
    assert.deepEqual(staleIcons(dir), [written[0], 'frontend/public/favicon.png', 'assets/icons/trayTemplate.png']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
