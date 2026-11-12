/**
 * What the Pages, Home and Home-card routes send for something a check-in
 * wrote (DESIGN-v2 §2.7). The check-in's node is purged after its run, so
 * every DTO that can carry its source goes out presented
 * (services/pages/checkinSources.ts): the source opens the post the run made
 * in the conversation, marked as a check-in's, and no route names the
 * purged n-cmph- node. Storage keeps the check-in's own source.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  CHECKIN_NODE_PREFIX, checkinNodeId, companionCheckinTurnId, companionPostId,
  type BlockSource, type HomeCard, type HomeCardsDto, type PageBlock, type PageChangeDto, type PageDto,
  type PageWriteResult, type SpacesHomeDto, type WorkspaceHomeDto,
} from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { ensureAssistant } from '../src/assistant/store';
import { setupPagesRoutes } from '../src/routes/pages';
import { setupSpacesHomeRoutes } from '../src/routes/spacesHome';
import { setupHomeCardsRoutes } from '../src/routes/homeCards';
import { applyAgentPageEdits, applyUserPageEdits } from '../src/services/pages/pageWrites';
import { applyAgentDbEdits, applyUserDatabaseEdits, createAgentDatabase } from '../src/services/pages/databaseWrites';
import { createPage, deletePage, getPage, type PageTrashResult } from '../src/services/pages/repository';
import { openTaskDatabase } from '../src/services/pages/taskDatabase';
import { ensureSpacesHomePageId, ensureWorkspaceHomePageId } from '../src/services/pages/homePages';
import { editHomeCustomization, readHomeCustomization } from '../src/services/homeCards/repository';

const OWNER = LOCAL_AGENT_OWNER_ID;
type ChatSource = BlockSource & { kind: 'chat' };

let dataDir: string;
let server: Server | undefined;
let previousDataDir: string | undefined;
let previousCloud: string | undefined;
let baseUrl = '';
/** The assistant's hidden workspace and the conversation a run posts in. */
let assistantWorkspace = '';
let conversation = '';
let seq = 100;

beforeEach(async () => {
  previousDataDir = process.env.MICHI_DATA_DIR;
  previousCloud = process.env.MICHI_CLOUD;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pages-checkin-presentation-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('ws', 'Workspace', OWNER);
  const assistant = ensureAssistant();
  assistantWorkspace = assistant.workspaceId;
  conversation = assistant.nodeId;
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use((req, _res, next) => {
    (req as any).user = { id: req.header('x-user-id') ?? OWNER, email: 'test@example.test' };
    next();
  });
  app.use('/api', setupPagesRoutes());
  app.use('/api', setupSpacesHomeRoutes({ clock: () => 50_000 }));
  app.use('/api', setupHomeCardsRoutes({ clock: () => 50_000 }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  closeDb();
  if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousDataDir;
  if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A check-in run's node in the assistant workspace with its live turn (W2-G1a): its write source. */
function checkin(runId: string): ChatSource {
  const nodeId = checkinNodeId(runId);
  const turnId = companionCheckinTurnId(runId);
  const assistantId = `self-${nodeId}-${turnId}`;
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,title,created_at) VALUES (?,?,'chat','idle','',1)").run(nodeId, assistantWorkspace);
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,'active',1,1)").run(turnId, nodeId, assistantId);
  return { kind: 'chat', nodeId, turnId, assistantId };
}

/** The message the run posted into the conversation (W1-B postSelfMessage), then the run's node hard-deleted (§3.1). */
function postAndPurge(runId: string): void {
  getDb().prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES (?,?,'assistant','Checked in.',?,2)")
    .run(companionPostId(runId), conversation, seq++);
  getDb().prepare('DELETE FROM nodes WHERE id=?').run(checkinNodeId(runId));
}

function insertBlock(pageId: string, workspaceId: string, source: ChatSource, text: string, now = 10): string {
  const result = applyAgentPageEdits({ pageId, workspaceId, ownerUserId: OWNER, source, now,
    ops: [{ op: 'insert', after: null, block: { type: 'markdown', text } }] });
  assert.equal(result.applied.length, 1, JSON.stringify(result.rejected));
  return (result.applied[0]!.target as { blockId: string }).blockId;
}

/** A page of the workspace with one block a check-in wrote, posted about and purged. */
function pageFromCheckin(runId: string, title = 'Plan'): { page: PageDto; blockId: string } {
  const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title });
  const blockId = insertBlock(page.id, 'ws', checkin(runId), 'Moved 3 tasks to Done.');
  postAndPurge(runId);
  return { page: getPage(page.id, OWNER), blockId };
}

/** How a check-in's source is shown: the conversation it posted in, the post, and the check-in mark. */
const opensPost = (runId: string) => ({ nodeId: conversation, turnId: companionPostId(runId), assistantId: companionPostId(runId), checkin: true });
const storedSource = (runId: string) => {
  const nodeId = checkinNodeId(runId);
  const turnId = companionCheckinTurnId(runId);
  return { nodeId, turnId, assistantId: `self-${nodeId}-${turnId}` };
};
const blockIn = (page: Pick<PageDto, 'blocks'>, blockId: string): PageBlock => page.blocks.find((block) => block.id === blockId)!;

async function request(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
}
/** The response body, after checking its status and that it names no check-in node anywhere. */
async function shown<T>(pathname: string, init?: RequestInit, status = 200): Promise<T> {
  const response = await request(pathname, init);
  const text = await response.text();
  assert.equal(response.status, status, `${init?.method ?? 'GET'} ${pathname}: ${text}`);
  assert.ok(!text.includes(CHECKIN_NODE_PREFIX), `${init?.method ?? 'GET'} ${pathname} names a check-in node: ${text}`);
  return JSON.parse(text) as T;
}
const json = (value: unknown): string => JSON.stringify(value);

describe('the Pages routes send a check-in\'s source as the post its run made', () => {
  test('GET /pages/:id: the block opens the post; storage keeps the check-in node; ?since still answers 204', async () => {
    const { page, blockId } = pageFromCheckin('run-get');
    const read = await shown<PageDto>(`/pages/${page.id}`);
    assert.deepEqual(blockIn(read, blockId).sources, [opensPost('run-get')]);
    assert.deepEqual(blockIn(getPage(page.id, OWNER), blockId).sources, [storedSource('run-get')], 'storage is not rewritten');
    assert.equal((await request(`/pages/${page.id}?since=${page.viewVersion}`)).status, 204);
  });

  test('POST /pages/:id/edits: the page, and the block each change held before and after, open the post', async () => {
    const { page, blockId } = pageFromCheckin('run-edit');
    const edited = await shown<{ page: PageDto; changes: PageWriteResult }>(`/pages/${page.id}/edits`, {
      method: 'POST', body: json({ revision: page.revision, ops: [{ op: 'update', id: blockId, block: { type: 'markdown', text: 'Moved 4 tasks to Done.' } }] }),
    });
    assert.equal(edited.page.revision, page.revision + 1);
    // A person's edit keeps the block's sources, so the page it answers with still holds the check-in's.
    assert.deepEqual(blockIn(edited.page, blockId).sources, [opensPost('run-edit')]);
    assert.equal(edited.changes.applied.length, 1);
    const [change] = edited.changes.applied;
    assert.ok(change?.before?.kind === 'block' && change.before.exists && change.after?.kind === 'block' && change.after.exists);
    assert.deepEqual(change.before.block.sources, [opensPost('run-edit')]);
    assert.deepEqual(change.after.block.sources, [opensPost('run-edit')]);
    assert.ok(change.forward.kind === 'block' && change.forward.op === 'upsert' && change.inverse.kind === 'block' && change.inverse.op === 'upsert');
    assert.deepEqual(change.forward.block.sources, [opensPost('run-edit')]);
    assert.deepEqual(change.inverse.block.sources, [opensPost('run-edit')]);
    assert.deepEqual(change.source, { kind: 'user' }, 'the edit itself is the person\'s');
    assert.deepEqual(edited.changes.proposed, []);
    assert.deepEqual(blockIn(getPage(page.id, OWNER), blockId).sources, [storedSource('run-edit')], 'storage is not rewritten');
  });

  test('PATCH /pages/:id: the renamed page opens the post', async () => {
    const { page, blockId } = pageFromCheckin('run-patch');
    const renamed = await shown<PageDto>(`/pages/${page.id}`, { method: 'PATCH', body: json({ revision: page.revision, title: 'Weekly plan' }) });
    assert.equal(renamed.title, 'Weekly plan');
    assert.deepEqual(blockIn(renamed, blockId).sources, [opensPost('run-patch')]);
  });

  test('GET /workspaces/:id/pages/trash: a trashed page\'s root opens the post', async () => {
    const { page, blockId } = pageFromCheckin('run-trash');
    deletePage(page.id, OWNER);
    const trash = await shown<PageTrashResult>('/workspaces/ws/pages/trash');
    const root = trash.items.find((group) => group.root.id === page.id)?.root;
    assert.ok(root, 'the trashed page is listed');
    assert.deepEqual(blockIn(root, blockId).sources, [opensPost('run-trash')]);
  });

  test('D12: a run that posted nothing opens the conversation without a message; with no conversation its source is dropped', async () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Quiet' });
    const blockId = insertBlock(page.id, 'ws', checkin('run-quiet'), 'Nothing to report.');
    getDb().prepare('DELETE FROM nodes WHERE id=?').run(checkinNodeId('run-quiet'));
    const read = await shown<PageDto>(`/pages/${page.id}`);
    assert.deepEqual(blockIn(read, blockId).sources, [{ nodeId: conversation, turnId: null, assistantId: null, checkin: true }]);

    getDb().prepare('UPDATE nodes SET deleted_at=5 WHERE id=?').run(conversation);
    const nowhere = await shown<PageDto>(`/pages/${page.id}`);
    assert.equal(blockIn(nowhere, blockId).sources, undefined, 'dropped, never the purged node');
    const changes = (await shown<{ changes: PageChangeDto[] }>(`/pages/${page.id}/changes`)).changes;
    assert.deepEqual(changes.find((change) => change.source.kind === 'chat')!.source, { kind: 'chat', nodeId: '', turnId: null, assistantId: null, checkin: true });
  });

  test('C2-review #1: no block or task names a check-in\'s own node for the first time', () => {
    const run = checkin('run-ref');
    // A check-in's node can live in the page's workspace: the Spaces Home shares the assistant's on a local install.
    const homeId = ensureSpacesHomePageId(OWNER, 1);
    assert.equal(getPage(homeId, OWNER).workspaceId, assistantWorkspace, 'the case the check guards');
    const named = applyAgentPageEdits({ pageId: homeId, workspaceId: assistantWorkspace, ownerUserId: OWNER, source: run, now: 20, ops: [
      { op: 'insert', after: null, block: { type: 'threads', nodeIds: [run.nodeId] } },
      { op: 'insert', after: null, block: { type: 'conflict', question: 'Which plan?', options: [{ text: 'Mine', nodeId: run.nodeId }, { text: 'Theirs' }] } },
    ] });
    assert.deepEqual(named.applied, []);
    assert.deepEqual(named.rejected.map((rejected) => rejected.reason), ['invalid', 'invalid']);
    assert.match(named.rejected[0]!.message, /check-in's own/);
    assert.ok(!getPage(homeId, OWNER).blocks.some((block) => block.type === 'threads' || block.type === 'conflict'));
    assert.throws(() => applyUserPageEdits({ pageId: homeId, ownerUserId: OWNER, revision: getPage(homeId, OWNER).revision,
      ops: [{ op: 'insert', after: null, block: { type: 'threads', nodeIds: [run.nodeId] } }] }), /check-in's own/, 'nor a person\'s edit');

    // A task's Conversations cell: the same rule, wherever the node is.
    getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,title,created_at) VALUES (?,'ws','chat','idle','',1)").run(checkinNodeId('run-ws'));
    const tasks = openTaskDatabase({ workspaceId: 'ws', ownerUserId: OWNER, now: 21 }).database;
    assert.throws(() => applyUserDatabaseEdits({ databaseId: tasks.id, ownerUserId: OWNER, revision: tasks.revision, now: 22,
      ops: [{ op: 'row.add', values: { task: 'Linked', threads: [checkinNodeId('run-ws')] } }] }), /check-in's own/);
  });

  test('a page with nothing from a check-in is sent as stored', async () => {
    const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Mine' });
    const written = applyUserPageEdits({ pageId: page.id, ownerUserId: OWNER, revision: page.revision,
      ops: [{ op: 'insert', after: null, block: { type: 'markdown', text: 'Mine.' } }] });
    assert.equal(written.applied.length, 1);
    assert.deepEqual(await shown<PageDto>(`/pages/${page.id}`), getPage(page.id, OWNER));
  });
});

describe('the Home routes send their page presented', () => {
  test('GET /spaces-home: a check-in block on the Spaces Home opens the post', async () => {
    const homeId = ensureSpacesHomePageId(OWNER, 1);
    const blockId = insertBlock(homeId, getPage(homeId, OWNER).workspaceId, checkin('run-spaces'), 'Today: two CRs to review.');
    postAndPurge('run-spaces');
    const home = await shown<SpacesHomeDto>('/spaces-home');
    assert.equal(home.page.id, homeId);
    assert.deepEqual(blockIn(home.page, blockId).sources, [opensPost('run-spaces')]);
  });

  test('GET and PATCH /workspaces/:id/home: a check-in block on the workspace home opens the post', async () => {
    const homeId = ensureWorkspaceHomePageId('ws', OWNER, 1);
    const blockId = insertBlock(homeId, 'ws', checkin('run-home'), 'Release blocked on one test.');
    postAndPurge('run-home');
    const home = await shown<WorkspaceHomeDto>('/workspaces/ws/home');
    assert.equal(home.page.id, homeId);
    assert.deepEqual(blockIn(home.page, blockId).sources, [opensPost('run-home')]);
    const hidden = await shown<WorkspaceHomeDto>('/workspaces/ws/home', { method: 'PATCH', body: json({ hidden: true }) });
    assert.ok(hidden.hiddenAt !== null);
    assert.deepEqual(blockIn(hidden.page, blockId).sources, [opensPost('run-home')]);
  });
});

describe('the Home card routes send the content page and the cards presented', () => {
  const card = (id: string, threadNodeId: string): HomeCard => ({
    id, kind: 'continue', label: 'Workspace', source: { workspaceId: 'ws', threadNodeId },
    title: `Title ${id}`, reason: 'Two cases left.', buttonText: 'Continue', prompt: `Prompt ${id}`, workspaceId: 'ws',
  });

  test('GET /home/cards: the chosen content page opens the post', async () => {
    const { page, blockId } = pageFromCheckin('run-content', 'Home content');
    editHomeCustomization(OWNER, { expectedRevision: 0, contentMode: 'page', pageId: page.id });
    const cards = await shown<HomeCardsDto>('/home/cards');
    assert.equal(cards.contentPage?.id, page.id);
    assert.deepEqual(blockIn(cards.contentPage!, blockId).sources, [opensPost('run-content')]);
  });

  test('PUT and GET /home/cards: a card on a check-in\'s conversation opens the one it posted in; other cards are as written', async () => {
    checkin('run-card');
    postAndPurge('run-card');
    const write = { greeting: null, inputFingerprint: null, sets: [{ cards: [card('a', checkinNodeId('run-card')), card('b', 'n-chat')] }] };
    const answered = await shown<HomeCardsDto>('/home/cards', { method: 'PUT', body: json(write) });
    assert.deepEqual(answered.sets[0]!.cards[0]!.source, { workspaceId: 'ws', threadNodeId: conversation });
    assert.deepEqual(answered.sets[0]!.cards[1], card('b', 'n-chat'));
    assert.deepEqual((await shown<HomeCardsDto>('/home/cards')).sets, answered.sets);

    // Cards the person chose are sent the same way.
    editHomeCustomization(OWNER, { expectedRevision: 0, cardsMode: 'custom', setsJson: json([{ cards: [card('c', checkinNodeId('run-card'))] }]) });
    assert.deepEqual((await shown<HomeCardsDto>('/home/cards')).sets[0]!.cards[0]!.source, { workspaceId: 'ws', threadNodeId: conversation });
  });

  test('with no conversation to open, a check-in\'s card opens none', async () => {
    getDb().prepare('UPDATE nodes SET deleted_at=5 WHERE id=?').run(conversation);
    const write = { greeting: null, inputFingerprint: null, sets: [{ cards: [card('a', checkinNodeId('run-gone'))] }] };
    const answered = await shown<HomeCardsDto>('/home/cards', { method: 'PUT', body: json(write) });
    assert.deepEqual(answered.sets[0]!.cards[0]!.source, { workspaceId: 'ws' });
  });

  test('the Home edit_home answers with (read_home\'s too) is presented the same way; the stored preferences are echoed as written', () => {
    const { page, blockId } = pageFromCheckin('run-tool', 'Home content');
    checkin('run-tool-card');
    postAndPurge('run-tool-card');
    const answered = editHomeCustomization(OWNER, {
      expectedRevision: 0, contentMode: 'page', pageId: page.id, cardsMode: 'custom', setsJson: json([{ cards: [card('t', checkinNodeId('run-tool-card'))] }]),
    });
    assert.ok(!JSON.stringify(answered.content).includes(CHECKIN_NODE_PREFIX), JSON.stringify(answered.content));
    assert.deepEqual(blockIn(answered.content.contentPage!, blockId).sources, [opensPost('run-tool')]);
    assert.deepEqual(answered.content.sets[0]!.cards[0]!.source, { workspaceId: 'ws', threadNodeId: conversation });
    // C2-review #3: the chosen cards in `preferences` read as `content.sets` does, in edit_home's answer and read_home's.
    assert.deepEqual(answered.preferences.sets?.[0]?.cards[0]?.source, { workspaceId: 'ws', threadNodeId: conversation });
    assert.deepEqual(readHomeCustomization(OWNER).preferences.sets?.[0]?.cards[0]?.source, { workspaceId: 'ws', threadNodeId: conversation });
    const stored = () => JSON.parse((getDb().prepare('SELECT preferences FROM home_customization WHERE owner_user_id=?').get(OWNER) as { preferences: string }).preferences);
    assert.equal(stored().sets[0].cards[0].source.threadNodeId, checkinNodeId('run-tool-card'), 'storage keeps the card as written');
    const later = editHomeCustomization(OWNER, { expectedRevision: answered.revision, greetingMode: 'hidden' });
    assert.ok(!JSON.stringify(later).includes(CHECKIN_NODE_PREFIX), JSON.stringify(later));
    assert.equal(stored().sets[0].cards[0].source.threadNodeId, checkinNodeId('run-tool-card'), 'an edit writes back the stored form, never the shown one');
  });
});

test('no Pages, Home or Home card route names a check-in node, whatever it wrote', async () => {
  const run = checkin('run-all');
  const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Plan' });
  insertBlock(page.id, 'ws', run, 'Moved 3 tasks to Done.');
  const made = createAgentDatabase({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Reading list', source: run, now: 11,
    columns: [{ name: 'Title', type: 'text' }] }).database;
  const tasks = openTaskDatabase({ workspaceId: 'ws', ownerUserId: OWNER, now: 12 }).database;
  applyUserDatabaseEdits({ databaseId: tasks.id, ownerUserId: OWNER, revision: tasks.revision, now: 13, ops: [{ op: 'row.add', values: { task: 'Mine' } }] });
  const mine = (await shown<{ rows: Array<{ id: string; rev: number }> }>(`/databases/${tasks.id}`)).rows[0]!;
  const added = applyAgentDbEdits({ databaseId: tasks.id, workspaceId: 'ws', ownerUserId: OWNER, source: run, now: 14,
    ops: [{ op: 'row.add', values: { task: 'Review CR-1' } }, { op: 'row.update', id: mine.id, expectRev: mine.rev, values: { task: 'Mine, reworded' } }] });
  assert.equal(added.proposed.length, 1, 'a person\'s task gets a suggestion');
  const trashed = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Old notes' });
  insertBlock(trashed.id, 'ws', run, 'Old.', 15);
  deletePage(trashed.id, OWNER);
  // C2-review #1: a threads block or a conflict option naming the run's own node on the Spaces Home is refused.
  const homeId = ensureSpacesHomePageId(OWNER, 1);
  insertBlock(homeId, assistantWorkspace, run, 'Two CRs to review.', 16);
  const named = applyAgentPageEdits({ pageId: homeId, workspaceId: assistantWorkspace, ownerUserId: OWNER, source: run, now: 17, ops: [
    { op: 'insert', after: null, block: { type: 'threads', nodeIds: [run.nodeId, conversation] } },
    { op: 'insert', after: null, block: { type: 'conflict', question: 'Which?', options: [{ text: 'A', nodeId: run.nodeId }, { text: 'B' }] } },
  ] });
  assert.equal(named.applied.length, 0, JSON.stringify(named.applied));
  postAndPurge('run-all');

  const changes = (await shown<{ changes: PageChangeDto[] }>(`/pages/${page.id}/changes`)).changes;
  const fromRun = changes.find((change) => change.source.kind === 'chat')!;
  assert.deepEqual(fromRun.source, { kind: 'chat', ...opensPost('run-all') });
  const taskRow = (await shown<{ rows: Array<{ id: string; values: Record<string, unknown> }> }>(`/databases/${tasks.id}`)).rows
    .find((row) => row.values.task === 'Review CR-1')!;
  for (const route of [
    '/spaces', '/spaces?workspaceId=ws', '/workspaces/ws/pages', '/workspaces/ws/pages/trash', '/workspaces/ws/databases',
    `/databases/${made.id}`, `/databases/${tasks.id}`, `/databases/${tasks.id}/task-activity`, `/databases/${tasks.id}/rows/${taskRow.id}/origin`,
    `/pages/${page.id}`, `/pages/${page.id}/changes?direction=backward`, `/page-batches/${fromRun.batchId}`,
    '/spaces-home', '/spaces-home/workspaces', '/workspaces/ws/home', '/home/cards',
  ]) await shown(route);
  await shown(`/page-changes/${added.proposed[0]!.id}/dismiss`, { method: 'POST' });
  await shown(`/page-changes/${added.proposed[0]!.id}/reopen`, { method: 'POST' });
  await shown(`/page-changes/${added.proposed[0]!.id}/accept`, { method: 'POST', body: '{}' });
  await shown(`/page-changes/${fromRun.id}/revert`, { method: 'POST' });
  await shown(`/page-changes/${fromRun.id}/redo`, { method: 'POST' });
  await shown(`/page-batches/${fromRun.batchId}/revert`, { method: 'POST' });
  await shown(`/page-batches/${fromRun.batchId}/redo`, { method: 'POST' });
});
