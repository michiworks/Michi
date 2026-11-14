import { expect, test, type Page } from '@playwright/test';
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

test('Settings › Memory edits, rescopes and deletes saved memories', async ({ page }) => {
  const memory = createMemoryMock({
    records: [
      memoryRecord('mem-user', 'Answer in Chinese', { createdAt: 3 }),
      memoryRecord('mem-ws', 'Use 2 spaces in this repo', { createdAt: 2, kind: 'convention', scope: { kind: 'workspace', workspaceId: 'a' } }),
    ],
  });
  await boot(page, memory);
  const settings = await openSettings(page, 'Memory');
  await expect(settings.getByRole('switch', { name: 'Use memory' })).toBeChecked();
  const saved = settings.getByRole('list', { name: 'Saved memories' });
  await expect(saved.getByRole('listitem')).toHaveCount(2);

  const user = saved.getByRole('listitem', { name: 'Answer in Chinese' });
  await user.getByRole('button', { name: 'Edit', exact: true }).click();
  await saved.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('memory-saved.png') });
  await user.getByRole('textbox', { name: 'Edit memory' }).fill('Answer in Chinese, code comments in English');
  await user.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(saved.getByText('Answer in Chinese, code comments in English', { exact: true })).toBeVisible();

  const repo = saved.getByRole('listitem', { name: 'Use 2 spaces in this repo' });
  await expect(repo).toContainText('Alpha');
  await repo.getByRole('combobox', { name: 'Scope' }).selectOption({ label: 'Global' });
  await expect(repo.locator('.memory-item__meta')).toContainText('Global');
  await repo.getByRole('button', { name: 'Delete', exact: true }).click();
  await repo.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(saved.getByRole('listitem')).toHaveCount(1);

  expect(memory.writes).toEqual(['PATCH /memories/mem-user', 'PATCH /memories/mem-ws', 'DELETE /memories/mem-ws']);
  expect(memory.records.map((record) => record.body)).toEqual(['Answer in Chinese, code comments in English']);
  // What Settings changed itself shows no "Remembered" notice.
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Remembered' })).toHaveCount(0);
});

test('Settings › Memory is one switch: off keeps saved memories listed and stops adding them', async ({ page }, info) => {
  const memory = createMemoryMock({ records: [memoryRecord('mem-user', 'Answer in Chinese')] });
  await boot(page, memory);
  const settings = await openSettings(page, 'Memory');
  const toggle = settings.getByRole('switch', { name: 'Use memory' });
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: info.outputPath('memory-settings.png') });

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => memory.mode).toBe('off');
  await expect(settings.getByRole('button', { name: 'Add memory', exact: true })).toBeDisabled();
  await expect(settings.getByRole('list', { name: 'Saved memories' }).getByRole('listitem')).toHaveCount(1);

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => memory.mode).toBe('auto');
  expect(memory.writes).toEqual(['PUT /memory-settings', 'PUT /memory-settings']);
});

test('About the user: a line’s memories open under Saved memories, Rebuild asks again, Remove deletes what a line rests on', async ({ page }, info) => {
  const memory = createMemoryMock({
    records: [
      memoryRecord('mem-job', 'I work at Amazon in Tokyo', { origin: 'extracted', kind: 'fact', createdAt: 3 }),
      memoryRecord('mem-food', 'I only have an air fryer', { origin: 'extracted', kind: 'fact', createdAt: 2 }),
      memoryRecord('mem-pnpm', 'Prefers pnpm over npm', { origin: 'extracted', createdAt: 1, importSource: 'claude', importRef: 'michi/feedback.md' }),
    ],
    profile: {
      lines: [
        { topic: 'Work', text: 'Works at Amazon in Tokyo', refs: ['mem-job'] },
        { topic: 'Home', text: 'Cooks with only an air fryer', refs: ['mem-food'] },
      ],
      builtAt: Date.now() - 3 * 3600_000,
      version: 2,
    },
  });
  await boot(page, memory);
  const settings = await openSettings(page, 'Memory');
  const about = settings.getByRole('region', { name: 'About the user' });
  await expect(about.locator('.settings-section__aside')).toHaveText('Built 3h ago · Rebuild');
  await expect(about.getByRole('heading', { level: 3 })).toHaveText(['Work', 'Home']);
  await expect(settings.getByRole('listitem', { name: 'Prefers pnpm over npm' })).toContainText('From Claude Code');

  const work = about.getByRole('listitem').filter({ hasText: 'Works at Amazon in Tokyo' });
  await work.getByRole('button', { name: 'Based on 1 memory' }).click();
  await work.getByRole('button', { name: 'I work at Amazon in Tokyo' }).click();
  await expect(settings.getByRole('listitem', { name: 'I work at Amazon in Tokyo' })).toBeFocused();
  await about.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('memory-about-the-user.png') });

  const rebuild = about.getByRole('button', { name: 'Rebuild' });
  await rebuild.click();
  await expect(about.getByText('Rebuilding. This can take a minute.')).toBeVisible();
  await expect(rebuild).toBeDisabled();

  const home = about.getByRole('listitem').filter({ hasText: 'Cooks with only an air fryer' });
  await home.getByRole('button', { name: 'Remove' }).click();
  await expect(home).toContainText('Deletes the 1 memory it’s based on.');
  await home.getByRole('button', { name: 'Confirm remove' }).click();
  await expect(about.getByText('Cooks with only an air fryer')).toHaveCount(0);
  expect(memory.records.map((record) => record.id)).toEqual(['mem-job', 'mem-pnpm']);
  expect(memory.writes).toEqual(['POST /memory-profile/rebuild', 'POST /memory-profile/remove-line']);
  expect(memory.writeBodies).toEqual([{}, { index: 1, version: 2 }]);
});

test('Delete all memories asks first, then deletes every memory', async ({ page }) => {
  const memory = createMemoryMock({ records: [memoryRecord('mem-a', 'Answer in Chinese', { createdAt: 2 }), memoryRecord('mem-b', 'Use pnpm', { createdAt: 1 })] });
  await boot(page, memory);
  const settings = await openSettings(page, 'Memory');
  await expect(settings.getByRole('list', { name: 'Saved memories' }).getByRole('listitem')).toHaveCount(2);

  await settings.getByRole('button', { name: 'Delete all…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete all memories?' });
  await expect(confirm).toContainText('This can’t be undone.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(memory.writes).toEqual([]);

  await settings.getByRole('button', { name: 'Delete all…' }).click();
  await page.getByRole('dialog', { name: 'Delete all memories?' }).getByRole('button', { name: 'Delete all memories' }).click();
  await expect(settings.getByText('Deleted 2 memories.')).toBeVisible();
  await expect(settings.getByText('No memories yet.')).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Turn off temporary chat', exact: true })).toBeVisible();
  await expect(home.locator('.michi-home-eyebrow')).toHaveText('Temporary chat');
  await expect(home.getByRole('heading', { level: 1 })).toHaveText('_ Nothing here goes into memory.');
  await expect(home.getByText('Michi won’t use your memories, and other chats can’t read this one. It stays in your history. This can’t be changed after you send.')).toBeVisible();
  const homeComposer = home.locator(CONVERSATION_COMPOSER);
  await expect(homeComposer).toHaveCSS('border-top-style', 'dashed');
  await expect(homeComposer.locator('.mention-editor-placeholder')).toHaveText('Ask in a temporary chat');
  await page.screenshot({ path: info.outputPath('home-temporary-chat.png') });
  // The ghost turns it back off, and on again.
  await page.getByRole('button', { name: 'Turn off temporary chat', exact: true }).click();
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
  await expect(page.getByRole('button', { name: 'Temporary chat', exact: true })).toBeVisible();
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
