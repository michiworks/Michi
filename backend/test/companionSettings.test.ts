/**
 * Companion settings: defaults with stored fields on top (bad stored values
 * fall back to their default), strict patches that refuse everything on one
 * bad field, deep merge with list replacement, fresh copies, the reasoning
 * setting (DESIGN-v2 §6), the v2 migration of the MVP's default name
 * (§8.1(c)), the sources off (conv-3), a new user's outside sources off (D17),
 * Pause Michi as the settings show and take it,
 * and the local wall-clock helpers the brief and the tools'
 * times depend on (conv-2). Temp MICHI_DATA_DIR per test.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COMPANION_CONFIGURABLE_SOURCES,
  DEFAULT_COMPANION_SETTINGS,
  REASONING_LEVELS,
  type CompanionConfigurableSource,
  type CompanionSettings,
} from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { CompanionError } from '../src/services/companion/errors';
import {
  companionBaselineMetaKey,
  companionSourcesOff,
  crAccountChanged,
  effectiveCrAlias,
  getCompanionSettings,
  localAccountAlias,
  migrateCompanionPause,
  migrateCompanionSettingsV2,
  parseCompanionBaselineValue,
  parseCompanionName,
  parseCompanionWorkdays,
  parsePipelineNames,
  patchCompanionSettings,
  previewCompanionSettings,
  settleCompanionSourceDefaults,
  sourcesTurnedOn,
  sourcesWidened,
} from '../src/services/companion/settings';
import {
  atLocalClock,
  clockMinutes,
  isCompanionWorkday,
  localClockText,
  localDateKey,
  localDayStart,
  localIsoMinuteText,
  localTimeEchoText,
  localUtcOffsetText,
  localWeekday,
  parseCompanionTime,
} from '../src/services/companion/clock';
import { michiPause, pauseMichi, resumeMichi } from '../src/services/michiPause';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';

const stored = () => getDb().prepare("SELECT value FROM meta WHERE key = 'companion:settings'").get() as { value: string } | undefined;
const store = (value: unknown) => getDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('companion:settings', ?)")
  .run(typeof value === 'string' ? value : JSON.stringify(value));

/** What is stored: the settings without Pause Michi, which is not theirs to store. */
const storedPart = ({ enabled: _enabled, paused: _paused, pausedUntil: _until, ...rest }: CompanionSettings) => rest;

function refused(patch: unknown, message?: RegExp): void {
  assert.throws(() => patchCompanionSettings(patch), (error: unknown) => {
    assert.ok(error instanceof CompanionError, `CompanionError for ${JSON.stringify(patch)}`);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'invalid_settings');
    if (message) assert.match(error.message, message);
    return true;
  });
}

describe('Companion settings', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-settings-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('nothing stored: the defaults, as a fresh copy on every read; Michi starts paused until resumed', () => {
    const settings = getCompanionSettings();
    assert.deepEqual(settings, DEFAULT_COMPANION_SETTINGS);
    assert.deepEqual([settings.paused, settings.pausedUntil, michiPause('local-user').paused], [true, null, true], 'off until turned on');
    settings.sources.cr.alias = 'changed';
    settings.sources.pipeline.watch.push('Mutated');
    settings.heartbeat.intervalMinutes = 240;
    assert.deepEqual(getCompanionSettings(), DEFAULT_COMPANION_SETTINGS, 'callers cannot reach the stored or default objects');
    assert.deepEqual(DEFAULT_COMPANION_SETTINGS.sources.pipeline.watch, []);
    assert.equal(DEFAULT_COMPANION_SETTINGS.paused, true, 'Michi is off until the user turns it on: paused until resumed');
    assert.equal(stored(), undefined, 'reading writes nothing');
  });

  test('a patch merges into nested objects, keeps every other field and is stored', () => {
    const next = patchCompanionSettings({ heartbeat: { intervalMinutes: 120 }, sources: { cr: { alias: ' JDoe ' }, email: { enabled: false } } });
    assert.equal(next.heartbeat.intervalMinutes, 120);
    assert.equal(next.heartbeat.enabled, true, 'the sibling field is kept');
    assert.equal(next.sources.cr.alias, 'jdoe', 'aliases are trimmed and lower-cased');
    assert.equal(next.sources.cr.includeReviews, true);
    assert.equal(next.sources.email.enabled, false);
    assert.equal(next.sources.calendar.enabled, false);
    assert.deepEqual(getCompanionSettings(), next);
    assert.deepEqual(JSON.parse(stored()!.value), storedPart(next));

    next.sources.email.enabled = true;
    assert.equal(getCompanionSettings().sources.email.enabled, false, 'the returned settings are a copy');

    const again = patchCompanionSettings({ paused: true, displayName: 'Robin', pollMinutes: 10,
      brief: { time: '07:30' }, quietHours: { enabled: false, start: '22:00', end: '06:30' } });
    assert.equal(again.heartbeat.intervalMinutes, 120, 'earlier patches stay');
    assert.equal(again.paused, true);
    assert.equal(again.displayName, 'Robin');
    assert.equal('notifications' in again, false, 'Michi has no notification level of its own: Settings › Notifications is the one');
    assert.equal(again.pollMinutes, 10);
    assert.deepEqual(again.brief, { enabled: true, time: '07:30', days: [1, 2, 3, 4, 5] });
    assert.deepEqual(again.quietHours, { enabled: false, start: '22:00', end: '06:30' });
    assert.deepEqual(patchCompanionSettings({}), again, 'an empty patch changes nothing');
    assert.equal(patchCompanionSettings({ sources: { cr: { alias: null } } }).sources.cr.alias, null);
    assert.equal(patchCompanionSettings({ sources: { cr: { alias: '  ' } } }).sources.cr.alias, null, 'a blank alias means the local account');
  });

  test('the pipeline watch list is replaced, trimmed and de-duplicated, at most 25', () => {
    patchCompanionSettings({ sources: { pipeline: { watch: ['A', 'B'] } } });
    const next = patchCompanionSettings({ sources: { pipeline: { watch: [' MyService-Beta ', 'Other_Pipeline', 'MyService-Beta'] } } });
    assert.deepEqual(next.sources.pipeline.watch, ['MyService-Beta', 'Other_Pipeline']);
    assert.equal(next.sources.pipeline.includeFavorites, true);
    assert.deepEqual(parsePipelineNames(Array.from({ length: 25 }, (_, i) => `P${i}`)).length, 25);
    refused({ sources: { pipeline: { watch: Array.from({ length: 26 }, (_, i) => `P${i}`) } } }, /at most 25/);
    assert.deepEqual(parsePipelineNames(['X', 'X', ...Array.from({ length: 25 }, (_, i) => `P${i}`)].slice(0, 26)).length, 25, 'duplicates do not count');
  });

  test('a patch with any unknown field or bad value is refused whole, and nothing is written', () => {
    const before = getCompanionSettings();
    refused({ enabled: true, colour: 'blue' }, /unknown setting: colour/);
    refused({ sources: { cr: { enabled: true, token: 'x' } } }, /unknown setting: sources\.cr\.token/);
    refused({ sources: { system: { enabled: false } } }, /unknown setting: sources\.system/);
    refused({ sources: 'all' }, /sources must be an object/);
    refused({ heartbeat: null }, /heartbeat must be an object/);
    refused('enabled');
    refused(['enabled']);
    refused({ enabled: 'yes' }, /enabled must be true or false/);
    refused({ brief: { time: '9:00' } }, /HH:MM/);
    refused({ quietHours: { start: '24:00' } }, /HH:MM/);
    refused({ quietHours: { start: '08:00' } }, /must differ/, );
    refused({ heartbeat: { intervalMinutes: 45 } }, /30, 60, 120, 240/);
    refused({ pollMinutes: 1 }, /from 2 to 60/);
    refused({ pollMinutes: 61 });
    refused({ pollMinutes: 2.5 });
    refused({ dailyTurnBudget: 30 }, /unknown setting: dailyTurnBudget/);
    refused({ notifications: 'all' }, /unknown setting: notifications/);
    refused({ displayName: '' }, /1 to 40/);
    refused({ displayName: 'x'.repeat(41) }, /1 to 40/);
    refused({ displayName: 7 });
    refused({ sources: { cr: { alias: 'a/b' } } }, /alias/);
    refused({ sources: { cr: { alias: 'x?y=1' } } }, /alias/);
    refused({ sources: { pipeline: { watch: ['has space'] } } }, /not a pipeline name/);
    refused({ sources: { pipeline: { watch: 'MyService' } } }, /list of pipeline names/);
    refused({ sources: { pipeline: { watch: ['../etc'] } } }, /not a pipeline name/);
    // A valid field next to a bad one is not applied either.
    refused({ paused: true, pollMinutes: 0 });
    assert.deepEqual(getCompanionSettings(), before);
    assert.equal(stored(), undefined);
  });

  test('display names collapse whitespace onto one line', () => {
    assert.equal(parseCompanionName('  Sir\n  Robin \t'), 'Sir Robin');
    assert.equal(patchCompanionSettings({ displayName: '小助手' }).displayName, '小助手');
    assert.throws(() => parseCompanionName('bad\u0007bell'), CompanionError);
    assert.throws(() => parseCompanionName(' \n '), CompanionError);
  });

  test('stored values are read leniently: each bad or unknown field keeps its default', () => {
    store({
      paused: true,
      pollMinutes: 999,
      displayName: 'Robin',
      heartbeat: { intervalMinutes: 45, enabled: false },
      brief: { time: '7am', enabled: false },
      sources: { cr: { alias: 'BAD ALIAS', includeReviews: false }, pipeline: { watch: 'nope' }, system: { enabled: false } },
      // Michi's own notification level from before P4: no longer read.
      notifications: 'off',
      someday: { field: true },
    });
    const settings = getCompanionSettings();
    const expected: CompanionSettings = structuredClone(DEFAULT_COMPANION_SETTINGS);
    expected.displayName = 'Robin';
    expected.heartbeat.enabled = false;
    expected.brief.enabled = false;
    expected.sources.cr.includeReviews = false;
    assert.deepEqual(settings, expected, 'a stored pause is not read: Pause Michi is (migrateCompanionPause took it over once)');

    store('{not json');
    assert.deepEqual(getCompanionSettings(), DEFAULT_COMPANION_SETTINGS);
    store({ sources: 'garbage', quietHours: [1, 2] });
    assert.deepEqual(getCompanionSettings(), DEFAULT_COMPANION_SETTINGS);
    // A patch over a lenient read stores the cleaned settings; Michi turned on (Resume), as the stored pause no longer says.
    resumeMichi(LOCAL_AGENT_OWNER_ID);
    store({ pollMinutes: 'often', paused: true });
    const patched = patchCompanionSettings({ displayName: 'Ada' });
    assert.equal(patched.pollMinutes, DEFAULT_COMPANION_SETTINGS.pollMinutes);
    assert.equal(patched.paused, false);
    assert.deepEqual(JSON.parse(stored()!.value), { ...storedPart(patched), paused: true }, 'the old stored pause stays as it was, for a version to go back to');
  });

  test('the brief\'s days: Monday to Friday by default; stored workdays are read as them until it has its own; a patch replaces them', () => {
    assert.deepEqual(getCompanionSettings().brief.days, [1, 2, 3, 4, 5]);
    store({ workdays: [0, 6] });
    assert.deepEqual(getCompanionSettings().brief.days, [0, 6], 'settings from before read the old workdays');
    const next = patchCompanionSettings({ brief: { days: [3, 1, 3] } });
    assert.deepEqual(next.brief.days, [1, 3]);
    assert.deepEqual(next.workdays, [0, 6], 'the old field stays as it was, for a version');
    assert.deepEqual(JSON.parse(stored()!.value).brief.days, [1, 3], 'written as the brief\'s own');
    refused({ brief: { days: [] } }, /at least one day/);
    store({ workdays: [0, 6], brief: { days: 'never' } });
    assert.deepEqual(getCompanionSettings().brief.days, [0, 6], 'a bad stored list reads the old workdays too');
  });

  test('workdays: Monday to Friday by default; a patch replaces them, in week order without repeats; at least one', () => {
    assert.deepEqual(getCompanionSettings().workdays, [1, 2, 3, 4, 5]);
    assert.deepEqual(patchCompanionSettings({ workdays: [6, 0, 6] }).workdays, [0, 6]);
    assert.deepEqual(parseCompanionWorkdays([3]), [3]);
    refused({ workdays: [] }, /at least one day/);
    refused({ workdays: [7] }, /not a weekday/);
    refused({ workdays: [-1] }, /not a weekday/);
    refused({ workdays: [1.5] }, /not a weekday/);
    refused({ workdays: ['1'] }, /not a weekday/);
    refused({ workdays: 1 }, /list of weekdays/);
    assert.deepEqual(getCompanionSettings().workdays, [0, 6], 'a refused patch changes nothing');
    store({ workdays: [] });
    assert.deepEqual(getCompanionSettings().workdays, [1, 2, 3, 4, 5], 'a bad stored list falls back to the default');
    store({ workdays: [9, 1] });
    assert.deepEqual(getCompanionSettings().workdays, [1, 2, 3, 4, 5]);
  });

  test('turning a source on forgets its baseline; turning off, pausing, resuming and other settings do not', () => {
    const baselined = () => COMPANION_CONFIGURABLE_SOURCES.filter((kind) =>
      getDb().prepare('SELECT 1 FROM meta WHERE key = ?').get(companionBaselineMetaKey(kind)) !== undefined);
    const markAll = () => {
      for (const kind of COMPANION_CONFIGURABLE_SOURCES) getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(companionBaselineMetaKey(kind), '1');
    };
    markAll();
    patchCompanionSettings({ sources: { email: { enabled: false } }, heartbeat: { intervalMinutes: 30 } });
    assert.deepEqual(baselined(), [...COMPANION_CONFIGURABLE_SOURCES], 'turning one off or changing anything else keeps them');
    patchCompanionSettings({ sources: { email: { enabled: true } } });
    assert.deepEqual(baselined(), COMPANION_CONFIGURABLE_SOURCES.filter((kind) => kind !== 'email'), 'email is turned on again: its next poll is a baseline');
    markAll();
    patchCompanionSettings({ paused: true });
    patchCompanionSettings({ paused: false, sources: { calendar: { enabled: false } } });
    assert.deepEqual(baselined(), [...COMPANION_CONFIGURABLE_SOURCES], 'Pause Michi and its end forget nothing');
    refused({ paused: true, sources: { cr: { enabled: 'no' } } });
    assert.deepEqual(baselined(), [...COMPANION_CONFIGURABLE_SOURCES], 'a refused patch forgets nothing');
    const before = { ...structuredClone(DEFAULT_COMPANION_SETTINGS), enabled: true };
    assert.deepEqual(sourcesTurnedOn(before, before), []);
  });

  test('watching more reopens a source\'s first look from the change; watching less does not (A5)', () => {
    const T = Date.UTC(2026, 10, 5, 17, 0);
    const value = (kind: CompanionConfigurableSource) => (getDb().prepare('SELECT value FROM meta WHERE key = ?').get(companionBaselineMetaKey(kind)) as { value: string } | undefined)?.value;
    const markAll = () => {
      for (const kind of COMPANION_CONFIGURABLE_SOURCES) getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(companionBaselineMetaKey(kind), '1');
    };
    markAll();
    patchCompanionSettings({ sources: { cr: { includeReviews: false }, pipeline: { includeFavorites: false } } }, T);
    assert.deepEqual([value('cr'), value('pipeline')], ['1', '1'], 'watching less changes no baseline');
    patchCompanionSettings({ sources: { pipeline: { watch: ['Alpha', 'Beta'] } } }, T + 1);
    assert.deepEqual([value('cr'), value('pipeline')], ['1', `open:${T + 1}`], 'a pipeline added to the watch list');
    assert.deepEqual(parseCompanionBaselineValue(value('pipeline')!), { at: T + 1, open: true });
    markAll();
    patchCompanionSettings({ sources: { pipeline: { watch: ['Beta'] } } }, T + 2);
    assert.equal(value('pipeline'), '1', 'one taken off the list');
    patchCompanionSettings({ sources: { cr: { includeReviews: true }, pipeline: { includeFavorites: true } } }, T + 3);
    assert.deepEqual([value('cr'), value('pipeline')], [`open:${T + 3}`, `open:${T + 3}`], 'reviews and favorites turned on');
    assert.deepEqual(COMPANION_CONFIGURABLE_SOURCES.filter((kind) => kind !== 'cr' && kind !== 'pipeline').map(value), ['1', '1', '1']);

    getDb().prepare('DELETE FROM meta WHERE key = ?').run(companionBaselineMetaKey('pipeline'));
    patchCompanionSettings({ sources: { pipeline: { watch: ['Beta', 'Gamma'] } } }, T + 4);
    assert.equal(value('pipeline'), undefined, 'a baseline still to come covers it: nothing reopens');

    const before = structuredClone(DEFAULT_COMPANION_SETTINGS);
    const after = structuredClone(before);
    after.sources.pipeline.watch = ['Gamma'];
    after.sources.cr.includeReviews = false;
    assert.deepEqual(sourcesWidened(before, after), ['pipeline']);
    assert.deepEqual(sourcesWidened(after, before), ['cr']);
    assert.deepEqual(sourcesWidened(before, before), []);
  });

  test('the CR source watching another account starts over: its baseline and its snapshots go (A5)', () => {
    const baselined = () => getDb().prepare('SELECT 1 FROM meta WHERE key = ?').get(companionBaselineMetaKey('cr')) !== undefined;
    const snapshots = (source: string) => (getDb().prepare('SELECT COUNT(*) AS n FROM companion_snapshots WHERE source = ?').get(source) as { n: number }).n;
    const seed = () => {
      getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(companionBaselineMetaKey('cr'), '1');
      for (const [source, key] of [['cr', 'cr:CR-1:mine'], ['cr', 'cr:lists'], ['pipeline', 'pipeline:Alpha']]) {
        getDb().prepare(`INSERT OR REPLACE INTO companion_snapshots (owner_user_id, source, object_key, fingerprint, state_json, first_seen_at, fingerprint_since, last_seen_at)
          VALUES ('local-user', ?, ?, 'f', '{}', 1, 1, 1)`).run(source, key);
      }
    };
    const own = localAccountAlias();
    const someone = own === 'someone-else' ? 'another-one' : 'someone-else';
    seed();
    patchCompanionSettings({ sources: { cr: { alias: someone } } });
    assert.equal(baselined(), false);
    assert.deepEqual([snapshots('cr'), snapshots('pipeline')], [0, 1], 'only the CR source starts over');
    seed();
    patchCompanionSettings({ sources: { cr: { alias: ` ${someone.toUpperCase()} `, includeReviews: false } } });
    assert.deepEqual([baselined(), snapshots('cr')], [true, 2], 'the same account, written another way');

    const before = structuredClone(DEFAULT_COMPANION_SETTINGS);
    const mine = structuredClone(before);
    mine.sources.cr.alias = 'me';
    assert.equal(crAccountChanged(before, mine, () => 'me'), false, 'null is this computer\'s account: the same one');
    assert.equal(crAccountChanged(before, mine, () => 'other'), true);
    assert.equal(effectiveCrAlias(before, () => 'me'), 'me');
  });

  test('previewCompanionSettings validates and merges without writing', () => {
    const preview = previewCompanionSettings({ quietHours: { enabled: false } });
    assert.equal(preview.quietHours.enabled, false);
    assert.equal(stored(), undefined);
    assert.throws(() => previewCompanionSettings({ quietHours: { colour: 1 } }), CompanionError);
  });
  test('reasoning: null (the default) or a level; anything else is refused; a bad stored one reads as the default (§6)', () => {
    assert.equal(getCompanionSettings().reasoning, null);
    for (const level of REASONING_LEVELS) assert.equal(patchCompanionSettings({ reasoning: level }).reasoning, level);
    assert.equal(patchCompanionSettings({ reasoning: null }).reasoning, null);
    refused({ reasoning: 'extreme' }, /reasoning must be null \(the default\) or one of: minimal, low, medium, high, xhigh, max/);
    refused({ reasoning: 3 });
    refused({ reasoning: {} });
    store({ reasoning: 'loud', displayName: 'Robin' });
    assert.deepEqual([getCompanionSettings().reasoning, getCompanionSettings().displayName], [null, 'Robin']);
    store({ reasoning: 'low' });
    assert.equal(getCompanionSettings().reasoning, 'low');
  });

  test('migrateCompanionSettingsV2: the MVP\'s stored default name becomes Michi; another name is kept; a second run changes nothing (§8.1(c))', () => {
    // Nothing stored: nothing to do.
    migrateCompanionSettingsV2();
    assert.equal(stored(), undefined);

    // The MVP stored its whole settings, its default name 'Companion' included.
    store({ displayName: 'Companion', paused: true });
    migrateCompanionSettingsV2();
    assert.deepEqual(JSON.parse(stored()!.value), { displayName: 'Michi', paused: true, reasoning: null });
    assert.equal(getCompanionSettings().displayName, 'Michi');
    const once = stored()!.value;
    migrateCompanionSettingsV2();
    assert.equal(stored()!.value, once, 'a second run changes nothing');

    // A name the user gave in the MVP stays.
    store({ displayName: 'Robin', reasoning: 'low' });
    migrateCompanionSettingsV2();
    assert.deepEqual(JSON.parse(stored()!.value), { displayName: 'Robin', reasoning: 'low' });

    // After the migration a user may name it 'Companion' like any other name.
    patchCompanionSettings({ displayName: 'Companion' });
    assert.equal(getCompanionSettings().displayName, 'Companion');
  });

  test('the sources off: those turned off; pausing Michi turns none off (conv-3)', () => {
    assert.deepEqual(companionSourcesOff(getCompanionSettings()), ['cr', 'pipeline', 'email', 'calendar']);
    const some = patchCompanionSettings({ sources: { email: { enabled: false }, calendar: { enabled: false } } });
    assert.deepEqual(companionSourcesOff(some), ['cr', 'pipeline', 'email', 'calendar']);
    assert.deepEqual(companionSourcesOff(patchCompanionSettings({ paused: true })), ['cr', 'pipeline', 'email', 'calendar']);
  });

  test('Pause Michi: until resumed, for an hour or until tomorrow 08:00; the old off switch pauses too; nothing of it is stored here', () => {
    const now = new Date(2026, 10, 5, 22, 15).getTime();
    const tomorrow = new Date(2026, 10, 6, 8, 0).getTime();
    const pause = () => { const s = getCompanionSettings(now); return [s.enabled, s.paused, s.pausedUntil]; };
    assert.deepEqual(pause(), [true, true, null], 'off until turned on: paused until resumed');
    patchCompanionSettings({ paused: false }, now);
    assert.deepEqual(pause(), [true, false, null], 'Resume turns it on');
    patchCompanionSettings({ paused: true }, now);
    assert.deepEqual(pause(), [true, true, null], 'until resumed');
    assert.deepEqual(michiPause(LOCAL_AGENT_OWNER_ID, now + 30 * 86_400_000), { paused: true, until: null });
    patchCompanionSettings({ pauseFor: 'hour' }, now);
    assert.deepEqual(pause(), [true, true, now + 3_600_000]);
    assert.equal(getCompanionSettings(now + 3_600_000).paused, false, 'it ends by itself');
    patchCompanionSettings({ pauseFor: 'tomorrow' }, now);
    assert.deepEqual(pause(), [true, true, tomorrow]);
    patchCompanionSettings({ paused: false }, now);
    assert.deepEqual(pause(), [true, false, null]);
    patchCompanionSettings({ enabled: false }, now);
    assert.deepEqual(pause(), [true, true, null], 'the old off switch is Pause Michi until resumed');
    patchCompanionSettings({ enabled: true }, now);
    assert.deepEqual(pause(), [true, false, null]);
    patchCompanionSettings({ paused: false, enabled: false }, now);
    assert.equal(getCompanionSettings(now).paused, true, 'pausing wins over resuming');
    assert.deepEqual(['enabled', 'paused', 'pausedUntil'].filter((key) => key in JSON.parse(stored()!.value)), [],
      'Pause Michi stores nothing in these settings');

    refused({ pauseFor: 'week' }, /pauseFor must be one of: hour, tomorrow/);
    refused({ paused: 'yes' }, /paused must be true or false/);
    refused({ pausedUntil: now + 1 }, /unknown setting: pausedUntil/);
    const preview = previewCompanionSettings({ paused: false });
    assert.equal(preview.paused, false);
    assert.equal(getCompanionSettings(now).paused, true, 'a preview pauses or resumes nothing');
  });

  test('migrateCompanionPause: a stored off switch or pause becomes Pause Michi until resumed, once', () => {
    const paused = () => michiPause(LOCAL_AGENT_OWNER_ID).paused;
    resumeMichi(LOCAL_AGENT_OWNER_ID);
    migrateCompanionPause();
    assert.equal(paused(), false, 'nothing stored: nothing to pause');
    getDb().prepare("DELETE FROM meta WHERE key = 'companion:pause_merged_at'").run();
    store({ enabled: false, displayName: 'Robin' });
    migrateCompanionPause();
    assert.deepEqual(michiPause(LOCAL_AGENT_OWNER_ID), { paused: true, until: null });
    assert.deepEqual(JSON.parse(stored()!.value), { enabled: false, displayName: 'Robin' }, 'the stored settings are read, not changed');
    patchCompanionSettings({ paused: false });
    migrateCompanionPause();
    assert.equal(paused(), false, 'a second run changes nothing');

    getDb().prepare("DELETE FROM meta WHERE key = 'companion:pause_merged_at'").run();
    store({ paused: true });
    migrateCompanionPause();
    assert.equal(paused(), true);

    getDb().prepare("DELETE FROM meta WHERE key = 'companion:pause_merged_at'").run();
    store({ paused: false });
    const later = Date.now() + 3_600_000;
    pauseMichi(LOCAL_AGENT_OWNER_ID, later);
    migrateCompanionPause();
    assert.deepEqual(michiPause(LOCAL_AGENT_OWNER_ID), { paused: true, until: later }, 'a Michi already paused (Pages upkeep\'s pause) stays as it was');
  });
});

describe('Companion local clock', () => {
  const at = (hours: number, minutes = 0) => new Date(2026, 10, 5, hours, minutes, 30, 0).getTime();
  test('dates, day starts and clock times are local', () => {
    const now = at(15, 45);
    assert.equal(localDateKey(now), '2026-11-05');
    assert.equal(localDayStart(now), new Date(2026, 10, 5, 0, 0, 0, 0).getTime());
    assert.equal(atLocalClock(now, '09:00'), new Date(2026, 10, 5, 9, 0, 0, 0).getTime());
    assert.equal(atLocalClock(now, '09:00', 1), new Date(2026, 10, 6, 9, 0, 0, 0).getTime());
    assert.equal(localDateKey(new Date(2026, 0, 9, 0, 0).getTime()), '2026-01-09');
    assert.equal(clockMinutes('23:59'), 23 * 60 + 59);
    assert.equal(localClockText(new Date(2026, 10, 5, 8, 5).getTime()), '08:05');
    assert.equal(localClockText(now), '15:45');
  });

  test('times the tools take: a local YYYY-MM-DD HH:MM, a time from now, or epoch ms (conv-2)', () => {
    const now = at(9, 12);
    assert.deepEqual(parseCompanionTime('2026-11-06 09:00', now), { ok: true, at: new Date(2026, 10, 6, 9, 0, 0, 0).getTime() });
    assert.deepEqual(parseCompanionTime(' 2026-11-06T17:30 ', now), { ok: true, at: new Date(2026, 10, 6, 17, 30, 0, 0).getTime() });
    assert.deepEqual(parseCompanionTime('+90m', now), { ok: true, at: now + 90 * 60_000 });
    assert.deepEqual(parseCompanionTime('+3h', now), { ok: true, at: now + 3 * 3_600_000 });
    assert.deepEqual(parseCompanionTime('+1h30m', now), { ok: true, at: now + 90 * 60_000 });
    assert.deepEqual(parseCompanionTime('+2 days', now), { ok: true, at: now + 2 * 86_400_000 });
    assert.deepEqual(parseCompanionTime('-2h', now), { ok: true, at: now - 2 * 3_600_000 });
    const epoch = new Date(2026, 10, 6, 9, 0).getTime();
    assert.deepEqual(parseCompanionTime(epoch, now), { ok: true, at: epoch }, 'epoch ms still works');
    assert.deepEqual(parseCompanionTime(String(epoch), now), { ok: true, at: epoch });
    for (const bad of ['tomorrow 9', '09:00', '2026-02-30 10:00', '2026-11-06 24:00', '2026-13-01 10:00', '+0m', '+90', '+', '', 12.5, -1, null, {}]) {
      const parsed = parseCompanionTime(bad, now);
      assert.equal(parsed.ok, false, JSON.stringify(bad));
    }
    const refusedTime = parseCompanionTime('soon', now);
    assert.ok(!refusedTime.ok && refusedTime.problem.includes('a local time "YYYY-MM-DD HH:MM" or a time from now such as "+90m"'));
  });

  test('the run time and the echo of a time read in this computer\'s zone (conv-2)', () => {
    const now = at(9, 12);
    const offset = -new Date(now).getTimezoneOffset();
    const expected = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
    assert.equal(localUtcOffsetText(now), expected);
    assert.equal(localIsoMinuteText(now), `2026-11-05T09:12${expected}`);
    assert.equal(localTimeEchoText(new Date(2026, 10, 6, 9, 0).getTime()), '2026-11-06 09:00 (Friday)');
  });

  test('workdays are local weekdays, 0 = Sunday', () => {
    const thursday = at(12);
    const saturday = new Date(2026, 10, 7, 12, 0).getTime();
    assert.equal(localWeekday(thursday), 4);
    assert.equal(localWeekday(saturday), 6);
    assert.equal(isCompanionWorkday({ workdays: [1, 2, 3, 4, 5] }, thursday), true);
    assert.equal(isCompanionWorkday({ workdays: [1, 2, 3, 4, 5] }, saturday), false);
    assert.equal(isCompanionWorkday({ workdays: [6] }, saturday), true);
  });
});
