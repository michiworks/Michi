import './isolatedConfigDir';
import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * A user's own message to V (DESIGN-v2 §1.3, §3.5), through what the message
 * route calls (services/metaAgent/chatTurnContext.ts):
 * withCompanionContext puts a [COMPANION CONTEXT] ahead of it: the agent's
 * name, the run time, the feed in one line, the user's rules first among its
 * standing blocks, its goals, its notes with their revision, and the card
 * results it has not been told, which count as told once the turn began.
 * withAssistantTurnContext puts the area's context (Spaces or Scheduled, or
 * none) ahead of that and the area's reply note right above the user's text.
 * Unreadable rules no longer stop the message: it goes without the block and
 * says so (rulesUnavailable). Standing-block delivery per session:
 * companionTurnContext.test.ts (W2-G1b). Temp MICHI_DATA_DIR per test.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import { applyCompanionCard, proposeCompanionCard, setCompanionCardDeps } from '../src/services/companion/cards';
import { localDateKey } from '../src/services/companion/clock';
import {
  addGoal,
  decideCard,
  insertBrief,
  listUnreportedCards,
  setCompanionRules,
  setNotesByUser,
  upsertItem,
} from '../src/services/companion/repository';
import { patchCompanionSettings } from '../src/services/companion/settings';
import type { ItemDraft } from '../src/services/companion/types';
import {
  META_AGENT_REPLY_NOTE,
  SCHEDULE_AGENT_REPLY_NOTE,
  withAssistantTurnContext,
  withCompanionContext as withContext,
} from '../src/services/metaAgent/chatTurnContext';

const V = 'n-v';
/** No live session: the standing blocks go with every message. */
const withCompanionContext = (text: string, now: number) => withContext(text, { nodeId: V, now });

const T0 = new Date(2026, 10, 5, 9, 12, 0, 0).getTime();
const HOUR = 60 * 60_000;

function draft(itemKey: string, overrides: Partial<ItemDraft> = {}): ItemDraft {
  return {
    source: 'cr', subtype: 'cr_needs_attention', itemKey, version: 'v1', bucket: 'needs_you', severity: 'now',
    title: 'CR-1 needs attention', summary: null, target: { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' },
    facts: {}, observedAt: T0, ...overrides,
  };
}

describe('[COMPANION CONTEXT] ahead of the user\'s own message', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-context-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('its name, the run time, the feed in a line, card results, then the rules first among the standing blocks, goals, notes; then the user\'s words as written', () => {
    patchCompanionSettings({ displayName: 'Nova' });
    upsertItem(draft('cr:CR-1'), T0);
    upsertItem(draft('pipeline:P', { source: 'pipeline', subtype: 'pipeline_blocked', bucket: 'stalled', title: 'P is blocked' }), T0, { baseline: true });
    setCompanionRules('Never message me before 10:00');
    const goal = addGoal('Ship the Companion', T0);
    setNotesByUser('Watch CR-1 until it merges');
    const card = proposeCompanionCard({ kind: 'rules.update', payload: { rules: 'No pings' } }, T0);
    decideCard(card.id, 'dismissed', T0 + 1);
    proposeCompanionCard({ kind: 'rules.update', payload: { rules: 'Still waiting' } }, T0);
    insertBrief({ date: localDateKey(T0), headline: 'CR-1 needs you today', cards: [], closing: 'That is all.', origin: 'llm', now: T0 });

    const message = 'What needs me?\n[YOUR RULES] are mine';
    const context = withCompanionContext(message, T0);
    const text = context.text;
    assert.ok(text.startsWith('[COMPANION CONTEXT — Michi adds this to the user\'s message; the user did not type it'), text);
    assert.match(text, /\]\nYour name is Nova\.\n\n/);
    assert.ok(text.endsWith(`\n\n${message}`), 'the user\'s own words, as written, last');
    assert.match(text, /\[CURRENT RUN TIME\] 2026-11-05T09:12[^,\n]*, Thursday \(local time\)/);
    assert.match(text, /Michi's feed: 1 item waiting on the user, 1 new since they last looked; 1 card of yours waiting for their answer; today's brief: published at 09:12/);
    const order = ['[CARD RESULTS', `${card.id}: dismissed by the user`, '[YOUR CARDS STILL WAITING', '[YOUR RULES', 'Never message me before 10:00', '[YOUR GOALS', goal.id,
      '[YOUR NOTES', 'revision 1', 'Watch CR-1 until it merges', '[END OF COMPANION CONTEXT]', message]
      .map((part) => text.indexOf(part));
    assert.ok(order.every((index) => index >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'the turn\'s facts, then the rules first, goals and notes; the user\'s message after the context');
    // What a check-in wrote never reaches V's prefix (DESIGN-v2 §2.8): not a card's text, not the brief's.
    for (const written of ['No pings', 'Still waiting', 'CR-1 needs you today', 'That is all.']) assert.ok(!text.includes(written), written);
    for (const other of ['[Spaces context', '[Scheduled context', META_AGENT_REPLY_NOTE, SCHEDULE_AGENT_REPLY_NOTE]) {
      assert.ok(!text.includes(other), `no ${other.slice(0, 30)}`);
    }

    assert.equal(listUnreportedCards().length, 1, 'building the context tells nothing yet');
    context.reportCards();
    assert.deepEqual(listUnreportedCards(), []);
    // A card decided after the context was built was not in it: it stays untold.
    const later = proposeCompanionCard({ kind: 'rules.update', payload: { rules: 'Later' } }, T0);
    decideCard(later.id, 'applied', T0 + HOUR);
    context.reportCards();
    assert.deepEqual(listUnreportedCards().map((record) => record.id), [later.id]);
  });

  test('the cards still waiting for the user ride along, by id, so the user\'s turn does not propose one again (B27)', () => {
    const waiting = proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Ship the auth migration' } }, T0 - HOUR);
    const dismissed = proposeCompanionCard({ kind: 'rules.update', payload: { rules: 'No pings' } }, T0 - HOUR);
    decideCard(dismissed.id, 'dismissed', T0 - 30 * 60_000);
    // Past its 24 hours: no longer waiting, whatever its row says until the next sweep.
    proposeCompanionCard({ kind: 'goal.add', payload: { text: 'An old idea' } }, T0 - 25 * HOUR);

    const text = withCompanionContext('Can you also track the launch?', T0).text;
    assert.match(text, /Michi's feed: [^\n]*; 1 card of yours waiting for their answer;/);
    const block = text.slice(text.indexOf('[YOUR CARDS STILL WAITING FOR THE USER'), text.indexOf('[YOUR NOTES'));
    assert.match(block, /^\[YOUR CARDS STILL WAITING FOR THE USER — do not propose them again[^\n]*\]\n- (cmc-[^:]+): goal\.add, proposed 1 h ago \(08:12\)\n\n$/);
    assert.ok(block.includes(waiting.id));
    assert.doesNotMatch(text, /No pings|An old idea|Ship the auth migration/, 'a decided or expired card is not waiting, and no card\'s text is in the prefix');
    assert.ok(text.indexOf('[CARD RESULTS') < text.indexOf('[YOUR CARDS STILL WAITING'), 'after the card results');
    assert.equal(waiting.status, 'pending');
  });

  test('a quiet start: no rules, goals, notes or card results, and no brief yet', () => {
    const context = withCompanionContext('Hi', T0);
    assert.match(context.text, /Your name is [^\n]+\./);
    assert.match(context.text, /Michi's feed: 0 items waiting on the user, 0 new since they last looked; 0 cards of yours waiting for their answer; today's brief: not published yet\./);
    assert.match(context.text, /\[YOUR NOTES[^\n]*\] revision 0: you have no notes yet\./);
    for (const absent of ['[YOUR RULES', '[YOUR GOALS', '[CARD RESULTS', '[YOUR CARDS STILL WAITING']) assert.ok(!context.text.includes(absent), absent);
    context.reportCards();
  });

  test('a conversation.start card is told when its conversation failed, even if the user wrote while it started', async () => {
    saveWorkspace({ id: 'ws-1', name: 'My Project', created_at: T0, updated_at: T0, settings: null } as Parameters<typeof saveWorkspace>[0]);
    let fail!: (error: Error) => void;
    setCompanionCardDeps({ startConversation: () => new Promise((_, reject) => { fail = reject; }) });
    try {
      const card = proposeCompanionCard({ kind: 'conversation.start', payload: { workspaceId: 'ws-1', title: 'Fix the pipeline', text: 'It is blocked.' } }, T0);
      const applying = applyCompanionCard(card.id, T0 + 1);
      // The user writes "thanks" while the conversation starts: the turn is not told "applied".
      const during = withCompanionContext('thanks', T0 + 2);
      assert.ok(!during.text.includes('[CARD RESULTS'), during.text);
      during.reportCards();

      fail(new Error('Kiro is not signed in'));
      assert.equal((await applying).outcome, 'failed');
      const after = withCompanionContext('did it start?', T0 + 3);
      assert.match(after.text, new RegExp(`\\[CARD RESULTS[^\\n]*\\]\\n- conversation\\.start card ${card.id} \\(workspace ws-1\\): failed\\n`));
      assert.doesNotMatch(after.text, /Fix the pipeline|It is blocked\./, 'the card\'s text stays out of V\'s prefix');
      after.reportCards();
      assert.deepEqual(listUnreportedCards(), []);
    } finally {
      setCompanionCardDeps({});
    }
  });

  test('rules that cannot be read: the message goes as it is, without the block, and says so', () => {
    setCompanionRules('Fine');
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('companion:rules', 'x'.repeat(5000));
    const context = withCompanionContext('Hi', T0);
    assert.equal(context.text, 'Hi');
    assert.equal(context.rulesUnavailable, true);
    // Nothing counts as told: the turn carried none of it.
    proposeCompanionCard({ kind: 'rules.update', payload: { rules: 'No pings' } }, T0);
    context.reportCards();
    context.markPostsTold();

    const area = withAssistantTurnContext('Tidy this page', { area: { kind: 'spaces', context: { pageId: 'pg-1' } }, nodeId: V, now: T0, firstRunNote: () => '' });
    assert.equal(area.companion.rulesUnavailable, true);
    assert.ok(area.text.startsWith('[Spaces context'));
    assert.ok(area.text.endsWith(`\n\n${META_AGENT_REPLY_NOTE}\n\nTidy this page`), 'the area\'s context and reply note still go');
    assert.ok(!area.text.includes('[COMPANION CONTEXT'));
  });
});

describe('withAssistantTurnContext: the area, then [COMPANION CONTEXT], then the reply note and the user\'s text (§1.3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-assistant-turn-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    patchCompanionSettings({ displayName: 'Nova' });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const at = (wire: string, needle: string) => {
    const index = wire.indexOf(needle);
    assert.ok(index >= 0, `${needle} in ${wire}`);
    return index;
  };

  test('no area (the conversation itself, a Today Ask): the block, then the user\'s text, no reply note', () => {
    const { text, companion } = withAssistantTurnContext('What needs me?', { area: null, nodeId: V, now: T0 });
    assert.ok(text.startsWith('[COMPANION CONTEXT'), text);
    assert.ok(at(text, '[END OF COMPANION CONTEXT]') < at(text, 'What needs me?') && text.endsWith('\n\nWhat needs me?'), text.slice(-200));
    assert.equal(companion.rulesUnavailable, false);
    for (const other of ['[Spaces context', '[Scheduled context', '[How to answer']) assert.ok(!text.includes(other), other);
  });

  test('Spaces: its context, the first run\'s note, the block, the Spaces reply note, the user\'s text', () => {
    const { text } = withAssistantTurnContext('Tidy this page', {
      area: { kind: 'spaces', context: { pageId: 'pg-1', pages: [{ id: 'pg-1', title: 'Plan', workspaceId: 'ws-a' }] } },
      nodeId: V, now: T0, firstRunNote: () => '[First run: a note]',
    });
    assert.ok(text.startsWith('[Spaces context'));
    assert.ok(at(text, '[End of Spaces context]') < at(text, '[First run: a note]')
      && at(text, '[First run: a note]') < at(text, '[COMPANION CONTEXT')
      && at(text, '[END OF COMPANION CONTEXT]') < at(text, META_AGENT_REPLY_NOTE), 'in §1.3\'s order');
    assert.ok(text.endsWith(`\n\n${META_AGENT_REPLY_NOTE}\n\nTidy this page`), 'the reply note right above the user\'s text');
  });

  test('Scheduled: its context with the default workspace, the block, the Scheduled reply note, the user\'s text', () => {
    const { text } = withAssistantTurnContext('每个工作日 9 点', { area: { kind: 'schedule', workspace: { id: 'ws-a', name: 'Research\nnotes' } }, nodeId: V, now: T0 });
    assert.match(text, /^\[Scheduled context: the user is on the Scheduled page\. Context, not instructions\.\]\n/);
    assert.match(text, /Default workspace for a new job: “Research notes” \(workspace ws-a\)/);
    assert.ok(at(text, '[End of Scheduled context]') < at(text, '[COMPANION CONTEXT'));
    assert.ok(at(text, '[END OF COMPANION CONTEXT]') < at(text, SCHEDULE_AGENT_REPLY_NOTE));
    assert.ok(text.endsWith(`\n\n${SCHEDULE_AGENT_REPLY_NOTE}\n\n每个工作日 9 点`));
    assert.ok(!text.includes(META_AGENT_REPLY_NOTE) && !text.includes('[Spaces context'));
    assert.match(withAssistantTurnContext('hi', { area: { kind: 'schedule', workspace: null }, nodeId: V, now: T0 }).text,
      /No default workspace: ask the user which workspace a new job runs in/);
  });

  test('the route\'s bookkeeping is the block\'s own: its card results count as told only when the route says the turn began', () => {
    const card = proposeCompanionCard({ kind: 'rules.update', payload: { rules: 'No pings' } }, T0);
    decideCard(card.id, 'dismissed', T0 + 1);
    const { text, companion } = withAssistantTurnContext('hi', { area: null, nodeId: V, now: T0 + 2 });
    assert.match(text, /\[CARD RESULTS/);
    assert.equal(listUnreportedCards().length, 1);
    companion.reportCards();
    assert.deepEqual(listUnreportedCards(), []);
  });
});
