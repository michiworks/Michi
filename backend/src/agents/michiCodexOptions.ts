import type { CodexAdapterOptions, CodexHostText } from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import { onSkillLibraryChanged } from '../services/skills/events';
import { skillMountRoot } from '../services/skills/mounts';
import { skillsAvailable } from '../services/skills/paths';
import * as titleGeneration from '../services/titleGeneration';
import * as codexText from './hostText/codex';

/**
 * Michi's wording for the Codex adapter (CodexAdapterOptions.hostText): the
 * turn-metadata rules and the title thread's
 * instructions and input. Each member reads hostText/codex.ts (or
 * titleGeneration) through its module object at every call, so test stubs
 * of those exports still apply.
 */
export function michiCodexHostText(): CodexHostText {
  return {
    turnMetadataInstruction: (...args) => codexText.buildCodexTurnMetadataInstruction(...args),
    titleInstructions: () => codexText.TITLE_INSTRUCTIONS,
    titleInput: (text, context) => titleGeneration.buildTitleInput(text, context),
  };
}

/**
 * Michi's skill library for the Codex adapter: app-server scans the flat
 * Codex mount (links to the library skills Codex may use) as an extra skill
 * root, given again after each library change. None in cloud mode.
 */
export function michiCodexSkillOptions(env: NodeJS.ProcessEnv = process.env): Pick<CodexAdapterOptions, 'skillRoots' | 'onSkillRootsChanged'> {
  if (!skillsAvailable(env)) return {};
  return {
    skillRoots: () => {
      const root = skillMountRoot('codex', 'flat');
      return root ? [root] : [];
    },
    onSkillRootsChanged: onSkillLibraryChanged,
  };
}
