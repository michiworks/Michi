import { test, expect, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

// A long transcript mounts its newest turns first and the rest above them in
// idle batches (components/terminal/progressiveMount.ts): the view does not
// move while they come, a saved anchor above the first batch is still where
// the pane opens, and find reaches the oldest message.
//
// State is seeded through localStorage (michi:v1:state) like scroll-restore;
// every /api call is intercepted by mockApi.

const STATE_SCHEMA_VERSION = 5;
const PROJECT_ID = 'progressive-ws';
const TURNS = 60;
const BASE_T = 1_780_000_000_000;

function makeChatNode(nodeId: string, chat: string, turns: number) {
  const messages = [] as unknown[];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ id: `u-${nodeId}-${turn}`, role: 'user', toolCalls: [], createdAt: BASE_T + turn * 1_000,
      text: `Question ${turn} for chat ${chat}, with enough words to wrap onto a couple of lines in the pane.` });
    messages.push({ id: `a-${nodeId}-${turn}`, role: 'assistant', text: '', toolCalls: [], streaming: false,
      blocks: [{ id: `b-${nodeId}-${turn}`, kind: 'answer', rawText: `Answer ${turn}. ${'This sentence pads the reply. '.repeat(30)}` }],
      createdAt: BASE_T + turn * 1_000 + 500 });
  }
  return { nodeId, kind: 'chat', chatId: `mock-chat-${nodeId}`, runtimeId: 'mock', projectId: PROJECT_ID, messages,
    followUps: [], title: `Chat ${chat}`, status: 'idle', viewedAt: BASE_T + turns * 1_000,
    lastAssistantAt: BASE_T + (turns - 1) * 1_000 + 500 };
}

async function seed(page: Page, scrollAnchors?: unknown) {
  const state = {
    version: STATE_SCHEMA_VERSION,
    activeProjectId: PROJECT_ID,
    projects: [{ id: PROJECT_ID, name: 'Progressive WS', chatIds: ['nA', 'nB'], edges: [], contexts: [], createdAt: BASE_T,
      trees: [
        { id: 'tree-a', rootNodeId: 'nA', createdAt: BASE_T, lastActiveAt: BASE_T + 100 },
        { id: 'tree-b', rootNodeId: 'nB', createdAt: BASE_T, lastActiveAt: BASE_T + 50 },
      ],
      activeTreeId: 'tree-b' }],
    nodes: { nA: makeChatNode('nA', 'A', TURNS), nB: makeChatNode('nB', 'B', 2) },
  };
  await page.addInitScript(({ saved, anchors }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('michi:migrated', '1');
    window.localStorage.setItem('michi:v1:state', JSON.stringify(saved));
    if (anchors) window.localStorage.setItem('michi:paneScrollAnchors', JSON.stringify(anchors));
  }, { saved: state, anchors: scrollAnchors ?? null });
  await installMockApi(page);
}

const frames = (page: Page) => page.locator('[data-node-id="nA"] [data-msg-id]');

/** Where a message's top sits below the pane's viewport top, and how far the pane is from its bottom. */
function place(page: Page, messageId: string) {
  return page.evaluate((id) => {
    const el = document.querySelector('[data-node-id="nA"] .term-scrollbar') as HTMLElement;
    const msg = el.querySelector(`[data-msg-id="${id}"]`) as HTMLElement | null;
    return {
      top: msg ? msg.getBoundingClientRect().top - el.getBoundingClientRect().top : null,
      fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
    };
  }, messageId);
}

test.describe('progressive mount', () => {
  test('a long chat opens on its newest turns and mounts the rest above them without moving the view', async ({ page }) => {
    await seed(page);
    await page.goto('/');
    await page.getByText('Chat A', { exact: true }).first().click();
    await expect(page.locator('[data-node-id="nA"] [data-msg-id="a-nA-59"]')).toBeAttached();
    expect(await frames(page).count()).toBeLessThan(TURNS * 2);
    // The mount restore holds the bottom for a moment; the batches come after it.
    await page.waitForTimeout(500);
    const before = await place(page, 'a-nA-59');
    await expect(frames(page)).toHaveCount(TURNS * 2, { timeout: 10_000 });
    await page.waitForTimeout(300);
    const after = await place(page, 'a-nA-59');
    expect(after.fromBottom).toBeLessThan(200);
    expect(Math.abs(after.top! - before.top!)).toBeLessThan(3);
  });

  test('a saved anchor above the first batch is where the chat opens, and stays there', async ({ page }) => {
    const lastSeen = BASE_T + (TURNS - 1) * 1_000 + 500;
    await seed(page, [['nA', { anchorId: 'u-nA-10', offset: -20, atBottom: false, lastSeen }]]);
    await page.goto('/');
    await page.getByText('Chat A', { exact: true }).first().click();
    await expect(page.locator('[data-node-id="nA"] [data-msg-id="u-nA-10"]')).toBeAttached();
    await page.waitForTimeout(500);
    const opened = await place(page, 'u-nA-10');
    expect(Math.abs(opened.top! + 20)).toBeLessThan(24);
    await expect(frames(page)).toHaveCount(TURNS * 2, { timeout: 10_000 });
    await page.waitForTimeout(300);
    expect(Math.abs((await place(page, 'u-nA-10')).top! - opened.top!)).toBeLessThan(3);
  });

  test('find reaches the oldest message', async ({ page }) => {
    await seed(page);
    await page.goto('/');
    await page.getByText('Chat A', { exact: true }).first().click();
    await expect(page.locator('[data-node-id="nA"] [data-msg-id="a-nA-59"]')).toBeAttached();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('michi:open-pane-find', { detail: { nodeId: 'nA' } })));
    const input = page.locator('[data-node-id="nA"] .t-pane-find-input');
    await input.fill('Question 0 for chat A,');
    await expect(page.locator('[data-node-id="nA"] .t-pane-find-counter')).toHaveText('1 / 1');
    await input.press('Enter');
    await expect.poll(async () => {
      const { top } = await place(page, 'u-nA-0');
      const height = await page.locator('[data-node-id="nA"] .term-scrollbar').first().evaluate((el) => el.clientHeight);
      return top !== null && top > -40 && top < height;
    }).toBe(true);
  });
});
