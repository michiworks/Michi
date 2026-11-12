import path from 'node:path';
import {
  parseSkillId,
  readSkillFileInfo,
  type SkillInvocationRequest,
  type SkillMessageMetadata,
} from 'michi-shared';
import type { AgentRuntime, SkillTurnInvocation } from 'michi-runtime';
import { getBuiltinSkill } from './builtin';
import { findListedRuntimeSkill } from './catalog';
import { readSkillMarkdown } from './files';
import { getLibrarySkill } from './library';
import { skillsAvailable } from './paths';

/**
 * invalid_skill: a malformed request (400). skill_not_found: the skill is
 * gone, off or not this chat's to run (404). runtime_unavailable: the
 * runtime could not list its skills just now (503). skills_unavailable:
 * cloud mode (404).
 */
export type SkillInvocationErrorCode = 'invalid_skill' | 'skill_not_found' | 'runtime_unavailable' | 'skills_unavailable';

/** Its message is the sentence the composer shows: "Couldn’t run /name: <reason>." */
export class SkillInvocationError extends Error {
  constructor(readonly code: SkillInvocationErrorCode, message: string) {
    super(message);
    this.name = 'SkillInvocationError';
  }
}

/** The same bound as a message's own text (the JSON body limit is larger). */
const ARGS_MAX = 1024 * 1024;

function cannotRun(code: SkillInvocationErrorCode, name: string, reason: string): SkillInvocationError {
  return new SkillInvocationError(code, `Couldn’t run /${name}: ${reason}.`);
}

/** The `skill` field of a message request, or throws invalid_skill. */
export function parseSkillInvocationRequest(value: unknown): SkillInvocationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SkillInvocationError('invalid_skill', 'skill must be an object');
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !parseSkillId(raw.id)) throw new SkillInvocationError('invalid_skill', 'skill.id is not a skill id');
  if (typeof raw.name !== 'string' || !raw.name) throw new SkillInvocationError('invalid_skill', 'skill.name is required');
  const args = raw.args === undefined ? '' : raw.args;
  if (typeof args !== 'string') throw new SkillInvocationError('invalid_skill', 'skill.args must be a string');
  if (args.length > ARGS_MAX) throw cannotRun('invalid_skill', raw.name, 'the text after its name is too long');
  return { id: raw.id, name: raw.name, args: args.trim() };
}

/** SKILL.md body (no frontmatter), or undefined when the file is missing, too large or unreadable. */
function readSkillBody(file: string): string | undefined {
  const content = readSkillMarkdown(file);
  return content === null ? undefined : readSkillFileInfo(content, path.basename(path.dirname(file))).body;
}

export interface ResolveSkillInvocationInput {
  request: SkillInvocationRequest;
  runtime: Pick<AgentRuntime, 'id' | 'label' | 'listSkills'>;
  /** The folder the chat runs in: runtime skills are listed for it. Null in cloud mode or without a workspace. */
  cwd: string | null;
  ownerUserId?: string | null;
}

/**
 * The skill a message runs, resolved from the backend's own catalog (the
 * listing the / menu came from): an enabled library or built-in skill, a skill the
 * chat's runtime lists for the cwd, or a command its live session
 * advertised (run by name only). Skills the menu leaves out (off, or not
 * `user-invocable`) do not run. Paths and bodies come from here, never from
 * the request.
 */
export async function resolveSkillInvocation(input: ResolveSkillInvocationInput): Promise<SkillTurnInvocation> {
  const { request, runtime } = input;
  const parsed = parseSkillId(request.id);
  if (!parsed) throw new SkillInvocationError('invalid_skill', 'skill.id is not a skill id');
  // Fail closed for every kind, live commands included: cloud mode has no skills.
  if (!skillsAvailable()) throw cannotRun('skills_unavailable', request.name, 'this Michi server has no skills');
  if (parsed.kind === 'library') {
    const skill = getLibrarySkill(parsed.name);
    const body = skill ? readSkillBody(skill.path) : undefined;
    if (!skill || body === undefined) throw cannotRun('skill_not_found', request.name, 'it’s no longer in your skill library');
    if (!skill.enabled) throw cannotRun('skill_not_found', request.name, 'it’s turned off in Settings › Skills');
    if (!skill.userInvocable) throw cannotRun('skill_not_found', request.name, 'only the model may use it');
    return { id: request.id, name: skill.name, origin: 'library', path: skill.path, body, args: request.args };
  }
  if (parsed.kind === 'builtin') {
    const skill = getBuiltinSkill(parsed.name);
    if (!skill) throw cannotRun('skill_not_found', request.name, 'this Michi has no such built-in skill');
    if (!skill.enabled) throw cannotRun('skill_not_found', request.name, 'it’s turned off in Settings › Skills');
    if (!skill.userInvocable) throw cannotRun('skill_not_found', request.name, 'only the model may use it');
    // No path: built-in skills have no folder a runtime could read.
    return { id: request.id, name: skill.name, origin: 'builtin', body: skill.body, args: request.args };
  }
  if (parsed.runtimeId !== runtime.id) {
    throw cannotRun('skill_not_found', request.name, `it’s a skill of another runtime, not ${runtime.label}`);
  }
  if (parsed.kind === 'live') {
    return { id: request.id, name: request.name, origin: 'runtime', nativeName: parsed.nativeName, args: request.args };
  }
  if (!runtime.listSkills || !input.cwd) throw cannotRun('skill_not_found', request.name, `${runtime.label} lists no skills here`);
  let match;
  try {
    match = await findListedRuntimeSkill(runtime, { cwd: input.cwd, ownerUserId: input.ownerUserId ?? null }, request.id);
  } catch (error) {
    throw cannotRun('runtime_unavailable', request.name, `${runtime.label} couldn’t list its skills (${(error as Error).message})`);
  }
  if (!match || match.enabled === false || match.userInvocable === false) {
    throw cannotRun('skill_not_found', request.name, 'it’s no longer available');
  }
  const body = match.path ? readSkillBody(match.path) : undefined;
  // A listing can outlive the file it names; without it the skill would run as bare text.
  if (match.path && body === undefined) throw cannotRun('skill_not_found', request.name, 'its SKILL.md is gone');
  return {
    id: request.id,
    name: match.name,
    origin: 'runtime',
    ...(match.nativeName ? { nativeName: match.nativeName } : {}),
    ...(match.path ? { path: match.path } : {}),
    ...(body !== undefined ? { body } : {}),
    args: request.args,
  };
}

/** What the user message keeps of the skill it ran. */
export function skillMessageMetadata(skill: SkillTurnInvocation, runtimeId: string): SkillMessageMetadata {
  return {
    id: skill.id,
    name: skill.name,
    origin: skill.origin,
    ...(skill.origin === 'runtime' ? { runtimeId } : {}),
    args: skill.args,
  };
}
