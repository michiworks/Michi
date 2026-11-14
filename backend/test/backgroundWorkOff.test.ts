/**
 * Michi and its background work are off until the user turns them on
 * (services/backgroundWorkOff.ts, michiPause.ts): a new owner's Michi is
 * paused until resumed, which holds check-ins, watching and Pages upkeep
 * together, and automatic memory is paused until Settings › Memory turns it
 * on. Resume (or Get started's Start) is the turn-on. And the one-time
 * switch-off of what older versions stored on, after migrateCompanionPause.
 */
import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { turnBackgroundWorkOffOnce } from '../src/services/backgroundWorkOff';
import { getCompanionSettings, migrateCompanionPause, patchCompanionSettings } from '../src/services/companion/settings';
import { ensureExtractionEnabledAt, getExtractionState, setExtractionPaused } from '../src/services/memory/extractionRepository';
import { MaintenanceCoordinator, maintenanceCoordinatorState } from '../src/services/metaAgent/maintenanceCoordinator';
import { michiPause, pauseMichi, resumeMichi } from '../src/services/michiPause';
import type { ScheduledJobRecord } from '../src/services/scheduledJobs/repository';

const OWNER = 'local-user';
let dir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.MICHI_DATA_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-background-off-'));
  process.env.MICHI_DATA_DIR = dir;
  closeDb();
  initDb();
});

afterEach(() => {
  closeDb();
  if (previous === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

const pausedUntilResumed = (owner: string) => {
  const pause = michiPause(owner);
  return pause.paused && pause.until === null;
};

describe('off until the user turns it on', () => {
  test('a new database: Michi is paused until resumed, and automatic memory is off', () => {
    const settings = getCompanionSettings();
    assert.deepEqual([settings.paused, settings.pausedUntil], [true, null]);
    assert.equal(pausedUntilResumed(OWNER), true);
    assert.equal(maintenanceCoordinatorState(OWNER).paused, true, 'Pages upkeep with it');
    assert.equal(getExtractionState(OWNER).paused, true);
  });

  test('rows the background writes for itself keep them off', () => {
    const record = { id: 'job-1', workspaceId: 'ws', ownerUserId: OWNER, enabled: true, autoPaused: false, consecutiveFailures: 0,
      lastRunAt: null, createdAt: 1, updatedAt: 1, lastError: null } as unknown as ScheduledJobRecord;
    new MaintenanceCoordinator().check(1_000, [record], () => false);
    assert.equal(maintenanceCoordinatorState(OWNER).lastCheckedAt, 1_000, 'the check wrote its row');
    assert.equal(pausedUntilResumed(OWNER), true);
    ensureExtractionEnabledAt(OWNER, 1_000);
    assert.equal(getExtractionState(OWNER).paused, true);
  });

  test('Resume in Settings › Michi turns Michi on; automatic memory waits for its own setting', () => {
    patchCompanionSettings({ paused: false });
    assert.deepEqual([getCompanionSettings().paused, maintenanceCoordinatorState(OWNER).paused], [false, false]);
    assert.equal(getExtractionState(OWNER).paused, true, 'Resume is not Settings › Memory');
    setExtractionPaused(OWNER, false, 1_000);
    assert.equal(getExtractionState(OWNER).paused, false);
  });
});

describe('turnBackgroundWorkOffOnce', () => {
  const storedCompanion = () => (getDb().prepare("SELECT value FROM meta WHERE key = 'companion:settings'").get() as { value: string } | undefined)?.value;

  test('pauses every owner\'s Michi until resumed and automatic memory, once per database', () => {
    patchCompanionSettings({ displayName: 'Nova' });
    for (const owner of [OWNER, 'alice']) {
      resumeMichi(owner);
      setExtractionPaused(owner, false, 1_000);
    }
    assert.equal(turnBackgroundWorkOffOnce(2_000), true);
    assert.equal(getCompanionSettings().displayName, 'Nova', 'the other settings stay');
    for (const owner of [OWNER, 'alice']) {
      assert.equal(pausedUntilResumed(owner), true, owner);
      assert.equal(getExtractionState(owner).paused, true, owner);
    }

    resumeMichi(OWNER);
    setExtractionPaused(OWNER, false, 3_000);
    assert.equal(turnBackgroundWorkOffOnce(4_000), false, 'it already ran');
    assert.equal(michiPause(OWNER).paused, false, 'what the user turned on afterwards stays on');
    assert.equal(getExtractionState(OWNER).paused, false);
  });

  test('a pause the user chose is kept: a timed one holds until resumed, the Companion\'s own off switch first becomes Pause Michi', () => {
    pauseMichi('alice', Date.now() + 60 * 60_000);
    // An MVP Companion switched off, on a Michi its coordinator had left running.
    getDb().prepare("INSERT INTO meta (key, value) VALUES ('companion:settings', ?)").run(JSON.stringify({ enabled: false, displayName: 'Nova' }));
    resumeMichi(OWNER);
    // Boot order (server.ts): the pause merge, then this.
    migrateCompanionPause();
    assert.equal(pausedUntilResumed(OWNER), true, 'the off switch became Pause Michi');
    turnBackgroundWorkOffOnce();
    assert.equal(pausedUntilResumed(OWNER), true);
    assert.equal(pausedUntilResumed('alice'), true, 'the timed pause now lasts until resumed: never shorter');
  });

  test('a database with nothing stored stays at the defaults: no settings row is written', () => {
    assert.equal(turnBackgroundWorkOffOnce(1_000), true);
    assert.equal(storedCompanion(), undefined);
    assert.equal(pausedUntilResumed(OWNER), true);
  });
});
