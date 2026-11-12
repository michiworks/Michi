// Checks that Cmd+W reaches a sandboxed view as the close-pane shortcut, and
// Ctrl+Tab as a chord passed on to the shell, which takes keyboard focus back
// from the view the way main.ts does.
// Runs from `npm run test:electron-shortcuts`; it needs a desktop session.
const { forwardedShellChord, isClosePaneShortcut } = require('../electron/dist/paneShortcuts.js');
const { runSmoke } = require('./electron-smoke-harness.cjs');

runSmoke('native-shortcut-smoke', async ({ host, view }) => {
  let closed = false;
  let forwarded = false;
  view.webContents.on('before-input-event', (event, input) => {
    if (isClosePaneShortcut(input, 'darwin')) closed = true;
    else if (forwardedShellChord(input, 'darwin')?.key === 'Tab') {
      forwarded = true;
      host.webContents.focus();
    } else return;
    event.preventDefault();
  });
  // A hidden window has no keyboard focus to hand back, so this smoke shows it.
  host.show();
  await host.loadURL('data:text/html,<title>shell</title>');
  await view.webContents.loadURL('data:text/html,<title>shortcut smoke</title>');
  view.webContents.focus();
  if (!view.webContents.isFocused()) return false;
  view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
  view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['control'] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  return closed && forwarded && host.webContents.isFocused() && !view.webContents.isFocused();
});
