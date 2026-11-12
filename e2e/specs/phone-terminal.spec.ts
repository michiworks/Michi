import { expect, test, type Page } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';
import { installTerminalFixture, terminalInputs } from '../fixtures/terminalFixtures';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function openChooser(page: Page) {
  await installMockApi(page);
  await bootWithWorkspace(page);
  await page.locator(COMPOSER_EDITOR).first().fill('phone terminal');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  // A phone keeps New pane in the topbar's overflow menu.
  await page.getByRole('button', { name: 'Workspace views', exact: true }).click();
  await page.getByRole('button', { name: 'New pane', exact: true }).click();
  return page.locator('[data-pane-kind="launcher"]');
}

test('with Terminal off for phones, the chooser says why instead of opening a dead pane', async ({ page }) => {
  await installTerminalFixture(page, { allowed: false });
  const launcher = await openChooser(page);
  const terminal = launcher.getByRole('button', { name: 'Terminal' });
  await expect(terminal).toContainText('Off on this phone');
  await terminal.click();
  await expect(launcher.getByRole('note')).toContainText('Settings › Phone access › Terminal');
  await expect(page.locator('[data-pane-kind="terminal"]')).toHaveCount(0);
});

test('a phone types into the shell, with the keys its keyboard lacks above it', async ({ page }, testInfo) => {
  await installTerminalFixture(page, { allowed: true });
  const launcher = await openChooser(page);
  await launcher.getByRole('button', { name: 'Terminal' }).click();
  const pane = page.locator('[data-pane-kind="terminal"][data-terminal-status="ready"]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('.xterm-rows')).toContainText('~/Michi $');
  await expect(pane.getByText('Also on desktop')).toBeVisible();

  // Focus the shell as a tap would; the key row must not take the focus (the keyboard would close).
  await pane.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('ls');
  const keys = pane.getByRole('toolbar', { name: 'Terminal keys' });
  await keys.getByRole('button', { name: 'Up' }).tap();
  await keys.getByRole('button', { name: 'ctrl' }).tap();
  await expect(keys.getByRole('button', { name: 'ctrl' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.type('c');
  await expect.poll(() => terminalInputs(page).then((inputs) => inputs.join(''))).toBe('ls\x1b[A\x03');
  expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
  await expect(keys.getByRole('button', { name: 'ctrl' })).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({ path: testInfo.outputPath('phone-terminal.png') });
});
