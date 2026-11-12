import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ClaudeAdapterOptions } from './claudeAdapterOptions';
import { claudeConfigRoot } from './claudeBinary';

/**
 * What locates the profile of the claude processes the adapter spawns: the
 * adapter's options (its configDir, the environment children inherit, and
 * whether the host keeps each user's history apart).
 */
export type ClaudeProfileOptions = Pick<ClaudeAdapterOptions, 'host' | 'spawnEnv' | 'configDir'>;

/** Base config dir of the claude processes the adapter spawns, where their JSONL transcripts are. */
export function claudeConfigBase(options: ClaudeProfileOptions): string {
  return claudeConfigRoot(options.configDir?.(), options.spawnEnv());
}

/** Longest project directory name the CLI writes before it cuts the name and adds a hash. */
const MAX_SLUG = 200;

/** The CLI's hash of a long path (Java's String.hashCode). */
function pathHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}

/**
 * Claude's project directory name for a cwd. It encodes punctuation too,
 * including underscores in macOS temp paths; past 200 characters the CLI
 * keeps the first 200 and adds a base-36 hash of the whole path.
 */
export function claudeProjectSlug(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= MAX_SLUG) return slug;
  return `${slug.slice(0, MAX_SLUG)}-${Math.abs(pathHash(cwd)).toString(36)}`;
}

/**
 * Returns the directory where Claude stores its project JSONL history files.
 *
 * When the host enforces user ownership (Michi: cloud mode) a per-user
 * prefix is inserted so two users sharing the same cwd slug do not collide
 * on each other's history:
 *   <configDir>/projects/<userId>/<slug>/
 *
 * Otherwise (Michi's desktop) the path is unchanged:
 *   <configDir>/projects/<slug>/
 */
export function getClaudeProjectsDir(options: ClaudeProfileOptions, cwd: string, userId?: string | null): string {
  const slug = claudeProjectSlug(cwd);
  if (options.host.principal.enforceUserOwnership() && userId) {
    return path.join(claudeConfigBase(options), 'projects', userId, slug);
  }
  return path.join(claudeConfigBase(options), 'projects', slug);
}

export function getClaudeJsonlPath(options: ClaudeProfileOptions, cwd: string, claudeSessionId: string, userId?: string | null): string {
  return path.join(getClaudeProjectsDir(options, cwd, userId), `${claudeSessionId}.jsonl`);
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether `claude --resume <id>` from `cwd` can find the session's
 * transcript: in the cwd's project directory (the cwd as given, or with its
 * symlinks resolved, which is how the CLI sees it), or else in another
 * project directory, which the CLI's own fallback scan finds (Claude Code
 * 2.1: a session moved with its cwd still resumes). False, no transcript in
 * any project directory, is positive evidence that the native session is gone.
 *
 * Both layouts are searched: Michi's (with cloud mode's per-user segment,
 * getClaudeProjectsDir) and the CLI's own `<config>/projects`, which is where
 * the CLI writes whatever Michi's layout says (a claude child gets only
 * CLAUDE_CONFIG_DIR, claudeChildEnv).
 */
export async function claudeTranscriptFindable(options: ClaudeProfileOptions, cwd: string, claudeSessionId: string, userId?: string | null): Promise<boolean> {
  const file = `${claudeSessionId}.jsonl`;
  const cwds = new Set([cwd]);
  try {
    cwds.add(await fs.promises.realpath(cwd));
  } catch { /* a cwd that no longer exists still names its project directory */ }
  const roots = [...new Set([path.dirname(getClaudeProjectsDir(options, cwd, userId)), path.join(claudeConfigBase(options), 'projects')])];
  for (const root of roots) {
    for (const dir of cwds) {
      if (await isFile(path.join(root, claudeProjectSlug(dir), file))) return true;
    }
  }
  for (const root of roots) {
    let names: string[];
    try {
      names = (await fs.promises.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of names) {
      if (await isFile(path.join(root, name, file))) return true;
    }
  }
  return false;
}

/** A native id the CLI mints (`system/init` session_id): a UUID, nothing that could name a path. */
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `child` names an entry strictly inside `parent` (not `parent` itself, nothing above it). */
function strictlyInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(path.sep);
}

/**
 * Removes what the CLI kept on disk for one released session
 * (AgentRuntime.discardNativeSession, DESIGN-v2 §3.2): in the cwd's project
 * directory `<id>.jsonl` and the `<id>/` subagent directory, and
 * `<config>/session-env/<id>/`. Nothing else: not the project directory,
 * not another session's files. The project directory is the cwd's as given
 * and with its symlinks resolved (the CLI writes under the latter), in
 * Michi's layout and the CLI's own (claudeTranscriptFindable).
 *
 * `unsupported` when the id is not a UUID or the cwd is not absolute (the
 * paths could not be vouched for), and nothing is removed; `absent` when
 * there was nothing; `discarded` otherwise.
 */
export async function discardClaudeNativeFiles(
  options: ClaudeProfileOptions,
  input: { cwd: string; nativeSessionId: string | null; ownerUserId?: string | null },
): Promise<'discarded' | 'absent' | 'unsupported'> {
  const id = input.nativeSessionId;
  if (id === null || id === undefined) return 'absent';
  if (typeof id !== 'string' || !CLAUDE_SESSION_ID.test(id)) return 'unsupported';
  if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) return 'unsupported';
  const cwds = new Set([path.resolve(input.cwd)]);
  try { cwds.add(await fs.promises.realpath(input.cwd)); } catch { /* a removed cwd still names its project directory */ }
  const base = claudeConfigBase(options);
  const projectDirs = new Set<string>();
  for (const cwd of cwds) {
    projectDirs.add(getClaudeProjectsDir(options, cwd, input.ownerUserId));
    projectDirs.add(path.join(base, 'projects', claudeProjectSlug(cwd)));
  }
  const targets: Array<{ parent: string; entry: string }> = [];
  for (const dir of projectDirs) {
    targets.push({ parent: dir, entry: path.join(dir, `${id}.jsonl`) }, { parent: dir, entry: path.join(dir, id) });
  }
  const sessionEnv = path.join(base, 'session-env');
  targets.push({ parent: sessionEnv, entry: path.join(sessionEnv, id) });
  // Every path is checked before anything is removed: each entry directly in
  // its directory, each project directory below `<config>/projects`.
  const projectsRoot = path.join(base, 'projects');
  const below = (root: string, dir: string) => {
    const relative = path.relative(path.resolve(root), path.resolve(dir));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  if (![...projectDirs].every((dir) => below(projectsRoot, dir))) return 'unsupported';
  if (!targets.every(({ parent, entry }) => strictlyInside(parent, entry))) return 'unsupported';
  let removed = false;
  for (const { entry } of targets) {
    let exists = true;
    try { await fs.promises.lstat(entry); } catch { exists = false; }
    if (!exists) continue;
    await fs.promises.rm(entry, { recursive: true, force: true });
    removed = true;
  }
  return removed ? 'discarded' : 'absent';
}
