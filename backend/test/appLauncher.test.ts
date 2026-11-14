/**
 * The backend's one launcher (scheduledJobs/appLauncher.ts, DESIGN-v2 §5.1):
 * only the macOS background service wakes the app, with `open -g -j`, passing
 * on the service's data and config directories, at most once a minute. What
 * wakes it, and when, is the attention service's (attentionService.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_LAUNCH_ARG, createDesktopAppLauncher } from '../src/services/scheduledJobs/appLauncher';

const MINUTE = 60_000;

test('one wake a minute, with the service\'s directories, each as one argument', () => {
  let now = 1_000_000;
  const opens: string[][] = [];
  const launcher = createDesktopAppLauncher({
    bundlePath: '/Applications/Michi.app', enabled: true, platform: 'darwin', clock: () => now, exists: () => true,
    env: { MICHI_DATA_DIR: '/Users/me/.michi data', MICHI_CONFIG_DIR: '/Users/me/.michi-config', HOME: '/Users/me', MICHI_CLOUD: '' },
    exec: (file, args, callback) => { opens.push([file, ...args]); callback(null); },
  });
  assert.equal(launcher.wake(), true);
  assert.deepEqual(opens, [['/usr/bin/open', '-g', '-j', '--env', 'MICHI_DATA_DIR=/Users/me/.michi data', '--env', 'MICHI_CONFIG_DIR=/Users/me/.michi-config',
    '/Applications/Michi.app', '--args', BACKGROUND_LAUNCH_ARG]], 'only the two directories are passed on');
  now += 20_000;
  assert.equal(launcher.wake(), false);
  now += MINUTE;
  assert.equal(launcher.wake(), true);
  assert.equal(opens.length, 2);
});

test('without directories to pass on, open gets none; a value it cannot carry is left out', () => {
  const opens: string[][] = [];
  const launcher = (env: Record<string, string | undefined>) => createDesktopAppLauncher({
    bundlePath: '/Applications/Michi.app', enabled: true, platform: 'darwin', clock: () => 1, exists: () => true, env,
    exec: (file, args, callback) => { opens.push([file, ...args]); callback(null); },
  });
  launcher({}).wake();
  launcher({ MICHI_DATA_DIR: '/a\nb', MICHI_CONFIG_DIR: '' }).wake();
  assert.deepEqual(opens, [
    ['/usr/bin/open', '-g', '-j', '/Applications/Michi.app', '--args', BACKGROUND_LAUNCH_ARG],
    ['/usr/bin/open', '-g', '-j', '/Applications/Michi.app', '--args', BACKGROUND_LAUNCH_ARG],
  ]);
});

test('anywhere but the macOS service it never launches', () => {
  const opens: string[][] = [];
  const exec = (file: string, args: string[], callback: (error: Error | null) => void) => { opens.push([file, ...args]); callback(null); };
  assert.equal(createDesktopAppLauncher({ bundlePath: '/Applications/Michi.app', enabled: false, platform: 'darwin', exists: () => true, exec }).wake(), false);
  assert.equal(createDesktopAppLauncher({ bundlePath: '/Applications/Michi.app', enabled: true, platform: 'linux', exists: () => true, exec }).wake(), false);
  assert.deepEqual(opens, []);
});
