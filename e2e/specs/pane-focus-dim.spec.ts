import { expect, test, type Locator, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

// An unfocused pane dims under a black veil (.terminal-pane::after) instead
// of filter: brightness() on its subtree. The veil must never take a click,
// a text selection or a drag from the pane under it.

const pane = (page: Page, id: string) => page.locator(`.terminal-pane[data-node-id="${id}"]`);
const answer = (page: Page, id: string) => pane(page, id).getByText(`The ${id} layout is ready for review.`);

async function seedTwoPanes(page: Page) {
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
    if (sessionStorage.getItem('dim-seeded')) return;
    sessionStorage.setItem('dim-seeded', '1');
    localStorage.clear();
    const ids = ['root', 'second'];
    const nodes = Object.fromEntries(ids.map(id => [id, {
      nodeId: id, kind: 'chat', chatId: null, projectId: 'dim-ws',
      title: `${id} conversation`, status: 'idle', followUps: [],
      messages: [
        { id: `${id}-question`, role: 'user', text: `Review the ${id} part.`, toolCalls: [], createdAt: 1 },
        { id: `${id}-answer`, role: 'assistant', text: '', toolCalls: [], createdAt: 2,
          blocks: [{ id: `${id}-block`, kind: 'answer', rawText: `The ${id} layout is ready for review.` }] },
      ],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({
      version: 6, activeProjectId: 'dim-ws', nodes,
      projects: [{ id: 'dim-ws', name: 'Pane dim', chatIds: ids,
        edges: [{ source: 'root', target: 'second', kind: 'branch' }],
        trees: [{ id: 'tree', rootNodeId: 'root', name: 'root conversation', createdAt: 1, lastActiveAt: 1 }],
        activeTreeId: 'tree', contexts: [], createdAt: 1,
      }],
    }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ paneWidthMode: 'half', focusDim: 40 }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'dim-ws::tree': ids }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'dim-ws::tree': 'root' }));
  });
  await page.goto('/');
  await page.getByText('root conversation', { exact: true }).first().click();
  await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(2);
}

function veil(target: Locator) {
  return target.evaluate((el) => {
    const after = getComputedStyle(el, '::after');
    const own = getComputedStyle(el);
    return {
      opacity: Number(after.opacity),
      background: after.backgroundColor,
      pointerEvents: after.pointerEvents,
      position: after.position,
      filter: own.filter,
      isolation: own.isolation,
    };
  });
}

/** What a pointer at the middle of `target` lands on, inside its pane. */
function hit(target: Locator) {
  return target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const under = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { reachesTarget: !!under && (under === el || el.contains(under)), isPaneRoot: !!under?.matches('.terminal-pane') };
  });
}

test.describe('pane focus dim', () => {
  test.use({ viewport: { width: 1480, height: 900 } });

  test('dims only the unfocused pane, with a veil that lets clicks, selection and focus through', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await seedTwoPanes(page);

    // 40% focus dim at the old brightness factor: brightness(0.76), a 0.24 veil.
    await expect.poll(async () => (await veil(pane(page, 'second'))).opacity).toBeCloseTo(0.24, 2);
    const unfocused = await veil(pane(page, 'second'));
    expect(unfocused).toMatchObject({ background: 'rgb(0, 0, 0)', pointerEvents: 'none', position: 'absolute', filter: 'none', isolation: 'isolate' });
    expect((await veil(pane(page, 'root'))).opacity).toBe(0);

    // The pointer reaches the text under the veil, not the veil's pane.
    expect(await hit(answer(page, 'second'))).toEqual({ reachesTarget: true, isPaneRoot: false });

    // A click through the veil focuses that pane; the dim moves to the other.
    await answer(page, 'second').click();
    await expect.poll(async () => (await veil(pane(page, 'second'))).opacity).toBe(0);
    await expect.poll(async () => (await veil(pane(page, 'root'))).opacity).toBeCloseTo(0.24, 2);

    // The pointer reaches the text of the pane dimmed now too, and a drag
    // selects in a pane under the veil's layer. (A drag that starts in an
    // unfocused pane focuses it first and selects nothing, veil or not.)
    expect(await hit(answer(page, 'root'))).toEqual({ reachesTarget: true, isPaneRoot: false });
    const drag = async (id: string) => {
      const box = await answer(page, id).evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const r = range.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      });
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      return page.evaluate(() => window.getSelection()?.toString() ?? '');
    };
    expect(await drag('second')).toBe('The second layout is ready for review');
    expect(errors).toEqual([]);
  });
});
