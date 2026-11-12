import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

// Scrolling up through a paged conversation loads the previous page before
// the reader reaches the top, without the "Load older messages" button, and
// keeps what the reader is looking at in place. Opening it loads nothing old.
test('reading upward loads older history on its own and keeps the viewport still', async ({ page }) => {
  const connection = { id: 'paged-remote', name: 'Remote', transport: 'ssh', sshHost: 'build+', hasToken: true, createdAt: 1, updatedAt: 1 };
  const prefix = '/api/backend-connections/paged-remote/proxy';
  const rows = Array.from({ length: 120 }, (_, seq) => ({ id: `m${seq}`, node_id: 'node', role: seq % 2 ? 'assistant' : 'user',
    content: `History item ${seq}\n\n${'Padding so every message takes a few lines of the pane. '.repeat(6)}`, seq, created_at: seq + 1 }));
  const workspace = { workspace: { id: 'ws', name: 'Remote history', active_tree_id: 'tree', created_at: 1 },
    trees: [{ id: 'tree', workspace_id: 'ws', root_node_id: 'node', created_at: 1, last_active_at: 1 }],
    nodes: [{ id: 'node', workspace_id: 'ws', tree_id: 'tree', title: 'Long conversation', runtime_id: 'mock', acp_session_id: 'node', status: 'idle', message_count: 120, created_at: 1 }],
    edges: [], messages: [], contexts: [] };
  const reads: URL[] = [];
  // Older pages wait for the test, so it can see the viewport before they land.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 })));
  await installMockApi(page, { workspaces: [], custom: async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/backend-connections') { await route.fulfill({ json: { connections: [connection] } }); return true; }
    if (!url.pathname.startsWith(prefix)) return false;
    const path = url.pathname.slice(prefix.length);
    if (path === '/workspaces/all') { await route.fulfill({ json: { workspaces: [workspace] } }); return true; }
    if (path === '/workspaces/ws/trees/tree/messages') {
      reads.push(url);
      if (url.searchParams.has('beforeSeq')) await gate;
      const limit = Number(url.searchParams.get('limit') ?? rows.length);
      const end = Number(url.searchParams.get('beforeSeq') ?? rows.length);
      const messages = rows.slice(Math.max(0, end - limit), end);
      await route.fulfill({ json: { messages, pages: [{ nodeId: 'node', total: rows.length,
        before: end > limit ? { id: messages[0].id, seq: messages[0].seq } : null }] } });
      return true;
    }
    if (path === '/health') { await route.fulfill({ json: { service: 'michi-backend', status: 'healthy' } }); return true; }
    if (path === '/chats/background/subscribe') { await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true; }
    if (path === '/agent/status') { await route.fulfill({ json: { runtime: 'mock', label: 'Mock', hasRequiredKey: true, capabilities: {},
      availableRuntimes: [{ id: 'mock', label: 'Mock', available: true }] } }); return true; }
    if (path === '/ready') { await route.fulfill({ json: { status: 'ready' } }); return true; }
    await route.fulfill({ json: { ok: true } }); return true;
  } });
  await page.goto('/');
  const remote = page.getByTestId('workspace-row-remote:paged-remote:ws');
  await expect(remote).toBeVisible();
  await remote.getByText('Long conversation', { exact: true }).click();
  await expect(page.getByText('History item 119', { exact: true })).toBeVisible();
  // Opening (and its positioning pass) reads only the recent page.
  await page.waitForTimeout(800);
  expect(reads.filter(url => url.searchParams.has('beforeSeq'))).toHaveLength(0);
  await expect(page.getByText('History item 104', { exact: true })).toHaveCount(0);

  const transcript = page.locator('.terminal-pane__transcript').first();
  await transcript.hover();
  // Read upward a screen at a time until the older page is requested.
  for (let i = 0; i < 60 && reads.every(url => !url.searchParams.has('beforeSeq')); i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(50);
  }
  expect(reads.find(url => url.searchParams.has('beforeSeq'))?.searchParams.get('beforeSeq')).toBe('105');
  expect(await transcript.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  // The message in view before the page lands stays where it is after.
  await page.waitForTimeout(300);
  const inView = await transcript.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const msg = Array.from(el.querySelectorAll<HTMLElement>('[data-msg-id]')).find(f => f.getBoundingClientRect().bottom > top + 1)!;
    return { id: msg.dataset.msgId!, y: msg.getBoundingClientRect().top };
  });
  release();
  await expect(page.getByText('History item 55', { exact: true })).toBeAttached();
  const anchor = transcript.locator(`[data-msg-id="${inView.id}"]`);
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - inView.y)).toBeLessThan(3);
  await page.waitForTimeout(400);
  expect(Math.abs((await anchor.boundingBox())!.y - inView.y)).toBeLessThan(3);
  // One read per page, no duplicates from the burst of scroll events.
  expect(reads.filter(url => url.searchParams.get('beforeSeq') === '105')).toHaveLength(1);
});
