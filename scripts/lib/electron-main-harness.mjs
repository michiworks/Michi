// Loads the built Electron main process (electron/dist, `npm run
// electron:build-main`) in plain Node with an in-memory Electron, node-pty and
// child_process.fork, so scripts/electron-main-lifecycle.test.mjs can drive
// its lifecycle without a display, a real backend, launchd, PTYs or user
// files. Every module under electron/dist gets the doubles, so the tests keep
// working when main.ts is split into modules.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const realChildProcess = require('node:child_process');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distDir = path.join(root, 'electron', 'dist');
const mainEntry = path.join(root, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).main);

let active = null;
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  const fromMain = typeof parent?.filename === 'string' && parent.filename.startsWith(distDir + path.sep);
  if (active && fromMain && Object.hasOwn(active.modules, request)) return active.modules[request];
  return originalLoad.call(this, request, parent, isMain);
};

// main.ts's log lines, console notices and startup marks; the tests read the log file instead.
const ELOG_LINE = /^(\d{4}-\d{2}-\d{2}T\S+ (INFO |WARN |ERROR) |\[(devtools|main)\] |\{"type":"startup")/;
const SANDBOXED_ENV = /^(MICHI_|ELECTRON_|CLAUDE|ANTHROPIC|KIRO_)|^PORT$/;

function event() {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

/** Polls until `predicate` returns a truthy value; fails after `timeoutMs`. */
export async function waitFor(predicate, message = 'condition', timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createBackend() {
  const requests = [];
  const streams = new Set();
  const servers = new Map();
  let healthy = true;
  const handler = (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'michi-backend' }));
    } else if (req.method === 'GET' && req.url === '/api/scheduled-jobs/notifications/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      streams.add(res);
      res.on('close', () => streams.delete(res));
    } else if (req.method === 'GET' && req.url === '/api/companion/notifications/stream') {
      // The Companion's feed connects and stays quiet; `streams` holds the scheduled one only.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    } else {
      req.resume();
      res.writeHead(req.method === 'POST' ? 200 : 404);
      res.end('{}');
    }
  };
  return {
    requests,
    streams,
    setHealthy(value) { healthy = value; },
    /** Starts answering on `port` (0 picks one) unless it already does; resolves the port. */
    async listen(port = 0) {
      if (servers.has(port)) return port;
      const server = http.createServer(handler);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      const bound = server.address().port;
      servers.set(bound, server);
      return bound;
    },
    pushNotice(notice) {
      for (const res of streams) res.write(`event: scheduled_job_run\ndata: ${JSON.stringify(notice)}\n\n`);
    },
    async close() {
      const closing = [...servers.values()];
      servers.clear();
      for (const server of closing) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}

function createFakes(state, options) {
  let nextContentsId = 1;

  class FakeWebContents extends EventEmitter {
    constructor() {
      super();
      this.id = nextContentsId++;
      this.sent = [];
      this.url = '';
      this.destroyed = false;
      this.reloads = 0;
    }
    send(channel, ...args) { this.sent.push([channel, ...args]); }
    getURL() { return this.url; }
    isDestroyed() { return this.destroyed; }
    getZoomFactor() { return 1; }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    reload() { this.reloads += 1; }
    openDevTools() { state.log.push('webContents.openDevTools'); }
    // Keyboard focus: one webContents at a time, as in Chromium.
    focus() { state.focusedContents = this; }
    isFocused() { return state.focusedContents === this; }
  }

  class BrowserWindow extends EventEmitter {
    constructor(windowOptions) {
      super();
      this.options = windowOptions;
      this.webContents = new FakeWebContents();
      this.loads = [];
      this.destroyed = false;
      this.maximized = false;
      this.shown = false;
      this.normalBounds = { x: windowOptions.x ?? 0, y: windowOptions.y ?? 0, width: windowOptions.width, height: windowOptions.height };
      this.contentView = { addChildView() {}, removeChildView() {} };
      state.windows.push(this);
    }
    static getFocusedWindow() { return state.focused && !state.focused.destroyed ? state.focused : null; }
    static fromWebContents(contents) { return state.windows.find((win) => win.webContents === contents && !win.destroyed) ?? null; }
    static getAllWindows() { return state.windows.filter((win) => !win.destroyed); }
    // A closed window's webContents is gone: Electron throws "Object has been destroyed".
    async loadURL(url) {
      if (this.destroyed) throw new Error('Object has been destroyed');
      this.loads.push(url); this.webContents.url = url;
    }
    async loadFile(file, loadOptions) {
      if (this.destroyed) throw new Error('Object has been destroyed');
      this.loads.push({ file, ...loadOptions }); this.webContents.url = `file://${file}`;
    }
    maximize() { this.maximized = true; }
    isMaximized() { return this.maximized; }
    getNormalBounds() { return { ...this.normalBounds }; }
    getContentSize() { return [this.normalBounds.width, this.normalBounds.height]; }
    show() { this.shown = true; }
    setSkipTaskbar(value) { this.skipTaskbar = value; }
    focus() { state.focused = this; }
    isMinimized() { return false; }
    restore() {}
    isDestroyed() { return this.destroyed; }
    setVibrancy() {}
    close() {
      const closing = event();
      this.emit('close', closing);
      if (closing.defaultPrevented) return;
      this.destroyed = true;
      this.webContents.destroyed = true;
      if (state.focused === this) state.focused = null;
      this.emit('closed');
    }
  }

  class Notification extends EventEmitter {
    constructor(notificationOptions) {
      super();
      this.options = notificationOptions;
      this.shown = false;
      this.closed = false;
      state.notifications.push(this);
    }
    static isSupported() { return state.notificationsSupported; }
    show() { this.shown = true; }
    setSkipTaskbar(value) { this.skipTaskbar = value; }
    close() { this.closed = true; this.emit('close'); }
  }

  // A Browser pane's view: enough of it for browser:create, without a page.
  class WebContentsView {
    constructor() {
      const contents = new FakeWebContents();
      Object.assign(contents, {
        async loadURL(url) { contents.url = url; },
        getTitle() { return ''; },
        isLoading() { return false; },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        session: { setPermissionRequestHandler() {} },
        close() { contents.destroyed = true; },
      });
      this.webContents = contents;
      state.views.push(this);
    }
    setVisible() {}
    setBackgroundColor() {}
    setBounds() {}
  }

  const paths = { userData: state.userData, home: state.home };
  const app = Object.assign(new EventEmitter(), {
    name: 'michi',
    isPackaged: options.mode === 'packaged',
    dock: undefined,
    commandLine: {
      switches: state.switches,
      getSwitchValue(name) { return state.switches.get(name) ?? ''; },
      appendSwitch(name, value) { state.switches.set(name, value); },
    },
    setPath(name, value) { paths[name] = value; state.log.push(`app.setPath:${name}`); },
    getPath(name) { return paths[name]; },
    getAppPath() { return state.appPath; },
    getVersion() { return '0.0.0-test'; },
    requestSingleInstanceLock() { return options.singleInstance !== false; },
    // Windows only: the toast id and the "Open Michi at login" item.
    setAppUserModelId() {},
    getLoginItemSettings() { return { openAtLogin: false, wasOpenedAtLogin: false }; },
    setLoginItemSettings() {},
    whenReady() { return state.ready; },
    exit(code) { state.log.push(`app.exit:${code}`); },
    relaunch() { state.log.push('app.relaunch'); },
    focus() {},
    // Electron's order (docs/api/app.md): before-quit, then every window is
    // asked to close; one that refuses cancels the quit; once all have closed,
    // will-quit, and then the app ends unless that is prevented too.
    quit() {
      state.log.push('app.quit');
      const quitting = event();
      this.emit('before-quit', quitting);
      if (quitting.defaultPrevented) return;
      for (const win of state.windows.filter((candidate) => !candidate.destroyed)) {
        win.close();
        if (!win.destroyed) { state.log.push('app.quit:cancelled'); return; }
      }
      const willQuit = event();
      this.emit('will-quit', willQuit);
      if (!willQuit.defaultPrevented) state.log.push('app.quit:done');
    },
  });

  const electron = {
    app,
    BrowserWindow,
    WebContentsView,
    Notification,
    Menu: {
      buildFromTemplate(template) { return { template }; },
      setApplicationMenu(menu) { state.menu = menu.template; },
    },
    ipcMain: {
      handle(channel, handler) {
        if (state.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
        state.handlers.set(channel, handler);
      },
      on(channel, listener) {
        if (state.listeners.has(channel)) throw new Error(`Second listener for '${channel}'`);
        state.listeners.set(channel, listener);
      },
    },
    dialog: {
      async showMessageBox(_win, box) {
        state.messageBoxes.push(box);
        return { response: state.messageBoxResponse };
      },
      async showOpenDialog() { return { canceled: true, filePaths: [] }; },
      async showSaveDialog() { return { canceled: true }; },
    },
    shell: {
      async openExternal(url) { state.log.push(`shell.openExternal:${url}`); },
      async openPath() { return ''; },
    },
    // Main listens for 'updated' (the Windows tray icon follows the taskbar theme).
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false, shouldUseDarkColorsForSystemIntegratedUI: false, themeSource: 'system' }),
    // Every image is empty, as for an icon file missing from the package, so
    // no Tray is ever made and closing the last window works as without the
    // icon. scripts/electron-tray.test.mjs and the tray smoke cover the icon.
    nativeImage: { createFromPath() { return { isEmpty: () => true }; } },
    powerSaveBlocker: {
      start(type) { state.log.push(`powerSaveBlocker.start:${type}`); return 7; },
      stop(id) { state.log.push(`powerSaveBlocker.stop:${id}`); },
    },
    powerMonitor: state.powerMonitor,
    session: {
      defaultSession: {
        // React DevTools counts as installed, so dev launches never download it.
        extensions: { getAllExtensions: () => [{ id: 'fmkadmapgofadopljbjfkapdkoienihi', name: 'React Developer Tools' }] },
      },
    },
  };

  const pty = {
    spawn(file, args, spawnOptions) {
      const terminal = {
        file, args, options: spawnOptions, writes: [], resizes: [], killed: 0,
        dataListeners: [], exitListeners: [],
        onData(listener) { terminal.dataListeners.push(listener); },
        onExit(listener) { terminal.exitListeners.push(listener); },
        write(data) { terminal.writes.push(data); },
        resize(cols, rows) { terminal.resizes.push([cols, rows]); },
        kill() { terminal.killed += 1; },
        emitData(data) { for (const listener of terminal.dataListeners) listener(data); },
        emitExit(exitCode) { for (const listener of terminal.exitListeners) listener({ exitCode }); },
      };
      state.ptys.push(terminal);
      return terminal;
    },
  };

  const childProcess = {
    ...realChildProcess,
    fork(entry, args, forkOptions) {
      const child = Object.assign(new EventEmitter(), {
        entry, args, options: forkOptions, signals: [],
        kill(signal) {
          child.signals.push(signal);
          state.log.push(`backend.kill:${signal}`);
          void state.backend.close().then(() => child.emit('exit', null, signal));
          return true;
        },
      });
      state.forks.push(child);
      state.backend.listen(Number(forkOptions.env.PORT)).catch((error) => state.log.push(`backend.listen:${error.code}`));
      return child;
    },
  };

  return {
    electron,
    modules: {
      electron,
      'node-pty': pty,
      child_process: childProcess,
      'node:child_process': childProcess,
      'fix-path': () => { state.log.push('fix-path'); },
      'electron-devtools-installer/dist/downloadChromeExtension': {
        async downloadChromeExtension() { throw new Error('React DevTools must not be downloaded in tests'); },
      },
    },
  };
}

function writeFiles(base, files = {}) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/**
 * Loads a fresh copy of the main process. `mode`:
 * - 'packaged': an installed app whose bundle has backend/dist/server.js;
 * - 'unbundled': a production launch without that backend (the file:// fallback);
 * - 'dev': ELECTRON_DEV=1, the external Vite renderer and dev backend.
 * The process environment is replaced for the test's duration (no MICHI_*,
 * HOME in a temporary directory); `t.after` restores it and quits the app.
 */
export async function startMain(t, options = {}) {
  assert(!active, 'one main process at a time');
  assert(fs.existsSync(mainEntry), `${path.relative(root, mainEntry)} is missing; run \`npm run electron:build-main\` first`);
  const mode = options.mode ?? 'dev';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-main-lifecycle-'));
  let markReady;
  const state = {
    dir,
    home: path.join(dir, 'home'),
    userData: path.join(dir, 'userData'),
    appPath: path.join(dir, 'app'),
    logDir: path.join(dir, 'logs'),
    ready: new Promise((resolve) => { markReady = resolve; }),
    log: [],
    windows: [],
    views: [],
    focused: null,
    focusedContents: null,
    notifications: [],
    notificationsSupported: true,
    messageBoxes: [],
    messageBoxResponse: 1,
    handlers: new Map(),
    listeners: new Map(),
    switches: new Map(),
    ptys: [],
    forks: [],
    menu: null,
    powerMonitor: new EventEmitter(),
    backend: createBackend(),
  };
  fs.mkdirSync(state.home, { recursive: true });
  fs.mkdirSync(state.userData, { recursive: true });
  writeFiles(state.home, options.homeFiles);
  writeFiles(state.userData, options.userDataFiles);
  if (mode === 'packaged') writeFiles(state.appPath, { 'backend/dist/server.js': '' });
  else fs.mkdirSync(state.appPath, { recursive: true });
  // The dev backend port (also the notification feed's port when no backend is bundled).
  const devBackendPort = await state.backend.listen(0);

  const savedEnv = { ...process.env };
  const savedArgv = [...process.argv];
  for (const key of Object.keys(process.env)) if (SANDBOXED_ENV.test(key)) delete process.env[key];
  Object.assign(process.env, {
    HOME: state.home,
    SHELL: '/bin/sh',
    MICHI_LOG_DIR: state.logDir,
    MICHI_NO_VIBRANCY: '1',
    MICHI_BACKEND_PORT: String(devBackendPort),
    ...(mode === 'dev' ? { ELECTRON_DEV: '1' } : {}),
    ...(typeof options.env === 'function' ? options.env(state) : options.env),
  });

  const timers = new Set();
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function trackedSetTimeout(...args) {
    const timer = realSetTimeout(...args);
    timers.add(timer);
    return timer;
  };
  const writes = { stdout: process.stdout.write, stderr: process.stderr.write };
  for (const stream of ['stdout', 'stderr']) {
    process[stream].write = function quietMainLog(chunk, ...rest) {
      if (typeof chunk === 'string' && ELOG_LINE.test(chunk)) return true;
      return writes[stream].call(this, chunk, ...rest);
    };
  }

  const fakes = createFakes(state, { ...options, mode });
  active = fakes;
  let disposed = false;
  const ctx = {
    /** Mutable test state: focused, notificationsSupported, messageBoxResponse. */
    state,
    electron: fakes.electron,
    backend: state.backend,
    log: state.log,
    windows: state.windows,
    views: state.views,
    notifications: state.notifications,
    messageBoxes: state.messageBoxes,
    handlers: state.handlers,
    listeners: state.listeners,
    switches: state.switches,
    ptys: state.ptys,
    forks: state.forks,
    powerMonitor: state.powerMonitor,
    home: state.home,
    userData: state.userData,
    appPath: state.appPath,
    logDir: state.logDir,
    get menu() { return state.menu; },
    /** Resolves app.whenReady(); the boot sequence then runs. */
    ready() { markReady(); },
    async invoke(channel, sender, ...args) {
      const handler = state.handlers.get(channel);
      assert(handler, `no handler for ${channel}`);
      return handler({ sender }, ...args);
    },
    send(channel, sender, ...args) {
      const listener = state.listeners.get(channel);
      assert(listener, `no listener for ${channel}`);
      listener({ sender }, ...args);
    },
    readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        // Teardown ends the app: confirm "Close anyway" for windows that still
        // run terminals. A confirmed window closes on its own; the quit it
        // cancelled does not resume, so quit again until it completes.
        state.messageBoxResponse = 0;
        fakes.electron.app.quit();
        await waitFor(() => {
          if (state.log.at(-1) === 'app.quit:cancelled' && state.windows.every((win) => win.destroyed)) fakes.electron.app.quit();
          return state.log.at(-1) === 'app.quit:done';
        }, 'the app to quit');
      } finally {
        await state.backend.close();
        for (const timer of timers) clearTimeout(timer);
        globalThis.setTimeout = realSetTimeout;
        process.stdout.write = writes.stdout;
        process.stderr.write = writes.stderr;
        for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
        Object.assign(process.env, savedEnv);
        process.argv.splice(0, process.argv.length, ...savedArgv);
        active = null;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
  t.after(() => ctx.dispose());

  // The launch arguments stay until dispose, as in Electron: main reads them
  // at import and again once the app is ready (startupMode).
  process.argv.push(...(options.argv ?? []));
  for (const id of Object.keys(require.cache)) if (id.startsWith(distDir + path.sep)) delete require.cache[id];
  require(mainEntry);
  if (options.ready !== false) ctx.ready();
  return ctx;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
