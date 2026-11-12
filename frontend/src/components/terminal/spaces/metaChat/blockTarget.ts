import type { PageBlock } from 'michi-shared';
import { blockFullText, blockLabel } from '../../content/page/michiPageModel';
import { toMichiBlock } from '../nativeBlockAdapter';

/** How the chat window names a page block it targets, and the text it sends along: the same on a Space page and a home. */
export function pageBlockTarget(block: PageBlock): { title: string; content: string } {
  const content = toMichiBlock(block);
  return { title: blockLabel(content), content: blockFullText(content) };
}
