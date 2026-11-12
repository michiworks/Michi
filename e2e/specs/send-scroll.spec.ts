import { expect, test, type Page } from '@playwright/test';
import { bootWithWorkspace, installMockApi, sseBody, type SseEvent } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

// A send keeps the thread pinned to its bottom, the way a messaging app does:
// the transcript glides up by what the send added (the user's message and the
// reply's placeholder) on one decelerating curve, the bubble only fades in,
// and the reply then grows from just above the composer.

declare global {
  interface Window {
    sendScrollStream?: ReadableStreamDefaultController<Uint8Array>;
    sendScrollSamples?: number[];
  }
}

async function setUp(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await installMockApi(page);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method === 'POST' && /^\/api\/chats\/[^/]+\/message$/.test(url.pathname)) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { window.sendScrollStream = controller; },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      return originalFetch(input, init);
    };
  });
  await bootWithWorkspace(page, 'Send scroll');
  const scroller = page.locator('[data-node-id] .term-scrollbar').first();
  const send = async (text: string) => {
    await page.locator(COMPOSER_EDITOR).first().fill(text);
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
    await expect.poll(() => page.evaluate(() => !!window.sendScrollStream)).toBe(true);
  };
  const emit = async (events: SseEvent[], close = false) => {
    await page.evaluate(({ body, close }) => {
      window.sendScrollStream!.enqueue(new TextEncoder().encode(body));
      if (close) {
        window.sendScrollStream!.close();
        window.sendScrollStream = undefined;
      }
    }, { body: sseBody(events), close });
  };
  const fromBottom = () => scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  // History that overflows the pane, so a send has somewhere to scroll.
  await send('Build some history');
  await emit([
    { event: 'chunk', data: { text: Array.from({ length: 36 }, (_, i) => `History paragraph ${i}.`).join('\n\n') } },
    { event: 'done', data: { stopReason: 'end_turn' } },
  ], true);
  await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
  await expect(page.getByText('History paragraph 35.', { exact: true })).toBeVisible();
  await expect.poll(fromBottom).toBeLessThan(2);
  return { scroller, send, emit, fromBottom };
}

for (const width of [1280, 390]) {
  test(`a send glides the thread up to rest above the composer at ${width}px`, async ({ page }) => {
    const { scroller, send, emit, fromBottom } = await setUp(page, width);

    // Sample scrollTop every frame from before the send until it settles.
    await scroller.evaluate(el => {
      window.sendScrollSamples = [];
      const until = performance.now() + 1500;
      const tick = () => {
        window.sendScrollSamples!.push(el.scrollTop);
        if (performance.now() < until) requestAnimationFrame(tick);
      };
      tick();
    });
    await send('Continue');
    const user = scroller.locator('[data-msg-id]').filter({ hasText: 'Continue' }).last();
    await expect(user).toBeVisible();
    // The bubble only fades: nothing between it and its row is moved or scaled.
    const moved = await user.evaluate(row => {
      const bubble = row.querySelector('.terminal-message-user');
      const out: string[] = [];
      for (let el = bubble as HTMLElement | null; el && el !== row; el = el.parentElement) {
        const t = getComputedStyle(el).transform;
        if (t !== 'none') out.push(t);
      }
      return out;
    });
    expect(moved).toEqual([]);

    await expect.poll(fromBottom).toBeLessThan(2);
    await expect(scroller.locator('[data-tail-spacer]')).toHaveCount(0);
    await page.waitForTimeout(1600);
    const samples = await page.evaluate(() => window.sendScrollSamples!);
    const start = samples[0];
    const end = samples[samples.length - 1];
    // It travels: more than one frame between start and rest, never back.
    expect(end).toBeGreaterThan(start + 20);
    expect(samples.filter(v => v > start + 1 && v < end - 1).length).toBeGreaterThan(2);
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 0.5);

    // The message rests above the composer, not under it.
    const composerTop = await page.locator('[data-node-id] .terminal-composer').first().evaluate(el => el.getBoundingClientRect().top);
    const userBottom = await user.evaluate(el => el.getBoundingClientRect().bottom);
    expect(userBottom).toBeLessThan(composerTop);

    // A long reply keeps its tail above the composer as it streams.
    await emit([{ event: 'chunk', data: { text: Array.from({ length: 24 }, (_, i) => `Reply paragraph ${i}.`).join('\n\n') } }]);
    const last = scroller.getByText('Reply paragraph 23.', { exact: true });
    await expect(last).toBeVisible();
    // Tail-following rests the reply's last line just clear of the card.
    const clearOfComposer = async () => composerTop - await last.evaluate(el => el.getBoundingClientRect().bottom);
    await expect.poll(clearOfComposer).toBeGreaterThan(0);
    await expect.poll(clearOfComposer).toBeLessThan(80);
    await emit([{ event: 'done', data: { stopReason: 'end_turn' } }], true);
  });
}

test('a wheel during the send glide leaves the scroll with the reader', async ({ page }) => {
  const { scroller, send, emit, fromBottom } = await setUp(page, 1280);
  const before = await scroller.evaluate(el => el.scrollTop);
  await send('Continue');
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(before + 1);
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(900);
  const away = await fromBottom();
  expect(away).toBeGreaterThan(200);
  // Streaming output does not pull the reader back down.
  await emit([{ event: 'chunk', data: { text: Array.from({ length: 12 }, (_, i) => `Reply paragraph ${i}.`).join('\n\n') } }]);
  await expect(scroller.getByText('Reply paragraph 11.', { exact: true })).toBeAttached();
  await page.waitForTimeout(300);
  expect(await fromBottom()).toBeGreaterThan(200);
  await emit([{ event: 'done', data: { stopReason: 'end_turn' } }], true);
});
