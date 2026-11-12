import { expect, test, type Browser, type Page } from '@playwright/test';
import type { ReplyMemorySource } from '../../shared/src/memory';
import { installMockApi } from '../fixtures/mockApi';
import { createMemoryMock, memoryRecord, type MemoryMockController } from '../fixtures/memoryFixtures';
import { CONVERSATION_COMPOSER, openThreadFromSidebar, settingsMain } from '../fixtures/shell';

// What a reply was based on, against the mock API: no backend, SQLite or
// agent. The line under a reply that repeated what Michi gave the model;
// Forget, Edit and Don't recall; a phone's first tap; a chat set to Off; and
// a streamed reply that asks once it is done, without moving what is read.

const PNPM = memoryRecord('mem-pnpm', 'Use pnpm, never npm, in this repo.', { kind: 'convention' });
const based = (): ReplyMemorySource[] => [
  { kind: 'memory', memoryId: PNPM.id, text: PNPM.body, savedBy: 'user', at: Date.now() - 3_600_000, from: null },
  { kind: 'conversation', docId: 41, text: 'We ship on Fridays', at: Date.now() - 2 * 86_400_000,
    from: { nodeId: 'chat', messageId: 'chat-q1', title: 'Repo setup' } },
];
const REGION = 'What this reply was based on';

async function boot(page: Page, memory: MemoryMockController, turns = 2): Promise<void> {
  await installMockApi(page, { custom: memory.handle });
  await page.addInitScript(({ count }) => {
    localStorage.clear();
    sessionStorage.clear();
    const messages: unknown[] = [];
    for (let i = 1; i <= count; i += 1) {
      messages.push({ id: `chat-q${i}`, role: 'user', text: `Question ${i}: how do I install the dependencies?`, toolCalls: [], createdAt: i * 2 - 1 },
        { id: `chat-a${i}`, role: 'assistant', text: `Answer ${i}: install them with pnpm, as this repo does.\n\nThen run the tests.`, toolCalls: [], createdAt: i * 2 });
    }
    const nodes = { chat: { nodeId: 'chat', title: 'Repo setup', kind: 'chat', chatId: null, projectId: 'ws', status: 'idle', followUps: [], messagesLoaded: true, messages } };
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'ws', nodes, projects: [{
      id: 'ws', name: 'Alpha', createdAt: 1, chatIds: ['chat'], activeTreeId: 'tree',
      trees: [{ id: 'tree', rootNodeId: 'chat', name: 'Repo setup', createdAt: 1, lastActiveAt: 2 }], edges: [],
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, reduceMotion: true }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'ws::tree': ['chat'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'ws::tree': 'chat' }));
  }, { count: turns });
  await page.goto('/');
  await openThreadFromSidebar(page, 'Repo setup');
}

const reply = (page: Page, id: string) => page.locator(`[data-msg-id="${id}"]`);

test('only the reply with sources shows the line; Forget asks first, then deletes and says so; the keyboard opens and closes it', async ({ page }, info) => {
  const memory = createMemoryMock({ records: [PNPM], sources: { 'chat-a2': based() }, conversations: true });
  await boot(page, memory);
  const line = reply(page, 'chat-a2').getByRole('region', { name: REGION });
  await expect(line).toBeVisible();
  await expect(page.getByRole('region', { name: REGION })).toHaveCount(1);
  expect(memory.sourceRequests).toEqual([['chat-a1', 'chat-a2']]);
  const toggle = line.locator('.t-reply-sources-toggle');
  await expect(toggle).toHaveText('Based on 2 things you told me');
  await expect(toggle).toHaveAttribute('title', 'What Michi remembered for this reply. It may not list everything.');
  // Enter and Space open and close it; Escape closes it and keeps focus on the toggle.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(line.getByRole('listitem')).toHaveCount(2);
  await expect(line.getByRole('listitem').nth(0)).toContainText('Saved by you · today');
  await expect(line.getByRole('listitem').nth(1)).toContainText('From a past chat');
  await page.screenshot({ path: info.outputPath('reply-sources-open.png') });
  await line.getByRole('button', { name: 'Forget' }).click();
  expect(memory.writes).toEqual([]);
  await line.getByRole('button', { name: 'Confirm forget' }).click();
  await expect(line.getByRole('status')).toHaveText('Forgotten.');
  await expect(toggle).toHaveText('Based on 1 thing you told me');
  expect(memory.writes).toEqual(['DELETE /memories/mem-pnpm']);
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  await line.getByRole('button', { name: 'Don’t recall' }).click();
  await line.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(line.getByRole('status')).toHaveCount(2);
  expect(memory.writes).toEqual(['DELETE /memories/mem-pnpm', 'POST /memory-recall/hide']);
  expect(memory.writeBodies[1]).toEqual({ docId: 41 });
  // Focus returns to the toggle on the next frame; Escape is the section's from there.
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: REGION })).toHaveCount(0);
});

test('Edit opens Settings › Memory with the memory marked', async ({ page }) => {
  const memory = createMemoryMock({ records: [PNPM, memoryRecord('mem-other', 'Answer in Chinese')], sources: { 'chat-a2': based() }, conversations: true });
  await boot(page, memory);
  const line = reply(page, 'chat-a2').getByRole('region', { name: REGION });
  await line.locator('.t-reply-sources-toggle').click();
  await line.getByRole('button', { name: 'Edit' }).click();
  const settings = settingsMain(page);
  await expect(settings.getByRole('heading', { level: 1, name: 'Memory' })).toBeVisible();
  await expect(settings.getByRole('list', { name: 'Saved memories' }).getByRole('listitem', { name: PNPM.body })).toHaveAttribute('data-marked', 'true');
});

async function phone(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  return { context, page: await context.newPage() };
}

test('on a phone the first tap opens it, reveals none of the message\'s actions, and every target is at least 44 px', async ({ browser, baseURL }, info) => {
  const { context, page } = await phone(browser, baseURL);
  try {
    // An earlier reply: on touch the pane's latest reply shows its actions at rest (actionsAtRest), an earlier
    // one only once the message is tapped, so here a tap that revealed them would show.
    const memory = createMemoryMock({ records: [PNPM], sources: { 'chat-a1': based() }, conversations: true });
    await boot(page, memory);
    // boot opens the chat with clicks, and their mouse stays over the transcript; a phone has no such pointer.
    await page.mouse.move(0, 0);
    const message = reply(page, 'chat-a1');
    const toggle = message.locator('.t-reply-sources-toggle');
    await expect(toggle).toBeVisible();
    await expect(message.locator('.t-msg-actions')).toHaveCSS('opacity', '0');
    await toggle.tap();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(message.locator('.t-msg-actions')).toHaveCSS('opacity', '0');
    for (const target of [toggle, ...await message.locator('.t-reply-sources-action').all()]) {
      const box = (await target.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    await message.getByRole('button', { name: 'Forget' }).tap();
    await expect(message.getByRole('button', { name: 'Confirm forget' })).toBeVisible();
    await expect(message.locator('.t-msg-actions')).toHaveCSS('opacity', '0');
    await page.screenshot({ path: info.outputPath('reply-sources-phone.png') });
  } finally {
    await context.close();
  }
});

test('a chat switched to Off shows no line under its replies', async ({ page }) => {
  const memory = createMemoryMock({ records: [PNPM], sources: { 'chat-a1': based(), 'chat-a2': based() }, conversations: true });
  await boot(page, memory);
  await expect(page.getByRole('region', { name: REGION })).toHaveCount(2);
  await page.getByRole('button', { name: 'Memory: Learn' }).click();
  await page.getByRole('menu', { name: 'Memory for this chat' }).getByRole('menuitemradio', { name: /^Off/ }).click();
  await expect(page.getByRole('button', { name: 'Memory: Off' })).toBeVisible();
  await expect(page.getByRole('region', { name: REGION })).toHaveCount(0);
  // The lines leave at once; their replies then ask again (batched), and the chat answers none.
  await expect.poll(() => memory.sourceRequests.length).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('region', { name: REGION })).toHaveCount(0);
});

test('a streamed reply asks once it is done; lines loading for history above keep the reading position', async ({ page }) => {
  const memory = createMemoryMock({ records: [PNPM], sources: { 'chat-a1': based() }, conversations: true, sourcesDelayMs: 500 });
  await boot(page, memory, 12);
  const newest = reply(page, 'chat-a12');
  await expect(newest).toBeVisible();
  const before = (await newest.boundingBox())!;
  await expect.poll(() => memory.sourceRequests.length).toBeGreaterThan(0);
  // The line under the first reply (far above the viewport) arrives half a second later.
  await expect(reply(page, 'chat-a1').getByRole('region', { name: REGION })).toHaveCount(1);
  const after = (await newest.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  const seen = new Set(memory.sourceRequests.flat());
  const composer = page.locator(CONVERSATION_COMPOSER).first();
  await composer.locator('[contenteditable="true"]').fill('And the lint step?');
  await composer.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
  // The reply asks after its done frame, for its own id.
  await expect.poll(() => memory.sourceRequests.flat().some((id) => !seen.has(id)), { timeout: 10_000 }).toBe(true);
});
