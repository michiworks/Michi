// The `turn/start` request CodexSession.send builds for a turn, and what it
// reads from the result. Pure; the session decides the policy, the text and
// when the request goes out.
import type { SkillTurnInvocation } from '../../contract/types';
import { buildCodexCollaborationMode, isCodexModeKind } from './codexProtocol';
import type { CodexSkillInput } from './codexSkills';

/** `turn/start` input: the model's text, the skill Codex runs natively, then the images. */
export function codexTurnInput(
  text: string,
  skill: CodexSkillInput | null | undefined,
  images: ReadonlyArray<{ absPath: string }>,
): Array<Record<string, unknown>> {
  return [
    { type: 'text', text },
    ...(skill ? [{ type: 'skill', name: skill.name, path: skill.path }] : []),
    ...images.map((img) => ({ type: 'localImage', path: img.absPath })),
  ];
}

/**
 * The `serviceTier` a turn asks for: the chat's tier when its model lists it,
 * else standard (`default`), so a tier in the user's Codex config cannot apply
 * unseen. Undefined, which leaves Codex's config in charge, for an owner with
 * no choice (not a chat) and for a model that lists no tiers.
 */
export function codexTurnServiceTier(chosen: string | null | undefined, offered: readonly string[]): string | undefined {
  if (chosen === undefined || offered.length === 0) return undefined;
  return chosen !== null && offered.includes(chosen) ? chosen : 'default';
}

/**
 * `turn/start` params: the turn's approval and sandbox policy, then the thread,
 * input, effort, speed tier and, once the session chose one, its collaboration mode.
 */
export function codexTurnStartParams(turn: {
  policy: object;
  threadId: string;
  input: Array<Record<string, unknown>>;
  effort: string | null;
  serviceTier?: string;
  modeId: string | null;
  modelId: string | null;
}): Record<string, unknown> {
  return {
    ...turn.policy,
    threadId: turn.threadId,
    input: turn.input,
    ...(turn.effort ? { effort: turn.effort } : {}),
    // Codex keeps it for the thread's later turns too; every turn sends its own.
    ...(turn.serviceTier ? { serviceTier: turn.serviceTier } : {}),
    ...(isCodexModeKind(turn.modeId) && turn.modelId
      ? { collaborationMode: buildCodexCollaborationMode(turn.modeId, turn.modelId, turn.effort) }
      : {}),
    summary: 'detailed',
  };
}

/** The native turn id a `turn/start` result names, if any. */
export function codexStartedTurnId(result: unknown): string | undefined {
  const payload = result as { turn?: { id?: string }; turnId?: string } | null;
  return payload?.turn?.id ?? payload?.turnId;
}

/** The user text the pre-turn title thread gets. */
export function codexTitleText(skill: SkillTurnInvocation | undefined, text: string): string {
  // A skill turn is titled from the command the user typed; `$name` would run the skill in the title thread.
  return skill ? `/${skill.nativeName ?? skill.name}${text ? ` ${text}` : ''}` : text;
}
