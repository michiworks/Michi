import { readSkillFileInfo } from 'michi-shared';
import { COMPARE_SKILL } from './builtin/compare';
import { skillsAvailable } from './paths';
import { disabledBuiltinSkills } from './state';

/**
 * Skills that ship with Michi. Their SKILL.md is compiled into the backend,
 * so no file is read (a packaged app keeps the backend inside app.asar,
 * which runtime CLIs cannot open) and none is mounted: every runtime gets
 * the body through Michi's expansion, which is why they run by / only, and
 * a library or runtime skill of the same name is a different skill beside
 * them. Each can be turned off in skills-state.json; none can be edited.
 */

const DEFAULT_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ['compare', COMPARE_SKILL],
];
let sources = DEFAULT_SOURCES;

export interface BuiltinSkill {
  name: string;
  description: string;
  argumentHint?: string;
  userInvocable: boolean;
  modelInvocable: boolean;
  /** Off while skills-state.json cannot be read, as library skills are. */
  enabled: boolean;
  /** The whole SKILL.md. */
  content: string;
  /** SKILL.md without its frontmatter. */
  body: string;
}

function toBuiltinSkill(name: string, content: string, disabled: ReadonlySet<string> | null): BuiltinSkill {
  const info = readSkillFileInfo(content, name);
  return {
    name,
    description: info.description,
    ...(info.argumentHint ? { argumentHint: info.argumentHint } : {}),
    userInvocable: info.userInvocable,
    modelInvocable: info.modelInvocable,
    enabled: disabled !== null && !disabled.has(name),
    content,
    body: info.body,
  };
}

/** Every built-in skill, on or off. Empty in cloud mode, which keeps no skill settings. */
export function listBuiltinSkills(): BuiltinSkill[] {
  if (!skillsAvailable()) return [];
  const disabled = disabledBuiltinSkills();
  return sources.map(([name, content]) => toBuiltinSkill(name, content, disabled));
}

export function getBuiltinSkill(name: string): BuiltinSkill | null {
  return listBuiltinSkills().find((skill) => skill.name === name) ?? null;
}

/**
 * Test hook: other built-in skills (name, SKILL.md), none with [], or the
 * shipped ones again without an argument.
 * @testonly
 */
export function setBuiltinSkillsForTests(next?: ReadonlyArray<readonly [string, string]>): void {
  sources = next ?? DEFAULT_SOURCES;
}
