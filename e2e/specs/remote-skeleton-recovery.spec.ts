import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

// This window files the thread under `tree`; the server keeps it in
// `tree-moved`, so the tree read answers without it.
const connection = { id: 'skeleton-remote', name: 'Build box', transport: 'ssh', sshHost: 'build+', hasToken: true, createdAt: 1, updatedAt: 1 };
const prefix = '/api/backend-connections/skeleton-remote/proxy';
const rows = [0, 1, 2].map(seq => ({ id: `m${seq}`, node_id: 'node', role: seq % 2 ? 'assistant' : 'user',
  content: `Moved history ${seq}`, seq, created_at: seq + 1 }));
const workspace = { workspace: { id: 'ws', name: 'Remote skeleton', active_tree_id: 'tree', created_at: 1 },
  trees: [{ id: 'tree', workspace_id: 'ws', root_node_id: 'node', created_at: 1, last_active_at: 1 }],
  nodes: [{ id: 'node', workspace_id: 'ws', tree_id: 'tree', title: 'Moved conversation', runtime_id: 'mock', acp_session_id: 'node',
    status: 'idle', message_count: rows.length, created_at: 1 }],
  edges: [], messages: [], contexts: [] };

interface RemoteState { offline: boolean; nodeReads: 'ok' | 'fail' }

async function openMovedThread(page: Page, state: RemoteState, reads: URL[]) {
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
      await route.fulfill({ json: { messages: [], pages: [], turns: [] } });
      return true;
    }
    if (path === '/nodes/node/workspace') { await route.fulfill({ json: { workspaceId: 'ws', treeId: 'tree-moved' } }); return true; }
    if (path === '/workspaces/ws/trees/tree-moved/messages') {
      reads.push(url);
      if (state.nodeReads === 'fail') { await route.fulfill({ status: 500, json: { error: 'database is locked' } }); return true; }
      await route.fulfill({ json: { messages: rows, pages: [{ nodeId: 'node', total: rows.length, before: null }], turns: [] } });
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
  const remote = page.getByTestId('workspace-row-remote:skeleton-remote:ws');
  await expect(remote).toBeVisible();
  await remote.getByText('Moved conversation', { exact: true }).click();
  await expect(page.getByTestId('messages-loading')).toBeVisible();
}

test.describe('conversation loading skeleton', () => {
  test('a thread the tree read leaves out loads itself from the server\'s thread', async ({ page }) => {
    const reads: URL[] = [];
    await openMovedThread(page, { offline: false, nodeReads: 'ok' }, reads);
    await expect(page.getByText('Moved history 2', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('messages-loading')).toHaveCount(0);
    expect(reads.filter(url => url.pathname.endsWith('/trees/tree-moved/messages'))
      .every(url => url.searchParams.get('nodeId') === 'node')).toBe(true);
    const diagnostics = await page.evaluate(() => (globalThis as { __michiLoadDiagnostics?: unknown[] }).__michiLoadDiagnostics);
    expect(diagnostics).toEqual([expect.objectContaining({
      type: 'message_load_slow', nodeId: 'remote:skeleton-remote:node', reason: 'no_request_issued',
      lastOutcome: 'responded', ended: 'installed',
    })]);
  });

  test('says it is still loading and retries at once on request', async ({ page }) => {
    const state: RemoteState = { offline: false, nodeReads: 'fail' };
    await openMovedThread(page, state, []);
    const status = page.getByTestId('messages-loading').getByRole('status');
    await expect(status).toHaveText('Still loading…', { timeout: 12_000 });
    state.nodeReads = 'ok';
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('Moved history 2', { exact: true })).toBeVisible({ timeout: 3_000 });
  });

  test('names the connection while it reconnects', async ({ page }) => {
    const state: RemoteState = { offline: false, nodeReads: 'fail' };
    await openMovedThread(page, state, []);
    state.offline = true;
    const status = page.getByTestId('messages-loading').getByRole('status');
    await expect(status).toHaveText('Reconnecting to Build box…', { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    state.offline = false;
    state.nodeReads = 'ok';
    await expect(page.getByText('Moved history 2', { exact: true })).toBeVisible({ timeout: 30_000 });
  });
});
