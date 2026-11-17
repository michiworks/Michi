import { expect, test, type Locator, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

/**
 * The composer's context tray (ContextTray.tsx): what travels with the next
 * send, as one row of chips. Five comments and a quote used to stack five
 * rows deep and take two fifths of the pane; the tray keeps the composer one
 * row tall whatever waits in it, and hands the full list to a card.
 */

const PARAS = [
  'The build is slow mostly because the cache key changes on every run.',
  'A warm cache cuts the cold build from 9 minutes to under 2, and the lockfile hash is a stable key.',
  'We could also split the test step so the slow integration suite runs only on main.',
  'Either way the first green run will still look slow, because the cache has to be written once.',
  'After that the numbers hold as long as the lockfile is untouched.',
];
const NOTES = [
  'Why does it change? Is it the timestamp in the key, or the env hash?',
  'Can you show where the 9 minutes goes, step by step?',
  'Not now; keep one pipeline until the cache lands.',
  'Say this in the PR description too.',
  'Good.',
];

async function boot(page: Page, extra: object[] = []) {
  await installMockApi(page, { custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/agent-runs') { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/api/agent-runs/subscribe') { await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true; }
    return false;
  } });
  await page.addInitScript(({ paras, extra }) => {
    localStorage.clear(); sessionStorage.clear();
    const node = {
      nodeId: 'target', kind: 'chat', chatId: 'mock-target', runtimeId: 'mock', projectId: 'tray-ws', title: 'Build cache',
      status: 'idle', followUps: [],
      messages: [
        { id: 'u1', role: 'user', text: 'Why is CI so slow lately?', toolCalls: [], createdAt: 1 },
        { id: 'a1', role: 'assistant', text: paras.join('\n\n'), toolCalls: [], createdAt: 2 },
        ...extra,
      ],
    };
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'tray-ws', nodes: { target: node }, projects: [{
      id: 'tray-ws', name: 'Tray check', chatIds: ['target'], edges: [],
      trees: [{ id: 'tray-tree', rootNodeId: 'target', name: 'Build cache', createdAt: 1, lastActiveAt: 1 }],
      activeTreeId: 'tray-tree', contexts: [], createdAt: 1,
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ defaultPaneWidth: 640, sidebarExpanded: { workspaces: { 'tray-ws': true }, threads: { 'tray-tree': true } } }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'tray-ws::tray-tree': ['target'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'tray-ws::tray-tree': 'target' }));
  }, { paras: PARAS, extra });
  await page.goto('/');
  await page.getByText('Build cache', { exact: true }).first().click();
  await expect(page.locator('[data-msg-id="a1"] p').first()).toContainText(PARAS[0]);
}

/** Selects one paragraph of the answer the way a pointer does. */
async function selectPara(page: Page, index: number) {
  const para = page.locator('[data-msg-id="a1"] p').nth(index);
  await para.scrollIntoViewIfNeeded();
  const box = await para.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0);
    const first = rects[0];
    const last = rects[rects.length - 1];
    return { x1: first.left + 0.5, y1: first.top + first.height / 2, x2: last.right - 0.5, y2: last.top + last.height / 2 };
  });
  await page.mouse.move(box.x1, box.y1);
  await page.mouse.down();
  await page.mouse.move(box.x2, box.y2, { steps: 16 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
}

/** The path a comment arrives by: select the passage, Comment, write the note, save. */
async function addComment(page: Page, index: number, body: string) {
  await selectPara(page, index);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByPlaceholder('your reply to this passage…').fill(body);
  await page.getByRole('button', { name: 'Save comment' }).click();
  await expect(page.getByPlaceholder('your reply to this passage…')).toHaveCount(0);
}

const tray = (page: Page) => page.getByRole('group', { name: 'Sent with your message' });
const card = (page: Page) => page.getByRole('dialog', { name: 'Sent with your message' });

test.use({ viewport: { width: 1280, height: 820 } });

test('five comments and a quote keep the composer one row tall, and scroll sideways', async ({ page }) => {
  await boot(page);
  for (let i = 0; i < 5; i++) await addComment(page, i, NOTES[i]);
  await selectPara(page, 2);
  await page.getByRole('button', { name: 'Quote', exact: true }).click();

  const chips = tray(page).locator('.t-ctx-chip');
  await expect(chips).toHaveCount(6);
  // Five comments as stacked rows took ~340px of an ~780px pane; one row of
  // chips an attachment tall leaves the transcript its height.
  const composer = page.locator('.terminal-composer').first();
  const pane = page.locator('.terminal-pane').first();
  const [composerBox, paneBox] = [await composer.boundingBox(), await pane.boundingBox()];
  expect(composerBox!.height).toBeLessThan(paneBox!.height * 0.3);
  const sizes = await chips.evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)));
  expect(sizes).toEqual([64, 64, 64, 64, 64, 64]);

  // Nothing folds into a +N: the row scrolls, with three chips across it.
  const row = tray(page).locator('.t-ctx-tray-row');
  const metrics = await row.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth, chip: el.firstElementChild!.getBoundingClientRect().width }));
  expect(metrics.scroll).toBeGreaterThan(metrics.client);
  expect(Math.floor(metrics.client / metrics.chip)).toBe(3);
  await expect(tray(page)).toHaveAttribute('data-overflow', 'end');

  // A wheel over the row turns it, and both ends then say there is more.
  await row.hover();
  await page.mouse.wheel(0, 300);
  await expect(tray(page)).toHaveAttribute('data-overflow', 'start end');
  expect(await row.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
});

test('a chip opens the full list above the composer, where a note is edited', async ({ page }) => {
  await boot(page);
  await addComment(page, 0, NOTES[0]);
  await addComment(page, 1, NOTES[1]);

  const chip = page.getByRole('button', { name: `Comment: ${NOTES[1]}`, exact: true });
  await chip.click();
  await expect(card(page)).toBeVisible();
  // Over the transcript, above the composer, as wide as it.
  const [cardBox, composerBox] = [await card(page).boundingBox(), await page.locator('.terminal-composer').first().boundingBox()];
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);
  expect(Math.abs(cardBox!.width - composerBox!.width)).toBeLessThan(60);
  await expect(card(page).locator('.t-ctx.is-comment')).toHaveCount(2);
  // It opens on the chip's own comment, with its note ready to take the edit.
  await expect(card(page).locator('[data-target]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: `Edit comment: ${NOTES[1]}` })).toBeFocused();

  await page.getByRole('button', { name: `Edit comment: ${NOTES[1]}` }).click();
  const field = card(page).getByRole('textbox', { name: 'Edit comment' });
  await field.fill('Break the 9 minutes down by step, please.');
  await page.keyboard.press('Meta+Enter');
  await expect(card(page).getByRole('button', { name: 'Edit comment: Break the 9 minutes down by step, please.' })).toBeFocused();
  // The chip carries the edit, and Esc gives the keyboard back to it.
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  const edited = page.getByRole('button', { name: 'Comment: Break the 9 minutes down by step, please.', exact: true });
  await expect(edited).toBeFocused();

  // Its × takes the comment out of the send.
  await page.getByRole('button', { name: 'Remove comment: Break the 9 minutes down by step, please.' }).click();
  await expect(tray(page).locator('.t-ctx-chip')).toHaveCount(1);
  await expect(page.getByRole('button', { name: `Comment: ${NOTES[0]}`, exact: true })).toBeFocused();
});

/**
 * Waits until an element stops moving: the card scales in, and is placed again a
 * frame after the composer under it changes (touch restyles the composer).
 */
async function settled(page: Page, el: Locator) {
  await el.evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(a => a.finished.catch(() => null))));
  const twoFrames = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect.poll(async () => {
    const before = JSON.stringify(await el.boundingBox());
    await twoFrames();
    return before === JSON.stringify(await el.boundingBox());
  }).toBe(true);
}

/** The label of the button whose box, or hit area (::after), takes a tap at this point. */
const hitAt = (page: Page, x: number, y: number) => page.evaluate(([px, py]) =>
  document.elementFromPoint(px, py)?.closest('button')?.getAttribute('aria-label') ?? null, [x, y]);

test("the tray's small buttons take 24px, and 40px on touch, short of their neighbours", async ({ page }) => {
  await boot(page);
  await addComment(page, 0, NOTES[0]);
  await addComment(page, 1, NOTES[1]);
  const removeFirst = `Remove comment: ${NOTES[0]}`;

  // A pointer: the chip's 18px × answers 3px past its edge, inside the chip.
  await tray(page).locator('.t-ctx-chip').first().hover();
  let x = (await tray(page).getByRole('button', { name: removeFirst }).boundingBox())!;
  expect(await hitAt(page, x.x - 2, x.y + x.height + 2)).toBe(removeFirst);
  expect(await hitAt(page, x.x - 4, x.y + x.height / 2)).not.toBe(removeFirst);

  // The card's 20px buttons answer 2px past theirs.
  await page.getByRole('button', { name: `Comment: ${NOTES[1]}`, exact: true }).click();
  await expect(card(page)).toBeVisible();
  await settled(page, card(page));
  const rowX = card(page).getByRole('button', { name: removeFirst });
  const close = card(page).getByRole('button', { name: 'Close', exact: true });
  await card(page).locator('.t-ctx.is-comment').first().hover();
  let r = (await rowX.boundingBox())!;
  expect(await hitAt(page, r.x - 1, r.y + r.height / 2)).toBe(removeFirst);
  let c = (await close.boundingBox())!;
  expect(await hitAt(page, c.x + c.width / 2, c.y + c.height + 1)).toBe('Close');

  // Touch: 40px each, and the Close, the rows' × and the next chip never share a point.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await expect.poll(() => page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true);
  await settled(page, card(page));
  r = (await rowX.boundingBox())!;
  c = (await close.boundingBox())!;
  const next = (await card(page).getByRole('button', { name: `Remove comment: ${NOTES[1]}` }).boundingBox())!;
  expect(await hitAt(page, r.x - 9, r.y - 9)).toBe(removeFirst);
  expect(await hitAt(page, r.x + r.width + 9, r.y + r.height + 9)).toBe(removeFirst);
  expect(await hitAt(page, c.x + c.width / 2, c.y + c.height + 9)).toBe('Close');
  expect(r.y - c.y).toBeGreaterThanOrEqual(40);
  expect(next.y - r.y).toBeGreaterThanOrEqual(40);
  // Close's area runs to the card's edge, and no area past it scrolls the card sideways.
  const edge = await card(page).evaluate(el => el.getBoundingClientRect().left + el.clientLeft + el.clientWidth);
  expect(await hitAt(page, edge - 2, c.y + c.height / 2)).toBe('Close');
  expect(await card(page).evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);

  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await settled(page, tray(page));
  x = (await tray(page).getByRole('button', { name: removeFirst }).boundingBox())!;
  const chip = (await tray(page).locator('.t-ctx-chip').first().boundingBox())!;
  // 40 across, from 17px left of the × to the chip's own right edge...
  expect(await hitAt(page, x.x - 16, x.y + x.height + 10)).toBe(removeFirst);
  expect(await hitAt(page, chip.x + chip.width - 1, x.y + x.height / 2)).toBe(removeFirst);
  expect(await hitAt(page, chip.x + chip.width + 1, x.y + x.height / 2)).not.toBe(removeFirst);
  // ...and 40 down, from 6px above the chip, where the row does not clip it.
  expect(await hitAt(page, x.x + x.width / 2, chip.y - 5)).toBe(removeFirst);
  expect(await hitAt(page, x.x + x.width / 2, x.y + x.height + 10)).toBe(removeFirst);
  // Two chips fit, and the areas add nothing to the row's scroll width.
  expect(await tray(page).locator('.t-ctx-tray-row').evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
});

test("a sent row's chevron takes 40px on touch, short of the next row and the message's text", async ({ page }) => {
  // One-line rows: an old comment without a note, and a quote, each long enough to clip.
  const sent = (n: number) => `${PARAS[n]} ${PARAS[n + 1]} ${PARAS[n + 2]}`;
  await boot(page, [{
    id: 'u2', role: 'user', text: 'Go on with the cache.', toolCalls: [], createdAt: 3,
    comments: [0, 1].map(n => ({ id: `c${n}`, quotedText: sent(n), body: '', createdAt: 3 })),
    quotedText: sent(2),
  }]);
  const msg = page.locator('[data-msg-id="u2"]');
  await msg.scrollIntoViewIfNeeded();
  const rows = msg.locator('.t-ctx-list.is-msg > .t-ctx, .t-ctx.is-msg');
  await expect(rows).toHaveCount(3);
  await expect(msg.locator('.t-ctx-btn')).toHaveCount(3);
  // A pointer keeps a one-line row its line's height.
  expect((await rows.last().boundingBox())!.height).toBeLessThan(28);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await expect.poll(() => page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true);
  await settled(page, msg);
  const buttons = await msg.locator('.t-ctx-btn').evaluateAll(els => els.map(el => el.getBoundingClientRect().toJSON() as DOMRect));
  const labels = await msg.locator('.t-ctx-btn').evaluateAll(els => els.map(el => el.getAttribute('aria-label')));
  expect(labels).toEqual(['Show full comment', 'Show full comment', 'Show full quote']);
  for (let i = 0; i < buttons.length; i++) {
    // The chevron takes a tap 9px under its box.
    expect(await hitAt(page, buttons[i].left + buttons[i].width / 2, buttons[i].bottom + 9)).toBe(labels[i]);
  }
  for (let i = 0; i + 1 < buttons.length; i++) {
    // Each 40px area (10px past the 20px button) ends where the next one begins.
    expect(buttons[i + 1].top - 10).toBeGreaterThanOrEqual(buttons[i].bottom + 10);
  }
  const text = (await msg.getByText('Go on with the cache.').boundingBox())!;
  // The text starts about 10px past where the last area ends (without the 32px rows, 0).
  expect(text.y).toBeGreaterThanOrEqual(buttons[2].bottom + 19);
});
