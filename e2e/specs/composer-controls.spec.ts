import { expect, test, type Locator, type Page } from '@playwright/test';
import { installComposerModels } from '../fixtures/composerModels';
import { bootWithWorkspace } from '../fixtures/mockApi';
import { CONVERSATION_COMPOSER } from '../fixtures/shell';

async function bootComposer(page: Page, palette: 'bone' | 'monokai' = 'bone') {
  const { status } = await installComposerModels(page);
  status.capabilities = { ...status.capabilities, modes: true };
  await page.route(/\/api\/prefs$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: palette } } });
  });
  await bootWithWorkspace(page, 'Composer controls');
  await expect(page.locator('html')).toHaveAttribute('data-terminal-palette', palette);
}

async function finishHover(control: Locator) {
  await control.hover();
  await expect.poll(() => control.evaluate((element) => element.getAnimations()
    .filter((animation) => animation.playState === 'running').length)).toBe(0);
}

test('compact controls keep their geometry and respect reduced motion', async ({ page }, info) => {
  await bootComposer(page);
  const composer = page.locator(CONVERSATION_COMPOSER).first();
  const editor = composer.locator('[contenteditable="true"]');
  await editor.fill('Start a narrow pane');
  await composer.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await editor.fill('Check compact controls');
  const frame = (await composer.boundingBox())!;
  for (const control of await composer.locator('.t-toolbar-chip, .t-action-btn.is-outline').all()) {
    // A phone has no @ chip; typing @ still mentions.
    if (!await control.isVisible()) continue;
    await finishHover(control);
    await expect(control).toHaveCSS('transition-duration', '0s');
    const bounds = (await control.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(frame.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(frame.x + frame.width);
  }
  await page.screenshot({ path: info.outputPath('composer-hover-mobile.png'), fullPage: true });
});

// iOS keeps :hover on the last-tapped element until the next tap elsewhere,
// so a chip that paints on :hover looks pressed after its menu closes.
// Chromium's touch emulation never leaves :hover behind, so force it.
test('a touch screen does not paint the agent chip for a sticky :hover', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await bootComposer(page);
    const composer = page.locator(CONVERSATION_COMPOSER).first();
    const editor = composer.locator('[contenteditable="true"]');
    await editor.fill('Start a phone pane');
    await composer.getByRole('button', { name: 'Send (Enter)', exact: true }).tap();
    await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
    await editor.tap();
    const agent = composer.getByTitle(/^Switch agent/);
    await agent.tap();
    await expect(agent).toHaveAttribute('aria-expanded', 'true');
    await expect(agent).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await agent.tap();
    await expect(agent).toHaveAttribute('aria-expanded', 'false');

    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `${CONVERSATION_COMPOSER} [title^="Switch agent"]` });
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    await expect.poll(() => agent.evaluate((element) => element.matches(':hover'))).toBe(true);
    await expect(agent).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  } finally {
    await context.close();
  }
});
