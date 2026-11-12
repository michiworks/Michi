/**
 * Check-in provenance at read time (DESIGN-v2 §2.7, §2.8 T5) and "Undo all"
 * (revertRunPageChanges). A check-in writes with its own node as the source
 * and that node is purged after its run: what the owner is shown still opens
 * the post it made, still says the user's agent wrote it, and still taints a
 * turn that reads it. Storage keeps the check-in's own source.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkinNodeId, companionCheckinTurnId, companionPostId, isCheckinBlockSource, parsePageBlock, parsePageSegmentSources,
  type BlockSource, type PageBlock,
} from 'michi-shared';
import ts from 'typescript';
import { closeDb, getDb, initDb } from '../src/services/db';
import { currentAssistantNodeId } from '../src/assistant/store';
import { applyAgentPageEdits, applyUserPageEdits } from '../src/services/pages/pageWrites';
import { applyAgentDbEdits, applyUserDatabaseEdits, createAgentDatabase } from '../src/services/pages/databaseWrites';
import {
  createDatabase, createPage, deletePage, getDatabase, getPage, listPageTrash, listSpaces, restorePageDeletionGroup, updatePageMetadata,
} from '../src/services/pages/repository';
import { listRelevantChanges } from '../src/services/pages/historyRepository';
import { acceptProposal, revertBatch, revertChange, revertRunPageChanges } from '../src/services/pages/pageChanges';
import { PageWriteError } from '../src/services/pages/core';
import { taskActivity, taskOrigin } from '../src/services/pages/taskActivity';
import { spaceActivity } from '../src/services/pages/homeActivity';
import { openTaskDatabase } from '../src/services/pages/taskDatabase';
import {
  blocksCheckinTaint, checkinSourceResolver, databaseCheckinTaint, databasesCheckinTaint, pageCheckinTaint, presentPage,
} from '../src/services/pages/checkinSources';

const OWNER = 'alice';
const V = 'n-conversation';
type ChatSource = BlockSource & { kind: 'chat' };

let dir: string;
let priorData: string | undefined;
let priorCloud: string | undefined;

beforeEach(() => {
  priorData = process.env.MICHI_DATA_DIR;
  priorCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-checkin-sources-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  const db = getDb();
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', OWNER);
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,settings,created_at,updated_at) VALUES (?,?,?,?,1,1)')
    .run('asst', 'Michi assistant', OWNER, JSON.stringify({ system: 'assistant', assistant: { nodeId: V } }));
  db.prepare("INSERT INTO trees(id,workspace_id,root_node_id,last_active_at,created_at) VALUES ('t-v','asst',?,1,1)").run(V);
  db.prepare("INSERT INTO nodes(id,workspace_id,tree_id,kind,status,title,created_at) VALUES (?,'asst','t-v','chat','idle','Michi',1)").run(V);
  db.prepare("INSERT INTO nodes(id,workspace_id,kind,status,title,created_at) VALUES ('n-other','ws','chat','idle','Planning',1)").run();
});

afterEach(() => {
  closeDb();
  if (priorData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorData;
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A check-in run's node in the assistant workspace with its live turn, as W2-G1a makes it: its write source. */
function checkin(runId: string): ChatSource {
  const nodeId = checkinNodeId(runId);
  const turnId = companionCheckinTurnId(runId);
  const assistantId = `self-${nodeId}-${turnId}`;
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,title,created_at) VALUES (?,'asst','chat','idle','',1)").run(nodeId);
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,'active',1,1)").run(turnId, nodeId, assistantId);
  return { kind: 'chat', nodeId, turnId, assistantId };
}

/** The run's node and everything under it are hard-deleted after the run (DESIGN-v2 §3.1). */
function purge(runId: string): void {
  getDb().prepare('DELETE FROM nodes WHERE id=?').run(checkinNodeId(runId));
}

/** The message a run posted into the conversation (W1-B postSelfMessage). */
function posted(runId: string, nodeId = V): void {
  getDb().prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES (?,?,'assistant','Checked in.',1,2)").run(companionPostId(runId), nodeId);
}

/** A turn of an ordinary chat of the workspace, or of the conversation: a write source too. */
function chatTurn(nodeId: string, turnId: string): ChatSource {
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,'active',1,1)").run(turnId, nodeId, `a-${turnId}`);
  return { kind: 'chat', nodeId, turnId, assistantId: `a-${turnId}` };
}

function insertBlock(pageId: string, source: ChatSource, text: string, now = 10): string {
  const result = applyAgentPageEdits({ pageId, workspaceId: 'ws', ownerUserId: OWNER, source, now,
    ops: [{ op: 'insert', after: null, block: { type: 'markdown', text } }] });
  assert.equal(result.applied.length, 1, JSON.stringify(result.rejected));
  return (result.applied[0]!.target as { blockId: string }).blockId;
}

const blockOf = (pageId: string, blockId: string): PageBlock => getPage(pageId, OWNER).blocks.find((block) => block.id === blockId)!;
const pageExists = (pageId: string): boolean => { try { getPage(pageId, OWNER); return true; } catch { return false; } };
const databaseExists = (databaseId: string): boolean => { try { getDatabase(databaseId, OWNER); return true; } catch { return false; } };
const trashedPages = (): string[] => listPageTrash('ws', OWNER).items.map((group) => group.root.id);

const SRC = path.resolve(__dirname, '../src');
/** The modules a module loads as it loads (value imports, transitively, within backend/src). */
function loadClosure(start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [path.join(SRC, start)];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      let specifier: string | null = null;
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly)));
        if (!typeOnly) specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
        specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
      }
      if (!specifier?.startsWith('.')) continue;
      const base = path.resolve(path.dirname(file), specifier);
      const resolvedFile = [`${base}.ts`, path.join(base, 'index.ts')].find((candidate) => fs.existsSync(candidate));
      if (resolvedFile) queue.push(resolvedFile);
    }
  }
  return new Set([...seen].map((file) => path.relative(SRC, file)));
}
const shown = (pageId: string, blockId: string): PageBlock => presentPage(getPage(pageId, OWNER), OWNER).blocks.find((block) => block.id === blockId)!;
const resolved = (runId: string, nodeId = V) => ({ nodeId, turnId: companionPostId(runId), assistantId: companionPostId(runId) });
const flagged = (runId: string, nodeId = V) => ({ ...resolved(runId, nodeId), checkin: true });

describe('a check-in source opens the post after its node is purged', () => {
  test('a block opens the message its run posted, marked as a check-in; storage keeps the check-in node', () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plan' });
    const source = checkin('run1');
    const blockId = insertBlock(page.id, source, 'Checked: 3 tasks moved.');
    posted('run1');
    purge('run1');

    assert.deepEqual(shown(page.id, blockId).sources, [flagged('run1')]);
    const stored = blockOf(page.id, blockId);
    assert.deepEqual(stored.sources, [{ nodeId: source.nodeId, turnId: source.turnId, assistantId: source.assistantId }]);
    assert.ok(parsePageBlock(stored), 'what is stored still parses');
    assert.equal(parsePageBlock(shown(page.id, blockId)), null, 'the resolved form is for the response only');
  });

  test('D12: a run that posted nothing opens the current conversation without a message; with no conversation its source is dropped, never the raw node', () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plan' });
    const quiet = checkin('run2');
    const blockId = insertBlock(page.id, quiet, 'Quiet run wrote this.');
    // A passage of it, as the passage-tracking write stores one.
    const stored = getPage(page.id, OWNER).blocks.map((block) => (block.id === blockId
      ? { ...block, segmentSources: [{ text: 'Quiet run wrote this.', sources: [{ nodeId: quiet.nodeId, turnId: quiet.turnId, assistantId: quiet.assistantId }] }] }
      : block));
    getDb().prepare('UPDATE pages SET blocks=? WHERE id=?').run(JSON.stringify(stored), page.id);
    purge('run2');
    const [source] = shown(page.id, blockId).sources!;
    assert.deepEqual(source, { nodeId: V, turnId: null, assistantId: null, checkin: true }, 'the conversation, no message: the post it would have made does not exist');
    assert.ok(isCheckinBlockSource(source!), 'still marked as a check-in\'s');
    const [change] = listRelevantChanges(page.id, OWNER).changes.filter((item) => item.source.kind === 'chat');
    assert.deepEqual(change!.source, { kind: 'chat', nodeId: V, turnId: null, assistantId: null, checkin: true });
    assert.equal(pageCheckinTaint(presentPage(getPage(page.id, OWNER), OWNER)), 'checkin');

    getDb().prepare("UPDATE workspaces SET settings=? WHERE id='asst'").run(JSON.stringify({ system: 'assistant', assistant: { nodeId: null } }));
    const nowhere = presentPage(getPage(page.id, OWNER), OWNER);
    assert.ok(!JSON.stringify(nowhere).includes(checkinNodeId('run2')), JSON.stringify(nowhere));
    const dropped = nowhere.blocks.find((block) => block.id === blockId)!;
    assert.equal('sources' in dropped, false, 'its only source is dropped');
    assert.deepEqual((dropped as Extract<PageBlock, { type: 'markdown' }>).segmentSources, [{ text: 'Quiet run wrote this.', sources: [] }],
      'and so is its passage\'s');
    const changes = listRelevantChanges(page.id, OWNER).changes.filter((item) => item.source.kind === 'chat');
    assert.ok(!JSON.stringify(changes).includes(checkinNodeId('run2')), JSON.stringify(changes));
    assert.deepEqual(changes[0]!.source, { kind: 'chat', nodeId: '', turnId: null, assistantId: null, checkin: true },
      'a change keeps a source: the agent\'s mark, nothing to open');
    assert.equal(pageCheckinTaint(getPage(page.id, OWNER)), 'checkin', 'what is stored still taints a turn that reads it');
  });

  test('a post outside the assistant workspace is not followed', () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plan' });
    const blockId = insertBlock(page.id, checkin('run7'), 'Text.');
    posted('run7', 'n-other');
    purge('run7');
    assert.deepEqual(shown(page.id, blockId).sources, [{ nodeId: V, turnId: null, assistantId: null, checkin: true }],
      'a post outside the assistant workspace is ignored: as with no post, the conversation without a message (D12)');
  });

  test('the current conversation is the one the assistant store names, in every state it can be in', () => {
    const quiet = checkinNodeId('quiet');
    const shownConversation = () => checkinSourceResolver(OWNER).target(quiet)?.nodeId ?? null;
    const same = (state: string) => assert.equal(shownConversation(), currentAssistantNodeId(), state);
    same('the conversation');
    assert.equal(shownConversation(), V);
    getDb().prepare("UPDATE trees SET archived_at=5 WHERE id='t-v'").run(); same('its tree archived');
    getDb().prepare("UPDATE trees SET archived_at=NULL WHERE id='t-v'").run();
    getDb().prepare("UPDATE nodes SET status='archived' WHERE id=?").run(V); same('the conversation archived');
    getDb().prepare("UPDATE nodes SET status='idle', deleted_at=5 WHERE id=?").run(V); same('the conversation deleted');
    getDb().prepare('UPDATE nodes SET deleted_at=NULL, tree_id=NULL WHERE id=?').run(V); same('no tree');
    getDb().prepare("UPDATE nodes SET tree_id='t-v' WHERE id=?").run(V); same('back');
    getDb().prepare("UPDATE workspaces SET settings=? WHERE id='asst'").run(JSON.stringify({ system: 'assistant', assistant: { nodeId: 'n-other' } }));
    same('a node of another workspace');
    getDb().prepare("UPDATE workspaces SET settings=? WHERE id='asst'").run(JSON.stringify({ system: 'assistant', assistant: { nodeId: V } }));
    getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,settings,created_at,updated_at) VALUES (?,?,?,?,9,9)')
      .run('asst2', 'Michi assistant', OWNER, JSON.stringify({ system: 'assistant', assistant: {} }));
    same('a newer assistant workspace without a conversation');
    getDb().prepare("UPDATE workspaces SET deleted_at=10 WHERE id='asst2'").run(); same('the newer one deleted');
    assert.equal(shownConversation(), V);
  });

  test('the Pages modules load without the assistant store or the agent layer (no import cycle)', () => {
    for (const module of ['services/pages/checkinSources.ts', 'services/pages/remoteMedia.ts', 'services/pages/historyRepository.ts',
      'services/pages/repository.ts', 'services/pages/pageChanges.ts']) {
      const loaded = [...loadClosure(module)].filter((file) => file.startsWith('assistant/') || file.startsWith('agents/'));
      assert.deepEqual(loaded, [], `${module} loads ${loaded.join(', ')}`);
    }
  });

  test('a passage\'s segment sources are rewritten without the flag, so they still parse', () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plan' });
    const source = checkin('run3');
    const blockId = insertBlock(page.id, source, 'One passage.');
    posted('run3');
    purge('run3');
    const stored = getPage(page.id, OWNER).blocks.map((block) => (block.id === blockId
      ? { ...block, segmentSources: [{ text: 'One passage.', sources: [{ nodeId: source.nodeId, turnId: source.turnId, assistantId: source.assistantId }] }] }
      : block));
    getDb().prepare('UPDATE pages SET blocks=? WHERE id=?').run(JSON.stringify(stored), page.id);

    const block = shown(page.id, blockId) as Extract<PageBlock, { type: 'markdown' }>;
    assert.deepEqual(block.segmentSources, [{ text: 'One passage.', sources: [resolved('run3')] }]);
    assert.ok(parsePageSegmentSources(block.text, block.segmentSources), 'the frontend parser accepts them');
    assert.deepEqual(block.sources, [flagged('run3')]);
  });

  test('a page without check-in content is returned as it is', () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plan' });
    insertBlock(page.id, chatTurn('n-other', 'turn-other'), 'From a chat.');
    const read = getPage(page.id, OWNER);
    assert.equal(presentPage(read, OWNER), read);
  });

  test('history, suggestions and review results open the post too', () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plan' });
    const source = checkin('run4');
    const blockId = insertBlock(page.id, source, 'Agent text.');
    const tasks = openTaskDatabase({ workspaceId: 'ws', ownerUserId: OWNER, now: 1 }).database;
    applyUserDatabaseEdits({ databaseId: tasks.id, ownerUserId: OWNER, revision: tasks.revision, now: 2, ops: [{ op: 'row.add', values: { task: 'Mine' } }] });
    const mine = getDatabase(tasks.id, OWNER).rows[0]!;
    const proposal = applyAgentDbEdits({ databaseId: tasks.id, workspaceId: 'ws', ownerUserId: OWNER, source, now: 3,
      ops: [{ op: 'row.update', id: mine.id, expectRev: mine.rev, values: { task: 'Mine, reworded' } }] });
    assert.equal(proposal.proposed.length, 1, 'a person\'s task gets a suggestion');
    posted('run4');
    purge('run4');

    const [change] = listRelevantChanges(page.id, OWNER).changes.filter((item) => item.source.kind === 'chat');
    assert.deepEqual(change!.source, { kind: 'chat', ...flagged('run4') });
    assert.ok(change!.after?.kind === 'block' && change!.after.exists);
    assert.deepEqual(change!.after.block.sources, [flagged('run4')]);
    assert.deepEqual(taskActivity(tasks.id, OWNER, 4).suggestions.map((item) => item.source), [{ kind: 'chat', ...flagged('run4') }]);

    const undone = revertChange(change!.id, OWNER, 5);
    assert.deepEqual(undone.source, { kind: 'chat', ...flagged('run4') });
    assert.equal(blockOf(page.id, blockId), undefined, 'the revert itself ran on the stored record');
    const accepted = acceptProposal(proposal.proposed[0]!.id, OWNER, 6);
    assert.deepEqual(accepted.source, { kind: 'chat', ...flagged('run4') });
  });
});

describe('the user\'s agent is named as the writer', () => {
  test('after the purge: a check-in\'s task, page, Space and activity say companion · checkin', () => {
    const tasks = openTaskDatabase({ workspaceId: 'ws', ownerUserId: OWNER, now: 1 }).database;
    const source = checkin('run5');
    applyAgentDbEdits({ databaseId: tasks.id, workspaceId: 'ws', ownerUserId: OWNER, source, now: 20, ops: [{ op: 'row.add', values: { task: 'Review CR-1', status: 'todo' } }] });
    const made = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Weekly', source, now: 21 });
    insertBlock(made.id, source, 'Summary.', 22);
    posted('run5');
    purge('run5');

    const row = getDatabase(tasks.id, OWNER).rows.find((item) => item.values.task === 'Review CR-1')!;
    assert.deepEqual(taskOrigin(tasks.id, row.id, OWNER), { by: { kind: 'companion', via: 'checkin' }, conversations: 0, at: 20 });
    const space = listSpaces(OWNER, { workspaceId: 'ws' }).items.find((item) => item.id === made.id)!;
    assert.deepEqual(space.createdBy, { kind: 'companion', via: 'checkin' });
    assert.deepEqual(space.contributorNodeIds, [V], 'the purged node contributes as the conversation it posted in');
    const item = spaceActivity(OWNER, { now: 30 }).find((entry) => entry.kind === 'page-change' && entry.pageId === made.id);
    assert.ok(item?.kind === 'page-change');
    assert.deepEqual(item.detail?.by, { kind: 'companion', via: 'checkin' });
    assert.equal(item.sourceNodeId, V);
  });

  test('a conversation in the assistant workspace is companion · conversation; an ordinary chat stays an agent', () => {
    const fromV = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'From the conversation', source: chatTurn(V, 'a-turn') });
    const fromChat = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'From a chat', source: chatTurn('n-other', 'turn-chat') });
    const createdBy = (id: string) => listSpaces(OWNER, { workspaceId: 'ws' }).items.find((space) => space.id === id)?.createdBy;
    assert.deepEqual(createdBy(fromV.id), { kind: 'companion', via: 'conversation' });
    assert.equal(createdBy(fromChat.id), 'agent');
  });
});

describe('what a check-in wrote taints the turn that reads it', () => {
  test('a page by its blocks, all or the ones read; resolved or stored', () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plan' });
    const mine = applyUserPageEdits({ pageId: page.id, ownerUserId: OWNER, revision: getPage(page.id, OWNER).revision,
      ops: [{ op: 'insert', after: null, block: { type: 'markdown', text: 'Mine.' } }] }).applied[0]!.target as { blockId: string };
    const chat = insertBlock(page.id, chatTurn('n-other', 'turn-other'), 'From a chat.');
    assert.equal(pageCheckinTaint(getPage(page.id, OWNER)), null);
    // After the chat's edit lease on the page has run out.
    const fromCheckin = insertBlock(page.id, checkin('run6'), 'From a check-in.', 400_000);
    purge('run6');

    assert.equal(pageCheckinTaint(getPage(page.id, OWNER)), 'checkin');
    assert.equal(pageCheckinTaint(presentPage(getPage(page.id, OWNER), OWNER)), 'checkin', 'the resolved form still says so');
    assert.equal(pageCheckinTaint(getPage(page.id, OWNER), [mine.blockId, chat]), null);
    assert.equal(pageCheckinTaint(getPage(page.id, OWNER), [fromCheckin]), 'checkin');
    const nested = { type: 'toggle', title: 'T', blocks: [{ type: 'markdown', text: 'x', segmentSources: [{ text: 'x', sources: [{ nodeId: checkinNodeId('r'), turnId: 't', assistantId: 'a' }] }] }] };
    assert.equal(blocksCheckinTaint([nested as never]), 'checkin', 'a passage nested in a container');
  });

  test('a database as a whole, while a check-in\'s change to it still stands', () => {
    const tasks = openTaskDatabase({ workspaceId: 'ws', ownerUserId: OWNER, now: 1 }).database;
    const other = createDatabase({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Other', now: 1, columns: [{ id: 'name', name: 'Name', type: 'text' }] });
    applyAgentDbEdits({ databaseId: other.id, workspaceId: 'ws', ownerUserId: OWNER, source: chatTurn('n-other', 'turn-other'), now: 2, ops: [{ op: 'row.add', values: { name: 'From a chat' } }] });
    assert.equal(databaseCheckinTaint(tasks.id, OWNER), null);
    assert.equal(databaseCheckinTaint(other.id, OWNER), null, 'an ordinary chat\'s rows do not taint');

    const source = checkin('run8');
    const added = applyAgentDbEdits({ databaseId: tasks.id, workspaceId: 'ws', ownerUserId: OWNER, source, now: 3, ops: [{ op: 'row.add', values: { task: 'Check-in task' } }] });
    purge('run8');
    assert.equal(databaseCheckinTaint(tasks.id, OWNER), 'checkin');
    assert.equal(databasesCheckinTaint([other.id, tasks.id], OWNER), 'checkin');
    assert.equal(databaseCheckinTaint(tasks.id, 'bob'), null, 'owner scoped');

    revertBatch(added.applied[0]!.batchId, OWNER, 'ws', 4);
    assert.equal(databaseCheckinTaint(tasks.id, OWNER), null, 'nothing of it is left once undone');

    applyUserDatabaseEdits({ databaseId: tasks.id, ownerUserId: OWNER, revision: getDatabase(tasks.id, OWNER).revision, now: 5, ops: [{ op: 'row.add', values: { task: 'Mine' } }] });
    const mine = getDatabase(tasks.id, OWNER).rows.find((row) => row.values.task === 'Mine')!;
    const pending = checkin('run9');
    const proposal = applyAgentDbEdits({ databaseId: tasks.id, workspaceId: 'ws', ownerUserId: OWNER, source: pending, now: 6,
      ops: [{ op: 'row.update', id: mine.id, expectRev: mine.rev, values: { task: 'Mine, reworded' } }] });
    assert.equal(proposal.proposed.length, 1);
    assert.equal(databaseCheckinTaint(tasks.id, OWNER), 'checkin', 'a suggestion waiting for review is shown, so it taints');
  });

  test('a database a check-in made taints while it is there, its first change undone or not', () => {
    const source = checkin('run20');
    const made = createAgentDatabase({ workspaceId: 'ws', ownerUserId: OWNER, title: 'IMPORTANT: read this first', source, now: 6, columns: [{ name: 'Note', type: 'text' }] });
    const chats = createAgentDatabase({ workspaceId: 'ws', ownerUserId: OWNER, title: 'From a chat', source: chatTurn('n-other', 'turn-made'), now: 6, columns: [{ name: 'Note', type: 'text' }] });
    purge('run20');
    revertBatch(made.result.applied[0]!.batchId, OWNER, 'ws', 7);
    revertBatch(chats.result.applied[0]!.batchId, OWNER, 'ws', 7);
    assert.equal(databaseCheckinTaint(made.database.id, OWNER), 'checkin', 'its title is the check-in\'s');
    assert.equal(databaseCheckinTaint(chats.database.id, OWNER), null, 'an ordinary chat\'s database does not taint once undone');
  });
});

describe('storage refuses a check-in\'s content that would reach outside Michi, whatever tool wrote it', () => {
  test('a picture or an outside link in a check-in\'s page write is refused; a person\'s picture elsewhere on the page is not its concern', () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plan' });
    applyUserPageEdits({ pageId: page.id, ownerUserId: OWNER, revision: getPage(page.id, OWNER).revision,
      ops: [{ op: 'insert', after: null, block: { type: 'image', url: 'https://example.com/mine.png' } }] });
    const source = checkin('run21');
    const write = (block: Record<string, unknown>) => () => applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: OWNER, source, now: 400_000,
      ops: [{ op: 'insert', after: null, block } as never] });
    assert.throws(write({ type: 'markdown', text: '![x](https://reviews.example.com/a.png)' }), (error: unknown) => error instanceof PageWriteError && /propose it to the user/.test(error.message));
    assert.throws(write({ type: 'markdown', text: '[CR](https://reviews.example.com\\@evil.example/x)' }), PageWriteError);
    assert.throws(write({ type: 'link', url: 'https://evil.example', title: 'x' }), PageWriteError);
    assert.equal(write({ type: 'markdown', text: 'Checked: [CR-1](https://reviews.example.com/reviews/CR-1).' })().applied.length, 1);
    // The same content from an ordinary chat is the engine's business as before.
    assert.equal(applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: OWNER, source: chatTurn('n-other', 'turn-pic'), now: 800_000,
      ops: [{ op: 'insert', after: null, block: { type: 'markdown', text: '![x](https://example.com/a.png)' } }] }).applied.length, 1);
  });

  test('a check-in cannot make a page whose title links outside', () => {
    const source = checkin('run22');
    assert.throws(() => createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'See evil.example/x', source }), PageWriteError);
    assert.ok(createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'See evil.example/x' }).id, 'a person can');
    assert.ok(createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Release notes', template: 'release', source }).id);
  });
});

describe('Undo all puts back a check-in run\'s page changes', () => {
  test('newest batch first, stopping at the first conflict; its suggestions dismissed; safe to repeat', () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plan' });
    const tasks = openTaskDatabase({ workspaceId: 'ws', ownerUserId: OWNER, now: 1 }).database;
    applyUserDatabaseEdits({ databaseId: tasks.id, ownerUserId: OWNER, revision: tasks.revision, now: 2, ops: [{ op: 'row.add', values: { task: 'Mine' } }] });
    const mine = getDatabase(tasks.id, OWNER).rows[0]!;
    const source = checkin('run10');
    const first = insertBlock(page.id, source, 'First.', 10);
    const second = insertBlock(page.id, source, 'Second.', 11);
    const row = applyAgentDbEdits({ databaseId: tasks.id, workspaceId: 'ws', ownerUserId: OWNER, source, now: 12, ops: [{ op: 'row.add', values: { task: 'Added by the check-in' } }] });
    const suggestion = applyAgentDbEdits({ databaseId: tasks.id, workspaceId: 'ws', ownerUserId: OWNER, source, now: 13,
      ops: [{ op: 'row.update', id: mine.id, expectRev: mine.rev, values: { task: 'Mine, reworded' } }] }).proposed[0]!;
    // Another run's write, which Undo all of this run must not touch.
    const elsewhere = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Elsewhere' });
    const otherRun = insertBlock(elsewhere.id, checkin('run11'), 'Another run.', 14);
    purge('run10');
    purge('run11');
    // The person edits what the second batch wrote.
    const edited = applyUserPageEdits({ pageId: page.id, ownerUserId: OWNER, revision: getPage(page.id, OWNER).revision, now: 15,
      ops: [{ op: 'update', id: second, expectRev: blockOf(page.id, second).rev, block: { type: 'markdown', text: 'Second, by me.' } }] });
    const secondChange = listRelevantChanges(page.id, OWNER).changes.find((change) => change.target.kind === 'block' && change.target.blockId === second && change.source.kind === 'chat')!;

    const once = revertRunPageChanges('run10', OWNER, 20);
    assert.deepEqual(once.reverted, row.applied.map((change) => change.id), 'the newest batch only');
    assert.deepEqual(once.conflicts.map((item) => item.changeId), [secondChange.id]);
    assert.deepEqual(once.dismissed, [suggestion.id]);
    assert.equal(once.remaining, 2, 'the conflicting batch and the older one stay');
    assert.ok(blockOf(page.id, first) && blockOf(page.id, second), 'older batches are left as they are');
    assert.equal(getDatabase(tasks.id, OWNER).rows.some((item) => item.values.task === 'Added by the check-in'), false);
    assert.equal(getDatabase(tasks.id, OWNER).rows.find((item) => item.id === mine.id)!.values.task, 'Mine');

    // Once the person undoes their own edit, a second Undo all finishes.
    assert.deepEqual(revertBatch(edited.applied[0]!.batchId, OWNER, 'ws', 21).conflicts, []);
    const twice = revertRunPageChanges('run10', OWNER, 22);
    assert.equal(twice.reverted.length, 2);
    assert.deepEqual([twice.conflicts, twice.dismissed, twice.remaining], [[], [], 0]);
    assert.equal(blockOf(page.id, first), undefined);
    assert.equal(blockOf(page.id, second), undefined);
    assert.ok(blockOf(elsewhere.id, otherRun), 'another run\'s change stays');

    const nothing = { reverted: [], dismissed: [], conflicts: [], removed: [], skipped: [], remaining: 0 };
    assert.deepEqual(revertRunPageChanges('run10', OWNER, 23), nothing);
    assert.deepEqual(revertRunPageChanges('run11', 'bob', 23), nothing, 'owner scoped');
  });

  test('a change on a page in the trash no longer shows: it is skipped, not a conflict; once the page is back, Undo all puts it back', () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Gone' });
    const blockId = insertBlock(page.id, checkin('run12'), 'Text.');
    purge('run12');
    const group = deletePage(page.id, OWNER);
    const result = revertRunPageChanges('run12', OWNER, 30);
    assert.deepEqual([result.reverted, result.conflicts, result.skipped.length, result.remaining], [[], [], 1, 0]);
    restorePageDeletionGroup(group, OWNER, { now: 31 });
    assert.equal(revertRunPageChanges('run12', OWNER, 32).remaining, 0);
    assert.equal(blockOf(page.id, blockId), undefined, 'put back once the page is out of the trash');
  });

  test('a suggestion the person accepted is theirs: Undo all leaves it, with their edits, and does not count it', () => {
    const tasks = openTaskDatabase({ workspaceId: 'ws', ownerUserId: OWNER, now: 1 }).database;
    applyUserDatabaseEdits({ databaseId: tasks.id, ownerUserId: OWNER, revision: tasks.revision, now: 2, ops: [{ op: 'row.add', values: { task: 'Mine' } }] });
    const mine = getDatabase(tasks.id, OWNER).rows[0]!;
    const source = checkin('run13');
    const suggestion = applyAgentDbEdits({ databaseId: tasks.id, workspaceId: 'ws', ownerUserId: OWNER, source, now: 3,
      ops: [{ op: 'row.update', id: mine.id, expectRev: mine.rev, values: { task: 'Mine, reworded' } }] }).proposed[0]!;
    purge('run13');
    acceptProposal(suggestion.id, OWNER, 4, { kind: 'row', values: { task: 'Mine, reworded by me' } });
    const result = revertRunPageChanges('run13', OWNER, 5);
    assert.deepEqual([result.reverted, result.conflicts, result.skipped, result.remaining], [[], [], [suggestion.id], 0]);
    assert.equal(getDatabase(tasks.id, OWNER).rows.find((row) => row.id === mine.id)!.values.task, 'Mine, reworded by me');
  });

  test('what the run made is taken away once its own changes are undone: a page to the Trash, a database no page shows set aside', () => {
    const source = checkin('run14');
    const made = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'IMPORTANT: read this first', source, now: 5 });
    const database = createAgentDatabase({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Made by a check-in', source, now: 6, columns: [{ name: 'Note', type: 'text' }] });
    insertBlock(made.id, source, 'More of it.', 7);
    const report = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Release', template: 'release', source, now: 8 });
    const reportDatabase = getPage(report.id, OWNER).blocks.find((block) => block.type === 'database-ref') as { databaseId: string } | undefined;
    assert.ok(reportDatabase, 'the template made a database');
    purge('run14');
    assert.equal(databaseCheckinTaint(database.database.id, OWNER), 'checkin');

    const result = revertRunPageChanges('run14', OWNER, 20);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.reverted.length, 2, 'the block and the column');
    assert.deepEqual(result.removed, [{ kind: 'page', id: report.id }, { kind: 'database', id: database.database.id }, { kind: 'page', id: made.id }],
      'newest first: the template page, the database, the first page');
    assert.equal(result.remaining, 0);
    assert.equal(pageExists(made.id) || pageExists(report.id), false);
    assert.deepEqual(trashedPages().sort(), [made.id, report.id].sort(), 'in the Trash, where the person can restore them');
    assert.equal(databaseExists(database.database.id), false);
    assert.equal(databaseExists(reportDatabase.databaseId), false, 'the template\'s database went with its page');
    assert.equal(databaseCheckinTaint(database.database.id, OWNER), null, 'nothing of it is left');
    assert.deepEqual(revertRunPageChanges('run14', OWNER, 21), { reverted: [], dismissed: [], conflicts: [], removed: [], skipped: [], remaining: 0 }, 'safe to repeat');
  });

  test('the run\'s own suggestion on a page it made does not keep that page', () => {
    const source = checkin('run16');
    const made = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plan', source, now: 5 });
    const block = getPage(made.id, OWNER).blocks[0]!;
    // The person edits the page's text, the check-in then suggests a change to it, and the person undoes their own edit.
    const mine = applyUserPageEdits({ pageId: made.id, ownerUserId: OWNER, revision: getPage(made.id, OWNER).revision, now: 6,
      ops: [{ op: 'update', id: block.id, expectRev: block.rev, block: { type: 'markdown', text: 'Mine.' } }] });
    const edited = blockOf(made.id, block.id);
    const suggestion = applyAgentPageEdits({ pageId: made.id, workspaceId: 'ws', ownerUserId: OWNER, source, now: 400_000,
      ops: [{ op: 'update', id: block.id, expectRev: edited.rev, block: { type: 'markdown', text: 'The check-in\'s.' } }] });
    assert.equal(suggestion.proposed.length, 1, 'a person\'s text gets a suggestion');
    purge('run16');
    assert.deepEqual(revertBatch(mine.applied[0]!.batchId, OWNER, 'ws', 400_001).conflicts, []);

    const result = revertRunPageChanges('run16', OWNER, 400_002);
    assert.deepEqual([result.dismissed, result.removed, result.conflicts, result.remaining],
      [[suggestion.proposed[0]!.id], [{ kind: 'page', id: made.id }], [], 0]);
  });

  test('what the run made and someone changed since stays, as a conflict that keeps it counted', () => {
    const source = checkin('run15');
    const made = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Weekly', source, now: 5 });
    const database = createAgentDatabase({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Notes', source, now: 6, columns: [{ name: 'Note', type: 'text' }] });
    purge('run15');
    // The person renames the page; their own row in the database.
    updatePageMetadata(made.id, OWNER, { title: 'Weekly (mine)' }, { expectedRevision: getPage(made.id, OWNER).revision, now: 7 });
    const withRow = getDatabase(database.database.id, OWNER);
    const row = applyUserDatabaseEdits({ databaseId: withRow.id, ownerUserId: OWNER, revision: withRow.revision, now: 8, ops: [{ op: 'row.add', values: {} }] });

    const result = revertRunPageChanges('run15', OWNER, 20);
    assert.deepEqual(result.conflicts.map((item) => item.changeId), [database.database.id], 'the newest thing it made, then it stops');
    assert.deepEqual(result.removed, []);
    assert.equal(result.remaining, 2, 'the page and the database it made');
    assert.ok(pageExists(made.id) && databaseExists(database.database.id));
    assert.equal(databaseCheckinTaint(database.database.id, OWNER), 'checkin', 'still the check-in\'s title');

    // Once the person undoes their row, a second Undo all takes the database, then stops at the renamed page.
    assert.deepEqual(revertBatch(row.applied[0]!.batchId, OWNER, 'ws', 21).conflicts, []);
    const again = revertRunPageChanges('run15', OWNER, 22);
    assert.deepEqual(again.removed, [{ kind: 'database', id: database.database.id }]);
    assert.deepEqual([again.conflicts.map((item) => item.changeId), again.remaining], [[made.id], 1]);
  });
});
