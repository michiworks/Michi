import { expect, test, type Locator, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

// What the stylesheet decides about the answer meta line and the ⌘K palette,
// in a real browser: Vitest loads no CSS.

async function seed(page: Page) {
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
    if (sessionStorage.getItem('meta-seeded')) return;
    sessionStorage.setItem('meta-seeded', '1');
    localStorage.clear();
    const answer = (id: string, text: string, tokens: number) => ({
      id, role: 'assistant', text: '', toolCalls: [], createdAt: 2,
      usageSummary: { source: 'native', totalTokens: tokens, inputTokens: tokens, outputTokens: 0, turnDurationMs: 1_600 },
      blocks: [{ id: `${id}-block`, kind: 'answer', rawText: text }],
    });
    const nodes = {
      root: {
        nodeId: 'root', kind: 'chat', chatId: null, projectId: 'meta-ws', title: 'Fireworks', status: 'idle', followUps: [],
        messages: [
          { id: 'u1', role: 'user', text: 'Which festival is biggest?', toolCalls: [], createdAt: 1 },
          answer('a1', 'Omagari is the biggest competition.', 12_000),
          { id: 'u2', role: 'user', text: 'And the best seats?', toolCalls: [], createdAt: 1 },
          answer('a2', 'The paid seats on the riverbank sell out in June, so book them early.', 46_000),
        ],
      },
      other: {
        nodeId: 'other', kind: 'chat', chatId: null, projectId: 'meta-ws', title: 'Train tickets', status: 'idle', followUps: [],
        messages: [],
      },
    };
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({
      version: 6, activeProjectId: 'meta-ws', nodes,
      projects: [{ id: 'meta-ws', name: 'Tokyo trip', chatIds: ['root', 'other'], edges: [],
        trees: [
          { id: 'tree', rootNodeId: 'root', name: 'Fireworks', createdAt: 1, lastActiveAt: 1 },
          { id: 'tree-2', rootNodeId: 'other', name: 'Train tickets', createdAt: 1, lastActiveAt: 2 },
        ],
        activeTreeId: 'tree', contexts: [], createdAt: 1,
      }],
    }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'meta-ws::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'meta-ws::tree': 'root' }));
  });
  await page.goto('/');
  await page.getByText('Fireworks', { exact: true }).first().click();
  await expect(page.locator('[data-msg-id="a2"]')).toBeVisible();
}

const actionsOf = (page: Page, id: string) => page.locator(`[data-msg-id="${id}"] .t-answer-meta .t-msg-actions`);
const opacity = (target: Locator) => target.evaluate((el) => Number(getComputedStyle(el).opacity));

test.describe('answer meta line', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('shows the latest answer\'s line, reveals earlier ones on hover or focus, at 12px', async ({ page }) => {
    await seed(page);
    await expect(page.locator('[data-msg-id="a2"]')).not.toContainText('> michi');
    const latest = actionsOf(page, 'a2');
    await expect.poll(() => opacity(latest)).toBe(1);
    const text = page.locator('[data-msg-id="a2"] .t-answer-meta__text');
    await expect(text).toContainText('46k tokens');
    expect(await text.evaluate((el) => getComputedStyle(el).fontSize)).toBe('12px');
    // The parts are joined by a CSS dot.
    expect(await page.locator('[data-msg-id="a2"] .t-answer-meta__part').nth(1)
      .evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"·"');

    const earlier = actionsOf(page, 'a1');
    expect(await opacity(earlier)).toBe(0);
    await page.getByText('Omagari is the biggest competition.').hover();
    await expect.poll(() => opacity(earlier)).toBe(1);
    await page.mouse.move(5, 890);
    await expect.poll(() => opacity(earlier)).toBe(0);
    // A keyboard landing on its buttons shows them (keyboard focus only: a tap must not, see memory-sources).
    const copy = page.locator('[data-msg-id="a1"] button[aria-label="copy message"]');
    await copy.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(copy).toBeFocused();
    await expect.poll(() => opacity(earlier)).toBe(1);
  });

  test('a user message\'s hover row stays clear of its answer\'s first line', async ({ page }) => {
    await seed(page);
    await page.getByText('And the best seats?').hover();
    const row = page.locator('[data-msg-id="u2"] .t-msg-actions');
    await expect.poll(() => opacity(row)).toBe(1);
    const rowBox = (await page.locator('[data-msg-id="u2"] button[aria-label="copy message"]').boundingBox())!;
    const firstLine = await page.getByText('The paid seats on the riverbank').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects()[0].top;
    });
    // The icon sits mid-button; the button may reach into the line's leading, not its glyphs.
    expect(rowBox.y + rowBox.height / 2 + 7).toBeLessThanOrEqual(firstLine + 4);
  });
});

test.describe('command palette', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('opens without a title bar, with Recent first and the key hints under the list', async ({ page }) => {
    await seed(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.ui-overlay-header')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
    const groups = await dialog.locator('[data-menu="palette"] > ul').evaluateAll((lists) => lists.map((ul) => ul.getAttribute('aria-label')));
    expect(groups.slice(0, 3)).toEqual(['Recent', 'Navigate', 'Actions']);
    const recent = dialog.getByRole('list', { name: 'Recent' }).locator('.ui-menu-item');
    await expect(recent).toHaveCount(1);
    await expect(recent.first()).toContainText('Train tickets');
    await expect(recent.first().locator('.michi-menu-where')).toHaveText('Tokyo trip');
    await expect(dialog.locator('.palette-hints')).toHaveText('↑↓move↵openescclose');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('opens the highlighted recent thread on Enter', async ({ page }) => {
    await seed(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    await expect(page.locator('.terminal-pane[data-node-id="other"]')).toBeVisible();
  });
});
