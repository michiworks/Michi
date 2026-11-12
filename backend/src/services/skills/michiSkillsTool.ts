import { isValidSkillName } from 'michi-shared';
import { listBuiltinSkills } from './builtin';
import { listSkillFiles, readSkillFolderFile, readSkillMarkdown, SkillFileError } from './files';
import { enabledLibrarySkills } from './library';
import { skillsAvailable } from './paths';

/**
 * michi_skills: the Michi skill library and Michi's built-in skills as a
 * model reads them, on every runtime (MCP for the CLI runtimes, the Crew
 * relay, Pi in process). Only enabled skills are reachable, only files
 * inside a library skill's folder, and only the SKILL.md of a built-in one,
 * which has no folder. Of a library and a built-in skill sharing a name,
 * `name` reads the library's; `builtin: true` reads the other.
 */

export interface MichiSkillsArgs {
  action?: unknown;
  name?: unknown;
  file?: unknown;
  builtin?: unknown;
}

const SOURCE = 'The user\'s Michi skill library and the skills built into Michi: instructions for agents. Follow a skill when the task matches its description; '
  + 'paths in a library skill are relative to baseDir.';

class SkillToolError extends Error {}

function queryMichiSkills(args: MichiSkillsArgs): Record<string, unknown> {
  const action = args.action ?? 'list';
  if (action !== 'list' && action !== 'read') throw new SkillToolError('action must be list or read');
  if (!skillsAvailable()) throw new SkillToolError('The Michi skill library is not available on this backend.');
  const skills = enabledLibrarySkills();
  // A skill with disable-model-invocation is the user's to run, not one to load unasked.
  const builtins = listBuiltinSkills().filter((skill) => skill.enabled && skill.modelInvocable);
  if (action === 'list') {
    return {
      action,
      source: SOURCE,
      skills: [
        ...skills.filter((skill) => skill.modelInvocable).map((skill) => ({
          name: skill.name,
          description: skill.description,
          ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
        })),
        ...builtins.map((skill) => ({
          name: skill.name,
          description: skill.description,
          ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
          builtin: true,
        })),
      ],
    };
  }
  if (typeof args.name !== 'string' || !isValidSkillName(args.name)) throw new SkillToolError('read requires the name of a skill from action=list');
  if (args.builtin !== undefined && typeof args.builtin !== 'boolean') throw new SkillToolError('builtin must be true or false');
  const library = args.builtin === true ? undefined : skills.find((candidate) => candidate.name === args.name);
  const builtin = library ? undefined : builtins.find((candidate) => candidate.name === args.name);
  if (builtin) {
    if (args.file !== undefined && args.file !== 'SKILL.md') throw new SkillToolError(`${builtin.name} is built into Michi and has no files besides its SKILL.md`);
    return { action, source: SOURCE, name: builtin.name, description: builtin.description, builtin: true, file: 'SKILL.md', text: builtin.content, files: [] };
  }
  const skill = library;
  if (!skill) throw new SkillToolError(`No enabled skill named ${args.name}${args.builtin === true ? ' built into Michi' : ''}; use action=list for the skills you can read.`);
  const base = { action, source: SOURCE, name: skill.name, description: skill.description, baseDir: skill.dir };
  if (args.file !== undefined && args.file !== 'SKILL.md') {
    if (typeof args.file !== 'string') throw new SkillToolError('file must be a path relative to the skill folder');
    const { text } = readSkillFolderFile(skill.dir, args.file);
    return { ...base, file: args.file, text };
  }
  const text = readSkillMarkdown(skill.path);
  if (text === null) throw new SkillToolError(`The SKILL.md of ${skill.name} could not be read.`);
  return { ...base, file: 'SKILL.md', text, files: listSkillFiles(skill.dir) };
}

/** Identical content and failure semantics for MCP transports and in-process Pi. */
export function michiSkillsTool(args: MichiSkillsArgs = {}) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(queryMichiSkills(args ?? {})) }] };
  } catch (error) {
    const message = error instanceof SkillToolError || error instanceof SkillFileError
      ? error.message
      : 'The Michi skill library could not be read.';
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
  }
}
