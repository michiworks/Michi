import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

// Back on a phone: a swipe right from the left screen edge, the system Back
// (the browser history) and the topbar's ‹ all step one stack. The swipe
// follows the finger and settles back when released short.

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

async function phone(browser: Browser, baseURL: string | undefined, userAgent?: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp };
}

async function boot(page: Page) {
  await installMockApi(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('michi:e2e-booted')) return;
    localStorage.clear(); sessionStorage.clear();
    sessionStorage.setItem('michi:e2e-booted', '1');
    const ids = ['root', 'branch'];
    const titles = ['Root note', 'Alternative plan'];
    const nodes = Object.fromEntries(ids.map((id, i) => [id, {
      nodeId: id, title: titles[i], kind: 'chat', chatId: null, projectId: 'phone', status: 'idle', followUps: [], messagesLoaded: true,
      messages: [{ id: id + '-q', role: 'user', text: titles[i], toolCalls: [], createdAt: 1 },
        { id: id + '-a', role: 'assistant', text: 'A quiet workspace keeps each conversation and its reading position.', toolCalls: [], createdAt: 2 }],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'phone', nodes, projects: [{
      id: 'phone', name: 'Mobile workspace', createdAt: 1, chatIds: ids, activeTreeId: 'tree',
      trees: [{ id: 'tree', rootNodeId: 'root', name: titles[0], createdAt: 1, lastActiveAt: 2 }],
      edges: [{ source: 'root', target: 'branch' }],
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarView: 'structure', sidebarCollapsed: true,
      sidebarExpanded: { workspaces: { phone: true }, threads: {}, branches: {} } }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'phone::tree': ['root', 'branch'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'phone::tree': 'root' }));
  });
  await page.goto('/');
  // Picked in the drawer: a root, with nothing to go back to.
  await openThreadFromSidebar(page, 'Root note');
  await expect(page.locator('.mobile-pane-title')).toHaveText('Root note');
  await expect(page.locator('aside.terminal-sidebar')).toHaveCount(0);
}

/** Raw touch input: a finger that goes down, moves in 16ms steps and lifts. */
function finger(cdp: CDPSession, page: Page) {
  let at = { x: 0, y: 0 };
  return {
    down: async (x: number, y: number) => { at = { x, y }; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] }); },
    to: async (x: number, steps = 8) => {
      const from = at.x;
      for (let i = 1; i <= steps; i++) {
        at = { x: Math.round(from + ((x - from) * i) / steps), y: at.y };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at] });
        await page.waitForTimeout(16);
      }
    },
    up: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
  };
}

const drawer = (page: Page) => page.locator('aside.terminal-sidebar');
const left = async (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => Math.round(el.getBoundingClientRect().left));

test('the drawer follows a swipe from the left edge, settles back when released short, and closes with a swipe left', async ({ browser, baseURL }) => {
  const { context, page, cdp } = await phone(browser, baseURL);
  try {
    await boot(page);
    const touch = finger(cdp, page);
    await touch.down(4, 420);
    await touch.to(90);
    await expect(drawer(page)).toBeVisible();
    // Part-way in, where the finger is.
    const width = await drawer(page).evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.abs(await left(page, 'aside.terminal-sidebar') - (86 - width))).toBeLessThan(4);
    await touch.to(30);
    await touch.up();
    await expect(drawer(page)).toHaveCount(0);

    await touch.down(4, 420);
    await touch.to(260);
    await touch.up();
    await expect.poll(() => left(page, 'aside.terminal-sidebar')).toBe(0);

    await touch.down(300, 420);
    await touch.to(120);
    await touch.up();
    await expect(drawer(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('on iOS the browser’s back swipe cannot take the edge, and a tap there still clicks', async ({ browser, baseURL }) => {
  const { context, page, cdp } = await phone(browser, baseURL, IPHONE_SAFARI);
  try {
    await boot(page);
    // Safari swipes back to the tab's previous page unless this touchstart is cancelled.
    await page.evaluate(() => {
      window.addEventListener('touchstart', (e) => { document.body.dataset.edgeCancelled = String(e.defaultPrevented); });
    });
    const touch = finger(cdp, page);
    await touch.down(4, 420);
    await expect(page.locator('body')).toHaveAttribute('data-edge-cancelled', 'true');
    await touch.to(260);
    await touch.up();
    await expect.poll(() => left(page, 'aside.terminal-sidebar')).toBe(0);
    await touch.down(300, 420);
    await touch.to(120);
    await touch.up();
    await expect(drawer(page)).toHaveCount(0);

    const toggle = await page.getByRole('button', { name: 'Open sidebar', exact: true }).boundingBox();
    expect(toggle!.x).toBeLessThan(20);
    await touch.down(Math.round(toggle!.x) + 4, Math.round(toggle!.y + toggle!.height / 2));
    await touch.up();
    await expect(page.locator('body')).toHaveAttribute('data-edge-cancelled', 'true');
    await expect.poll(() => left(page, 'aside.terminal-sidebar')).toBe(0);
  } finally {
    await context.close();
  }
});

test('the system Back closes the drawer and stays in the app', async ({ browser, baseURL }) => {
  const { context, page } = await phone(browser, baseURL);
  try {
    await boot(page);
    const url = page.url();
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
    await expect(drawer(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (history.state as { michiBack?: boolean } | null)?.michiBack === true)).toBe(true);
    await page.goBack();
    await expect(drawer(page)).toHaveCount(0);
    expect(page.url()).toBe(url);
    await expect(page.locator('.mobile-pane-title')).toHaveText('Root note');
    // Nothing left to go back to: our entry is gone again.
    await expect.poll(() => page.evaluate(() => (history.state as { michiBack?: boolean } | null)?.michiBack === true)).toBe(false);
  } finally {
    await context.close();
  }
});

test('a back swipe steps out of a Settings page with the edge arrow, then drags Settings off', async ({ browser, baseURL }) => {
  const { context, page, cdp } = await phone(browser, baseURL);
  try {
    await boot(page);
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
    await page.getByRole('navigation', { name: 'Areas' }).locator('[data-area="settings"]').click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: /^Appearance/ }).first().click();
    const section = settings.getByRole('heading', { name: 'Appearance', level: 1 });
    await expect(section).toBeVisible();

    const touch = finger(cdp, page);
    await touch.down(4, 420);
    await touch.to(100);
    await expect(page.locator('.back-swipe-arrow')).toHaveAttribute('data-armed', 'true');
    await touch.up();
    await expect(section).toHaveCount(0);
    await expect(settings.getByRole('button', { name: /^Appearance/ }).first()).toBeVisible();

    await touch.down(4, 420);
    await touch.to(120);
    expect(Math.abs(await left(page, '.drawer-shell-panel') - 116)).toBeLessThan(4);
    await touch.to(300);
    await touch.up();
    await expect(settings).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('Home is a root: opened with the topbar +, the edge swipe opens the drawer', async ({ browser, baseURL }) => {
  const { context, page, cdp } = await phone(browser, baseURL);
  try {
    await boot(page);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.locator('.mobile-pane-title')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Go back' })).toHaveCount(0);

    const touch = finger(cdp, page);
    await touch.down(4, 420);
    await touch.to(260);
    await touch.up();
    await expect.poll(() => left(page, 'aside.terminal-sidebar')).toBe(0);
  } finally {
    await context.close();
  }
});

test('Back returns to the conversation a branch was opened from, by swipe, ‹ and the system Back', async ({ browser, baseURL }) => {
  const { context, page, cdp } = await phone(browser, baseURL);
  const goTo = async (title: string) => {
    await page.getByRole('button', { name: 'Switch pane' }).click();
    await page.getByRole('navigation', { name: 'Branches and panes' }).getByRole('button', { name: title, exact: true }).click();
    await expect(page.locator('.mobile-pane-title')).toHaveText(title);
  };
  try {
    await boot(page);
    await expect(page.getByRole('button', { name: 'Go back' })).toHaveCount(0);
    await goTo('Alternative plan');
    await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible();

    const touch = finger(cdp, page);
    await touch.down(4, 420);
    await touch.to(110);
    // The page follows the finger.
    expect(Math.abs(await left(page, '.terminal-content-col') - 106)).toBeLessThan(4);
    await touch.to(280);
    await touch.up();
    await expect(page.locator('.mobile-pane-title')).toHaveText('Root note');
    await expect(page.getByRole('button', { name: 'Go back' })).toHaveCount(0);
    await expect.poll(() => left(page, '.terminal-content-col')).toBe(0);

    await goTo('Alternative plan');
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page.locator('.mobile-pane-title')).toHaveText('Root note');

    await goTo('Alternative plan');
    await page.goBack();
    await expect(page.locator('.mobile-pane-title')).toHaveText('Root note');
  } finally {
    await context.close();
  }
});
