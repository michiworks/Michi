/** How a page change names what it changed: the Home's activity, a chat's receipt and a suggestion's card all read alike. */
import { pageBlockTitle } from './blockCatalog';
import type { PageBlockInput } from './blocks';

/** A name on one line, without Markdown emphasis, cut at `max` characters. */
export function clipPageName(text: string, max = 24): string {
  const line = text.replace(/\*\*|__|`|~~/g, '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** A block's name: its title or heading, else its first words without heading or list marks; '' when it has neither. */
export function pageBlockName(block: PageBlockInput, max = 24): string {
  switch (block.type) {
    case 'heading': return clipPageName(block.text, max);
    case 'markdown': {
      const first = block.text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
      return clipPageName(first.replace(/^#{1,6}\s+/, '').replace(/^(?:[-*+>]|\d+[.)])\s+/, ''), max);
    }
    case 'callout': return clipPageName(block.title?.trim() || block.text, max);
    case 'checklist': case 'next-steps': case 'timeline': return clipPageName(block.title ?? '', max);
    case 'metrics': case 'database-ref': case 'page-link': case 'component': return '';
    default: return clipPageName(pageBlockTitle(block), max);
  }
}

/**
 * A row's name: its title column's text (the column a database view titles
 * a row by, see titleColumn), else its first text in the order its cells
 * were written; '' when it has no text.
 */
export function pageRowName(values: Readonly<Record<string, unknown>>, titleColumnId: string | null | undefined, max = 24): string {
  const own = titleColumnId ? values[titleColumnId] : undefined;
  const text = typeof own === 'string' && own.trim() ? own
    : Object.values(values).find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return text ? clipPageName(text, max) : '';
}
