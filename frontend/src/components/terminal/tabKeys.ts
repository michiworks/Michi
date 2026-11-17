import type React from 'react';

/**
 * The tab a key moves to in a tab strip (ST-20): ← and → step to the tab
 * before or after, wrapping round, and Home and End go to the ends. Null for
 * any other key, and for shortcuts with ⌘, Ctrl or ⌥, which the strip leaves
 * alone. The strip selects the tab it returns and focuses it.
 */
export function tabStripKeyTarget(event: React.KeyboardEvent, index: number, count: number): number | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  switch (event.key) {
    case 'ArrowLeft': return (index + count - 1) % count;
    case 'ArrowRight': return (index + 1) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}
