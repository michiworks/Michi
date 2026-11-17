/**
 * Rich blocks an agent shows inside a chat reply (the show_blocks tool):
 * Pages' own block contracts, checked with the same schemas and the same
 * field-naming messages a page write gets, and read back as plain text for
 * the windows, searches and exports that do not draw them.
 */
import { isRecord } from '../guards';
import { PAGE_BLOCK_CATALOG, pageBlockProblem, pageBlockText, type PageBlockType } from './blockCatalog';
import { parsePageBlockInput, type PageBlockInput } from './blocks';
import { RICH_BLOCK_SCHEMAS, sentValue, type RichBlockType } from './richBlocks';

export const CHAT_BLOCK_LIMITS = { min: 1, max: 12, title: 200 } as const;

/**
 * Not shown in a reply: toc lists a page's headings, and the players
 * (video, audio) load from the internet without asking, which on a page
 * only a block the page holds back may do.
 */
const LEFT_OUT: ReadonlySet<string> = new Set(['toc', 'video', 'audio']);

/** The block types a reply may show: the rich blocks and charts. */
export const CHAT_BLOCK_TYPES: readonly PageBlockType[] = [
  ...(Object.keys(RICH_BLOCK_SCHEMAS) as RichBlockType[]).filter((type) => !LEFT_OUT.has(type)),
  'chart',
];
const ALLOWED: ReadonlySet<string> = new Set(CHAT_BLOCK_TYPES);

/** Page-only fields: a reply has no named views, and Michi gives each block its id. */
const PAGE_ONLY_FIELDS = ['id', 'interaction', 'visibility'] as const;

/** Issues listed in one refusal; the rest are counted. */
const SHOWN_ISSUES = 12;

/** Each allowed type's fields in brief, for the tool description: `poll {question, options: …}; …`. */
export function chatBlockFieldsDoc(): string {
  return CHAT_BLOCK_TYPES.map((type) => `${type} ${PAGE_BLOCK_CATALOG[type].fields}`).join('; ');
}

export type ChatBlocksCheck =
  | { ok: true; blocks: PageBlockInput[]; title?: string }
  | { ok: false; problem: string };

/**
 * The blocks and title a show_blocks call asks for, or why not, naming each
 * field that is wrong (`blocks[1]: This poll block is not valid: options
 * needs at least 2 items. Its fields: …`).
 */
export function checkChatBlocks(input: { blocks?: unknown; title?: unknown }): ChatBlocksCheck {
  const { blocks, title } = input;
  const range = `${CHAT_BLOCK_LIMITS.min}-${CHAT_BLOCK_LIMITS.max} blocks`;
  if (!Array.isArray(blocks)) return { ok: false, problem: `blocks must be a list of ${range}` };
  if (blocks.length < CHAT_BLOCK_LIMITS.min || blocks.length > CHAT_BLOCK_LIMITS.max) {
    return { ok: false, problem: `blocks has ${blocks.length} item${blocks.length === 1 ? '' : 's'}; show ${range}` };
  }
  const issues: string[] = [];
  if (title !== undefined && typeof title !== 'string') issues.push(`title must be text${sentValue(title)}`);
  else if (typeof title === 'string' && title.length > CHAT_BLOCK_LIMITS.title) issues.push(`title is longer than ${CHAT_BLOCK_LIMITS.title} characters`);
  const parsed: PageBlockInput[] = [];
  blocks.forEach((value, index) => {
    const at = `blocks[${index}]`;
    if (!isRecord(value)) { issues.push(`${at} must be a block object with a type`); return; }
    if (typeof value.type !== 'string' || !ALLOWED.has(value.type)) {
      issues.push(`${at}.type is not a block type a reply shows${sentValue(value.type)}; the types are ${CHAT_BLOCK_TYPES.join(', ')}`);
      return;
    }
    const pageOnly = PAGE_ONLY_FIELDS.filter((key) => value[key] !== undefined);
    if (pageOnly.length) { issues.push(...pageOnly.map((key) => `${at}.${key} is not a field`)); return; }
    const problem = pageBlockProblem(value);
    if (problem) { issues.push(`${at}: ${problem}`); return; }
    const block = parsePageBlockInput(value);
    if (block) parsed.push(block);
  });
  if (issues.length) {
    const shown = issues.slice(0, SHOWN_ISSUES).join('; ') + (issues.length > SHOWN_ISSUES ? `; and ${issues.length - SHOWN_ISSUES} more` : '');
    return { ok: false, problem: shown };
  }
  const named = typeof title === 'string' && title.trim() ? title.trim() : undefined;
  return { ok: true, blocks: parsed, ...(named ? { title: named } : {}) };
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const bullets = (items: unknown) => (Array.isArray(items) ? items.map(str).filter(Boolean).map((item) => `- ${item}`) : []);

/** One block as the text a reader without the drawing needs: the question and its options, a form's fields, the figures. */
function blockFallback(block: Record<string, unknown>): string {
  switch (block.type) {
    case 'poll':
    case 'choice':
      return [str(block.question), ...bullets(block.options)].filter(Boolean).join('\n');
    case 'form': {
      const fields = Array.isArray(block.fields) ? block.fields.filter(isRecord) : [];
      return [str(block.title), ...fields.map((field) => {
        const options = Array.isArray(field.options) ? `: ${field.options.map(str).filter(Boolean).join(' / ')}` : '';
        return `- ${str(field.label)}${field.required ? ' (required)' : ''}${options}`;
      })].filter(Boolean).join('\n');
    }
    case 'actions':
      return (Array.isArray(block.buttons) ? block.buttons.filter(isRecord) : []).map((button) => `[${str(button.label)}]`).join(' ');
    case 'stat':
      return `${str(block.label)}: ${str(block.value)}${str(block.delta) ? ` (${str(block.delta)})` : ''}`;
    case 'keyvalue':
      return [str(block.title), ...(Array.isArray(block.items) ? block.items.filter(isRecord) : []).map((item) => `- ${str(item.key)}: ${str(item.value)}`)]
        .filter(Boolean).join('\n');
    case 'divider':
      return '---';
    default:
      return pageBlockText(block as PageBlockInput).trim();
  }
}

/** The blocks as plain text, the title first; what older windows, searches and exports read in their place. */
export function chatBlocksFallbackText(blocks: readonly unknown[], title?: string): string {
  return [str(title), ...blocks.filter(isRecord).map(blockFallback)].filter(Boolean).join('\n\n');
}
