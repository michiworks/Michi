import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardedShellChord, isClosePaneShortcut } from '../electron/dist/paneShortcuts.js';

function input(overrides = {}) {
  return {
    type: 'keyDown',
    key: 'w',
    meta: false,
    control: false,
    shift: false,
    alt: false,
    ...overrides,
  };
}

test('matches the platform close-pane accelerator', () => {
  assert.equal(isClosePaneShortcut(input({ meta: true }), 'darwin'), true);
  assert.equal(isClosePaneShortcut(input({ control: true }), 'linux'), true);
  assert.equal(isClosePaneShortcut(input({ control: true }), 'win32'), true);
});

test('does not steal close-window or alternate modified shortcuts', () => {
  assert.equal(isClosePaneShortcut(input({ meta: true, shift: true }), 'darwin'), false);
  assert.equal(isClosePaneShortcut(input({ meta: true, alt: true }), 'darwin'), false);
  assert.equal(isClosePaneShortcut(input({ meta: true, control: true }), 'darwin'), false);
});

test('ignores key-up and non-W input', () => {
  assert.equal(isClosePaneShortcut(input({ type: 'keyUp', meta: true }), 'darwin'), false);
  assert.equal(isClosePaneShortcut(input({ key: 'q', meta: true }), 'darwin'), false);
});

// Chords a focused Browser pane hands back to the shell, by platform. Every
// other chord, ⌘K and ⌘[ ⌘] included, stays the page's.
const FORWARDED = [
  { name: 'next pane', input: { key: 'Tab', control: true }, platforms: ['darwin', 'linux', 'win32'] },
  { name: 'previous pane', input: { key: 'Tab', control: true, shift: true }, platforms: ['darwin', 'linux', 'win32'] },
  { name: 'new thread', input: { key: 't', meta: true }, platforms: ['darwin'] },
  { name: 'new thread', input: { key: 't', control: true }, platforms: ['linux', 'win32'] },
  { name: 'assistant', input: { key: 'j', meta: true }, platforms: ['darwin'] },
  { name: 'assistant', input: { key: 'j', control: true }, platforms: ['linux', 'win32'] },
  { name: 'settings', input: { key: ',', meta: true }, platforms: ['darwin'] },
  { name: 'settings', input: { key: ',', control: true }, platforms: ['linux', 'win32'] },
];
const KEPT_BY_THE_PAGE = [
  { name: 'page palette', input: { key: 'k', meta: true }, platform: 'darwin' },
  { name: 'page back', input: { key: '[', meta: true }, platform: 'darwin' },
  { name: 'page forward', input: { key: ']', control: true }, platform: 'linux' },
  { name: 'macOS transpose', input: { key: 't', control: true }, platform: 'darwin' },
  { name: 'Ctrl+Cmd chord', input: { key: 'j', meta: true, control: true }, platform: 'darwin' },
  { name: 'Shift variant', input: { key: 't', meta: true, shift: true }, platform: 'darwin' },
  { name: 'Option variant', input: { key: 'j', control: true, alt: true }, platform: 'linux' },
  { name: 'close pane (its own event)', input: { key: 'w', meta: true }, platform: 'darwin' },
  { name: 'bare Tab', input: { key: 'Tab' }, platform: 'linux' },
];

test('forwards the shell chords a browser pane must not swallow', () => {
  for (const row of FORWARDED) {
    for (const platform of row.platforms) {
      const chord = input(row.input);
      assert.deepEqual(forwardedShellChord(chord, platform), { key: chord.key, meta: chord.meta, control: chord.control, shift: chord.shift, alt: chord.alt }, `${row.name} on ${platform}`);
    }
  }
});

test('leaves every other chord, and key-up, to the page', () => {
  for (const row of KEPT_BY_THE_PAGE) assert.equal(forwardedShellChord(input(row.input), row.platform), null, row.name);
  assert.equal(forwardedShellChord(input({ type: 'keyUp', key: 'j', meta: true }), 'darwin'), null);
});
