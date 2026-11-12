import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeFeatureList, michiDisabledFeatures } from '../electron/dist/chromiumFeatures.js';

// Chromium 146 (Electron 41) and Chromium 152 names of the same feature.
const VSYNC = ['VSyncAlignedPresent', 'VSyncAlignedPresentationForScrolling'];
// ANGLE's Metal backend and Skia Graphite, which runs only on Metal.
const METAL = ['DefaultANGLEMetal', 'SkiaGraphite'];

test('turns off vsync-aligned presentation and the Metal backend on macOS only', () => {
  assert.deepEqual(michiDisabledFeatures('darwin', {}), [...VSYNC, ...METAL]);
  assert.deepEqual(michiDisabledFeatures('win32', {}), []);
  assert.deepEqual(michiDisabledFeatures('linux', {}), []);
});

test('MICHI_KEEP_VSYNC_PRESENTATION=1 keeps Chromium default for comparison', () => {
  assert.deepEqual(michiDisabledFeatures('darwin', { MICHI_KEEP_VSYNC_PRESENTATION: '1' }), METAL);
  assert.deepEqual(michiDisabledFeatures('darwin', { MICHI_KEEP_VSYNC_PRESENTATION: '0' }), [...VSYNC, ...METAL]);
});

test('keeps the Metal backend without vibrancy, or when MICHI_KEEP_ANGLE_METAL=1', () => {
  assert.deepEqual(michiDisabledFeatures('darwin', { MICHI_NO_VIBRANCY: '1' }), VSYNC);
  assert.deepEqual(michiDisabledFeatures('darwin', { MICHI_KEEP_ANGLE_METAL: '1' }), VSYNC);
  assert.deepEqual(michiDisabledFeatures('darwin', { MICHI_KEEP_ANGLE_METAL: '0' }), [...VSYNC, ...METAL]);
});

test('keeps the Metal backend when windows open with window glass off', () => {
  assert.deepEqual(michiDisabledFeatures('darwin', {}, false), VSYNC);
  assert.deepEqual(michiDisabledFeatures('darwin', {}, true), [...VSYNC, ...METAL]);
});

test('merges into an existing --disable-features value without duplicates', () => {
  assert.equal(mergeFeatureList('', ['A']), 'A');
  assert.equal(mergeFeatureList('Foo,Bar', ['A']), 'Foo,Bar,A');
  assert.equal(mergeFeatureList(' Foo , A ,', ['A', 'B']), 'Foo,A,B');
});
