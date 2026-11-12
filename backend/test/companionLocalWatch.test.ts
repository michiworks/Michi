import './isolatedConfigDir';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/services/db';
import { createReminder, resolveItems, upsertItem } from '../src/services/companion/repository';
import { fireDueReminders } from '../src/services/companion/remindersEngine';

const NOW = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const MINUTE = 60_000;
const WORKDAYS = { workdays: [1, 2, 3, 4, 5] };
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-local-watch-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  closeDb();
  initDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const fired = (now: number) => fireDueReminders(WORKDAYS, now).map((firing) => firing.reminderId);

test('until answered: a Michi conversation that stopped waiting fires', () => {
  const waiting = upsertItem({
    source: 'michi', subtype: 'michi_waiting', itemKey: 'michi:node:n1',
    version: 'waiting:1', bucket: 'needs_you', severity: 'digest',
    title: 'Deploy plan waits for you', summary: null,
    target: { kind: 'node', workspaceId: 'ws-1', nodeId: 'n1' },
    facts: {}, observedAt: NOW,
  }, NOW).item;
  const watch = createReminder({
    text: 'When it is answered', itemId: waiting.id, until: 'answered',
  }, NOW + MINUTE);
  assert.deepEqual(fired(NOW + 2 * MINUTE), []);
  resolveItems([waiting.id], NOW + 3 * MINUTE);
  assert.deepEqual(fired(NOW + 4 * MINUTE), [watch.id]);
});
