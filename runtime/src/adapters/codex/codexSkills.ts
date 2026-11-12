import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeSkill, RuntimeSkillListing, SkillTurnInvocation } from '../../contract/types';
import type { CodexSkill, CodexSkillsListing } from './codexProtocol';
import { isWithinRoot } from '../../core/pathSandbox';

/**
 * A `{type:'skill'}` turn input. app-server matches it to a listed skill by
 * path and injects that SKILL.md; one whose path is outside every skill
 * root, missing or disabled is dropped without an error.
 */
export interface CodexSkillInput {
  name: string;
  path: string;
}

function isInside(file: string, folder: string): boolean {
  return path.relative(folder, file) !== '' && isWithinRoot(file, folder);
}

async function realpathOrNull(target: string): Promise<string | null> {
  try { return await fs.realpath(target); } catch { return null; }
}

/**
 * Where the host's own skills live: each root, and the real folder behind
 * each entry of it. app-server reports a skill in a linked folder by its
 * real path, and the host's mounts are links to its library folders.
 */
export async function hostSkillFolders(roots: readonly string[]): Promise<string[]> {
  const folders: string[] = [];
  for (const root of roots) {
    folders.push(root);
    const real = await realpathOrNull(root);
    if (real && real !== root) folders.push(real);
    let entries: string[];
    try { entries = await fs.readdir(root); } catch { continue; }
    for (const entry of entries) {
      const target = await realpathOrNull(path.join(root, entry));
      if (target) folders.push(target);
    }
  }
  return folders;
}

/** One Codex skill for the host; a plugin skill (`Plugin:skill`) keeps that as its native name. */
function codexRuntimeSkill(skill: CodexSkill): RuntimeSkill {
  const colon = skill.name.lastIndexOf(':');
  const name = colon > 0 && colon < skill.name.length - 1 ? skill.name.slice(colon + 1) : skill.name;
  const managedBy = skill.pluginId || name !== skill.name ? 'Codex plugin'
      : skill.scope === 'system' ? 'Codex' : undefined;
  return {
    name,
    description: skill.description || skill.shortDescription || '',
    ...(name !== skill.name ? { nativeName: skill.name } : {}),
    path: skill.path,
    ...(skill.scope ? { scope: skill.scope } : {}),
    ...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
    ...(managedBy ? { managedBy } : {}),
    enabled: skill.enabled,
  };
}

/**
 * listSkills' answer from app-server's listing, without the host's own
 * skills (under `hostFolders`), which the host lists itself. Two skills
 * with the same scope and name would share one catalog id; the first wins.
 */
export function codexRuntimeSkills(listing: CodexSkillsListing, hostFolders: readonly string[]): RuntimeSkillListing {
  const isHost = (file: string) => hostFolders.some((folder) => isInside(file, folder));
  const skills: RuntimeSkill[] = [];
  const ids = new Set<string>();
  for (const entry of listing.skills) {
    if (isHost(entry.path)) continue;
    const skill = codexRuntimeSkill(entry);
    const id = `${skill.scope ?? ''}\u0000${skill.nativeName ?? skill.name}`;
    if (ids.has(id)) continue;
    ids.add(id);
    skills.push(skill);
  }
  const errors = listing.errors
    .filter((error) => !error.path || !isHost(error.path))
    .map((error) => (error.path ? `${error.path}: ${error.message}` : error.message));
  return { skills, ...(errors.length ? { errors } : {}) };
}

/**
 * The input that runs `skill` natively, or null when app-server would drop
 * it: only a skill this listing has enabled gets one. A library skill is
 * sent at its mount path `<root>/<name>/SKILL.md`; app-server resolves that
 * to the linked folder it listed.
 */
export async function codexSkillInput(
  skill: SkillTurnInvocation,
  listing: CodexSkillsListing,
  roots: readonly string[],
): Promise<CodexSkillInput | null> {
  // The host's built-in skills are never mounted, so app-server has none of them.
  if (skill.origin === 'builtin') return null;
  const listed = (file: string) => listing.skills.find((entry) => entry.enabled && entry.path === file);
  if (skill.origin === 'library') {
    if (!/^[^/\\]+$/.test(skill.name) || skill.name === '.' || skill.name === '..') return null;
    for (const root of roots) {
      const mounted = path.join(root, skill.name, 'SKILL.md');
      const real = await realpathOrNull(mounted);
      const entry = real ? listed(real) ?? listed(mounted) : undefined;
      if (entry) return { name: entry.name, path: mounted };
    }
    return null;
  }
  const entry = skill.path ? listed(skill.path) : undefined;
  return entry ? { name: entry.name, path: entry.path } : null;
}

/** `$name`, which app-server also resolves in the text (case-sensitive), when the name can be written that way. */
export function codexSkillMention(name: string): string | null {
  return /^[\w:-]+$/.test(name) ? `$${name}` : null;
}
