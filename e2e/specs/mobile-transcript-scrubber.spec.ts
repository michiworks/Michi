import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

// The phone scrubber: scrolling a long conversation brings a handle out of the
// transcript's right edge; held and dragged with a finger it scrolls the
// transcript and a bubble names the question at that point.

const QUESTIONS = 8;

async function phone(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  return context.newPage();
}

async function boot(page: Page) {
  await installMockApi(page);
  await page.addInitScript((count) => {
    localStorage.clear(); sessionStorage.clear();
    const answer = Array(12).fill('Each answer runs long enough that the conversation spans many screens.').join('\n\n');
    const messages = Array.from({ length: count }, (_, i) => [
      { id: `q${i}`, role: 'user', text: `Question ${i + 1} about the phone layout`, toolCalls: [], createdAt: 1 + i * 2 },
      { id: `a${i}`, role: 'assistant', text: answer, toolCalls: [], createdAt: 2 + i * 2 },
    ]).flat();
    const nodes = { root: { nodeId: 'root', title: 'Long chat', kind: 'chat', chatId: null, projectId: 'phone', status: 'idle', followUps: [], messagesLoaded: true, messages } };
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'phone', nodes, projects: [{
      id: 'phone', name: 'Mobile workspace', createdAt: 1, chatIds: ['root'], activeTreeId: 'tree-0',
      trees: [{ id: 'tree-0', rootNodeId: 'root', name: 'Long chat', createdAt: 1, lastActiveAt: 100 }], edges: [],
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarView: 'structure', sidebarCollapsed: true,
      sidebarExpanded: { workspaces: { phone: true }, threads: {}, branches: {} }, reduceMotion: true }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'phone::tree-0': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'phone::tree-0': 'root' }));
  }, QUESTIONS);
  await page.goto('/');
}

/** Raw touch input: put a finger down, move it in steps, lift it. */
const finger = (cdp: CDPSession) => ({
  down: (x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }),
  async move(x: number, from: number, to: number) {
    for (let i = 1; i <= 15; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(from + ((to - from) * i) / 15) }] });
    }
  },
  up: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
});

test('dragging the handle scrolls the transcript and names the question there', async ({ browser, baseURL }) => {
  const page = await phone(browser, baseURL);
  await boot(page);
  await openThreadFromSidebar(page, 'Long chat');
  const pane = page.locator('.terminal-pane[data-node-id="root"]');
  const transcript = pane.locator('.terminal-pane__transcript');
  const handle = pane.locator('.transcript-scrubber__handle');
  const bubble = pane.locator('.transcript-scrubber__bubble');
  await expect.poll(() => transcript.evaluate((el) => el.scrollHeight > el.clientHeight * 3)).toBe(true);
  const touch = finger(await page.context().newCDPSession(page));

  // Opening and following the conversation leave the handle in.
  await expect(handle).not.toHaveAttribute('data-shown', '');

  // A finger scroll brings it out at the edge.
  const box = (await transcript.boundingBox())!;
  const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);
  await touch.down(cx, cy);
  await touch.move(cx, cy, cy + 200);
  await touch.up();
  await expect(handle).toHaveAttribute('data-shown', '');
  const before = await transcript.evaluate((el) => el.scrollTop);

  // Hold the handle and drag it to the top of the track: the transcript
  // follows, and the bubble names the first question.
  const grip = (await handle.boundingBox())!;
  const x = Math.round(grip.x + grip.width - 12);
  const start = Math.round(grip.y + grip.height / 2);
  await touch.down(x, start);
  await touch.move(x, start, 0);
  await expect(bubble).toHaveAttribute('data-shown', '');
  await expect(bubble).toContainText(`1 / ${QUESTIONS}`);
  await expect(bubble).toContainText('Question 1 about the phone layout');
  expect(await transcript.evaluate((el) => el.scrollTop)).toBeLessThan(before - 500);
  await expect(pane.locator('[data-scrub-target]')).toHaveAttribute('data-msg-id', 'q0');

  // Halfway down: a question from the middle of the conversation.
  const track = (await pane.locator('.transcript-scrubber').boundingBox())!;
  await touch.move(x, 0, Math.round(track.y + track.height / 2));
  const label = await bubble.locator('.transcript-scrubber__meta').innerText();
  const index = Number(label.split('/')[0]);
  expect(index).toBeGreaterThan(2);
  expect(index).toBeLessThan(QUESTIONS);
  await expect(pane.locator('[data-scrub-target]')).toHaveAttribute('data-msg-id', `q${index - 1}`);

  // Lifting the finger puts the bubble away; the page itself never scrolled.
  await touch.up();
  await expect(bubble).not.toHaveAttribute('data-shown', '');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
