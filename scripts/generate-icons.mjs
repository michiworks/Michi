#!/usr/bin/env node
// Generates every shipped icon from two masters: assets/icons/icon.png
// (1024x1024 RGBA, the app icon) and assets/icons/tray-glyph.png (1024x1024,
// a black glyph on transparency: the menu-bar / notification-area icon,
// DESIGN-v2 §5.1). To change one, replace its master and run
//   npm run icons:generate
// then commit the master and the generated files. `--check` regenerates in
// memory and exits 1 if any committed file is missing or no longer matches.
//
// The desktop icons (.icns, .ico) keep the master's transparent margin. The
// web icons are cropped to the master's opaque area, as the browser favicon
// always was. The tray icons are cropped to the glyph, with a small margin.
//
// The tray glyph is a placeholder until it has a design: the app icon's light
// shape, written by `node scripts/generate-icons.mjs --tray-glyph-from-icon`.
// A designed glyph replaces assets/icons/tray-glyph.png and needs no code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  decodeIcns, decodeIco, decodePng, encodeIcns, encodeIco, encodePng, opaqueBounds, resizeSquare,
} from './lib/image.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MASTER_ICON = 'assets/icons/icon.png';
export const TRAY_GLYPH_MASTER = 'assets/icons/tray-glyph.png';

// Sizes the Windows shell asks for (small icons, taskbar, Explorer views), so
// it never has to scale the 256 px image down on its own. Largest first:
// some tools read only the first entry (app-builder's icon set does).
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];

// Same types and sizes iconutil writes for a full .iconset.
const ICNS_ENTRIES = [
  ['ic04', 16], ['ic05', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128],
  ['ic08', 256], ['ic13', 256], ['ic09', 512], ['ic14', 512], ['ic10', 1024],
];

const WEB_PNGS = [
  ['frontend/public/favicon.png', 144],
  ['frontend/public/icon-192.png', 192],
  ['frontend/public/icon-512.png', 512],
];

// ── Tray icons (electron/tray.ts trayIconFile names them) ────────────────────

/** macOS template images: black and alpha only, 16 pt with a @2x sibling of the same name. */
export const TRAY_TEMPLATE_PNGS = [
  ['assets/icons/trayTemplate.png', 'normal', 16],
  ['assets/icons/trayTemplate@2x.png', 'normal', 32],
  ['assets/icons/trayAttentionTemplate.png', 'attention', 16],
  ['assets/icons/trayAttentionTemplate@2x.png', 'attention', 32],
];

/** Windows notification-area sizes, 100% to 300% scaling (largest first, as ICO_SIZES). */
export const TRAY_ICO_SIZES = [48, 40, 32, 24, 20, 16];

/** `light` is for a light taskbar (a black glyph), `dark` for a dark one (a white glyph). */
const TRAY_INK = { light: [0, 0, 0], dark: [255, 255, 255] };
/** The attention dot on Windows, where the icon is not a template and can have colour. */
const TRAY_DOT_WINDOWS = [0xe5, 0x48, 0x4d];

export const TRAY_ICOS = [
  ['assets/icons/tray-light.ico', 'normal', 'light'],
  ['assets/icons/tray-dark.ico', 'normal', 'dark'],
  ['assets/icons/tray-attention-light.ico', 'attention', 'light'],
  ['assets/icons/tray-attention-dark.ico', 'attention', 'dark'],
];

/** The glyph's box: a square around its opaque area with a 1/16 margin each side, so the dot and the edges never clip. */
function trayBox(glyph) {
  const bounds = opaqueBounds(glyph);
  const side = Math.max(bounds.width, bounds.height) * 18 / 16;
  return {
    x: bounds.x + (bounds.width - side) / 2,
    y: bounds.y + (bounds.height - side) / 2,
    width: side,
    height: side,
  };
}

/**
 * The glyph in one colour (its alpha kept), with the attention dot in the
 * top-right corner of `box` when asked: a clear ring cut around it so the dot
 * reads apart from the glyph at 16 px.
 */
function trayArt(glyph, box, { ink, dot }) {
  const data = new Uint8Array(glyph.data.length);
  const cx = box.x + box.width * 0.8;
  const cy = box.y + box.height * 0.2;
  const dotR = box.width * 0.18;
  const ringR = box.width * 0.27;
  for (let y = 0; y < glyph.height; y++) {
    for (let x = 0; x < glyph.width; x++) {
      const i = (y * glyph.width + x) * 4;
      const d = dot ? Math.hypot(x + 0.5 - cx, y + 0.5 - cy) : Infinity;
      if (d <= dotR) {
        data.set(dot, i);
        data[i + 3] = 255;
      } else if (d > ringR) {
        data.set(ink, i);
        data[i + 3] = glyph.data[i + 3];
      }
    }
  }
  return { width: glyph.width, height: glyph.height, data };
}

function trayOutputs(glyph) {
  const box = trayBox(glyph);
  const art = new Map();
  const artFor = (state, ink, dot) => {
    const key = `${state}:${ink}:${dot}`;
    if (!art.has(key)) art.set(key, trayArt(glyph, box, { ink, dot: state === 'attention' ? dot : null }));
    return art.get(key);
  };
  return [
    ...TRAY_TEMPLATE_PNGS.map(([file, state, size]) => ({
      file,
      images: [resizeSquare(artFor(state, TRAY_INK.light, TRAY_INK.light), box, size)],
      encode: ([img]) => encodePng(img),
      decode: (buf) => [decodePng(buf)],
    })),
    ...TRAY_ICOS.map(([file, state, theme]) => ({
      file,
      images: TRAY_ICO_SIZES.map((size) => resizeSquare(artFor(state, TRAY_INK[theme], TRAY_DOT_WINDOWS), box, size)),
      encode: encodeIco,
      decode: decodeIco,
    })),
  ];
}

/**
 * The placeholder glyph from the app icon: its light shape (the character),
 * black on transparency, the dark features (eyes, mouth, the background)
 * cut out. Alpha follows the master's luminance between 32 and 224.
 */
export function placeholderTrayGlyph(master) {
  const data = new Uint8Array(master.data.length);
  for (let i = 0; i < master.data.length; i += 4) {
    const lum = 0.2126 * master.data[i] + 0.7152 * master.data[i + 1] + 0.0722 * master.data[i + 2];
    const coverage = Math.min(1, Math.max(0, (lum - 32) / (224 - 32)));
    data[i + 3] = Math.round(master.data[i + 3] * coverage);
  }
  return { width: master.width, height: master.height, data };
}

// Each output: its repo-relative path, the decoder for the committed file,
// and the images it should hold.
function renderOutputs(master) {
  const full = { x: 0, y: 0, width: master.width, height: master.height };
  const web = opaqueBounds(master);
  return [
    {
      file: 'assets/icons/icon.icns',
      images: ICNS_ENTRIES.map(([type, size]) => [type, resizeSquare(master, full, size)]),
      encode: encodeIcns,
      decode: decodeIcns,
    },
    {
      file: 'assets/icons/icon.ico',
      images: ICO_SIZES.map((size) => resizeSquare(master, full, size)),
      encode: encodeIco,
      decode: decodeIco,
    },
    ...WEB_PNGS.map(([file, size]) => ({
      file,
      images: [resizeSquare(master, web, size)],
      encode: ([img]) => encodePng(img),
      decode: (buf) => [decodePng(buf)],
    })),
  ];
}

function readSquare(root, file) {
  const image = decodePng(fs.readFileSync(path.join(root, file)));
  if (image.width !== 1024 || image.height !== 1024) {
    throw new Error(`${file} must be 1024x1024, got ${image.width}x${image.height}`);
  }
  return image;
}

function readMaster(root) {
  return readSquare(root, MASTER_ICON);
}

/** The tray glyph master; a template image holds black only, so any colour in it is refused. */
function readTrayGlyph(root) {
  const glyph = readSquare(root, TRAY_GLYPH_MASTER);
  for (let i = 0; i < glyph.data.length; i += 4) {
    if (glyph.data[i + 3] > 0 && (glyph.data[i] || glyph.data[i + 1] || glyph.data[i + 2])) {
      throw new Error(`${TRAY_GLYPH_MASTER} must be black on transparency`);
    }
  }
  return glyph;
}

function allOutputs(root) {
  return [...renderOutputs(readMaster(root)), ...trayOutputs(readTrayGlyph(root))];
}

/** Write every generated icon under `root`; returns the repo-relative paths. */
export function generateIcons(root = ROOT) {
  const outputs = allOutputs(root);
  for (const out of outputs) fs.writeFileSync(path.join(root, out.file), out.encode(out.images));
  return outputs.map((out) => out.file);
}

/**
 * Write the placeholder tray glyph master from the app icon (see the header)
 * and the tray icons generated from it; returns the repo-relative paths.
 */
export function writePlaceholderTrayGlyph(root = ROOT) {
  fs.writeFileSync(path.join(root, TRAY_GLYPH_MASTER), encodePng(placeholderTrayGlyph(readMaster(root))));
  const outputs = trayOutputs(readTrayGlyph(root));
  for (const out of outputs) fs.writeFileSync(path.join(root, out.file), out.encode(out.images));
  return [TRAY_GLYPH_MASTER, ...outputs.map((out) => out.file)];
}

// Pixels match when alpha is within 1 and, for visible pixels, every colour
// channel is within 1 (rounding can differ across Node versions).
function samePixels(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i + 3] - b.data[i + 3]) > 1) return false;
    if (a.data[i + 3] === 0 && b.data[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) if (Math.abs(a.data[i + c] - b.data[i + c]) > 1) return false;
  }
  return true;
}

const unwrap = (entry) => (Array.isArray(entry) ? entry : [null, entry]);

/** Repo-relative paths of generated icons that are missing or stale. */
export function staleIcons(root = ROOT) {
  const stale = [];
  for (const out of allOutputs(root)) {
    const file = path.join(root, out.file);
    if (!fs.existsSync(file)) {
      stale.push(out.file);
      continue;
    }
    const actual = out.decode(fs.readFileSync(file)).map(unwrap);
    const expected = out.images.map(unwrap);
    const same = actual.length === expected.length && expected.every(([type, img], i) =>
      actual[i][0] === type && samePixels(actual[i][1], img));
    if (!same) stale.push(out.file);
  }
  return stale;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--tray-glyph-from-icon')) {
    for (const file of writePlaceholderTrayGlyph()) console.log(`wrote ${file}`);
  } else if (process.argv.includes('--check')) {
    const stale = staleIcons();
    if (stale.length) {
      console.error(`Icons out of date with ${MASTER_ICON} and ${TRAY_GLYPH_MASTER}: ${stale.join(', ')}\nRun: npm run icons:generate`);
      process.exit(1);
    }
    console.log('Icons match their masters.');
  } else {
    for (const file of generateIcons()) console.log(`wrote ${file}`);
  }
}
