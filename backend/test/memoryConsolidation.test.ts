// Must stay first: agentConfig would otherwise persist settings to ~/.michi/config.json.
import './isolatedConfigDir';
// Consolidation (services/memory/consolidation.ts, spec round 10 §C): when a
// run is due, what a batch lists, what an answer may say, the commit's
// checks, that the user sees nothing, the 7-day retention and the revert.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryChangedEvent, MemoryRecord } from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { setAiGlobalContext } from '../src/services/dbRepository';
import {
  buildConsolidationPrompt, codeTokens, commitConsolidation, consolidationDue, consolidationListing, ConsolidationPayloadError,
  containmentGaps, digitRuns, listedConsolidationBatch, nextConsolidationBatch, parseConsolidationListing, readConsolidationState, revertConsolidation,
  validateConsolidationPayload, type ConsolidationBatch, type ConsolidationHolds, type ConsolidationNote,
} from '../src/services/memory/consolidation';
import { CONSOLIDATION_INSTRUCTIONS, CONSOLIDATION_LIMITS } from '../src/services/memory/consolidationPolicy';
import { finishExtractionRun, getExtractionRun, insertExtractionRun, setExtractionPaused } from '../src/services/memory/extractionRepository';
import {
  consolidationHolds, designatedConsolidationJob, markExtractionBoot, memoryExtractionHasWork, planMemoryExtractionRun, settleMemoryExtractionRun,
} from '../src/services/memory/extractionRun';
import { installMemoryExtractionHooks, memoryExtractionStatus, type MemoryExtractionScheduler } from '../src/services/memory/extractionService';
import { stageMemoryAnswer } from '../src/services/memory/extractionTools';
import { activeMichiNoteCount, consolidationRows, storedMemories } from '../src/services/memory/memoryRepository';
import { memoryRef } from '../src/services/memory/memoryRefs';
import {
  createMemory, memoryEvents, setConversationMemoryMode, setMemorySettings, supersedeMemory, updateMemory, type CreateMemoryInput,
} from '../src/services/memory/memoryService';
import { indexTurn } from '../src/services/memory/recallIndex';
import { recordTypedText, releaseTypedText } from '../src/services/memory/typedText';
import { commitProfilePayload, readUserProfile } from '../src/services/memory/userProfile';
import { pauseMichi, resumeMichi } from '../src/services/michiPause';
import { turnBackgroundWorkOn } from './helpers/backgroundWork';

const ME = LOCAL_AGENT_OWNER_ID;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Monday 2026-11-09, 10:00 local time. */
const START = new Date(2026, 10, 9, 10).getTime();
let now = START;
let dataDir: string;
let uninstall: (() => void) | null = null;
let serial = 0;
const saved = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };
const scheduler: MemoryExtractionScheduler = {
  createMaintenanceExecution: () => ({ id: 'unused' }), deleteJob: () => {}, updateJob: () => null, cancelActiveRun: () => false, wakeJobs: () => {},
};

function note(body: string, extra: Partial<CreateMemoryInput> = {}): MemoryRecord {
  serial += 1;
  now += 1_000;
  return createMemory({ ownerUserId: ME }, {
    scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'extracted', observedAt: START - 30 * DAY + serial * MINUTE, ...extra,
  });
}

function refOf(record: { id: string }): string {
  const row = getDb().prepare('SELECT row_id, version FROM memories WHERE id = ?').get(record.id) as { row_id: number; version: number };
  return memoryRef(row.row_id, row.version);
}

function row(id: string) {
  return consolidationRows(ME, [id])[0]!;
}

function holds(extra: Partial<ConsolidationHolds> = {}): ConsolidationHolds {
  return { hold: null, budgetLeft: 1_000_000, minBudget: 20_000, bootAt: null, ...extra };
}

const live = () => true;

function batchNow(): ConsolidationBatch {
  const batch = nextConsolidationBatch(ME, now, live);
  assert.ok(batch, 'a batch waits');
  return batch;
}

/** The cursor moves past everything written so far: the next batch starts with what follows. */
function lookedAtEverything(): void {
  getDb().prepare(`INSERT INTO memory_consolidation_state (owner_user_id, cursor_at, cursor_row, updated_at)
    VALUES (?, ?, (SELECT COALESCE(MAX(row_id), 0) FROM memories), ?)
    ON CONFLICT(owner_user_id) DO UPDATE SET cursor_at = excluded.cursor_at, cursor_row = excluded.cursor_row`).run(ME, now, now);
}

function decide(...decisions: Array<[string, 'keep' | 'duplicate' | 'outdated', string | null]>) {
  return { decisions: decisions.map(([ref, op, into]) => ({ ref, op, into, why: 'test' })) };
}

/** keep for every group's input, but for the refs given. */
function keepAll(batch: { groups: ConsolidationBatch['groups']; notes: ConsolidationBatch['notes'] }, ...except: string[]): Array<[string, 'keep', null]> {
  return batch.groups.map((group) => batch.notes.get(group.members[0])!.ref).filter((ref) => !except.includes(ref))
    .map((ref) => [ref, 'keep', null]);
}

/** The batch a recorded run listed. */
function batchFor(id: string) {
  return listedConsolidationBatch(ME, parseConsolidationListing(getExtractionRun(id, ME)!.related));
}

function problems(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConsolidationPayloadError, String(error));
    return error.message;
  }
  assert.fail('the answer was accepted');
}

function commit(batch: ConsolidationBatch, raw: unknown, runId = 'mcr-test') {
  const payload = validateConsolidationPayload(raw, batch, { activeMichiNotes: activeMichiNoteCount(ME) });
  return commitConsolidation(payload, { ownerUserId: ME, runId, batch, liveWorkspace: live, now });
}

/** An extraction consumer with its scheduler job, as sweepMemoryExtraction leaves it. */
function consumer(workspaceId: string, jobId: string, createdAt = START - DAY): void {
  getDb().prepare(`INSERT INTO scheduled_jobs (id, owner_user_id, workspace_id, name, prompt, schedule, execution_kind, created_at, updated_at)
    VALUES (?, ?, ?, 'Automatic memory', 'x', '{"kind":"every","everySeconds":60}', 'maintenance', ?, ?)`).run(jobId, ME, workspaceId, createdAt, createdAt);
  getDb().prepare(`INSERT INTO memory_extraction_cursors (workspace_id, owner_user_id, job_id, completion_cursor, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(workspace_id, owner_user_id) DO UPDATE SET job_id = excluded.job_id, created_at = excluded.created_at`)
    .run(workspaceId, ME, jobId, createdAt, createdAt);
}

let runSerial = 0;
/** A scheduler run of the job this process owns (what ownsSchedulerRun checks). */
function schedulerRun(jobId: string, workspaceId = 'ws'): string {
  const runId = `run-${++runSerial}`;
  getDb().prepare(`INSERT INTO scheduled_job_runs (id, job_id, workspace_id, trigger, status, started_at, claimed_by)
    VALUES (?, ?, ?, 'scheduled', 'running', ?, 'test')`).run(runId, jobId, workspaceId, now);
  getDb().prepare(`INSERT INTO scheduler_lease (id, holder, expires_at, generation) VALUES (1, 'test', ?, 1)
    ON CONFLICT(id) DO UPDATE SET holder = 'test', expires_at = excluded.expires_at, generation = 1`).run(now + DAY);
  getDb().prepare(`INSERT INTO scheduler_execution_claims (run_id, job_id, holder, generation, acquired_at, workspace_id)
    VALUES (?, ?, 'test', 1, ?, ?)`).run(runId, jobId, now, workspaceId);
  return runId;
}

function endSchedulerRun(runId: string): void {
  getDb().prepare("UPDATE scheduled_job_runs SET status = 'succeeded', finished_at = ? WHERE id = ?").run(now, runId);
}

/** Plans one execution of the job with a direct call; the plan is consolidation's when nothing else is due. */
function plan(jobId: string, workspaceId = 'ws') {
  const runId = schedulerRun(jobId, workspaceId);
  const planned = planMemoryExtractionRun({ jobId, workspaceId, ownerUserId: ME, runId, now, direct: true });
  return { runId, planned };
}

function settle(id: string, status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' = 'succeeded') {
  return settleMemoryExtractionRun({ id, ownerUserId: ME, status, error: status === 'succeeded' ? null : 'stopped', turnId: null,
    reportedTokens: 4_000, claimedBy: 'test', now });
}

function events(): MemoryChangedEvent[] {
  const seen: MemoryChangedEvent[] = [];
  memoryEvents.on('changed', (event) => seen.push(event));
  return seen;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-consolidation-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  turnBackgroundWorkOn();
  now = START;
  serial = 0;
  mock.method(Date, 'now', () => now);
  getDb().prepare(`INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'Michi', 1, 1), ('ws2', 'Home', 1, 1)`).run();
  uninstall = installMemoryExtractionHooks();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  memoryEvents.removeAllListeners('changed');
  markExtractionBoot(null);
  mock.restoreAll();
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  if (saved.data === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.data;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('when it runs', () => {
  test('due after 10 idle minutes, or once 8 memories wait, or once the oldest waited 2 hours', () => {
    lookedAtEverything();
    const idleFloor = holds({ bootAt: now });
    note('The user lives in Meguro, Tokyo.');
    assert.equal(consolidationDue(ME, now, idleFloor), false, 'one waits, and the user was active a moment ago');
    assert.equal(consolidationDue(ME, now + CONSOLIDATION_LIMITS.idleMs, idleFloor), true, 'idle 10 minutes');
    // Typing counts as activity, whenever the process started.
    recordTypedText('n-chat', 't-1', 'hello');
    releaseTypedText('n-chat', 't-1');
    assert.equal(consolidationDue(ME, now + 5 * MINUTE, holds({ bootAt: START - DAY })), false);
    for (let i = 0; i < 7; i += 1) note(`Note ${i} about the user's week.`);
    assert.equal(consolidationDue(ME, now, idleFloor), true, '8 wait');
    lookedAtEverything();
    const old = note('The user plays the cello.');
    assert.equal(consolidationDue(ME, old.updatedAt + 1, holds({ bootAt: old.updatedAt })), false);
    assert.equal(consolidationDue(ME, old.updatedAt + CONSOLIDATION_LIMITS.oldestWaitingMs, holds({ bootAt: old.updatedAt + CONSOLIDATION_LIMITS.oldestWaitingMs })), true,
      'the oldest waited 2 hours');
    lookedAtEverything();
    assert.equal(consolidationDue(ME, now + DAY, holds()), false, 'nothing waits');
  });

  test('never while anything holds it: memory off, paused, the cloud, the budget, its own limits, a live or recent run, a backoff, a turn; the Meta agent pause does not', () => {
    note('The user lives in Meguro, Tokyo.');
    assert.equal(consolidationDue(ME, now, consolidationHolds(ME, now)), true);
    setMemorySettings(ME, { mode: 'off' });
    assert.equal(consolidationDue(ME, now, consolidationHolds(ME, now)), false, 'memory off');
    setMemorySettings(ME, { mode: 'auto' });
    setExtractionPaused(ME, true, now);
    assert.equal(consolidationDue(ME, now, consolidationHolds(ME, now)), false, 'automatic memory paused');
    setExtractionPaused(ME, false, now);
    pauseMichi(ME, null);
    assert.equal(consolidationDue(ME, now, consolidationHolds(ME, now)), true, 'the Meta agent pause is not memory\'s');
    resumeMichi(ME);
    process.env.MICHI_CLOUD = '1';
    assert.equal(consolidationDue(ME, now, consolidationHolds(ME, now)), false, 'cloud');
    delete process.env.MICHI_CLOUD;
    assert.equal(consolidationDue(ME, now, holds({ budgetLeft: 10_000 })), false, 'the shared daily limit');
    assert.equal(consolidationDue(ME, now, holds()), true);

    consumer('ws', 'job-a');
    const runRow = (id: string, startedAt: number, state: 'active' | 'failed' | 'succeeded' | 'cancelled', tokens = 0, runId = 'old-run') => {
      insertExtractionRun({ id, kind: 'consolidate', ownerUserId: ME, workspaceId: 'ws', jobId: 'job-a', runId, configRevision: 1, after: 0, through: 0,
        memoryVersion: 0, tombstoneMark: 0, tokenBudget: 40_000, estimatedTokens: tokens, now: startedAt, sources: [], related: [] });
      if (state !== 'active') finishExtractionRun({ id, state, summary: null, error: null, reportedTokens: tokens, now: startedAt + 1_000 });
    };
    runRow('mcr-tokens', now - 3 * HOUR, 'succeeded', CONSOLIDATION_LIMITS.dailyTokens);
    assert.equal(consolidationDue(ME, now, holds()), false, '250k consolidation tokens today');
    getDb().prepare('DELETE FROM memory_extraction_runs').run();
    const insert = getDb().prepare(`INSERT INTO memory_consolidation_log (run_id, memory_id, owner_user_id, role, listed_version, decision, into_id, outcome, created_at)
      VALUES ('mcr-x', ?, ?, 'input', 1, 'duplicate', 'mem-y', 'applied', ?)`);
    for (let i = 0; i < CONSOLIDATION_LIMITS.changesPerDay; i += 1) insert.run(`mem-${i}`, ME, now - HOUR);
    assert.equal(consolidationDue(ME, now, holds()), false, '60 changes today');
    getDb().prepare('DELETE FROM memory_consolidation_log').run();
    const running = schedulerRun('job-a');
    runRow('mcr-live', now - MINUTE, 'active', 0, running);
    assert.equal(consolidationDue(ME, now + HOUR, holds()), false, 'a live run');
    getDb().prepare('DELETE FROM memory_extraction_runs').run();
    runRow('mcr-recent', now - 10 * MINUTE, 'succeeded');
    assert.equal(consolidationDue(ME, now, holds()), false, '30-minute spacing');
    assert.equal(consolidationDue(ME, now + 21 * MINUTE, holds()), true);
    getDb().prepare('DELETE FROM memory_extraction_runs').run();
    runRow('mcr-f1', now - 3 * HOUR, 'failed');
    runRow('mcr-f2', now - 2 * HOUR, 'failed');
    runRow('mcr-c', now - 90 * MINUTE, 'cancelled');
    runRow('mcr-f3', now - HOUR, 'failed');
    assert.equal(consolidationDue(ME, now, holds()), false, 'three failures in a row, the newest an hour ago (a cancelled run does not count)');
    assert.equal(consolidationDue(ME, now + 5 * HOUR + MINUTE, holds()), true, 'six hours after the newest');
    getDb().prepare('DELETE FROM memory_extraction_runs').run();
    recordTypedText('n-chat', 't-running', 'write me a poem');
    assert.equal(consolidationDue(ME, now, holds()), false, 'a turn a person typed is running');
    releaseTypedText('n-chat', 't-running');
    assert.equal(consolidationDue(ME, now + CONSOLIDATION_LIMITS.idleMs, holds()), true);
  });

  test('only the owner\'s designated job (its earliest consumer that may run) plans it', () => {
    consumer('ws', 'job-a', START - 2 * DAY);
    consumer('ws2', 'job-b', START - DAY);
    note('The user lives in Meguro, Tokyo.');
    assert.equal(designatedConsolidationJob(ME, now), 'job-a');
    assert.equal(memoryExtractionHasWork({ jobId: 'job-a', workspaceId: 'ws', ownerUserId: ME }, now, true), true);
    assert.equal(memoryExtractionHasWork({ jobId: 'job-b', workspaceId: 'ws2', ownerUserId: ME }, now, true), false);
    // A consumer paused on its own workspace hands it to the next.
    getDb().prepare("UPDATE memory_extraction_cursors SET paused = 1 WHERE job_id = 'job-a'").run();
    assert.equal(designatedConsolidationJob(ME, now), 'job-b');
    // AI navigation off still serves it: it reads memories, not conversations.
    getDb().prepare("UPDATE memory_extraction_cursors SET paused = 0 WHERE job_id = 'job-a'").run();
    setAiGlobalContext('ws', false);
    assert.equal(designatedConsolidationJob(ME, now), 'job-a');
  });
});

describe('the batch', () => {
  test('neighbours: the same source turn, the same body, and recall\'s search; a zh↔en pair through keywords', () => {
    lookedAtEverything();
    const agentSave = note('The user prefers dark mode in every editor.', { kind: 'preference', source: { nodeId: 'n-1', turnId: 't-1' } });
    const extractorSave = note('用户在所有编辑器里都用深色模式', { kind: 'preference', keywords: ['dark mode', '深色模式', 'editor'], source: { nodeId: 'n-1', turnId: 't-1' } });
    const sameBody = note('Deploys go out on Fridays', { scope: { kind: 'workspace', workspaceId: 'ws' }, kind: 'convention' });
    const sameBodyAgain = note('deploys go out on fridays.', { scope: { kind: 'workspace', workspaceId: 'ws' }, kind: 'convention' });
    const nakano = note('用户搬到了东京中野', { keywords: ['Nakano', '中野', 'Tokyo', 'moved'] });
    const english = note('The user lives in Nakano, Tokyo.', { origin: 'explicit' });
    const batch = batchNow();
    const groupOf = (record: MemoryRecord) => batch.groups.find((group) => group.members[0] === record.id)?.members ?? [];
    assert.ok(groupOf(agentSave).includes(extractorSave.id), 'the agent-plus-extractor double save');
    assert.ok(groupOf(sameBody).includes(sameBodyAgain.id), 'the same body once normalized');
    assert.ok(groupOf(nakano).includes(english.id), 'Chinese to English through the keywords');
    // The explicit note is the user's own: listed only as what a Michi note goes into.
    assert.equal(batch.notes.get(english.id)!.who, 'user');
    assert.equal(batch.notes.get(english.id)!.changeable, false);
  });

  test('untrusted, non-live and navigation-off memories are left out; protected notes only pair with a Michi note', () => {
    lookedAtEverything();
    note('The user likes the café on Rue Cler.', { sourceRisk: 'untrusted', source: { nodeId: 'n-web', turnId: 't-web' } });
    const archived = note('Ship builds with pnpm.', { scope: { kind: 'workspace', workspaceId: 'ws2' }, kind: 'convention' });
    note('Ship builds with pnpm', { scope: { kind: 'workspace', workspaceId: 'ws2' }, kind: 'convention' });
    const mine = note('Answer in Chinese.', { origin: 'explicit', kind: 'preference' });
    note('Answer in Chinese', { origin: 'explicit', kind: 'preference' });
    getDb().prepare('UPDATE workspaces SET archived_at = 1 WHERE id = ?').run('ws2');
    const liveOnly = (id: string) => id !== 'ws2';
    const batch = nextConsolidationBatch(ME, now, liveOnly)!;
    assert.equal(batch.groups.length, 0, 'nothing pairs: the untrusted note is not listed, ws2 is not live, two of the user\'s own never pair');
    assert.ok(batch.inputs.includes(archived.id) && batch.inputs.includes(mine.id), 'they are inputs all the same (the cursor passes them)');
    assert.ok(![...batch.notes.values()].some((listed) => listed.body.includes('Rue Cler')));
  });

  test('a no-pair range moves the cursor at once, with no run and no model call', () => {
    consumer('ws', 'job-a');
    note('Cello lessons every Tuesday.');
    note('Mochi is a tabby.');
    const before = readConsolidationState(ME).cursor;
    const { planned } = plan('job-a');
    assert.equal(planned.kind, 'skip');
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM memory_extraction_runs WHERE kind = 'consolidate'").get()!.n, 0);
    const after = readConsolidationState(ME).cursor;
    assert.ok(after.row > before.row, 'the cursor passed them');
    assert.equal(consolidationDue(ME, now + DAY, holds()), false);
  });

  test('groups stop at the listing caps; the inputs after the cut wait for the next run', () => {
    lookedAtEverything();
    // 300 CJK characters are 300 tokens: about 13 bodies fit the 4,000-token listing.
    const long = '长'.repeat(300);
    for (let i = 0; i < 12; i += 1) note(`${long} alpha${i}`, { keywords: [`alpha${i}`] });
    lookedAtEverything();
    for (let i = 0; i < 12; i += 1) note(`${long} alpha${i}.`, { keywords: [`alpha${i}`] });
    const batch = batchNow();
    const lines = batch.groups.reduce((sum, group) => sum + group.members.length, 0);
    assert.ok(lines <= CONSOLIDATION_LIMITS.listedNotes, `${lines} lines`);
    assert.ok(batch.groups.length > 0 && batch.groups.length < 12, `${batch.groups.length} groups`);
    assert.equal(batch.inputs.length, batch.groups.length, 'the run ends where the caps cut');
    commit(batch, decide(...keepAll(batch)));
    const next = nextConsolidationBatch(ME, now, live)!;
    assert.ok(next && !batch.inputs.includes(next.inputs[0]!), 'the next run starts after the cut');
  });

  test('the prompt renders refs, who, area, kind, dates and keywords', () => {
    const notes = new Map<string, ConsolidationNote>();
    const add = (memoryId: string, fields: Partial<ConsolidationNote>) => notes.set(memoryId, {
      ref: '', memoryId, rowId: 1, version: 1, who: 'michi', changeable: true, workspaceId: null, kind: 'fact', body: '', keywords: [],
      said: 0, eventAt: null, pinnable: false, sourceTurnId: null, updatedAt: 0, ...fields,
    });
    add('a', { ref: 'm:1kv2', workspaceId: 'ws', kind: 'convention', said: new Date(2026, 10, 8, 9).getTime(),
      body: '这个仓库用 pnpm，不用 npm', keywords: ['pnpm', 'package manager', '包管理器'] });
    add('b', { ref: 'm:9av1', who: 'user', workspaceId: 'ws', kind: 'convention', said: new Date(2026, 9, 2, 9).getTime(), body: 'This repo uses pnpm, never npm.' });
    add('c', { ref: 'm:1kz0v1', said: new Date(2026, 10, 1, 9).getTime(), body: 'User moved to Nakano, Tokyo.' });
    add('d', { ref: 'm:7b2v3', said: new Date(2026, 8, 2, 9).getTime(), body: 'User lives in Meguro, Tokyo.', eventAt: new Date(2026, 8, 1).getTime() });
    const batch: ConsolidationBatch = {
      ownerUserId: ME, notes, inputs: ['a', 'c'], areaNames: new Map([['ws', 'Michi']]), through: { at: 0, row: 0 },
      groups: [{ index: 1, members: ['a', 'b'] }, { index: 2, members: ['c', 'd'] }],
    };
    assert.equal(buildConsolidationPrompt(batch, START), [
      'Michi Memory tidy · today 2026-11-09 (Monday)',
      'Areas: everywhere = all the user\'s work · "Michi" = a project',
      'Line: [ref] who · area · kind · said YYYY-MM-DD[ · event YYYY-MM-DD]: text[ · keywords: k1, k2]',
      '',
      'Group 1',
      '> [m:1kv2] michi · "Michi" · convention · said 2026-11-08: 这个仓库用 pnpm，不用 npm · keywords: pnpm, package manager, 包管理器',
      '- [m:9av1] user · "Michi" · convention · said 2026-10-02: This repo uses pnpm, never npm.',
      '',
      'Group 2',
      '> [m:1kz0v1] michi · everywhere · fact · said 2026-11-01: User moved to Nakano, Tokyo.',
      '- [m:7b2v3] michi · everywhere · fact · said 2026-09-02 · event 2026-09-01: User lives in Meguro, Tokyo.',
      '',
      'Reply with the JSON object only.',
    ].join('\n'));
    assert.match(buildConsolidationPrompt(batch, START, 'memory_consolidate'), /Call memory_consolidate once with the decisions, then stop\.$/u);
    assert.match(CONSOLIDATION_INSTRUCTIONS(null), /^You tidy Michi Memory/u);
    assert.match(CONSOLIDATION_INSTRUCTIONS(null), /Reply with only one JSON object/u);
    assert.match(CONSOLIDATION_INSTRUCTIONS('memory_consolidate'), /Call memory_consolidate exactly once with \{ decisions \}/u);
  });
});

describe('the answer', () => {
  test('digit runs and code tokens: what a duplicate\'s into must hold', () => {
    assert.deepEqual([...digitRuns('2026-07-10, ver 07')].sort(), ['10', '2026', '7']);
    assert.deepEqual([...digitRuns('７月10日')].sort(), ['10', '7']);
    assert.deepEqual([...codeTokens('Use v22 on us-east-1; see src/app.ts or mail a@b.com, https://x.dev/a?b=1.')].sort(),
      ['a@b.com', 'https://x.dev/a?b=1', 'src/app.ts', 'us-east-1', 'v22']);
    assert.deepEqual([...codeTokens('用户用 pnpm@9 管理依赖，住在3号楼')].sort(), ['3', 'pnpm@9']);
    assert.deepEqual(containmentGaps({ body: 'Trip on 7月10日' }, { body: 'The trip is on 2026-07-10', keywords: [] }), []);
    assert.deepEqual(containmentGaps({ body: 'Runs Node 22 on us-east-1' }, { body: 'Runs Node on AWS', keywords: ['us-east-1'] }), ['22']);
  });

  test('rules 1-10, each with the message that repairs it', () => {
    const notes = new Map<string, ConsolidationNote>();
    let rowId = 0;
    const add = (memoryId: string, fields: Partial<ConsolidationNote>) => {
      rowId += 1;
      notes.set(memoryId, {
        ref: `m:${rowId.toString(36)}v1`, memoryId, rowId, version: 1, who: 'michi', changeable: true, workspaceId: null, kind: 'fact', body: '',
        keywords: [], said: START - DAY, eventAt: null, pinnable: false, sourceTurnId: null, updatedAt: START, ...fields,
      });
      return notes.get(memoryId)!.ref;
    };
    const n = add('nakano', { body: 'User moved to Nakano, Tokyo.', keywords: ['Meguro', 'Tokyo'] });
    const m = add('meguro', { body: 'User lives in Meguro, Tokyo.', said: START - 60 * DAY });
    const r = add('room', { body: 'The user lives in room 808 in Meguro, Tokyo.', said: START - 90 * DAY });
    const p = add('office', { body: 'The Meguro office builds run on Tokyo servers.', workspaceId: 'ws' });
    const c = add('cat', { body: '用户养了一只叫 Mochi 的猫', keywords: ['cat', 'Mochi', '猫'] });
    const t = add('theirs', { body: 'The user has a cat named Mochi.', who: 'user', changeable: false, pinnable: true });
    const w = add('window', { body: 'The user prefers window seats.', kind: 'preference', pinnable: true });
    const f = add('booked', { body: 'The user booked a window seat to Osaka.' });
    const e = add('trip', { body: 'Trip to Osaka on 7月10日', eventAt: new Date(2026, 6, 10).getTime() });
    const e2 = add('trip2', { body: 'The Osaka trip is on 2026-07-10', eventAt: new Date(2026, 6, 11).getTime() });
    const batch: ConsolidationBatch = {
      ownerUserId: ME, notes, inputs: ['nakano', 'cat', 'window', 'trip'], areaNames: new Map([['ws', 'Michi']]), through: { at: 0, row: 0 },
      groups: [
        { index: 1, members: ['nakano', 'meguro', 'room', 'office'] }, { index: 2, members: ['cat', 'theirs'] },
        { index: 3, members: ['window', 'booked'] }, { index: 4, members: ['trip', 'trip2'] },
      ],
    };
    const keeps = (...except: string[]) => [n, c, w, e].filter((ref) => !except.includes(ref)).map((ref) => [ref, 'keep', null] as [string, 'keep', null]);
    const check = (...decisions: Array<[string, 'keep' | 'duplicate' | 'outdated', string | null]>) =>
      problems(() => validateConsolidationPayload(decide(...decisions), batch, { activeMichiNotes: 100 }));
    // 1. the schema
    assert.match(problems(() => validateConsolidationPayload({ decisions: [{ ref: n, op: 'merge', into: null, why: '' }] }, batch)),
      /decisions\[0\]\.op must be equal to one of the allowed values/u);
    // 2. listed refs, one decision per note, one for every > note
    assert.match(check(...keeps(), ['m:zzzzv1', 'keep', null]), /m:zzzzv1 was not listed in this run/u);
    assert.match(check(...keeps(), [n, 'keep', null]), /has more than one decision/u);
    assert.match(check(...keeps(n)), new RegExp(`${n} \\(a > note\\) has no decision: add one \\(keep when unsure\\)`, 'u'));
    // 3. keep takes no into; a change goes into another note of its group
    assert.match(check(...keeps(n), [n, 'keep', m]), /keep takes "into": null/u);
    assert.match(check(...keeps(c), [c, 'duplicate', c]), /a note does not go into itself/u);
    assert.match(check(...keeps(c), [c, 'duplicate', m]), /is not in a group with/u);
    // 4. the user's own note never changes
    assert.match(check(...keeps(), [t, 'duplicate', c]), new RegExp(`${t} is the user's own: keep it`, 'u'));
    // 5. no chains
    assert.match(check(...keeps(), [r, 'outdated', m], [m, 'outdated', n]), /is changed in this answer too/u);
    // 6. scope: a note about all of the user's work never goes into a project's note
    assert.match(check(...keeps(n), [n, 'duplicate', p]), /is about a project/u);
    assert.match(check(...keeps(), [p, 'outdated', n]), /are not about the same area/u);
    // 7. a pinned preference never goes into an unpinned fact
    assert.match(check(...keeps(w), [w, 'duplicate', f]), /is a standing preference or rule and .* is not/u);
    // 8. a duplicate's into holds its digits, codes and event day
    assert.match(check(...keeps(), [r, 'duplicate', m]), new RegExp(`${m} does not hold "808"; keep it, or choose another note`, 'u'));
    assert.match(check(...keeps(e), [e, 'duplicate', e2]), /is about 2026-07-10 and .* is not about that day/u);
    // 9. outdated: the into was said later
    assert.match(check(...keeps(n), [n, 'outdated', m]), /was not said after/u);
    // A valid answer, in listing order.
    const valid = validateConsolidationPayload(decide(...keeps(c), [m, 'outdated', n], [c, 'duplicate', t]), batch, { activeMichiNotes: 20 });
    assert.deepEqual(valid.decisions.filter((decision) => decision.op !== 'keep').map((decision) => [decision.memoryId, decision.op, decision.intoId]),
      [['meguro', 'outdated', 'nakano'], ['cat', 'duplicate', 'theirs']]);
    // 10. the run's cap (max(4, ⌈20% of Michi's notes⌉), at most 8) and the day's (60)
    assert.match(problems(() => validateConsolidationPayload(decide(...keeps(c), [m, 'outdated', n], [c, 'duplicate', t]), batch,
      { activeMichiNotes: 20, appliedToday: CONSOLIDATION_LIMITS.changesPerDay - 1 })), /this run changes at most 1/u);
  });

  test('the last allowed answer is lenient: a broken decision and a missing one become keep', () => {
    lookedAtEverything();
    const meguro = note('User lives in Meguro, Tokyo.', { observedAt: START - 60 * DAY });
    const nakano = note('User moved to Nakano, Tokyo.', { keywords: ['Meguro', 'Tokyo'], observedAt: START - DAY });
    const batch = batchNow();
    const lenient = validateConsolidationPayload(decide([refOf(nakano), 'outdated', refOf(meguro)]), batch, { strict: false });
    assert.ok(lenient.decisions.every((decision) => decision.op === 'keep'));
    assert.ok(lenient.decisions.some((decision) => decision.memoryId === meguro.id));
    // Schema problems still fail it: that answer is unreadable.
    assert.throws(() => validateConsolidationPayload({ decisions: 'none' }, batch, { strict: false }), ConsolidationPayloadError);
  });
});

describe('the commit', () => {
  test('an applied change: superseded, one version up, linked to its into, which stays exactly as it was; events are superseded only', () => {
    lookedAtEverything();
    const duplicate = note('用户用 pnpm 管理依赖', { keywords: ['pnpm', 'package manager', '包管理器'], kind: 'preference' });
    const theirs = note('The user uses pnpm to manage packages.', { origin: 'explicit', kind: 'preference' });
    const intoBefore = getDb().prepare('SELECT * FROM memories WHERE id = ?').get(theirs.id);
    const batch = batchNow();
    const seen = events();
    const result = commit(batch, decide([refOf(duplicate), 'duplicate', refOf(theirs)], [refOf(theirs), 'keep', null]));
    assert.equal(result.applied.length, 1);
    const stored = row(duplicate.id);
    assert.equal(stored.record.status, 'superseded');
    assert.equal(stored.record.version, duplicate.version + 1);
    assert.equal(stored.mergedIntoId, theirs.id);
    assert.equal(stored.record.body, duplicate.body, 'no text is written');
    assert.deepEqual(getDb().prepare('SELECT * FROM memories WHERE id = ?').get(theirs.id), intoBefore, 'the into is byte-identical');
    assert.deepEqual(seen, [], 'nothing is announced inside the commit');
    const log = (getDb().prepare('SELECT memory_id, role, listed_version, decision, into_id, outcome FROM memory_consolidation_log ORDER BY memory_id').all() as
      Array<Record<string, unknown>>).map((entry) => ({ ...entry }));
    assert.deepEqual(log.find((entry) => entry.memory_id === duplicate.id),
      { memory_id: duplicate.id, role: 'input', listed_version: 1, decision: 'duplicate', into_id: theirs.id, outcome: 'applied' });
    assert.equal(readConsolidationState(ME).cursor.row, batch.through.row, 'the cursor moved past the batch');
  });

  test('each change is checked again: gone, changed, protected, source, area, rule and cap', () => {
    const olders = Array.from({ length: 7 }, (_, i) => note(`The user's locker code is the number ${i + 1} on floor ${i + 1}.`, { keywords: [`locker${i}`] }));
    lookedAtEverything();
    const pairs = olders.map((older, i) => ({ older, newer: note(`The user's locker code is the number ${i + 1} on floor ${i + 1}`, { keywords: [`locker${i}`] }) }));
    const batch = batchNow();
    const changes = pairs.map(({ older, newer }) => [refOf(newer), 'duplicate', refOf(older)] as [string, 'duplicate', string]);
    const keeps = batch.groups.map((group) => batch.notes.get(group.members[0])!.ref).filter((ref) => !changes.some(([r]) => r === ref))
      .map((ref) => [ref, 'keep', null] as [string, 'keep', null]);
    const payload = validateConsolidationPayload(decide(...changes, ...keeps), batch, { activeMichiNotes: 100 });
    // Meanwhile: one is deleted, one edited, one the user edited in Settings, one's conversation stopped learning, one moved out of the areas.
    getDb().prepare('DELETE FROM memories WHERE id = ?').run(pairs[0]!.older.id);
    updateMemory({ ownerUserId: ME }, pairs[1]!.newer.id, { body: 'The user\'s locker code is the number 2 on floor 2 (west wing).' });
    getDb().prepare('UPDATE memories SET user_edited_at = ? WHERE id = ?').run(now, pairs[2]!.newer.id);
    getDb().prepare('INSERT INTO nodes (id, workspace_id, kind, status, created_at, memory_mode) VALUES (?, ?, ?, ?, ?, ?)').run('n-off', 'ws', 'chat', 'idle', now, 'off');
    getDb().prepare("UPDATE memories SET source_node_id = 'n-off' WHERE id = ?").run(pairs[3]!.newer.id);
    getDb().prepare("UPDATE memories SET scope = 'workspace', workspace_id = 'ws2' WHERE id IN (?, ?)").run(pairs[4]!.newer.id, pairs[4]!.older.id);
    getDb().prepare('UPDATE memories SET body = ? WHERE id = ?').run('The user\'s locker code is 99.', pairs[5]!.older.id);
    const result = commitConsolidation(payload, { ownerUserId: ME, runId: 'mcr-checks', batch, liveWorkspace: (id) => id !== 'ws2', now });
    const outcome = (record: MemoryRecord) => result.outcomes.get(record.id)?.outcome;
    assert.equal(outcome(pairs[0]!.newer), 'skipped:gone');
    assert.equal(outcome(pairs[1]!.newer), 'skipped:changed');
    assert.equal(outcome(pairs[2]!.newer), 'skipped:protected');
    assert.equal(outcome(pairs[3]!.newer), 'skipped:source');
    assert.equal(outcome(pairs[4]!.newer), 'skipped:area');
    assert.equal(outcome(pairs[5]!.newer), 'skipped:rule:8', 'the into\'s current text lost the digits');
    assert.equal(outcome(pairs[6]!.newer), 'applied');
    assert.equal(result.applied.length, 1);
  });

  test('the caps hold at commit too', () => {
    const olders = Array.from({ length: 6 }, (_, i) => note(`Team ritual ${i}: standup at ${9 + i}:00.`, { keywords: [`ritual${i}`] }));
    lookedAtEverything();
    const pairs = olders.map((older, i) => ({ older, newer: note(`Team ritual ${i}: standup at ${9 + i}:00`, { keywords: [`ritual${i}`] }) }));
    const batch = batchNow();
    const changes = pairs.map(({ older, newer }) => [refOf(newer), 'duplicate', refOf(older)] as [string, 'duplicate', string]);
    const payload = validateConsolidationPayload(decide(...changes), batch, { activeMichiNotes: 100, strict: false });
    // Twelve Michi notes: the run may change max(4, ⌈2.4⌉) = 4.
    const result = commitConsolidation(payload, { ownerUserId: ME, runId: 'mcr-cap', batch, liveWorkspace: live, now });
    assert.equal(result.applied.length, 4);
    assert.equal([...result.outcomes.values()].filter((entry) => entry.outcome === 'skipped:cap').length, 2);
  });

  test('a throw rolls everything back, the cursor included', () => {
    lookedAtEverything();
    const a = note('The user\'s bike is a red Brompton.', { keywords: ['bike', 'Brompton'] });
    const b = note('The user rides a red Brompton bike.', { keywords: ['bike', 'Brompton'] });
    const batch = batchNow();
    const before = readConsolidationState(ME).cursor;
    const payload = validateConsolidationPayload(decide([refOf(b), 'duplicate', refOf(a)], [refOf(a), 'keep', null]), batch);
    getDb().exec(`CREATE TRIGGER fail_log BEFORE INSERT ON memory_consolidation_log BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    assert.throws(() => commitConsolidation(payload, { ownerUserId: ME, runId: 'mcr-throw', batch, liveWorkspace: live, now }), /disk full/u);
    getDb().exec('DROP TRIGGER fail_log');
    assert.equal(row(b.id).record.status, 'active');
    assert.equal(row(b.id).mergedIntoId, null);
    assert.deepEqual(readConsolidationState(ME).cursor, before);
  });

  test('the profile\'s lines move to a duplicate\'s into; an outdated note\'s lines drop', () => {
    lookedAtEverything();
    const kitchen = note('The user\'s kitchen has only an air fryer.', { keywords: ['kitchen', 'air fryer'] });
    const owl = note('The user is a night owl.', { kind: 'preference' });
    const town = note('The user lives in Meguro.', { observedAt: START - 60 * DAY });
    lookedAtEverything();
    commitProfilePayload({ sections: [{ topic: 'Home', lines: [{ text: 'Kitchen: air fryer only', refs: [refOf(kitchen)] },
      { text: 'Lives in Meguro', refs: [refOf(town)] }, { text: 'Night owl', refs: [refOf(owl)] }] }] }, {
      ownerUserId: ME, sourceVersion: 0, now,
      sources: [kitchen, town, owl].map((record) => ({ ref: refOf(record), memoryId: record.id })),
    });
    const kitchenAgain = note('用户厨房里只有一台空气炸锅', { keywords: ['kitchen', 'air fryer', '空气炸锅'] });
    const moved = note('The user moved to Nakano.', { keywords: ['Meguro', 'moved'] });
    const batch = batchNow();
    const keeps = batch.groups.map((group) => batch.notes.get(group.members[0])!.ref)
      .filter((ref) => ref !== refOf(kitchen) && ref !== refOf(town)).map((ref) => [ref, 'keep', null] as [string, 'keep', null]);
    const result = commit(batch, decide(...keeps, [refOf(kitchen), 'duplicate', refOf(kitchenAgain)], [refOf(town), 'outdated', refOf(moved)]));
    assert.equal(result.applied.length, 2);
    const lines = readUserProfile(ME)!.lines;
    assert.deepEqual(lines.find((line) => line.text.startsWith('Kitchen'))!.refs.map((ref) => ref.id), [kitchenAgain.id], 'cites the into now');
    assert.deepEqual(lines.find((line) => line.text.startsWith('Lives'))!.refs.map((ref) => ref.id), [town.id], 'kept, and dropped by the version rule');
  });
});

describe('the run (planned, answered, settled)', () => {
  function pair() {
    lookedAtEverything();
    const older = note('User lives in Meguro, Tokyo.', { observedAt: START - 60 * DAY });
    const newer = note('User moved to Nakano, Tokyo.', { keywords: ['Meguro', 'Tokyo'], observedAt: START - DAY });
    return { older, newer, answer: decide([refOf(newer), 'keep', null], [refOf(older), 'outdated', refOf(newer)]) };
  }

  function planned(jobId = 'job-a') {
    const { runId, planned: plannedRun } = plan(jobId);
    assert.equal(plannedRun.kind, 'run');
    assert.ok(plannedRun.kind === 'run' && plannedRun.id.startsWith('mcr-') && plannedRun.nodeId === null);
    return { runId, id: (plannedRun as { id: string }).id };
  }

  test('a direct run commits on settle, quietly; Settings › Memory › Details shows none of it but its tokens', () => {
    consumer('ws', 'job-a');
    const { older, newer, answer } = pair();
    const before = memoryExtractionStatus(ME, now, scheduler);
    const { runId, id } = planned();
    const run = getExtractionRun(id, ME)!;
    assert.equal(run.kind, 'consolidate');
    assert.ok(run.related.every((entry) => !('body' in entry)), 'the listing holds ids and versions, never text');
    const during = memoryExtractionStatus(ME, now, scheduler);
    assert.notEqual(during.state, 'running', 'a consolidation run is not "Running"');
    stageMemoryAnswer(run, answer, now);
    const seen = events();
    now += 5_000;
    assert.deepEqual(settle(id), { status: 'succeeded', summary: null, error: null });
    endSchedulerRun(runId);
    assert.equal(row(older.id).record.status, 'superseded');
    assert.equal(row(older.id).mergedIntoId, newer.id);
    assert.deepEqual(seen.map((event) => [event.memoryId, event.action]), [[older.id, 'superseded']]);
    assert.equal(getExtractionRun(id, ME)!.payload, null, 'the staged answer (and its reasons) went');
    const after = memoryExtractionStatus(ME, now, scheduler);
    assert.deepEqual(after.recentRuns, before.recentRuns);
    assert.equal(after.lastRunAt, before.lastRunAt);
    assert.equal(after.lastError, before.lastError);
    assert.equal(after.todayTokens, before.todayTokens + 4_000, 'Today counts it: the daily limit is shared');
  });

  test('a turn that ran during it does not cancel it: the commit applies what is unchanged and skips what changed', () => {
    consumer('ws', 'job-a');
    const { older, newer, answer } = pair();
    const { id } = planned();
    stageMemoryAnswer(getExtractionRun(id, ME)!, answer, now);
    now += 2_000;
    recordTypedText('n-chat', 't-during', 'one more question');
    releaseTypedText('n-chat', 't-during');
    now += 2_000;
    assert.deepEqual(settle(id), { status: 'succeeded', summary: null, error: null });
    assert.equal(getExtractionRun(id, ME)!.state, 'succeeded');
    assert.equal(row(older.id).record.status, 'superseded', 'applied though a person typed meanwhile');
    assert.equal(row(older.id).mergedIntoId, newer.id);
    assert.equal(readConsolidationState(ME).planned, null);
    endSchedulerRun(getExtractionRun(id, ME)!.runId);

    // The re-check at commit: a note changed since the run listed it is skipped, the rest of the batch still moves on.
    now += 31 * MINUTE;
    lookedAtEverything();
    const a = note('User drinks oat milk flat whites.', { observedAt: START - 30 * DAY });
    const b = note('User now drinks black coffee.', { keywords: ['oat milk', 'flat white', 'coffee'], observedAt: START - DAY });
    const second = planned();
    stageMemoryAnswer(getExtractionRun(second.id, ME)!, decide([refOf(b), 'keep', null], [refOf(a), 'outdated', refOf(b)]), now);
    // The user corrects the newer note in a chat while the run waits for its answer.
    supersedeMemory({ ownerUserId: ME }, b.id, { body: 'User now drinks green tea.', status: 'active', origin: 'extracted' });
    now += 2_000;
    assert.deepEqual(settle(second.id), { status: 'succeeded', summary: null, error: null });
    assert.equal(row(a.id).record.status, 'active', 'its into changed since it was listed: skipped');
    const outcome = getDb().prepare('SELECT outcome FROM memory_consolidation_log WHERE run_id = ? AND memory_id = ?').get(second.id, a.id) as { outcome: string };
    assert.equal(outcome.outcome, 'skipped:changed', 'the correction replaced the note it would go into');
    assert.equal(readConsolidationState(ME).planned, null, 'the cursor moved past the batch');
  });

  test('memory turned off during the run: cancelled, nothing applied', () => {
    consumer('ws', 'job-a');
    const { older, answer } = pair();
    const { id } = planned();
    stageMemoryAnswer(getExtractionRun(id, ME)!, answer, now);
    setMemorySettings(ME, { mode: 'off' });
    assert.deepEqual(settle(id), { status: 'succeeded', summary: null, error: null });
    assert.equal(getExtractionRun(id, ME)!.state, 'cancelled');
    assert.equal(row(older.id).record.status, 'active');
  });

  test('a scheduler stop ends it with that status; a failed run keeps the cursor and never fails the execution', () => {
    consumer('ws', 'job-a');
    pair();
    const cursor = readConsolidationState(ME).cursor;
    const first = planned();
    assert.equal(settle(first.id, 'timed_out').status, 'timed_out');
    endSchedulerRun(first.runId);
    assert.deepEqual(readConsolidationState(ME).cursor, cursor);
    now += 31 * MINUTE;
    const second = planned();
    // No answer staged: failed, quietly.
    assert.deepEqual(settle(second.id), { status: 'succeeded', summary: null, error: null });
    assert.equal(getExtractionRun(second.id, ME)!.state, 'failed');
    assert.deepEqual(readConsolidationState(ME).cursor, cursor);
  });

  test('an answer unreadable after its repairs: every listed note is logged unreadable and the cursor passes them', () => {
    consumer('ws', 'job-a');
    const { older } = pair();
    const { id } = planned();
    for (let i = 0; i < 3; i += 1) {
      try { stageMemoryAnswer(getExtractionRun(id, ME)!, { decisions: 'no' }, now); } catch { /* counted below */ }
      getDb().prepare(`UPDATE memory_extraction_runs SET invalid_calls = invalid_calls + 1,
        stopped_reason = CASE WHEN invalid_calls + 1 > 2 THEN 'invalid_limit' ELSE stopped_reason END WHERE id = ?`).run(id);
    }
    assert.deepEqual(settle(id), { status: 'succeeded', summary: null, error: null });
    assert.equal(getExtractionRun(id, ME)!.state, 'failed');
    assert.equal(row(older.id).record.status, 'active');
    const logged = getDb().prepare('SELECT DISTINCT outcome FROM memory_consolidation_log WHERE run_id = ?').all(id) as Array<{ outcome: string }>;
    assert.deepEqual(logged.map((entry) => entry.outcome), ['unreadable']);
    assert.equal(consolidationDue(ME, now + DAY, holds()), false, 'nothing waits: the batch is not retried unchanged');
  });

  test('a session run is answered with memory_consolidate; the stage step validates against the listing', () => {
    consumer('ws', 'job-a');
    const { answer } = pair();
    const runId = schedulerRun('job-a');
    const plannedRun = planMemoryExtractionRun({ jobId: 'job-a', workspaceId: 'ws', ownerUserId: ME, runId, now });
    assert.equal(plannedRun.kind, 'run');
    if (plannedRun.kind !== 'run') return;
    assert.match(plannedRun.system, /Call memory_consolidate exactly once/u);
    assert.match(plannedRun.prompt, /Call memory_consolidate once with the decisions, then stop\.$/u);
    const result = stageMemoryAnswer(getExtractionRun(plannedRun.id, ME)!, answer, now);
    assert.equal(result.status, 'recorded');
  });
});

describe('retention and revert', () => {
  test('runs and log rows older than 7 days are pruned; newer ones stay', () => {
    consumer('ws', 'job-a');
    lookedAtEverything();
    const old = note('User lives in Meguro, Tokyo.', { observedAt: START - 60 * DAY });
    note('User moved to Nakano, Tokyo.', { keywords: ['Meguro', 'Tokyo'], observedAt: START - DAY });
    const first = (() => {
      const { runId, planned: p } = plan('job-a');
      const id = (p as { id: string }).id;
      stageMemoryAnswer(getExtractionRun(id, ME)!, decide(...keepAll(batchFor(id))), now);
      settle(id);
      endSchedulerRun(runId);
      return id;
    })();
    assert.ok(getExtractionRun(first, ME));
    now += 8 * DAY;
    lookedAtEverything();
    const a = note('The user\'s bike is a red Brompton.', { keywords: ['bike', 'Brompton'] });
    note('The user rides a red Brompton bike.', { keywords: ['bike', 'Brompton'] });
    const { planned: p } = plan('job-a');
    const second = (p as { id: string }).id;
    stageMemoryAnswer(getExtractionRun(second, ME)!, decide(...keepAll(batchFor(second))), now);
    settle(second);
    assert.equal(getExtractionRun(first, ME), null, 'the 8-day-old run went');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM memory_consolidation_log WHERE run_id = ?').get(first)!.n, 0);
    assert.ok(getExtractionRun(second, ME));
  });

  test('revert: an exact revert, a skip when something changed since, never a resurrection', () => {
    lookedAtEverything();
    const a1 = note('The user\'s bike is a red Brompton.', { keywords: ['bike', 'Brompton'] });
    const a2 = note('The user rides a red Brompton bike.', { keywords: ['bike', 'Brompton'] });
    const b1 = note('The user drinks oat milk lattes.', { keywords: ['latte', 'oat milk'], kind: 'preference' });
    const b2 = note('The user\'s coffee order is an oat milk latte.', { keywords: ['latte', 'oat milk'], kind: 'preference' });
    const c1 = note('The user\'s dentist is Dr. Sato.', { keywords: ['dentist', 'Sato'] });
    const c2 = note('Dr. Sato is the user\'s dentist.', { keywords: ['dentist', 'Sato'] });
    const batch = batchNow();
    const keeps = batch.groups.map((group) => batch.notes.get(group.members[0])!.ref)
      .filter((ref) => ![refOf(a2), refOf(b2), refOf(c2)].includes(ref)).map((ref) => [ref, 'keep', null] as [string, 'keep', null]);
    commit(batch, decide(...keeps, [refOf(a2), 'duplicate', refOf(a1)], [refOf(b2), 'duplicate', refOf(b1)], [refOf(c2), 'duplicate', refOf(c1)]), 'mcr-revert');
    // Since: b2 was forgotten with b1 (the user forgot b1), and c2 changed (a test stands in for any other write).
    const { forgetMemory } = require('../src/services/memory/memoryService') as typeof import('../src/services/memory/memoryService');
    forgetMemory({ ownerUserId: ME }, b1.id);
    getDb().prepare('UPDATE memories SET version = version + 1 WHERE id = ?').run(c2.id);
    const dry = revertConsolidation({ ownerUserId: ME, runIds: ['mcr-revert'] });
    assert.deepEqual(dry.reverted, [a2.id]);
    assert.deepEqual([...dry.skipped].sort(), [b2.id, c2.id].sort());
    assert.equal(row(a2.id).record.status, 'superseded', 'a dry run changes nothing');
    const applied = revertConsolidation({ ownerUserId: ME, runIds: ['mcr-revert'], apply: true });
    assert.deepEqual(applied.reverted, [a2.id]);
    assert.equal(row(a2.id).record.status, 'active');
    assert.equal(row(a2.id).mergedIntoId, null);
    assert.equal(row(a2.id).record.version, a2.version + 2);
    assert.equal(storedMemories(ME, [b2.id]).length, 0, 'what was forgotten stays gone');
    assert.equal(row(c2.id).record.status, 'superseded', 'what changed since is left alone');
    assert.equal(getDb().prepare("SELECT outcome FROM memory_consolidation_log WHERE run_id = 'mcr-revert' AND memory_id = ?").get(a2.id)!.outcome, 'reverted');
  });

  test('a listed batch rebuilds from a run\'s listing: ids and versions only, a changed note stale', () => {
    lookedAtEverything();
    const a = note('The user\'s bike is a red Brompton.', { keywords: ['bike', 'Brompton'] });
    const b = note('The user rides a red Brompton bike.', { keywords: ['bike', 'Brompton'] });
    const batch = batchNow();
    const listing = consolidationListing(batch);
    assert.ok(listing.every((entry) => Object.keys(entry).sort().join(',') === 'group,input,memoryId,ref,version'));
    updateMemory({ ownerUserId: ME }, a.id, { body: 'The user\'s bike is a blue Brompton.' });
    const listed = listedConsolidationBatch(ME, listing, batch.through);
    assert.equal(listed.notes.get(a.id)!.stale, true);
    assert.equal(listed.notes.get(b.id)!.stale, false);
    assert.deepEqual(listed.groups, batch.groups);
  });

  test('a conversation that stops learning makes its notes unchangeable (the source rule)', () => {
    lookedAtEverything();
    getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('n-src', 'ws', 'chat', 'idle', ?)").run(now);
    indexTurn({ ownerUserId: null, nodeId: 'n-src', turnId: 't-src', humanOrigin: true, userText: 'I ride a red Brompton', assistantText: 'Nice', completedAt: now });
    const a = note('The user\'s bike is a red Brompton.', { keywords: ['bike', 'Brompton'], source: { nodeId: 'n-src', turnId: 't-src' } });
    note('The user rides a red Brompton bike.', { keywords: ['bike', 'Brompton'] });
    assert.equal(batchNow().notes.get(a.id)!.changeable, true);
    setConversationMemoryMode({ ownerUserId: ME }, 'n-src', 'use_only');
    // Leaving learn removed it altogether (Michi's notes from that conversation go).
    assert.equal(storedMemories(ME, [a.id]).length, 0);
  });
});

describe('review fixes: look-alike identifiers, live runs, what stays visible, edits of the into', () => {
  test('an identifier must be one of the into\'s tokens, not a part of one', () => {
    for (const [ref, into] of [
      ['Deploys go to prod.example.com', 'Deploys go to preprod.example.com'],
      ['The entry point is src/app.ts', 'The entry point is src/app.tsx'],
      ['Alerts go to ops@acme.io', 'Alerts go to devops@acme.io'],
      ['Uses Python 3.1', 'Uses Python 3.12'],
    ] as const) {
      assert.notDeepEqual(containmentGaps({ body: ref }, { body: into, keywords: [] }), [], `${ref} -> ${into}`);
    }
    assert.deepEqual(containmentGaps({ body: 'Deploys go to prod.example.com.' }, { body: 'All deploys go to prod.example.com (eu).', keywords: [] }), []);
    assert.deepEqual(containmentGaps({ body: 'Trip on 7月10日' }, { body: 'The trip is on 2026-07-10', keywords: [] }), [], 'numbers stay digit runs');
    // The commit refuses it as well.
    const ref = note('Deploys go to prod.example.com', { kind: 'convention', scope: { kind: 'workspace', workspaceId: 'ws' }, source: { nodeId: 'n-a', turnId: 't-a' } });
    note('Deploys go to preprod.example.com', { kind: 'convention', scope: { kind: 'workspace', workspaceId: 'ws' }, source: { nodeId: 'n-b', turnId: 't-b' } });
    const batch = batchNow();
    const group = batch.groups.find((candidate) => candidate.members[0] === ref.id)!;
    const intoRef = batch.notes.get(group.members[1]!)!.ref;
    assert.match(problems(() => validateConsolidationPayload(decide(...keepAll(batch, refOf(ref)), [refOf(ref), 'duplicate', intoRef]), batch,
      { activeMichiNotes: 10 })), /does not hold "prod\.example\.com"/u);
  });

  test('not due while any run of automatic memory is live: a profile rebuild reads the notes it would put away', () => {
    consumer('ws', 'job-a', START - 2 * DAY);
    consumer('ws2', 'job-b', START - DAY);
    note('The user works at Acme as a data engineer.');
    now += CONSOLIDATION_LIMITS.idleMs;
    assert.equal(consolidationDue(ME, now, holds()), true);
    const running = schedulerRun('job-b', 'ws2');
    insertExtractionRun({ id: 'mpr-live', kind: 'profile', ownerUserId: ME, workspaceId: 'ws2', jobId: 'job-b', runId: running, configRevision: 1,
      after: 0, through: 0, memoryVersion: 0, tombstoneMark: 0, tokenBudget: 80_000, estimatedTokens: 1_000, now, sources: [], related: [] });
    assert.equal(consolidationDue(ME, now, holds()), false, 'a live profile run');
    endSchedulerRun(running);
    assert.equal(consolidationDue(ME, now, holds()), true, 'its scheduler run ended');
  });

  test('a note goes only where it stays as visible: not into a Michi note whose conversation stopped learning, whatever Don\'t recall hid; a long note is never changed', () => {
    getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('n-a', 'ws', 'chat', 'idle', 1), ('n-b', 'ws', 'chat', 'idle', 1)").run();
    assert.equal(indexTurn({ ownerUserId: null, nodeId: 'n-b', turnId: 't-hidden', humanOrigin: true, userText: 'remember I play the cello on Tuesdays',
      assistantText: 'OK.', completedAt: now, userMessageAt: now }), true);
    const into = note('The user plays the cello on Tuesdays.', { source: { nodeId: 'n-b', turnId: 't-hidden' } });
    // Don't recall hid the excerpt its note came from: the note is still pinned and cited, so it changes and takes as before.
    getDb().prepare("UPDATE memory_recall_docs SET hidden = 1 WHERE ref_id = 't-hidden'").run();
    const ref = note('用户每周二拉大提琴', { keywords: ['cello', '大提琴', 'Tuesday'], source: { nodeId: 'n-a', turnId: 't-a' } });
    const listing = [
      { ref: refOf(ref), memoryId: ref.id, version: 1, group: 1, input: true }, { ref: refOf(into), memoryId: into.id, version: 1, group: 1, input: false },
    ];
    const batch = listedConsolidationBatch(ME, listing);
    assert.deepEqual([batch.notes.get(into.id)!.learns, batch.notes.get(into.id)!.changeable], [true, true]);
    assert.deepEqual(validateConsolidationPayload(decide([refOf(ref), 'duplicate', refOf(into)]), batch, { activeMichiNotes: 10 }).decisions
      .map((decision) => [decision.op, decision.intoId]), [['duplicate', into.id]]);
    // Its conversation stopped learning: a Michi note of it takes nothing (leaving Learn removes such notes; this is the guard).
    getDb().prepare("UPDATE nodes SET memory_mode = 'use_only' WHERE id = 'n-b'").run();
    assert.match(problems(() => validateConsolidationPayload(decide([refOf(ref), 'duplicate', refOf(into)]), listedConsolidationBatch(ME, listing),
      { activeMichiNotes: 10 })), /comes from a conversation that no longer adds to memory/u);
    const long = note(`${'The user\'s partner works night shifts at the city hospital during the week. '.repeat(6)}Their sister Hana lives with them.`);
    assert.equal(listedConsolidationBatch(ME, [{ ref: refOf(long), memoryId: long.id, version: 1, group: 1, input: true }]).notes.get(long.id)!.changeable, false,
      'the prompt clips it: what the model did not read is never put away');
  });

  test('an edit of the note another was merged into brings that one back, to be looked at again; a correction does not', () => {
    const own = note('The project needs Node 22 and pnpm 9.', { origin: 'explicit', kind: 'convention', scope: { kind: 'workspace', workspaceId: 'ws' } });
    const michi = note('The project requires Node 22.', { kind: 'convention', scope: { kind: 'workspace', workspaceId: 'ws' } });
    lookedAtEverything();
    commit(listedConsolidationBatch(ME, [
      { ref: refOf(michi), memoryId: michi.id, version: 1, group: 1, input: true }, { ref: refOf(own), memoryId: own.id, version: 1, group: 1, input: false },
    ]), decide([refOf(michi), 'duplicate', refOf(own)]));
    assert.equal(row(michi.id).record.status, 'superseded');
    const seen = events();
    now += MINUTE;
    updateMemory({ ownerUserId: ME }, own.id, { body: 'The project uses pnpm 9.' }, undefined, { byUser: true });
    assert.equal(row(michi.id).record.status, 'active', 'Node 22 is said again');
    assert.equal(row(michi.id).mergedIntoId, null);
    assert.deepEqual(seen.filter((event) => event.memoryId === michi.id).map((event) => event.action), ['updated']);
    assert.equal(consolidationRowsWaiting().includes(michi.id), true, 'and waits for the next run');
    // An edit that changes nothing it says leaves a merge alone; so does a correction (a new version: the merge resolves to it).
    const other = note('The project lints with eslint 9.', { kind: 'convention', scope: { kind: 'workspace', workspaceId: 'ws' } });
    const second = note('The repo uses eslint 9 for linting.', { origin: 'explicit', kind: 'convention', scope: { kind: 'workspace', workspaceId: 'ws' } });
    commit(listedConsolidationBatch(ME, [
      { ref: refOf(other), memoryId: other.id, version: 1, group: 1, input: true }, { ref: refOf(second), memoryId: second.id, version: 1, group: 1, input: false },
    ]), decide([refOf(other), 'duplicate', refOf(second)]), 'mcr-second');
    updateMemory({ ownerUserId: ME }, second.id, { body: 'The repo uses eslint 9 for linting.' }, undefined, { byUser: true });
    assert.equal(row(other.id).record.status, 'superseded', 'the same text: nothing changed');
    supersedeMemory({ ownerUserId: ME }, second.id, { body: 'The repo uses eslint 10 for linting.', status: 'active', origin: 'explicit' });
    assert.equal(row(other.id).record.status, 'superseded', 'a correction: the merge resolves to the new version');
  });
});

/** The memories consolidation waits to look at (after its cursor). */
function consolidationRowsWaiting(): string[] {
  return (getDb().prepare(`SELECT m.id FROM memories m, memory_consolidation_state s WHERE m.owner_user_id = s.owner_user_id AND m.status = 'active'
    AND (m.updated_at > s.cursor_at OR (m.updated_at = s.cursor_at AND m.row_id > s.cursor_row))`).all() as Array<{ id: string }>).map((r) => r.id);
}
