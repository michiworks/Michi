/**
 * How Michi Memory names and dates what it shows an agent (spec §5): a
 * memory pack (contextBuilder.ts) and the memory tools
 * (agents/memoryTools.ts) name items by short refs instead of 40-character
 * ids, and date them by the local calendar day.
 *
 *  - `m:<base36 memories.row_id>v<version>`: one version of a memory. An
 *    edit or a correction gives the memory a new ref, so a ref the agent
 *    holds always names the text it was shown.
 *  - `c:<base36 memory_recall_docs.id>`: one past-conversation excerpt.
 *
 * Base36 digits include "v", so the version is the digits after the last
 * "v". A memory ref without its version names the memory's current version.
 */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD of a time (ms) in this machine's time zone. */
export function memoryDay(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? 'undated' : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type ParsedRef =
  | { kind: 'memory'; rowId: number; version: number | null }
  | { kind: 'conversation'; docId: number };

export function memoryRef(rowId: number, version: number): string {
  return `m:${rowId.toString(36)}v${version}`;
}

export function conversationRef(docId: number): string {
  return `c:${docId.toString(36)}`;
}

const VERSIONED_MEMORY_REF = /^m:([0-9a-z]{1,11})v(\d{1,9})$/u;
const BARE_REF = /^([mc]):([0-9a-z]{1,11})$/u;

/** A ref as an agent may pass it back ("m:1kv2", "[m:1kv2]", "c:3f"); null when the text is no ref. */
export function parseRef(text: unknown): ParsedRef | null {
  if (typeof text !== 'string') return null;
  const value = text.trim().replace(/^\[\s*/u, '').replace(/\s*\]$/u, '').toLowerCase();
  const versioned = VERSIONED_MEMORY_REF.exec(value);
  if (versioned) {
    const rowId = Number.parseInt(versioned[1], 36);
    const version = Number(versioned[2]);
    return Number.isSafeInteger(rowId) && rowId > 0 && version > 0 ? { kind: 'memory', rowId, version } : null;
  }
  const bare = BARE_REF.exec(value);
  if (!bare) return null;
  const id = Number.parseInt(bare[2], 36);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return bare[1] === 'm' ? { kind: 'memory', rowId: id, version: null } : { kind: 'conversation', docId: id };
}
