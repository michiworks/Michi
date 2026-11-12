import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  mapAgentEvent,
  type MapperContext,
} from "../src/agents/pi/eventMapper";

function context(): MapperContext {
  return {
    cumulative: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
    contextWindow: 1_000_000,
    runStartMs: Date.now(),
  };
}

describe("Pi event mapper provider errors", () => {
  test("surfaces an OpenRouter rate-limit error instead of completing an empty turn", () => {
    const ctx = context();
    const errorMessage = '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.","remedy_hint":"Retry shortly or route to another provider."}}';

    const messageEvents = Array.from(mapAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage,
        content: [],
        usage: {
          input: 0,
          output: 0,
          cost: { total: 0 },
        },
      },
    }, ctx));
    assert.deepEqual(messageEvents, []);

    const terminalEvents = Array.from(mapAgentEvent({ type: "agent_end" }, ctx));
    const runtimeError = terminalEvents.find((event) => event.kind === "runtime_error");
    assert.deepEqual(runtimeError, {
      kind: "runtime_error",
      error: "429: stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.\nRetry shortly or route to another provider.",
    });
    assert.deepEqual(terminalEvents[terminalEvents.length - 1], { kind: "turn_end", stopReason: "error" });
  });

  test("preserves a non-JSON provider error verbatim", () => {
    const ctx = context();
    Array.from(mapAgentEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Provider connection closed",
      },
    }, ctx));

    const events = Array.from(mapAgentEvent({ type: "agent_end" }, ctx));
    assert.deepEqual(events.find((event) => event.kind === "runtime_error"), {
      kind: "runtime_error",
      error: "Provider connection closed",
    });
  });
});

describe('eventMapper', () => {
  test('maps Pi turn_start/turn_end to harness_lifecycle, not ChatHub done', () => {
    const events = [
      ...mapAgentEvent({ type: 'turn_start' }, context()),
      ...mapAgentEvent({ type: 'turn_end' }, context()),
    ];
    assert.deepEqual(events.map((e) => e.kind), ['harness_lifecycle', 'harness_lifecycle']);
    assert.equal(events.some((e) => e.kind === 'turn_end'), false);
  });

  test('maps tool_execution_update to tool_call_update', () => {
    const events = [...mapAgentEvent({
      type: 'tool_execution_update',
      toolCallId: 'tc1',
      toolName: 'bash',
      args: { cmd: 'ls' },
    }, context())];
    assert.equal(events[0]?.kind, 'tool_call_update');
    assert.equal(events[0] && 'status' in events[0] ? events[0].status : '', 'in_progress');
  });

  test('maps compaction and retry when present, ignores when absent', () => {
    const present = [
      ...mapAgentEvent({ type: 'compaction_start' }, context()),
      ...mapAgentEvent({ type: 'auto_retry_start' }, context()),
    ];
    assert.deepEqual(present.map((e) => e.kind), ['compaction_start', 'retry_start']);
    const absent = [...mapAgentEvent({ type: 'unknown_noise' }, context())];
    assert.equal(absent.length, 0);
  });
});


test('Pi SDK price-table cost has USD units and estimated provenance instead of native credits', () => {
  const ctx = context();
  ctx.cumulative.totalCost = 0.123;
  const summary = Array.from(mapAgentEvent({ type: 'agent_end' }, ctx)).find(event => event.kind === 'usage_summary');
  assert.ok(summary?.kind === 'usage_summary');
  assert.deepEqual(summary.charge, { amount: 0.123, unit: 'USD', provenance: 'sdk_estimate' });
  assert.equal(summary.totalCredits, undefined);
  assert.equal(summary.source, 'estimated');
});


test('usage counts cache reads and writes as input, like the Claude adapter', () => {
  const ctx = context();
  // DeepSeek-shaped: most of each request's prompt comes from the provider cache.
  for (const usage of [
    { input: 120, cacheRead: 9_800, cacheWrite: 0, output: 40, totalTokens: 9_960, cost: { total: 0.001 } },
    { input: 80, cacheRead: 10_100, cacheWrite: 300, output: 60, totalTokens: 10_540, cost: { total: 0.002 } },
  ]) [...mapAgentEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [], usage } }, ctx)];
  [...mapAgentEvent({ type: 'compaction_end', result: { usage: { input: 500, cacheRead: 0, cacheWrite: 0, output: 200, cost: { total: 0.0005 } } } }, ctx)];
  const summary = Array.from(mapAgentEvent({ type: 'agent_end' }, ctx)).find(event => event.kind === 'usage_summary');
  assert.ok(summary?.kind === 'usage_summary');
  assert.equal(summary.inputTokens, 120 + 9_800 + 80 + 10_100 + 300 + 500);
  assert.equal(summary.cachedInputTokens, 9_800 + 10_100);
  assert.equal(summary.outputTokens, 40 + 60 + 200);
  assert.equal(summary.totalTokens, 20_900 + 300);
  assert.ok(Math.abs((summary.charge?.amount ?? 0) - 0.0035) < 1e-9);
});

describe('Pi context fill', () => {
  const call = (input: number, cacheRead: number, output: number) => ({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'toolUse', content: [], usage: { input, cacheRead, cacheWrite: 0, output, cost: { total: 0 } } },
  });
  const fill = (ctx: MapperContext) => {
    const events = [...mapAgentEvent({ type: 'agent_end' }, ctx)];
    const usage = events.find(event => event.kind === 'context_usage');
    const summary = events.find(event => event.kind === 'usage_summary');
    assert.ok(usage?.kind === 'context_usage' && summary?.kind === 'usage_summary');
    assert.equal(summary.contextUsagePercentage, usage.contextUsagePercentage);
    return usage.contextUsagePercentage;
  };

  test('is the latest call\'s share of the window, not the sum of every call in the run', () => {
    const ctx = { ...context(), contextWindow: 100_000 };
    [...mapAgentEvent(call(1_000, 59_000, 500), ctx)];
    [...mapAgentEvent(call(1_500, 60_500, 500), ctx)];
    assert.equal(fill(ctx), 62.5);
  });

  test('never exceeds 100%', () => {
    const ctx = { ...context(), contextWindow: 100_000 };
    [...mapAgentEvent(call(1_000, 120_000, 500), ctx)];
    assert.equal(fill(ctx), 100);
  });

  test('a compaction lowers it to the compacted size, and its summarisation call does not count', () => {
    const ctx = { ...context(), contextWindow: 100_000 };
    [...mapAgentEvent(call(1_000, 79_000, 500), ctx)];
    [...mapAgentEvent({ type: 'compaction_end', result: { tokensBefore: 80_500, estimatedTokensAfter: 12_000, usage: { input: 80_000, output: 2_000, cost: { total: 0 } } } }, ctx)];
    assert.equal(fill(ctx), 12);
  });
});

test('a run without cache hits reports no cachedInputTokens', () => {
  const ctx = context();
  [...mapAgentEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [], usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, totalTokens: 15, cost: { total: 0 } } } }, ctx)];
  const summary = Array.from(mapAgentEvent({ type: 'agent_end' }, ctx)).find(event => event.kind === 'usage_summary');
  assert.ok(summary?.kind === 'usage_summary');
  assert.equal(summary.cachedInputTokens, undefined);
  assert.equal(summary.totalTokens, 15);
});

test('successful SDK recovery clears a previous overflow error at the final durable boundary', () => {
  const ctx = context();
  [...mapAgentEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'context overflow' } }, ctx)];
  [...mapAgentEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }, ctx)];
  const events = [...mapAgentEvent({ type: 'agent_end' }, ctx)];
  assert.equal(events.some(event => event.kind === 'runtime_error'), false);
  assert.deepEqual(events.at(-1), { kind: 'turn_end' });
});

test('a tool result image reaches the chip as a placeholder; the agent loop keeps its result', () => {
  const data = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(30_000, 2)]).toString('base64');
  const result = { content: [{ type: 'text', text: 'Read shot.png' }, { type: 'image', data, mimeType: 'image/png' }], details: {} };
  const before = structuredClone(result);
  const events = [...mapAgentEvent({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', result, isError: false }, context())];
  assert.deepEqual(result, before);
  const update = events.find(event => event.kind === 'tool_call_update');
  assert.ok(update?.kind === 'tool_call_update');
  assert.deepEqual(JSON.parse(update.output!), {
    content: [{ type: 'text', text: 'Read shot.png' }, { type: 'image', data: '[image image/png 29 KB omitted]', mimeType: 'image/png' }],
    details: {},
  });
});

describe("Pi event mapper tool payloads", () => {
  test("shows a tool call whose arguments JSON cannot encode", () => {
    const [event] = Array.from(mapAgentEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "count", args: { n: 10n } }, context()));
    assert.equal(event.kind === "tool_call" && event.inputJson, "[object Object]");
  });
});
