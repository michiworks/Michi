import type { Page } from '@playwright/test';

export interface TerminalFixtureState {
  /** Whether the backend lets this window use terminals (a phone with Settings › Phone access › Terminal on). */
  allowed: boolean;
  inputs: string[];
  resizes: Array<{ cols: number; rows: number }>;
}

type TerminalWindow = Window & { __michiTerminal: TerminalFixtureState };

/**
 * A browser-local stand-in for backend/src/routes/terminals.ts. route.fulfill
 * cannot keep a stream open, so this replaces fetch for /api/terminals only;
 * the pane's own fetchStream, SSE parsing and TerminalLink still run. The
 * "shell" echoes input back as output. Nothing runs anywhere.
 */
export async function installTerminalFixture(page: Page, options: { allowed: boolean }): Promise<void> {
  await page.addInitScript((allowed) => {
    const state: TerminalFixtureState = { allowed, inputs: [], resizes: [] };
    (window as TerminalWindow).__michiTerminal = state;
    const encoder = new TextEncoder();
    const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    let seq = 0;
    const send = (event: Record<string, unknown>) => {
      const bytes = encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      for (const controller of streams) controller.enqueue(bytes);
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const off = () => json({ error: 'Terminals are off for phones on this machine.', code: 'terminal_phone_off' }, 403);
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const match = /\/api\/terminals(?:\/([a-zA-Z0-9-]+)(\/[a-z]+)?)?$/.exec(url.pathname);
      if (!match) return realFetch(input, init);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      const [, id, action] = match;
      if (!id && method === 'GET') {
        return json(state.allowed ? { available: true, terminals: [] }
          : { available: false, reason: 'phone-off', message: 'Terminals are off for phones on this machine.', terminals: [] });
      }
      if (!state.allowed) return off();
      if (!id && method === 'POST') {
        return json({ terminalId: body.terminalId, instance: 'fixture', cwd: body.cwd, createdAt: 1, lastActiveAt: 1,
          exited: false, cols: body.cols, rows: body.rows, clients: { phone: 0, desktop: 1 } });
      }
      if (action === '/stream') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streams.add(controller);
            const prompt = '~/Michi $ ';
            seq = prompt.length;
            controller.enqueue(encoder.encode(`event: reset\ndata: ${JSON.stringify({ type: 'reset', seq, instance: 'fixture', data: prompt, exited: false })}\n\n`));
            controller.enqueue(encoder.encode(`event: peers\ndata: ${JSON.stringify({ type: 'peers', phone: 0, desktop: 1 })}\n\n`));
            const signal = init?.signal;
            signal?.addEventListener('abort', () => { streams.delete(controller); try { controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* closed */ } }, { once: true });
          },
          cancel() { /* the pane closed */ },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (action === '/input') {
        const data = String(body.data ?? '');
        state.inputs.push(data);
        seq += data.length;
        send({ type: 'data', seq, data });
        return json({ ok: true });
      }
      if (action === '/resize') {
        state.resizes.push({ cols: Number(body.cols), rows: Number(body.rows) });
        return json({ ok: true });
      }
      return json(method === 'DELETE' ? { closed: true } : { ok: true });
    };
  }, options.allowed);
}

export const terminalInputs = (page: Page) => page.evaluate(() => (window as TerminalWindow).__michiTerminal.inputs.slice());
