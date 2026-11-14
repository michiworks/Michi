// A temporary chat (services/memory/temporaryChat.ts) is the user's own
// conversation: their search finds it, but no agent reads it except from
// inside it. Its branches are temporary too, from the stored parent row only.
// Covers the shared readers every tool surface calls: saveNode's inheritance,
// keyword search, list_threads / read_node / read_node_overview /
// search_messages (globalContext.ts), the conversation feed and the pane
// inspection tools. The runtime surfaces are in memoryTools.test.ts (MCP, Pi),
// companionMemoryTools.test.ts (the assistant) and threadMessageTool.test.ts.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent, type DurableTurnSnapshot } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { beginTurn, finalizeTurn, getNode, saveNode } from '../src/services/dbRepository';
import { keywordSearch, nodeGroupedSearch } from '../src/routes/search';
import { listThreads, readNode, readNodeOverview, searchMessages } from '../src/services/globalContext';
import { readConversationUpdates } from '../src/services/conversationUpdates';
import { inspectPaneTool, listPanesTool, readPaneOutputTool, waitPaneTool, type PaneInspectionToolBinding } from '../src/agents/paneInspectionTools';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';

const saved = { cloud: process.env.MICHI_CLOUD, dataDir: process.env.MICHI_DATA_DIR };
let dataDir: string;

const ev = (event: ChatStreamEvent['event'], data: Record<string, unknown>) => ({ event, data }) as ChatStreamEvent;

/** A completed turn in `nodeId`: the user's text and the reply both say `word`. */
function completedTurn(nodeId: string, word: string): void {
  const turn: DurableTurnSnapshot = createDurableTurn({
    turnId: `turn-${nodeId}`, assistantId: `a-${nodeId}`, nodeId, workspaceId: 'ws', displayUserText: `${word} rollout plan`, startedAt: 10,
  });
  beginTurn(turn);
  const answer = applyTurnEvent(turn, ev('chunk', { seq: turn.lastAppliedSeq + 1, text: `${word} answer` }));
  finalizeTurn(applyTurnEvent(answer, ev('done', { seq: answer.lastAppliedSeq + 1, stopReason: 'end_turn', completedAt: 100 })));
}

function chat(id: string, title: string, parent: string | null = null): void {
  const treeId = `t-${parent ?? id}`;
  if (!parent) getDb().prepare('INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES (?, ?, ?, 1, 1)').run(treeId, 'ws', id);
  saveNode({ id, workspace_id: 'ws', tree_id: treeId, parent_node_id: parent, kind: 'chat', title, status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
}

const memoryMode = (id: string) => getNode(id)?.memory_mode ?? null;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-temporary-chat-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'Project', 1, 1)").run();
  chat('n-learn', 'Learning chat');
  chat('n-temp', 'Secret plan');
  getDb().prepare("UPDATE nodes SET memory_mode = 'off' WHERE id = 'n-temp'").run();
  chat('n-temp-child', 'Secret branch', 'n-temp');
  completedTurn('n-learn', 'heron');
  completedTurn('n-temp', 'heron');
});

afterEach(() => {
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  if (saved.dataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.dataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('temporary chats', () => {
  test('a branch is temporary from its stored parent on insertion; a client value never sets or clears the setting', () => {
    assert.equal(memoryMode('n-temp-child'), 'off');
    // A graph snapshot replaying the branch, with the setting it does not own.
    saveNode({ id: 'n-temp-child', workspace_id: 'ws', tree_id: 't-n-temp', parent_node_id: 'n-temp', kind: 'chat', title: 'Renamed', status: 'idle',
      minimized: 0, spawned_by_agent: 0, created_at: 1, memory_mode: null });
    assert.equal(getNode('n-temp-child')?.title, 'Renamed');
    assert.equal(memoryMode('n-temp-child'), 'off', 'the conflict clause keeps it');
    saveNode({ id: 'n-claims', workspace_id: 'ws', tree_id: 't-n-learn', parent_node_id: null, kind: 'chat', status: 'idle', minimized: 0,
      spawned_by_agent: 0, created_at: 2, memory_mode: 'off' });
    assert.equal(memoryMode('n-claims'), null, 'a root takes nothing from the client');
    chat('n-learn-child', 'Learning branch', 'n-learn');
    assert.equal(memoryMode('n-learn-child'), null);
  });

  test('the user\'s search finds it; an agent\'s search does not', () => {
    assert.deepEqual(new Set(keywordSearch('heron').map((row) => row.node_id)), new Set(['n-learn', 'n-temp']));
    assert.deepEqual(new Set(nodeGroupedSearch('heron').map((row) => row.nodeId)), new Set(['n-learn', 'n-temp']));
    assert.deepEqual(new Set(keywordSearch('heron', undefined, 20, undefined, { excludeTemporaryChats: true }).map((row) => row.node_id)), new Set(['n-learn']));
    const agent = searchMessages('ws', null, 'heron', 'all');
    assert.match(agent.text, /n-learn/);
    assert.doesNotMatch(agent.text, /n-temp/);
    assert.equal(agent.matchCount, 2, 'the learning chat\'s question and answer');
  });

  test('list_threads, read_node and read_node_overview: another conversation\'s temporary chat is not there; its own is', () => {
    for (const reader of ['n-learn', undefined]) {
      const listed = listThreads('ws', null, undefined, reader).text;
      assert.match(listed, /n-learn/);
      assert.doesNotMatch(listed, /n-temp|Secret/, `listed for ${reader}: no node, thread id or title`);
      for (const nodeId of ['n-temp', 'n-temp-child']) {
        assert.deepEqual(readNode('ws', null, nodeId, undefined, reader), { status: 'not_found', text: `node not found: ${nodeId}` });
        assert.deepEqual(readNodeOverview('ws', null, nodeId, reader), { status: 'not_found', text: `node not found: ${nodeId}` });
      }
      assert.equal(readNode('ws', null, 'n-learn', undefined, reader).status, 'ok');
    }
    const own = listThreads('ws', null, undefined, 'n-temp').text;
    assert.match(own, /n-temp"/);
    assert.doesNotMatch(own, /n-temp-child/, 'its branch is another conversation');
    assert.equal(readNode('ws', null, 'n-temp', undefined, 'n-temp').status, 'ok');
    assert.match(readNode('ws', null, 'n-temp', undefined, 'n-temp').text, /heron answer/);
    assert.equal(readNodeOverview('ws', null, 'n-temp', 'n-temp').status, 'ok');
  });

  test('the conversation feed leaves it out', () => {
    const updates = readConversationUpdates({ workspaceId: 'ws', ownerUserId: LOCAL_AGENT_OWNER_ID, backendConnectionId: 'local' }, { after: 0, includeMessages: true });
    assert.deepEqual(updates.turns.map((turn) => turn.nodeId), ['n-learn']);
    assert.deepEqual(updates.byNode.map((row) => row.nodeId), ['n-learn']);
    assert.equal(updates.totalTurns, 1);
  });

  test('pane tools: not found and not listed from another conversation, an Agent Run or none; found from itself', async () => {
    const binding = (callerNodeId: string | null): PaneInspectionToolBinding =>
      ({ ownerUserId: null, workspaceId: 'ws', runOwnerRunId: null, backendConnectionId: 'local', callerNodeId });
    const text = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;
    for (const reader of ['n-learn', null]) {
      const as = binding(reader);
      assert.match(text(inspectPaneTool(as, { nodeId: 'n-temp' })), /^NOT_FOUND/);
      assert.match(text(inspectPaneTool(as, { paneId: 'node:n-temp-child' })), /^NOT_FOUND/);
      assert.match(text(readPaneOutputTool(as, { nodeId: 'n-temp' })), /^NOT_FOUND/);
      assert.match(text(await waitPaneTool(as, { nodeId: 'n-temp', until: 'changed', cursor: 'c' })), /^NOT_FOUND/);
      const listed = text(listPanesTool(as, { scope: 'all' }));
      assert.match(listed, /node:n-learn/);
      assert.doesNotMatch(listed, /n-temp/);
      assert.doesNotMatch(text(inspectPaneTool(as, { nodeId: 'n-learn' })), /^NOT_FOUND/);
    }
    const own = binding('n-temp');
    assert.doesNotMatch(text(inspectPaneTool(own, { nodeId: 'n-temp' })), /^NOT_FOUND/);
    assert.match(text(readPaneOutputTool(own, { nodeId: 'n-temp' })), /heron answer/);
  });
});
