import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

// The @ menu holds both edges while one query filters it (MentionEditor's
// held list height), and a picked chip grows out of the typed query
// (mentionEnter.ts) before settling as a plain chip.

async function boot(page: Page) {
  await installMockApi(page, { custom: async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (path === '/prefs' && route.request().method() === 'GET') {
      await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: 'bone' } } });
      return true;
    }
    return false;
  } });
  await page.addInitScript(() => {
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({
      version: 6, activeProjectId: 'ws',
      nodes: { root: { nodeId: 'root', kind: 'chat', chatId: null, projectId: 'ws', title: 'Sign the CI build', status: 'idle', followUps: [],
        messages: [{ id: 'm1', role: 'user', text: 'Why does notarization still fail?', toolCalls: [], createdAt: 1 }] } },
      projects: [{ id: 'ws', name: 'michi', chatIds: ['root'], edges: [],
        trees: [{ id: 'tree', rootNodeId: 'root', name: 'Sign the CI build', createdAt: 1, lastActiveAt: 1 }],
        activeTreeId: 'tree', createdAt: 1,
        artifacts: ['Notarize the DMG', 'Michi 0.9 release', 'entitlements.mac.plist', 'Release notes', 'scripts/notarize.sh', 'Design notes', 'Build matrix']
          .map((name, i) => ({ id: `a${i}`, name, filePath: `${i}.md`, type: 'doc', source: 'user', createdAt: 1, updatedAt: 1 })),
      }],
    }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ terminalPalette: 'bone', sidebarView: 'structure', sidebarCollapsed: false,
      onboardingCompletedAt: 1, sidebarExpanded: { workspaces: { ws: true }, threads: { tree: true }, branches: {} } }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'ws::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'ws::tree': 'root' }));
  });
  await page.goto('/');
  await expect(page.locator(COMPOSER_EDITOR).first()).toBeVisible();
}

test('the mention menu keeps its edges while filtering; the picked chip grows in, then settles', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await boot(page);
  const editor = page.locator(COMPOSER_EDITOR).first();
  await editor.click();
  await page.keyboard.type('Compare this with @');
  const menu = page.getByRole('listbox', { name: 'Mentions', exact: true });
  await expect(menu).toBeVisible();
  const options = menu.getByRole('option');
  const edges = async () => {
    const box = (await menu.boundingBox())!;
    return [Math.round(box.y), Math.round(box.y + box.height)];
  };
  const opened = await edges();
  const counts = [await options.count()];
  for (const key of 'not') {
    await page.keyboard.type(key);
    await expect.poll(() => options.count()).toBeLessThanOrEqual(counts[counts.length - 1]);
    counts.push(await options.count());
    expect(await edges()).toEqual(opened);
  }
  // The query really narrowed the list while the box held still.
  expect(counts[counts.length - 1]).toBeLessThan(counts[0]);

  await page.keyboard.press('Enter');
  const chip = editor.locator('.mention-chip');
  await expect(chip).toHaveText('@Notarize the DMG');
  await expect(menu).toHaveCount(0);
  await expect(chip).not.toHaveClass(/mention-chip--enter/);
  await expect(chip).not.toHaveAttribute('data-from');
});
