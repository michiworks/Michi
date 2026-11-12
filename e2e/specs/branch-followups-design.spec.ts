import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

const questions = [
  'Where in the Michi source is the completion marker in the set_branch_overview result generated?',
  'What could go wrong with frontend parsing if the model outputs that marker?',
  'Do instructions embedded in tool results pose a prompt injection risk?',
];

async function boot(page: Page, palette = 'monokai', longAnswer = false) {
  const sentChats: string[] = [];
  const prefs = { terminalPalette: palette, onboardingCompletedAt: 1, enableFollowUps: true,
    sidebarCollapsed: true, defaultPaneWidth: 880, paneWidthMode: 'fixed', messageFontSize: 16.5 };
  const ids = ['root', 'child', 'error-child'];
  const createdAt = Date.now() - 5 * 60_000;
  const workspace = {
    workspace: { id: 'followups-ws', name: 'Branch design', active_tree_id: 'tree', created_at: createdAt },
    trees: [{ id: 'tree', workspace_id: 'followups-ws', root_node_id: 'root', name: 'Tool results', created_at: createdAt, last_active_at: createdAt }],
    nodes: ids.map((id, index) => ({
      id, kind: 'chat', acp_session_id: id, runtime_id: 'mock', workspace_id: 'followups-ws', tree_id: 'tree',
      title: index === 0 ? 'Tool results and completion markers' : index === 1
        ? 'Trace set_branch_overview completion markers across tool definitions, runtime control messages, and frontend projection'
        : 'Frontend parsing of completion markers',
      status: index === 2 ? 'error' : 'idle', created_at: createdAt + index,
      follow_ups: JSON.stringify(index === 0 ? questions : []),
      follow_ups_source_message_id: index === 0 ? 'root-answer' : undefined,
    })),
    edges: ids.slice(1).map((target, i) => ({
      source_node_id: 'root', target_node_id: target, kind: 'branch',
      anchor_message_id: 'root-answer', created_at: createdAt + i + 3,
    })),
    messages: ids.flatMap(id => [
      { id: `${id}-question`, node_id: id, role: 'user', seq: 0, content: 'Review the tool result handling.', created_at: createdAt },
      { id: `${id}-answer`, node_id: id, role: 'assistant', seq: 1, content: 'Keep tool output separate from runtime control messages. Check the tool definition, stream events, and rendered output.'.repeat(id === 'root' && longAnswer ? 40 : 1), created_at: createdAt + 1 },
    ]),
    contexts: [],
  };
  await installMockApi(page, { workspaces: [workspace], custom: async route => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (path === '/prefs' && route.request().method() === 'GET') {
      await route.fulfill({ json: { prefs } });
      return true;
    }
    if (route.request().method() === 'POST' && /^\/chats\/[^/]+\/message$/.test(path)) {
      sentChats.push(path.split('/')[2]);
    }
    return false;
  } });
  await page.addInitScript(prefs => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:prefs', JSON.stringify(prefs));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'followups-ws::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'followups-ws::tree': 'root' }));
  }, prefs);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await openThreadFromSidebar(page, 'Tool results');
  const pane = page.locator('.terminal-pane[data-node-id="root"]');
  await expect(pane.locator('.t-followup-row')).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
  return { pane, sentChats };
}

test('generated branch metadata opens the existing child without creating or sending a turn', async ({ page }) => {
  const { pane, sentChats } = await boot(page);
  await expect(pane.locator('.t-branch-anchor-status').first()).toHaveText('Idle');
  await expect(pane.locator('.t-branch-anchor-status').nth(1)).toHaveText('Needs attention');
  await pane.locator('.t-branch-anchor-row').first().getByText('2 messages').click();
  await expect(page.locator('.terminal-pane[data-node-id="child"]')).toBeVisible();
  expect(sentChats).toEqual([]);
});

for (const corner of ['top-left', 'bottom-right']) {
  test(`the ${corner} corner of the branch quarter only sends to the child`, async ({ page }) => {
    const { pane, sentChats } = await boot(page);
    const branch = pane.locator('.t-followup-branch').first();
    const size = await branch.boundingBox();
    await branch.click({ position: corner === 'top-left' ? { x: 3, y: 3 } : { x: size!.width - 3, y: size!.height - 3 } });
    await expect.poll(() => sentChats.length).toBe(1);
    expect(sentChats[0]).not.toBe('root');
    await expect(pane.locator('.t-branch-anchor-row')).toHaveCount(3);
    await expect(pane.locator('.terminal-message-user').filter({ hasText: questions[0] })).toHaveCount(0);
  });
}

test('continuing sends in the parent without adding a branch', async ({ page }) => {
  const { pane, sentChats } = await boot(page);
  await pane.locator('.t-followup-text').first().click();
  await expect.poll(() => sentChats.length).toBe(1);
  expect(sentChats).toEqual(['root']);
  await expect(pane.locator('.t-branch-anchor-row')).toHaveCount(2);
});

for (const width of [1440, 390]) {
  test(`branch insertion keeps all follow-ups above the composer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { pane } = await boot(page, 'monokai', true);
    const transcript = pane.locator('.terminal-pane__transcript');
    await transcript.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await pane.locator('.t-followup-branch').first().click();
    await expect(pane.locator('.t-branch-anchor-row')).toHaveCount(3);
    await expect.poll(() => pane.evaluate(root => {
      const viewport = root.querySelector('.terminal-pane__transcript')!.getBoundingClientRect();
      const composer = root.querySelector('[contenteditable="true"]')!.getBoundingClientRect();
      return Array.from(root.querySelectorAll('.t-followup-row')).every(row => {
        const bounds = row.getBoundingClientRect();
        return bounds.top >= viewport.top && bounds.bottom <= Math.min(viewport.bottom, composer.top);
      });
    })).toBe(true);
  });
}
