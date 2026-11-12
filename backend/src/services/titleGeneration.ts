/**
 * Michi's sidecar thread-title generation: the instruction text and prompt,
 * and the per-runtime title model read from the environment.
 *
 * The runtime-neutral mechanics (output cleaning, the plain-text fallback,
 * the deadline race and the length limits) live in michi-runtime
 * (runtime/src/core/titles.ts) and are re-exported here, so existing
 * importers keep the same functions. The runtime-specific transport lives
 * next to each runtime.
 */

import type { TitleModelConfig } from 'michi-runtime';
import {
  DEFAULT_TITLE_TIMEOUT_MS,
  MAX_TITLE_INPUT_CHARS,
  truncateChars,
} from 'michi-runtime/internal/core/titles';
import { envPositiveInt } from '../config/env';

/** The deadline Codex's title thread has always had, shorter than Kiro's. */
const CODEX_TITLE_TIMEOUT_MS = 10_000;

export {
  DEFAULT_TITLE_TIMEOUT_MS,
  MAX_TITLE_INPUT_CHARS,
  MAX_TITLE_CHARS,
  truncateChars,
  cleanGeneratedTitle,
  fallbackTitleFromUserText,
  withTitleTimeout,
} from 'michi-runtime/internal/core/titles';

/** What a title must be, for every runtime; each adds how to return it. */
export const TITLE_RULES = `You generate a short thread title from a user's message in a knowledge-exploration chat app.
Do not answer the request, plan the work, call tools, or explain your reasoning.
Capture the TOPIC or INTENT of the message. Match the user's language.
The title MUST be self-contained: include the specific subject so it makes sense in a sidebar without extra context. Never produce a generic verb-only title like "修复原理详解" or "Implementation Details" — always name WHAT is being discussed.
Prefer 4-8 words for space-delimited languages or 8-20 characters for Chinese/Japanese.
Avoid meta phrasing such as "User asks about…" or "关于…".`;

export const TITLE_INSTRUCTIONS = `${TITLE_RULES}
Plain text only: no quotes, no trailing period, no markdown, no "Title:" prefix.
Output ONLY the title.`;

/** The message to title, after the text it replies to or quotes. */
export function buildTitleInput(userText: string, contextText?: string): string {
  const contextBlock = contextText?.trim()
    ? `CONTEXT (the user is replying to or quoting this):\n${truncateChars(contextText.trim(), 1_000)}\n\n`
    : '';
  return `${contextBlock}USER MESSAGE:\n${truncateChars(userText, MAX_TITLE_INPUT_CHARS)}`;
}

export function buildTitlePrompt(userText: string, contextText?: string): string {
  return `${TITLE_INSTRUCTIONS}\n\n---\n${buildTitleInput(userText, contextText)}`;
}

function readModel(envName: string, fallback: string, env: NodeJS.ProcessEnv): string | null {
  const raw = env[envName];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'off' || trimmed.toLowerCase() === 'none') return null;
  return trimmed;
}

/** The model variable and its default, and the deadline variable and its default, of each runtime with sidecar titles. */
const TITLE_MODELS: Readonly<Record<string, { modelEnv: string; model: string; timeoutEnv: string; timeoutMs: number }>> = {
  kiro: { modelEnv: 'MICHI_TITLE_MODEL_KIRO', model: 'gpt-5.6-luna', timeoutEnv: 'MICHI_TITLE_TIMEOUT_MS', timeoutMs: DEFAULT_TITLE_TIMEOUT_MS },
  codex: { modelEnv: 'MICHI_TITLE_MODEL_CODEX', model: 'gpt-5.6-luna', timeoutEnv: 'MICHI_CODEX_TITLE_TIMEOUT_MS', timeoutMs: CODEX_TITLE_TIMEOUT_MS },
  // A tier name: the CLI's own list says which Haiku that is.
  claude: { modelEnv: 'MICHI_TITLE_MODEL_CLAUDE', model: 'haiku', timeoutEnv: 'MICHI_TITLE_TIMEOUT_MS', timeoutMs: DEFAULT_TITLE_TIMEOUT_MS },
};

/**
 * Per-runtime cheap model for title generation. Each runtime reads its own
 * entry so a user who only has one CLI installed still gets titles from the
 * credentials they already have. Set the env var to `off` to disable.
 * Undefined for a runtime without sidecar titles.
 */
export function titleModelConfig(runtimeId: string, env: NodeJS.ProcessEnv = process.env): TitleModelConfig | undefined {
  const entry = Object.hasOwn(TITLE_MODELS, runtimeId) ? TITLE_MODELS[runtimeId] : undefined;
  return entry && {
    model: readModel(entry.modelEnv, entry.model, env),
    timeoutMs: envPositiveInt(entry.timeoutEnv, entry.timeoutMs, env),
  };
}
