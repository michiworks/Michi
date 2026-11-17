import { expect, test, type Locator, type Page } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { openSettings } from '../fixtures/shell';

async function boot(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await installMockApi(page, { custom: async (route) => {
    if (new URL(route.request().url()).pathname === '/api/prefs' && route.request().method() === 'GET') {
      await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, reduceMotion: true } } });
      return true;
    }
    return false;
  } });
  await bootWithWorkspace(page, 'Settings aside');
  return page.getByRole('dialog', { name: 'Settings', exact: true });
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found!;
}

test('a wide screen puts On this page and the Appearance preview beside the Settings window', async ({ page }) => {
  // Short enough that the Michi page runs past two screens of the window.
  const dialog = await boot(page, 1600, 700);
  await openSettings(page, 'Michi');
  const windowBox = await box(dialog);
  expect(windowBox.width).toBe(880);
  const toc = dialog.getByRole('navigation', { name: 'On this page' });
  await expect(toc).toBeVisible();
  expect((await box(toc)).x).toBeGreaterThanOrEqual(windowBox.x + windowBox.width + 16);

  await openSettings(page, 'Appearance');
  const preview = dialog.getByRole('complementary', { name: 'Preview' });
  await expect(preview).toBeVisible();
  const previewBox = await box(preview);
  expect(previewBox.x).toBeGreaterThanOrEqual(windowBox.x + windowBox.width + 16);
  expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(1600 - 16);
});

test('without room beside the window, the preview stays under the settings and the list is left out', async ({ page }) => {
  const dialog = await boot(page, 1280, 700);
  await openSettings(page, 'Michi');
  await expect(dialog.getByRole('navigation', { name: 'On this page' })).toHaveCount(0);

  await openSettings(page, 'Appearance');
  const windowBox = await box(dialog);
  const preview = dialog.getByRole('complementary', { name: 'Preview' });
  await preview.scrollIntoViewIfNeeded();
  const previewBox = await box(preview);
  expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(windowBox.x + windowBox.width);
});

test('a row with a switch flips it wherever it is clicked, and lights under the pointer', async ({ page }) => {
  const dialog = await boot(page, 1440, 1000);
  await openSettings(page, 'Appearance');
  const row = dialog.locator('.settings-row').filter({ has: page.getByRole('switch', { name: 'Dim unfocused panes' }) });
  const toggle = row.getByRole('switch', { name: 'Dim unfocused panes' });
  const before = await toggle.getAttribute('aria-checked');
  // Clicks land where the name and the description are drawn: the switch's hit area covers them.
  const clickOn = async (target: Locator) => {
    const at = await box(target);
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  };
  await clickOn(row.getByText('Dim unfocused panes', { exact: true }));
  await expect(toggle).not.toHaveAttribute('aria-checked', before!);
  await clickOn(row.locator('.settings-row__desc'));
  await expect(toggle).toHaveAttribute('aria-checked', before!);

  await row.hover();
  await expect.poll(() => row.evaluate((el) => getComputedStyle(el, '::before').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});
