import path from 'node:path';
import { getMichiConfigPaths } from '../configPaths';
import { getMichiDataDir } from '../dataDir';

/**
 * Where the Michi skill library and its runtime mounts live.
 *
 * The library is the user's own content, beside config.json in the selected
 * profile (~/.michi/skills; ~/.michi-dev/skills in development). Mounts are
 * generated, disposable views of it that runtimes load (a Claude additional
 * folder, a Kiro workspace root, a flat root), under the data directory.
 */

/** Cloud mode has no per-owner filesystem, so it keeps no library and lists no host skills. */
export function skillsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MICHI_CLOUD !== '1';
}

export function skillLibraryRoot(): string {
  return path.join(getMichiConfigPaths().configDir, 'skills');
}

/** Which library skills are off (state.ts). */
export function skillStatePath(): string {
  return path.join(getMichiConfigPaths().configDir, 'skills-state.json');
}

export function skillMountsRoot(): string {
  return path.join(getMichiDataDir(), 'skill-mounts');
}
