/**
 * server.ts's first import. The desktop app forwards ~/.michi/.env into the
 * backend it forks; the macOS background service is started by launchd
 * instead, so it reads the file here, before any module reads its settings
 * at import (MICHI_CONFIG_DIR, MICHI_DEFAULT_RUNTIME, the Kiro pool knobs).
 * The rules are the app's (electron/backgroundService.ts desktopBackendEnv),
 * and so is the parser: existing values win, and the remote token and the
 * dev-renderer keys are dropped, since the service is the installed app's
 * loopback backend.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

const DROPPED_KEYS = ['MICHI_REMOTE_TOKEN', 'MICHI_DEV_RENDERER', 'MICHI_RENDERER_URL'];

export function loadMichiDotenv(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): void {
  let content: string;
  try {
    content = fs.readFileSync(path.join(home, '.michi', '.env'), 'utf8');
  } catch {
    content = '';
  }
  for (const [key, value] of Object.entries(parseEnv(content))) {
    if (!Object.hasOwn(env, key)) env[key] = value;
  }
  for (const key of DROPPED_KEYS) delete env[key];
}

if (process.env.MICHI_SERVICE_MODE === '1') loadMichiDotenv();
