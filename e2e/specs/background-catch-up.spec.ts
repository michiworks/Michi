import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

// 2026-11-09: the background feed could not stay connected, so a self-turn
// that finished in SQLite never reached the open pane. Coming back to the
// window must show it without the feed.
const row = (seq: number, role: 'user' | 'assistant', content: string) => ({
  id: `m${seq}`, node_id: 'n-catch', role, content, seq, created_at: seq + 1,
});
const before = [row(0, 'user', 'Research this for me'), row(1, 'assistant', 'Nine agents are still running.')];
const after = [...before, row(2, 'assistant', 'The report is ready.')];

const workspace = (messageCount: number, turnId: string, seq: number) => ({
  workspace: { id: 'ws', name: 'Catch-up', active_tree_id: 'tree', created_at: 1 },
  trees: [{ id: 'tree', workspace_id: 'ws', root_node_id: 'n-catch', created_at: 1, last_active_at: 1 }],
  nodes: [{ id: 'n-catch', workspace_id: 'ws', tree_id: 'tree', title: 'Self-turn thread', runtime_id: 'mock',
    acp_session_id: 'n-catch', status: 'idle', message_count: messageCount, created_at: 1,
    last_applied_turn_id: turnId, last_applied_seq: seq }],
  edges: [], messages: [], contexts: [],
});

test('a window back in the foreground shows a self-turn the feed never delivered', async ({ page }) => {
  let selfTurnDone = false;
  const cursorReads: string[][] = [];
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 })));
  await installMockApi(page, { workspaces: [workspace(2, 'turn-1', 3)], custom: async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    if (path === '/chats/background/subscribe') {
      // The feed opens and says nothing: it carries none of the self-turn.
      await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' });
      return true;
    }
    if (path === '/chats/background/cursors') {
      cursorReads.push((route.request().postDataJSON() as { chatIds: string[] }).chatIds);
      const cursor = selfTurnDone ? { turnId: 'turn-self', seq: 9 } : { turnId: 'turn-1', seq: 3 };
      await route.fulfill({ json: { cursors: { 'n-catch': { ...cursor, nodeId: 'n-catch' } } } });
      return true;
    }
    if (path === '/workspaces/ws') {
      await route.fulfill({ json: selfTurnDone ? workspace(3, 'turn-self', 9) : workspace(2, 'turn-1', 3) });
      return true;
    }
    if (path === '/workspaces/ws/trees/tree/messages') {
      const rows = selfTurnDone ? after : before;
      await route.fulfill({ json: { messages: rows, pages: [{ nodeId: 'n-catch', total: rows.length, before: null }], turns: [] } });
      return true;
    }
    return false;
  } });

  await page.goto('/');
  await page.getByTestId('workspace-row-ws').getByText('Self-turn thread', { exact: true }).click();
  await expect(page.getByText('Nine agents are still running.', { exact: true })).toBeVisible();
  await expect.poll(() => cursorReads.length, { message: 'the opened pane checked itself' }).toBeGreaterThan(0);

  selfTurnDone = true;
  await expect(page.getByText('The report is ready.', { exact: true })).toHaveCount(0);
  // Come back to the window (hidden, then visible) until the check runs again.
  await expect.poll(async () => {
    await page.evaluate(() => {
      for (const state of ['hidden', 'visible'] as const) {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
        document.dispatchEvent(new Event('visibilitychange'));
      }
    });
    return page.getByText('The report is ready.', { exact: true }).count();
  }, { timeout: 15_000, intervals: [500] }).toBe(1);
  expect(cursorReads.every((chatIds) => chatIds.includes('n-catch'))).toBe(true);
});
