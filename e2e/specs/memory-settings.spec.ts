import { expect, test, type Page } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { CONVERSATION_COMPOSER, openSettings, settingsMain } from '../fixtures/shell';
import { createMemoryMock, memoryChange, memoryRecord, type MemoryMockController } from '../fixtures/memoryFixtures';

// Settings › Memory, its notices and a chat's memory setting against the mock
// API: no backend, SQLite or agent runtime. The change feed answers with
// queued changes, the way the backend forwards an agent's or automatic
// memory's writes.

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
  await expect(about.getByText('Built 3h ago')).toBeVisible();
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
  await expect(about.getByText('Rebuilding with automatic memory. This can take a minute.')).toBeVisible();
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
  await expect(settings.getByText('Deleting a conversation doesn’t delete what Michi learned from it. Delete those memories here.')).toBeVisible();

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

test('a chat’s memory setting opens from the keyboard, and a chat that stops learning says so', async ({ page }, info) => {
  const memory = createMemoryMock({ conversations: true });
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, reduceMotion: true }));
  });
  await installMockApi(page, { custom: memory.handle });
  await bootWithWorkspace(page, 'Memory chat');
  const composer = page.locator(CONVERSATION_COMPOSER).first();
  await composer.locator('[contenteditable="true"]').fill('Plan the trip');
  await composer.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();

  const learn = page.getByRole('button', { name: 'Memory: Learn' });
  await learn.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Memory for this chat' });
  await expect(menu.getByRole('menuitemradio', { name: /^Learn/ })).toBeFocused();
  await expect(menu.getByRole('menuitemradio', { name: /^Learn/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: /^Use only/ })).toBeFocused();
  await page.screenshot({ path: info.outputPath('chat-memory-menu.png') });
  await page.keyboard.press('Enter');

  const useOnly = page.getByRole('button', { name: 'Memory: Use only' });
  await expect(useOnly).toBeFocused();
  await expect(useOnly).toHaveText('Use only');
  await composer.screenshot({ path: info.outputPath('chat-memory-use-only.png') });
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Forgot 1 memory Michi had learned from this chat' })).toBeVisible();
  expect(Object.values(memory.conversationModes)).toEqual(['use_only']);

  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: /^Use only/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(useOnly).toBeFocused();
  expect(memory.writes.filter((write) => write.startsWith('PUT /nodes/'))).toHaveLength(1);
});
