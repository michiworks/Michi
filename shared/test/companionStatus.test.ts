import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_COMPANION_SETTINGS,
  companionAgo,
  companionBadgeCount,
  companionCheckinRunning,
  companionStatusLine,
  type CompanionItemDto,
  type CompanionRunDto,
  type CompanionRunKind,
  type CompanionSettings,
  type CompanionSnapshotDto,
  type CompanionStatusDto,
  type CompanionStatusLineInput,
} from '../src/index';

// The same cases as the frontend's companionView and companionStore tests, so
// the panel, the backend and the tray menu keep saying the same thing.

const NOW = new Date(2026, 10, 5, 14, 30).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const STATUS: CompanionStatusDto = {
  state: 'ok', auth: { valid: true, expiresAt: null, checkedAt: null }, sources: [], lastCheckAt: null, nextCheckAt: null,
  nextHeartbeatAt: null, nextBriefAt: null, turnsToday: 0, working: false,
};

function line(status: Partial<CompanionStatusDto> = {}, settings: Partial<CompanionSettings> = {}) {
  return companionStatusLine({ settings: { ...DEFAULT_COMPANION_SETTINGS, ...settings }, status: { ...STATUS, ...status } }, NOW);
}

function item(id: string, overrides: Partial<CompanionItemDto>): CompanionItemDto {
  return {
    id, source: 'cr', subtype: 'cr_needs_attention', bucket: 'needs_you', severity: 'now', itemKey: `cr:${id}:mine`, version: 'v1',
    title: `Item ${id}`, summary: null, target: null, facts: {}, status: 'new', snoozedUntil: null, feedback: null, feedbackReason: null,
    firstSeenAt: 1, changedAt: 2, observedAt: 3, createdAt: 1, updatedAt: 3, resolvedAt: null, ...overrides,
  };
}

describe('the status line', () => {
  test('says what the agent is doing, in order of what matters', () => {
    assert.deepEqual(line({ lastCheckAt: NOW - 2 * MINUTE }), { text: 'Watching · checked 2m ago', tone: 'ok' });
    assert.equal(line({ lastCheckAt: NOW - 10_000 }).text, 'Watching · checked just now');
    assert.equal(line({ lastCheckAt: null }).text, 'Watching · not checked yet');
    assert.equal(line({ state: 'degraded', lastCheckAt: NOW - MINUTE }).tone, 'warn');
    assert.deepEqual(line({ working: true }), { text: 'Working…', tone: 'working' });
    assert.deepEqual(line({ state: 'quiet_hours' }), { text: `Quiet hours until ${DEFAULT_COMPANION_SETTINGS.quietHours.end}`, tone: 'quiet' });
    assert.deepEqual(line({ auth: { valid: false, expiresAt: null, checkedAt: null } }), { text: 'Auth expired — refresh your credentials', tone: 'warn' });
    assert.deepEqual(line({ turnsToday: DEFAULT_COMPANION_SETTINGS.dailyTurnBudget }), { text: 'Budget used — resumes tomorrow', tone: 'quiet' });
    assert.deepEqual(line({ working: true }, { paused: true }), { text: 'Paused', tone: 'off' });
    assert.deepEqual(line({ state: 'paused' }), { text: 'Paused', tone: 'off' });
    assert.deepEqual(line({ working: true }, { enabled: false }), { text: 'Off', tone: 'off' });
    assert.deepEqual(line({ state: 'off' }), { text: 'Off', tone: 'off' });
  });

  test('words ages for people', () => {
    assert.equal(companionAgo(NOW - 45_000, NOW), 'just now');
    assert.equal(companionAgo(NOW + MINUTE, NOW), 'just now', 'a time ahead of this clock');
    assert.equal(companionAgo(NOW - 59 * MINUTE, NOW), '59m ago');
    assert.equal(companionAgo(NOW - 3 * HOUR, NOW), '3h ago');
    assert.equal(companionAgo(NOW - 30 * HOUR, NOW), 'yesterday');
    assert.equal(companionAgo(NOW - 3 * 24 * HOUR, NOW), '3d ago');
    assert.equal(companionAgo(NOW - 15 * 24 * HOUR, NOW), '2w ago');
  });
});

describe('the status line while the agent works (DESIGN-v2 §3.8, W0 review #3)', () => {
  const running = (kind: CompanionRunKind): Pick<CompanionRunDto, 'kind' | 'outcome'> => ({ kind, outcome: 'running' });
  const working = (activity: Pick<CompanionRunDto, 'kind' | 'outcome'>[], status: Partial<CompanionStatusDto> = {}, settings: Partial<CompanionSettings> = {}) =>
    companionStatusLine({ settings: { ...DEFAULT_COMPANION_SETTINGS, ...settings }, status: { ...STATUS, working: true, ...status }, activity }, NOW);

  test('says Checking in…, with Stop, for every check-in but the welcome', () => {
    for (const kind of ['heartbeat', 'wake', 'brief', 'worker_report', 'catch_up'] as const) {
      assert.deepEqual(working([running(kind)]), { text: 'Checking in…', tone: 'working', stoppable: true }, kind);
    }
  });

  test('says Saying hello…, without Stop, for the welcome (F4)', () => {
    assert.deepEqual(working([running('welcome')]), { text: 'Saying hello…', tone: 'working' });
  });

  test('says Taking a first look… before the welcome starts, and a running check-in goes first', () => {
    assert.deepEqual(working([], { firstLook: true }), { text: 'Taking a first look…', tone: 'working' });
    assert.deepEqual(working([{ kind: 'poll', outcome: 'running' }], { firstLook: true }), { text: 'Taking a first look…', tone: 'working' });
    assert.equal(working([running('welcome')], { firstLook: true }).text, 'Saying hello…');
  });

  test('ignores polls, follow-up sends, finished runs, and a running row the backend does not work on', () => {
    assert.deepEqual(working([{ kind: 'poll', outcome: 'running' }, { kind: 'send', outcome: 'running' }, { kind: 'heartbeat', outcome: 'quiet' }]),
      { text: 'Working…', tone: 'working' });
    assert.equal(working([running('heartbeat')], { working: false, lastCheckAt: NOW - MINUTE }).text, 'Watching · checked 1m ago');
  });

  test('keeps Off and Paused first, and reads as before v2 without activity or a first look', () => {
    assert.deepEqual(working([running('heartbeat')], {}, { paused: true }), { text: 'Paused', tone: 'off' });
    assert.deepEqual(working([running('welcome')], { firstLook: true }, { enabled: false }), { text: 'Off', tone: 'off' });
    assert.deepEqual(line({ working: true }), { text: 'Working…', tone: 'working' });
    assert.equal('stoppable' in line({ working: true }), false);
  });

  test('names the check-in that runs, and takes a whole snapshot as the tray will', () => {
    assert.equal(companionCheckinRunning([{ kind: 'poll', outcome: 'running' }, { kind: 'wake', outcome: 'running' }]), 'wake');
    assert.equal(companionCheckinRunning([{ kind: 'send', outcome: 'running' }, { kind: 'brief', outcome: 'ok' }]), null);
    assert.equal(companionCheckinRunning(undefined), null);
    // Compile-time: a snapshot is a status line input.
    const asInput = (snapshot: CompanionSnapshotDto): CompanionStatusLineInput => snapshot;
    assert.equal(typeof asInput, 'function');
  });
});

describe('the badge', () => {
  test('counts needs_you items not seen yet, plus unread messages', () => {
    const items = [
      item('a', {}),
      item('b', { status: 'seen' }),
      item('c', { bucket: 'update' }),
      item('d', {}),
    ];
    assert.equal(companionBadgeCount({ items, counts: { needsYou: 3, newItems: 3, unreadMessages: 2 } }), 4);
    assert.equal(companionBadgeCount({ items: [], counts: { needsYou: 0, newItems: 0, unreadMessages: 0 } }), 0);
    assert.equal(companionBadgeCount(null), 0);
    assert.equal(companionBadgeCount(undefined), 0);
  });
});
