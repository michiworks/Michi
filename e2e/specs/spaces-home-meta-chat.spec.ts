import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { areaButton, openArea } from '../fixtures/shell';
import { createSpacesHomeMock } from '../fixtures/spacesHomeFixtures';

const assistantWorkspace = {
  workspace: { id: 'ws-assistant', name: 'Assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }), active_tree_id: 'tree-assistant' },
  trees: [{ id: 'tree-assistant', workspace_id: 'ws-assistant', root_node_id: 'assistant-node', name: 'Assistant', created_at: 1 }],
  nodes: [{ id: 'assistant-node', workspace_id: 'ws-assistant', tree_id: 'tree-assistant', kind: 'chat', title: 'Assistant', runtime_id: 'mock', status: 'idle', created_at: 1 }],
  edges: [], messages: [], contexts: [], artifacts: [],
};
const workspace = {
  workspace: { id: 'ws-release', name: 'Release work', created_at: 1 },
  trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [],
};

test('Pages opens on its Home, a workspace home opens from the sidebar, and ⌘J opens the one panel beside it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const spaces = createSpacesHomeMock({
    homeBlocks: [{ id: 'home-lead', rev: 1, type: 'markdown', text: 'Two threads moved overnight.' }],
    workspaceHomes: { 'ws-release': { name: 'Release work', blocks: [{ id: 'ws-lead', rev: 1, type: 'markdown', text: 'The release is waiting on QA.' }] } },
  });
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
    localStorage.setItem('michi:migrated', '1');
  });
  const assistantInfo = { nodeId: 'assistant-node', treeId: 'tree-assistant', workspaceId: 'ws-assistant', settings: { runtimeId: 'mock', modelId: null, reasoning: null }, supportedRuntimes: ['mock'] };
  await installMockApi(page, {
    workspaces: [workspace, assistantWorkspace],
    custom: async (route) => {
      // The panel stands on the one conversation (`/assistant`).
      if (new URL(route.request().url()).pathname === '/api/assistant') { await route.fulfill({ json: assistantInfo }); return true; }
      return spaces.handle(route);
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();

  // The rail's Spaces button always lands on the Spaces Home.
  await openArea(page, 'spaces');
  await expect(areaButton(page, 'spaces')).toHaveAttribute('aria-current', 'page');
  const home = page.locator('main.spaces-home');
  await expect(home.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await expect(home.getByText('Two threads moved overnight.')).toBeVisible();
  const sidebar = page.locator('.spaces-side');
  await expect(sidebar.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');

  // A workspace row opens that workspace's home.
  await sidebar.getByRole('button', { name: /^Release work/ }).click();
  const workspaceHome = page.getByRole('main', { name: 'Release work' });
  await expect(workspaceHome.getByRole('heading', { name: 'Release work', level: 1 })).toBeVisible();
  await expect(workspaceHome.getByText('The release is waiting on QA.')).toBeVisible();
  await expect(sidebar.locator('[data-workspace="ws-release"]')).toHaveAttribute('aria-current', 'page');
  expect(spaces.requests).toContain('GET /workspaces/ws-release/home');

  // Browser-style history returns to this exact workspace home, not global Home.
  await openArea(page, 'conversations');
  await page.getByRole('button', { name: 'Navigate back', exact: true }).click();
  await expect(workspaceHome.getByRole('heading', { name: 'Release work', level: 1 })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+]');
  await expect(areaButton(page, 'conversations')).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('ControlOrMeta+[');
  await expect(workspaceHome.getByRole('heading', { name: 'Release work', level: 1 })).toBeVisible();


  // Pages has no window of its own (DESIGN-v2 §1.4); ⌘J opens the one panel beside the page.
  await expect(page.locator('.meta-chat-area, button.meta-chat-pill')).toHaveCount(0);
  const panel = page.getByRole('complementary', { name: 'Michi', exact: true });
  await expect(panel).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-layout', 'docked');
  await expect(workspaceHome.getByRole('heading', { name: 'Release work', level: 1 })).toBeVisible();
  const [pageBox, panelBox] = await Promise.all([workspaceHome.boundingBox(), panel.boundingBox()]);
  expect(pageBox!.x + pageBox!.width).toBeLessThanOrEqual(panelBox!.x + 1);

  // ⌘J from inside closes it; ⌘J brings it back.
  await panel.getByRole('tab', { name: /Chat/ }).focus();
  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel).toBeVisible();

  // The panel is not Pages': it stays open in Conversations and on return.
  await openArea(page, 'conversations');
  await expect(panel).toBeVisible();
  await openArea(page, 'spaces');
  await expect(home.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await expect(panel).toBeVisible();
  expect(errors).toEqual([]);
});
