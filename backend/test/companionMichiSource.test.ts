/**
 * The Companion's Michi source (sources/michi.ts, DESIGN §5, R2.2, R2.4) on
 * desktop workspaces stored with a NULL owner: waiting (a failed turn, a
 * reply ending in a question, a live approval), stalled after three days,
 * done until the user has it on screen, abandoned after a month; what it
 * never reads (system workspaces, "Let AI navigate" off, scheduled-job runs,
 * archived conversations); the delegated conversation a worker report
 * covers; failed scheduled jobs; versions that change with the state only;
 * focus, worker states, and a whole poll stored through applySourcePoll.
 * Temp MICHI_DATA_DIR per test; times are explicit.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_COMPANION_SETTINGS, type CompanionSettings } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import type { HomeLiveWaitReader } from '../src/services/pages/homeSections';
import {
  applySourcePoll,
  closeDelegation,
  getItemByKey,
  getSnapshots,
  markDelegationReported,
  recordDelegation,
} from '../src/services/companion/repository';
import { createMichiSource, MICHI_ABANDONED_AFTER_MS } from '../src/services/companion/sources/michi';
import type { ItemDraft, SourcePollResult } from '../src/services/companion/types';
import { seedConversation, type SeedTurn } from './helpers/homeConversations';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const settings: CompanionSettings = structuredClone(DEFAULT_COMPANION_SETTINGS);

let n = 0;
function chat(turn: Partial<SeedTurn> & Pick<SeedTurn, 'status'>, extra: { workspaceId?: string; nodeId?: string; title?: string | null; userMessageAt?: number; nodeStatus?: string } = {}): string {
  const nodeId = extra.nodeId ?? `c${++n}`;
  seedConversation({
    nodeId, workspaceId: extra.workspaceId ?? 'ws', title: extra.title, userMessageAt: extra.userMessageAt, nodeStatus: extra.nodeStatus,
    turns: [{ startedAt: NOW - HOUR, ...turn }],
  });
  return nodeId;
}

const viewed = (nodeId: string, at: number) => getDb().prepare('UPDATE nodes SET viewed_at = ? WHERE id = ?').run(at, nodeId);

async function poll(now = NOW, live?: HomeLiveWaitReader): Promise<{ result: SourcePollResult; drafts: ItemDraft[] }> {
  const source = createMichiSource({ live: live ?? (() => null) });
  const previous = getSnapshots('michi');
  const result = await source.poll({ settings, now, previous });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { result, drafts: source.draft({ observations: result.observations, previous, settings, now }) };
}

const byNode = (drafts: ItemDraft[]) => new Map(drafts.map((draft) => [draft.itemKey.replace(/^michi:node:/, ''), draft]));

describe('Companion Michi source', () => {
  let tmpDir: string;
  let oldCloud: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-michi-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    oldCloud = process.env.MICHI_CLOUD;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    const insert = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,settings,created_at,updated_at) VALUES (?,?,?,?,1,1)');
    insert.run('ws', 'sample-project', null, null);
    insert.run('ws-off', 'Private', null, JSON.stringify({ aiGlobalContext: false }));
    insert.run('ws-sys', 'Assistant', null, JSON.stringify({ system: 'assistant' }));
    insert.run('ws-x', 'Elsewhere', 'someone-else', null);
  });

  afterEach(() => {
    closeDb();
    if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('reads the conversations of a NULL-owner workspace: waiting, stalled and done, nothing else', async () => {
    const failed = chat({ status: 'error', error: 'Kiro exited with code 1\nstack…', startedAt: NOW - 2 * HOUR });
    const asked = chat({ status: 'completed', reply: 'I fixed the parser. Should I also update the docs?', startedAt: NOW - 90 * MINUTE });
    const approval = chat({ status: 'active', startedAt: NOW - 30 * MINUTE });
    const running = chat({ status: 'active', startedAt: NOW - 20 * MINUTE });
    const done = chat({ status: 'completed', reply: 'All tests pass now.\n\nDetails…', startedAt: NOW - 50 * MINUTE });
    const seenDone = chat({ status: 'completed', reply: 'Done', startedAt: NOW - 40 * MINUTE });
    viewed(seenDone, NOW - 10 * MINUTE);
    const oldDone = chat({ status: 'completed', reply: 'Long ago', startedAt: NOW - 4 * DAY });
    const stalled = chat({ status: 'error', error: 'boom', startedAt: NOW - 4 * DAY - HOUR });
    const abandoned = chat({ status: 'error', error: 'boom', startedAt: NOW - MICHI_ABANDONED_AFTER_MS - DAY });
    const answered = chat({ status: 'completed', reply: 'Ship it?', startedAt: NOW - 3 * HOUR }, { userMessageAt: NOW - HOUR });
    const early = chat({ status: 'completed', stopReason: 'max_tokens', reply: 'Half a', startedAt: NOW - 45 * MINUTE });
    const elsewhere = [
      chat({ status: 'error', error: 'boom' }, { workspaceId: 'ws-off' }),
      chat({ status: 'error', error: 'boom' }, { workspaceId: 'ws-sys' }),
      chat({ status: 'error', error: 'boom' }, { nodeStatus: 'archived' }),
    ];
    const scheduledRun = `c${++n}`;
    seedConversation({ nodeId: scheduledRun, workspaceId: 'ws', turns: [{ status: 'error', error: 'boom', startedAt: NOW - HOUR, scheduledJobId: 'job-1' }] });
    const live: HomeLiveWaitReader = (nodeId) => (nodeId === approval ? { kind: 'approval', text: 'Run   npm test\nin backend' } : null);

    const { result, drafts } = await poll(NOW, live);
    assert.equal(result.complete, true);
    const items = byNode(drafts);
    assert.deepEqual([...items.keys()].sort(), [approval, asked, done, early, failed, stalled].sort());
    for (const id of [running, seenDone, oldDone, abandoned, answered, scheduledRun, ...elsewhere]) assert.equal(items.has(id), false, id);

    assert.deepEqual(
      [items.get(failed)!.subtype, items.get(failed)!.bucket, items.get(failed)!.severity, items.get(failed)!.summary],
      ['michi_waiting', 'needs_you', 'digest', 'Failed: Kiro exited with code 1'],
      'michi_waiting is digest: Michi notified the approval or question itself',
    );
    assert.equal(items.get(asked)!.summary, 'Asked: Should I also update the docs?');
    assert.equal(items.get(approval)!.summary, 'Waiting for your approval: Run npm test in backend');
    assert.deepEqual([items.get(done)!.subtype, items.get(done)!.bucket, items.get(done)!.summary], ['michi_done', 'update', 'All tests pass now.']);
    assert.equal(items.get(early)!.summary, 'Stopped early: it reached its output limit');
    assert.deepEqual([items.get(stalled)!.subtype, items.get(stalled)!.bucket], ['michi_stalled', 'stalled']);
    assert.match(items.get(stalled)!.summary ?? '', /^Waiting on you for 4 days · Failed: boom$/);
    assert.deepEqual(items.get(done)!.target, { kind: 'node', workspaceId: 'ws', nodeId: done });
    assert.equal(items.get(failed)!.itemKey, `michi:node:${failed}`);

    const list = result.observations.find((observation) => observation.objectKey === 'michi:list');
    assert.ok(list, 'every poll carries its list object, so a feed that empties is not a suspect drop');
    assert.equal(list.state.waiting, 3);
    assert.equal(drafts.some((draft) => draft.itemKey === 'michi:list'), false);
  });

  test('versions hold while the state holds; entering stalled is a new version; the age is a display field', async () => {
    const failed = chat({ status: 'error', error: 'boom', startedAt: NOW - 2 * HOUR });
    const done = chat({ status: 'completed', reply: 'Finished', startedAt: NOW - HOUR });
    const first = byNode((await poll(NOW)).drafts);
    const again = byNode((await poll(NOW + 10 * MINUTE)).drafts);
    assert.equal(again.get(failed)!.version, first.get(failed)!.version);
    assert.equal(again.get(done)!.version, first.get(done)!.version);

    const later = byNode((await poll(NOW + 3 * DAY)).drafts);
    assert.equal(later.get(failed)!.subtype, 'michi_stalled');
    assert.notEqual(later.get(failed)!.version, first.get(failed)!.version, 'stalled is news (R2.8)');
    assert.equal(later.has(done), false, 'done only for three days unless opened');
    const day4 = byNode((await poll(NOW + 4 * DAY)).drafts);
    assert.equal(day4.get(failed)!.version, later.get(failed)!.version);
    assert.notEqual(day4.get(failed)!.summary, later.get(failed)!.summary);
  });

  test('a done conversation the Companion delegated is the worker report\'s, not the feed\'s', async () => {
    const worker = chat({ status: 'completed', reply: 'Here is the fix.', startedAt: NOW - HOUR });
    recordDelegation({ workspaceId: 'ws', nodeId: worker, title: 'Fix it', now: NOW - 2 * HOUR });
    let drafts = byNode((await poll(NOW)).drafts);
    assert.equal(drafts.has(worker), false, 'while the delegation is open');
    markDelegationReported(worker, `${worker}-t0-a`, NOW);
    closeDelegation(worker, NOW);
    drafts = byNode((await poll(NOW + MINUTE)).drafts);
    assert.equal(drafts.has(worker), false, 'the reply it reported');

    const other = chat({ status: 'completed', reply: 'Done too', startedAt: NOW - HOUR });
    recordDelegation({ workspaceId: 'ws', nodeId: other, title: 'Other', now: NOW - 2 * HOUR });
    closeDelegation(other, NOW);
    assert.equal(byNode((await poll(NOW + 2 * MINUTE)).drafts).get(other)?.subtype, 'michi_done', 'closed without a report: the user\'s again');
  });

  test('a delegation the MVP left (closed by 0082, never by the MVP) no longer hides its reply (DESIGN-v2 §4)', async () => {
    const left = chat({ status: 'completed', reply: 'Old work done', startedAt: NOW - HOUR });
    getDb().prepare(`INSERT INTO companion_delegations (id, owner_user_id, workspace_id, node_id, title, created_at)
      VALUES ('cmd-mvp', 'local-user', 'ws', ?, 'Old work', ?)`).run(left, NOW - 2 * HOUR);
    assert.equal(byNode((await poll(NOW)).drafts).get(left)?.subtype, 'michi_done', 'no worker report covers it');
  });

  test('the user took over only by writing themselves: the agent\'s follow-ups and its thread messages never count (DESIGN-v2 §4)', () => {
    getDb().prepare(`INSERT INTO workspaces (id, name, settings, created_at, updated_at) VALUES ('ws-agent', 'Michi', ?, 1, 1)`)
      .run(JSON.stringify({ system: 'assistant' }));
    getDb().prepare(`INSERT INTO nodes (id, workspace_id, kind, title, status, created_at) VALUES ('n-v', 'ws-agent', 'chat', 'V', 'idle', 1)`).run();
    const worker = chat({ status: 'completed', reply: 'Done', startedAt: NOW - HOUR });
    const message = getDb().prepare('INSERT INTO messages (id, node_id, role, content, metadata, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    message.run('m-send', worker, 'user', 'Follow-up', JSON.stringify({ threadMessage: { fromNodeId: 'n-v' }, companionSend: { runId: 'cmr-1', via: 'card' } }), 10, NOW);
    message.run('m-mvp', worker, 'user', 'From the assistant', JSON.stringify({ threadMessage: { fromNodeId: 'n-v' } }), 11, NOW);
    message.run('m-job', worker, 'user', 'Not JSON', '{', 12, NOW);
    const source = createMichiSource({ live: () => null });
    assert.equal(source.workerStates([worker]).get(worker)!.userTookOver, true, 'a message Michi cannot read counts as the user\'s');
    getDb().prepare("DELETE FROM messages WHERE id = 'm-job'").run();
    assert.equal(source.workerStates([worker]).get(worker)!.userTookOver, false, 'the brief and the agent\'s own messages');
    message.run('m-peer', worker, 'user', 'From a peer thread', JSON.stringify({ threadMessage: { fromNodeId: 'c-peer' } }), 13, NOW);
    assert.equal(source.workerStates([worker]).get(worker)!.userTookOver, true, 'a thread the user runs is the user\'s doing');
  });

  test('a scheduled job whose latest finished run failed waits on the user until a run succeeds', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO scheduled_jobs (id, owner_user_id, workspace_id, name, prompt, schedule, created_at, updated_at)
      VALUES (?, NULL, 'ws', ?, 'p', '{"kind":"every","minutes":60}', 1, 1)`).run('job-1', 'Nightly report');
    db.prepare(`INSERT INTO scheduled_jobs (id, owner_user_id, workspace_id, name, prompt, schedule, created_at, updated_at, execution_kind)
      VALUES ('job-m', NULL, 'ws', 'Maintenance', 'p', '{"kind":"every","minutes":60}', 1, 1, 'maintenance')`).run();
    const run = db.prepare(`INSERT INTO scheduled_job_runs (id, job_id, workspace_id, trigger, status, started_at, finished_at, error, claimed_by)
      VALUES (?, ?, 'ws', 'scheduled', ?, ?, ?, ?, 'test')`);
    run.run('run-1', 'job-1', 'succeeded', NOW - 3 * HOUR, NOW - 3 * HOUR + 1, null);
    run.run('run-2', 'job-1', 'timed_out', NOW - 2 * HOUR, NOW - 2 * HOUR + 1, 'Timed out after 30 min\nmore');
    run.run('run-3', 'job-1', 'running', NOW - MINUTE, null, null);
    run.run('run-m', 'job-m', 'failed', NOW - HOUR, NOW - HOUR + 1, 'boom');

    let job = (await poll(NOW)).drafts.find((draft) => draft.itemKey.startsWith('michi:job:'));
    assert.ok(job);
    assert.deepEqual([job.itemKey, job.subtype, job.bucket, job.severity, job.version, job.title, job.summary],
      ['michi:job:job-1', 'michi_scheduled_failed', 'needs_you', 'digest', 'run-2', 'Scheduled job "Nightly report" timed out', 'Timed out after 30 min']);
    assert.equal((await poll(NOW)).drafts.filter((draft) => draft.itemKey.startsWith('michi:job:')).length, 1, 'never the Meta agent\'s maintenance');

    db.prepare(`UPDATE scheduled_job_runs SET status = 'succeeded', finished_at = ? WHERE id = 'run-3'`).run(NOW);
    job = (await poll(NOW + MINUTE)).drafts.find((draft) => draft.itemKey.startsWith('michi:job:'));
    assert.equal(job, undefined);
  });

  test('a whole poll stores as a baseline first, then as news; an emptied feed resolves after two polls', async () => {
    const failed = chat({ status: 'error', error: 'boom', startedAt: NOW - HOUR });
    const source = createMichiSource({ live: () => null });
    const store = async (now: number) => {
      const previous = getSnapshots('michi');
      const result = await source.poll({ settings, now, previous });
      return applySourcePoll({ source: 'michi', result, drafts: source.draft({ observations: result.observations, previous, settings, now }), now });
    };
    assert.equal((await store(NOW)).baseline, true);
    assert.equal(getItemByKey(`michi:node:${failed}`)?.status, 'seen', 'what was there before is not news');
    const fresh = chat({ status: 'completed', reply: 'Which one?', startedAt: NOW });
    await store(NOW + MINUTE);
    assert.equal(getItemByKey(`michi:node:${fresh}`)?.status, 'new');

    // The user answers both: the feed empties, which is no suspect drop thanks to the list object.
    getDb().prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES ('later-1',?,'user','ok',99,?)").run(failed, NOW + 2 * MINUTE);
    getDb().prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES ('later-2',?,'user','ok',99,?)").run(fresh, NOW + 2 * MINUTE);
    assert.equal((await store(NOW + 3 * MINUTE)).outcome, 'applied');
    assert.equal(getItemByKey(`michi:node:${failed}`)?.status, 'seen', 'one absence only counts');
    assert.equal((await store(NOW + 4 * MINUTE)).resolved.length, 2);
    assert.equal(getItemByKey(`michi:node:${fresh}`)?.status, 'resolved');
  });

  test('focus: what the user wrote in during the last three hours, newest first, with its state', () => {
    const live: HomeLiveWaitReader = (nodeId) => (nodeId === 'c-waiting' ? { kind: 'question', text: 'Which?' } : null);
    chat({ status: 'active', startedAt: NOW - 10 * MINUTE }, { nodeId: 'c-running', title: 'Refactor' });
    chat({ status: 'active', startedAt: NOW - 20 * MINUTE }, { nodeId: 'c-waiting', title: 'Plan' });
    chat({ status: 'completed', reply: 'ok', startedAt: NOW - 30 * MINUTE }, { nodeId: 'c-idle', title: 'Notes' });
    chat({ status: 'completed', reply: 'ok', startedAt: NOW - 4 * HOUR }, { nodeId: 'c-old', title: 'Old' });
    chat({ status: 'completed', reply: 'ok', startedAt: NOW - 5 * MINUTE }, { nodeId: 'c-private', workspaceId: 'ws-off' });
    const focus = createMichiSource({ live }).focusSnapshot(NOW);
    assert.deepEqual(focus.map((entry) => [entry.nodeId, entry.state, entry.title, entry.workspaceName]), [
      ['c-running', 'running', 'Refactor', 'sample-project'],
      ['c-waiting', 'waiting', 'Plan', 'sample-project'],
      ['c-idle', 'idle', 'Notes', 'sample-project'],
    ]);
  });

  test('a temporary chat is never an item nor in focus, whatever its state', async () => {
    const failed = chat({ status: 'error', error: 'secret failure', startedAt: NOW - 2 * HOUR }, { title: 'Secret plan' });
    const asked = chat({ status: 'completed', reply: 'Should I send it?', startedAt: NOW - 10 * MINUTE });
    const ordinary = chat({ status: 'error', error: 'boom', startedAt: NOW - HOUR });
    getDb().prepare("UPDATE nodes SET memory_mode = 'off' WHERE id IN (?, ?)").run(failed, asked);
    const { drafts } = await poll();
    assert.deepEqual([...byNode(drafts).keys()], [ordinary]);
    assert.deepEqual(createMichiSource({ live: () => null }).focusSnapshot(NOW).map((entry) => entry.nodeId), [ordinary]);
  });

  test('worker states: the reply, when it ended, whether the user saw it or wrote in it', () => {
    const worker = chat({ status: 'completed', reply: 'Here is the fix.', startedAt: NOW - HOUR }, { title: 'Fix it' });
    const busy = chat({ status: 'active', startedAt: NOW - MINUTE });
    const takenOver = chat({ status: 'completed', reply: 'Done', startedAt: NOW - HOUR }, { userMessageAt: NOW - 30 * MINUTE });
    viewed(worker, NOW - 2 * HOUR);
    const states = createMichiSource().workerStates([worker, busy, takenOver, 'missing']);
    const state = states.get(worker)!;
    assert.deepEqual([state.exists, state.turnStatus, state.messageId, state.endedAt, state.reply, state.viewedAt, state.userTookOver, state.title],
      [true, 'completed', `${worker}-t0-a`, NOW - HOUR + 10, 'Here is the fix.', NOW - 2 * HOUR, false, 'Fix it']);
    assert.equal(states.get(busy)!.endedAt, null);
    assert.equal(states.get(takenOver)!.userTookOver, true);
    assert.equal(states.has('missing'), false);
  });

  test('a Michi source turned off reports disabled and observes nothing', async () => {
    const off = structuredClone(settings);
    off.sources.michi.enabled = false;
    const result = await createMichiSource().poll({ settings: off, now: NOW, previous: new Map() });
    assert.deepEqual([result.ok, result.error, result.observations.length], [false, 'disabled', 0]);
  });
});
