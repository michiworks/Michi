import fs from 'node:fs';
import path from 'node:path';
import { SKILL_LIBRARY_FOLDER_NAME } from 'michi-shared';
import { log } from '../logger';
import { enabledLibrarySkills, type LibrarySkill } from './library';
import { skillMountsRoot, skillsAvailable } from './paths';

/**
 * Mounts: generated folders that show a runtime the library's enabled
 * skills, as links to the library folders, laid out the way that runtime
 * loads skills. Their paths never change, so spawn arguments that name
 * them stay identical (warm pools); only the links inside change.
 *
 * - claude-add-dir: a folder named `michi` with `.claude/skills/<name>`,
 *   an additional directory of every Claude session (SDK
 *   `additionalDirectories`). Its skills keep their names; one whose name a
 *   personal or project skill already has is `michi:<name>` inside Claude.
 *   One named like a personal command is left out (michiClaudeOptions.ts).
 * - kiro-workspace: a folder with `.kiro/skills/<name>`, for a Kiro
 *   session's additional directories.
 * - flat: `<root>/<name>/SKILL.md`, for Codex's extra skill roots.
 *
 * Pi takes the enabled library folders themselves (librarySkillDirs). Kiro
 * V2, Crew and Antigravity get no mount, only the michi_skills tool.
 *
 * A mount holds only what Michi puts there: every sync removes anything
 * else, and runtimes sync their mount when a session starts. A runtime
 * loads everything in a mount in every session, so a file an agent planted
 * there (a Kiro AGENTS.md or steering file, Claude settings, another skill)
 * would otherwise reach every chat in every workspace. The folders stay
 * writable so that deleting the data directory (rm -rf) keeps working.
 */
export type SkillMountLayout = 'claude-add-dir' | 'kiro-workspace' | 'flat';

interface MountKey { runtimeId: string; layout: SkillMountLayout }

export interface SkillMountOptions {
  /**
   * Names a mounted skill would take from something of the runtime's own
   * (Claude: the user's own commands, which a skill of their name hides).
   * Read at every sync; those skills stay out and run through Michi's
   * expansion.
   */
  leaveOut?: () => Iterable<string>;
}

interface MountRequest extends MountKey, SkillMountOptions {}

const requested = new Map<string, MountRequest>();

function keyOf(mount: MountKey): string {
  return `${mount.runtimeId}\u0000${mount.layout}`;
}

function rootOf(mount: MountKey): string {
  if (mount.layout === 'claude-add-dir') return path.join(skillMountsRoot(), mount.runtimeId, SKILL_LIBRARY_FOLDER_NAME);
  return path.join(skillMountsRoot(), mount.layout === 'kiro-workspace' ? `${mount.runtimeId}-workspace` : mount.runtimeId);
}

function skillsDirOf(mount: MountKey, root: string): string {
  if (mount.layout === 'claude-add-dir') return path.join(root, '.claude', 'skills');
  if (mount.layout === 'kiro-workspace') return path.join(root, '.kiro', 'skills');
  return root;
}

function linkTarget(entry: string): string | null {
  try { return fs.readlinkSync(entry); } catch { return null; }
}

/** Directory links: junctions on Windows, which need no privilege. */
function linkDirectory(target: string, entry: string): void {
  fs.symlinkSync(target, entry, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Whether a mount may carry a skill. Claude honours
 * `disable-model-invocation` itself; Codex and Kiro would offer such a skill
 * to their model, so their mounts leave it out (it still runs by slash,
 * through Michi's own expansion).
 */
function mountCarries(mount: MountKey, skill: LibrarySkill): boolean {
  return mount.layout === 'claude-add-dir' || skill.modelInvocable;
}

/** The folders Michi owns in a mount, outermost first, with the entries each may hold (null: only skill links). */
function managedFolders(mount: MountKey, root: string): Array<{ dir: string; allowed: readonly string[] | null }> {
  if (mount.layout === 'claude-add-dir') {
    return [
      { dir: path.dirname(root), allowed: [SKILL_LIBRARY_FOLDER_NAME] },
      { dir: root, allowed: ['.claude'] },
      { dir: path.join(root, '.claude'), allowed: ['skills'] },
      { dir: path.join(root, '.claude', 'skills'), allowed: null },
    ];
  }
  if (mount.layout === 'kiro-workspace') {
    return [
      { dir: root, allowed: ['.kiro'] },
      { dir: path.join(root, '.kiro'), allowed: ['skills'] },
      { dir: path.join(root, '.kiro', 'skills'), allowed: null },
    ];
  }
  return [{ dir: root, allowed: null }];
}

/**
 * A managed folder as a folder of its own. One replaced by a link (or a
 * junction) loses the link: pruning through it would empty, and then link
 * skills into, whatever it points to.
 */
function ensureFolder(dir: string): void {
  let stat: fs.Stats | null = null;
  try { stat = fs.lstatSync(dir); } catch { /* created below */ }
  if (stat?.isDirectory()) return;
  if (stat) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function syncMount(mount: MountRequest): string {
  const root = rootOf(mount);
  const folders = managedFolders(mount, root);
  for (const { dir } of folders) ensureFolder(dir);
  const leftOut = new Set(mount.leaveOut?.() ?? []);
  const wanted = new Map(enabledLibrarySkills().filter((skill) => mountCarries(mount, skill) && !leftOut.has(skill.name))
    .map((skill) => [skill.name, skill.dir]));
  for (const { dir, allowed } of folders) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      // rmSync removes a link itself, never what it points to.
      if (allowed) {
        if (!allowed.includes(entry)) fs.rmSync(full, { recursive: true, force: true });
      } else if (wanted.get(entry) !== linkTarget(full)) {
        // Skill folders: only links to the skills this runtime gets.
        fs.rmSync(full, { recursive: true, force: true });
      }
    }
  }
  const skillsDir = skillsDirOf(mount, root);
  for (const [name, dir] of wanted) {
    if (linkTarget(path.join(skillsDir, name)) !== dir) linkDirectory(dir, path.join(skillsDir, name));
  }
  return root;
}

/**
 * The mount root to pass to a runtime, kept in step with the library from
 * now on, or null in cloud mode. Errors leave the runtime without library
 * skills rather than failing its session.
 */
export function skillMountRoot(runtimeId: string, layout: SkillMountLayout, options: SkillMountOptions = {}): string | null {
  if (!skillsAvailable()) return null;
  const mount = { runtimeId, layout, ...options };
  requested.set(keyOf(mount), mount);
  try {
    return syncMount(mount);
  } catch (error) {
    log.warn('workspace', 'could not prepare a skill mount', { runtimeId, layout, error: (error as Error).message });
    return null;
  }
}

/** Bring every mount a runtime asked for up to date with the library. */
export function syncSkillMounts(): void {
  if (!skillsAvailable()) return;
  for (const mount of requested.values()) {
    try { syncMount(mount); }
    catch (error) {
      log.warn('workspace', 'could not update a skill mount', { runtimeId: mount.runtimeId, layout: mount.layout, error: (error as Error).message });
    }
  }
}

/** The enabled library skill folders, for runtimes that take a list of skill folders (Pi). */
export function librarySkillDirs(): string[] {
  if (!skillsAvailable()) return [];
  return enabledLibrarySkills().map((skill) => skill.dir);
}

/**
 * Test hook: forget requested mounts.
 * @testonly
 */
export function resetSkillMountsForTests(): void {
  requested.clear();
}
