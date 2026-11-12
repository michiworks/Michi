import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openArea, openSettings, openThreadFromSidebar, selectSettingsSection } from '../fixtures/shell';
import { createSpacesLiveUpdatesMock, liveAssistant, liveWorkspace, LIVE_PAGE_ID } from '../fixtures/spacesLiveUpdatesFixtures';

/**
 * Drawer text sizes on a 390px phone at the 小 and 大 text-size presets:
 * Background work, Artifacts and Settings, as getComputedStyle reads them.
 * The body steps up; the header and a Pages view keep the preset's sizes. A
 * wide window's drawer keeps the desktop sizes.
 */

type Preset = 's' | 'l';

const now = Date.now();

const subagent = {
  sessionId: 'toolu_agent', parentToolCallId: 'toolu_agent', sessionName: 'Map the auth flow', agentName: 'Explore',
  initialQuery: 'Map the auth flow', description: 'Map the auth flow', status: 'terminated', outcome: 'completed',
  group: '', dependsOn: [], prompt: 'Find every place the session cookie is read.', model: 'haiku', source: 'claude',
  result: 'Three readers.', usage: { totalTokens: 12_400, durationMs: 4_200 },
};

const run = {
  version: 1, id: 'wfr_a', runtime: 'claude', nativeId: 'n_wfr_a', workspaceId: 'pdt-ws', nodeId: 'pdt-node',
  parentToolCallId: 'toolu_wf', name: 'read-probe', description: 'Two parallel agents read alpha.txt and beta.txt',
  definition: "phase('read')", status: 'running',
  nodes: [
    { id: 'phase:1', kind: 'phase', title: 'read', status: 'running' },
    { id: 'agent:1', parentId: 'phase:1', kind: 'agent', title: 'alpha', status: 'running', currentTool: 'Read alpha.txt' },
  ],
  log: [], actions: ['stop'], startedAt: now - 4 * 60_000, updatedAt: now, revision: 1,
};

const workspace = {
  workspace: { id: 'pdt-ws', name: 'Michi', active_tree_id: 'pdt-tree', created_at: 1 },
  trees: [{ id: 'pdt-tree', workspace_id: 'pdt-ws', root_node_id: 'pdt-node', name: 'Auth audit', created_at: 1, last_active_at: 1 }],
  nodes: [{ id: 'pdt-node', workspace_id: 'pdt-ws', tree_id: 'pdt-tree', kind: 'chat', title: 'Auth audit', runtime_id: 'claude', status: 'idle', created_at: 1 }],
  edges: [],
  contexts: [
    { id: 'ctx-1', name: 'auth-flow-notes', file_path: 'notes/auth-flow.md', type: 'doc', source: 'agent', origin_node_id: 'pdt-node', created_at: now - 5 * 60_000, updated_at: now - 5 * 60_000, size: 2400 },
  ],
  messages: [
    { id: 'ask', node_id: 'pdt-node', role: 'user', seq: 1, content: 'Audit the auth flow.' },
    {
      id: 'answer', node_id: 'pdt-node', role: 'assistant', seq: 2, content: 'Delegated the audit.',
      tool_calls: JSON.stringify([
        { id: 'toolu_agent', title: 'Agent', status: 'completed', kind: 'tool', detail: JSON.stringify({ subagent_type: 'Explore', description: 'Map the auth flow' }) },
        { id: 'toolu_wf', title: 'Workflow', status: 'completed', kind: 'tool' },
      ]),
      blocks: JSON.stringify([
        { id: 'b0', kind: 'tool', toolCallId: 'toolu_agent', section: 'answer', rawOffset: 0 },
        { id: 'b1', kind: 'tool', toolCallId: 'toolu_wf', section: 'answer', rawOffset: 0 },
        { id: 'b2', kind: 'answer', rawText: 'Delegated the audit.' },
      ]),
      metadata: JSON.stringify({ subagents: [subagent] }),
    },
  ],
};

async function boot(page: Page, preset: Preset) {
  const prefs = { onboardingCompletedAt: 1, sidebarCollapsed: false, phoneTextSize: preset };
  const custom = async (route: Route): Promise<boolean> => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    const method = route.request().method();
    if (method === 'GET' && path === '/prefs') { await route.fulfill({ json: { prefs } }); return true; }
    if (method === 'GET' && path === '/workflow-runs/subscribe') {
      await route.fulfill({
        status: 200, headers: { 'content-type': 'text/event-stream' },
        body: `event: workflow_run\ndata: ${JSON.stringify({ version: 1, event: 'workflow_run', run, emittedAt: now })}\n\n`,
      });
      return true;
    }
    if (method === 'GET' && /^\/workflow-runs\/[^/]+$/.test(path)) { await route.fulfill({ json: { run } }); return true; }
    if (path === '/workflow-runs') { await route.fulfill({ json: { runs: [run] } }); return true; }
    if (path === '/agent-runs') { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/agent-runs/subscribe') { await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true; }
    return false;
  };
  await installMockApi(page, { workspaces: [workspace], custom });
  await page.addInitScript((p) => localStorage.setItem('michi:v1:prefs', JSON.stringify(p)), prefs);
  await page.goto('/');
  await openThreadFromSidebar(page, 'Auth audit');
  await expect(page.locator('[data-msg-id="answer"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.phoneText)).toBe(preset);
}

async function px(locator: Locator): Promise<number> {
  await expect(locator).toBeVisible();
  return locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

async function backgroundWork(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('michi:open-background-work', { detail: { nodeId: 'pdt-node' } })));
  const drawer = page.getByRole('dialog', { name: 'Background work' });
  const sizes = {
    title: await px(drawer.locator('.ui-overlay-title')),
    running: await px(drawer.getByTestId('background-work-running')),
    scope: await px(drawer.getByRole('button', { name: /^Show background work for:/ })),
    runDescription: await px(drawer.getByText(run.description, { exact: true })),
    subagentName: await px(drawer.getByText('Map the auth flow', { exact: true })),
    kindLine: await px(drawer.getByText('Workflow · Claude Code', { exact: true })),
  };
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  return sizes;
}

async function artifacts(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('michi:toggle-artifacts', { detail: null })));
  const drawer = page.getByRole('dialog', { name: 'Artifacts' });
  const sizes = {
    title: await px(drawer.locator('.ui-overlay-title')),
    count: await px(drawer.locator('.ui-overlay-header').getByText('1', { exact: true })),
    name: await px(drawer.locator('.artifacts-row__title').filter({ hasText: 'auth-flow-notes' })),
    meta: await px(drawer.locator('.artifacts-row__meta').first()),
  };
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  return sizes;
}

async function settings(page: Page) {
  const main = await openSettings(page);
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  const list = {
    title: await px(drawer.locator('.ui-overlay-title')),
    groupLabel: await px(main.locator('.settings-phone__heading').filter({ hasText: 'Agent' })),
    rowLabel: await px(main.locator('.settings-phone__label').filter({ hasText: 'Runtime & model' })),
    rowValue: await px(main.locator('.settings-phone__value').first()),
  };
  await selectSettingsSection(page, 'Notifications');
  const notifications = {
    rowLabel: await px(main.locator('.settings-row__label').filter({ hasText: 'Notification sounds' })),
    rowDescription: await px(main.locator('.settings-row__desc').first()),
    optionDescription: await px(main.locator('.settings-radio__description').first()),
  };
  return { list, notifications };
}

const EXPECTED: Record<Preset, unknown> = {
  s: {
    backgroundWork: { title: 11, running: 11, scope: 11, runDescription: 15, subagentName: 15, kindLine: 13 },
    artifacts: { title: 11, count: 11, name: 15, meta: 12 },
    settings: {
      list: { title: 11, groupLabel: 12, rowLabel: 15, rowValue: 15 },
      notifications: { rowLabel: 15, rowDescription: 13, optionDescription: 13 },
    },
  },
  l: {
    backgroundWork: { title: 13, running: 13, scope: 13, runDescription: 17, subagentName: 17, kindLine: 15 },
    artifacts: { title: 13, count: 13, name: 17, meta: 14 },
    settings: {
      list: { title: 13, groupLabel: 14, rowLabel: 17, rowValue: 17 },
      notifications: { rowLabel: 17, rowDescription: 15, optionDescription: 15 },
    },
  },
};

for (const preset of ['s', 'l'] as const) {
  test(`phone drawers at the ${preset === 's' ? '小' : '大'} preset read the expected text sizes`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page, preset);
    const measured = {
      backgroundWork: await backgroundWork(page),
      artifacts: await artifacts(page),
      settings: await settings(page),
    };
    expect(measured).toEqual(EXPECTED[preset]);
  });
}

test('a wide window keeps the desktop drawer sizes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await boot(page, 'l');
  expect(await backgroundWork(page)).toEqual({ title: 11, running: 11, scope: 11, runDescription: 12, subagentName: 12, kindLine: 11 });
});

test('a Pages view in a phone drawer reads at the size of the page inline', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = createSpacesLiveUpdatesMock();
  mock.pages.set(LIVE_PAGE_ID, { ...mock.pages.get(LIVE_PAGE_ID)!, blocks: [
    { id: 'intro', rev: 1, type: 'markdown', text: 'The recommendation is staged rollout. [Read the evidence](#view/evidence).' },
    { id: 'rollout', rev: 1, type: 'code', code: 'rollout(0.1)', lang: 'ts' },
    { id: 'evidence-view', rev: 1, type: 'view', viewId: 'evidence', title: 'Recommendation evidence', blockIds: ['pilot'] },
    { id: 'pilot', rev: 1, type: 'code', code: 'pilot()', lang: 'ts', visibility: 'detail' },
  ] });
  const prefs = { onboardingCompletedAt: 1, phoneTextSize: 'l' };
  await installMockApi(page, { workspaces: [liveWorkspace, liveAssistant], custom: async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (route.request().method() === 'GET' && path === '/prefs') { await route.fulfill({ json: { prefs } }); return true; }
    return mock.handle(route);
  } });
  await page.addInitScript((p) => localStorage.setItem('michi:v1:prefs', JSON.stringify(p)), prefs);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.phoneText)).toBe('l');
  await openArea(page, 'spaces');
  await page.getByRole('button', { name: 'Release work', exact: true }).first().click();
  await page.locator('.spaces-home-space-card').filter({ hasText: 'Live release' }).click();
  const main = page.getByRole('main', { name: 'Live release', exact: true });
  const inline = await px(main.locator('.michi-doc-block[data-block-id="rollout"] .michi-doc-code-lang'));
  await main.getByRole('link', { name: 'Read the evidence', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Recommendation evidence', exact: true });
  expect(await px(drawer.locator('.michi-doc-block[data-block-id="pilot"] .michi-doc-code-lang'))).toBe(inline);
});
