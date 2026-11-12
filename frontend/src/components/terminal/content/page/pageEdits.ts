import type { MichiPageBlock } from 'michi-shared';
import type { MichiPageEditOp } from './editorTypes';
import { isObj, objects, str } from './michiPageModel';

// Build presentation edits consumed by the native Page adapter.

/**
 * What a person may rewrite here. Michi also lets a database be edited, cell by
 * cell; that belongs to the database views, not the page's own editor.
 */
export const EDITABLE_TYPES: ReadonlySet<string> = new Set(['markdown', 'heading', 'callout', 'checklist']);

/**
 * Editor limits for human-authored text and checklist items.
 */
export const MICHI_TEXT_MAX = 2000;
export const MICHI_HEADING_MAX = 200;
export const MICHI_CHECKLIST_MAX_ITEMS = 50;

/** The block's id when it has one; a block without one cannot be named in an edit. */
export function blockIdOf(block: MichiPageBlock): string | null {
  return typeof block.id === 'string' && block.id ? block.id : null;
}

export function isEditableBlock(block: MichiPageBlock): boolean {
  return blockIdOf(block) != null && EDITABLE_TYPES.has(block.type);
}

/** Set by Michi once a person changed the block; the agent then keeps it as it is. */
export function isEditedBlock(block: MichiPageBlock): boolean {
  return isObj(block.edit);
}

/** The block an agent's note says may be out of date, when this block is such a note. */
export function staleTargetOf(block: MichiPageBlock): string | null {
  return typeof block.staleFor === 'string' && block.staleFor ? block.staleFor : null;
}

/** Leading blank lines and trailing space carry nothing in Markdown, so they neither count as a change nor get saved. */
export function tidy(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

/** One line, as a heading holds it. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The whole block with its changes; Michi marks the block as the person's itself, so its old mark is not sent back. */
export function updateOp(block: MichiPageBlock, changes: Record<string, unknown>): MichiPageEditOp | null {
  const id = blockIdOf(block);
  if (!id) return null;
  const { edit: _edit, ...rest } = block;
  return { op: 'update', id, block: { ...rest, ...changes, id, type: block.type } };
}

/**
 * The text change a markdown, heading or callout editor makes, or null when
 * there is none to send: unchanged, or emptied (an emptied block stays as it was).
 * A callout's `title` (one line) goes too when it changed; emptied, the callout
 * has none (`title: undefined`, which the sent block leaves out).
 */
export function textChanges(block: MichiPageBlock, draft: string, title?: string): Record<string, unknown> | null {
  const before = str(block.text);
  if (block.type === 'heading') {
    const text = oneLine(draft);
    return text && text !== oneLine(before) ? { text } : null;
  }
  const out: Record<string, unknown> = {};
  const text = tidy(draft);
  if (text && text !== tidy(before)) out.text = text;
  if (block.type === 'callout' && title !== undefined) {
    const next = oneLine(title);
    if (next !== oneLine(str(block.title))) out.title = next || undefined;
  }
  return Object.keys(out).length ? out : null;
}

export interface ChecklistDraftItem {
  text: string;
  done: boolean;
}

/** A checklist's items as the editor starts them. */
export function checklistItems(block: MichiPageBlock): ChecklistDraftItem[] {
  return objects(block.items).map((it) => ({ text: str(it.text), done: it.done === true }));
}

/**
 * A checklist editor's result: blank items dropped (Michi keeps none), the
 * title kept when emptied. `empty` when no item is left, which Michi refuses.
 */
export function checklistChanges(
  block: MichiPageBlock,
  title: string,
  items: readonly ChecklistDraftItem[],
): Record<string, unknown> | null | 'empty' {
  const kept = items.map((it) => ({ text: oneLine(it.text), done: it.done })).filter((it) => it.text);
  if (!kept.length) return 'empty';
  const nextTitle = oneLine(title) || str(block.title);
  const before = checklistItems(block).map((it) => ({ text: oneLine(it.text), done: it.done }));
  const same = nextTitle === str(block.title)
    && kept.length === before.length
    && kept.every((it, i) => it.text === before[i].text && it.done === before[i].done);
  return same ? null : { title: nextTitle, items: kept };
}

/** The checklist with one item ticked or unticked; null when there is no such item. */
export function toggledChecklist(block: MichiPageBlock, index: number): MichiPageBlock | null {
  const items = objects(block.items);
  if (index < 0 || index >= items.length) return null;
  return { ...block, items: items.map((it, i) => (i === index ? { ...it, done: it.done !== true } : it)) };
}

/** What the margin's + adds below a block. Michi adds Markdown only, so each kind is written as its Markdown. */
export type InsertKind = 'text' | 'heading' | 'todo' | 'callout';

/** The Markdown an add-block editor's words become; null when nothing was written. */
export function insertMarkdown(kind: InsertKind, draft: string): string | null {
  if (kind === 'heading') {
    const text = oneLine(draft);
    return text ? `## ${text}` : null;
  }
  const lines = draft.split(/\r?\n/).map((l) => l.trim());
  if (kind === 'todo') {
    const items = lines.filter(Boolean);
    return items.length ? items.map((l) => `- [ ] ${l}`).join('\n') : null;
  }
  const text = tidy(draft);
  if (!text) return null;
  if (kind === 'callout') return text.split(/\r?\n/).map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
  return text;
}

/** Markdown added after the block `after`, or at the top of the page when `after` is null. */
export function insertOp(after: string | null, markdown: string): MichiPageEditOp {
  const block = { type: 'markdown', text: markdown };
  return after == null ? { op: 'insert', after: null, parent: null, block } : { op: 'insert', after, block };
}

export function deleteOps(ids: readonly string[]): MichiPageEditOp[] {
  return ids.map((id) => ({ op: 'delete', id }));
}

export function releaseOp(id: string): MichiPageEditOp {
  return { op: 'release', id };
}

// ── drafts ───────────────────────────────────────────────────────

/** What an open editor holds: words (a callout's with its title), or a checklist's title and items. */
export type EditorDraft =
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'checklist'; title: string; items: ChecklistDraftItem[] };

/** A draft as plain text, for Copy. */
export function draftText(draft: EditorDraft): string {
  if (draft.kind === 'text') return [oneLine(draft.title ?? ''), draft.text].filter(Boolean).join('\n');
  const items = draft.items.filter((it) => it.text.trim()).map((it) => `- [${it.done ? 'x' : ' '}] ${oneLine(it.text)}`);
  return [oneLine(draft.title), ...items].filter(Boolean).join('\n');
}

/**
 * A draft as the Markdown it would be as a new block, so it can be added back
 * when the block it was editing is gone. `type` is the edited block's type,
 * or the kind of block being added. Null when there is nothing to keep.
 */
export function draftMarkdown(type: string, draft: EditorDraft): string | null {
  if (draft.kind === 'checklist') {
    const items = draft.items.map((it) => ({ text: oneLine(it.text), done: it.done })).filter((it) => it.text);
    const title = oneLine(draft.title);
    if (!items.length && !title) return null;
    const lines = items.map((it) => `- [${it.done ? 'x' : ' '}] ${it.text}`).join('\n');
    return title ? (lines ? `**${title}**\n\n${lines}` : `**${title}**`) : lines;
  }
  switch (type) {
    case 'heading':
      return insertMarkdown('heading', draft.text);
    case 'callout': {
      const title = oneLine(draft.title ?? '');
      return insertMarkdown('callout', title ? `**${title}**\n${draft.text}` : draft.text);
    }
    case 'todo':
      return insertMarkdown('todo', draft.text);
    default:
      return insertMarkdown('text', draft.text);
  }
}

// ── what an editor opened on ─────────────────────────────────────

/**
 * What a block says, as an editor saw it when it opened: its kind and words
 * (text, title, items, level, tone) and, for a piece, the block it was cut
 * from. Ids alone do not say this: an agent may rewrite a block keeping its
 * id, and a paragraph added above shifts which paragraph `b~1` names.
 */
export function blockFingerprint(block: MichiPageBlock, segmentOf?: string): string {
  return JSON.stringify([
    segmentOf ?? null,
    block.type,
    str(block.text),
    str(block.title),
    block.type === 'checklist' ? checklistItems(block) : null,
    block.level ?? null,
    block.tone ?? null,
  ]);
}
