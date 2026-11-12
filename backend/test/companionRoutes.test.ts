import './isolatedConfigDir';
import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * /api/companion over HTTP (DESIGN R2.17): the snapshot (its conversation is
 * the assistant's V, made on first use, with its assistant info), strict body validation with
 * `{ error, code }` refusals, item actions, settings, notes with their
 * revision, rules, reminders, demotions, goals, cards (Apply / Dismiss /
 * expired / failed), briefs, the injected service (check with its 409
 * not_owner, presence, welcome), Undo all of a check-in, "Ask before
 * sending" for a followed conversation, the view with its "Since you left",
 * the local-only guard, and both SSE streams (current revision on connect,
 * notice replay with the backlog fold and acknowledgement, cleanup on close).
 * In-process express on 127.0.0.1; temp MICHI_DATA_DIR per test; the service
 * is a fake or the no-op with a fake busy check.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  checkinNodeId,
  companionDelegationPath,
  companionPostId,
  companionStatusLine,
  type CompanionCatchUpDto, type CompanionNotice, type CompanionPresenceInput, type CompanionSnapshotDto, type CompanionTrayDto,
} from 'michi-shared';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import { assistantPurposeOf, currentAssistantNodeId } from '../src/assistant/store';
import { createCompanionRouter } from '../src/routes/companion';
import { createRemoteAccessMiddleware } from '../src/services/remoteAccess';
import { closeDb, getDb, initDb } from '../src/services/db';
import { proposeCompanionCard, proposePublicCompanionCard, applyPublicCompanionCard } from '../src/services/companion/cards';
import { getChatNotificationLevel } from '../src/services/companion/chatNotices';
import { CompanionEventBus, companionBacklogBody, enqueueCompanionNotice } from '../src/services/companion/delivery';
import { notOwner } from '../src/services/companion/errors';
import {
  COMPANION_CARD_TTL_MS,
  addGoal,
  demoteSubtype,
  getBriefCurate,
  getCompanionNotes,
  getCompanionNotesState,
  getCompanionRules,
  getItem,
  getReminder,
  createReminder,
  insertBrief,
  markCompanionWelcomeDone,
  isSubtypeDemoted,
  listGoals,
  listReminders,
  pendingNotices,
  getRun,
  recordDelegation,
  recordRun,
  recordRunChange,
  startRun,
  recordRunPost,
  removeGoal,
  setRunCheckinNode,
  setCompanionMeta,
  setNotesByCompanion,
  upsertItem,
} from '../src/services/companion/repository';
import { getCompanionSettings, patchCompanionSettings } from '../src/services/companion/settings';
import { createNoopCompanionService } from '../src/services/companion/service';
import type { CompanionService, ItemDraft } from '../src/services/companion/types';

const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

let tmpDir: string;
let server: http.Server;
let base: string;
let now = T0;
let bus: CompanionEventBus;
let service: CompanionService;
let calls: { checkNow: Array<readonly string[] | undefined>; presence: CompanionPresenceInput[]; welcome: number };
/** Conversations whose running turn waits on the user (the router's conversationWaiting). */
let waiting: Set<string>;

const CATCH_UP: CompanionCatchUpDto = { awaySince: T0 - 2 * HOUR, returnedAt: T0, changedItemIds: [], line: 'Nothing new since 10:00.' };

function fakeService(): CompanionService {
  return {
    checkNow: (kinds) => { calls.checkNow.push(kinds); },
    onPresence: async (input) => { calls.presence.push(input); },
    requestWelcome: async () => { calls.welcome += 1; return { started: true }; },
    isBusy: () => false,
  };
}

interface Reply { status: number; body: any; headers: http.IncomingHttpHeaders }

function raw(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const url = new URL(base);
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, method, path: `/api${route}`,
      // A length, not chunking: Node sends a DELETE body unframed otherwise, and the server would never see it.
      headers: payload === undefined ? headers : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        // Express's own 404 for a route that does not exist is an HTML page.
        const json = (res.headers['content-type'] ?? '').includes('json');
        resolve({ status: res.statusCode ?? 0, body: text ? (json ? JSON.parse(text) : text) : undefined, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A refusal: the status and the `{ error, code }` shape. */
async function refused(reply: Promise<Reply>, status: number, code: string, what = ''): Promise<Reply> {
  const result = await reply;
  assert.equal(result.status, status, `${what} ${JSON.stringify(result.body)}`);
  assert.equal(typeof result.body?.error, 'string', what);
  assert.equal(result.body.code, code, what);
  return result;
}

function draft(overrides: Partial<ItemDraft> = {}): ItemDraft {
  return {
    source: 'pipeline', subtype: 'pipeline_blocked', itemKey: 'pipeline:MyService', version: 'blocked:1', bucket: 'needs_you', severity: 'now',
    title: 'MyService is blocked', summary: 'Gamma is blocked by an alarm', target: { kind: 'url', url: 'https://builds.example.com/pipelines/MyService' },
    facts: { pipeline: 'MyService', blocked: 1 }, observedAt: T0, ...overrides,
  };
}

interface Stream { status: number; contentType: string | undefined; frames: string[]; waitFor(predicate: (frames: string[]) => boolean, what: string): Promise<void>; close(): void }

/** An SSE response read frame by frame (frames are separated by a blank line). */
async function stream(route: string): Promise<Stream> {
  const url = new URL(base);
  const req = http.get({ host: url.hostname, port: url.port, path: `/api${route}` });
  req.on('error', () => {});
  const [res] = await once(req, 'response') as [http.IncomingMessage];
  res.on('error', () => {});
  res.setEncoding('utf8');
  const frames: string[] = [];
  let buffer = '';
  res.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      frames.push(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  });
  return {
    status: res.statusCode ?? 0,
    contentType: res.headers['content-type'],
    frames,
    async waitFor(predicate, what) {
      for (let i = 0; i < 300 && !predicate(frames); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(predicate(frames), `${what}: ${JSON.stringify(frames)}`);
    },
    close() { req.destroy(); res.destroy(); },
  };
}

const eventName = (frame: string) => frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
const eventData = (frame: string) => JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
const framesOf = (frames: string[], name: string) => frames.filter((frame) => eventName(frame) === name).map(eventData);

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), what);
}

describe('Companion routes', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-routes-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    clearAllSessions();
    now = T0;
    calls = { checkNow: [], presence: [], welcome: 0 };
    service = fakeService();
    waiting = new Set();
    bus = new CompanionEventBus();
    const app = express();
    app.use(express.json());
    app.use('/api', createRemoteAccessMiddleware());
    app.use('/api', createCompanionRouter({ service: () => service, events: bus, clock: { now: () => now }, conversationWaiting: (nodeId) => waiting.has(nodeId) }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    clearAllSessions();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('GET /companion is the snapshot; its conversation is the assistant\'s V, made once', async () => {
    assert.equal(currentAssistantNodeId(), null);
    const first = await raw('GET', '/companion');
    assert.equal(first.status, 200);
    const snapshot = first.body as CompanionSnapshotDto;
    assert.deepEqual(snapshot.settings, getCompanionSettings());
    assert.ok(snapshot.conversation?.nodeId);
    assert.equal(snapshot.conversation.nodeId, currentAssistantNodeId());
    assert.equal(assistantPurposeOf(snapshot.conversation.nodeId), 'main', 'the one conversation the user talks in, not a closed one');
    const { assistant } = snapshot.conversation;
    assert.deepEqual([assistant.nodeId, assistant.workspaceId], [snapshot.conversation.nodeId, snapshot.conversation.workspaceId],
      'what an embedded pane needs as its assistant source');
    assert.ok(assistant.treeId && typeof assistant.conversation.runtimeId === 'string' && Array.isArray(assistant.supportedRuntimes));
    assert.deepEqual([snapshot.items, snapshot.cards, snapshot.goals, snapshot.activity, snapshot.brief, snapshot.catchUp, snapshot.notes, snapshot.revision],
      [[], [], [], [], null, null, '', 0]);
    assert.deepEqual([snapshot.notesRevision, snapshot.rules, snapshot.reminders, snapshot.demotedSubtypes], [0, '', [], []]);
    assert.deepEqual(snapshot.counts, { needsYou: 0, newItems: 0, unreadMessages: 0 });
    assert.equal(snapshot.status.state, 'ok');
    assert.equal(snapshot.status.working, false);
    assert.deepEqual((await raw('GET', '/companion')).body.conversation, snapshot.conversation, 'idempotent');

    // A live service's status and catch-up replace the stored ones.
    const status = { ...snapshot.status, state: 'degraded' as const, turnsToday: 7 };
    service = { ...fakeService(), status: () => status, catchUp: () => CATCH_UP };
    const live = (await raw('GET', '/companion')).body as CompanionSnapshotDto;
    assert.deepEqual(live.status, status);
    assert.deepEqual(live.catchUp, CATCH_UP);
  });

  test('only this machine\'s app (or the authenticated remote owner) reaches the routes', async () => {
    for (const [method, route] of [['GET', '/companion'], ['GET', '/companion/events'], ['GET', '/companion/notifications/stream'],
      ['GET', '/companion/tray'], ['PUT', '/companion/chat-notification-level'],
      ['POST', '/companion/runs/cmr-x/undo'], ['PATCH', '/companion/delegations/cmd-x'], ['PUT', '/companion/notes'], ['PUT', '/companion/rules'], ['POST', '/companion/view'],
      ['POST', '/companion/reminders'], ['DELETE', '/companion/demotions/cr_stale']] as const) {
      assert.equal((await raw(method, route, undefined, { host: 'evil.example' })).status, 403, `${method} ${route} rebound host`);
      assert.equal((await raw(method, route, undefined, { origin: 'https://evil.example' })).status, 403, `${method} ${route} foreign origin`);
    }
    assert.equal(currentAssistantNodeId(), null, 'nothing ran');
  });

  test('a cloud backend has no Companion, even if the router were mounted', async (t) => {
    process.env.MICHI_CLOUD = '1';
    t.after(() => { delete process.env.MICHI_CLOUD; });
    await refused(raw('GET', '/companion'), 404, 'not_found');
    await refused(raw('POST', '/companion/runs/cmr-x/undo'), 404, 'not_found');
    delete process.env.MICHI_CLOUD;
    assert.equal(currentAssistantNodeId(), null, 'no conversation was made');
  });

  test('settings: a valid patch answers the new snapshot; a bad one is refused and changes nothing', async () => {
    const patched = await raw('PATCH', '/companion/settings', { heartbeat: { intervalMinutes: 120 }, sources: { email: { enabled: false } } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.settings.heartbeat.intervalMinutes, 120);
    assert.equal(patched.body.status.sources.find((source: { kind: string }) => source.kind === 'email').state, 'disabled');
    assert.equal(patched.body.revision, 1, 'the change bumped the revision');
    await refused(raw('PATCH', '/companion/settings', { heartbeat: { intervalMinutes: 45 } }), 400, 'invalid_settings');
    await refused(raw('PATCH', '/companion/settings', { theme: 'dark' }), 400, 'invalid_settings');
    await refused(raw('PATCH', '/companion/settings', ['enabled']), 400, 'invalid_request');
    await refused(raw('PATCH', '/companion/settings'), 400, 'invalid_request');
    assert.equal(getCompanionSettings().heartbeat.intervalMinutes, 120);
    assert.equal((await raw('GET', '/companion')).body.revision, 1);
  });

  test('public boundaries refuse unavailable collectors without recording a successful change', async () => {
    for (const source of ['cr', 'pipeline', 'email', 'calendar']) {
      await refused(raw('PATCH', '/companion/settings', { sources: { [source]: { enabled: true } } }), 400, 'invalid_request');
      await refused(raw('POST', '/companion/check', { sources: [source] }), 400, 'invalid_request');
      assert.throws(() => proposePublicCompanionCard({ kind: 'source.update', payload: { source, enabled: true } }, T0), /not available in this build/);
    }
    assert.equal(calls.checkNow.length, 0);
    await refused(raw('PATCH', '/companion/settings', { sources: { pipeline: { watch: ['example-pipeline'] } } }), 400, 'invalid_request');
    assert.throws(() => proposePublicCompanionCard({ kind: 'pipeline.watch', payload: { add: ['example-pipeline'] } }, T0), /not available in this build/);

    // Compatibility storage can hold an older card. Apply must recheck availability too.
    const old = proposeCompanionCard({ kind: 'source.update', payload: { source: 'email', enabled: true } }, T0);
    const result = await raw('POST', `/companion/cards/${old.id}/apply`);
    assert.equal(result.body.status, 'failed');
    assert.match(result.body.error, /not available in this build/);

    const external = upsertItem(draft(), T0).item;
    assert.throws(() => proposePublicCompanionCard({ kind: 'watch.add', payload: { itemId: external.id, until: 'recovered' } }, T0), /not available in this build/);
    await refused(raw('POST', '/companion/reminders', { text: 'Wait', itemId: external.id, until: 'recovered' }), 400, 'invalid_request');
    const oldWatch = createReminder({ text: 'Wait', itemId: external.id, until: 'recovered' }, T0);
    assert.equal((await raw('PATCH', `/companion/reminders/${oldWatch.id}`, { status: 'paused' })).status, 200);
    await refused(raw('PATCH', `/companion/reminders/${oldWatch.id}`, { status: 'active' }), 400, 'invalid_request');
    assert.equal((await raw('DELETE', `/companion/reminders/${oldWatch.id}`)).status, 204);

    // Stale configuration can still be disabled and cleared.
    const off = proposePublicCompanionCard({ kind: 'source.update', payload: { source: 'email', enabled: false } }, T0);
    assert.equal((await applyPublicCompanionCard(off.id, T0)).outcome, 'applied');
    const clear = await raw('PATCH', '/companion/settings', { sources: { pipeline: { enabled: false, watch: [], includeFavorites: false } } });
    assert.equal(clear.status, 200);
    assert.equal(getCompanionSettings().sources.email.enabled, false);
  });

  test('check now goes to the service; sources are validated', async () => {
    assert.deepEqual((await raw('POST', '/companion/check')).body, { queued: true });
    const some = await raw('POST', '/companion/check', { sources: ['michi', 'michi'] });
    assert.deepEqual([some.status, some.body], [202, { queued: true }]);
    assert.deepEqual(calls.checkNow, [undefined, ['michi']]);
    for (const body of [{ sources: [] }, { sources: ['system'] }, { sources: 'cr' }, { sources: ['cr', 'slack'] }, { kinds: ['cr'] }]) {
      await refused(raw('POST', '/companion/check', body), 400, 'invalid_request', JSON.stringify(body));
    }
    assert.equal(calls.checkNow.length, 2);
  });

  test('check now in a process without the scheduler lease answers 409 not_owner (R2.14)', async () => {
    service = { ...fakeService(), checkNow: () => { throw notOwner(); } };
    const other = await refused(raw('POST', '/companion/check'), 409, 'not_owner');
    assert.match(other.body.error, /Another Michi process runs the Companion/);
    let lease = false;
    service = createNoopCompanionService({ conversationBusy: () => false, holdsSchedulerLease: () => lease });
    await refused(raw('POST', '/companion/check', { sources: ['michi'] }), 409, 'not_owner');
    lease = true;
    assert.deepEqual((await raw('POST', '/companion/check')).body, { queued: true });
  });

  test('item actions and seen, each with exactly its own fields', async () => {
    const item = upsertItem(draft(), T0).item;
    const other = upsertItem(draft({ itemKey: 'pipeline:Other' }), T0).item;
    now = T0 + 1000;
    const snoozed = await raw('POST', `/companion/items/${item.id}`, { action: 'snooze', until: T0 + HOUR });
    assert.equal(snoozed.status, 200);
    assert.deepEqual([snoozed.body.status, snoozed.body.snoozedUntil, snoozed.body.updatedAt], ['snoozed', T0 + HOUR, T0 + 1000]);
    assert.deepEqual((await raw('GET', '/companion')).body.items.map((i: { id: string }) => i.id), [other.id], 'snoozed items leave the feed');
    assert.equal((await raw('POST', `/companion/items/${item.id}`, { action: 'restore' })).body.status, 'seen');
    assert.equal((await raw('POST', `/companion/items/${item.id}`, { action: 'dismiss' })).body.status, 'dismissed');
    assert.equal((await raw('POST', `/companion/items/${item.id}`, { action: 'mute' })).body.status, 'muted');
    const feedback = await raw('POST', `/companion/items/${other.id}`, { action: 'feedback', feedback: 'down', reason: 'too_noisy' });
    assert.deepEqual([feedback.body.feedback, feedback.body.feedbackReason], ['down', 'too_noisy']);
    assert.equal((await raw('POST', `/companion/items/${other.id}`, { action: 'feedback', feedback: null })).body.feedback, null);

    const seen = await raw('POST', '/companion/items/seen', { ids: [other.id, other.id, 'cmi-missing'] });
    assert.equal(seen.status, 204);
    assert.equal(getItem(other.id)!.status, 'seen');
    assert.equal((await raw('POST', '/companion/items/seen', { ids: [] })).status, 204);

    for (const body of [
      { action: 'snooze' }, { action: 'snooze', until: 'tomorrow' }, { action: 'snooze', until: T0 - 1 }, { action: 'snooze', until: T0 + 40 * 24 * HOUR },
      { action: 'dismiss', reason: 'too_noisy' }, { action: 'explode' }, {}, { action: 'feedback', feedback: 'meh' },
      { action: 'feedback', feedback: 'down', reason: 'bored' }, { action: 'feedback', feedback: 'up', reason: 'too_noisy' },
    ]) {
      await refused(raw('POST', `/companion/items/${other.id}`, body), 400, 'invalid_request', JSON.stringify(body));
    }
    await refused(raw('POST', `/companion/items/${other.id}`, ['seen']), 400, 'invalid_request', 'a list body');
    await refused(raw('POST', '/companion/items/cmi-missing', { action: 'seen' }), 404, 'not_found');
    await refused(raw('POST', '/companion/items/bad%20id', { action: 'seen' }), 400, 'invalid_request');
    await refused(raw('POST', '/companion/items/seen', { ids: Array.from({ length: 101 }, (_, i) => `cmi-${i}`) }), 400, 'invalid_request');
    await refused(raw('POST', '/companion/items/seen', { ids: 'cmi-1' }), 400, 'invalid_request');
    await refused(raw('POST', '/companion/items/seen', { ids: ['bad id'] }), 400, 'invalid_request');
    await refused(raw('POST', '/companion/items/seen', { ids: [], all: true }), 400, 'invalid_request');
  });

  test('presence (with composing) and welcome go to the service', async () => {
    const back = await raw('POST', '/companion/presence', { active: true, companionFocused: false, lastInputAt: T0 - 5, composing: true });
    assert.deepEqual([back.status, back.body], [204, undefined], 'presence answers nothing: "Since you left" comes from the view');
    assert.equal((await raw('POST', '/companion/presence', { active: false, companionFocused: false, lastInputAt: null })).status, 204);
    assert.deepEqual(calls.presence, [
      { active: true, companionFocused: false, lastInputAt: T0 - 5, composing: true },
      { active: false, companionFocused: false, lastInputAt: null, composing: false },
    ], 'a renderer that does not say is not composing');
    for (const body of [{ companionFocused: false, lastInputAt: null }, { active: 'yes', companionFocused: false, lastInputAt: null },
      { active: true, companionFocused: false, lastInputAt: -1 }, { active: true, companionFocused: false, lastInputAt: 1.5 },
      { active: true, companionFocused: false }, { active: true, companionFocused: false, lastInputAt: null, page: 'x' },
      { active: true, companionFocused: true, lastInputAt: null, composing: 'yes' }]) {
      await refused(raw('POST', '/companion/presence', body), 400, 'invalid_request', JSON.stringify(body));
    }
    assert.equal(calls.presence.length, 2);

    assert.deepEqual((await raw('POST', '/companion/welcome')).body, { started: true });
    assert.deepEqual((await raw('POST', '/companion/welcome', {})).body, { started: true });
    await refused(raw('POST', '/companion/welcome', { force: true }), 400, 'invalid_request');
    assert.equal(calls.welcome, 2);
    service = createNoopCompanionService({ conversationBusy: () => false });
    assert.deepEqual((await raw('POST', '/companion/welcome')).body, { started: false }, 'the no-op service never welcomes');
    assert.equal((await raw('POST', '/companion/presence', { active: true, companionFocused: true, lastInputAt: null, composing: false })).status, 204);
    assert.deepEqual((await raw('POST', '/companion/check')).body, { queued: true }, 'without a lease check every check is accepted');
  });

  test('the view marks the Companion\'s messages read and answers "Since you left" after half an hour away', async () => {
    const events = await stream('/companion/events');
    try {
      await events.waitFor((frames) => framesOf(frames, 'companion_changed').length === 1, 'the connect frame');
      assert.deepEqual((await raw('POST', '/companion/view')).body, { catchUp: null }, 'the first look has nothing to catch up on');
      const spoke = recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 + 1000, outcome: 'spoke', finishedAt: T0 + 2000 });
      recordRunPost(spoke.id, { messageId: companionPostId(spoke.id), at: T0 + 2000, changes: [] });
      assert.equal((await raw('GET', '/companion')).body.counts.unreadMessages, 1, 'its post is unread');
      now = T0 + 10 * 60_000;
      assert.deepEqual((await raw('POST', '/companion/view', {})).body, { catchUp: null }, 'back after 10 minutes');
      assert.equal((await raw('GET', '/companion')).body.counts.unreadMessages, 0);
      await events.waitFor((frames) => framesOf(frames, 'companion_changed').some((event) => event.reason === 'catch_up'), 'the unread badge changed');

      const item = upsertItem(draft(), now + 60_000).item;
      const awaySince = now;
      now += HOUR;
      const back = await raw('POST', '/companion/view');
      assert.deepEqual(back.body.catchUp, { awaySince, returnedAt: now, changedItemIds: [item.id], line: '1 thing needs you.' });
      assert.deepEqual((await raw('GET', '/companion')).body.catchUp, back.body.catchUp, 'the snapshot shows it while it is recent');
    } finally {
      events.close();
    }
    await refused(raw('POST', '/companion/view', { focused: true }), 400, 'invalid_request');
  });

  test('notes with their revision, and the brief\'s focus', async () => {
    const saved = await raw('PUT', '/companion/notes', { notes: ' Watch CR-1\r\n ' });
    assert.deepEqual([saved.status, saved.body], [200, { notes: 'Watch CR-1', notesRevision: 1, origin: 'user' }]);
    assert.equal(getCompanionNotes(), 'Watch CR-1');
    const snapshot = (await raw('GET', '/companion')).body as CompanionSnapshotDto;
    assert.deepEqual([snapshot.notes, snapshot.notesRevision], ['Watch CR-1', 1]);
    setNotesByCompanion('The Companion wrote in between', 1);
    assert.equal(((await raw('GET', '/companion')).body as CompanionSnapshotDto).notesOrigin, 'checkin', 'a check-in wrote them');
    assert.deepEqual((await raw('PUT', '/companion/notes', { notes: '' })).body, { notes: '', notesRevision: 3, origin: 'user' }, 'the user\'s edit wins whatever the revision');
    assert.deepEqual(getCompanionNotesState(), { notes: '', notesRevision: 3, origin: 'user' });
    await refused(raw('PUT', '/companion/notes', { notes: 'x', notesRevision: 3 }), 400, 'invalid_request', 'the user does not pass a revision');
    await refused(raw('PUT', '/companion/notes', { notes: 'x'.repeat(4001) }), 400, 'invalid_request');
    await refused(raw('PUT', '/companion/notes', {}), 400, 'invalid_request');
    await refused(raw('PUT', '/companion/notes', { notes: 5 }), 400, 'invalid_request');
    await refused(raw('PUT', '/companion/notes', { notes: 'x', append: true }), 400, 'invalid_request');

    assert.equal((await raw('POST', '/companion/brief/curate', { text: 'More on reviews' })).status, 204);
    assert.equal(getBriefCurate(), 'More on reviews');
    await refused(raw('POST', '/companion/brief/curate', { text: 'x'.repeat(501) }), 400, 'invalid_request');
    await refused(raw('POST', '/companion/brief/curate', {}), 400, 'invalid_request');
  });

  test('rules: the user replaces them and the snapshot shows them', async () => {
    const saved = await raw('PUT', '/companion/rules', { rules: ' No pings before 10:00\r\nNever email ' });
    assert.deepEqual([saved.status, saved.body], [200, { rules: 'No pings before 10:00\nNever email' }]);
    assert.equal(getCompanionRules(), 'No pings before 10:00\nNever email');
    const snapshot = (await raw('GET', '/companion')).body as CompanionSnapshotDto;
    assert.equal(snapshot.rules, 'No pings before 10:00\nNever email');
    assert.equal(snapshot.revision, 1, 'the change bumped the revision');
    for (const body of [{ rules: 'x'.repeat(2001) }, {}, { rules: ['a'] }, { rules: 'x', append: true }]) {
      await refused(raw('PUT', '/companion/rules', body), 400, 'invalid_request', JSON.stringify(body).slice(0, 40));
    }
    assert.deepEqual((await raw('PUT', '/companion/rules', { rules: '' })).body, { rules: '' });
    assert.equal(getCompanionRules(), '');
    // Rules no write could have stored show as none; the turns refuse to run on them (readCompanionRules).
    setCompanionMeta('companion:rules', 'x'.repeat(2001));
    assert.equal((await raw('GET', '/companion')).body.rules, '');
  });

  test('reminders: add, pause, resume and cancel; each refusal says why', async () => {
    const item = upsertItem(draft({ source: 'michi', subtype: 'michi_waiting', itemKey: 'michi:local-chat' }), T0).item;
    const created = await raw('POST', '/companion/reminders', { text: 'Check the deploy', at: T0 + HOUR });
    assert.equal(created.status, 201);
    assert.deepEqual([created.body.kind, created.body.text, created.body.at, created.body.dailyAt, created.body.status], ['time', 'Check the deploy', T0 + HOUR, null, 'active']);
    assert.equal('lastFiredDate' in created.body, false, 'the DTO only');
    now = T0 + 1;
    const watch = await raw('POST', '/companion/reminders', { text: 'When it is answered', itemId: item.id, until: 'answered' });
    assert.deepEqual([watch.status, watch.body.kind, watch.body.itemId, watch.body.until], [201, 'watch', item.id, 'answered']);
    assert.deepEqual((await raw('GET', '/companion')).body.reminders.map((reminder: { id: string }) => reminder.id), [created.body.id, watch.body.id]);

    const paused = await raw('PATCH', `/companion/reminders/${created.body.id}`, { status: 'paused' });
    assert.deepEqual([paused.status, paused.body.status], [200, 'paused']);
    assert.equal((await raw('PATCH', `/companion/reminders/${created.body.id}`, { status: 'active' })).body.status, 'active');
    assert.equal((await raw('DELETE', `/companion/reminders/${created.body.id}`)).status, 204);
    assert.equal(getReminder(created.body.id)?.status, 'cancelled');
    assert.equal((await raw('DELETE', `/companion/reminders/${created.body.id}`)).status, 204, 'cancelling twice is fine');
    await refused(raw('PATCH', `/companion/reminders/${created.body.id}`, { status: 'active' }), 409, 'reminder_closed');
    for (const body of [{ status: 'fired' }, { status: 'cancelled' }, {}, { status: 'paused', text: 'x' }]) {
      await refused(raw('PATCH', `/companion/reminders/${watch.body.id}`, body), 400, 'invalid_request', JSON.stringify(body));
    }
    await refused(raw('PATCH', '/companion/reminders/cmrm-missing', { status: 'paused' }), 404, 'not_found');
    await refused(raw('DELETE', '/companion/reminders/cmrm-missing'), 404, 'not_found');
    await refused(raw('DELETE', '/companion/reminders/bad%20id'), 400, 'invalid_request');
    for (const body of [{}, { text: 'x' }, { text: 'x', at: T0 - 1 }, { text: 'x', at: T0 + HOUR, dailyAt: '09:00' }, { text: 'x', until: 'approved' },
      { text: 'x', itemId: item.id, until: 'merged' }, { text: 'x', at: T0 + HOUR, repeat: 'weekly' }, { text: 'x', dailyAt: '9am' }]) {
      await refused(raw('POST', '/companion/reminders', body), 400, 'invalid_request', JSON.stringify(body));
    }
    await refused(raw('POST', '/companion/reminders', { text: 'x', at: T0 + HOUR, itemId: 'cmi-missing' }), 404, 'not_found');
    assert.deepEqual(listReminders().map((reminder) => reminder.id), [watch.body.id]);
  });

  test('demotions: Settings undoes one; an unknown subtype is refused', async () => {
    demoteSubtype('pipeline_blocked', T0);
    const before = (await raw('GET', '/companion')).body as CompanionSnapshotDto;
    assert.deepEqual(before.demotedSubtypes, ['pipeline_blocked']);
    assert.equal((await raw('DELETE', '/companion/demotions/pipeline_blocked')).status, 204);
    assert.equal(isSubtypeDemoted('pipeline_blocked'), false);
    assert.equal((await raw('GET', '/companion')).body.revision, before.revision + 1);
    assert.equal((await raw('DELETE', '/companion/demotions/pipeline_blocked')).status, 204, 'nothing left to undo is fine');
    assert.equal((await raw('GET', '/companion')).body.revision, before.revision + 1, 'and changes nothing');
    await refused(raw('DELETE', '/companion/demotions/cr_exploded'), 400, 'invalid_request');
    await refused(raw('DELETE', '/companion/demotions/pipeline_blocked', { all: true }), 400, 'invalid_request');
  });

  test('goals: add, change, remove, limits', async () => {
    const created = await raw('POST', '/companion/goals', { text: 'Ship the Companion' });
    assert.equal(created.status, 201);
    assert.equal(created.body.text, 'Ship the Companion');
    const changed = await raw('PATCH', `/companion/goals/${created.body.id}`, { text: 'Ship it', progress: 'Wave 1 done' });
    assert.deepEqual([changed.body.text, changed.body.progress, changed.body.progressAt], ['Ship it', 'Wave 1 done', T0]);
    assert.equal((await raw('PATCH', `/companion/goals/${created.body.id}`, { progress: null })).body.progress, null);
    assert.deepEqual((await raw('GET', '/companion')).body.goals.map((goal: { id: string }) => goal.id), [created.body.id]);
    assert.equal((await raw('DELETE', `/companion/goals/${created.body.id}`)).status, 204);
    assert.deepEqual(listGoals(), []);
    await refused(raw('DELETE', `/companion/goals/${created.body.id}`), 404, 'not_found');
    await refused(raw('PATCH', `/companion/goals/${created.body.id}`, { text: 'x' }), 404, 'not_found');
    await refused(raw('POST', '/companion/goals', {}), 400, 'invalid_request');
    await refused(raw('POST', '/companion/goals', { text: '' }), 400, 'invalid_request');
    await refused(raw('POST', '/companion/goals', { text: 'x'.repeat(501) }), 400, 'invalid_request');
    await refused(raw('POST', '/companion/goals', { text: 'x', position: 1 }), 400, 'invalid_request');
    const goal = addGoal('Keep', T0);
    await refused(raw('PATCH', `/companion/goals/${goal.id}`, {}), 400, 'invalid_request');
    for (let i = 1; i < 10; i++) addGoal(`Goal ${i}`, T0);
    await refused(raw('POST', '/companion/goals', { text: 'Eleventh' }), 409, 'limit_reached');
  });

  test('cards: Apply and Dismiss decide once; an expired card and a change that no longer holds say so', async () => {
    const card = proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Review CRs daily' }, reason: 'You asked for it' }, T0);
    assert.deepEqual((await raw('GET', '/companion')).body.cards.map((c: { id: string }) => c.id), [card.id]);
    const applied = await raw('POST', `/companion/cards/${card.id}/apply`);
    assert.equal(applied.status, 200);
    assert.deepEqual([applied.body.status, applied.body.summary, applied.body.reason], ['applied', 'Add a goal: "Review CRs daily"', 'You asked for it']);
    assert.deepEqual(listGoals().map((goal) => goal.text), ['Review CRs daily']);
    const again = await refused(raw('POST', `/companion/cards/${card.id}/apply`), 409, 'card_not_pending');
    assert.equal(again.body.card.status, 'applied');
    await refused(raw('POST', `/companion/cards/${card.id}/dismiss`), 409, 'card_not_pending');

    const maybe = proposeCompanionCard({ kind: 'source.update', payload: { source: 'email', enabled: false } }, T0);
    const dismissed = await raw('POST', `/companion/cards/${maybe.id}/dismiss`, {});
    assert.deepEqual([dismissed.status, dismissed.body.status], [200, 'dismissed']);
    assert.equal(getCompanionSettings().sources.email.enabled, true, 'dismissing changes nothing');

    const late = proposeCompanionCard({ kind: 'source.update', payload: { source: 'email', enabled: false } }, T0);
    now = T0 + COMPANION_CARD_TTL_MS;
    const expired = await refused(raw('POST', `/companion/cards/${late.id}/apply`), 409, 'card_expired');
    assert.equal(expired.body.card.status, 'expired');
    assert.equal(getCompanionSettings().sources.email.enabled, true);

    const goal = listGoals()[0];
    const remove = proposeCompanionCard({ kind: 'goal.remove', payload: { goalId: goal.id } }, now);
    removeGoal(goal.id, now);
    const failed = await raw('POST', `/companion/cards/${remove.id}/apply`);
    assert.deepEqual([failed.status, failed.body.status, failed.body.error], [200, 'failed', 'That goal no longer exists']);

    await refused(raw('POST', '/companion/cards/cmc-missing/apply'), 404, 'not_found');
    await refused(raw('POST', `/companion/cards/${remove.id}/apply`, { force: true }), 400, 'invalid_request');
    assert.deepEqual((await raw('GET', '/companion')).body.cards, [], 'no card is left waiting');
  });

  test('brief card feedback', async () => {
    const brief = insertBrief({ date: '2026-11-05', headline: '1 thing needs you today', origin: 'fallback', now: T0, closing: "That's all for today.",
      cards: [{ title: 'MyService is blocked', body: 'Gamma is blocked.', itemIds: [], action: null }] })!;
    assert.equal((await raw('GET', '/companion')).body.brief.id, brief.id);
    const voted = await raw('POST', `/companion/brief/${brief.id}/feedback`, { index: 0, feedback: 'up' });
    assert.deepEqual([voted.status, voted.body.cardFeedback], [200, { 0: 'up' }]);
    assert.deepEqual((await raw('POST', `/companion/brief/${brief.id}/feedback`, { index: 0, feedback: null })).body.cardFeedback, {});
    await refused(raw('POST', `/companion/brief/${brief.id}/feedback`, { index: 1, feedback: 'up' }), 400, 'invalid_request');
    await refused(raw('POST', `/companion/brief/${brief.id}/feedback`, { index: '0', feedback: 'up' }), 400, 'invalid_request');
    await refused(raw('POST', `/companion/brief/${brief.id}/feedback`, { index: 0, feedback: 'love' }), 400, 'invalid_request');
    await refused(raw('POST', `/companion/brief/${brief.id}/feedback`, { index: 0 }), 400, 'invalid_request');
    await refused(raw('POST', '/companion/brief/cmb-missing/feedback', { index: 0, feedback: 'up' }), 404, 'not_found');
  });

  test('there is no reset any more: New conversation is the assistant\'s own', async () => {
    const first = (await raw('GET', '/companion')).body as CompanionSnapshotDto;
    assert.equal((await raw('POST', '/companion/reset')).status, 404);
    assert.equal(currentAssistantNodeId(), first.conversation!.nodeId, 'V is untouched');
  });

  test('Undo all puts back what a check-in changed in Today, once; any other run is not found', async () => {
    const item = upsertItem(draft({ itemKey: 'cr:CR-1:mine' }), T0).item;
    const run = recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0, outcome: 'quiet', finishedAt: T0 + 1 });
    setRunCheckinNode(run.id, checkinNodeId(run.id));
    getDb().prepare("UPDATE companion_items SET status = 'dismissed' WHERE id = ?").run(item.id);
    const change = recordRunChange({ runId: run.id, targetKind: 'item', targetId: item.id, action: 'dismiss',
      before: { status: 'new', snoozedUntil: null }, after: { status: 'dismissed', snoozedUntil: null }, reason: 'Merged already', now: T0 });
    const changed: string[] = [];
    bus.subscribe({ changed: (event) => { changed.push(event.reason); } });
    const undone = await raw('POST', `/companion/runs/${run.id}/undo`, {});
    assert.equal(undone.status, 200);
    assert.deepEqual(undone.body, { reverted: [change], conflicts: [] });
    assert.deepEqual(changed, ['activity', 'items', 'goals', 'conversation'], 'Activity, Today, the goals and the receipt under the post');
    assert.equal(getItem(item.id)!.status, 'new');
    assert.equal(getRun(run.id)!.undoneAt, now, 'nothing of it stands');
    assert.deepEqual((await raw('POST', `/companion/runs/${run.id}/undo`)).body, { reverted: [], conflicts: [] }, 'again: nothing left to undo');
    await refused(raw('POST', `/companion/runs/${run.id}/undo`, { force: true }), 400, 'invalid_request');
    const poll = recordRun({ kind: 'poll', trigger: 'cr', startedAt: T0, outcome: 'ok', finishedAt: T0 + 1 });
    await refused(raw('POST', `/companion/runs/${poll.id}/undo`), 404, 'not_found');
    await refused(raw('POST', '/companion/runs/cmr-missing/undo'), 404, 'not_found');
  });

  test('"Ask before sending" turns a followed conversation\'s auto-send off; the body is exactly {autoSend: false}', async () => {
    const delegation = recordDelegation({ workspaceId: 'ws-1', nodeId: 'n-worker', title: 'Fix the pipeline', now: T0 });
    getDb().prepare("UPDATE companion_delegations SET state = 'following', origin = 'card', auto_send = 1 WHERE id = ?").run(delegation.id);
    for (const bad of [{}, { autoSend: true }, { autoSend: false, state: 'closed' }, { autoSend: 'false' }]) {
      await refused(raw('PATCH', companionDelegationPath(delegation.id), bad), 400, 'invalid_request');
    }
    assert.equal(((await raw('GET', '/companion')).body as CompanionSnapshotDto).delegations![0]!.autoSend, true, 'refusals change nothing');
    const patched = await raw('PATCH', companionDelegationPath(delegation.id), { autoSend: false });
    assert.equal(patched.status, 200);
    assert.deepEqual([patched.body.id, patched.body.state, patched.body.autoSend], [delegation.id, 'following', false]);
    assert.equal(((await raw('GET', '/companion')).body as CompanionSnapshotDto).delegations![0]!.autoSend, false);
    await refused(raw('PATCH', companionDelegationPath('cmd-missing'), { autoSend: false }), 404, 'not_found');
  });

  test('GET /companion/tray: the panel\'s status line, badge and welcome rule, and five Needs you rows by title only; it makes no conversation', async () => {
    const empty = await raw('GET', '/companion/tray');
    assert.equal(empty.status, 200);
    assert.deepEqual(Object.keys(empty.body).sort(), ['badge', 'briefReady', 'conversationWaiting', 'displayName', 'enabled', 'needsYou', 'needsYouTotal',
      'paused', 'revision', 'statusLine', 'welcomeWanted'], 'no welcomeDone any more (W3)');
    assert.deepEqual([empty.body.displayName, empty.body.welcomeWanted, empty.body.conversationWaiting, empty.body.needsYou, empty.body.briefReady],
      ['Michi', true, false, [], false]);
    assert.equal(currentAssistantNodeId(), null, 'a fetch from the menu bar creates nothing');

    const snapshot = (await raw('GET', '/companion')).body as CompanionSnapshotDto;
    const vNodeId = snapshot.conversation!.nodeId;
    for (let index = 0; index < 7; index++) {
      upsertItem(draft({ itemKey: `pipeline:P${index}`, title: `P${index} is blocked`, observedAt: T0 + index }), T0 + index);
    }
    const seen = upsertItem(draft({ itemKey: 'pipeline:Seen', title: 'Seen is blocked' }), T0 - HOUR).item;
    await raw('POST', '/companion/items/seen', { ids: [seen.id] });
    upsertItem(draft({ itemKey: 'pipeline:Update', title: 'Update', bucket: 'update' }), T0 + 20);
    const chat = upsertItem(draft({ source: 'michi', subtype: 'michi_waiting', itemKey: 'michi:node:n-9', title: '"Design review" is waiting for you',
      severity: 'digest', target: { kind: 'node', workspaceId: 'ws-1', nodeId: 'n-9' }, observedAt: T0 + 30 }), T0 + 30).item;
    upsertItem(draft({ source: 'email', subtype: 'email_unread', itemKey: 'email:1', title: 'Salary review', summary: 'Confidential', observedAt: T0 + 40 }), T0 + 40);
    patchCompanionSettings({ sources: { email: { enabled: false } } });
    insertBrief({ date: '2026-11-05', headline: 'Your day', origin: 'fallback', now: T0, closing: "That's all for today.", cards: [] });
    const run = startRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: T0 });
    service = { ...fakeService(), status: () => ({ ...snapshot.status, working: true }) };
    waiting.add(vNodeId);
    markCompanionWelcomeDone(T0);

    const tray = (await raw('GET', '/companion/tray')).body as CompanionTrayDto;
    const panel = (await raw('GET', '/companion')).body as CompanionSnapshotDto;
    assert.deepEqual(tray.statusLine, companionStatusLine(panel, now), 'the panel\'s line, from its activity');
    assert.deepEqual(tray.statusLine, { text: 'Checking in…', tone: 'working', stoppable: true }, `the running ${run.kind}`);
    assert.equal(tray.welcomeWanted, panel.welcome!.wanted);
    assert.equal(tray.welcomeWanted, false);
    assert.equal(tray.conversationWaiting, true, 'V waits on the user');
    assert.equal(tray.badge, 8, 'needs_you items not seen yet (seven pipelines and the conversation), as the Topbar button counts');
    assert.equal(tray.needsYouTotal, 9);
    assert.deepEqual(tray.needsYou.map((row) => row.title), ['"Design review" is waiting for you', 'P6 is blocked', 'P5 is blocked', 'P4 is blocked', 'P3 is blocked'],
      'newest change first, at most five, a source turned off left out');
    assert.ok(tray.needsYou.every((row) => Object.keys(row).sort().join() === 'id,isNew,target,title'), 'a title only');
    assert.deepEqual(tray.needsYou[0], { id: chat.id, title: '"Design review" is waiting for you', isNew: true, target: { kind: 'node', workspaceId: 'ws-1', nodeId: 'n-9' } });
    assert.deepEqual(tray.needsYou[1]!.target.kind, 'companion', 'any other item opens Today at its row, not its link');
    const text = JSON.stringify(tray);
    for (const secret of ['Gamma is blocked by an alarm', 'builds.example.com', 'Salary review', 'Confidential']) {
      assert.ok(!text.includes(secret), `no summary, link or hidden source in the tray: ${secret}`);
    }
    assert.equal(tray.briefReady, true, 'today\'s brief, not looked at');
    await raw('POST', '/companion/view', {});
    assert.equal(((await raw('GET', '/companion/tray')).body as CompanionTrayDto).briefReady, false, 'the panel was opened since');
    waiting.clear();
    assert.equal(((await raw('GET', '/companion/tray')).body as CompanionTrayDto).conversationWaiting, false);
  });

  test('PUT /companion/chat-notification-level keeps the renderer\'s level; anything else is refused', async () => {
    assert.equal(getChatNotificationLevel(), 'all');
    const put = await raw('PUT', '/companion/chat-notification-level', { level: 'approval-only' });
    assert.deepEqual([put.status, put.body], [200, { level: 'approval-only' }]);
    assert.equal(getChatNotificationLevel(), 'approval-only');
    for (const bad of [{}, { level: 'loud' }, { level: null }, { level: 'off', also: true }, ['off']]) {
      await refused(raw('PUT', '/companion/chat-notification-level', bad), 400, 'invalid_request', JSON.stringify(bad));
    }
    assert.equal(getChatNotificationLevel(), 'approval-only', 'refusals change nothing');
    assert.equal((await raw('PUT', '/companion/chat-notification-level', { level: 'off' })).status, 200);
    assert.equal(getChatNotificationLevel(), 'off');
  });

  test('the notifier\'s feed counts as the notifier and carries a companion_changed per change for the tray; a renderer\'s feed is a window', async () => {
    const chat = enqueueCompanionNotice({ title: 'Fix the build', body: 'Needs your approval: Run npm test', target: { kind: 'node', workspaceId: 'ws-1', nodeId: 'n-9' },
      itemIds: [], channel: 'chat' }, T0, { bus })!;
    const feed = await stream('/companion/notifications/stream');
    try {
      await feed.waitFor((frames) => framesOf(frames, 'companion_notice').length === 1, 'the replay');
      assert.deepEqual(framesOf(feed.frames, 'companion_notice')[0], chat, 'a conversation\'s notice keeps its channel');
      assert.equal(framesOf(feed.frames, 'companion_notice')[0].channel, 'chat');
      await until(() => bus.hasNotifier(), 'the notifier is connected');
      assert.equal(bus.windowCount(), 0, 'and is no window');
      await raw('PUT', '/companion/notes', { notes: 'Changed' });
      await feed.waitFor((frames) => framesOf(frames, 'companion_changed').length === 1, 'the change frame');
      assert.equal(framesOf(feed.frames, 'companion_changed')[0].reason, 'notes');
      assert.equal(framesOf(feed.frames, 'companion_changed')[0].type, 'companion_changed');
    } finally {
      feed.close();
    }
    await until(() => !bus.hasNotifier(), 'closing it detaches the notifier');
    const window = await stream('/companion/events');
    try {
      await until(() => bus.windowCount() === 1, 'a renderer\'s feed counts as a window');
      assert.equal(bus.hasNotifier(), false);
    } finally {
      window.close();
    }
    await until(() => bus.windowCount() === 0, 'closing it detaches the window');
  });

  test('the events stream starts with the current revision and sends one frame per change', async () => {
    bus.emitChanged('status');
    const events = await stream('/companion/events');
    try {
      assert.equal(events.status, 200);
      assert.match(events.contentType ?? '', /^text\/event-stream/);
      await events.waitFor((frames) => framesOf(frames, 'companion_changed').length === 1, 'the connect frame');
      assert.deepEqual(framesOf(events.frames, 'companion_changed')[0], { type: 'companion_changed', revision: 1, reason: 'status' });
      await raw('PUT', '/companion/notes', { notes: 'Changed' });
      await events.waitFor((frames) => framesOf(frames, 'companion_changed').length === 2, 'the change frame');
      assert.deepEqual(framesOf(events.frames, 'companion_changed')[1], { type: 'companion_changed', revision: 2, reason: 'notes' });
      const item = upsertItem(draft(), T0).item;
      await raw('POST', `/companion/items/${item.id}`, { action: 'dismiss' });
      await events.waitFor((frames) => framesOf(frames, 'companion_changed').some((event) => event.reason === 'items'), 'an items frame');
    } finally {
      events.close();
    }
  });

  test('the events stream also carries each new notice, live, for a browser; it replays, acknowledges and folds nothing (A14)', async () => {
    const item = upsertItem(draft(), T0).item;
    const target = { kind: 'companion' as const, tab: 'today' as const, itemId: item.id };
    const earlier = enqueueCompanionNotice({ title: 'Companion', body: 'Earlier', target, itemIds: [item.id] }, T0, { bus })!;
    const events = await stream('/companion/events');
    try {
      await events.waitFor((frames) => framesOf(frames, 'companion_changed').length === 1, 'the connect frame');
      assert.deepEqual(framesOf(events.frames, 'companion_notice'), [], 'the backlog is the desktop notifier\'s: nothing is replayed here');
      assert.equal(bus.hasNotifier(), false, 'a renderer feed is no notifier');
      const live: CompanionNotice = enqueueCompanionNotice({ title: 'Companion', body: 'MyService is blocked', target, itemIds: [item.id] }, T0 + 1, { bus })!;
      await events.waitFor((frames) => framesOf(frames, 'companion_notice').length === 1, 'the live notice');
      assert.deepEqual(framesOf(events.frames, 'companion_notice')[0], live, 'as stored, the item it points at included');
      assert.deepEqual(pendingNotices(T0 + 2).map((notice) => notice.id), [earlier.id, live.id], 'neither consumed');
    } finally {
      events.close();
    }
    // Delivery is still the desktop notifier's: it gets both, folded.
    const feed = await stream('/companion/notifications/stream');
    try {
      await feed.waitFor((frames) => framesOf(frames, 'companion_notice').length === 1, 'the fold');
      assert.equal(framesOf(feed.frames, 'companion_notice')[0].body, companionBacklogBody(2));
    } finally {
      feed.close();
    }
  });

  test('the notifications stream replays undelivered notices, pushes new ones, and stops replaying acknowledged ones', async () => {
    const early = enqueueCompanionNotice({ title: 'Companion', body: 'MyService is blocked', target: { kind: 'companion', tab: 'today' }, itemIds: ['cmi-1'] }, T0, { bus })!;
    const feed = await stream('/companion/notifications/stream');
    try {
      assert.equal(feed.status, 200);
      await feed.waitFor((frames) => framesOf(frames, 'companion_notice').length === 1, 'the replay');
      assert.deepEqual(framesOf(feed.frames, 'companion_notice')[0], early);
      assert.equal(feed.frames[0], ': connected');
      assert.equal(bus.hasNotifier(), true);
      const late = enqueueCompanionNotice({ title: 'Companion', body: 'Your brief is ready', target: { kind: 'companion', tab: 'chat' }, itemIds: [] }, T0 + 1, { bus })!;
      await feed.waitFor((frames) => framesOf(frames, 'companion_notice').length === 2, 'the pushed notice');
      assert.deepEqual(framesOf(feed.frames, 'companion_notice')[1], late);
      assert.equal((await raw('POST', `/companion/notifications/${early.id}/ack`)).status, 204);
      assert.equal((await raw('POST', `/companion/notifications/${early.id}/ack`)).status, 204, 'acknowledging twice is fine');
      await refused(raw('POST', '/companion/notifications/cmn-missing/ack'), 404, 'not_found');
      await refused(raw('POST', `/companion/notifications/${late.id}/ack`, { shown: true }), 400, 'invalid_request');
    } finally {
      feed.close();
    }
    await until(() => !bus.hasNotifier(), 'closing the response detaches the notifier');
    const again = await stream('/companion/notifications/stream');
    try {
      await again.waitFor((frames) => framesOf(frames, 'companion_notice').length === 1, 'the second replay');
      assert.deepEqual(framesOf(again.frames, 'companion_notice').map((notice) => notice.body), ['Your brief is ready']);
    } finally {
      again.close();
    }
  });

  test('a notifier that connects to a backlog gets one "While you were away" notice in its place (R2.7)', async () => {
    const a = upsertItem(draft(), T0).item;
    const b = upsertItem(draft({ itemKey: 'pipeline:Other' }), T0).item;
    const c = upsertItem(draft({ itemKey: 'pipeline:Third' }), T0).item;
    const target = { kind: 'url' as const, url: 'https://builds.example.com/pipelines/MyService' };
    const first = enqueueCompanionNotice({ title: 'Companion', body: 'MyService is blocked', target, itemIds: [a.id] }, T0, { bus })!;
    enqueueCompanionNotice({ title: 'Companion', body: 'Other is blocked', target, itemIds: [b.id] }, T0 + 1, { bus });
    enqueueCompanionNotice({ title: 'Companion', body: 'Third is blocked', target, itemIds: [c.id] }, T0 + 2, { bus });
    enqueueCompanionNotice({ title: 'Companion', body: 'Standup now', target, itemIds: [], expiresAt: T0 + 5 }, T0 + 3, { bus });
    await raw('POST', `/companion/items/${c.id}`, { action: 'dismiss' });
    now = T0 + 10;
    const feed = await stream('/companion/notifications/stream');
    let foldId = '';
    try {
      await feed.waitFor((frames) => framesOf(frames, 'companion_notice').length === 1, 'the fold');
      const [fold] = framesOf(feed.frames, 'companion_notice');
      assert.equal(fold.body, companionBacklogBody(2), 'the dismissed item\'s and the expired notices are not counted');
      assert.equal(fold.body, 'While you were away: 2 updates');
      assert.equal(fold.title, getCompanionSettings().displayName);
      assert.deepEqual(fold.target, { kind: 'companion', tab: 'today' });
      assert.deepEqual([...fold.itemIds].sort(), [a.id, b.id].sort());
      foldId = fold.id;
      assert.equal((await raw('POST', `/companion/notifications/${first.id}/ack`)).status, 204, 'a folded notice counts as delivered');
    } finally {
      feed.close();
    }
    await until(() => !bus.hasNotifier(), 'closing the response detaches the notifier');
    const again = await stream('/companion/notifications/stream');
    try {
      await again.waitFor((frames) => framesOf(frames, 'companion_notice').length === 1, 'the fold replays until acknowledged');
      assert.equal(framesOf(again.frames, 'companion_notice')[0].id, foldId);
      assert.equal((await raw('POST', `/companion/notifications/${foldId}/ack`)).status, 204);
    } finally {
      again.close();
    }
  });
});
