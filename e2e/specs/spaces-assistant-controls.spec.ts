import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { installMockApi } from '../fixtures/mockApi';
import { createSpacesHomeMock } from '../fixtures/spacesHomeFixtures';
import { openArea } from '../fixtures/shell';

const evidence = resolve('.artifacts/hover-ask');
const previousAnswer = 'Start with the desktop acceptance checks, then confirm the release notes.';

// DESIGN-v2 §1.2–§1.4: the Spaces assistant window and its sidebar row are gone; a
// block's Ask opens the one panel about the block, whose menu starts over and keeps History.
for (const palette of ['bone', 'monokai']) test(`native hover actions, Ask <name> and the panel's New conversation in ${palette}`, async ({ page }) => {
  mkdirSync(evidence, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let current = 'old';
  let resets = 0;
  const assistantInfo = () => ({ nodeId: `assistant-${current}`, treeId: `tree-${current}`, workspaceId: 'ws-assistant', settings: { runtimeId: 'mock', modelId: null, reasoning: null }, supportedRuntimes: ['mock'] });
  const messages = [
    { id: 'question-old', node_id: 'assistant-old', role: 'user', seq: 0, content: 'What should I focus on next?' },
    { id: 'answer-old', node_id: 'assistant-old', role: 'assistant', seq: 1, content: previousAnswer },
  ];
  const assistantWorkspace = () => ({
    workspace: { id: 'ws-assistant', name: 'Assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }), active_tree_id: `tree-${current}` },
    trees: (current === 'old' ? ['old'] : ['old', 'new']).map(id => ({ id: `tree-${id}`, workspace_id: 'ws-assistant', root_node_id: `assistant-${id}`, name: 'Assistant', created_at: 1, archived_at: id === 'old' && current === 'new' ? 2 : null })),
    nodes: (current === 'old' ? ['old'] : ['old', 'new']).map(id => ({ id: `assistant-${id}`, workspace_id: 'ws-assistant', tree_id: `tree-${id}`, kind: 'chat', title: 'Assistant', runtime_id: 'mock', status: 'idle', created_at: 1 })),
    messages, edges: [], contexts: [], artifacts: [],
  });
  const spaces = createSpacesHomeMock({
    workspaceHomes: { 'ws-review': { name: 'Release review', blocks: [{ id: 'review-block', rev: 1, type: 'markdown', text: 'Review the desktop build and confirm the release notes.', sources: [{ nodeId: 'assistant-old', turnId: 'turn-old', assistantId: 'answer-old' }] }] } },
  });
  await page.addInitScript(terminalPalette => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, terminalPalette, uiFont: 'Geist' }));
    localStorage.setItem('michi:migrated', '1');
  }, palette);
  await installMockApi(page, {
    workspaces: [{ workspace: { id: 'ws-review', name: 'Release review', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] }, assistantWorkspace()],
    custom: async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/prefs' && route.request().method() === 'GET') { await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: palette, uiFont: 'Geist' } } }); return true; }
      if (path === '/api/assistant') { await route.fulfill({ json: assistantInfo() }); return true; }
      if (path === '/api/assistant/conversations') {
        await route.fulfill({ json: { items: [{ nodeId: `assistant-${current}`, title: 'Recent assistant conversation', updatedAt: 1000 }], nextCursor: null } }); return true;
      }
      if (path === '/api/assistant/reset') {
        expect(route.request().postDataJSON()).toEqual({ nodeId: 'assistant-old' });
        resets += 1;
        current = 'new';
        await route.fulfill({ json: assistantInfo() }); return true;
      }
      if (path === '/api/workspaces/ws-assistant') { await route.fulfill({ json: assistantWorkspace() }); return true; }
      if (path.includes('/api/workspaces/ws-assistant/trees/') && path.endsWith('/messages')) {
        await route.fulfill({ json: { messages: path.includes('tree-old') ? messages : [] } }); return true;
      }
      if (path === '/api/spaces') { await route.fulfill({ json: { items: [] } }); return true; }
      return spaces.handle(route);
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'spaces');
  // No window of its own, and no Assistant row or history in the sidebar.
  await expect(page.locator('.meta-chat-area, button.meta-chat-pill')).toHaveCount(0);
  await expect(page.locator('.spaces-side').getByRole('button', { name: 'Assistant', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Assistant conversations' })).toHaveCount(0);
  await page.locator('.spaces-side').getByRole('button', { name: /^Release review/ }).click();
  const home = page.getByRole('main', { name: 'Release review', exact: true });
  const block = home.locator('[data-block-id="review-block"]');
  await block.hover();
  const toolbar = block.getByRole('toolbar');
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveText('');
  await expect(toolbar.getByRole('button')).toHaveCount(6);
  await expect(toolbar.getByRole('button', { name: 'Copy link' })).toHaveCount(0);
  await expect(toolbar.getByText(/Codex/)).toHaveCount(0);
  await page.screenshot({ path: resolve(evidence, `hover-${palette}.png`), animations: 'disabled' });
  await toolbar.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(block).toHaveAttribute('data-selected', 'true');

  // Ask <name>: the one panel opens beside the page, about this block.
  await toolbar.getByRole('button', { name: 'Ask Michi', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Michi', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-layout', 'docked');
  await expect(home).toBeVisible();
  await expect(panel.getByText(previousAnswer)).toBeVisible();
  await expect(panel.getByText(/Targeting:/)).toBeVisible();
  const editor = panel.locator('.terminal-composer [contenteditable="true"]');
  await editor.fill('Keep this unsent question');
  await page.screenshot({ path: resolve(evidence, `ask-${palette}.png`), animations: 'disabled' });

  // History lives in the panel's menu now.
  await panel.getByRole('button', { name: 'Michi menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'History…', exact: true }).click();
  const history = panel.getByRole('dialog', { name: 'History' }).getByRole('navigation', { name: 'Assistant conversations' });
  await expect(history.locator('[aria-current="page"]')).toContainText('Recent assistant conversation');
  await panel.getByRole('button', { name: 'Close history', exact: true }).click();
  await expect(editor).toHaveText('Keep this unsent question');

  // New conversation starts over: the old answer, the draft and the target go.
  await panel.getByRole('button', { name: 'Michi menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click();
  await expect(panel.getByText(previousAnswer)).toHaveCount(0);
  await expect(panel.getByText(/Targeting:/)).toHaveCount(0);
  await expect(editor).toHaveText('');
  expect(resets).toBe(1);
  await page.screenshot({ path: resolve(evidence, `new-conversation-${palette}.png`), animations: 'disabled' });

  // A narrow window lays the panel over the page without spilling sideways.
  await page.setViewportSize({ width: 600, height: 740 });
  await expect(panel).toHaveAttribute('data-layout', 'overlay');
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(panel.getByRole('button', { name: 'Close Michi', exact: true })).toBeInViewport();
  await page.screenshot({ path: resolve(evidence, `narrow-${palette}.png`), animations: 'disabled' });
  expect(errors).toEqual([]);
});
