// Checks the tray icon as Electron itself loads it (DESIGN-v2 §5.1): every
// icon file the app can show is a non-empty image, on macOS a template image
// with a 2x representation; the menu model builds into a native menu; and a
// Tray comes up and goes away. Runs from `npm run test:electron-tray`, or
// alone with `node scripts/run-electron-smoke.mjs tray` after
// `npm run electron:build-main`; it needs a desktop session, and the menu bar
// (or notification area) shows the icon for a moment. No Michi data is read.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, Menu, Tray, nativeImage } = require('electron');
const tray = require('../electron/dist/tray.js');
const { runSmoke } = require('./electron-smoke-harness.cjs');

// A throwaway Chromium profile rather than bare Electron's shared default.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-tray-smoke-'));
app.setPath('userData', userData);
process.on('exit', () => fs.rmSync(userData, { recursive: true, force: true }));

// Where main.ts finds them: path.join(__dirname, '..', '..', 'assets', 'icons') from electron/dist.
const ICON_DIR = path.join(__dirname, '..', 'assets', 'icons');

function dto(badge) {
  return {
    displayName: 'Michi', enabled: true, paused: false, welcomeWanted: false, conversationWaiting: false,
    statusLine: { text: 'Watching · checked 2m ago', tone: 'ok' }, badge,
    needsYou: badge > 0 ? [{ id: 'cmi-1', title: 'CR-1 & 2 comments', isNew: true, target: { kind: 'companion', tab: 'today', itemId: 'cmi-1' } }] : [],
    needsYouTotal: badge, briefReady: true, revision: 1,
  };
}

runSmoke('native-tray-smoke', async () => {
  const problems = [];
  const states = [{ kind: 'loading' }, { kind: 'ready', dto: dto(0) }, { kind: 'ready', dto: dto(2) }];
  const files = new Set();
  for (const dark of [false, true]) for (const data of states) files.add(tray.trayIconFile(data, process.platform, dark));
  for (const file of files) {
    const image = nativeImage.createFromPath(path.join(ICON_DIR, file));
    if (image.isEmpty()) {
      problems.push(`${file}: empty`);
      continue;
    }
    if (process.platform === 'darwin') {
      if (!image.isTemplateImage()) problems.push(`${file}: not a template image`);
      if (!image.getScaleFactors().includes(2)) problems.push(`${file}: no 2x representation (scale factors ${image.getScaleFactors().join(', ')})`);
      const { width, height } = image.getSize();
      if (width !== 16 || height !== 16) problems.push(`${file}: ${width}x${height} pt, not 16x16`);
    }
  }

  const model = tray.trayMenuModel(states[2], { platform: process.platform });
  const menu = Menu.buildFromTemplate(tray.trayMenuTemplate(model, () => {}));
  if (menu.items.length !== model.length) problems.push(`menu: ${menu.items.length} items for ${model.length} entries`);

  const icon = new Tray(nativeImage.createFromPath(path.join(ICON_DIR, tray.trayIconFile(states[0], process.platform, false))));
  icon.setToolTip(tray.trayTooltip(states[2]));
  icon.destroy();
  if (!icon.isDestroyed()) problems.push('tray: not destroyed');

  // The slot main.ts uses, with Electron's own nativeImage and Tray: an icon
  // file missing from the package loads as an empty image, and gives no icon
  // at all rather than a blank one; a real file gives one; an update to a
  // missing file keeps it; and taking it down leaves none.
  const slot = new tray.TrayIconSlot({
    load: (file) => nativeImage.createFromPath(path.join(ICON_DIR, file)),
    construct: (image, guid) => (guid ? new Tray(image, guid) : new Tray(image)),
  });
  const missing = 'tray-smoke-missing.png';
  if (slot.show(missing, undefined) !== null || slot.current !== null) problems.push('slot: a missing icon file put up an icon');
  const shown = slot.show(tray.trayIconFile(states[0], process.platform, false), undefined);
  if (!shown) problems.push('slot: no icon from a real file');
  slot.setFile(missing);
  if (shown && slot.current !== shown) problems.push('slot: an update to a missing file took the icon away');
  slot.destroy();
  if (slot.current !== null || (shown && !shown.isDestroyed())) problems.push('slot: the icon was not taken down');

  for (const problem of problems) console.error(problem);
  return problems.length === 0;
});
