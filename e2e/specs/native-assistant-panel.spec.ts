import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { leaveSettings, openArea, openSettings } from '../fixtures/shell';

/**
 * DESIGN-v2 §1.2: one panel, one conversation, reached the same way in every
 * area. ⌘J opens it on Chat (⇧⌘J on Today) and closes it from inside; ⌘W in
 * it closes it; an Esc on the page leaves a docked panel alone and closes one
 * that covers a narrow window. Pages and Scheduled have no window of their own.
 */

const previousAnswer = 'Start with the desktop acceptance checks, then confirm the release notes.';

async function boot(page: Page) {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/desk') || url.port === '4317') external.push(request.url());
  });
  let current = 'old';
  const resets: unknown[] = [];
  const runs = { runtimeId: 'mock', providerId: null, modelId: null, reasoning: null };
  const assistantInfo = () => ({
    nodeId: `assistant-${current}`, treeId: `tree-${current}`, workspaceId: 'ws-assistant',
    settings: runs, conversation: runs, conversationFollowsGlobal: true, supportedRuntimes: ['mock'],
  });
  const messages = [
    { id: 'question-old', node_id: 'assistant-old', role: 'user', seq: 0, content: 'What should I focus on next?' },
    { id: 'answer-old', node_id: 'assistant-old', role: 'assistant', seq: 1, content: previousAnswer },
  ];
  const ids = () => (current === 'old' ? ['old'] : ['old', 'new']);
  const assistantWorkspace = () => ({
    workspace: { id: 'ws-assistant', name: 'Assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }), active_tree_id: `tree-${current}` },
    trees: ids().map(id => ({ id: `tree-${id}`, workspace_id: 'ws-assistant', root_node_id: `assistant-${id}`, name: 'Assistant', created_at: 1, archived_at: id === 'old' && current === 'new' ? 2 : null })),
    nodes: ids().map(id => ({ id: `assistant-${id}`, workspace_id: 'ws-assistant', tree_id: `tree-${id}`, kind: 'chat', title: 'Assistant', runtime_id: 'mock', status: 'idle', created_at: 1 })),
    messages, edges: [], contexts: [], artifacts: [],
  });
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:companion:opened', '1');
  });
  await installMockApi(page, {
    workspaces: [{ workspace: { id: 'ws-work', name: 'Work', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] }, assistantWorkspace()],
    custom: async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/assistant') { await route.fulfill({ json: assistantInfo() }); return true; }
      if (path === '/api/assistant/reset') {
        resets.push(route.request().postDataJSON());
        current = 'new';
        await route.fulfill({ json: assistantInfo() });
        return true;
      }
      if (path === '/api/workspaces/ws-assistant') { await route.fulfill({ json: assistantWorkspace() }); return true; }
      if (path.includes('/api/workspaces/ws-assistant/trees/') && path.endsWith('/messages')) {
        await route.fulfill({ json: { messages: path.includes('tree-old') ? messages : [] } });
        return true;
      }
      return false;
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  const panel = page.getByRole('complementary', { name: 'Michi', exact: true });
  return { errors, external, resets, panel, editor: panel.locator('.terminal-composer [contenteditable="true"]') };
}

/** Focus back on the page, outside the panel. */
const focusPage = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

test('⌘J and ⇧⌘J open the one panel in every area; ⌘J, ⌘W and Esc in it close it, and an Esc on the page leaves it docked', async ({ page }) => {
  const { errors, external, panel, editor } = await boot(page);
  await expect(panel).toHaveCount(0);

  // Closed: ⌘J opens it on Chat, on the one conversation.
  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-layout', 'docked');
  await expect(panel.getByRole('tab', { name: /Chat/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText(previousAnswer)).toBeVisible();
  // Focus already in it: ⌘J closes it.
  await panel.getByRole('tab', { name: /Chat/ }).focus();
  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel).toHaveCount(0);

  // ⇧⌘J opens it on Today.
  await page.keyboard.press('ControlOrMeta+Shift+J');
  await expect(panel.getByRole('tab', { name: /Today/ })).toHaveAttribute('aria-selected', 'true');
  // Open with focus on the page: ⌘J moves to Chat and puts the cursor in the composer.
  await focusPage(page);
  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel.getByRole('tab', { name: /Chat/ })).toHaveAttribute('aria-selected', 'true');
  await expect(editor).toBeFocused();

  // ⌘W with focus in the panel closes the panel, not the page under it.
  await page.keyboard.press('ControlOrMeta+w');
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.home-page')).toBeVisible();

  // Docked, an Esc on the page is the page's: the panel stays. An Esc in it closes it.
  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel).toBeVisible();
  await focusPage(page);
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await panel.getByRole('tab', { name: /Chat/ }).focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // Pages has no window of its own: ⌘J opens the same panel there, and it stays across areas.
  await openArea(page, 'spaces');
  await expect(page.locator('main.spaces-home')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Assistant', exact: true })).toHaveCount(0);
  await expect(page.locator('button.meta-chat-pill')).toHaveCount(0);
  await expect(page.locator('.spaces-side').getByRole('button', { name: 'Assistant', exact: true })).toHaveCount(0);
  await expect(page.locator('.terminal-topbar').getByRole('button', { name: /Assistant/ })).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel).toBeVisible();
  await expect(panel.getByText(previousAnswer)).toBeVisible();
  await openArea(page, 'scheduled');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Close Michi', exact: true }).click();
  await expect(panel).toHaveCount(0);

  // Scheduled's Create with agent opens the panel too, no window of its own.
  await page.getByRole('button', { name: 'Create with agent', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('tab', { name: /Chat/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText(previousAnswer)).toBeVisible();

  // A narrow window lays the panel over the page: there an Esc on the page closes it first.
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(panel).toHaveAttribute('data-layout', 'overlay');
  await focusPage(page);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('Settings has no Assistant page, and the palette names the agent: Ask <name>, <name>: New conversation starts over', async ({ page }) => {
  const { errors, external, resets, panel } = await boot(page);

  // Runtime & model is where the conversation's runtime comes from; it has no page of its own.
  const settings = await openSettings(page);
  const sections = settings.getByRole('navigation', { name: 'Settings sections' });
  await expect(sections.getByRole('button', { name: 'Runtime & model', exact: true })).toBeVisible();
  await expect(sections.getByRole('button', { name: 'Assistant', exact: true })).toHaveCount(0);
  await leaveSettings(page);

  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByPlaceholder('Search chats, commands, messages…').fill('Michi');
  for (const label of ['Ask Michi', 'Michi: Today', 'Michi: Check now', 'Michi: New conversation', 'Michi: Settings']) {
    await expect(palette.getByText(label, { exact: true })).toBeVisible();
  }
  await palette.getByPlaceholder('Search chats, commands, messages…').fill('assistant');
  await expect(palette.getByText(/Ask the assistant/)).toHaveCount(0);

  // New conversation: the one conversation starts over, the old one goes to History, the panel shows it.
  await palette.getByPlaceholder('Search chats, commands, messages…').fill('Michi');
  await palette.getByText('Michi: New conversation', { exact: true }).click();
  await expect(panel).toBeVisible();
  await expect.poll(() => resets).toEqual([{ nodeId: 'assistant-old' }]);
  await expect(panel.getByText(previousAnswer)).toHaveCount(0);

  // Ask <name> opens it on Chat.
  await panel.getByRole('button', { name: 'Close Michi', exact: true }).click();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await palette.getByPlaceholder('Search chats, commands, messages…').fill('Ask Michi');
  await palette.getByText('Ask Michi', { exact: true }).click();
  await expect(panel.getByRole('tab', { name: /Chat/ })).toHaveAttribute('aria-selected', 'true');
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});
