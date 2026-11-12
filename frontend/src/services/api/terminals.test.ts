import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStreamEvent } from 'michi-shared';
import { closeTerminal, createTerminal, listTerminals, restartTerminal, TerminalLink, type TerminalApiError } from './terminals';

const mocks = vi.hoisted(() => ({ fetchStream: vi.fn() }));
vi.mock('./streamTransport', () => ({ fetchStream: mocks.fetchStream }));

const encoder = new TextEncoder();
const frame = (event: TerminalStreamEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/** An SSE response the test writes to; it stays open until ended or aborted. */
function stream(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
  signal?.addEventListener('abort', () => { try { controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* closed */ } });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push: (event: TerminalStreamEvent) => controller.enqueue(encoder.encode(frame(event))),
    end: () => controller.close(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

const handlers = () => ({ onEvent: vi.fn(), onStatus: vi.fn(), onEnd: vi.fn() });
const streamCalls = () => mocks.fetchStream.mock.calls.filter(([url]) => String(url).includes('/stream?'));
const inputBodies = () => mocks.fetchStream.mock.calls
  .filter(([url]) => String(url).endsWith('/input'))
  .map(([, init]) => JSON.parse((init as RequestInit).body as string).data);

afterEach(() => { mocks.fetchStream.mockReset(); });

describe('TerminalLink', () => {
  it('resumes from the last seq of the same terminal run after a dropped connection', async () => {
    const streams: Array<ReturnType<typeof stream>> = [];
    mocks.fetchStream.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes('/stream?')) { const s = stream(init.signal); streams.push(s); return s.response; }
      return new Response('{}', { status: 200 });
    });
    const h = handlers();
    const link = new TerminalLink('local', 't1', 'w1', h);
    link.start();
    await until(() => streams.length === 1);
    expect(streamCalls()[0][0]).toContain('/terminals/t1/stream?after=-1&clientId=w1');
    streams[0].push({ type: 'reset', seq: 5, instance: 'run-1', data: 'hello', exited: false });
    streams[0].push({ type: 'data', seq: 8, data: ' ok' });
    await until(() => h.onEvent.mock.calls.length === 2);
    streams[0].end();
    await until(() => streams.length === 2);
    expect(streamCalls()[1][0]).toContain('after=8&clientId=w1&instance=run-1');
    expect(h.onStatus).toHaveBeenCalledWith('reconnecting');
    link.dispose();
  });

  it('sends input in order, one request at a time, and drops input whose delivery is uncertain', async () => {
    const pending: Array<ReturnType<typeof deferred<Response>>> = [];
    mocks.fetchStream.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes('/stream?')) return stream(init.signal).response;
      if (url.endsWith('/input')) { const d = deferred<Response>(); pending.push(d); return d.promise; }
      return new Response('{}', { status: 200 });
    });
    const link = new TerminalLink('local', 't1', 'w1', handlers());
    link.start();
    await until(() => link.connected);
    link.write('l');
    link.write('s');
    link.write('\r');
    await until(() => pending.length === 1);
    expect(inputBodies()).toEqual(['l']);
    pending[0].resolve(new Response('{"ok":true}', { status: 200 }));
    await until(() => pending.length === 2);
    expect(inputBodies()).toEqual(['l', 's\r']);
    // The tunnel dropped mid-request: maybe the shell got "s\r", maybe not. Never send it twice.
    pending[1].reject(new TypeError('Failed to fetch'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    link.write('x');
    await until(() => pending.length === 3);
    expect(inputBodies()).toEqual(['l', 's\r', 'x']);
    link.dispose();
  });

  it('ends without reconnecting when the phone may not use terminals or the terminal closed', async () => {
    mocks.fetchStream.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'terminal_phone_off', error: 'off' }), { status: 403 }));
    const off = handlers();
    new TerminalLink('local', 't1', 'p1', off).start();
    await until(() => off.onEnd.mock.calls.length === 1);
    expect((off.onEnd.mock.calls[0][0] as TerminalApiError).code).toBe('terminal_phone_off');

    const s = stream();
    mocks.fetchStream.mockResolvedValueOnce(s.response);
    const closed = handlers();
    new TerminalLink('local', 't2', 'w1', closed).start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    s.push({ type: 'closed', reason: 'closed' });
    s.end();
    await until(() => closed.onEnd.mock.calls.length === 1);
    expect((closed.onEnd.mock.calls[0][0] as TerminalApiError).code).toBe('terminal_not_found');
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(mocks.fetchStream).toHaveBeenCalledTimes(2);
  });
});

describe('terminal requests', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('send the browser default credentials, which the loopback API allows from the dev server', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ available: true, terminals: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await listTerminals('local');
    await createTerminal('local', {} as Parameters<typeof createTerminal>[1]);
    await restartTerminal('local', 't1', 'c1');
    await closeTerminal('local', 't1', 'c1');
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const [, init] of fetch.mock.calls as Array<[string, RequestInit | undefined]>) expect(init?.credentials).toBeUndefined();
  });
});
