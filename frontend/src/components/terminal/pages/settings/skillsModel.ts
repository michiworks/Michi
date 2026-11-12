import { useEffect, useState } from 'react';
import {
  isValidSkillName, SKILL_DESCRIPTION_MAX, type SkillCatalogResponse, type SkillRuntimeInfo, type SkillSummary,
} from 'michi-shared';
import { listSkills, SKILLS_CHANGED_EVENT } from '../../../../services/api/skills';

/** The library first, then Michi's built-in skills, then each runtime the backend reports. */
export const LIBRARY = 'library';
export const BUILTIN = 'builtin';

export function errorText(error: unknown): string {
  return (error instanceof Error && error.message ? error.message : 'the request failed').replace(/\.$/, '');
}

/**
 * The runtimes the page names, in the backend's order, with the backend's
 * labels. A runtime a skill or an error names that the list lacks (an
 * older backend sends no list) keeps its id as its label.
 */
export function catalogRuntimes(catalog: SkillCatalogResponse): SkillRuntimeInfo[] {
  const runtimes = [...(catalog.runtimes ?? [])];
  const named = [...catalog.skills.map((skill) => skill.runtimeId), ...catalog.errors.map((error) => error.runtimeId)];
  for (const id of named) {
    if (id && !runtimes.some((runtime) => runtime.id === id)) runtimes.push({ id, label: id, available: true });
  }
  return runtimes;
}

/** The library's folder, from where its skills are (`<root>/<name>/SKILL.md`). */
export function libraryRoot(skills: readonly SkillSummary[]): string | null {
  const path = skills.find((skill) => skill.origin === LIBRARY && skill.path)?.path;
  return path ? path.replace(/[\\/][^\\/]+[\\/]SKILL\.md$/, '') : null;
}

/** "Plugin · <package>", "User · Plugin", "Plugin": where a runtime keeps the skill. */
export function scopeLabel(skill: Pick<SkillSummary, 'scope' | 'pluginId' | 'managedBy'>): string {
  if (skill.scope === 'plugin') {
    const plugin = skill.pluginId?.replace(/@[^@]*$/, '');
    return plugin ? `Plugin · ${plugin}` : 'Plugin';
  }
  const scope = skill.scope ?? '';
  const owner = skill.managedBy;
  if (owner && owner.toLowerCase() === scope.toLowerCase()) return owner;
  return [scope && scope[0].toUpperCase() + scope.slice(1), owner].filter(Boolean).join(' · ');
}

/** Every word of the query is in the skill's name, command, description or scope. */
export function skillMatches(skill: SkillSummary, query: string): boolean {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [skill.name, skill.nativeName, skill.description, skill.origin === 'runtime' ? scopeLabel(skill) : ''].join(' ').toLocaleLowerCase();
  return words.every((word) => text.includes(word));
}

/** Why `name` can't name a library skill, or null. `taken`: the names already in the library. */
export function nameProblem(name: string, taken: ReadonlySet<string>): string | null {
  if (!name) return 'Give the skill a name.';
  if (!isValidSkillName(name)) return 'Use lowercase letters, digits and single hyphens, up to 64 characters.';
  if (taken.has(name)) return `A skill named ${name} is already in your library.`;
  return null;
}

export interface SkillDraft {
  name: string;
  description: string;
  argumentHint: string;
  body: string;
}

export type DraftField = keyof SkillDraft;

/** What each field of the form needs before it saves; `taken` is null when the name is not edited. */
export function draftProblems(draft: SkillDraft, taken: ReadonlySet<string> | null): Partial<Record<DraftField, string>> {
  const problems: Partial<Record<DraftField, string>> = {};
  const name = taken && nameProblem(draft.name.trim(), taken);
  if (name) problems.name = name;
  const description = draft.description.trim();
  if (!description) problems.description = 'Add a description: agents use it to decide when this skill fits.';
  else if (description.length > SKILL_DESCRIPTION_MAX) problems.description = 'Keep the description under 1,024 characters.';
  if (!draft.body.trim()) problems.body = 'Write the instructions the agent should follow.';
  return problems;
}

/** How many skills this machine's library holds, for the phone's Settings list; null while unknown. */
export function useLibrarySkillCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      listSkills({ signal: mine.signal })
        .then((catalog) => { if (!mine.signal.aborted) setCount(catalog.libraryAvailable ? catalog.skills.filter((skill) => skill.origin === LIBRARY).length : null); })
        .catch(() => { if (!mine.signal.aborted) setCount(null); });
    };
    load();
    window.addEventListener(SKILLS_CHANGED_EVENT, load);
    return () => { window.removeEventListener(SKILLS_CHANGED_EVENT, load); controller?.abort(); };
  }, []);
  return count;
}
