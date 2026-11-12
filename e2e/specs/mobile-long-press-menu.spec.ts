import { expect, test, type BrowserContext, type CDPSession, type Locator, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

// A long press on a phone opens the menu a right-click opens on desktop: the
// pressed element lifts out in its own shape and the menu opens beside it.

async function phone(browser: import('@playwright/test').Browser, baseURL: string | undefined): Promise<{ context: BrowserContext; page: Page; cdp: CDPSession }> {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp };
}

async function boot(page: Page) {
  await installMockApi(page);
  await page.addInitScript(() => {
    localStorage.clear(); sessionStorage.clear();
    const ids = ['root', 'branch', 'nested', 'other'];
    const titles = ['Root note', 'Alternative plan', 'Implementation details', 'Separate tree'];
    const nodes = Object.fromEntries(ids.map((id, i) => [id, {
      nodeId: id, title: titles[i], kind: 'chat', chatId: null, projectId: 'phone', status: 'idle', followUps: [], messagesLoaded: true,
      messages: [{ id: id + '-q', role: 'user', text: titles[i], toolCalls: [], createdAt: 1 },
        { id: id + '-a', role: 'assistant', text: 'A quiet workspace keeps each conversation and its reading position.', toolCalls: [], createdAt: 2 }],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'phone', nodes, projects: [{
      id: 'phone', name: 'Mobile workspace', createdAt: 1, chatIds: ids, activeTreeId: 'tree',
      trees: [{ id: 'tree', rootNodeId: 'root', name: titles[0], createdAt: 1, lastActiveAt: 2 }, { id: 'other-tree', rootNodeId: 'other', name: titles[3], createdAt: 1, lastActiveAt: 1 }],
      edges: [{ source: 'root', target: 'branch' }, { source: 'branch', target: 'nested' }],
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarView: 'structure', sidebarCollapsed: true,
      sidebarExpanded: { workspaces: { phone: true }, threads: {}, branches: {} } }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'phone::tree': ['root', 'branch'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'phone::tree': 'root' }));
  });
  await page.goto('/');
}

/** Hold a finger on the element; optionally slide it somewhere before lifting. */
async function longPress(page: Page, cdp: CDPSession, target: Locator, { holdMs = 560, slideTo }: { holdMs?: number; slideTo?: Locator } = {}) {
  const box = await settledBox(target);
  const point = { x: box.x + Math.min(60, box.width / 2), y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(holdMs);
  if (slideTo) {
    await expect(slideTo).toBeVisible();
    await page.waitForTimeout(450); // the menu springs out; slide once it has settled
    const to = (await slideTo.boundingBox())!;
    const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    for (let step = 1; step <= 6; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x + (end.x - point.x) * step / 6, y: point.y + (end.y - point.y) * step / 6 }] });
      await page.waitForTimeout(16);
    }
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function openDrawer(page: Page) {
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await expect(page.locator('.terminal-sidebar [data-sidebar-row="other"]')).toBeVisible();
}

/** The box once the element has stopped moving (the drawer slides in). */
async function settledBox(target: Locator) {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const box = (await target.boundingBox())!;
    const key = [box.x, box.y, box.width, box.height].map(Math.round).join();
    if (key === last) return box;
    last = key;
    await target.page().waitForTimeout(60);
  }
  throw new Error('the element kept moving');
}

test('a long press on a sidebar thread lifts the row in its own shape and opens its menu', async ({ browser, baseURL }, info) => {
  const { context, page, cdp } = await phone(browser, baseURL);
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  try {
    await boot(page);
    await openDrawer(page);
    const row = page.locator('.terminal-sidebar [data-sidebar-row="other"]');
    const rowBox = await settledBox(row);
    await longPress(page, cdp, row);

    const menu = page.getByRole('menu', { name: 'Actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Rename…', 'Pin', 'Archive', 'Export this thread…', 'Delete thread…']);
    // The row hides behind a copy of itself: square, flush and as wide as the row.
    const lifted = page.locator('.phone-menu-lift');
    await expect(row).toBeHidden();
    await expect.poll(async () => {
      const box = (await lifted.boundingBox())!;
      return [Math.round(box.x), Math.round(box.width), await lifted.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)];
    }).toEqual([Math.round(rowBox.x), Math.round(rowBox.width), '0px']);
    // Lifting the finger neither opened the thread nor closed the drawer.
    await expect(page.locator('.terminal-sidebar')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: info.outputPath('long-press-thread.png') });

    await menu.getByRole('menuitem', { name: 'Pin' }).tap();
    await expect(menu).toHaveCount(0);
    await expect(row).toBeVisible();
    await longPress(page, cdp, row);
    await expect(page.getByRole('menuitem', { name: 'Unpin' })).toBeVisible();
    // A tap that starts on the scrim closes the menu and gives the row back.
    await page.locator('.phone-menu-scrim').tap({ position: { x: 380, y: 830 } });
    await expect(page.getByRole('menu', { name: 'Actions' })).toHaveCount(0);
    await expect(row).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('the finger that opened the menu can slide onto an item and lift to choose it', async ({ browser, baseURL }) => {
  const { context, page, cdp } = await phone(browser, baseURL);
  try {
    await boot(page);
    await openDrawer(page);
    const row = page.locator('.terminal-sidebar [data-sidebar-row="other"]');
    await longPress(page, cdp, row, { slideTo: page.getByRole('menuitem', { name: 'Archive' }) });
    await expect(page.getByRole('menu', { name: 'Actions' })).toHaveCount(0);
    await expect(row).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('a long press on a workspace row opens its menu', async ({ browser, baseURL }) => {
  const { context, page, cdp } = await phone(browser, baseURL);
  try {
    await boot(page);
    await openDrawer(page);
    await longPress(page, cdp, page.getByTestId('workspace-row-phone').locator('[data-context-target]').first());
    await expect(page.getByRole('menuitem', { name: /^Manage workspace/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a press that moves scrolls instead, and a tap still opens the thread', async ({ browser, baseURL }) => {
  const { context, page, cdp } = await phone(browser, baseURL);
  try {
    await boot(page);
    await openDrawer(page);
    const row = page.locator('.terminal-sidebar [data-sidebar-row="other"]');
    const box = (await row.boundingBox())!;
    const start = { x: box.x + 60, y: box.y + box.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    await page.waitForTimeout(120);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y: start.y + 30 }] });
    await page.waitForTimeout(600);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByRole('menu', { name: 'Actions' })).toHaveCount(0);
    await expect(row).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the pane title and the pane switcher offer Close and Close Others on a long press', async ({ browser, baseURL }) => {
  const { context, page, cdp } = await phone(browser, baseURL);
  try {
    await boot(page);
    await openThreadFromSidebar(page, 'Root note');
    await expect(page.locator('.terminal-dashboard')).toBeVisible();

    await page.getByRole('button', { name: 'Switch pane' }).click();
    const list = page.getByRole('navigation', { name: 'Branches and panes' });
    const branchItem = list.locator('.mobile-pane-item', { hasText: 'Alternative plan' });
    await longPress(page, cdp, branchItem);
    await expect(page.getByRole('menu', { name: 'Actions' }).getByRole('menuitem')).toHaveText(['Close', 'Close Others']);
    await page.getByRole('menuitem', { name: 'Close', exact: true }).tap();
    // The list stays open so several panes can be closed in a row.
    await expect(list).toBeVisible();
    await expect(branchItem.getByRole('button', { name: /^Close / })).toHaveCount(0);
    await page.keyboard.press('Escape');

    const title = page.locator('.mobile-pane-title');
    await longPress(page, cdp, title);
    const closeOthers = page.getByRole('menuitem', { name: 'Close Others' });
    await expect(closeOthers).toBeDisabled();
    await page.locator('.phone-menu-scrim').tap({ position: { x: 380, y: 830 } });
    await expect(page.getByRole('menu', { name: 'Actions' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
