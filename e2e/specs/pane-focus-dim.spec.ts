import { expect, test, type Locator, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

// An unfocused pane's SURFACE sinks toward the palette's deep surface
// (.terminal-pane__recede, the pane's last child, on a negative rung) instead
// of a black veil over its content or filter: brightness() on its subtree.
// The text it holds keeps its own colour, and the layer must never take a
// click, a text selection or a drag from the pane under it.

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

function recede(target: Locator) {
  return target.evaluate((el) => {
    const layer = el.lastElementChild;
    const recede = layer?.matches('.terminal-pane__recede') ? getComputedStyle(layer) : null;
    const own = getComputedStyle(el);
    const probe = (value: string) => {
      const span = document.createElement('span');
      span.style.color = value;
      el.appendChild(span);
      const color = getComputedStyle(span).color;
      span.remove();
      return color;
    };
    const band = el.querySelector<HTMLElement>('[data-pane-band="top"]');
    return {
      opacity: recede ? Number(recede.opacity) : null,
      background: recede?.backgroundColor,
      zIndex: recede ? Number(recede.zIndex) : null,
      pointerEvents: recede?.pointerEvents,
      position: recede?.position,
      filter: own.filter,
      isolation: own.isolation,
      fill: probe('var(--term-recede-fill)'),
      paneBg: probe('var(--term-pane-bg, var(--term-surface))'),
      band: band ? getComputedStyle(band).backgroundColor : null,
    };
  });
}

/** The colour the pane's answer text is painted in. */
const inkOf = (page: Page, id: string) => answer(page, id).evaluate((el) => getComputedStyle(el).color);

/** A computed colour as 0–255 channels, from either `rgb()` or the `color(srgb …)` a color-mix resolves to. */
function rgb(value: string): number[] {
  const parts = (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  return value.includes('color(') ? parts.map((channel) => channel * 255) : parts;
}

/** `fill` at `amount` over `base`, the colour a receded surface composites to. */
function composite(fill: string, base: string, amount: number): number[] {
  const [f, b] = [rgb(fill), rgb(base)];
  return f.map((channel, i) => channel * amount + b[i] * (1 - amount));
}

/** What a pointer at the middle of `target` lands on, inside its pane. */
function hit(target: Locator) {
  return target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const under = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { reachesTarget: !!under && (under === el || el.contains(under)), isPaneRoot: !!under?.matches('.terminal-pane') };
  });
}

// The pane's caption cell in the top bar sinks with it (its ::after), at the
// pane's own amount, never under a filter and never over its title.
const caption = (page: Page, id: string) => page.locator(`[data-pane-caption-id="${id}"]`);

function captionRecede(page: Page, id: string) {
  return caption(page, id).evaluate((el) => {
    const after = getComputedStyle(el, '::after');
    return {
      opacity: Number(after.opacity),
      background: after.backgroundColor,
      zIndex: Number(after.zIndex),
      pointerEvents: after.pointerEvents,
      position: after.position,
      filter: getComputedStyle(el).filter,
    };
  });
}

test.describe('pane focus recede', () => {
  test.use({ viewport: { width: 1480, height: 900 } });

  test('sinks only the unfocused pane\'s surface, leaving its text and letting clicks, selection and focus through', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await seedTwoPanes(page);

    // 40% strength, doubled: the surface sits 80% of the way to the fill.
    await expect.poll(async () => (await recede(pane(page, 'second'))).opacity).toBeCloseTo(0.8, 2);
    const unfocused = await recede(pane(page, 'second'));
    expect(unfocused).toMatchObject({ pointerEvents: 'none', position: 'absolute', filter: 'none', isolation: 'isolate' });
    // The palette's deep surface, under the pane's content, not black over it.
    expect(unfocused.background).toBe(unfocused.fill);
    expect(unfocused.background).not.toBe('rgb(0, 0, 0)');
    expect(unfocused.zIndex).toBeLessThan(0);
    expect((await recede(pane(page, 'root'))).opacity).toBe(0);

    // The band that hides scrolled content behind the pane's surface sinks
    // with it, instead of standing out as an unreceded strip.
    const sunk = composite(unfocused.fill, unfocused.paneBg, 0.8);
    rgb(unfocused.band!).forEach((channel, i) => expect(Math.abs(channel - sunk[i])).toBeLessThan(2));
    rgb((await recede(pane(page, 'root'))).band!).forEach((channel, i) => expect(Math.abs(channel - rgb(unfocused.paneBg)[i])).toBeLessThan(2));

    // The text of a sunk pane keeps the colour of the focused one's.
    expect(await inkOf(page, 'second')).toBe(await inkOf(page, 'root'));

    // The pointer reaches the text over the recede, not the recede's pane.
    expect(await hit(answer(page, 'second'))).toEqual({ reachesTarget: true, isPaneRoot: false });

    // A click focuses that pane; the recede moves to the other.
    await answer(page, 'second').click();
    await expect.poll(async () => (await recede(pane(page, 'second'))).opacity).toBe(0);
    await expect.poll(async () => (await recede(pane(page, 'root'))).opacity).toBeCloseTo(0.8, 2);

    // The pointer reaches the text of the pane sunk now too, and a drag
    // selects in it. (A drag that starts in an unfocused pane focuses it
    // first and selects nothing, recede or not.)
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

  test('sinks the unfocused pane\'s caption cell under its title, which a click passes through', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await seedTwoPanes(page);

    await expect.poll(async () => (await captionRecede(page, 'second')).opacity).toBeCloseTo(0.8, 2);
    const unfocused = await captionRecede(page, 'second');
    expect(unfocused).toMatchObject({ pointerEvents: 'none', position: 'absolute', filter: 'none' });
    expect(unfocused.background).not.toBe('rgb(0, 0, 0)');
    expect(unfocused.zIndex).toBeLessThan(0);
    expect((await captionRecede(page, 'root')).opacity).toBe(0);

    // A click on the sunk caption reaches it and focuses its pane; the recede moves.
    await caption(page, 'second').click();
    await expect.poll(async () => (await captionRecede(page, 'second')).opacity).toBe(0);
    await expect.poll(async () => (await captionRecede(page, 'root')).opacity).toBeCloseTo(0.8, 2);
    expect((await captionRecede(page, 'root')).filter).toBe('none');
    expect(errors).toEqual([]);
  });
});
