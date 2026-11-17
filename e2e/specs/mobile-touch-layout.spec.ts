import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openArea } from '../fixtures/shell';

// Phone layouts on a touch screen: Scheduled rows, Settings, Explore further,
// the tap targets under messages and in the sidebar, the drawer's folder rows
// (ST-36), and hover reveals.

const questions = [
  'Where in the Michi source is the completion marker in the set_branch_overview result generated?',
  'What could go wrong with frontend parsing if the model outputs that marker?',
  'Do instructions embedded in tool results pose a prompt injection risk?',
];

async function phone(browser: Browser, baseURL: string | undefined, width = 390) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
  return context.newPage();
}

/** `threads`: the sidebar's saved thread folds, by tree id. */
async function boot(page: Page, { threads }: { threads?: Record<string, boolean> } = {}) {
  const prefs = {
    terminalPalette: 'bone', onboardingCompletedAt: 1, enableFollowUps: true, sidebarCollapsed: true, reduceMotion: true,
    ...(threads ? { sidebarExpanded: { workspaces: {}, threads, branches: {} } } : {}),
  };
  const createdAt = Date.now() - 5 * 60_000;
  const ids = ['root', 'child'];
  // A second conversation, older, whose branches nest: plan-a1 is a branch of plan-a.
  const plan = [
    { id: 'plan', title: 'Release plan' },
    { id: 'plan-a', title: 'Staging rollout', parent: 'plan', at: createdAt + 10 },
    { id: 'plan-b', title: 'Risk review', parent: 'plan', at: createdAt + 20 },
    { id: 'plan-a1', title: 'Rollback drill', parent: 'plan-a', at: createdAt + 30 },
  ];
  const workspace = {
    workspace: { id: 'ws-1', name: 'Branch design', active_tree_id: 'tree', created_at: createdAt },
    trees: [
      { id: 'tree', workspace_id: 'ws-1', root_node_id: 'root', name: 'Tool results', created_at: createdAt, last_active_at: createdAt },
      { id: 'plan-tree', workspace_id: 'ws-1', root_node_id: 'plan', name: 'Release plan', created_at: createdAt - 1000, last_active_at: createdAt - 1000 },
    ],
    nodes: [
      ...ids.map((id, index) => ({
        id, kind: 'chat', acp_session_id: id, runtime_id: 'mock', workspace_id: 'ws-1', tree_id: 'tree',
        title: index === 0 ? 'Tool results and completion markers' : 'Frontend parsing of completion markers',
        status: 'idle', created_at: createdAt + index,
        follow_ups: JSON.stringify(index === 0 ? questions : []),
        follow_ups_source_message_id: index === 0 ? 'root-answer' : undefined,
      })),
      ...plan.map(({ id, title }) => ({
        id, kind: 'chat', acp_session_id: id, runtime_id: 'mock', workspace_id: 'ws-1', tree_id: 'plan-tree',
        title, status: 'idle', created_at: createdAt - 1000, follow_ups: JSON.stringify([]),
      })),
    ],
    edges: [
      { source_node_id: 'root', target_node_id: 'child', kind: 'branch', anchor_message_id: 'root-answer', created_at: createdAt + 3 },
      ...plan.flatMap(({ id, parent, at }) => parent ? [{ source_node_id: parent, target_node_id: id, kind: 'branch', created_at: at }] : []),
    ],
    messages: [...ids, ...plan.map(({ id }) => id)].flatMap(id => [
      { id: `${id}-question`, node_id: id, role: 'user', seq: 0, content: 'Review the tool result handling.', created_at: createdAt },
      { id: `${id}-answer`, node_id: id, role: 'assistant', seq: 1, content: 'Keep tool output separate from runtime control messages.', created_at: createdAt + 1 },
    ]),
    contexts: [],
  };
  await installMockApi(page, { workspaces: [workspace], custom: async route => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (path === '/prefs' && route.request().method() === 'GET') { await route.fulfill({ json: { prefs } }); return true; }
    if (path === '/meta-agent/overview') {
      await route.fulfill({ json: {
        state: 'running', runtime: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
        today: { checks: 0, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 },
        cursors: [], recentRuns: [], managedJobIds: [],
      } });
      return true;
    }
    if (path === '/scheduled-jobs') {
      await route.fulfill({ json: {
        jobs: [{
          id: 'job-1', workspaceId: 'ws-1', name: 'Morning digest of overnight changes', prompt: 'Summarize overnight changes',
          schedule: { kind: 'every', everySeconds: 3600 }, enabled: true, autoPaused: false,
          runtimeId: null, providerId: null, modelId: null, reasoning: null, permissionMode: 'trust',
          sessionMode: 'fresh', notify: true, timeoutSeconds: 1800, consecutiveFailures: 0,
          activeRunId: null, lastRunAt: null, nextRunAt: null, lastStatus: null, lastError: null,
          persistentNodeId: null, createdAt: 1, updatedAt: 1,
        }],
        scheduler: { active: true, serviceMode: false, timezone: 'UTC' },
      } });
      return true;
    }
    if (/^\/scheduled-jobs\/[^/]+\/runs$/.test(path)) { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/uploads/web-cwd') { await route.fulfill({ json: { cwd: '/tmp/ws-1' } }); return true; }
    if (path === '/workspaces/import-file') {
      const { originalName } = route.request().postDataJSON() as { originalName: string };
      await route.fulfill({ json: { name: originalName, filePath: `.attachments/${originalName}`, size: 5 } });
      return true;
    }
    return false;
  } });
  await page.addInitScript(prefs => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:prefs', JSON.stringify(prefs));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'ws-1::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'ws-1::tree': 'root' }));
  }, prefs);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
}

async function openThread(page: Page) {
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await page.locator('.terminal-sidebar').getByText('Tool results', { exact: true }).first().click();
  const pane = page.locator('.terminal-pane[data-node-id="root"]');
  await expect(pane.locator('.t-followup-row')).toHaveCount(3);
  return pane;
}

/** Attaches a text file through the composer's web picker; returns its pending remove button. */
async function attachNotes(page: Page, pane: Locator) {
  const chooser = page.waitForEvent('filechooser');
  await pane.getByRole('button', { name: 'Attach file', exact: true }).click();
  await (await chooser).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') });
  return pane.getByRole('button', { name: 'Remove notes.txt', exact: true });
}

const shown = (control: Locator) => control.evaluate((el) => {
  const style = getComputedStyle(el);
  return style.opacity === '1' && style.pointerEvents !== 'none';
});

async function size(page: Page, selector: string) {
  const box = await page.locator(selector).filter({ visible: true }).first().boundingBox();
  expect(box, selector).not.toBeNull();
  return box!;
}

test('message actions, follow-up toggle and sidebar row buttons are finger-sized', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  const pane = await openThread(page);
  for (const name of ['copy message', 'retry this turn', 'branch from here']) {
    const box = await pane.getByRole('button', { name, exact: true }).first().boundingBox();
    expect(box!.width, name).toBeGreaterThanOrEqual(40);
    expect(box!.height, name).toBeGreaterThanOrEqual(40);
  }
  const toggle = await size(page, '.t-followups-toggle');
  expect(Math.min(toggle.width, toggle.height)).toBeGreaterThanOrEqual(40);

  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  const sidebar = page.locator('.terminal-sidebar');
  const newChat = await sidebar.getByRole('button', { name: 'New chat in this workspace', exact: true }).boundingBox();
  expect(Math.min(newChat!.width, newChat!.height)).toBeGreaterThanOrEqual(40);
  // A long press opens the rows' menus, so their ⋯ buttons stay only for screen readers.
  const threadMenu = page.getByRole('button', { name: 'Actions for Tool results', exact: true });
  const workspaceMenu = sidebar.getByRole('button', { name: 'Actions for Branch design', exact: true });
  for (const clip of [sidebar.locator('.row-kebab', { has: threadMenu }), workspaceMenu]) {
    const box = (await clip.boundingBox())!;
    expect(box.width * box.height).toBeLessThanOrEqual(1);
    expect(await clip.evaluate(el => getComputedStyle(el).clipPath)).toBe('inset(50%)');
  }

  // A card row that folds keeps its caret in a finger-sized column of its own:
  // a tap there folds the card and leaves the drawer open, a tap on the title
  // opens the conversation and closes the drawer.
  const row = sidebar.locator('[data-sidebar-row="root"]');
  const caret = row.locator('[data-card-caret]');
  const column = (await caret.boundingBox())!;
  expect(Math.min(column.width, column.height)).toBeGreaterThanOrEqual(40);
  const title = row.getByText('Tool results', { exact: true });
  const titleBox = (await title.boundingBox())!;
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(column.x);
  const expanded = await row.getAttribute('aria-expanded');
  await caret.tap();
  await expect(row).toHaveAttribute('aria-expanded', expanded === 'true' ? 'false' : 'true');
  await expect(sidebar).toBeVisible();
  await title.tap();
  await expect(sidebar).toBeHidden();
  await expect(page.locator('.terminal-pane[data-node-id="root"]')).toBeVisible();
});

test('the drawer opens the conversation on screen; a tap only opens a thread, its caret column alone folds it, and branches sit one level in', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  // The user folded the conversation on screen last time.
  await boot(page, { threads: { tree: false } });
  const sidebar = page.locator('.terminal-sidebar');
  const row = (id: string) => sidebar.locator(`[data-sidebar-row="${id}"]`);
  const openDrawer = () => page.getByRole('button', { name: 'Open sidebar', exact: true }).click();

  await openDrawer();
  await expect(row('root')).toHaveAttribute('aria-expanded', 'true');
  await expect(row('child')).toBeVisible();
  await expect(row('plan')).toHaveAttribute('aria-expanded', 'false');

  // The caret column unfolds the other one with the drawer open: every
  // branch, however deep, one level in, oldest first, with no fold of its own.
  await row('plan').locator('[data-card-caret]').tap();
  await expect(row('plan')).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar).toBeVisible();
  const branches = sidebar.locator('[data-sidebar-row^="plan-"]');
  await expect(branches).toHaveCount(3);
  expect(await branches.evaluateAll((rows) => rows.map((el) => el.getAttribute('data-sidebar-row')))).toEqual(['plan-a', 'plan-b', 'plan-a1']);
  expect(new Set(await branches.evaluateAll((rows) => rows.map((el) => getComputedStyle(el).paddingLeft))).size).toBe(1);
  expect(await branches.evaluateAll((rows) => rows.filter((el) => el.hasAttribute('aria-expanded')).length)).toBe(0);

  // Folded again, a tap on its title opens it; the drawer then shows it
  // open as the current one, and the one left behind as the user set it.
  await row('plan').locator('[data-card-caret]').tap();
  await expect(row('plan')).toHaveAttribute('aria-expanded', 'false');
  await row('plan').getByText('Release plan', { exact: true }).tap();
  await expect(sidebar).toBeHidden();
  await expect(page.locator('.terminal-pane[data-node-id="plan"]')).toBeVisible();
  await openDrawer();
  await expect(row('plan')).toHaveAttribute('aria-expanded', 'true');
  await expect(row('root')).toHaveAttribute('aria-expanded', 'false');
  // Left again, it is still folded: the tap that opened it set nothing.
  await row('root').getByText('Tool results', { exact: true }).tap();
  await expect(sidebar).toBeHidden();
  await openDrawer();
  await expect(row('plan')).toHaveAttribute('aria-expanded', 'false');
  await expect(row('root')).toHaveAttribute('aria-expanded', 'true');
});

test('a finger on the caret column fills the column alone and never long-presses its row', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  const cdp = await page.context().newCDPSession(page);
  await boot(page);
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  const row = page.locator('.terminal-sidebar [data-sidebar-row="root"]');
  const caret = row.locator('[data-card-caret]');
  const fill = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backgroundColor);
  const rowAtRest = await fill(row);
  const box = (await caret.boundingBox())!;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
  await expect(caret).toHaveAttribute('data-press');
  expect(await fill(caret)).not.toBe('rgba(0, 0, 0, 0)');
  // Past the 400ms long press and the browser's own.
  await page.waitForTimeout(700);
  expect(await fill(row)).toBe(rowAtRest);
  await expect(row).not.toHaveAttribute('data-press');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(caret).not.toHaveAttribute('data-press');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('.terminal-sidebar')).toBeVisible();
});

test('a pending attachment shows its remove button at rest on a touch screen; a pointer reveals it on hover or focus', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  const pane = await openThread(page);
  const remove = await attachNotes(page, pane);
  expect(await shown(remove)).toBe(true);
  await remove.tap();
  await expect(pane.getByText('notes.txt', { exact: true })).toHaveCount(0);
  await page.context().close();

  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const desktop = await context.newPage();
  await boot(desktop);
  const deskPane = await openThread(desktop);
  const deskRemove = await attachNotes(desktop, deskPane);
  await desktop.mouse.move(0, 0);
  await expect.poll(() => shown(deskRemove)).toBe(false);
  await deskPane.locator('.t-att-pending-item', { hasText: 'notes.txt' }).hover();
  await expect.poll(() => shown(deskRemove)).toBe(true);
  await desktop.mouse.move(0, 0);
  await expect.poll(() => shown(deskRemove)).toBe(false);
  // Keyboard focus reveals it (:focus-visible); a focus set after the pointer was used is not that.
  await deskRemove.focus();
  await desktop.keyboard.press('Tab');
  await desktop.keyboard.press('Shift+Tab');
  await expect(deskRemove).toBeFocused();
  await expect.poll(() => shown(deskRemove)).toBe(true);
  await desktop.keyboard.press('Enter');
  await expect(deskPane.getByText('notes.txt', { exact: true })).toHaveCount(0);
  await context.close();
});

for (const width of [390, 320]) test(`Explore further keeps Branch on one line at ${width}px`, async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL, width);
  await boot(page);
  const pane = await openThread(page);
  for (const row of await pane.locator('.t-followup-row').all()) {
    const branch = row.locator('.t-followup-branch');
    const glyph = await branch.locator('.t-followup-branch-glyph').boundingBox();
    const label = branch.locator('.t-followup-branch-label');
    expect(await branch.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    if (await label.isVisible()) {
      const text = await label.boundingBox();
      expect(Math.abs((glyph!.y + glyph!.height / 2) - (text!.y + text!.height / 2))).toBeLessThan(3);
      expect(text!.x).toBeGreaterThan(glyph!.x + glyph!.width);
    }
    await expect(branch).toHaveAccessibleName(/Branch/);
  }
});

test('Scheduled rows keep the title clear of the run, switch and menu buttons', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await openArea(page, 'scheduled');
  await page.getByRole('heading', { level: 1, name: 'Scheduled', exact: true }).waitFor();
  await page.touchscreen.tap(375, 600);
  for (const row of await page.locator('.terminal-scheduled .sched-row').all()) {
    const title = await row.locator('.trash-row-title').boundingBox();
    const actions = await row.locator('.trash-row-actions').boundingBox();
    expect(title!.width).toBeGreaterThan(150);
    expect(title!.x + title!.width).toBeLessThanOrEqual(actions!.x + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('Settings on a phone opens on its section list, then a full-width section; Back steps up a level', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await openArea(page, 'settings');
  const drawer = page.getByRole('dialog', { name: 'Settings', exact: true });
  const nav = drawer.getByRole('navigation', { name: 'Settings sections' });
  const back = drawer.locator('.ui-overlay-header').getByRole('button', { name: 'Back', exact: true });
  const content = drawer.locator('.terminal-settings-content');

  // First level: only the list, grouped cards with one row per page, each
  // nearly as wide as the screen.
  await expect(nav).toBeVisible();
  await expect(content).toBeHidden();
  const rows = await nav.locator('.settings-phone__row').all();
  expect(rows.length).toBeGreaterThanOrEqual(11);
  for (const row of rows) {
    const box = (await row.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.width).toBeGreaterThanOrEqual(340);
    await expect(row.locator('.settings-phone__chevron')).toBeVisible();
  }
  expect(await drawer.locator('.terminal-settings-sidebar').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('settings-phone-list.png'), animations: 'disabled' });

  // Second level: the section alone at full width.
  await nav.getByRole('button', { name: 'Appearance', exact: true }).click();
  const heading = drawer.getByRole('heading', { level: 1, name: 'Appearance', exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(nav).toBeHidden();
  expect((await content.boundingBox())!.width).toBeGreaterThanOrEqual(380);
  expect(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('settings-phone-section.png'), animations: 'disabled' });

  // Back returns to the list, focused on the section just left; Back again closes.
  await back.click();
  await expect(nav).toBeVisible();
  await expect(content).toBeHidden();
  await expect(nav.getByRole('button', { name: 'Appearance', exact: true })).toBeFocused();
  await back.click();
  await expect(drawer).toHaveCount(0);

  // Reopening starts on the list again.
  await openArea(page, 'settings');
  await expect(nav).toBeVisible();
  await expect(content).toBeHidden();
});

test('a request for one Settings section opens straight on it on a phone', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  await page.locator('.terminal-topbar').waitFor();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('michi:open-settings-section', { detail: { section: 'meta-agent' } }));
    window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'settings' } }));
  });
  const drawer = page.getByRole('dialog', { name: 'Settings', exact: true });
  const nav = drawer.getByRole('navigation', { name: 'Settings sections' });
  // The old meta-agent section opens Settings › <name> (DESIGN-v2 §1.5).
  await expect(drawer.getByRole('heading', { level: 1, name: 'Michi', exact: true })).toBeVisible();
  await expect(nav).toBeHidden();
  await drawer.locator('.ui-overlay-header').getByRole('button', { name: 'Back', exact: true }).click();
  await expect(nav).toBeVisible();
});
