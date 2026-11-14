import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { createCompanionMock } from '../fixtures/companionFixtures';
import { createSpacesHomeMock } from '../fixtures/spacesHomeFixtures';
import { leaveSettings, openArea } from '../fixtures/shell';

// Michi off (Q29, Q30): no button or ⌘J, and once a toast says where to turn it on (item 1).
// Pages' Ask still opens its conversation (item 2), with nothing of its own running.

const runs = { runtimeId: 'mock', providerId: null, modelId: null, reasoning: null };
const assistant = { nodeId: 'companion-node', treeId: 'tree-companion', workspaceId: 'ws-assistant', settings: runs, conversation: runs,
  conversationFollowsGlobal: true, supportedRuntimes: ['mock'] };
const answer = 'The release notes are the last open item.';
const assistantWorkspace = {
  workspace: { id: 'ws-assistant', name: 'Assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }), active_tree_id: 'tree-companion' },
  trees: [{ id: 'tree-companion', workspace_id: 'ws-assistant', root_node_id: 'companion-node', name: 'Michi', created_at: 1, archived_at: null }],
  nodes: [{ id: 'companion-node', workspace_id: 'ws-assistant', tree_id: 'tree-companion', kind: 'chat', title: 'Michi', runtime_id: 'mock', status: 'idle', created_at: 1 }],
  messages: [{ id: 'a-0', node_id: 'companion-node', role: 'assistant', seq: 0, content: answer }], edges: [], contexts: [], artifacts: [],
};

test('off, Michi says once where to turn it on, and Pages\' Ask still opens its conversation (Q29)', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const companion = createCompanionMock({ conversation: { workspaceId: 'ws-assistant', nodeId: 'companion-node', assistant }, settings: { paused: true }, offNoticeAt: null });
  const spaces = createSpacesHomeMock({
    workspaceHomes: { 'ws-review': { name: 'Release review', blocks: [{ id: 'review-block', rev: 1, type: 'markdown', text: 'Review the desktop build and confirm the release notes.' }] } },
  });
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:companion:opened', '1');
  });
  await installMockApi(page, {
    workspaces: [{ workspace: { id: 'ws-review', name: 'Release review', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] }, assistantWorkspace],
    custom: async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/assistant') { await route.fulfill({ json: assistant }); return true; }
      if (path === '/api/workspaces/ws-assistant') { await route.fulfill({ json: assistantWorkspace }); return true; }
      if (path.startsWith('/api/workspaces/ws-assistant/trees/') && path.endsWith('/messages')) { await route.fulfill({ json: { messages: assistantWorkspace.messages } }); return true; }
      return (await spaces.handle(route)) || companion.handle(route);
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();

  const notice = page.getByText('Michi is off · Turn it on in Settings');
  await expect(notice).toBeVisible();
  await expect(page.locator('[data-companion-button]')).toHaveCount(0);
  await expect.poll(() => companion.writes).toContain('POST /companion/off-notice');
  await page.getByRole('button', { name: 'Open Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('heading', { level: 1, name: 'Michi', exact: true })).toBeVisible();
  await expect(settings.getByRole('switch', { name: 'Michi', exact: true })).toHaveAttribute('aria-checked', 'false');
  await leaveSettings(page);

  // Said: the backend keeps it for every window and restart (companionRoutes.test.ts), and it does not come back.
  await expect(notice).toHaveCount(0);
  await openArea(page, 'spaces');

  await page.locator('.spaces-side').getByRole('button', { name: /^Release review/ }).click();
  const home = page.getByRole('main', { name: 'Release review', exact: true });
  const block = home.locator('[data-block-id="review-block"]');
  await block.hover();
  await block.getByRole('toolbar').getByRole('button', { name: 'Ask Michi', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Michi', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(answer)).toBeVisible();
  await expect(panel.getByRole('status').first()).toHaveText('Off');
  await expect(page.locator('[data-companion-button]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('michi-off-pages-ask.png') });
  // ⌘J still does nothing while off: it does not close the panel either.
  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel).toBeVisible();
  expect(errors).toEqual([]);
});
