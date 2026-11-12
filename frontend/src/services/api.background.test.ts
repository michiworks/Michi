import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_STREAM_EVENTS, encodeChatStreamEvent } from 'michi-shared';
import { reattachTurnReplay, streamMessage, subscribeBackground, type TurnReplayReattach } from './api';

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('background SSE', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('observes another device through the foreground wrapper and opts into delivery', async () => {
    const event = { event: 'turn_start', data: { chatId: 'phone', nodeId: 'phone', turnId: 'phone-turn', assistantId: 'phone-a', seq: 0, userText: 'from phone' } };
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      `event: foreground_event\ndata: ${JSON.stringify(event)}\n\n`,
      'event: foreground_event\ndata: null\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const onTurnStart = vi.fn();
    subscribeBackground(() => ({ onTurnStart }));
    await vi.waitFor(() => expect(onTurnStart).toHaveBeenCalledTimes(1));
    expect(onTurnStart).toHaveBeenCalledWith(expect.objectContaining({ userText: 'from phone' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).includeForeground).toBe(true);
  });

  it('ignores its own foreground echo even before direct headers arrive and after cancellation', async () => {
    const localEvent = { event: 'turn_start', data: { chatId: 'echo-node', nodeId: 'echo-node', turnId: 'echo-turn', assistantId: 'echo-a', seq: 0, userText: 'local' } };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith('/message')) return new Promise(() => {});
      if (String(url).endsWith('/cancel')) return new Response('{}');
      return sseResponse([`event: foreground_event\ndata: ${JSON.stringify(localEvent)}\n\n`]);
    }));
    const cancel = streamMessage('echo-node', 'local', {}, { turnId: 'echo-turn' });
    const onTurnStart = vi.fn();
    const onDisconnect = vi.fn();
    subscribeBackground(() => ({ onTurnStart }), { onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(onTurnStart).not.toHaveBeenCalled();
    cancel();
    subscribeBackground(() => ({ onTurnStart }), { onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(2));
    expect(onTurnStart).not.toHaveBeenCalled();
  });

  it.each([408, 429, 503])('retries a %i subscribe answer, a busy channel or gateway', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    const onDisconnect = vi.fn();
    subscribeBackground(() => ({}), { onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(onDisconnect.mock.calls[0][0].retryable).toBe(true);
  });

  it.each([401, 403, 404])('stops on a %i subscribe answer', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    const onDisconnect = vi.fn();
    subscribeBackground(() => ({}), { onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(onDisconnect.mock.calls[0][0].retryable).toBe(false);
  });

  it('treats replay-gap reconciliation as a delivery barrier', async () => {
    let releaseGap!: () => void;
    const gapBarrier = new Promise<void>((resolve) => { releaseGap = resolve; });
    const gapFrame = `event: background_sync_required\ndata: ${JSON.stringify({
        chatId: 'chat-gap', nodeId: 'node-gap', turnId: 'turn-durable', seq: 12,
      })}\n\n`;
    const liveFrame = encodeChatStreamEvent({
        event: CHAT_STREAM_EVENTS.chunk,
        data: {
          chatId: 'chat-gap', nodeId: 'node-gap', turnId: 'turn-live', seq: 1,
          assistantId: 'assistant-live', text: 'must wait for reconciliation',
        },
      });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([gapFrame + liveFrame])));
    const chunk = vi.fn();
    const onReplayGap = vi.fn(() => gapBarrier);

    subscribeBackground(() => ({ onChunk: chunk }), {
      onReplayGap,
    });
    await vi.waitFor(() => expect(onReplayGap).toHaveBeenCalledTimes(1));
    expect(chunk).not.toHaveBeenCalled();

    releaseGap();
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(1));
  });

  it('holds the silence watchdog while a replay gap reconciles, then restarts it', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const gapFrame = `event: background_sync_required\ndata: ${JSON.stringify({
        chatId: 'chat-gap', nodeId: 'node-gap', turnId: 'turn-durable', seq: 12,
      })}\n\n`;
      // A live feed: the gap arrives and the connection stays open.
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(gapFrame)); } });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })));
      let release!: () => void;
      let gapSignal: AbortSignal | undefined;
      const onReplayGap = vi.fn((_gap: unknown, signal: AbortSignal) => {
        gapSignal = signal;
        return new Promise<void>((resolve) => { release = resolve; });
      });
      const stop = subscribeBackground(() => ({}), { onReplayGap });
      for (let i = 0; i < 20 && !gapSignal; i += 1) await vi.advanceTimersByTimeAsync(0);
      expect(onReplayGap).toHaveBeenCalledTimes(1);
      // Far past the 30 s silence limit: the reconcile's reads are not cut off.
      await vi.advanceTimersByTimeAsync(90_000);
      expect(gapSignal!.aborted).toBe(false);
      release();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(gapSignal!.aborted).toBe(false);
      // Silence after the barrier lifts still ends a dead feed.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(gapSignal!.aborted).toBe(true);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('after installing past the gap, drops the ended gap turn and keeps permission prompts the cursor skips', async () => {
    const envelope = { chatId: 'chat-gap', nodeId: 'node-gap' };
    const frames = [
      `event: background_sync_required\ndata: ${JSON.stringify({ ...envelope, turnId: 'turn-old', seq: 12 })}\n\n`,
      // Replay of the gap's turn, which ended while the snapshot was read.
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { ...envelope, turnId: 'turn-old', seq: 13, assistantId: 'a-old', text: 'old tail' } }),
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.done, data: { ...envelope, turnId: 'turn-old', seq: 14, assistantId: 'a-old', stopReason: 'end_turn', persisted: true } }),
      // The installed turn: a prompt its body cannot hold, then output it does.
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.permissionRequest, data: {
        ...envelope, turnId: 'turn-new', seq: 2, assistantId: 'a-new', requestId: 7, title: 'Run tests', options: [],
      } }),
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { ...envelope, turnId: 'turn-new', seq: 3, assistantId: 'a-new', text: 'in the body' } }),
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { ...envelope, turnId: 'turn-new', seq: 6, assistantId: 'a-new', text: 'new output' } }),
      // Another chat is not affected by this chat's gap.
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { chatId: 'other', nodeId: 'other', turnId: 'turn-old', seq: 1, assistantId: 'a-x', text: 'other' } }),
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([frames.join('')])));
    const envelopes: Array<{ chatId?: string; turnId?: string; seq?: number }> = [];
    const permission = vi.fn();
    const onDisconnect = vi.fn();
    subscribeBackground(() => ({
      onEnvelope: (data) => { envelopes.push({ chatId: data.chatId, turnId: data.turnId, seq: data.seq }); },
      onPermissionRequest: permission,
    }), { onReplayGap: async () => ({ turnId: 'turn-new', seq: 5 }), onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(envelopes).toEqual([
      // Unsequenced, as the server's own recovery frames: it leaves the cursor alone.
      { chatId: 'chat-gap', turnId: 'turn-new', seq: undefined },
      // Sequenced output reaches the sequence gate, which drops what the body holds.
      { chatId: 'chat-gap', turnId: 'turn-new', seq: 3 },
      { chatId: 'chat-gap', turnId: 'turn-new', seq: 6 },
      { chatId: 'other', turnId: 'turn-old', seq: 1 },
    ]);
    expect(permission).toHaveBeenCalledWith(expect.objectContaining({ requestId: 7, title: 'Run tests' }));
  });

  it('delivers the gap turn when the snapshot installed that same turn', async () => {
    const envelope = { chatId: 'chat-gap', nodeId: 'node-gap', turnId: 'turn-a', assistantId: 'a' };
    const frames = [
      `event: background_sync_required\ndata: ${JSON.stringify({ chatId: 'chat-gap', nodeId: 'node-gap', turnId: 'turn-a', seq: 12 })}\n\n`,
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { ...envelope, seq: 13, text: 'held by the body' } }),
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.permissionResolved, data: { ...envelope, seq: 15, requestId: 7 } }),
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { ...envelope, seq: 21, text: 'new' } }),
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([frames.join('')])));
    const seqs: Array<number | undefined> = [];
    const onDisconnect = vi.fn();
    subscribeBackground(() => ({ onEnvelope: (data) => { seqs.push(data.seq); } }),
      { onReplayGap: async () => ({ turnId: 'turn-a', seq: 20 }), onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(seqs).toEqual([13, undefined, 21]);
  });

  it('delivers scheduled run control frames without blocking chat events', async () => {
    const event = {
      phase: 'started', runId: 'run-1', jobId: 'job-1', jobName: 'Digest', workspaceId: 'ws-1',
      nodeId: 'n-1', treeId: 't-1', status: 'running', summary: null, error: null, notify: true, at: 1,
    };
    const liveFrame = encodeChatStreamEvent({
      event: CHAT_STREAM_EVENTS.chunk,
      data: { chatId: 'chat-x', nodeId: 'node-x', turnId: 'turn-x', seq: 1, assistantId: 'a-x', text: 'after' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      `event: scheduled_job_run\ndata: ${JSON.stringify(event)}\n\n`,
      'event: scheduled_job_run\ndata: {"phase":"bogus"}\n\n',
      liveFrame,
    ])));
    const onScheduledJobRun = vi.fn();
    const chunk = vi.fn();
    subscribeBackground(() => ({ onChunk: chunk }), { onScheduledJobRun });
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(1));
    expect(onScheduledJobRun).toHaveBeenCalledTimes(1);
    expect(onScheduledJobRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', nodeId: 'n-1', phase: 'started' }));
  });

  it('delivers job change frames separately from run frames and chat events', async () => {
    const change = { change: 'created', jobId: 'job-1', workspaceId: 'ws-1', at: 1 };
    const liveFrame = encodeChatStreamEvent({
      event: CHAT_STREAM_EVENTS.chunk,
      data: { chatId: 'chat-x', nodeId: 'node-x', turnId: 'turn-x', seq: 1, assistantId: 'a-x', text: 'after' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      `event: scheduled_jobs_changed\ndata: ${JSON.stringify(change)}\n\n`,
      'event: scheduled_jobs_changed\ndata: {"change":"renamed"}\n\n',
      'event: scheduled_jobs_changed\ndata: not json\n\n',
      liveFrame,
    ])));
    const onScheduledJobsChanged = vi.fn();
    const onScheduledJobRun = vi.fn();
    const chunk = vi.fn();
    subscribeBackground(() => ({ onChunk: chunk }), { onScheduledJobsChanged, onScheduledJobRun });
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(1));
    expect(onScheduledJobsChanged).toHaveBeenCalledTimes(1);
    expect(onScheduledJobsChanged).toHaveBeenCalledWith(change);
    expect(onScheduledJobRun).not.toHaveBeenCalled();
  });

  it('shows the exact restart reason when a foreground replay is no longer available', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.turnStart,
          data: { turnId: 'interrupted', seq: 0, assistantId: 'a-interrupted', nodeId: 'node', userText: 'hello' } }),
      ]))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'Michi restarted while this task was running. Check the conversation before retrying.',
        code: 'backend_restarted',
      }), { status: 410, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const error = vi.fn(), done = vi.fn();
    streamMessage('node', 'hello', { onError: error, onDone: done });
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith(
      'Michi restarted while this task was running. Check the conversation before retrying.',
      undefined, undefined, 'backend_restarted',
    );
    expect(done).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('can resume the same foreground turn more than once with a moving seq cursor', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        encodeChatStreamEvent({
          event: CHAT_STREAM_EVENTS.turnStart,
          data: { turnId: 'turn-many', seq: 0, assistantId: 'a-many', nodeId: 'n-many', userText: 'hello' },
        }),
        encodeChatStreamEvent({
          event: CHAT_STREAM_EVENTS.chunk,
          data: { turnId: 'turn-many', seq: 1, assistantId: 'a-many', text: 'one' },
        }),
      ]))
      .mockResolvedValueOnce(sseResponse([
        encodeChatStreamEvent({
          event: CHAT_STREAM_EVENTS.chunk,
          data: { turnId: 'turn-many', seq: 2, assistantId: 'a-many', text: 'two' },
        }),
      ]))
      .mockResolvedValueOnce(sseResponse([
        encodeChatStreamEvent({
          event: CHAT_STREAM_EVENTS.done,
          data: { turnId: 'turn-many', seq: 3, assistantId: 'a-many', persisted: true },
        }),
      ]));
    vi.stubGlobal('fetch', fetchMock);
    const done = vi.fn();

    streamMessage('n-many', 'hello', { onDone: done });
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    expect(String(fetchMock.mock.calls[1][0])).toContain('fromSeq=2');
    expect(String(fetchMock.mock.calls[2][0])).toContain('fromSeq=3');
  });

  it('finalizes as aborted when Stop is pressed during a pending replay request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        encodeChatStreamEvent({
          event: CHAT_STREAM_EVENTS.turnStart,
          data: { turnId: 'turn-stop', seq: 0, assistantId: 'a-stop', nodeId: 'n-stop', userText: 'hello' },
        }),
      ]))
      .mockImplementationOnce((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onAborted = vi.fn();

    const cancel = streamMessage('n-stop', 'hello', { onAborted });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    cancel();

    expect(onAborted).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[2][0])).toContain('/chats/n-stop/cancel');
  });
});

describe('foreground stream startup failures', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('surfaces POST 409 without replaying a turn that never started', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    streamMessage('n-conflict', 'retry', { onError });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith('stream failed: 409');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/chats/n-conflict/message');
  });
});

describe('foreground send while the previous turn finishes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const busy = () => new Response(JSON.stringify({ code: 'turn_active', error: 'Still busy' }), { status: 409 });

  it('silently waits through repeated busy responses and sends the same payload once the runtime is ready', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(sseResponse([
        encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.done, data: { persisted: true } }),
      ]));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn(), onDone = vi.fn(), onRetryStart = vi.fn(), onRetryEnd = vi.fn();
    streamMessage('n-busy', 'wire text', { onError, onDone, onRetryStart, onRetryEnd }, {
      turnId: 'waiting-turn', displayText: 'visible text',
      userMetadata: { quotedText: 'quote', attachments: [{ name: 'file', absPath: '/tmp/file' }] },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onRetryStart).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onRetryEnd).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    const payloads = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).body);
    expect(new Set(payloads).size).toBe(1);
    expect(JSON.parse(String(payloads[0]))).toMatchObject({ turnId: 'waiting-turn', text: 'wire text', displayText: 'visible text' });
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/message'))).toBe(true);
  });

  it('waits 250 ms, then twice as long each time up to 2 s, for as long as the turn is busy', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => busy());
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();
    const cancel = streamMessage('n-busy', 'next', { onError });
    await vi.advanceTimersByTimeAsync(0);
    for (const wait of [250, 500, 1_000, 2_000, 2_000, 2_000]) {
      const calls = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
    }
    expect(onError).not.toHaveBeenCalled();
    cancel();
  });

  it('withdraws the waiting send without cancelling the previous turn or leaving a retry timer', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => busy());
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn(), onAborted = vi.fn(), onCancelRecovery = vi.fn();
    const cancel = streamMessage('n-busy', 'next', { onError, onAborted, onCancelRecovery });
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onAborted).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(onCancelRecovery).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still surfaces a real startup failure after waiting, without resending or replaying it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(new Response(JSON.stringify({
      code: 'IDENTITY_MISMATCH', error: 'Identity changed',
    }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();
    streamMessage('n-busy', 'next', { onError });
    await vi.advanceTimersByTimeAsync(250);
    expect(onError).toHaveBeenCalledExactlyOnceWith('Identity changed', undefined, undefined, 'IDENTITY_MISMATCH');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('reattaching a turn to its replay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const refusal = (status: number, body: Record<string, unknown>) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  function reattach(responses: Array<() => Response>, options: Partial<TurnReplayReattach> = {}) {
    const fetchMock = vi.fn(async (_url: string) => (responses.shift() ?? refusal(503, {}))());
    vi.stubGlobal('fetch', fetchMock);
    const callbacks = { onStale: vi.fn(), onBackgroundOwned: vi.fn(), onReplayGone: vi.fn(), onUnavailable: vi.fn() };
    let seq = 4;
    const stop = reattachTurnReplay('chat-r', {
      turnId: 'turn-r', nextSeq: () => seq++, handlers: {}, isCurrent: () => true, ...callbacks, ...options,
    });
    const urls = () => fetchMock.mock.calls.map(([url]) => String(url));
    return { fetchMock, callbacks, stop, urls };
  }

  it.each([
    ['the replay is gone', refusal(410, { code: 'turn_replay_unavailable', error: 'gone' }), 'onReplayGone', ['gone', 'turn_replay_unavailable']],
    ['the backend restarted', refusal(410, { code: 'backend_restarted', error: 'restarted' }), 'onReplayGone', ['restarted', 'backend_restarted']],
    ['a 410 names no reason', refusal(410, { error: 'gone' }), 'onReplayGone', ['gone', 'turn_replay_unavailable']],
    ['the background feed owns the turn', refusal(410, { code: 'turn_background_owned', error: 'background' }), 'onBackgroundOwned', ['background']],
    ['a 410 names another reason', refusal(410, { code: 'turn_outcome_unknown', error: 'unknown' }), 'onUnavailable', ['unknown', 'turn_outcome_unknown']],
    ['the chat is not found', refusal(404, { error: 'not_found' }), 'onUnavailable', ['not_found', 'turn_outcome_unknown']],
    ['another refusal names its own code', refusal(409, { code: 'turn_active', error: 'busy' }), 'onUnavailable', ['busy', 'turn_outcome_unknown']],
  ] as const)('ends once when %s, and never as a code that would send the prompt again', async (_name, response, callback, args) => {
    const { callbacks, fetchMock } = reattach([response]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callbacks[callback]).toHaveBeenCalledExactlyOnceWith(...args);
    for (const [name, fn] of Object.entries(callbacks)) if (name !== callback) expect(fn).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reconnects from the next seq after 250 ms doubling to 5 s, from 250 ms again once a reconnect opens', async () => {
    const down = refusal(503, {});
    const { urls } = reattach([down, down, down, down, down, down, down, () => sseResponse([]), down]);
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toHaveLength(1);
    expect(urls()[0]).toContain('fromSeq=4');
    expect(urls()[0]).toContain('fromTurnId=turn-r');
    const delays = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 250];
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(urls()).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(urls()).toHaveLength(index + 2);
    }
    expect(urls()[1]).toContain('fromSeq=5');
  });

  it('ends without reconnecting once the turn is no longer current, or once stopped', async () => {
    let current = true;
    const stale = reattach([refusal(503, {})], { isCurrent: () => current });
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stale.fetchMock).toHaveBeenCalledTimes(1);
    expect(stale.callbacks.onStale).toHaveBeenCalledOnce();

    const stopped = reattach([refusal(503, {})]);
    await vi.advanceTimersByTimeAsync(0);
    stopped.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stopped.fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(Object.values(stopped.callbacks).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });
});
