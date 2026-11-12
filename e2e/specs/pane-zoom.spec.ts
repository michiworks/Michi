import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

const strip = (page: Page) => page.locator('.terminal-dashboard');
const caption = (page: Page, id: string) => page.locator(`[data-pane-caption-id="${id}"]`);

async function seedThreePanes(page: Page) {
  await installMockApi(page, {
    custom: async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (route.request().method() === 'GET' && pathname === '/api/agent-runs') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ runs: [] }) });
        return true;
      }
      if (pathname === '/api/agent-runs/subscribe') {
        await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' });
        return true;
      }
      return false;
    },
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('zoom-seeded')) return;
    sessionStorage.setItem('zoom-seeded', '1');
    localStorage.clear();
    const ids = ['root', 'second', 'third'];
    const nodes = Object.fromEntries(ids.map(id => [id, {
      nodeId: id, kind: 'chat', chatId: null, projectId: 'zoom-ws',
      title: `${id} conversation`, status: 'idle', followUps: [],
      messages: [
        { id: `${id}-question`, role: 'user', text: `Review the ${id} part.`, toolCalls: [], createdAt: 1 },
        { id: `${id}-answer`, role: 'assistant', text: '', toolCalls: [], createdAt: 2,
          blocks: [{ id: `${id}-block`, kind: 'answer', rawText: `### ${id} review\n\nThe layout is ready for review.` }] },
      ],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({
      version: 6, activeProjectId: 'zoom-ws', nodes,
      projects: [{ id: 'zoom-ws', name: 'Pane zoom', chatIds: ids,
        edges: ids.slice(1).map(target => ({ source: 'root', target, kind: 'branch' })),
        trees: [{ id: 'tree', rootNodeId: 'root', name: 'root conversation', createdAt: 1, lastActiveAt: 1 }],
        activeTreeId: 'tree', contexts: [], createdAt: 1,
      }],
    }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ paneWidthMode: 'half' }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'zoom-ws::tree': ids }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'zoom-ws::tree': 'root' }));
  });
  await page.goto('/');
  await page.getByText('root conversation', { exact: true }).first().click();
  await expect(strip(page).locator(':scope > [data-node-id]')).toHaveCount(3);
}

/** Pane ids the strip shows, with their on-screen widths. */
async function shown(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.terminal-dashboard')!;
    return {
      available: el.clientWidth,
      panes: [...el.querySelectorAll<HTMLElement>(':scope > [data-node-id]')]
        .filter(pane => pane.style.visibility !== 'hidden' && pane.getAttribute('aria-hidden') !== 'true')
        .map(pane => ({ id: pane.dataset.nodeId!, width: Math.round(pane.getBoundingClientRect().width) })),
    };
  });
}

async function press(page: Page, key: string, init: KeyboardEventInit = {}) {
  await page.evaluate(({ key, init }) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...init }));
  }, { key, init });
}

test.describe('pane zoom', () => {
  test.use({ viewport: { width: 1480, height: 900 } });

  test('a double-clicked caption fills the strip, follows focus and gives the layout back', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await seedThreePanes(page);
    const before = await shown(page);
    expect(before.panes.length).toBeGreaterThanOrEqual(2);

    await caption(page, 'second').getByText('second conversation').dblclick();
    await expect(strip(page)).toHaveAttribute('data-pane-zoomed', 'second');
    await expect.poll(async () => (await shown(page)).panes).toEqual([{ id: 'second', width: before.available }]);
    // The hidden panes stay mounted with their content.
    await expect(strip(page).locator('[data-node-id="root"] .pane-entry-surface')).toHaveCount(1);
    const exit = page.getByTestId('pane-zoom-exit');
    await expect(exit).toHaveAccessibleName('Exit zoom, 2 more panes');
    await expect(page.locator('[data-pane-caption-id]:not([aria-hidden="true"])')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('zoomed.png') });

    // Ctrl+Tab moves focus, and the zoom goes with it.
    await press(page, 'Tab', { ctrlKey: true, metaKey: false });
    await expect(strip(page)).toHaveAttribute('data-pane-zoomed', 'third');

    await exit.click();
    await expect(strip(page)).not.toHaveAttribute('data-pane-zoomed');
    await expect.poll(async () => (await shown(page)).panes.map(pane => pane.width)
      .every(width => Math.abs(width - before.panes[0].width) <= 1)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('the shortcut works from the composer without typing into it, and closing the zoomed pane ends the zoom', async ({ page }, info) => {
    await seedThreePanes(page);
    const editor = page.locator(`[data-node-id="root"] ${COMPOSER_EDITOR}`).first();
    await editor.click();
    await page.keyboard.type('draft');
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await expect(strip(page)).toHaveAttribute('data-pane-zoomed', 'root');
    await expect(editor).toHaveText('draft');
    await page.screenshot({ path: info.outputPath('zoomed-from-composer.png') });
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await expect(strip(page)).not.toHaveAttribute('data-pane-zoomed');

    // The context menu offers it too; closing the zoomed pane leaves no zoom behind.
    await caption(page, 'second').getByText('second conversation').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Zoom Pane/ }).click();
    await expect(strip(page)).toHaveAttribute('data-pane-zoomed', 'second');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await press(page, 'w');
    await expect(strip(page).locator(':scope > [data-node-id]')).toHaveCount(2);
    await expect(strip(page)).not.toHaveAttribute('data-pane-zoomed');
    await expect.poll(async () => (await shown(page)).panes.length).toBe(2);
  });
});
