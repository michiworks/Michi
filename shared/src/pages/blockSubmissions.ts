/**
 * What a person sent through an interactive block (a form, poll or choice),
 * kept so the block shows it read-only afterwards, after a reload too. A
 * submission belongs to the block's host (a page, or one chat message), its
 * block id and the signature of the block's interactive content: a block the
 * agent rewrites with other fields or options starts fresh.
 */

export type BlockSubmissionHost = { kind: 'page'; pageId: string } | { kind: 'chat'; nodeId: string; messageId: string };

export interface BlockSubmission {
  blockId: string;
  signature: string;
  /** What the block holds again when it shows the submission (form answers by key, the picked option indices). */
  value: unknown;
  /** The message the submission sent. */
  text: string;
  submittedAt: number;
}

export const BLOCK_SUBMISSION_LIMITS = {
  /** UTF-8 bytes of the value's JSON. */
  valueBytes: 16 * 1024,
  /** UTF-8 bytes of the text. */
  textBytes: 8 * 1024,
  idLength: 200,
  signatureLength: 100,
} as const;

/** A host id (page, node, message): no whitespace, control characters or ':', which separates the parts of a host key. */
const HOST_ID = /^[^\s:\u0000-\u001f\u007f]+$/;

export function isBlockSubmissionHostId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= BLOCK_SUBMISSION_LIMITS.idLength && HOST_ID.test(value);
}

/** A block id: any printable text up to the id limit (container children carry positional ids such as `block-1.0`). */
export function isBlockSubmissionBlockId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= BLOCK_SUBMISSION_LIMITS.idLength && !/[\u0000-\u001f\u007f]/.test(value);
}

/** `page:<pageId>` or `chat:<nodeId>:<messageId>`: the `host` query parameter and the stored host key. */
export function blockSubmissionHostKey(host: BlockSubmissionHost): string {
  return host.kind === 'page' ? `page:${host.pageId}` : `chat:${host.nodeId}:${host.messageId}`;
}

export function parseBlockSubmissionHostKey(key: unknown): BlockSubmissionHost | null {
  if (typeof key !== 'string' || key.length > 3 * BLOCK_SUBMISSION_LIMITS.idLength + 10) return null;
  const parts = key.split(':');
  if (parts[0] === 'page' && parts.length === 2 && isBlockSubmissionHostId(parts[1])) return { kind: 'page', pageId: parts[1] };
  if (parts[0] === 'chat' && parts.length === 3 && isBlockSubmissionHostId(parts[1]) && isBlockSubmissionHostId(parts[2])) {
    return { kind: 'chat', nodeId: parts[1], messageId: parts[2] };
  }
  return null;
}

/** A host as a request body carries it: exactly the fields of its kind, each a valid id. */
export function parseBlockSubmissionHost(value: unknown): BlockSubmissionHost | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const host = value as Record<string, unknown>;
  const keys = Object.keys(host).sort().join(',');
  if (host.kind === 'page' && keys === 'kind,pageId' && isBlockSubmissionHostId(host.pageId)) return { kind: 'page', pageId: host.pageId };
  if (host.kind === 'chat' && keys === 'kind,messageId,nodeId' && isBlockSubmissionHostId(host.nodeId) && isBlockSubmissionHostId(host.messageId)) {
    return { kind: 'chat', nodeId: host.nodeId, messageId: host.messageId };
  }
  return null;
}

/** JSON with object keys sorted, so the same content hashes the same whichever order its keys were written in. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** The part of a block a submission answers: a form's fields, a poll's options and `multi`, a choice's options. */
function interactiveContent(block: { type?: unknown; [key: string]: unknown }): unknown {
  switch (block.type) {
    case 'form': return ['form', block.fields ?? null];
    case 'poll': return ['poll', block.options ?? null, !!block.multi];
    case 'choice': return ['choice', block.options ?? null];
    case 'actions': return ['actions', Array.isArray(block.buttons) ? block.buttons.map((b) => (b && typeof b === 'object' ? [(b as Record<string, unknown>).label ?? null, (b as Record<string, unknown>).prompt ?? null] : null)) : null];
    default: return [typeof block.type === 'string' ? block.type : null];
  }
}

/**
 * A stable hash (FNV-1a over canonical JSON) of the block's interactive
 * content, so a rewritten block starts fresh while a re-read or re-ordered
 * copy of the same block keeps its submission. Titles, prompts and a choice's
 * stored `selected` are not part of it.
 */
export function blockSubmissionSignature(block: { type?: unknown; [key: string]: unknown }): string {
  let text: string;
  try { text = JSON.stringify(canonical(interactiveContent(block))) ?? ''; } catch { text = ''; }
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return `${typeof block.type === 'string' ? block.type.slice(0, 20) : 'block'}-${(hash >>> 0).toString(36)}-${text.length}`;
}
