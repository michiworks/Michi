export type ChatPermissionMode = 'ask' | 'trust' | 'yolo';

/**
 * What a person picks for a chat: a mode, or `approve`, which is Ask with the
 * runtime's own trust classifier approving what no rule settles (Kiro V3
 * "Approve for me"). Storage and the wire keep the mode (`ask`) and carry
 * `approveForMe` beside it, so an older Backend or client reads Ask.
 */
export type ChatPermissionChoice = ChatPermissionMode | 'approve';

export interface ChatPermissionSettings {
  global: boolean;
  mode: ChatPermissionMode;
  /** Approve for me on top of `mode: 'ask'`; ignored with any other mode. */
  approveForMe?: boolean;
}

export const DEFAULT_CHAT_PERMISSION_SETTINGS: ChatPermissionSettings = { global: false, mode: 'ask' };

export function isChatPermissionMode(value: unknown): value is ChatPermissionMode {
  return value === 'ask' || value === 'trust' || value === 'yolo';
}

export function isChatPermissionChoice(value: unknown): value is ChatPermissionChoice {
  return value === 'approve' || isChatPermissionMode(value);
}

export function isChatPermissionSettings(value: unknown): value is ChatPermissionSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as Record<string, unknown>;
  return typeof settings.global === 'boolean' && isChatPermissionMode(settings.mode)
    && (settings.approveForMe === undefined || typeof settings.approveForMe === 'boolean');
}

/** The choice a stored mode and Approve for me flag describe. */
export function chatPermissionChoice(mode: ChatPermissionMode, approveForMe?: boolean | null): ChatPermissionChoice {
  return mode === 'ask' && approveForMe === true ? 'approve' : mode;
}

/** The mode and flag a choice is stored as. */
export function chatPermissionChoiceParts(choice: ChatPermissionChoice): { mode: ChatPermissionMode; approveForMe: boolean } {
  return choice === 'approve' ? { mode: 'ask', approveForMe: true } : { mode: choice, approveForMe: false };
}

/**
 * The choices from the one that asks most to the one that asks least
 * (DESIGN-v2 §4): `ask` asks before every tool; `approve` is Ask with a
 * classifier that approves on its own; `trust` and `yolo` run tools without
 * asking. A `session.send` card fails at Apply when its target's choice is
 * now wider than when it was proposed; a check-in sends a follow-up
 * directly only to a target in exactly `ask` (companionCheckinMaySendDirectly).
 */
export const CHAT_PERMISSION_CHOICE_ORDER: readonly ChatPermissionChoice[] = Object.freeze(['ask', 'approve', 'trust', 'yolo']);

/** The choice's place in CHAT_PERMISSION_CHOICE_ORDER (0 for `ask`); a value that is not a choice ranks widest, so checks fail closed. */
export function chatPermissionRank(choice: unknown): number {
  const rank = CHAT_PERMISSION_CHOICE_ORDER.indexOf(choice as ChatPermissionChoice);
  return rank < 0 ? CHAT_PERMISSION_CHOICE_ORDER.length : rank;
}

/**
 * True when `next` lets tools run with less asking than `than` (ask <
 * approve < trust < yolo). Either value not being a choice (stored data
 * gone bad) counts as wider, so a check fails closed.
 */
export function isWiderChatPermission(next: ChatPermissionChoice, than: ChatPermissionChoice): boolean {
  if (!isChatPermissionChoice(next) || !isChatPermissionChoice(than)) return true;
  return chatPermissionRank(next) > chatPermissionRank(than);
}
