import { expect, test, type Browser, type CDPSession, type Locator, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

// On a phone the page is an application shell: it never scrolls or bounces as
// a whole. Only the transcript, the sidebar's list and Settings' content
// scroll, so the composer, the top bar and the drawer's area tabs, New chat
// row and view tabs stay where they are. iOS's rubber-band is not emulated by Chromium; the
// root's overscroll-behavior is what stops it there.

async function phone(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  return context.newPage();
}

async function boot(page: Page) {
  await installMockApi(page);
  await page.addInitScript(() => {
    localStorage.clear(); sessionStorage.clear();
    const answer = Array(30).fill('A quiet workspace keeps each conversation and its reading position.').join('\n\n');
    const ids = Array.from({ length: 24 }, (_, i) => (i === 0 ? 'root' : `thread-${i}`));
    const nodes = Object.fromEntries(ids.map((id, i) => [id, {
      nodeId: id, title: i === 0 ? 'Root note' : `Thread ${i}`, kind: 'chat', chatId: null, projectId: 'phone', status: 'idle', followUps: [], messagesLoaded: true,
      messages: i === 0 ? [{ id: 'q', role: 'user', text: 'Root note', toolCalls: [], createdAt: 1 }, { id: 'a', role: 'assistant', text: answer, toolCalls: [], createdAt: 2 }] : [],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'phone', nodes, projects: [{
      id: 'phone', name: 'Mobile workspace', createdAt: 1, chatIds: ids, activeTreeId: 'tree-0',
      trees: ids.map((id, i) => ({ id: `tree-${i}`, rootNodeId: id, name: i === 0 ? 'Root note' : `Thread ${i}`, createdAt: 1, lastActiveAt: 100 - i })),
      edges: [],
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarView: 'structure', sidebarCollapsed: true, sidebarThreadLimit: 30,
      sidebarExpanded: { workspaces: { phone: true }, threads: {}, branches: {} }, reduceMotion: true }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'phone::tree-0': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'phone::tree-0': 'root' }));
  });
  await page.goto('/');
}

/**
 * A finger drag of `dy` px starting on `target` (negative = finger moves up,
 * which scrolls content down), as raw touch events.
 */
async function drag(cdp: CDPSession, target: Locator, dy: number) {
  const box = (await target.boundingBox())!;
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const steps = 15;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y + (dy * i) / steps) }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** The same drag, from a viewport point rather than an element's center. */
async function dragAt(cdp: CDPSession, x: number, y: number, dy: number) {
  const steps = 15;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y + (dy * i) / steps) }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * The drag on the drawer's list, from its middle row's left padding. In
 * Chromium's touch emulation a drag that starts on a row's title text often
 * scrolls nothing, on dev's layout too, so it starts beside the title.
 */
async function dragList(cdp: CDPSession, list: Locator, dy: number) {
  const box = (await list.boundingBox())!;
  await dragAt(cdp, Math.round(box.x + 16), Math.round(box.y + box.height / 2), dy);
}

async function top(locator: Locator) {
  return (await locator.boundingBox())!.y;
}

async function bottom(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return box.y + box.height;
}

async function pageScroll(page: Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement!;
    window.scrollTo(0, 500);
    const moved = window.scrollY;
    window.scrollTo(0, 0);
    return { range: root.scrollHeight - root.clientHeight, moved };
  });
}

test('the page never scrolls or bounces; dragging the composer moves nothing and the transcript scrolls beneath it', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  await openThreadFromSidebar(page, 'Root note');
  const pane = page.locator('.terminal-pane[data-node-id="root"]');
  const composer = pane.locator('.terminal-composer');
  const transcript = pane.locator('.term-scrollbar').first();
  await expect(composer).toBeVisible();
  await expect.poll(() => transcript.evaluate(el => el.scrollHeight > el.clientHeight + 200)).toBe(true);

  expect(await page.evaluate(() => [document.documentElement, document.body].map(el => getComputedStyle(el).overscrollBehaviorY))).toEqual(['none', 'none']);
  expect(await pageScroll(page)).toEqual({ range: 0, moved: 0 });

  const cdp = await page.context().newCDPSession(page);
  // The composer grows upward when engaged, so its bottom edge is the anchor.
  const composerBottom = await bottom(composer);
  const topbarTop = await top(page.locator('.terminal-topbar'));
  const before = await transcript.evaluate(el => el.scrollTop);

  await drag(cdp, composer, -300);
  await drag(cdp, composer, 300);
  expect(await bottom(composer)).toBe(composerBottom);
  // A tap can expand or collapse the composer, which moves the pinned
  // transcript by that height change; a 300px drag would move it by 300.
  expect(Math.abs(await transcript.evaluate(el => el.scrollTop) - before)).toBeLessThan(40);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // The transcript opens at its end; dragging down scrolls it back up.
  await drag(cdp, transcript, 300);
  await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBeLessThan(before - 100);
  expect(await bottom(composer)).toBe(composerBottom);
  expect(await top(page.locator('.terminal-topbar'))).toBe(topbarTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('the sidebar is not one scrolling page: its list scrolls under the fixed area tabs and view tabs', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  await page.locator('.home-page').waitFor();
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  const sidebar = page.locator('.terminal-sidebar');
  const tabs = sidebar.getByRole('navigation', { name: 'Areas' });
  // By project / Recent, the last fixed row above the list.
  const views = sidebar.getByRole('tablist', { name: 'Sidebar view' });
  const list = sidebar.locator('.sb-scroller__view').first();
  await expect(sidebar.getByText('Thread 23', { exact: true })).toBeAttached();
  await expect.poll(() => list.evaluate(el => el.scrollHeight > el.clientHeight + 200)).toBe(true);

  const cdp = await page.context().newCDPSession(page);
  const tabsTop = await top(tabs);
  const viewsTop = await top(views);

  await drag(cdp, tabs, 300);
  await drag(cdp, views, -300);
  expect([await top(tabs), await top(views)]).toEqual([tabsTop, viewsTop]);

  await dragList(cdp, list, -300);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  expect([await top(tabs), await top(views)]).toEqual([tabsTop, viewsTop]);
  expect(await pageScroll(page)).toEqual({ range: 0, moved: 0 });

  // A drag that starts on a row's title (an overflow: hidden box) scrolls the list too.
  await list.evaluate(el => { el.scrollTop = 0; });
  await drag(cdp, sidebar.getByText('Thread 4', { exact: true }), -300);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
});

test('an open drawer holds the transcript under it still: drags on the scrim or past the list ends scroll nothing behind', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  await openThreadFromSidebar(page, 'Root note');
  const transcript = page.locator('.terminal-pane[data-node-id="root"] .term-scrollbar').first();
  await expect.poll(() => transcript.evaluate(el => el.scrollHeight > el.clientHeight + 600)).toBe(true);
  // Off the transcript's end, by a finger, so a scroll either way would show.
  const cdp = await page.context().newCDPSession(page);
  await drag(cdp, transcript, 300);
  await expect.poll(() => transcript.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(200);
  await page.waitForTimeout(500);
  const held = await transcript.evaluate(el => el.scrollTop);

  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  const sidebar = page.locator('aside.terminal-sidebar');
  const list = sidebar.locator('.sb-scroller__view').first();
  await expect(sidebar.getByText('Thread 23', { exact: true })).toBeAttached();
  await expect.poll(async () => (await sidebar.boundingBox())?.x).toBe(0);
  const drawer = (await sidebar.boundingBox())!;
  const scrimX = Math.round(drawer.width + (390 - drawer.width) / 2);

  // iOS finds what a drag scrolls from composited layers, not the DOM, which
  // Chromium does not emulate: nothing under the drawer or its scrim is a hit
  // target at all, and a touch scroll in the drawer layer is cancelled unless
  // it starts in a list with something to scroll, which keeps it to itself.
  expect(await page.evaluate(points => points.some(([x, y]) => document.elementsFromPoint(x, y)
    .some(el => el.closest('.terminal-content-col'))), [[scrimX, 420], [scrimX, 780], [100, 420], [100, 780]])).toBe(false);
  const cancelsTouchScroll = (target: Locator) => target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const touch = new Touch({ identifier: 1, target: el, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
    const init = { touches: [touch], targetTouches: [touch], changedTouches: [touch], bubbles: true, cancelable: true };
    el.dispatchEvent(new TouchEvent('touchstart', init));
    const move = new TouchEvent('touchmove', init);
    el.dispatchEvent(move);
    el.dispatchEvent(new TouchEvent('touchend', { ...init, touches: [], targetTouches: [] }));
    return move.defaultPrevented;
  });
  // The scrim is the element just before the drawer, and what a touch beside it lands on.
  const scrim = sidebar.locator('xpath=preceding-sibling::div[1]');
  expect(await scrim.evaluate((el, x) => el === document.elementFromPoint(x, 420), scrimX)).toBe(true);
  expect(await cancelsTouchScroll(scrim)).toBe(true);
  expect(await cancelsTouchScroll(sidebar.getByRole('navigation', { name: 'Areas' }))).toBe(true);
  expect(await cancelsTouchScroll(sidebar.getByRole('tablist', { name: 'Sidebar view' }))).toBe(true);
  expect(await cancelsTouchScroll(sidebar.getByText('Thread 3', { exact: true }))).toBe(false);
  expect(await list.evaluate(el => getComputedStyle(el).overscrollBehaviorY)).toBe('contain');

  await dragAt(cdp, scrimX, 420, -300);
  await dragAt(cdp, scrimX, 420, 300);
  await page.mouse.move(scrimX, 420);
  await page.mouse.wheel(0, 400);
  await page.mouse.wheel(0, -400);

  // The drawer's list still scrolls, and a drag past its end stops there.
  await dragList(cdp, list, -600);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await dragList(cdp, list, -600);
  await dragList(cdp, list, 900);
  await drag(cdp, sidebar.getByRole('navigation', { name: 'Areas' }), -300);
  await drag(cdp, sidebar.getByRole('tablist', { name: 'Sidebar view' }), 300);

  await page.waitForTimeout(300);
  expect(await transcript.evaluate(el => el.scrollTop)).toBe(held);
  await expect(sidebar).toBeVisible();

  // Closed, the transcript takes a finger again.
  await page.keyboard.press('Escape');
  await expect(sidebar).toHaveCount(0);
  await drag(cdp, transcript, 300);
  await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBeLessThan(held - 100);
});
