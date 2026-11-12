/**
 * What the Spaces chat window tells the Meta agent with each message: the
 * page on screen, the selected block and the pages the user can see, by id
 * and title only (never page text beyond one bounded checklist item or
 * database row the user asked about). Sent as `metaAgentContext` on
 * POST /api/chats/:chatId/message, accepted only for the Michi assistant's
 * conversation; the backend turns it into a bounded prefix of that turn.
 * The Scheduled window sends `schedule` instead, for its own conversation.
 */

export interface MetaAgentChatPageRef {
  id: string;
  title: string;
  workspaceId?: string;
}

export interface MetaAgentChatTurnContext {
  /** The page on screen; null when the window is not over a page. */
  pageId?: string | null;
  /** The block the user selected on that page ("针对：…"); needs pageId. */
  blockId?: string | null;
  /**
   * One item of a checklist in that block the user asked about: its 0-based
   * position in its checklist and its text, bounded by titleChars. Needs blockId.
   */
  blockItem?: MetaAgentChatBlockItem | null;
  /**
   * One row of the database that block shows, the one the user asked about:
   * the database and row ids and the row's title, bounded by titleChars.
   * Needs blockId; not sent with blockItem.
   */
  blockRow?: MetaAgentChatBlockRow | null;
  /** The pages the user can see (sidebar order). */
  pages?: MetaAgentChatPageRef[];
  /** Workspaces on remote connections, by name: Spaces doesn't support them yet, so the Meta agent cannot read them. */
  remoteWorkspaces?: string[];
  /** The remote workspace the window is over, by name; the page on screen is then none. */
  remoteOnScreen?: string | null;
  /**
   * The Scheduled window's context instead of the Spaces fields: the
   * workspace a new job goes in unless the user names another (the one New
   * job would preselect). Accepted only for that window's conversation.
   */
  schedule?: MetaAgentScheduleContext;
  /**
   * DESIGN-v2 §1.3: what the message refers to besides its text (the target
   * block, attached blocks, handed-over rows, an attached Today item, the
   * posted check-in it replies to); see CompanionTurnRef. Any area sends
   * them, so they go with the Spaces fields or with `schedule`; they are not
   * one of the Spaces fields (hasSpacesTurnContext ignores them). The route
   * checks them for check-in and collector material before the turn starts
   * (§2.8 T4). W2-F1a sends them; W2-E reads them.
   */
  refs?: CompanionTurnRef[];
}

/** The conversation `start_conversation` opened, as its result names it for the chat window's conversation card. */
export interface MichiConversationStart {
  kind: 'michiConversationStart';
  nodeId: string;
  treeId: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  runtimeId: string;
  modelId: string | null;
  startedFromPageId: string | null;
}

export interface MetaAgentChatBlockItem {
  index: number;
  text: string;
}

export interface MetaAgentChatBlockRow {
  databaseId: string;
  rowId: string;
  text: string;
}

export interface MetaAgentScheduleContext {
  /** Null when the user has no workspace to schedule in. */
  workspaceId: string | null;
}

export const META_AGENT_CHAT_CONTEXT_LIMITS = Object.freeze({
  pages: 500,
  idChars: 200,
  titleChars: 300,
  remoteWorkspaces: 100,
  blockItemIndex: 1_000,
});

export class MetaAgentChatContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaAgentChatContextError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ID = /^[^\s\p{Cc}]+$/u;

/** An id the context accepts: no whitespace or control characters, at most idChars long. */
export function isMetaAgentChatId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value) && value.length <= META_AGENT_CHAT_CONTEXT_LIMITS.idChars;
}

function id(value: unknown, field: string, nullable: boolean): string | null | undefined {
  if (value === undefined || (nullable && value === null)) return value as null | undefined;
  if (!isMetaAgentChatId(value)) {
    throw new MetaAgentChatContextError(`${field} must be an id of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.idChars} characters`);
  }
  return value;
}

// ── v2: what a message to the agent refers to (DESIGN-v2 §1.3, §2.8 T4) ────
// Defined here, beside the parser of the field that carries them, so that
// this module and companion.ts (which re-exports them) never import values
// from each other.

/**
 * A structured reference a message to the agent carries besides its text,
 * sent as `metaAgentContext.refs` (DESIGN-v2 §1.3). Before the turn starts
 * the route checks each against check-in and collector material and, when
 * one points at some, marks the turn untrusted so it runs in Ask (§2.8 T4):
 * - `page`: the target block (or page) the message is about, or an attached block;
 * - `rows`: database rows handed over ("Hand to agent…"). Taint is judged per
 *   database (§2.8 T5), so `rowIds` is optional: a hand-off of more than
 *   COMPANION_TURN_REF_LIMITS.rowIds rows sends the database alone (W2-F1a)
 *   instead of failing the message;
 * - `companion_item`: a Today item attached (Today's Ask);
 * - `post`: the posted check-in the user replies to (`cmp-post-<runId>`).
 * W2-F1a sends them; W2-E reads them with parseMetaAgentChatTurnContext (or
 * parseCompanionTurnRefs alone).
 */
export type CompanionTurnRef =
  | { kind: 'page'; pageId: string; blockId?: string }
  | { kind: 'rows'; databaseId: string; rowIds?: string[] }
  | { kind: 'companion_item'; itemId: string }
  | { kind: 'post'; messageId: string };

export const COMPANION_TURN_REF_LIMITS = Object.freeze({
  /** References one message may carry. */
  refs: 50,
  /** Rows one `rows` reference may name; leave rowIds out above it. */
  rowIds: 100,
  /** Characters of one id, as metaAgentContext ids (META_AGENT_CHAT_CONTEXT_LIMITS.idChars). */
  idChars: META_AGENT_CHAT_CONTEXT_LIMITS.idChars,
});

/**
 * Validates `metaAgentContext.refs`; throws MetaAgentChatContextError (the
 * route answers it with 400, like the rest of metaAgentContext) for anything
 * but a list of known references with known fields and well-formed ids.
 */
export function parseCompanionTurnRefs(value: unknown): CompanionTurnRef[] {
  if (!Array.isArray(value) || value.length > COMPANION_TURN_REF_LIMITS.refs) {
    throw new MetaAgentChatContextError(`refs must be an array of at most ${COMPANION_TURN_REF_LIMITS.refs} references`);
  }
  const refId = (raw: unknown, field: string): string => {
    if (typeof raw !== 'string' || !ID.test(raw) || raw.length > COMPANION_TURN_REF_LIMITS.idChars) {
      throw new MetaAgentChatContextError(`${field} must be an id of at most ${COMPANION_TURN_REF_LIMITS.idChars} characters`);
    }
    return raw;
  };
  return value.map((entry, index): CompanionTurnRef => {
    const at = `refs[${index}]`;
    if (!isRecord(entry)) throw new MetaAgentChatContextError(`${at} must be an object`);
    const ref = entry;
    const only = (fields: string[], shape: string) => {
      if (Object.keys(ref).some((key) => key !== 'kind' && !fields.includes(key))) throw new MetaAgentChatContextError(`${at} must be ${shape}`);
    };
    switch (ref.kind) {
      case 'page':
        only(['pageId', 'blockId'], "{kind:'page', pageId, blockId?}");
        return { kind: 'page', pageId: refId(ref.pageId, `${at}.pageId`), ...(ref.blockId !== undefined ? { blockId: refId(ref.blockId, `${at}.blockId`) } : {}) };
      case 'rows': {
        only(['databaseId', 'rowIds'], "{kind:'rows', databaseId, rowIds?}");
        const databaseId = refId(ref.databaseId, `${at}.databaseId`);
        if (ref.rowIds === undefined) return { kind: 'rows', databaseId };
        if (!Array.isArray(ref.rowIds) || ref.rowIds.length === 0 || ref.rowIds.length > COMPANION_TURN_REF_LIMITS.rowIds) {
          throw new MetaAgentChatContextError(`${at}.rowIds must be 1 to ${COMPANION_TURN_REF_LIMITS.rowIds} row ids; leave it out for more rows`);
        }
        return { kind: 'rows', databaseId, rowIds: ref.rowIds.map((row, rowIndex) => refId(row, `${at}.rowIds[${rowIndex}]`)) };
      }
      case 'companion_item':
        only(['itemId'], "{kind:'companion_item', itemId}");
        return { kind: 'companion_item', itemId: refId(ref.itemId, `${at}.itemId`) };
      case 'post':
        only(['messageId'], "{kind:'post', messageId}");
        return { kind: 'post', messageId: refId(ref.messageId, `${at}.messageId`) };
      default:
        throw new MetaAgentChatContextError(`${at}.kind must be page, rows, companion_item or post`);
    }
  });
}

/** Validates the field; throws MetaAgentChatContextError with a message for the client. */
export function parseMetaAgentChatTurnContext(value: unknown): MetaAgentChatTurnContext {
  if (!isRecord(value)) throw new MetaAgentChatContextError('metaAgentContext must be an object');
  const unknown = Object.keys(value).filter((key) => !['pageId', 'blockId', 'blockItem', 'blockRow', 'pages', 'remoteWorkspaces', 'remoteOnScreen', 'schedule', 'refs'].includes(key));
  if (unknown.length) throw new MetaAgentChatContextError(`metaAgentContext has an unknown field: ${unknown[0]}`);
  let schedule: MetaAgentScheduleContext | undefined;
  if (value.schedule !== undefined) {
    if (!isRecord(value.schedule) || Object.keys(value.schedule).some((key) => key !== 'workspaceId')) {
      throw new MetaAgentChatContextError('schedule must be {workspaceId}');
    }
    schedule = { workspaceId: id(value.schedule.workspaceId, 'schedule.workspaceId', true) ?? null };
  }
  const pageId = id(value.pageId, 'pageId', true);
  const blockId = id(value.blockId, 'blockId', true);
  if (blockId && !pageId) throw new MetaAgentChatContextError('blockId needs pageId');
  let blockItem: MetaAgentChatBlockItem | null | undefined;
  if (value.blockItem === null) blockItem = null;
  else if (value.blockItem !== undefined) {
    const item = value.blockItem;
    if (!isRecord(item) || Object.keys(item).some((key) => key !== 'index' && key !== 'text')
      || !Number.isInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= META_AGENT_CHAT_CONTEXT_LIMITS.blockItemIndex
      || typeof item.text !== 'string' || item.text.length > META_AGENT_CHAT_CONTEXT_LIMITS.titleChars) {
      throw new MetaAgentChatContextError(`blockItem must be {index, text} with an index below ${META_AGENT_CHAT_CONTEXT_LIMITS.blockItemIndex} and text of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.titleChars} characters`);
    }
    if (!blockId) throw new MetaAgentChatContextError('blockItem needs blockId');
    blockItem = { index: item.index as number, text: item.text };
  }
  let blockRow: MetaAgentChatBlockRow | null | undefined;
  if (value.blockRow === null) blockRow = null;
  else if (value.blockRow !== undefined) {
    const row = value.blockRow;
    if (!isRecord(row) || Object.keys(row).some((key) => !['databaseId', 'rowId', 'text'].includes(key))
      || typeof row.text !== 'string' || row.text.length > META_AGENT_CHAT_CONTEXT_LIMITS.titleChars) {
      throw new MetaAgentChatContextError(`blockRow must be {databaseId, rowId, text} with text of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.titleChars} characters`);
    }
    const databaseId = id(row.databaseId, 'blockRow.databaseId', false)!;
    const rowId = id(row.rowId, 'blockRow.rowId', false)!;
    if (!databaseId || !rowId) throw new MetaAgentChatContextError('blockRow needs databaseId and rowId');
    if (!blockId) throw new MetaAgentChatContextError('blockRow needs blockId');
    if (blockItem) throw new MetaAgentChatContextError('blockRow and blockItem cannot both be set');
    blockRow = { databaseId, rowId, text: row.text };
  }
  let pages: MetaAgentChatPageRef[] | undefined;
  if (value.pages !== undefined) {
    if (!Array.isArray(value.pages) || value.pages.length > META_AGENT_CHAT_CONTEXT_LIMITS.pages) {
      throw new MetaAgentChatContextError(`pages must be an array of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.pages} pages`);
    }
    pages = value.pages.map((page, index) => {
      if (!isRecord(page) || Object.keys(page).some((key) => !['id', 'title', 'workspaceId'].includes(key))) {
        throw new MetaAgentChatContextError(`pages[${index}] must be {id, title, workspaceId?}`);
      }
      if (typeof page.title !== 'string' || page.title.length > META_AGENT_CHAT_CONTEXT_LIMITS.titleChars) {
        throw new MetaAgentChatContextError(`pages[${index}].title must be a string of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.titleChars} characters`);
      }
      const workspaceId = id(page.workspaceId, `pages[${index}].workspaceId`, false);
      return { id: id(page.id, `pages[${index}].id`, false)!, title: page.title, ...(workspaceId ? { workspaceId } : {}) };
    });
  }
  const name = (item: unknown, field: string): string => {
    if (typeof item !== 'string' || item.length > META_AGENT_CHAT_CONTEXT_LIMITS.titleChars) {
      throw new MetaAgentChatContextError(`${field} must be a name of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.titleChars} characters`);
    }
    return item;
  };
  let remoteWorkspaces: string[] | undefined;
  if (value.remoteWorkspaces !== undefined) {
    if (!Array.isArray(value.remoteWorkspaces) || value.remoteWorkspaces.length > META_AGENT_CHAT_CONTEXT_LIMITS.remoteWorkspaces) {
      throw new MetaAgentChatContextError(`remoteWorkspaces must be an array of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.remoteWorkspaces} names`);
    }
    remoteWorkspaces = value.remoteWorkspaces.map((item, index) => name(item, `remoteWorkspaces[${index}]`));
  }
  const remoteOnScreen = value.remoteOnScreen === undefined || value.remoteOnScreen === null ? value.remoteOnScreen : name(value.remoteOnScreen, 'remoteOnScreen');
  const refs = value.refs === undefined ? undefined : parseCompanionTurnRefs(value.refs);
  return {
    ...(pageId !== undefined ? { pageId } : {}),
    ...(blockId !== undefined ? { blockId } : {}),
    ...(blockItem !== undefined ? { blockItem } : {}),
    ...(blockRow !== undefined ? { blockRow } : {}),
    ...(pages ? { pages } : {}),
    ...(remoteWorkspaces ? { remoteWorkspaces } : {}),
    ...(remoteOnScreen !== undefined ? { remoteOnScreen } : {}),
    ...(schedule ? { schedule } : {}),
    ...(refs ? { refs } : {}),
  };
}

/** True when the context carries any of the Spaces window's fields (`refs` and `schedule` are not among them). */
export function hasSpacesTurnContext(context: MetaAgentChatTurnContext): boolean {
  return context.pageId !== undefined || context.blockId !== undefined || context.blockItem !== undefined || context.blockRow !== undefined
    || context.pages !== undefined
    || context.remoteWorkspaces !== undefined || context.remoteOnScreen !== undefined;
}
