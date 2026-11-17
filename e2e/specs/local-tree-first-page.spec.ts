import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

// A local tree opens on its first page in the phone layout, which the phone
// through the mobile gateway gets, and a long one in any window
// (frontend/src/state/treeMessageRequests.ts opensOnFirstPage): reading and
// mounting a whole long tree took a phone seconds. Older history pages in
// as on a remote tree.

async function openLocalTree(page: Page, length: number, node: Record<string, unknown> = {}) {
  const rows = Array.from({ length }, (_, seq) => ({ id: `m${seq}`, node_id: 'node', role: seq % 2 ? 'assistant' : 'user',
    content: `History item ${seq}`, seq, created_at: seq + 1 }));
  const workspace = { workspace: { id: 'ws', name: 'Local history', active_tree_id: 'tree', created_at: 1 },
    trees: [{ id: 'tree', workspace_id: 'ws', root_node_id: 'node', created_at: 1, last_active_at: 1 }],
    nodes: [{ id: 'node', workspace_id: 'ws', tree_id: 'tree', title: 'Long conversation', runtime_id: 'mock', status: 'idle',
      message_count: length, created_at: 1, ...node }],
    edges: [], messages: [], artifacts: [] };
  const reads: URL[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 })));
  await installMockApi(page, { workspaces: [workspace], custom: async route => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/workspaces/ws/trees/tree/messages') return false;
    reads.push(url);
    if (!url.searchParams.has('limit')) { await route.fulfill({ json: { messages: rows } }); return true; }
    const limit = Number(url.searchParams.get('limit'));
    const end = Number(url.searchParams.get('beforeSeq') ?? rows.length);
    const messages = rows.slice(Math.max(0, end - limit), end);
    await route.fulfill({ json: { messages, pages: [{ nodeId: 'node', total: rows.length,
      before: end > limit ? { id: messages[0].id, seq: messages[0].seq } : null }] } });
    return true;
  } });
  await page.goto('/');
  await openThreadFromSidebar(page, 'Long conversation');
  await expect(page.getByText(`History item ${length - 1}`, { exact: true })).toBeVisible();
  return { reads, errors };
}

for (const [layout, viewport, length] of [
  ['the phone layout', { width: 390, height: 844 }, 120],
  ['a desktop window, when the tree is long', { width: 1280, height: 850 }, 320],
] as const) {
  test(`a local tree opens on its last page in ${layout} and reads older pages when asked`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { reads, errors } = await openLocalTree(page, length);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(url => url.searchParams.get('limit') === '15' && !url.searchParams.has('nodeId'))).toBe(true);
    await expect(page.getByText(`History item ${length - 16}`, { exact: true })).toHaveCount(0);

    const transcript = page.locator('.terminal-pane__transcript:visible').first();
    await transcript.hover();
    await page.mouse.wheel(0, -100_000);
    await page.getByRole('button', { name: 'Load older messages', exact: true }).click();
    await expect(page.getByText(`History item ${length - 16}`, { exact: true })).toBeAttached();
    expect(reads.at(-1)?.searchParams.get('nodeId')).toBe('node');
    expect(reads.at(-1)?.searchParams.get('beforeSeq')).toBe(String(length - 15));
    expect(errors).toEqual([]);
  });
}

test('a phone lands on the first unread reply when the unread replies reach past the first page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Ten unread replies: the first page (items 105-119) holds eight of them.
  const { reads, errors } = await openLocalTree(page, 120, { completion_seq: 60, seen_completion_seq: 50 });
  await expect.poll(() => reads.some(url => url.searchParams.get('beforeSeq') === '105')).toBe(true);
  // Item 101 is the tenth reply from the end; item 100 asked for it.
  const transcript = page.locator('.terminal-pane__transcript:visible').first();
  const question = transcript.getByText('History item 100', { exact: true });
  await expect.poll(async () => {
    const box = await transcript.boundingBox();
    const at = await question.boundingBox();
    return box && at ? (at.y - box.y) / box.height : null;
  }).toBeLessThan(0.5);
  await expect(question).toBeInViewport();
  expect(errors).toEqual([]);
});
