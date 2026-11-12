import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { AgentRunEventType, AgentRunStatus, type AgentRunDtoV1, type AgentRunEventV1 } from 'michi-shared';
import { AgentRunEventBus } from '../src/agents/runs/agentRunEventBus';
import { setupAgentRunRoutes, type AgentRunRouteService } from '../src/routes/agentRuns';
import type { AgentRunSseSource } from '../src/routes/agentRunSse';

const HASH = 'd'.repeat(64);
const run: AgentRunDtoV1 = { version: 1, id: 'run-1', ownerUserId: 'owner-a', workspaceId: 'ws-a', definitionId: null, definitionRevision: null, effectiveDefinition: { version: 1, name: 'Worker', description: 'Works', instructions: 'Work', runtimeProfile: { version: 1, runtimeId: 'pi' }, fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] }, permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 0, maxConcurrentRuns: 1, maxWallTimeMs: 1000, maxAttempts: 1 }, contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 100 } }, invocationMode: 'manual' as any, completionMode: 'detach' as any, parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null, task: 'Work', contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, expectedResult: null, executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: 'ws-a', snapshotHash: HASH, createdAt: 1 }, status: AgentRunStatus.Running, waitingReason: null, activeAttemptId: null, resultBundle: null, latestEventSeq: 1, createdAt: 1, startedAt: 1, completedAt: null, archivedAt: null, expiresAt: null };
const history: AgentRunEventV1[] = [0, 1].map((seq) => ({ version: 1, runId: 'run-1', seq, attemptId: null, type: AgentRunEventType.Assistant, payload: { text: String(seq) }, createdAt: seq + 1 }));
let server: ReturnType<typeof express.application.listen>;
let base = '';
afterEach(async () => { delete process.env.MICHI_CLOUD; if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

const historySource: AgentRunSseSource = { getRun(owner: string, id: string) { return owner === 'owner-a' && id === 'run-1' ? run : null; }, listEvents(_owner: string, _id: string, afterSeq: number, limit: number) { return history.filter((event) => event.seq > afterSeq).slice(0, limit); }, listRuns(owner: string, query: { workspaceId: string }) { if (owner !== 'owner-a' || query.workspaceId !== 'ws-a') throw new Error('workspace not found'); return [run]; } };

async function start(events: AgentRunEventBus, source = historySource) {
  process.env.MICHI_CLOUD = '1';
  const service = { async spawn() { throw new Error('unused'); }, list() { return []; }, getDetail() { return null; }, events() { return null; }, async input() { return false; }, async cancel() { return false; }, async respond() { return null; }, createWatch() { throw new Error('unused'); }, updateWatch() { return null; } } satisfies AgentRunRouteService;
  const app = express(); app.use((req: any, _res, next) => { const owner = req.header('x-user'); if (owner) req.user = { id: owner }; next(); });
  app.use('/api', setupAgentRunRoutes({ service, sse: { source, events, heartbeatMs: 60_000, now: () => 100 } }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<any> {
  let text = '';
  while (!text.includes('\n\n')) { const next = await reader.read(); if (next.done) throw new Error('SSE closed'); text += new TextDecoder().decode(next.value); }
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(data!.slice(6));
}

describe('Agent Run SSE', () => {
  test('replays after per-Run cursor, dedupes, and observes later committed events', async () => {
    const events = new AgentRunEventBus(); await start(events);
    const response = await fetch(`${base}/agent-runs/subscribe?workspaceId=ws-a&cursors=${encodeURIComponent(JSON.stringify({ 'run-1': 0 }))}`, { headers: { 'x-user': 'owner-a' } });
    assert.equal(response.status, 200); const reader = response.body!.getReader();
    assert.equal((await readFrame(reader)).seq, 1);
    events.publishCommitted({ ...history[1], seq: 1 });
    events.publishCommitted({ ...history[1], seq: 2, createdAt: 3 });
    assert.equal((await readFrame(reader)).seq, 2);
    await reader.cancel();
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  });

  test('reports durable cursor gaps and hides wrong-owner subscriptions', async () => {
    const events = new AgentRunEventBus(); await start(events);
    const gap = await fetch(`${base}/agent-runs/subscribe?workspaceId=ws-a&cursors=${encodeURIComponent(JSON.stringify({ 'run-1': 9 }))}`, { headers: { 'x-user': 'owner-a' } });
    const reader = gap.body!.getReader(); const envelope = await readFrame(reader); assert.equal(envelope.event, 'agent_run_gap'); await reader.cancel();
    const hidden = await fetch(`${base}/agent-runs/subscribe?workspaceId=ws-a&cursors=${encodeURIComponent(JSON.stringify({ 'run-1': 0 }))}`, { headers: { 'x-user': 'owner-b' } });
    assert.equal(hidden.status, 404);
  });

  test('a replay larger than the slow-consumer limit is cut short with gaps, and live events follow', async () => {
    // Four Runs of 1,000 events of 12 KiB: about 48 MiB if replayed whole.
    const runs = [0, 1, 2, 3].map((index) => ({ ...run, id: `big-${index}`, latestEventSeq: 999 }));
    const text = 'x'.repeat(12 * 1024);
    const event = (runId: string, seq: number): AgentRunEventV1 => ({ version: 1, runId, seq, attemptId: null, type: AgentRunEventType.Assistant, payload: { text }, createdAt: seq + 1 });
    const events = new AgentRunEventBus();
    await start(events, {
      getRun: (owner, id) => (owner === 'owner-a' ? runs.find((candidate) => candidate.id === id) ?? null : null),
      listEvents: (_owner, runId, afterSeq, limit) => Array.from({ length: Math.max(0, Math.min(limit, 999 - afterSeq)) }, (_, i) => event(runId, afterSeq + 1 + i)),
      listRuns: () => runs,
    });
    const cursors = Object.fromEntries(runs.map((candidate) => [candidate.id, -1]));
    const response = await fetch(`${base}/agent-runs/subscribe?workspaceId=ws-a&cursors=${encodeURIComponent(JSON.stringify(cursors))}`, { headers: { 'x-user': 'owner-a' } });
    const frames = sseFrames(response.body!.getReader());
    const delivered = new Map(runs.map((candidate) => [candidate.id, -1]));
    const settled = new Set<string>();
    while (settled.size < runs.length) {
      const envelope = await frames.next();
      if (envelope.event === 'agent_run_event') {
        assert.equal(envelope.seq, delivered.get(envelope.runId)! + 1, 'replayed events are contiguous');
        delivered.set(envelope.runId, envelope.seq);
        if (envelope.seq === 999) settled.add(envelope.runId);
      } else if (envelope.event === 'agent_run_gap') {
        assert.equal(envelope.gapAfterSeq, delivered.get(envelope.runId), 'the gap starts after the last replayed event');
        settled.add(envelope.runId);
      }
    }
    assert.ok([...delivered.values()].some((seq) => seq < 999), 'the replay was bounded');
    events.publishCommitted(event('big-0', 1000));
    const live = await frames.next();
    assert.deepEqual([live.event, live.runId, live.seq], ['agent_run_event', 'big-0', 1000]);
    await frames.cancel();
  });
});

function sseFrames(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(): Promise<any> {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE closed');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      return data ? JSON.parse(data.slice(6)) : this.next();
    },
    cancel: () => reader.cancel(),
  };
}
