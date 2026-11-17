import { expect, test, type Locator, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { CONVERSATION_COMPOSER, openSettings, settingsMain } from '../fixtures/shell';
import { createMemoryMock, memoryChange, memoryRecord, type MemoryMockController } from '../fixtures/memoryFixtures';

// Settings › Memory, its notices and a temporary chat started from Home
// against the mock API: no backend, SQLite or agent runtime. The change feed
// answers with queued changes, the way the backend forwards an agent's or
// automatic memory's writes.

const WORKSPACES = [{ workspace: { id: 'a', name: 'Alpha', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] }];

async function boot(page: Page, memory: MemoryMockController): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false, reduceMotion: true }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, { workspaces: WORKSPACES, custom: memory.handle });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
}

test('an agent’s memory shows “Remembered” with Undo, and Undo deletes it; automatic memory stays quiet', async ({ page }) => {
  const saved = memoryRecord('mem-agent', 'Answer in Chinese unless I write in English', { source: { nodeId: 'n-1' } });
  const extracted = memoryRecord('mem-auto', 'Deploys go out on Fridays', { origin: 'extracted', kind: 'fact' });
  const memory = createMemoryMock({ records: [saved, extracted] });
  memory.announce(memoryChange(extracted), memoryChange(saved));
  await boot(page, memory);

  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Remembered: Answer in Chinese unless I write in English' });
  await expect(toast).toBeVisible();
  // The automatic one, announced first, showed nothing.
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Deploys go out on Fridays' })).toHaveCount(0);
  // A background notice leaves focus where it was.
  await expect(page.locator('[data-sonner-toast] :focus')).toHaveCount(0);
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Memory removed' })).toBeVisible();
  expect(memory.writes).toEqual(['DELETE /memories/mem-agent']);
  expect(memory.records).toEqual([extracted]);
});

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;

/** Topics in two places, one memory without a topic, and About the user resting on some of them. */
function library(): MemoryMockController {
  return createMemoryMock({
    records: [
      memoryRecord('mem-zh', 'Answer in Chinese unless I write in English', { createdAt: 6, updatedAt: minutesAgo(10), topic: 'Answers' }),
      memoryRecord('mem-short', 'Lead with the result; no recap at the end', { createdAt: 5, updatedAt: minutesAgo(20), topic: 'Answers', origin: 'extracted' }),
      memoryRecord('mem-job', 'I work at Example Studio in Tokyo', { createdAt: 4, updatedAt: minutesAgo(30), topic: 'Work', kind: 'fact', origin: 'extracted', keywords: ['job', '工作'] }),
      memoryRecord('mem-pnpm', 'Prefers pnpm over npm', { createdAt: 3, updatedAt: minutesAgo(40), topic: 'feedback', origin: 'extracted', importSource: 'claude', importRef: 'michi/feedback.md' }),
      memoryRecord('mem-old', 'Deploys go out on Fridays', { createdAt: 2, updatedAt: minutesAgo(50), kind: 'fact', origin: 'extracted' }),
      memoryRecord('mem-ws', 'Use 2 spaces in this repo', { createdAt: 1, updatedAt: minutesAgo(60), topic: 'Code style', kind: 'convention', scope: { kind: 'workspace', workspaceId: 'a' } }),
    ],
    profile: {
      lines: [
        { topic: 'Answers', text: 'Wants answers in Chinese, result first', refs: ['mem-zh', 'mem-short'] },
        { topic: 'Work', text: 'Works at Example Studio in Tokyo', refs: ['mem-job'] },
      ],
      builtAt: Date.now() - 3 * 3600_000,
      version: 2,
    },
  });
}

async function openYourMemories(page: Page) {
  const settings = await openSettings(page, 'Memory');
  const row = settings.locator('.settings-row').filter({ has: page.getByText('Your memories', { exact: true }) });
  await row.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(settings.getByRole('heading', { level: 1, name: 'Your memories' })).toBeVisible();
  return settings;
}

const rowsOf = (group: Locator) => group.locator('.settings-history__title');

test('Your memories lists topics where they apply; a topic shows its summary and each memory; a memory edits, moves and deletes', async ({ page }, info) => {
  const memory = library();
  await boot(page, memory);
  const settings = await openSettings(page, 'Memory');
  await expect(settings.getByText('6 memories · 4 topics')).toBeVisible();
  await openYourMemories(page);

  const everywhere = settings.getByRole('region', { name: /^Everywhere/ });
  await expect(rowsOf(everywhere)).toHaveText(['Answers', 'Work', 'feedback', 'Other']);
  await expect(rowsOf(settings.getByRole('region', { name: /^Alpha/ }))).toHaveText(['Code style']);
  await expect(everywhere.getByRole('button', { name: 'Answers', exact: true })).toHaveAccessibleDescription(/2 memories.*Wants answers in Chinese, result first/);
  await expect(everywhere.getByText('Summaries written 3h ago')).toBeVisible();
  await page.screenshot({ path: info.outputPath('memory-manage.png') });

  // A search lists the memories themselves, by their text, topic or search words.
  await settings.getByRole('searchbox', { name: 'Search memories' }).fill('工作');
  await expect(rowsOf(settings)).toHaveText(['I work at Example Studio in Tokyo']);
  await settings.getByRole('searchbox', { name: 'Search memories' }).fill('');

  await everywhere.getByRole('button', { name: 'Answers', exact: true }).click();
  await expect(settings.getByRole('heading', { level: 1, name: 'Answers' })).toBeFocused();
  await expect(settings.getByRole('region', { name: 'Summary' })).toContainText('Wants answers in Chinese, result first');
  const memories = settings.getByRole('region', { name: 'Memories' });
  await expect(rowsOf(memories)).toHaveText(['Answer in Chinese unless I write in English', 'Lead with the result; no recap at the end']);
  await page.screenshot({ path: info.outputPath('memory-topic.png') });

  await memories.getByRole('button', { name: 'Answer in Chinese unless I write in English', exact: true }).click();
  await expect(settings.getByRole('heading', { level: 1, name: 'Answer in Chinese unless I write in English' })).toBeFocused();
  const details = settings.getByRole('region', { name: 'Details' });
  await expect(details).toContainText('By you');
  await expect(details.getByRole('combobox', { name: 'Applies to' })).toHaveValue('user');
  await expect(details.getByRole('combobox', { name: 'Topic' })).toHaveValue('Answers');
  await page.screenshot({ path: info.outputPath('memory-detail.png') });

  await settings.getByRole('button', { name: 'Edit', exact: true }).click();
  await settings.getByRole('textbox', { name: 'Memory' }).fill('Answer in Chinese; code comments in English');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings.getByRole('heading', { level: 1, name: 'Answer in Chinese; code comments in English' })).toBeVisible();
  await details.getByRole('combobox', { name: 'Applies to' }).selectOption({ label: 'Alpha' });
  await expect(settings.locator('.settings-history__detail-kind')).toHaveText('Answers · Alpha');
  const topic = details.getByRole('combobox', { name: 'Topic' });
  await topic.fill('Language');
  await topic.press('Enter');
  await expect(settings.locator('.settings-history__detail-kind')).toHaveText('Language · Alpha');

  // Back returns to the topic it was opened from, which keeps its other memory.
  await settings.getByRole('button', { name: 'Answers', exact: true }).click();
  await expect(rowsOf(settings.getByRole('region', { name: 'Memories' }))).toHaveText(['Lead with the result; no recap at the end']);
  await settings.getByRole('button', { name: 'Lead with the result; no recap at the end', exact: true }).click();
  await settings.getByRole('button', { name: 'Delete…' }).click();
  await page.getByRole('dialog', { name: 'Delete this memory?' }).getByRole('button', { name: 'Delete', exact: true }).click();
  // Its topic went with it: Your memories again.
  await expect(settings.getByRole('heading', { level: 1, name: 'Your memories' })).toBeVisible();
  await expect(rowsOf(settings.getByRole('region', { name: /^Everywhere/ }))).toHaveText(['Work', 'feedback', 'Other']);
  await expect(rowsOf(settings.getByRole('region', { name: /^Alpha/ }))).toHaveText(['Language', 'Code style']);

  expect(memory.writes).toEqual(['PATCH /memories/mem-zh', 'PATCH /memories/mem-zh', 'PATCH /memories/mem-zh', 'DELETE /memories/mem-short']);
  expect(memory.writeBodies).toEqual([
    { body: 'Answer in Chinese; code comments in English', expectedVersion: 1 },
    { scope: { kind: 'workspace', workspaceId: 'a' }, expectedVersion: 2 },
    { topic: 'Language', expectedVersion: 3 },
    null,
  ]);
  // What Settings changed itself shows no "Remembered" notice.
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Remembered' })).toHaveCount(0);
});

test('a memory says where it came from; a topic is deleted with its memories after asking; Rebuild asks About the user again', async ({ page }) => {
  const memory = library();
  await boot(page, memory);
  const settings = await openYourMemories(page);
  const everywhere = settings.getByRole('region', { name: /^Everywhere/ });

  await everywhere.getByRole('button', { name: 'feedback', exact: true }).click();
  await settings.getByRole('button', { name: 'Prefers pnpm over npm', exact: true }).click();
  await expect(settings.getByRole('region', { name: 'Details' })).toContainText('From Claude Code');
  await expect(settings.getByRole('region', { name: 'Details' })).toContainText('michi/feedback.md');
  await page.keyboard.press('Escape');
  await expect(settings.getByRole('heading', { level: 1, name: 'feedback' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings.getByRole('heading', { level: 1, name: 'Your memories' })).toBeVisible();

  await everywhere.getByRole('button', { name: 'Work', exact: true }).click();
  await settings.getByRole('button', { name: 'Delete Work…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete Work?' });
  await expect(confirm).toContainText('This deletes its 1 memory.');
  await confirm.getByRole('button', { name: 'Delete 1 memory' }).click();
  await expect(settings.getByRole('heading', { level: 1, name: 'Your memories' })).toBeVisible();
  await expect(rowsOf(everywhere)).toHaveText(['Answers', 'feedback', 'Other']);

  await everywhere.getByRole('button', { name: 'Rebuild' }).click();
  await expect(everywhere.getByRole('button', { name: 'Rebuilding…' })).toBeDisabled();
  expect(memory.writes).toEqual(['DELETE /memories/mem-job', 'POST /memory-profile/rebuild']);
});

test('a memory shows the last day it is true where it is listed, and its page sets or clears it', async ({ page }, info) => {
  const nextWeek = new Date();
  nextWeek.setHours(0, 0, 0, 0);
  nextWeek.setDate(nextWeek.getDate() + 7);
  const memory = createMemoryMock({
    records: [
      memoryRecord('mem-trip', 'In Tokyo for the conference this week', { kind: 'fact', origin: 'extracted', topic: 'Travel', validUntil: nextWeek.getTime() }),
      memoryRecord('mem-freeze', 'Code freeze for the release', { kind: 'fact', topic: 'Travel', createdAt: 1 }),
    ],
  });
  await boot(page, memory);
  const settings = await openYourMemories(page);
  await settings.getByRole('region', { name: /^Everywhere/ }).getByRole('button', { name: 'Travel', exact: true }).click();
  const memories = settings.getByRole('region', { name: 'Memories' });
  await expect(memories.getByRole('button', { name: 'In Tokyo for the conference this week', exact: true })).toContainText('Until');

  await memories.getByRole('button', { name: 'Code freeze for the release', exact: true }).click();
  const lastDay = settings.getByRole('region', { name: 'Details' }).getByLabel('Last day it’s true');
  await lastDay.fill('2030-12-01');
  await lastDay.press('Enter');
  await expect(settings.getByRole('button', { name: 'No end date', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('memory-until.png') });
  await settings.getByRole('button', { name: 'Travel', exact: true }).click();
  await expect(memories.getByRole('button', { name: 'Code freeze for the release', exact: true })).toContainText('Until Dec 1, 2030');

  await memories.getByRole('button', { name: 'In Tokyo for the conference this week', exact: true }).click();
  await settings.getByRole('button', { name: 'No end date', exact: true }).click();
  await expect(settings.getByRole('region', { name: 'Details' }).getByLabel('Last day it’s true')).toHaveValue('');

  expect(memory.writes).toEqual(['PATCH /memories/mem-freeze', 'PATCH /memories/mem-trip']);
  expect(memory.writeBodies).toEqual([
    { validUntil: new Date(2030, 11, 2).getTime(), expectedVersion: 1 },
    { validUntil: null, expectedVersion: 1 },
  ]);
});

test('Guesses: collapsed until opened; That’s right saves one as a memory, Not true drops one, and nothing asks for attention', async ({ page }, info) => {
  const memory = createMemoryMock({
    records: [
      memoryRecord('mem-hotpot', 'Loves Sichuan hot pot', { origin: 'extracted', createdAt: 2 }),
      memoryRecord('mem-curry', 'Orders the hottest curry', { origin: 'extracted', createdAt: 1 }),
    ],
    guesses: [
      { id: 'mg-spicy', body: 'Likes spicy food', refs: ['mem-hotpot', 'mem-curry'] },
      { id: 'mg-lunch', body: 'Eats lunch at the desk', refs: ['mem-hotpot', 'mem-curry'] },
    ],
  });
  await boot(page, memory);
  // A guess brings no toast and no badge.
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  const settings = await openSettings(page, 'Memory');
  await expect(settings.getByText('2 memories')).toBeVisible();
  const guesses = settings.getByRole('region', { name: 'Guesses' });
  await expect(guesses.getByRole('list', { name: 'Guesses' })).toHaveCount(0);
  await guesses.getByRole('button', { name: 'Show guesses' }).click();
  const list = guesses.getByRole('list', { name: 'Guesses' });
  await expect(list.getByRole('listitem').filter({ hasText: 'Likes spicy food' })).toContainText('Loves Sichuan hot pot');
  await guesses.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('memory-guesses.png') });

  await list.getByRole('listitem').filter({ hasText: 'Likes spicy food' }).getByRole('button', { name: 'That’s right' }).click();
  await expect(settings.getByText('3 memories')).toBeVisible();
  await list.getByRole('listitem').filter({ hasText: 'Eats lunch at the desk' }).getByRole('button', { name: 'Not true' }).click();
  await expect(settings.getByRole('region', { name: 'Guesses' })).toHaveCount(0);
  expect(memory.writes).toEqual(['POST /memory-guesses/mg-spicy/confirm', 'POST /memory-guesses/mg-lunch/reject']);
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Remembered' })).toHaveCount(0);
});

test('Settings › Memory is one switch: off keeps memories listed and stops adding them', async ({ page }, info) => {
  const memory = createMemoryMock({ records: [memoryRecord('mem-user', 'Answer in Chinese', { topic: 'Answers' })] });
  await boot(page, memory);
  const settings = await openSettings(page, 'Memory');
  const toggle = settings.getByRole('switch', { name: 'Use memory' });
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: info.outputPath('memory-settings.png') });

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => memory.mode).toBe('off');
  await settings.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(rowsOf(settings)).toHaveText(['Answers']);
  await expect(settings.getByRole('button', { name: 'Add memory' })).toHaveCount(0);
  await settings.locator('.settings-history__back').click();

  await settings.getByRole('switch', { name: 'Use memory' }).click();
  await expect(settings.getByRole('switch', { name: 'Use memory' })).toBeChecked();
  await expect.poll(() => memory.mode).toBe('auto');
  await settings.getByRole('button', { name: 'Manage', exact: true }).click();
  await settings.getByRole('button', { name: 'Add memory' }).click();
  const add = settings.getByRole('group', { name: 'Add memory' });
  await add.getByRole('textbox', { name: 'New memory' }).fill('Lives in Tokyo');
  await add.getByRole('combobox', { name: 'Kind' }).selectOption('fact');
  await add.getByRole('combobox', { name: 'Topic' }).fill('Home');
  await add.getByRole('button', { name: 'Save memory' }).click();
  await expect(rowsOf(settings)).toHaveText(['Home', 'Answers']);
  expect(memory.writes).toEqual(['PUT /memory-settings', 'PUT /memory-settings', 'POST /memories']);
  expect(memory.writeBodies[2]).toEqual({ scope: { kind: 'user' }, kind: 'fact', body: 'Lives in Tokyo', topic: 'Home' });
});

test('Delete all memories asks first, then deletes every memory', async ({ page }) => {
  const memory = createMemoryMock({ records: [memoryRecord('mem-a', 'Answer in Chinese', { createdAt: 2 }), memoryRecord('mem-b', 'Use pnpm', { createdAt: 1 })] });
  await boot(page, memory);
  const settings = await openSettings(page, 'Memory');
  await expect(settings.getByText('2 memories', { exact: true })).toBeVisible();

  await settings.getByRole('button', { name: 'Delete all…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete all memories?' });
  await expect(confirm).toContainText('This can’t be undone.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(memory.writes).toEqual([]);

  await settings.getByRole('button', { name: 'Delete all…' }).click();
  await page.getByRole('dialog', { name: 'Delete all memories?' }).getByRole('button', { name: 'Delete all memories' }).click();
  await expect(settings.getByText('Deleted 2 memories.')).toBeVisible();
  await expect(settings.getByText('Nothing yet. See, add, edit or delete what Michi remembers.')).toBeVisible();
  expect(memory.writes).toEqual(['POST /memories/reset']);
  expect(memory.writeBodies).toEqual([{ confirm: true }]);
});

test('a one-time notice tells someone whose explicit-only memory became on, without taking focus; Review opens Settings', async ({ page }) => {
  const memory = createMemoryMock({ notice: { migratedFromExplicit: true, noticeSeen: false } });
  await boot(page, memory);
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Memory now learns from your conversations' });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Review it or turn it off in Settings › Memory.');
  await expect(page.locator('[data-sonner-toast] :focus')).toHaveCount(0);
  await toast.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(settingsMain(page).getByRole('heading', { level: 1, name: 'Memory' })).toBeVisible();
  expect(memory.writes).toEqual(['PUT /memory-settings']);
  expect(memory.writeBodies).toEqual([{ noticeSeen: true }]);
});

test('a temporary chat starts from Home: the ghost changes Home, the first message asks for one, and the chat says so', async ({ page }, info) => {
  const memory = createMemoryMock();
  await boot(page, memory);
  const home = page.locator('.home-page');
  const ghost = page.getByRole('button', { name: 'Temporary chat', exact: true });
  await expect(ghost).toBeVisible();
  await ghost.click();
  await expect(page.getByRole('button', { name: 'Temporary chat', exact: true, pressed: true })).toBeVisible();
  await expect(home.locator('.michi-home-eyebrow')).toHaveText('Temporary chat');
  await expect(home.getByRole('heading', { level: 1 })).toHaveText('_ Nothing here goes into memory.');
  await expect(home.getByText('Michi won’t use your memories, and other chats can’t read this one. It stays in your history. This can’t be changed after you send.')).toBeVisible();
  const homeComposer = home.locator(CONVERSATION_COMPOSER);
  await expect(homeComposer).toHaveCSS('border-top-style', 'dashed');
  await expect(homeComposer.locator('.mention-editor-placeholder')).toHaveText('Ask in a temporary chat');
  await page.screenshot({ path: info.outputPath('home-temporary-chat.png') });
  // The ghost turns it back off, and on again.
  await page.getByRole('button', { name: 'Temporary chat', exact: true, pressed: true }).click();
  await expect(home.getByText('Nothing here goes into memory.')).toHaveCount(0);
  await expect(homeComposer).toHaveCSS('border-top-style', 'solid');
  await ghost.click();

  await homeComposer.locator('[contenteditable="true"]').fill('Compare two job offers');
  await homeComposer.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
  expect(memory.ensureSessions.map((call) => call.temporary)).toEqual([true]);

  // The chat says so: a note at the top of its pane, a ghost on its sidebar row and its title.
  await expect(page.getByRole('note').filter({ hasText: 'Memory is off here' }))
    .toHaveText('Temporary chat · Memory is off here, and other chats can’t read it.');
  await expect(page.locator('.terminal-sidebar [data-sidebar-row] [data-temporary-chat-mark]')).toHaveCount(1);
  await expect(page.locator('[data-pane-caption-id] [data-temporary-chat-mark], [role="tab"] [data-temporary-chat-mark]')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('chat-temporary.png') });

  // Its next message asks for nothing: it is temporary from its first one on.
  const composer = page.locator(CONVERSATION_COMPOSER).first();
  await composer.locator('[contenteditable="true"]').fill('And over ten years?');
  await composer.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Hello from mock kiro.')).toHaveCount(2);
  expect(memory.ensureSessions.map((call) => call.temporary)).toEqual([true, false]);

  // Home's switch was for that chat only.
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(home).toBeVisible();
  await expect(page.getByRole('button', { name: 'Temporary chat', exact: true, pressed: false })).toBeVisible();
  await expect(home.getByText('Nothing here goes into memory.')).toHaveCount(0);
  await expect(page.locator(CONVERSATION_COMPOSER).first().locator('.mention-editor-placeholder')).toHaveText('What would you like to explore?');

  // Settings › Memory says where one chat is kept out of memory, behind the switch's “?”.
  const settings = await openSettings(page, 'Memory');
  const row = settings.locator('.settings-row').filter({ has: page.getByRole('switch', { name: 'Use memory' }) });
  await row.getByRole('button', { name: 'More about this setting' }).click();
  await expect(row).toContainText('To keep one chat out of memory, start a temporary chat from Home.');
});

test('on a phone, the ghost starts a temporary chat too, and its note wraps inside the screen', async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    const memory = createMemoryMock();
    await boot(page, memory);
    await page.getByRole('button', { name: 'Temporary chat', exact: true }).tap();
    const home = page.locator('.home-page');
    await expect(home.getByRole('heading', { level: 1 })).toHaveText('_ Nothing here goes into memory.');
    await page.screenshot({ path: info.outputPath('phone-home-temporary-chat.png') });
    const homeComposer = home.locator(CONVERSATION_COMPOSER);
    await homeComposer.locator('[contenteditable="true"]').fill('Compare two job offers');
    await homeComposer.getByRole('button', { name: 'Send (Enter)', exact: true }).tap();
    await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
    expect(memory.ensureSessions.map((call) => call.temporary)).toEqual([true]);

    const note = page.getByRole('note').filter({ hasText: 'Memory is off here' });
    await expect(note).toBeVisible();
    const box = (await note.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expect(page.locator('.mobile-pane-title [data-temporary-chat-mark]')).toHaveCount(1);
    // No switch beside a chat.
    await expect(page.getByRole('button', { name: /temporary chat/i })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('phone-chat-temporary.png') });
  } finally {
    await context.close();
  }
});
