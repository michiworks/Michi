/**
 * w3-fix D23, D19: Michi's own MCP tools hold the consequence rule
 * themselves, whatever the runtime. A call of a tool that leaves the machine
 * (toolEffects.ts `egress`) or starts work the turn's outside content would
 * not travel with (`indirect` but send_to_thread and start_conversation),
 * from a guarded turn (Michi drove it, or it holds outside content), runs
 * only after the user approved that call: on Codex (and Kiro tools the
 * user's agent pre-allows) no runtime prompt came, so the dispatch asks
 * through ask_user, or refuses without one; where Michi's runtime gate
 * already asked (Claude's hook, Kiro's request_permission, through the
 * permission port's `approved` note) it runs without a second question,
 * once per approval and turn. Reads, Michi-internal and local writes,
 * unguarded turns and tools that ask for themselves are untouched;
 * send_to_thread runs, and its message carries the outside content.
 * Real MCP catalog (buildMcpServerForSlot); temp MICHI_DATA_DIR per test.
 */

import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalCoordinator } from 'michi-runtime/internal/core/approvals';
import type { StartRequestedSelfTurnArgs, StartedRequestedSelfTurn } from '../src/agents/chatHub';
import { ChatApprovalState, michiPermissionPolicy } from '../src/agents/chatApprovalState';
import { chatOwner } from '../src/agents/ownerMapping';
import { BACKGROUND_TOOL_REFUSAL, TAINTED_TOOL_ASK_REASON, __resetRuntimeToolApprovals, taintedMichiToolGate } from '../src/agents/taintedToolGate';
import { activeTurnRow, makeCheckinNode } from './helpers/checkinNodes';
import { configureThreadMessaging } from '../src/agents/threadMessageTool';
import type { AgentSession } from '../src/agents/types';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { McpSlotRegistry, buildMcpServerForSlot, type McpSlot } from '../src/services/mcpServer';
import { getTurnTrust, recordCompanionTaint, recordUntrustedSource } from '../src/services/turnTrust';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import { registerLiveSession } from './helpers/liveSession';

const WS = 'ws-a';
const CHAT = 'n-a';
const TARGET = 'n-b';

type Question = { question: string; header?: string; options: Array<{ label: string }>; multiSelect: boolean };
type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>;

let tmpDir: string;
let turns = 0;
let turnId: string;
let spawned: number;
let asked: Question[][];
let answer: string | null;

function seedChat(id: string): void {
  saveTree({ id: `t-${id}`, workspace_id: WS, root_node_id: id, last_active_at: 1, created_at: 1 });
  saveNode({ id, workspace_id: WS, tree_id: `t-${id}`, kind: 'chat', title: `Title ${id}`, status: 'idle',
    minimized: 0, spawned_by_agent: 0, acp_session_id: id, runtime_id: 'codex', created_at: 1 });
}

/** A new running turn of the chat; the earlier one completes. */
function nextTurn(): string {
  getDb().prepare("UPDATE turns SET status = 'completed' WHERE node_id = ?").run(CHAT);
  turnId = `turn-${++turns}`;
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,'active',?,?)")
    .run(turnId, CHAT, `a-${turnId}`, turns, turns);
  return turnId;
}

const taint = () => recordCompanionTaint({ nodeId: CHAT, turnId }, 'companion_read', 'checkin');

function slot(extra: Record<string, unknown> = {}): McpSlot {
  return new McpSlotRegistry().create(CHAT, '/tmp', null, {
    owner: chatOwner(CHAT),
    onSpawnBranches: async (topics: Array<{ title: string; prompt: string }>) => {
      spawned += 1;
      return topics.map((topic, index) => ({ ...topic, chatId: `n-branch-${index}` }));
    },
    onAskUser: async (questions: Question[]) => {
      asked.push(questions);
      return answer === null ? null : { [questions[0]!.question]: answer };
    },
    ...extra,
  } as never, { nodeId: CHAT, workspaceId: WS });
}

async function call(target: McpSlot, name: string, args: Record<string, unknown>) {
  const tool = ((buildMcpServerForSlot(target) as any)._registeredTools as Registered)[name];
  assert.ok(tool, `${name} is registered`);
  const result = await tool.handler(args, {});
  return { text: result.content.map((part) => part.text).join(''), isError: result.isError === true };
}

const BRANCH = { topics: [{ title: 'Try the fix', prompt: 'Apply the patch from the check-in.' }] };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-tainted-tool-gate-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  __resetRuntimeToolApprovals();
  saveWorkspace({ id: WS, name: 'A', cwd: tmpDir, created_at: 1, updated_at: 1, settings: null });
  seedChat(CHAT);
  seedChat(TARGET);
  // The chat's live session: what its turn reads stays with it (D17).
  registerLiveSession(CHAT, { runtimeId: 'codex' });
  nextTurn();
  spawned = 0;
  asked = [];
  answer = 'Run it';
});

afterEach(() => {
  configureThreadMessaging(null);
  clearAllSessions();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('a Michi tool from a guarded turn (D23, D19)', () => {
  test('Codex-like (no runtime prompt): it asks through ask_user and runs only on "Run it"', async () => {
    // Unguarded, and the turn's own command output alone: it runs without a question.
    assert.match((await call(slot(), 'spawn_branches', BRANCH)).text, /Spawned 1 branch/);
    recordUntrustedSource({ nodeId: CHAT, turnId }, { tool: 'shell', runtimeId: 'codex' });
    assert.match((await call(slot(), 'spawn_branches', BRANCH)).text, /Spawned 1 branch/);
    assert.deepEqual([spawned, asked.length], [2, 0]);

    taint();
    const ran = await call(slot(), 'spawn_branches', BRANCH);
    assert.match(ran.text, /Spawned 1 branch/);
    assert.equal(asked.length, 1);
    const [question] = asked[0]!;
    assert.ok(question!.question.startsWith(`Run spawn_branches?\n${TAINTED_TOOL_ASK_REASON}\n\n`), question!.question);
    assert.ok(question!.question.includes('Apply the patch from the check-in.'), 'the user sees what runs');
    assert.deepEqual(question!.options.map((option) => option.label), ['Run it', "Don't run it"]);

    answer = "Don't run it";
    const declined = await call(slot(), 'spawn_branches', BRANCH);
    assert.equal(declined.isError, false);
    assert.deepEqual(JSON.parse(declined.text), { status: 'declined', tool: 'spawn_branches', next: 'The user declined; nothing ran. Do not retry unless the user asks.' });
    answer = 'only the first one';
    assert.equal(JSON.parse((await call(slot(), 'spawn_branches', BRANCH)).text).userNote, 'only the first one');
    answer = null;
    assert.match(JSON.parse((await call(slot(), 'spawn_branches', BRANCH)).text).next, /did not answer/);
    assert.equal(spawned, 3, 'only the approved call ran');

    // Sticky: the chat's next turn on the same session asks as well (D17).
    nextTurn();
    answer = 'Run it';
    await call(slot(), 'spawn_branches', BRANCH);
    assert.deepEqual([spawned, asked.length], [4, 5]);
  });

  test('a web page the turn read guards it too', async () => {
    recordUntrustedSource({ nodeId: CHAT, turnId }, { tool: 'WebFetch', runtimeId: 'codex' });
    await call(slot(), 'spawn_branches', BRANCH);
    assert.equal(asked.length, 1);
  });

  test('with no channel to ask through it is refused, and the agent is told to ask the user in chat', async () => {
    taint();
    const refused = await call(slot({ onAskUser: undefined }), 'spawn_branches', BRANCH);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /^NEEDS_USER_APPROVAL: in this conversation spawn_branches runs only with the user's approval.*did not run\. Do not retry\. Ask the user in chat/);
    assert.equal(spawned, 0);
  });

  test('reads, Michi-internal and local writes run as before; the gate covers what leaves the machine and work the mark would not reach', async () => {
    taint();
    assert.equal((await call(slot(), 'michi_docs', {})).isError, false);
    assert.equal(asked.length, 0);
    for (const name of ['spawn_branches', 'open_url', 'spawn_agent', 'send_agent_input', 'mcp____michi_internal____open_url']) {
      assert.equal(taintedMichiToolGate(CHAT, name).kind, 'ask', name);
    }
    for (const name of ['read_page', 'edit_page', 'memory_save', 'save_artifact', '@michi/save_artifact', 'send_to_thread', 'companion_session_send',
      'start_conversation', 'create_scheduled_job', 'Bash', 'unknown_tool']) {
      assert.equal(taintedMichiToolGate(CHAT, name).kind, 'run', name);
    }
    assert.equal(taintedMichiToolGate(null, 'spawn_branches').kind, 'run', 'no chat: nothing to judge');
  });

  test('Claude/Kiro-like: a call Michi\'s runtime prompt approved runs without a second question, once per approval and turn', async () => {
    taint();
    // The adapters' coordinator over Michi's permission port, as Claude and Kiro hold it.
    const approvals = new ApprovalCoordinator({ permissions: michiPermissionPolicy });
    assert.equal(approvals.accept('allow_once', chatOwner(CHAT), 'mcp____michi_internal____spawn_branches'), true);
    assert.match((await call(slot(), 'spawn_branches', BRANCH)).text, /Spawned 1 branch/);
    assert.equal(asked.length, 0, 'no double prompt');
    // The approval answered that call only: the next one asks.
    await call(slot(), 'spawn_branches', BRANCH);
    assert.equal(asked.length, 1);

    // Kiro's name for it; two approvals answer two calls.
    approvals.accept('allow_once', chatOwner(CHAT), '@michi/spawn_branches');
    approvals.accept('allow_always', chatOwner(CHAT), '@michi/spawn_branches');
    await call(slot(), 'spawn_branches', BRANCH);
    await call(slot(), 'spawn_branches', BRANCH);
    assert.equal(asked.length, 1);
    // A refusal approves nothing, and an approval in an earlier turn does not carry over.
    approvals.accept('reject_once', chatOwner(CHAT), '@michi/spawn_branches');
    approvals.accept('allow_once', chatOwner(CHAT), '@michi/spawn_branches');
    nextTurn();
    await call(slot(), 'spawn_branches', BRANCH);
    assert.equal(asked.length, 2);
    // One tool's approval is not another's.
    approvals.accept('allow_once', chatOwner(CHAT), 'mcp____michi_internal____open_url');
    await call(slot(), 'spawn_branches', BRANCH);
    assert.equal(asked.length, 3);
    assert.equal(spawned, 6);
  });

  test('a check-in\'s own turn refuses such a call: nobody is there to approve it', () => {
    const checkin = makeCheckinNode(WS, 'run-gate');
    activeTurnRow(checkin, 'cmp-run-gate', 'a-gate');
    assert.deepEqual(taintedMichiToolGate(checkin, 'open_url'), { kind: 'refuse', reason: BACKGROUND_TOOL_REFUSAL });
    assert.deepEqual(taintedMichiToolGate(checkin, 'spawn_branches'), { kind: 'refuse', reason: BACKGROUND_TOOL_REFUSAL });
    assert.equal(taintedMichiToolGate(checkin, 'edit_page').kind, 'run');
  });

  test('Pi-like: an approval through Michi\'s own ChatApprovalState is noted the same way', async () => {
    taint();
    assert.equal(new ChatApprovalState().accept('allow_once', chatOwner(CHAT), 'spawn_branches'), true);
    await call(slot(), 'spawn_branches', BRANCH);
    assert.equal(asked.length, 0);
  });

  test('send_to_thread is not gated: its message carries the turn\'s outside content to the turn it starts', async () => {
    const started: StartRequestedSelfTurnArgs[] = [];
    configureThreadMessaging({
      ensureSession: async () => ({ id: TARGET, runtimeId: 'codex' }) as unknown as AgentSession,
      startTurn: async (args): Promise<StartedRequestedSelfTurn> => {
        started.push(args);
        return { turnId: args.turnId, assistantId: `self-${args.nodeId}-${args.turnId}`, done: Promise.resolve(), existing: false };
      },
      acquireRestoreLock: async () => () => {},
      newTurnId: () => `turn-sent-${started.length}`,
      startWaitMs: 50,
    });
    const message = { nodeId: TARGET, text: 'Please run the deploy now.' };
    // Untainted, without requestApproval: it goes as before.
    await call(slot(), 'send_to_thread', message);
    assert.deepEqual([started.length, asked.length], [1, 0]);

    assert.equal(getTurnTrust({ nodeId: TARGET, turnId: started[0]!.turnId }).untrusted, false, 'a clean sender passes nothing on');

    taint();
    await call(slot(), 'send_to_thread', message);
    assert.deepEqual([started.length, asked.length], [2, 0], 'no question');
    const tools = getTurnTrust({ nodeId: TARGET, turnId: started[1]!.turnId }).sources.map((source) => source.tool).sort();
    assert.deepEqual(tools, ['passed_outside', 'send_to_thread']);

    // The user's own requestApproval still asks.
    answer = "Don't send";
    const declined = await call(slot(), 'send_to_thread', { ...message, requestApproval: true });
    assert.match(declined.text, /"status":"declined"/);
    assert.deepEqual([started.length, asked.length], [2, 1]);
  });
});
