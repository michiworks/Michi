import './isolatedConfigDir';
import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * The Companion as server.ts runs it (services/companion/boot.ts): the
 * routes get the coordinator's live service; the Companion's own tools reach
 * its Check now, which answers only once the polls ran and refuses in a
 * process without the scheduler lease (`NOT_OWNER`), its live status and the
 * deep reads; stopping it ends the engine, closes the outside sources once,
 * and leaves the tools answering "not available"; its first tick cleans up
 * what a stopped Michi left (its check-ins' native records every start, the
 * MVP Companion's transcripts once per process, DESIGN-v2 §3.7). Fake
 * outside sources, Auth, deep reads, chat hub and chat manager; no
 * timers; temp MICHI_DATA_DIR per test.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkinNodeId } from 'michi-shared';
import type { CompanionOwnToolName } from '../src/assistant/policy';
import { assistantPurposeKey } from '../src/assistant/identity';
import { ensureAssistant } from '../src/assistant/store';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import type { EphemeralSessionRecord } from '../src/services/chatManager';
import type { AssistantToolContext } from '../src/assistant/tools';
import { closeDb, getDb, initDb } from '../src/services/db';
import { bootCompanion, type CompanionBootDeps, type RunningCompanion } from '../src/services/companion/boot';
import { stableHash } from '../src/services/companion/observations';
import type { CompanionMvpDiscard } from '../src/services/companion/cleanup';
import type { CompanionTurnChatHub, CompanionTurnChatManager } from '../src/services/companion/conversation';
import {
  finishRun, getItem, getRun, listRuns, listUnnotifiedNowItems, markItemsNotified, recordRunSession, setRunCheckinNode,
  startRun, upsertItem,
} from '../src/services/companion/repository';
import type { CompanionExternalSources } from '../src/services/companion/sources';
import type { CompanionAuthStatus } from '../src/services/companion/sources/auth';
import { COMPANION_OWN_TOOLS } from '../src/services/companion/tools';
import type { CompanionPollContext, CompanionSource, SourcePollResult } from '../src/services/companion/types';
import { turnCompanionOn } from './helpers/backgroundWork';

const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();

/** An outside source whose polls wait until the test lets them finish. */
class HeldSource implements CompanionSource {
  readonly kind = 'cr' as const;
  polls = 0;
  private release: (() => void) | null = null;
  private held: Promise<void> | null = null;

  hold(): void {
    this.held = new Promise<void>((resolve) => { this.release = resolve; });
  }

  finish(): void {
    this.release?.();
    this.held = null;
  }

  intervalMs(): number {
    return 60 * 60_000;
  }

  async poll(ctx: CompanionPollContext): Promise<SourcePollResult> {
    this.polls += 1;
    if (this.held) await this.held;
    return { source: 'cr', ok: true, complete: true, observations: [{ source: 'cr', objectKey: 'cr:lists', fingerprint: '0', state: {}, observedAt: ctx.now }] };
  }

  draft(): [] {
    return [];
  }
}

const AUTH: CompanionAuthStatus = Object.freeze({ valid: true, expiresAt: T0 + 3_600_000, checkedAt: T0 });

/** The slice of chatHub the runner and the coordinator read: the conversation is idle. */
const idleHub: CompanionTurnChatHub = {
  isActive: () => false,
  isOwnerTurnActive: () => false,
  hasPendingSelfTurn: () => false,
  requestedTurnStatus: () => null,
  cancel: () => false,
  startRequestedSelfTurn: async () => { throw new Error('no check-in in this test'); },
  postSelfMessage: async () => { throw new Error('no post in this test'); },
  whenTurnSettled: async () => null,
};

/** What the chat manager and the MVP discard were asked. */
let discards: Array<{ ownerUserId: string; nodeId: string; recorded?: EphemeralSessionRecord }> = [];
let mvpDiscards: Array<Parameters<CompanionMvpDiscard>[0]> = [];
const noSessions: CompanionTurnChatManager = {
  openEphemeralSession: async () => { throw new Error('no session in this test'); },
  discardEphemeralSession: async (input) => { discards.push(input); return 'discarded'; },
};

describe('the Companion as the server runs it', () => {
  let tmpDir: string;
  let cr: HeldSource;
  let lease: boolean;
  let disposed: number;
  let crReads: string[];
  let running: RunningCompanion | null;
  let bootDeps: CompanionBootDeps;
  let companion: { workspaceId: string; nodeId: string };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-boot-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    turnCompanionOn();
    cr = new HeldSource();
    lease = true;
    disposed = 0;
    crReads = [];
    discards = [];
    mvpDiscards = [];
    companion = ensureAssistant();
    const external: CompanionExternalSources = {
      sources: [cr],
      auth: { check: async () => AUTH, last: () => AUTH },
      deepReads: {
        crDetail: async (id) => { crReads.push(id); return { ok: true, text: `<<<untrusted material (CR)\n${id} has 2 revisions\n>>>end` }; },
        pipelineDetail: async () => ({ ok: false, text: 'not in this test' }),
        emailSearch: async () => ({ ok: false, text: 'not in this test' }),
      },
      dispose: async () => { disposed += 1; },
    };
    bootDeps = {
      chatHub: idleHub,
      chatManager: noSessions,
      isLeaseHolder: () => lease,
      external,
      discardMvpSession: async (input) => { mvpDiscards.push(input); return 'discarded'; },
      coordinator: { autoTick: false, michiSource: null, clock: { now: () => T0 } },
    };
    running = bootCompanion(bootDeps);
  });

  afterEach(async () => {
    cr.finish();
    await running?.stop();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A turn the user started by writing to the Companion (chatHub's ids and its durable row). */
  function userTurn(turnId: string): AssistantToolContext {
    const assistantId = `a-${companion.nodeId}-${turnId}`;
    getDb().prepare(`INSERT INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, started_at, updated_at)
      VALUES (?, ?, NULL, ?, 'active', ?, ?)`).run(turnId, companion.nodeId, assistantId, T0, T0);
    return {
      ownerUserId: null, workspaceId: companion.workspaceId, nodeId: companion.nodeId,
      approveThreadMessage: async () => ({ approved: false, reason: 'unavailable' }),
      getActivePageTurnAttribution: () => ({ turnId, assistantId }),
    } as AssistantToolContext;
  }

  async function call(name: CompanionOwnToolName, context: AssistantToolContext, args: Record<string, unknown> = {}) {
    const tool = COMPANION_OWN_TOOLS.find((candidate) => candidate.name === name)!;
    const result = await tool.execute(context, args);
    return { text: result.content.map((part) => part.text).join(''), isError: result.isError === true };
  }

  test('the routes get the coordinator\'s live service', () => {
    const status = running!.service.status!();
    assert.equal(status.sources.find((source) => source.kind === 'cr')?.state, 'pending', 'its own source, not the stored default');
    assert.equal(status.sources.find((source) => source.kind === 'michi')?.state, 'unavailable', 'no Michi source in this test');
  });

  test('companion_check_now answers once the polls it asked for ran', async () => {
    const context = userTurn('turn-check');
    cr.hold();
    let answered = false;
    const pending = call('companion_check_now', context, { sources: ['cr'] }).then((answer) => { answered = true; return answer; });
    for (let i = 0; i < 50 && cr.polls === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cr.polls, 1, 'Check now polls the source at once');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(answered, false, 'not before the poll finished');
    cr.finish();
    const answer = await pending;
    assert.equal(answer.isError, false, answer.text);
    assert.match(answer.text, /nothing changed/);
    const polls = listRuns(20).filter((run) => run.kind === 'poll' && run.trigger === 'cr');
    assert.equal(polls.length, 1);
    assert.equal(polls[0]!.outcome, 'ok');
  });

  test('without the scheduler lease Check now refuses, from the tool and the service alike', async () => {
    lease = false;
    const answer = await call('companion_check_now', userTurn('turn-not-owner'));
    assert.equal(answer.isError, true);
    assert.match(answer.text, /^NOT_OWNER: /);
    assert.throws(() => running!.service.checkNow(), { code: 'not_owner' });
    assert.equal(cr.polls, 0);
  });

  test('the first tick cleans up what a stopped Michi left: its check-ins\' native records every start, the MVP Companion\'s transcripts once', async () => {
    // A check-in that ended, its node already purged, its native record not confirmed gone.
    const run = startRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 - 60 * 60_000 });
    setRunCheckinNode(run.id, checkinNodeId(run.id));
    const recorded = { runtimeId: 'claude', nativeSessionId: 'native-s', cwd: '/tmp/michi-checkin', profileHash: null };
    recordRunSession(run.id, recorded);
    finishRun(run.id, { outcome: 'quiet', finishedAt: T0 - 60 * 60_000 + 1 });
    // The MVP's own Companion conversation, with the native session it ran on.
    getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,runtime_id,created_at) VALUES ('n-mvp-companion',?,'chat','idle','kiro',1)").run(companion.workspaceId);
    getDb().prepare('INSERT INTO meta(key,value) VALUES (?, ?)').run(assistantPurposeKey('n-mvp-companion'), 'companion');
    getDb().prepare("INSERT INTO assistant_native_sessions(native_id,node_id,recorded_at) VALUES ('native-mvp','n-mvp-companion',1)").run();

    cr.finish();
    await call('companion_check_now', userTurn('turn-first'), { sources: ['cr'] });
    assert.deepEqual(discards, [{ ownerUserId: LOCAL_AGENT_OWNER_ID, nodeId: checkinNodeId(run.id), recorded }], 'from what the run recorded, S being gone');
    assert.equal(getRun(run.id)!.discardedAt, T0);
    assert.deepEqual(mvpDiscards, [{ session: { nodeId: 'n-mvp-companion', nativeSessionId: 'native-mvp', runtimeIds: ['kiro'] }, runtimeId: 'kiro' }]);
    assert.equal(getDb().prepare("SELECT 1 FROM assistant_native_sessions WHERE native_id = 'native-mvp'").get(), undefined, 'gone from the ledger once discarded');

    getDb().prepare("INSERT INTO assistant_native_sessions(native_id,node_id,recorded_at) VALUES ('native-mvp-2','n-mvp-companion',2)").run();
    await call('companion_check_now', userTurn('turn-second'), { sources: ['cr'] });
    assert.equal(mvpDiscards.length, 1, 'once per process');
    assert.equal(discards.length, 1, 'nothing left of the check-in');
  });

  test('stopping ends the engine, closes the outside sources once and leaves the tools without a live side', async () => {
    const stopping = running!.stop();
    assert.equal(running!.stop(), stopping, 'one stop');
    await stopping;
    assert.equal(disposed, 1);
    const check = await call('companion_check_now', userTurn('turn-after-stop'));
    assert.equal(check.isError, true);
    assert.match(check.text, /not available/i);
    running = null;
  });
});
