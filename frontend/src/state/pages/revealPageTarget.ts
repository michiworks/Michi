import { serverEntityId } from '../../config/backendIdentity';
import { prefersReducedMotion } from '../../hooks/useReducedMotion';

/** A block, or a row of a database, to show once its page has rendered it. */
export interface PageRevealTarget {
  /** A block id; a row id when `databaseId` is set. */
  targetId: string;
  /** The row's database. A target that names the database itself shows the whole database. */
  databaseId?: string;
  /** Only inside the page pane showing this page (beside a chat); otherwise the page on screen. */
  pane?: { pageId: string; workspaceId: string; backendConnectionId: string };
}

const REVEAL_WAIT_MS = 8_000;
const POLL_MS = 100;
/** Outlasts the CSS animation of data-reveal-flash (michiPage.css). */
const FLASH_MS = 1_600;

let cancelPending: (() => void) | null = null;

function owners(pane: PageRevealTarget['pane']): ParentNode[] {
  if (!pane) return [document];
  return Array.from(document.querySelectorAll<HTMLElement>('[data-native-page-pane]'))
    .filter((element) => element.dataset.pageId === pane.pageId
      && element.dataset.workspaceId === pane.workspaceId
      && element.dataset.backendConnectionId === pane.backendConnectionId);
}

function find(target: PageRevealTarget): { element: HTMLElement; block: boolean } | null {
  const { targetId, databaseId, pane } = target;
  for (const owner of owners(pane)) {
    if (!databaseId) {
      // The chat window can show the same block; the reveal is for the page.
      const block = Array.from(owner.querySelectorAll<HTMLElement>('[data-block-id]'))
        .find((element) => element.dataset.blockId === targetId && !element.closest('.meta-chat-panel'));
      if (block) return { element: block.closest<HTMLElement>('.michi-doc-block') ?? block, block: true };
      continue;
    }
    const row = Array.from(owner.querySelectorAll<HTMLElement>('[data-row-id]'))
      .find((element) => element.dataset.rowId === targetId
        && element.closest<HTMLElement>('[data-native-database]')?.dataset.databaseId === databaseId);
    if (row) return { element: row, block: false };
    const wholeDatabase = pane && targetId === serverEntityId(databaseId, pane.backendConnectionId);
    const database = wholeDatabase
      ? Array.from(owner.querySelectorAll<HTMLElement>('[data-native-database]')).find((element) => element.dataset.databaseId === databaseId)
      : undefined;
    if (database) return { element: database, block: false };
  }
  return null;
}

/**
 * Scrolls to a block or row once its page has rendered it, and flashes a block
 * once. Opening a page replaces what was on screen, so it waits for the page
 * to load, up to `timeoutMs`; a newer reveal replaces one still waiting.
 * Returns a function that stops the wait.
 */
export function revealPageTarget(target: PageRevealTarget, timeoutMs = REVEAL_WAIT_MS): () => void {
  cancelPending?.();
  const deadline = Date.now() + timeoutMs;
  let timer: number | undefined;
  const cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    if (cancelPending === cancel) cancelPending = null;
  };
  const attempt = () => {
    timer = undefined;
    const found = find(target);
    if (!found) {
      if (Date.now() < deadline) timer = window.setTimeout(attempt, POLL_MS);
      else cancel();
      return;
    }
    cancel();
    const still = prefersReducedMotion();
    found.element.scrollIntoView?.({ behavior: still ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
    if (!found.block) return;
    const block = found.element;
    block.removeAttribute('data-reveal-flash');
    void block.offsetWidth;
    block.setAttribute('data-reveal-flash', '');
    window.setTimeout(() => block.removeAttribute('data-reveal-flash'), FLASH_MS);
  };
  cancelPending = cancel;
  attempt();
  return cancel;
}
