import { chatLabel } from './chatStore';
import type { ChatNodeState } from './chatTypes';
import { paneItemTitle, type PaneItem } from './paneItems';

/**
 * A pane's name on every surface that lists panes (captions, tabs, the phone
 * title and switcher, arrivals): a pane item's own title or its kind's name;
 * `override` for a conversation (the Assistant workspace names them all);
 * else the conversation's title, then its first message. Empty when the
 * conversation is gone; each surface supplies its own last word.
 */
export function paneTitle(node: ChatNodeState | undefined, item: PaneItem | undefined, { override }: { override?: string } = {}): string {
  if (item) return paneItemTitle(item);
  if (override) return override;
  return node ? node.title || chatLabel(node) : '';
}
