import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

/** A remote conversation of 120 messages whose backend answers in pages; `state.offline` makes it fail. */
async function pagedRemote(page: Page) {
  const connection = { id: 'paged-remote', name: 'Remote', transport: 'ssh', sshHost: 'build+', hasToken: true, createdAt: 1, updatedAt: 1 };
  const prefix = '/api/backend-connections/paged-remote/proxy';
  const rows = Array.from({ length: 120 }, (_, seq) => ({ id: `m${seq}`, node_id: 'node', role: seq % 2 ? 'assistant' : 'user',
    content: `History item ${seq}`, seq, created_at: seq + 1 }));
  const workspace = { workspace: { id: 'ws', name: 'Remote history', active_tree_id: 'tree', created_at: 1 },
    trees: [{ id: 'tree', workspace_id: 'ws', root_node_id: 'node', created_at: 1, last_active_at: 1 }],
    nodes: [{ id: 'node', workspace_id: 'ws', tree_id: 'tree', title: 'Long conversation', runtime_id: 'mock', acp_session_id: 'node', status: 'idle', message_count: 120, created_at: 1 }],
    edges: [], messages: [], contexts: [] };
  const reads: URL[] = [];
  const state = { offline: false };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 })));
  await installMockApi(page, { workspaces: [], custom: async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/backend-connections') { await route.fulfill({ json: { connections: [connection] } }); return true; }
    if (!url.pathname.startsWith(prefix)) return false;
    const path = url.pathname.slice(prefix.length);
    if (state.offline) { await route.fulfill({ status: 503, json: { error: 'Temporarily offline' } }); return true; }
    if (path === '/workspaces/all') { await route.fulfill({ json: { workspaces: [workspace] } }); return true; }
    if (path === '/workspaces/ws/trees/tree/messages') {
      reads.push(url);
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
  // The renderer's ids of the conversation and its messages (namespaced for the remote).
  const ids = await page.getByText('History item 119', { exact: true }).evaluate((el) => ({
    node: el.closest('[data-node-id]')!.getAttribute('data-node-id')!,
    newest: el.closest('[data-msg-id]')!.getAttribute('data-msg-id')!,
  }));
  return { reads, state, errors, remote, nodeId: ids.node, messageId: (seq: number) => ids.newest.replace(/m119$/, `m${seq}`) };
}

test('remote history opens at the recent page, loads older messages, and survives an offline/reconnect cycle', async ({ page }) => {
  const { reads, state, errors, remote } = await pagedRemote(page);
  // The first page over a tunnel is short (the last screenful); older pages are full size.
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every(url => url.searchParams.get('limit') === '15' && !url.searchParams.has('nodeId'))).toBe(true);
  await expect(page.getByText('History item 0', { exact: true })).toHaveCount(0);
  await expect(page.getByText('History item 104', { exact: true })).toHaveCount(0);
  const older = page.getByRole('button', { name: 'Load older messages', exact: true });
  const transcript = page.locator('.terminal-pane__transcript').first();
  // Real reader input cancels an in-progress restore. Programmatic scrolling
  // alone can race the preceding page's content-visibility settling pass.
  const scrollToHistoryStart = async () => {
    await transcript.hover();
    await page.mouse.wheel(0, -100_000);
    await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBe(0);
  };
  // Each older page keeps the reader's place: what was first stays put.
  const loadOlder = async (firstShown: number, firstLoaded: number) => {
    await scrollToHistoryStart();
    const anchor = page.getByText(`History item ${firstShown}`, { exact: true });
    const anchorTop = (await anchor.boundingBox())!.y;
    await older.click();
    await expect(page.getByText(`History item ${firstLoaded}`, { exact: true })).toBeAttached();
    await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - anchorTop)).toBeLessThan(3);
    expect(reads.at(-1)?.searchParams.get('beforeSeq')).toBe(String(firstShown));
    expect(reads.at(-1)?.searchParams.get('nodeId')).toBe('node');
    expect(reads.at(-1)?.searchParams.get('limit')).toBe('50');
  };
  await loadOlder(105, 55);
  await loadOlder(55, 5);
  await loadOlder(5, 0);
  await expect(older).toHaveCount(0);
  const composer = page.locator(COMPOSER_EDITOR).first();
  await composer.fill('Keep this unsent draft');
  const readsBefore = reads.length;
  state.offline = true;
  await page.evaluate(async () => {
    const path = '/src/services/api/backendRequest.ts';
    const { backendFetch } = await import(path);
    await backendFetch('/api/backend-connections/paged-remote/proxy/agent/status');
  });
  await expect(remote).toBeVisible();
  await expect(composer).toContainText('Keep this unsent draft');
  await expect(page.getByText('History item 0', { exact: true })).toBeAttached();
  state.offline = false;
  await expect.poll(() => page.evaluate(async () => {
    const path = '/src/config/backendConnectionState.ts';
    const { backendConnectionUnavailable } = await import(path);
    return backendConnectionUnavailable('paged-remote');
  })).toBe(false);
  await expect(composer).toContainText('Keep this unsent draft');
  await expect(page.getByText('History item 0', { exact: true })).toHaveCount(1);
  expect(reads.length).toBe(readsBefore);
  expect(errors).toEqual([]);
});

test('a jump to a message older than the loaded page reads back to it', async ({ page }) => {
  const { reads, errors, nodeId, messageId } = await pagedRemote(page);
  await page.evaluate(async ({ node, message }) => {
    const path = '/src/state/sourceNav/sourceNav.ts';
    const { requestMessageJump } = await import(path);
    requestMessageJump(node, message);
  }, { node: nodeId, message: messageId(3) });
  await expect(page.getByText('History item 3', { exact: true })).toBeInViewport();
  expect(reads.filter(url => url.searchParams.get('nodeId') === 'node').length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('find reads the older pages before it counts', async ({ page }) => {
  const { nodeId } = await pagedRemote(page);
  await page.evaluate((node) => window.dispatchEvent(new CustomEvent('michi:open-pane-find', { detail: { nodeId: node } })), nodeId);
  const pane = page.locator(`[data-node-id="${nodeId}"]`);
  await pane.locator('.t-pane-find-input').fill('History item 3');
  // "History item 3" and 30 to 39, all on pages older than the first one.
  await expect(pane.locator('.t-pane-find-counter')).toHaveText('1 / 11');
});
