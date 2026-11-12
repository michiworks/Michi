import './isolatedConfigDir';
import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * The assistant purposes `main` and `checkin` (DESIGN-v2 §2.2, §2.5, §1.3):
 * V is the user's one conversation with the agent, on the open profile; a
 * check-in node S (`n-cmph-…`) is closed by its id alone, binds with the
 * check-in instructions, the closed profile and its own working directory
 * (its runtime and reasoning: assistantCompanionReasoning.test.ts), and is
 * never in History, activated or re-picked. On the message route V takes the Spaces
 * fields or the Scheduled context (not both), always gets [COMPANION
 * CONTEXT] in §1.3's order, still sends when the rules cannot be read (the
 * user message says so), and S is refused before any lookup. Temp
 * MICHI_DATA_DIR per test; the message route runs on a fake live session.
 * The runtimes' closed-profile flags and verdicts: companionGuard.test.ts;
 * the catalogs per runtime: companionToolsCatalog.test.ts.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { COMPANION_LIMITS, MICHI_ASSISTANT_MARKER, checkinNodeId } from 'michi-shared';
import type { AgentSession } from '../src/agents/types';
import { clearAllSessions, registerSession } from '../src/agents/sessionRegistry';
import { resolveAssistantBinding } from '../src/assistant/binding';
import { assistantPurposeKey, isAssistantScheduleTurn } from '../src/assistant/identity';
import { assistantInstructionsFor, assistantToolProfile } from '../src/assistant/policy';
import {
  AssistantSettingsError,
  activateAssistantConversation,
  assistantCwd,
  assistantPurposeOf,
  checkinCwd,
  ensureAssistant,
  isAssistantNode,
  listAssistantConversations,
  updateAssistantSettings,
} from '../src/assistant/store';
import { companionCheckinInstructions, companionMainInstructions } from '../src/services/companion/prompts';
import { patchCompanionSettings } from '../src/services/companion/settings';
import { ChatManager } from '../src/services/chatManager';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveMessage } from '../src/services/dbRepository';
import { setupMichiRoutes } from '../src/routes/michi';
import { makeCheckinNode } from './helpers/checkinNodes';

const CHECKIN = assistantToolProfile('checkin');

describe('assistant purposes: main and checkin (DESIGN-v2 §2.2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-purpose-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    clearAllSessions();
  });

  afterEach(() => {
    clearAllSessions();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a check-in node is checkin by its id alone, with or without its meta row; any other conversation is main', () => {
    const v = ensureAssistant();
    assert.equal(assistantPurposeOf(v.nodeId), 'main');
    assert.ok(isAssistantNode(v.nodeId));
    const s = makeCheckinNode(v.workspaceId);
    assert.equal(assistantPurposeOf(s), 'checkin');
    getDb().prepare('DELETE FROM meta WHERE key = ?').run(assistantPurposeKey(s));
    assert.equal(assistantPurposeOf(s), 'checkin', 'deleting the meta row keeps S closed');
    // A meta row saying anything else cannot open it either.
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey(s), 'spaces');
    assert.equal(assistantPurposeOf(s), 'checkin');
    assert.equal(assistantPurposeOf(checkinNodeId('never-made')), 'checkin', 'a purged or never-made S id too');
    assert.ok(isAssistantNode(s), 'S runs as the assistant, never as a worker, but checkin');
    for (const [recorded, purpose] of [['companion', 'checkin'], ['checkin', 'checkin'], ['schedule', 'main'], ['spaces', 'main'], ['something-new', 'main']] as const) {
      getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey('n-other'), recorded);
      assert.equal(assistantPurposeOf('n-other'), purpose, recorded);
    }
    assert.equal(assistantPurposeOf(null), 'main');
  });

  test('S binds closed, in its own directory, with the check-in instructions; V binds open with the main ones; a rename keeps both', () => {
    const v = ensureAssistant();
    const s = makeCheckinNode(v.workspaceId, 'run-1', { meta: false });
    const sBinding = resolveAssistantBinding(s)!;
    assert.deepEqual(sBinding.sessionOptions.toolProfile, CHECKIN, 'closed without its meta row (§2.5)');
    assert.equal(sBinding.sessionOptions.cwd, checkinCwd());
    assert.equal(checkinCwd(), path.join(path.resolve(tmpDir), 'companion', 'checkin', '.michi'));
    assert.equal(fs.statSync(checkinCwd()).mode & 0o777, 0o700);
    const vBinding = resolveAssistantBinding(v.nodeId)!;
    assert.deepEqual(vBinding.sessionOptions.toolProfile, { assistant: true });
    assert.equal(vBinding.sessionOptions.cwd, assistantCwd());
    assert.notEqual(sBinding.sessionOptions.cwd, vBinding.sessionOptions.cwd, 'discarding S\'s native record can never reach V\'s');

    assert.equal(assistantInstructionsFor('main'), companionMainInstructions());
    assert.equal(assistantInstructionsFor('checkin'), companionCheckinInstructions());
    assert.equal(vBinding.sessionOptions.bootstrapInstructions, companionMainInstructions());
    assert.equal(sBinding.sessionOptions.bootstrapInstructions, companionCheckinInstructions());
    for (const instructions of [companionMainInstructions(), companionCheckinInstructions()]) {
      assert.ok(instructions.startsWith(`${MICHI_ASSISTANT_MARKER}.`), 'opens with the marker Michi filtering relies on');
    }
    assert.equal(sBinding.effectiveDefinition.name, 'Michi check-in');
    assert.notEqual(sBinding.profileHash, vBinding.profileHash);
    patchCompanionSettings({ displayName: 'Nova' });
    assert.equal(resolveAssistantBinding(v.nodeId)!.profileHash, vBinding.profileHash, 'no name in the instructions (R2.13)');
    assert.equal(resolveAssistantBinding(s)!.profileHash, sBinding.profileHash);
  });

  test('S is never in History, never activated and never re-picked; the old Scheduled conversation is', () => {
    const v = ensureAssistant();
    saveMessage({ id: 'v-q', node_id: v.nodeId, role: 'user', content: 'What changed today', seq: 0, created_at: 40 });
    const s = makeCheckinNode(v.workspaceId);
    saveMessage({ id: 's-a', node_id: s, role: 'assistant', content: 'Two CRs need you.', seq: 0, created_at: 50 });
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey(s), 'spaces');
    assert.deepEqual(listAssistantConversations(50).items.map((item) => item.nodeId), [v.nodeId], 'not even with its meta row rewritten');
    assert.throws(() => activateAssistantConversation(s), AssistantSettingsError);
    assert.throws(() => updateAssistantSettings({ nodeId: s, reasoning: 'low' }), AssistantSettingsError);
  });

  describe('the message route (§1.3)', () => {
    let server: ReturnType<typeof express.application.listen>;
    let baseUrl: string;
    let sent: string[];

    function liveSession(id: string): AgentSession {
      return {
        id, runtimeId: 'claude', runtimeProfileHash: null, currentModelId: null,
        getHistory: () => [], getPendingAssistant: () => undefined,
        async *send(text: string) { sent.push(text); yield { kind: 'turn_end', stopReason: 'end_turn' }; },
        async cancel() {},
      } as unknown as AgentSession;
    }

    beforeEach(async () => {
      sent = [];
      const app = express();
      app.use(express.json());
      app.use('/api', setupMichiRoutes(new ChatManager(undefined, tmpDir)));
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    });

    const post = (nodeId: string, body: unknown) => fetch(`${baseUrl}/chats/${nodeId}/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    const userRows = (nodeId: string) => (getDb().prepare(`SELECT content, metadata FROM messages WHERE node_id = ? AND role = 'user' ORDER BY seq`)
      .all(nodeId) as Array<{ content: string; metadata: string | null }>)
      .map((row) => ({ content: row.content, metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null }));

    test('every message gets [COMPANION CONTEXT]: area context, first-run note, the block, the reply note, then the user\'s words', async () => {
      const v = ensureAssistant();
      registerSession(liveSession(v.nodeId), null);
      patchCompanionSettings({ displayName: 'Nova' });
      const plain = await post(v.nodeId, { text: 'What needs me?', turnId: 'turn-plain' });
      assert.equal(plain.status, 200);
      await plain.text();
      assert.ok(sent[0].startsWith('[COMPANION CONTEXT'), sent[0]);
      assert.match(sent[0], /Nova/);
      assert.ok(sent[0].endsWith('\n\nWhat needs me?'));

      const spaces = await post(v.nodeId, { text: 'Tidy this page', turnId: 'turn-spaces', metaAgentContext: { pageId: 'pg-1', pages: [{ id: 'pg-1', title: 'Plan' }] } });
      assert.equal(spaces.status, 200);
      await spaces.text();
      const wire = sent[1];
      const at = (needle: string) => { const index = wire.indexOf(needle); assert.ok(index >= 0, `${needle} in ${wire}`); return index; };
      assert.ok(at('[Spaces context') < at('[COMPANION CONTEXT') && at('[COMPANION CONTEXT') < at('[How to answer') && at('[How to answer') < at('Tidy this page'),
        'area context → [COMPANION CONTEXT] → reply note → the user\'s text');
      assert.ok(wire.startsWith('[Spaces context'));

      const schedule = await post(v.nodeId, { text: 'Make a daily job', turnId: 'turn-schedule', metaAgentContext: { schedule: { workspaceId: null } } });
      assert.equal(schedule.status, 200);
      await schedule.text();
      assert.ok(sent[2].startsWith('[Scheduled context'));
      assert.ok(sent[2].indexOf('[COMPANION CONTEXT') < sent[2].indexOf('Make a daily job'));
      // A job this turn creates is one "Create with agent" starts over for; the Spaces turn's is not (w2-fix D6).
      assert.equal(isAssistantScheduleTurn(v.nodeId, 'turn-schedule'), true);
      assert.equal(isAssistantScheduleTurn(v.nodeId, 'turn-spaces'), false);
      assert.deepEqual(userRows(v.nodeId).map((row) => row.content), ['What needs me?', 'Tidy this page', 'Make a daily job'], 'the bubbles show what the user wrote');
    });

    test('the Spaces fields and the Scheduled context together are refused; an ordinary chat takes neither', async () => {
      const v = ensureAssistant();
      registerSession(liveSession(v.nodeId), null);
      const both = await post(v.nodeId, { text: 'hi', turnId: 'turn-both', metaAgentContext: { pageId: 'pg-1', schedule: { workspaceId: null } } });
      assert.equal(both.status, 400);
      assert.equal((await both.json() as { code: string }).code, 'invalid_meta_agent_context');
      assert.deepEqual(sent, []);
    });

    test('unreadable rules: the message still goes, without the block, and its user message says so; a client\'s own companionTurn is dropped', async () => {
      const v = ensureAssistant();
      registerSession(liveSession(v.nodeId), null);
      // Longer than rules can be: readCompanionRules refuses them.
      getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('companion:rules', 'x'.repeat(COMPANION_LIMITS.maxRulesChars + 1));
      const accepted = await post(v.nodeId, { text: 'What needs me?', turnId: 'turn-norules', userMetadata: { companionTurn: { startTaint: 'collector' }, quotedText: 'q' } });
      assert.equal(accepted.status, 200);
      await accepted.text();
      assert.deepEqual(sent, ['What needs me?'], 'no [COMPANION CONTEXT]');
      const [row] = userRows(v.nodeId);
      assert.deepEqual(row.metadata?.companionTurn, { rulesUnavailable: true }, 'the route\'s own record, not the client\'s');
      assert.equal(row.metadata?.quotedText, 'q');

      getDb().prepare('DELETE FROM meta WHERE key = ?').run('companion:rules');
      const forged = await post(v.nodeId, { text: 'Again', turnId: 'turn-forged', userMetadata: { companionTurn: { rulesUnavailable: true }, companionPost: { runId: 'x' }, companionSend: { runId: 'y' } } });
      assert.equal(forged.status, 200);
      await forged.text();
      const second = userRows(v.nodeId)[1].metadata ?? {};
      assert.deepEqual(['companionTurn', 'companionPost', 'companionSend'].filter((key) => key in second), []);
    });

    test('a check-in node is refused with 409 before any lookup, made or not; a reserved turn id is a 400', async () => {
      const v = ensureAssistant();
      const s = makeCheckinNode(v.workspaceId);
      registerSession(liveSession(s), null);
      for (const nodeId of [s, checkinNodeId('purged')]) {
        const refused = await post(nodeId, { text: 'hi' });
        assert.equal(refused.status, 409, nodeId);
        assert.equal((await refused.json() as { code: string }).code, 'checkin_node');
      }
      registerSession(liveSession(v.nodeId), null);
      const reserved = await post(v.nodeId, { text: 'hi', turnId: 'cmp-run-9' });
      assert.equal(reserved.status, 400);
      assert.equal((await reserved.json() as { code: string }).code, 'reserved_turn_id');
      assert.deepEqual(sent, []);
    });
  });
});
