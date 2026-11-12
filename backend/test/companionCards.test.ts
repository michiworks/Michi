import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * The change cards R2 added (DESIGN R2.1, R2.9): reminder.add, watch.add,
 * rules.update and conversation.start. Each is validated when proposed and
 * again on Apply, summarized by Michi, and changes nothing before the user's
 * Apply. A conversation.start Apply is the user's approval of that
 * conversation: it starts through the injected setCompanionCardDeps (a fake
 * here), at most once, and fails with the reason when it cannot. The first
 * kinds are covered in companionRepository.test.ts. Temp MICHI_DATA_DIR per
 * test.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMPANION_LIMITS, THREAD_MESSAGE_MAX_CHARS } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import { CompanionError } from '../src/services/companion/errors';
import {
  COMPANION_REMINDER_TEXT_MAX_CHARS,
  addGoal,
  cardDto,
  createReminder,
  decideCard,
  getCard,
  getCompanionRules,
  getDelegation,
  listGoals,
  listOpenDelegations,
  listPendingCards,
  listReminders,
  listUnreportedCards,
  markCardsReported,
  setCompanionRules,
  upsertItem,
} from '../src/services/companion/repository';
import {
  COMPANION_ABANDONED_START_ERROR,
  COMPANION_DELEGATION_NOTE,
  applyCompanionCard,
  dismissCompanionCard,
  proposeCompanionCard,
  setCompanionCardDeps,
  settleAbandonedStarts,
} from '../src/services/companion/cards';
import type { ItemDraft } from '../src/services/companion/types';

const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const HOUR = 60 * 60_000;

function draft(itemKey: string, overrides: Partial<ItemDraft> = {}): ItemDraft {
  return {
    source: 'cr',
    subtype: 'cr_needs_attention',
    itemKey,
    version: 'v1',
    bucket: 'needs_you',
    severity: 'now',
    title: 'CR-1 needs attention',
    summary: null,
    target: { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' },
    facts: {},
    observedAt: T0,
    ...overrides,
  };
}

const companionError = (status: number, code: string, message?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof CompanionError, String(error));
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  if (message) assert.match(error.message, message);
  return true;
};

function workspace(id: string, name: string, extra: { archived_at?: number; deleted_at?: number } = {}): void {
  saveWorkspace({ id, name, created_at: T0, updated_at: T0, settings: null, ...extra } as Parameters<typeof saveWorkspace>[0]);
}

describe('Companion cards added by R2', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-cards-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    setCompanionCardDeps({});
  });

  afterEach(() => {
    setCompanionCardDeps({});
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('reminder.add', () => {
    test('a one-off or daily reminder, optionally about an item; Apply adds it', async () => {
      const cr = upsertItem(draft('cr:CR-1:mine'), T0).item;
      const once = proposeCompanionCard({ kind: 'reminder.add', payload: { text: ' Call\nthe vet ', at: T0 + HOUR }, reason: 'You said so' }, T0);
      assert.deepEqual(once.payload, { text: 'Call the vet', at: T0 + HOUR });
      assert.equal(once.summary, 'Remind you on 2026-11-05 at 13:00: "Call the vet"');
      const daily = proposeCompanionCard({ kind: 'reminder.add', payload: { text: 'Stand up', dailyAt: '09:30', itemId: cr.id } }, T0);
      assert.deepEqual(daily.payload, { text: 'Stand up', dailyAt: '09:30', itemId: cr.id });
      assert.equal(daily.summary, 'Remind you every workday at 09:30: "Stand up" (about "CR-1 needs attention")');
      assert.deepEqual(listReminders(), [], 'nothing before Apply');

      const applied = await applyCompanionCard(once.id, T0 + 1);
      assert.deepEqual([applied.outcome, applied.changed], ['applied', ['reminders']]);
      await applyCompanionCard(daily.id, T0 + 2);
      assert.deepEqual(listReminders().map((reminder) => [reminder.kind, reminder.text, reminder.at, reminder.dailyAt, reminder.itemId]), [
        ['time', 'Call the vet', T0 + HOUR, null, null],
        ['time', 'Stand up', null, '09:30', cr.id],
      ]);
    });

    test('at takes a local "YYYY-MM-DD HH:MM" or a time from now, stored as the time it means (conv-2)', async () => {
      const local = proposeCompanionCard({ kind: 'reminder.add', payload: { text: 'Call the vet', at: '2026-11-06 09:30' } }, T0);
      const nineThirty = new Date(2026, 10, 6, 9, 30, 0, 0).getTime();
      assert.deepEqual(local.payload, { text: 'Call the vet', at: nineThirty });
      assert.equal(local.summary, 'Remind you on 2026-11-06 at 09:30: "Call the vet"');
      const relative = proposeCompanionCard({ kind: 'reminder.add', payload: { text: 'Stretch', at: '+90m' } }, T0);
      assert.deepEqual(relative.payload, { text: 'Stretch', at: T0 + 90 * 60_000 });
      assert.equal(relative.summary, 'Remind you on 2026-11-05 at 13:30: "Stretch"');
      assert.equal(proposeCompanionCard({ kind: 'reminder.add', payload: { text: 'Epoch still works', at: T0 + HOUR } }, T0).payload.at, T0 + HOUR);
      for (const [at, message] of [
        ['2026-13-01 10:00', /^payload: at 2026-13-01 10:00 is not a date and time/],
        ['tomorrow', /^payload: at must be a local time "YYYY-MM-DD HH:MM" or a time from now/],
        ['-2h', /^payload: at must be a future time/],
        ['2026-11-05 11:00', /^payload: at must be a future time/],
      ] as const) {
        assert.throws(() => proposeCompanionCard({ kind: 'reminder.add', payload: { text: 'x', at } }, T0), companionError(400, 'invalid_request', message), at);
      }
      const applied = await applyCompanionCard(local.id, T0 + 1);
      assert.equal(applied.outcome, 'applied', 'Apply reads the stored time');
      assert.deepEqual(listReminders().map((reminder) => reminder.at), [nineThirty]);
    });

    test('refusals read as payload errors; a time that passed before Apply fails the card', async () => {
      for (const [payload, status, code, message] of [
        [{ text: 'x' }, 400, 'invalid_request', /^payload: A reminder has either at/],
        [{ text: 'x', at: T0 - 1 }, 400, 'invalid_request', /^payload: at must be a future time/],
        [{ text: '', at: T0 + HOUR }, 400, 'invalid_request', /^payload: A reminder cannot be empty/],
        [{ text: 'x', at: T0 + HOUR, until: 'approved' }, 400, 'invalid_request', /unknown field until/],
        [{ at: T0 + HOUR }, 400, 'invalid_request', /text is required/],
        [{ text: 'x', at: T0 + HOUR, itemId: 'cmi-missing' }, 404, 'not_found', /does not exist/],
      ] as const) {
        assert.throws(() => proposeCompanionCard({ kind: 'reminder.add', payload }, T0), companionError(status, code, message), JSON.stringify(payload));
      }
      const soon = proposeCompanionCard({ kind: 'reminder.add', payload: { text: 'Soon', at: T0 + 1000 } }, T0);
      const late = await applyCompanionCard(soon.id, T0 + 2000);
      assert.equal(late.outcome, 'failed');
      assert.match(late.card.error ?? '', /at must be a future time/);
      assert.deepEqual(listReminders(), []);
    });

    test('at most 20 open reminders: no card past it, and an Apply that would pass it fails', async () => {
      const card = proposeCompanionCard({ kind: 'reminder.add', payload: { text: 'Last one', at: T0 + HOUR } }, T0);
      for (let i = 0; i < COMPANION_LIMITS.maxReminders; i++) createReminder({ text: `R${i}`, at: T0 + HOUR }, T0);
      assert.throws(() => proposeCompanionCard({ kind: 'reminder.add', payload: { text: 'More', at: T0 + HOUR } }, T0), companionError(409, 'limit_reached'));
      const full = await applyCompanionCard(card.id, T0 + 1);
      assert.equal(full.outcome, 'failed');
      assert.match(full.card.error ?? '', /at most 20/);
      assert.equal(listReminders().length, COMPANION_LIMITS.maxReminders);
    });
  });

  describe('watch.add', () => {
    test('waits for a state the item\'s source can reach; Apply adds a watch in Michi\'s words', async () => {
      const cr = upsertItem(draft('cr:CR-1:mine'), T0).item;
      const card = proposeCompanionCard({ kind: 'watch.add', payload: { itemId: cr.id, until: 'approved' } }, T0);
      assert.deepEqual(card.payload, { itemId: cr.id, until: 'approved' });
      assert.equal(card.summary, 'Tell you when "CR-1 needs attention" is approved');
      const applied = await applyCompanionCard(card.id, T0 + 1);
      assert.deepEqual([applied.outcome, applied.changed], ['applied', ['reminders']]);
      assert.deepEqual(listReminders().map((reminder) => [reminder.kind, reminder.text, reminder.itemId, reminder.until]),
        [['watch', 'When "CR-1 needs attention" is approved', cr.id, 'approved']]);

      const pipeline = upsertItem(draft('pipeline:P', { source: 'pipeline', subtype: 'pipeline_blocked', title: 'P is blocked' }), T0).item;
      for (const [payload, status, code, message] of [
        [{ itemId: pipeline.id, until: 'approved' }, 400, 'invalid_request', /^payload: A pipeline item can be watched until: recovered/],
        [{ itemId: cr.id, until: 'shipped' }, 400, 'invalid_request', /until must be one of/],
        [{ itemId: cr.id }, 400, 'invalid_request', /until is required/],
        [{ itemId: cr.id, until: 'merged', text: 'mine' }, 400, 'invalid_request', /unknown field text/],
        [{ itemId: 'cmi-missing', until: 'merged' }, 404, 'not_found', /does not exist/],
      ] as const) {
        assert.throws(() => proposeCompanionCard({ kind: 'watch.add', payload }, T0), companionError(status, code, message), JSON.stringify(payload));
      }
      assert.equal(proposeCompanionCard({ kind: 'watch.add', payload: { itemId: pipeline.id, until: 'recovered' } }, T0).summary, 'Tell you when "P is blocked" recovers');
    });
  });

  describe('rules.update', () => {
    test('replaces or clears the user\'s rules on Apply; never more than the rules allow', async () => {
      setCompanionRules('Old rule');
      const card = proposeCompanionCard({ kind: 'rules.update', payload: { rules: ' No pings before 10:00\nNever email ' } }, T0);
      assert.deepEqual(card.payload, { rules: 'No pings before 10:00\nNever email' });
      assert.equal(card.summary, 'Replace your rules for the Companion with: "No pings before 10:00 Never email"');
      assert.equal(getCompanionRules(), 'Old rule', 'nothing before Apply');
      const applied = await applyCompanionCard(card.id, T0 + 1);
      assert.deepEqual([applied.outcome, applied.changed], ['applied', ['rules']]);
      assert.equal(getCompanionRules(), 'No pings before 10:00\nNever email');

      const clear = proposeCompanionCard({ kind: 'rules.update', payload: { rules: '' } }, T0);
      assert.equal(clear.summary, 'Clear your rules for the Companion');
      await applyCompanionCard(clear.id, T0 + 1);
      assert.equal(getCompanionRules(), '');
      assert.throws(() => proposeCompanionCard({ kind: 'rules.update', payload: { rules: 'x'.repeat(COMPANION_LIMITS.maxRulesChars + 1) } }, T0),
        companionError(400, 'invalid_request', /^payload: Rules are at most 2000/));
      assert.throws(() => proposeCompanionCard({ kind: 'rules.update', payload: {} }, T0), companionError(400, 'invalid_request', /rules is required/));
      const dismissed = proposeCompanionCard({ kind: 'rules.update', payload: { rules: 'Ignored' } }, T0);
      dismissCompanionCard(dismissed.id, T0 + 1);
      assert.equal(getCompanionRules(), '');
    });
  });

  describe('conversation.start', () => {
    const payload = { workspaceId: 'ws-1', title: ' Fix the\npipeline ', text: ' The pipeline MyService is blocked in Gamma.\r\nLook at the deploy. ' };

    test('proposed only for one of the user\'s live workspaces, with Michi\'s summary and the delegation note', () => {
      workspace('ws-1', 'My  Project');
      const card = proposeCompanionCard({ kind: 'conversation.start', payload }, T0);
      assert.deepEqual(card.payload, { workspaceId: 'ws-1', title: 'Fix the pipeline', text: 'The pipeline MyService is blocked in Gamma.\nLook at the deploy.' });
      assert.equal(card.summary, `Start a conversation in "My Project": "Fix the pipeline" (${COMPANION_DELEGATION_NOTE})`);

      workspace('ws-archived', 'Old', { archived_at: T0 });
      workspace('ws-deleted', 'Gone', { deleted_at: T0 });
      workspace('ws-system', 'Michi');
      // The system marker is server-owned: no workspace write can set it, so it goes in by hand.
      getDb().prepare(`UPDATE workspaces SET settings = '{"system":"assistant"}' WHERE id = 'ws-system'`).run();
      for (const [change, status, code, message] of [
        [{ workspaceId: 'ws-missing' }, 404, 'not_found', /workspace does not exist/],
        [{ workspaceId: 'ws-deleted' }, 404, 'not_found', /workspace does not exist/],
        [{ workspaceId: 'ws-system' }, 404, 'not_found', /workspace does not exist/],
        [{ workspaceId: 'ws-archived' }, 400, 'invalid_request', /Old is archived/],
        [{ workspaceId: 7 }, 400, 'invalid_request', /workspaceId must be a workspace id/],
        [{ title: '  ' }, 400, 'invalid_request', /title cannot be empty/],
        [{ title: 'x'.repeat(81) }, 400, 'invalid_request', /title is at most 80/],
        [{ text: '' }, 400, 'invalid_request', /text cannot be empty/],
        [{ text: 'x'.repeat(THREAD_MESSAGE_MAX_CHARS + 1) }, 400, 'invalid_request', /text is at most/],
        [{ runtimeId: 'claude' }, 400, 'invalid_request', /unknown field runtimeId/],
      ] as const) {
        assert.throws(() => proposeCompanionCard({ kind: 'conversation.start', payload: { ...payload, ...change } }, T0),
          companionError(status, code, message), JSON.stringify(change));
      }
      assert.equal(proposeCompanionCard({ kind: 'conversation.start', payload: { ...payload, title: 'x'.repeat(80) } }, T0).payload.title, 'x'.repeat(80));
    });

    test('Apply starts the conversation once, through the injected starter, and records the delegation', async () => {
      workspace('ws-1', 'My Project');
      const calls: unknown[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      setCompanionCardDeps({
        startConversation: async (input) => {
          calls.push(input);
          await gate;
          return { workspaceId: input.workspaceId, nodeId: 'n-started', title: input.title };
        },
      });
      const card = proposeCompanionCard({ kind: 'conversation.start', payload }, T0);
      const first = applyCompanionCard(card.id, T0 + 1);
      const second = await applyCompanionCard(card.id, T0 + 2);
      assert.equal(second.outcome, 'not_pending', 'a second click while it starts finds the card applied');
      release();
      const decision = await first;
      assert.deepEqual([decision.outcome, decision.card.status, decision.changed], ['applied', 'applied', []]);
      assert.deepEqual(calls, [{ workspaceId: 'ws-1', title: 'Fix the pipeline', text: 'The pipeline MyService is blocked in Gamma.\nLook at the deploy.' }]);
      assert.deepEqual([getDelegation('n-started')?.workspaceId, getDelegation('n-started')?.title], ['ws-1', 'Fix the pipeline']);
      assert.deepEqual([getDelegation('n-started')?.state, getDelegation('n-started')?.origin], ['following', 'card'], 'the agent follows it (DESIGN-v2 §4)');
      assert.equal((await applyCompanionCard(card.id, T0 + 3)).outcome, 'not_pending');
      assert.equal(calls.length, 1);
    });

    test('a conversation that cannot start fails the card with the reason and records nothing', async () => {
      workspace('ws-1', 'My Project');
      const unavailable = proposeCompanionCard({ kind: 'conversation.start', payload }, T0);
      const noStarter = await applyCompanionCard(unavailable.id, T0 + 1);
      assert.deepEqual([noStarter.outcome, noStarter.card.error], ['failed', 'Starting conversations is not available on this backend']);

      setCompanionCardDeps({ startConversation: async () => { throw new Error('Claude is not signed in'); } });
      const refused = proposeCompanionCard({ kind: 'conversation.start', payload }, T0);
      const failed = await applyCompanionCard(refused.id, T0 + 1);
      assert.deepEqual([failed.outcome, failed.card.status, failed.card.error], ['failed', 'failed', 'Claude is not signed in']);
      assert.equal(getCard(refused.id)?.status, 'failed');

      let started = 0;
      setCompanionCardDeps({ startConversation: async (input) => { started += 1; return { ...input, nodeId: 'n-x' }; } });
      const archivedSince = proposeCompanionCard({ kind: 'conversation.start', payload }, T0);
      workspace('ws-1', 'My Project', { archived_at: T0 + 1 });
      const stale = await applyCompanionCard(archivedSince.id, T0 + 2);
      assert.equal(stale.outcome, 'failed');
      assert.match(stale.card.error ?? '', /My Project is archived/);
      assert.equal(started, 0, 'nothing starts in a workspace that no longer takes conversations');
      assert.deepEqual(listOpenDelegations(), []);
    });

    /** A starter the test settles: it resolves or rejects when told. */
    function gatedStarter() {
      let settle!: (error?: Error) => void;
      const gate = new Promise<void>((resolve, reject) => { settle = (error) => (error ? reject(error) : resolve()); });
      setCompanionCardDeps({
        startConversation: async (input) => {
          await gate;
          return { workspaceId: input.workspaceId, nodeId: 'n-started', title: input.title };
        },
      });
      return { succeed: () => settle(), fail: (message: string) => settle(new Error(message)) };
    }

    /** What a Companion turn does with card results meanwhile: read them, then mark what it read told. */
    function turnReadsCardResults(now: number): string[] {
      const cards = listUnreportedCards();
      markCardsReported(cards.map((card) => card.id), now);
      return cards.map((card) => card.id);
    }

    test('a conversation that fails after Apply is reported as failed, even when a turn ran while it started', async () => {
      workspace('ws-1', 'My Project');
      const starter = gatedStarter();
      const card = proposeCompanionCard({ kind: 'conversation.start', payload }, T0);
      const applying = applyCompanionCard(card.id, T0 + 1);
      // While it starts: applied (a second click starts nothing, Dismiss cannot touch it), but no turn is told yet.
      assert.equal(getCard(card.id)?.status, 'applied');
      assert.deepEqual(turnReadsCardResults(T0 + 2), [], 'a turn that runs meanwhile is not told "applied"');
      assert.equal(markCardsReported([card.id], T0 + 2), 0, 'nor can a turn that marks its own cards mark this one');
      assert.equal((await applyCompanionCard(card.id, T0 + 3)).outcome, 'not_pending');
      assert.equal(dismissCompanionCard(card.id, T0 + 3).outcome, 'not_pending');

      starter.fail('Kiro is not signed in');
      const decision = await applying;
      assert.deepEqual([decision.outcome, decision.card.status, decision.card.error], ['failed', 'failed', 'Kiro is not signed in']);
      assert.deepEqual(listUnreportedCards().map((unreported) => [unreported.id, unreported.status, unreported.error]),
        [[card.id, 'failed', 'Kiro is not signed in']], 'the next turn hears how it ended');
      assert.deepEqual(turnReadsCardResults(T0 + 5), [card.id]);
      assert.deepEqual(listUnreportedCards(), [], 'told once');
      assert.deepEqual(listOpenDelegations(), []);
    });

    test('a conversation that starts is reported as applied once it started, never before', async () => {
      workspace('ws-1', 'My Project');
      const starter = gatedStarter();
      const card = proposeCompanionCard({ kind: 'conversation.start', payload }, T0);
      const applying = applyCompanionCard(card.id, T0 + 1);
      assert.deepEqual(turnReadsCardResults(T0 + 2), []);
      starter.succeed();
      assert.equal((await applying).outcome, 'applied');
      assert.equal(getDelegation('n-started')?.workspaceId, 'ws-1');
      assert.deepEqual(listUnreportedCards().map((unreported) => [unreported.id, unreported.status]), [[card.id, 'applied']]);
      assert.deepEqual(turnReadsCardResults(T0 + 3), [card.id]);
      assert.deepEqual(listUnreportedCards(), []);
    });

    test('a start a stopped Michi left behind is settled as failed after ten minutes; one still starting here is left alone', async () => {
      workspace('ws-1', 'My Project');
      // As a Michi that went down mid-start leaves it: applied, held out of the card results.
      const abandoned = proposeCompanionCard({ kind: 'conversation.start', payload }, T0);
      decideCard(abandoned.id, 'applied', T0);
      getDb().prepare('UPDATE companion_cards SET reported_at = -1 WHERE id = ?').run(abandoned.id);
      const starter = gatedStarter();
      const live = proposeCompanionCard({ kind: 'conversation.start', payload }, T0);
      const applying = applyCompanionCard(live.id, T0);

      assert.equal(settleAbandonedStarts(T0 + 5 * 60_000), 0, 'a start may take a while');
      assert.deepEqual(listUnreportedCards(), []);
      assert.equal(settleAbandonedStarts(T0 + 11 * 60_000), 1, 'only the abandoned one');
      assert.deepEqual([getCard(abandoned.id)?.status, getCard(abandoned.id)?.error], ['failed', COMPANION_ABANDONED_START_ERROR]);
      assert.deepEqual(listUnreportedCards().map((unreported) => unreported.id), [abandoned.id]);
      assert.equal(getCard(live.id)?.status, 'applied');

      starter.succeed();
      assert.equal((await applying).outcome, 'applied');
      assert.equal(settleAbandonedStarts(T0 + 20 * 60_000), 0, 'nothing is held any more');
      assert.deepEqual(listUnreportedCards().map((unreported) => [unreported.id, unreported.status]).sort(),
        [[abandoned.id, 'failed'], [live.id, 'applied']].sort());
    });
  });

  describe('what the user reads before Apply', () => {
    test('the card a snapshot carries holds the whole text Apply writes, however long; only the summary is a short headline', async () => {
      const goalText = 'Ship the auth migration: '.padEnd(COMPANION_LIMITS.maxGoalChars, 'g');
      const reminderText = 'Call the vendor about the contract. '.padEnd(COMPANION_REMINDER_TEXT_MAX_CHARS, 'r');
      const rules = ['No pings before 10:00.', 'Group CR updates into one message.', ...Array.from({ length: 40 }, (_, line) => `Rule ${line}: ${'x'.repeat(30)}`)]
        .join('\n').slice(0, COMPANION_LIMITS.maxRulesChars).trimEnd();
      assert.equal(Array.from(goalText).length, COMPANION_LIMITS.maxGoalChars);
      assert.ok(rules.length > 1500 && rules.split('\n').length > 30);
      const existing = addGoal('Old goal', T0);

      const proposed = [
        proposeCompanionCard({ kind: 'goal.add', payload: { text: goalText } }, T0),
        proposeCompanionCard({ kind: 'goal.update', payload: { goalId: existing.id, text: goalText } }, T0),
        proposeCompanionCard({ kind: 'reminder.add', payload: { text: reminderText, at: T0 + HOUR } }, T0),
        proposeCompanionCard({ kind: 'rules.update', payload: { rules } }, T0),
      ];
      // What GET /companion sends: the pending cards as DTOs.
      const shown = new Map(listPendingCards(T0).map(cardDto).map((card) => [card.kind, card]));
      assert.equal(shown.get('goal.add')?.payload.text, goalText);
      assert.equal(shown.get('goal.update')?.payload.text, goalText);
      assert.equal(shown.get('reminder.add')?.payload.text, reminderText);
      assert.equal(shown.get('rules.update')?.payload.rules, rules, 'every line, nothing collapsed');
      for (const card of shown.values()) {
        assert.ok(Array.from(card.summary).length <= 300, `${card.kind}: the summary is a headline`);
        assert.match(card.summary, /…"/, `${card.kind}: and says it is cut`);
      }

      // Apply writes exactly what the card showed.
      for (const card of proposed) assert.equal((await applyCompanionCard(card.id, T0 + 1)).outcome, 'applied', card.kind);
      assert.deepEqual(listGoals().map((goal) => goal.text), [goalText, goalText]);
      assert.equal(listReminders()[0]?.text, reminderText);
      assert.equal(getCompanionRules(), rules);
    });
  });
});
