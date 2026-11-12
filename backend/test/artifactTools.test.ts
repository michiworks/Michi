// Artifact agent tools (agents/artifactTools.ts): list ordering and paging,
// search bounds and snippets, delete semantics (the user confirms every
// deletion; the row goes, the file stays) and owner/workspace isolation, on
// the shared executor and through both tool surfaces (Michi's MCP server with
// its ask_user channel and session sink, and Pi's built-in tools with their
// ask_user channel and stream event), plus their catalog, trust and permission entries.
import { afterEach, beforeEach, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  deleteContext, getWorkspace, isContextTombstoned, listContexts, saveContext, upsertAgentContextMetadata, type ContextRow,
} from '../src/services/dbRepository';
import * as workspaceFiles from '../src/services/workspaceFiles';
import {
  artifactTool, SEARCH_MAX_BYTES_PER_FILE, SEARCH_MAX_FILES_READ,
  type ArtifactApprovalRequest, type ArtifactToolCaller, type ArtifactToolHooks, type DeletedArtifact,
} from '../src/agents/artifactTools';
import { askUserApprover, type HostApprovalResult } from '../src/agents/hostApproval';
import { ARTIFACT_TOOL_NAMES, type ArtifactToolName } from '../src/agents/artifactToolNames';
import { BUILTIN_TOOLS, CHAT_ONLY_BUILTIN_TOOLS } from '../src/agents/builtinTools';
import { resolveChatPolicy } from '../src/agents/permissionPolicy';
import { classifyToolTrust, MICHI_TOOL_NAMES } from '../src/services/turnTrust';
import { isMaintenanceInternalTool } from '../src/services/metaAgent/maintenanceAccess';
import { CHECKIN_TOOL_NAMES, MAIN_TOOL_NAMES } from '../src/assistant/policy';
import { toChatStreamEvent } from '../src/routes/chatStreamEvents';
import { McpSlotRegistry, mountMcp } from '../src/services/mcpServer';
import { JSON_BODY_LIMIT_BYTES } from '../src/services/requestBodyLimit';
import { buildPiTools } from '../src/agents/pi/piTools';
import { mapAgentEvent } from '../src/agents/pi/eventMapper';
import { loadPiTypebox } from '../src/agents/pi/piAi';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { acpPermissionToolName } from 'michi-runtime/internal/adapters/kiro/kiroToolNames';
import { encodeChatStreamEvent, type ChatPermissionMode, type UserInputAnswer, type UserInputQuestion } from 'michi-shared';
import { chatOwner, runOwner } from './helpers/owners';

const saved = { cloud: process.env.MICHI_CLOUD, dataDir: process.env.MICHI_DATA_DIR };
let root: string;
/** The workspaces' cloud sandboxes (<dataDir>/user-cwds/<owner>/ws-<id>), where their sessions run. */
let cwdA: string;
let cwdB: string;

function workspace(id: string, ownerUserId: string | null, cwd: string): void {
  getDb().prepare('INSERT INTO workspaces (id, name, cwd, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
    .run(id, `Workspace ${id}`, cwd, ownerUserId);
}

/** The workspace row's cwd: in cloud mode whatever a client stored. */
function storeWorkspaceCwd(id: string, cwd: string): void {
  getDb().prepare('UPDATE workspaces SET cwd = ? WHERE id = ?').run(cwd, id);
}

/** What the server configures: the sandbox derivation reads the data dir and the workspace store. */
function configureDeps(mode?: ChatPermissionMode): void {
  configureRuntimeDeps({
    dataDir: path.join(root, 'data'),
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace, getWorkspaceInstructions: () => null } as any,
    agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined } as any,
    ...(mode ? { chatPermissions: { getMode: () => mode, hasGrant: () => true, grant: () => {} } } : {}),
  });
}

function artifact(id: string, workspaceId: string, name: string, fields: Partial<ContextRow> = {}): void {
  saveContext({
    id, workspace_id: workspaceId, name, file_path: `.contexts/${name}.md`, size: null, auto_inject: 0,
    source: 'agent', type: 'doc', url: null, origin_node_id: null, origin_message_id: null, kind: 'embedded',
    pinned_at: null, created_at: 1, updated_at: 1, rev: null, ...fields,
  } as ContextRow);
}

/** A `.contexts/` document in the workspace folder. */
function doc(cwd: string, name: string, body: string): void {
  fs.mkdirSync(path.join(cwd, '.contexts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.contexts', `${name}.md`), body);
}

const alice: ArtifactToolCaller = { ownerUserId: 'alice', workspaceId: 'ws-a', cwd: null };

/** Every card delete_artifact showed, and the user's answer to the next one. */
let asked: ArtifactApprovalRequest[];
let answer: HostApprovalResult;
const approve = async (request: ArtifactApprovalRequest): Promise<HostApprovalResult> => { asked.push(request); return answer; };

async function call(name: ArtifactToolName, args: unknown, caller: ArtifactToolCaller = alice, hooks: ArtifactToolHooks = { approve }) {
  const result = await artifactTool(name, caller, args, hooks);
  const text = result.content.map((part) => part.text).join('');
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* an error result is text */ }
  return { result, text, json };
}

const names = (json: any): string[] => json.artifacts.map((entry: any) => entry.name);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-artifact-tools-')));
  cwdA = path.join(root, 'data', 'user-cwds', 'alice', 'ws-ws-a');
  cwdB = path.join(root, 'data', 'user-cwds', 'bob', 'ws-ws-b');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  process.env.MICHI_DATA_DIR = path.join(root, 'data');
  process.env.MICHI_CLOUD = '1';
  closeDb();
  initDb();
  configureDeps();
  workspace('ws-a', 'alice', cwdA);
  workspace('ws-b', 'bob', cwdB);
  asked = [];
  answer = { approved: true };
});

afterEach(() => {
  __resetRuntimeDeps();
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  if (saved.dataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.dataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('list_artifacts', () => {
  beforeEach(() => {
    artifact('c-old', 'ws-a', 'old', { updated_at: 10 });
    artifact('c-new', 'ws-a', 'new', { updated_at: 30 });
    artifact('c-mid', 'ws-a', 'mid', { updated_at: 20, type: 'image', file_path: 'shots/mid.png', kind: 'reference' });
    artifact('c-pin1', 'ws-a', 'pinned-early', { updated_at: 5, pinned_at: 100 });
    artifact('c-pin2', 'ws-a', 'pinned-late', { updated_at: 1, pinned_at: 200 });
    artifact('c-link', 'ws-a', 'site', { updated_at: 25, type: 'link', file_path: '', url: 'https://example.com/spec', kind: null });
    artifact('c-bob', 'ws-b', 'bobs', { updated_at: 99, pinned_at: 999 });
  });

  test('pinned first (most recently pinned first), then most recently updated, with the total', async () => {
    const { json } = await call('list_artifacts', {});
    assert.deepEqual(names(json), ['pinned-late', 'pinned-early', 'new', 'site', 'mid', 'old']);
    assert.equal(json.total, 6);
    assert.equal(json.count, 6);
    assert.equal(json.nextOffset, null);
    assert.equal('workspaceTotal' in json, false);
    assert.deepEqual(json.artifacts[0], {
      name: 'pinned-late', type: 'doc', filePath: '.contexts/pinned-late.md', kind: 'embedded', pinned: true,
      updatedAt: new Date(1).toISOString(),
    });
    assert.equal(json.artifacts.find((entry: any) => entry.name === 'site').url, 'https://example.com/spec');
    assert.equal('filePath' in json.artifacts.find((entry: any) => entry.name === 'site'), false);
  });

  test('pages with limit and offset; nextOffset is null on the last page', async () => {
    const first = (await call('list_artifacts', { limit: 4 })).json;
    assert.deepEqual(names(first), ['pinned-late', 'pinned-early', 'new', 'site']);
    assert.equal(first.nextOffset, 4);
    const second = (await call('list_artifacts', { limit: 4, offset: first.nextOffset })).json;
    assert.deepEqual(names(second), ['mid', 'old']);
    assert.equal(second.nextOffset, null);
    assert.equal(second.total, 6);
    assert.equal((await call('list_artifacts', { offset: 10 })).json.count, 0);
  });

  test('filters by type and pinned, and then also gives the workspace total', async () => {
    const images = (await call('list_artifacts', { type: 'image' })).json;
    assert.deepEqual(names(images), ['mid']);
    assert.equal(images.total, 1);
    assert.equal(images.workspaceTotal, 6);
    assert.deepEqual(names((await call('list_artifacts', { pinned: true })).json), ['pinned-late', 'pinned-early']);
    assert.deepEqual(names((await call('list_artifacts', { pinned: false, type: 'doc' })).json), ['new', 'old']);
  });

  test('rejects bad arguments', async () => {
    for (const args of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { offset: -1 }, { type: 'pdf' }, { pinned: 'yes' }]) {
      const { result, text } = await call('list_artifacts', args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(text, /^INVALID_ARGUMENT/);
    }
  });

  test("lists only the session's workspace, whatever the arguments say", async () => {
    const { json } = await call('list_artifacts', { workspaceId: 'ws-b', ownerUserId: 'bob' });
    assert.ok(!names(json).includes('bobs'));
    assert.equal(json.total, 6);
  });

  test("another owner's workspace, a session without a user or without a workspace reads nothing", async () => {
    assert.match((await call('list_artifacts', {}, { ownerUserId: 'alice', workspaceId: 'ws-b' })).text, /^NOT_FOUND/);
    assert.match((await call('list_artifacts', {}, { ownerUserId: null, workspaceId: 'ws-a' })).text, /^UNAVAILABLE/);
    assert.match((await call('list_artifacts', {}, { ownerUserId: 'alice', workspaceId: null })).text, /^SOURCE_UNAVAILABLE/);
  });

  test('on the desktop the session has no user and lists its workspace', async () => {
    delete process.env.MICHI_CLOUD;
    assert.equal((await call('list_artifacts', {}, { ownerUserId: null, workspaceId: 'ws-b' })).json.total, 1);
  });
});

describe('search_artifacts', () => {
  test('matches names, paths, links and document text; every keyword must appear', async () => {
    artifact('c-1', 'ws-a', 'pricing-plan', { updated_at: 3 });
    artifact('c-2', 'ws-a', 'roadmap', { updated_at: 2 });
    artifact('c-3', 'ws-a', 'site', { type: 'link', file_path: '', url: 'https://example.com/pricing', kind: null, updated_at: 1 });
    artifact('c-4', 'ws-a', 'shot', { type: 'image', file_path: 'assets/pricing.png', updated_at: 4 });
    doc(cwdA, 'pricing-plan', 'Plan tiers.');
    doc(cwdA, 'roadmap', `${'intro '.repeat(30)}Q3 ships the new Pricing page and the billing API.${' outro'.repeat(40)}`);

    const { json } = await call('search_artifacts', { query: 'pricing' });
    assert.deepEqual(names(json), ['pricing-plan', 'shot', 'site', 'roadmap']);
    assert.deepEqual(json.artifacts.map((entry: any) => entry.matchedIn), [['name', 'path'], ['path'], ['url'], ['body']]);
    const roadmap = json.artifacts[3];
    assert.match(roadmap.snippet, /^….*Q3 ships the new Pricing page.*…$/);
    assert.ok(roadmap.snippet.length < 200);
    assert.equal(json.total, 4);

    // Both keywords: the name has one, the body the other.
    assert.deepEqual(names((await call('search_artifacts', { query: 'ROADMAP billing' })).json), ['roadmap']);
    assert.deepEqual(names((await call('search_artifacts', { query: 'pricing nowhere' })).json), []);
    assert.match((await call('search_artifacts', { query: 'nowhere' })).json.next, /Try fewer or different keywords/);
    assert.equal((await call('search_artifacts', { query: 'pricing', limit: 2 })).json.count, 2);
  });

  test('reads only embedded documents inside .contexts/', async (t: TestContext) => {
    // A registered user file, a document outside .contexts/ and a symlink leading out of the folder.
    fs.writeFileSync(path.join(cwdA, 'notes.md'), 'secret keyword');
    fs.writeFileSync(path.join(root, 'outside.md'), 'secret keyword');
    fs.mkdirSync(path.join(cwdA, '.contexts'), { recursive: true });
    fs.symlinkSync(path.join(root, 'outside.md'), path.join(cwdA, '.contexts', 'linked.md'));
    artifact('c-ref', 'ws-a', 'ref', { file_path: path.join(cwdA, 'notes.md'), kind: 'reference' });
    artifact('c-loose', 'ws-a', 'loose', { file_path: 'notes.md' });
    artifact('c-link', 'ws-a', 'linked', { file_path: '.contexts/linked.md' });
    const read = t.mock.method(fs, 'readSync');
    assert.deepEqual(names((await call('search_artifacts', { query: 'secret' })).json), []);
    assert.equal(read.mock.callCount(), 0);
  });

  test('bounds the files and bytes it reads, and says what it skipped', async () => {
    for (let i = 0; i < SEARCH_MAX_FILES_READ + 5; i++) {
      const name = `doc-${String(i).padStart(3, '0')}`;
      artifact(`c-${i}`, 'ws-a', name, { updated_at: 1000 - i });
      doc(cwdA, name, 'needle');
    }
    artifact('c-big', 'ws-a', 'big', { updated_at: 5000 });
    doc(cwdA, 'big', `${'x'.repeat(SEARCH_MAX_BYTES_PER_FILE)} needle`);
    const { json } = await call('search_artifacts', { query: 'needle', limit: 50 });
    // The big document is read first (most recent) but only in part: its keyword lies past the limit.
    assert.equal(json.total, SEARCH_MAX_FILES_READ - 1);
    assert.ok(!names(json).includes('big'));
    assert.equal(json.count, 50);
    assert.deepEqual(
      { read: json.bodySearch.documentsRead, skipped: json.bodySearch.documentsSkipped, partial: json.bodySearch.documentsReadInPart },
      { read: SEARCH_MAX_FILES_READ, skipped: 6, partial: 1 },
    );
    assert.match(json.bodySearch.note, /bounded amount of document text/);
  });

  test("in cloud mode reads documents only from the workspace's sandbox, not its stored cwd or the session's folder", async () => {
    artifact('c-1', 'ws-a', 'notes');
    const stored = path.join(root, 'stored');
    const sessionFolder = path.join(root, 'session');
    doc(stored, 'notes', 'in the stored folder');
    doc(sessionFolder, 'notes', 'in the session folder');
    storeWorkspaceCwd('ws-a', stored);
    const caller = { ...alice, cwd: sessionFolder };
    assert.deepEqual(names((await call('search_artifacts', { query: 'folder' }, caller)).json), []);
    doc(cwdA, 'notes', 'in the sandbox folder');
    assert.equal((await call('search_artifacts', { query: 'folder' }, caller)).json.artifacts[0].snippet, 'in the sandbox folder');
  });

  test("a workspace cwd naming another user's sandbox reads none of its files", async (t: TestContext) => {
    // Bob's document, and Alice's artifact registered under the same path.
    doc(cwdB, 'plans', 'bob secret plans');
    artifact('c-bob', 'ws-b', 'plans');
    artifact('c-alice', 'ws-a', 'plans-copy', { file_path: '.contexts/plans.md' });
    // Alice's client stores Bob's sandbox as her workspace's cwd; her session claims it too.
    storeWorkspaceCwd('ws-a', cwdB);
    const read = t.mock.method(fs, 'readSync');
    for (const caller of [alice, { ...alice, cwd: cwdB }]) {
      const { json } = await call('search_artifacts', { query: 'secret' }, caller);
      assert.deepEqual(names(json), []);
      assert.equal(JSON.stringify(json).includes('bob secret'), false);
    }
    assert.equal(read.mock.callCount(), 0);
    // Bob still finds his own document.
    const bobs = await call('search_artifacts', { query: 'secret' }, { ownerUserId: 'bob', workspaceId: 'ws-b' });
    assert.equal(bobs.json.artifacts[0].snippet, 'bob secret plans');
  });

  test("on the desktop reads a document from the session's folder first, else from the workspace's", async () => {
    delete process.env.MICHI_CLOUD;
    artifact('c-1', 'ws-a', 'notes');
    doc(cwdA, 'notes', 'in the workspace folder');
    const elsewhere = path.join(root, 'session');
    fs.mkdirSync(elsewhere);
    const caller = { ...alice, cwd: elsewhere };
    assert.match((await call('search_artifacts', { query: 'workspace folder' }, caller)).json.artifacts[0].snippet, /in the workspace folder/);
    doc(elsewhere, 'notes', 'in the session folder');
    assert.deepEqual(names((await call('search_artifacts', { query: 'workspace folder' }, caller)).json), []);
    assert.equal((await call('search_artifacts', { query: 'session' }, caller)).json.artifacts[0].snippet, 'in the session folder');
    // A stored cwd is normalized as session cwds are: a symlink to the folder reads the same files.
    const link = path.join(root, 'workspace-link');
    fs.symlinkSync(cwdA, link);
    storeWorkspaceCwd('ws-a', `${link}/`);
    assert.match((await call('search_artifacts', { query: 'workspace folder' })).json.artifacts[0].snippet, /in the workspace folder/);
  });

  test('a .contexts folder that is a symlink out of the workspace is not read', async (t: TestContext) => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'notes.md'), 'secret keyword');
    fs.symlinkSync(outside, path.join(cwdA, '.contexts'));
    artifact('c-notes', 'ws-a', 'notes');
    artifact('c-up', 'ws-a', 'up', { file_path: '.contexts/../.contexts/notes.md' });
    const read = t.mock.method(fs, 'readSync');
    assert.deepEqual(names((await call('search_artifacts', { query: 'secret' })).json), []);
    delete process.env.MICHI_CLOUD;
    assert.deepEqual(names((await call('search_artifacts', { query: 'secret' })).json), []);
    assert.equal(read.mock.callCount(), 0);
  });

  test('a .contexts folder that is a symlink within the workspace is read on the desktop, not in cloud mode', async () => {
    fs.mkdirSync(path.join(cwdA, 'shared'));
    fs.symlinkSync(path.join(cwdA, 'shared'), path.join(cwdA, '.contexts'));
    doc(cwdA, 'notes', 'kept inside');
    artifact('c-notes', 'ws-a', 'notes');
    // The agent's shell could point it at another sandbox as easily.
    assert.deepEqual(names((await call('search_artifacts', { query: 'inside' })).json), []);
    delete process.env.MICHI_CLOUD;
    assert.equal((await call('search_artifacts', { query: 'inside' })).json.artifacts[0].snippet, 'kept inside');
  });

  test("a sandbox replaced by a symlink into another user's sandbox reads none of its files", async (t: TestContext) => {
    doc(cwdB, 'plans', 'bob secret plans');
    artifact('c-alice', 'ws-a', 'plans');
    // The sandbox itself becomes a symlink to Bob's: every path below resolves inside it.
    fs.rmSync(cwdA, { recursive: true });
    fs.symlinkSync(cwdB, cwdA);
    const read = t.mock.method(fs, 'readSync');
    assert.deepEqual(names((await call('search_artifacts', { query: 'secret' })).json), []);
    // So does Alice's whole sandbox root, to a folder laid out like hers.
    fs.rmSync(cwdA);
    const aliceRoot = path.dirname(cwdA);
    fs.rmSync(aliceRoot, { recursive: true });
    const lookalike = path.join(root, 'lookalike');
    doc(path.join(lookalike, 'ws-ws-a'), 'plans', 'lookalike secret');
    fs.symlinkSync(lookalike, aliceRoot);
    assert.deepEqual(names((await call('search_artifacts', { query: 'secret' })).json), []);
    assert.equal(read.mock.callCount(), 0);
  });

  test('in cloud mode a document with a second name (a hardlink) is not read', async (t: TestContext) => {
    doc(cwdB, 'plans', 'bob secret plans');
    artifact('c-alice', 'ws-a', 'stolen');
    fs.mkdirSync(path.join(cwdA, '.contexts'), { recursive: true });
    fs.linkSync(path.join(cwdB, '.contexts', 'plans.md'), path.join(cwdA, '.contexts', 'stolen.md'));
    const read = t.mock.method(fs, 'readSync');
    assert.deepEqual(names((await call('search_artifacts', { query: 'secret' })).json), []);
    assert.equal(read.mock.callCount(), 0);
    // The desktop has no other user's files to protect, and reads it as before.
    delete process.env.MICHI_CLOUD;
    assert.equal((await call('search_artifacts', { query: 'secret' })).json.artifacts[0].snippet, 'bob secret plans');
  });

  test('in cloud mode a document the kernel opened outside the sandbox is not read (Linux /proc)', async (t: TestContext) => {
    artifact('c-notes', 'ws-a', 'notes');
    doc(cwdA, 'notes', 'secret keyword');
    const errno = (code: string) => Object.assign(new Error(code), { code });
    const readlink = fs.readlinkSync;
    let kernelPath: () => string = () => { throw errno('ENOENT'); };
    t.mock.method(fs, 'readlinkSync', (file: fs.PathLike, ...rest: unknown[]) =>
      String(file).startsWith('/proc/self/fd/') ? kernelPath() : (readlink as (...args: unknown[]) => unknown)(file, ...rest));
    const search = async () => names((await call('search_artifacts', { query: 'secret' })).json);
    // Opened where it was checked: read.
    kernelPath = () => path.join(cwdA, '.contexts', 'notes.md');
    assert.deepEqual(await search(), ['notes']);
    // A directory on the way swapped for a symlink between the check and the open: the kernel opened Bob's.
    kernelPath = () => path.join(cwdB, '.contexts', 'notes.md');
    assert.deepEqual(await search(), []);
    // /proc there but unreadable: nothing is read.
    kernelPath = () => { throw errno('EACCES'); };
    assert.deepEqual(await search(), []);
    kernelPath = () => { throw errno('ENOENT'); };
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const on = async (value: NodeJS.Platform) => {
      Object.defineProperty(process, 'platform', { ...platform, value });
      try { return await search(); } finally { Object.defineProperty(process, 'platform', platform); }
    };
    // No /proc (macOS): the checks before it decide, as they did.
    assert.deepEqual(await on('darwin'), ['notes']);
    // On Linux a missing /proc refuses the file instead.
    assert.deepEqual(await on('linux'), []);
  });

  test("a sandbox swapped for a symlink after it was verified reads none of the other user's files", async (t: TestContext) => {
    doc(cwdB, 'plans', 'bob secret plans');
    doc(cwdB, 'more', 'bob secret more');
    artifact('c-plans', 'ws-a', 'plans');
    artifact('c-more', 'ws-a', 'more');
    // Verified at the start of the search, then swapped before the documents are resolved.
    const resolve = workspaceFiles.resolveWorkspaceRegularFile;
    let swapped = false;
    t.mock.method(workspaceFiles, 'resolveWorkspaceRegularFile', (relative: string, base: string) => {
      if (!swapped) {
        swapped = true;
        fs.renameSync(cwdA, `${cwdA}.real`);
        fs.symlinkSync(cwdB, cwdA);
      }
      return resolve(relative, base);
    });
    const read = t.mock.method(fs, 'readSync');
    assert.deepEqual(names((await call('search_artifacts', { query: 'secret' })).json), []);
    assert.equal(read.mock.callCount(), 0);
  });

  test('a document swapped after it was checked is not read', async (t: TestContext) => {
    artifact('c-notes', 'ws-a', 'notes');
    doc(cwdA, 'notes', 'checked text');
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, 'secret keyword');
    const file = path.join(cwdA, '.contexts', 'notes.md');
    const resolve = workspaceFiles.resolveWorkspaceRegularFile;
    let swap: () => void = () => {};
    t.mock.method(workspaceFiles, 'resolveWorkspaceRegularFile', (relative: string, base: string) => {
      const resolved = resolve(relative, base);
      swap();
      return resolved;
    });
    // The checked path becomes a symlink out: O_NOFOLLOW refuses to open it.
    swap = () => { fs.rmSync(file); fs.symlinkSync(outside, file); };
    assert.deepEqual(names((await call('search_artifacts', { query: 'secret' })).json), []);
    // The checked path becomes another file: its inode differs from the one checked.
    fs.rmSync(file);
    doc(cwdA, 'notes', 'checked text');
    swap = () => { fs.renameSync(outside, file); };
    assert.deepEqual(names((await call('search_artifacts', { query: 'secret' })).json), []);
    // Unswapped, the document reads.
    swap = () => {};
    assert.equal((await call('search_artifacts', { query: 'secret' })).json.artifacts[0].snippet, 'secret keyword');
  });

  test('rejects an empty or too long query', async () => {
    assert.match((await call('search_artifacts', { query: '  ' })).text, /^INVALID_ARGUMENT/);
    assert.match((await call('search_artifacts', { query: 'x'.repeat(201) })).text, /^INVALID_ARGUMENT/);
    assert.match((await call('search_artifacts', { query: 'x', limit: 51 })).text, /^INVALID_ARGUMENT/);
  });

  test("never searches another workspace's artifacts", async () => {
    artifact('c-bob', 'ws-b', 'bob-pricing');
    doc(cwdB, 'bob-pricing', 'pricing');
    assert.deepEqual(names((await call('search_artifacts', { query: 'pricing' })).json), []);
  });
});

describe('delete_artifact', () => {
  test('asks the user, naming the artifact, its type and file; approved, it removes the registration and keeps the file', async () => {
    artifact('c-notes', 'ws-a', 'notes', { pinned_at: 5 });
    doc(cwdA, 'notes', 'keep me');
    const deleted: DeletedArtifact[] = [];
    const { json } = await call('delete_artifact', { name: '@notes' }, alice, { approve, onDeleted: (d) => deleted.push(d) });
    assert.deepEqual(asked, [{
      toolName: 'delete_artifact',
      artifactName: 'notes',
      title: 'Delete artifact “@notes”?',
      lines: [
        'Type: Document (pinned)',
        'File: .contexts/notes.md',
        "Removes it from this workspace's Artifacts; it can no longer be @-mentioned. The file itself is not deleted.",
      ],
      approveLabel: 'Delete',
    }]);
    assert.equal(json.status, 'deleted');
    assert.equal(json.artifact.name, 'notes');
    assert.match(json.note, /Its file was not deleted/);
    // How it can come back: save_artifact with its path, or update_artifact for a document.
    assert.match(json.note, /save_artifact with the same name and its filePath as path/);
    assert.match(json.note, /update_artifact with the same name also registers it again/);
    assert.deepEqual(deleted, [{ contextId: 'c-notes', name: 'notes' }]);
    assert.deepEqual(listContexts('ws-a', 'alice'), []);
    assert.equal(fs.readFileSync(path.join(cwdA, '.contexts', 'notes.md'), 'utf8'), 'keep me');
  });

  test('declined or unanswered, nothing is deleted or reported, and the agent is told not to retry', async () => {
    artifact('c-notes', 'ws-a', 'notes');
    const deleted: DeletedArtifact[] = [];
    answer = { approved: false, reason: 'declined', note: 'keep it for now' };
    const declined = await call('delete_artifact', { name: 'notes' }, alice, { approve, onDeleted: (d) => deleted.push(d) });
    assert.deepEqual(declined.json, {
      status: 'not_deleted', reason: 'declined', artifact: 'notes', userNote: 'keep it for now',
      next: 'The user declined; @notes was not deleted. Do not retry unless the user asks.',
    });
    answer = { approved: false, reason: 'no_answer' };
    const unanswered = await call('delete_artifact', { name: 'notes' }, alice, { approve, onDeleted: (d) => deleted.push(d) });
    assert.equal(unanswered.json.reason, 'no_answer');
    assert.match(unanswered.json.next, /did not answer; @notes was not deleted/);
    assert.equal(asked.length, 2);
    assert.deepEqual(deleted, []);
    assert.deepEqual(listContexts('ws-a', 'alice').map((row) => row.id), ['c-notes']);
  });

  test('with no way to ask the user, nothing is deleted', async () => {
    artifact('c-notes', 'ws-a', 'notes');
    for (const hooks of [{}, { approve: askUserApprover<ArtifactApprovalRequest>(undefined, 'Artifacts') }]) {
      const { result, text } = await call('delete_artifact', { name: 'notes' }, alice, hooks);
      assert.equal(result.isError, true);
      assert.match(text, /^APPROVAL_UNAVAILABLE: .*@notes was not deleted/);
    }
    assert.equal(listContexts('ws-a', 'alice').length, 1);
  });

  test('an artifact removed or replaced while the user decided is not deleted', async () => {
    artifact('c-notes', 'ws-a', 'notes');
    const deleted: DeletedArtifact[] = [];
    // While the card is open, the drawer deletes it and a new artifact takes the name.
    const replacing = async (request: ArtifactApprovalRequest) => {
      asked.push(request);
      deleteContext('c-notes', 'alice');
      artifact('c-new', 'ws-a', 'notes');
      return { approved: true } as const;
    };
    const { result, text } = await call('delete_artifact', { name: 'notes' }, alice, { approve: replacing, onDeleted: (d) => deleted.push(d) });
    assert.equal(result.isError, true);
    assert.match(text, /^NOT_FOUND: @notes left this workspace's Artifacts while the user decided; nothing was deleted/);
    assert.deepEqual(deleted, []);
    assert.deepEqual(listContexts('ws-a', 'alice').map((row) => row.id), ['c-new']);
  });

  test('an artifact saved again under its name while the user decided keeps its id and is not deleted', async () => {
    artifact('c-notes', 'ws-a', 'notes');
    const deleted: DeletedArtifact[] = [];
    // While the card is open, save_artifact registers another file under the same name: same id, new file.
    const resaving = (filePath: string) => async (request: ArtifactApprovalRequest) => {
      asked.push(request);
      // A later millisecond than any earlier save, as a user's decision takes.
      await new Promise((resolve) => setTimeout(resolve, 5));
      upsertAgentContextMetadata({ workspaceId: 'ws-a', nodeId: 'n-1', name: 'notes', filePath, size: 9, userId: 'alice' });
      return { approved: true } as const;
    };
    const hooks = (filePath: string): ArtifactToolHooks => ({ approve: resaving(filePath), onDeleted: (d) => deleted.push(d) });
    const moved = await call('delete_artifact', { name: 'notes' }, alice, hooks('reports/other.md'));
    assert.match(asked[0].lines.join('\n'), /File: \.contexts\/notes\.md/);
    assert.equal(moved.result.isError, undefined);
    assert.equal(moved.json.status, 'not_deleted');
    assert.equal(moved.json.reason, 'changed');
    assert.match(moved.json.next, /no longer what the card showed; nothing was deleted\. .*call delete_artifact again/);
    // Rewritten in place (update_artifact): the same path, a later save.
    const rewritten = await call('delete_artifact', { name: 'notes' }, alice, hooks('reports/other.md'));
    assert.equal(rewritten.json.reason, 'changed');
    assert.deepEqual(deleted, []);
    assert.deepEqual(listContexts('ws-a', 'alice').map((row) => [row.id, row.file_path]), [['c-notes', 'reports/other.md']]);
    // Unchanged while the card is open, it is deleted.
    const unchanged = await call('delete_artifact', { name: 'notes' });
    assert.equal(unchanged.json.status, 'deleted');
    assert.deepEqual(listContexts('ws-a', 'alice'), []);
  });

  test('a deleted artifact stays deleted; save_artifact of its name registers a new one', async () => {
    artifact('c-notes', 'ws-a', 'notes');
    assert.equal((await call('delete_artifact', { name: 'notes' })).json.status, 'deleted');
    assert.equal(isContextTombstoned('c-notes'), true);
    // A window that still shows it writes its copy back: nothing comes back.
    artifact('c-notes', 'ws-a', 'notes', { pinned_at: 9 });
    assert.deepEqual(listContexts('ws-a', 'alice'), []);
    // save_artifact (and update_artifact) of the same name: a new id, not the deleted one.
    const id = upsertAgentContextMetadata({ workspaceId: 'ws-a', nodeId: 'n-1', name: 'notes', filePath: '.contexts/notes.md', size: 3, userId: 'alice' });
    assert.ok(id && id !== 'c-notes');
    assert.deepEqual(listContexts('ws-a', 'alice').map((row) => row.id), [id]);
  });

  test('a registered user file stays on disk', async () => {
    const file = path.join(root, 'report.pdf');
    fs.writeFileSync(file, 'pdf');
    artifact('c-report', 'ws-a', 'report', { file_path: file, kind: 'reference', type: 'file' });
    const { json } = await call('delete_artifact', { name: 'report' });
    assert.equal(asked[0].lines[0], 'Type: File');
    assert.equal(json.status, 'deleted');
    assert.equal(fs.existsSync(file), true);
    assert.doesNotMatch(json.note, /update_artifact/);
  });

  test('a deleted link says the user can add it again; save_artifact cannot', async () => {
    artifact('c-site', 'ws-a', 'site', { type: 'link', file_path: '', url: 'https://example.com', kind: null });
    const { json } = await call('delete_artifact', { name: 'site' });
    assert.deepEqual(asked[0].lines.slice(0, 2), ['Type: Link', 'Link: https://example.com']);
    assert.doesNotMatch(asked[0].lines[2], /file/);
    assert.equal(json.status, 'deleted');
    assert.match(json.note, /save_artifact cannot register a link/);
    assert.doesNotMatch(json.note, /Its file/);
  });

  test('an exact name wins; otherwise a name matching only ignoring case must be unique', async () => {
    artifact('c-1', 'ws-a', 'Spec');
    artifact('c-2', 'ws-a', 'spec');
    artifact('c-3', 'ws-a', 'Plan');
    artifact('c-4', 'ws-a', 'PLAN');
    assert.equal((await call('delete_artifact', { name: 'spec' })).json.artifact.name, 'spec');
    const ambiguous = await call('delete_artifact', { name: 'plan' });
    assert.equal(ambiguous.result.isError, true);
    assert.match(ambiguous.text, /^AMBIGUOUS: @plan matches 2 artifacts \(@Plan, @PLAN\)/);
    assert.equal((await call('delete_artifact', { name: 'SPEC' })).json.artifact.name, 'Spec');
    assert.deepEqual(listContexts('ws-a', 'alice').map((row) => row.name).sort(), ['PLAN', 'Plan']);
    // The ambiguous name was never put to the user.
    assert.deepEqual(asked.map((request) => request.artifactName), ['spec', 'Spec']);
  });

  test("an unknown name, or another workspace's artifact, is not found, asks nothing and deletes nothing", async () => {
    artifact('c-bob', 'ws-b', 'bobs');
    const reported: DeletedArtifact[] = [];
    for (const [args, caller] of [[{ name: 'missing' }, alice], [{ name: 'bobs' }, alice], [{ name: 'bobs', workspaceId: 'ws-b' }, alice]] as const) {
      const { result, text } = await call('delete_artifact', args, caller, { approve, onDeleted: (d) => reported.push(d) });
      assert.equal(result.isError, true);
      assert.match(text, /^NOT_FOUND/);
    }
    assert.match((await call('delete_artifact', { name: 'bobs' }, { ownerUserId: 'alice', workspaceId: 'ws-b' })).text, /^NOT_FOUND/);
    assert.match((await call('delete_artifact', {})).text, /^INVALID_ARGUMENT/);
    assert.deepEqual(asked, []);
    assert.deepEqual(reported, []);
    assert.equal(listContexts('ws-b', 'bob').length, 1);
  });
});

// ── Tool surfaces ────────────────────────────────────────────────────────────

async function mcpApp(t: TestContext) {
  const app = express();
  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));
  const router = express.Router();
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const registry = new McpSlotRegistry({ mcpPort: (server.address() as AddressInfo).port });
  mountMcp(router, registry);
  const connect = async (url: string) => {
    const client = new Client({ name: 'artifact-tools', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    t.after(() => client.close());
    return client;
  };
  return { registry, connect };
}

type AskUserQuestions = Array<{ question: string; header?: string; options: Array<{ label: string }>; multiSelect: boolean }>;

describe('Michi MCP server (Claude, Codex, Kiro, Crew)', () => {
  test("chat slots serve the three tools on the slot's workspace; a delete asks through ask_user and reaches the session's stream", async (t) => {
    artifact('c-notes', 'ws-a', 'notes', { pinned_at: 5 });
    artifact('c-bob', 'ws-b', 'bobs');
    doc(cwdA, 'notes', 'meeting notes');
    const { registry, connect } = await mcpApp(t);
    const reports: Array<{ type: string; payload?: unknown }> = [];
    const questions: AskUserQuestions[] = [];
    let choice = 'Cancel';
    // Like Codex, which approves every Michi MCP tool itself: no runtime prompt
    // comes before the call, so the tool's own card is the only one.
    const onAskUser = async (asking: AskUserQuestions) => { questions.push(asking); return { [asking[0].question]: choice }; };
    const slot = registry.create('chat-a', cwdA, 'alice', { sink: { emit: (event) => { reports.push(event); } }, onAskUser }, { workspaceId: 'ws-a' });
    t.after(() => registry.dispose(slot.slotId));
    const client = await connect(registry.endpoint(slot.slotId).url);
    const tools = (await client.listTools()).tools;
    for (const name of ARTIFACT_TOOL_NAMES) assert.ok(tools.some((tool) => tool.name === name), name);
    assert.equal(tools.find((tool) => tool.name === 'list_artifacts')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'search_artifacts')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'delete_artifact')?.annotations?.destructiveHint, true);

    const text = (result: any) => result.content[0].text as string;
    const listed: any = await client.callTool({ name: 'list_artifacts', arguments: {} });
    assert.deepEqual(JSON.parse(text(listed)).artifacts.map((entry: any) => entry.name), ['notes']);
    const found: any = await client.callTool({ name: 'search_artifacts', arguments: { query: 'meeting' } });
    assert.equal(JSON.parse(text(found)).artifacts[0].snippet, 'meeting notes');
    assert.equal(questions.length, 0);

    const refused: any = await client.callTool({ name: 'delete_artifact', arguments: { name: 'bobs' } });
    assert.equal(refused.isError, true);
    assert.equal(questions.length, 0);
    // Cancel on the card: the artifact stays.
    const kept: any = await client.callTool({ name: 'delete_artifact', arguments: { name: 'notes' } });
    assert.equal(JSON.parse(text(kept)).status, 'not_deleted');
    assert.deepEqual(questions[0], [{
      question: 'Delete artifact “@notes”?\nType: Document (pinned)\nFile: .contexts/notes.md\n'
        + "Removes it from this workspace's Artifacts; it can no longer be @-mentioned. The file itself is not deleted.",
      header: 'Artifacts',
      options: [{ label: 'Delete' }, { label: 'Cancel' }],
      multiSelect: false,
    }]);
    assert.deepEqual(reports, []);
    assert.equal(listContexts('ws-a', 'alice').length, 1);
    // Delete on the card.
    choice = 'Delete';
    const deleted: any = await client.callTool({ name: 'delete_artifact', arguments: { name: 'notes' } });
    assert.equal(JSON.parse(text(deleted)).status, 'deleted');
    assert.equal(questions.length, 2);
    assert.deepEqual(reports, [{ type: 'artifact_deleted', payload: { contextId: 'c-notes', name: 'notes' } }]);
    assert.equal(fs.existsSync(path.join(cwdA, '.contexts', 'notes.md')), true);

    // The report as the chat stream frame a window reads.
    const [report] = reports as Array<{ type: string; payload?: unknown }>;
    const wire = toChatStreamEvent({ kind: 'host_event', type: report.type, payload: report.payload });
    assert.ok(wire);
    assert.equal(encodeChatStreamEvent(wire), 'event: artifact_deleted\ndata: {"contextId":"c-notes","name":"notes"}\n\n');
  });

  test('a slot with no user channel deletes nothing', async (t) => {
    artifact('c-notes', 'ws-a', 'notes');
    const { registry, connect } = await mcpApp(t);
    const slot = registry.create('chat-a', cwdA, 'alice', {}, { workspaceId: 'ws-a' });
    t.after(() => registry.dispose(slot.slotId));
    const client = await connect(registry.endpoint(slot.slotId).url);
    const result: any = await client.callTool({ name: 'delete_artifact', arguments: { name: 'notes' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^APPROVAL_UNAVAILABLE/);
    assert.equal(listContexts('ws-a', 'alice').length, 1);
  });

  test('Agent Run slots never get them', async (t) => {
    const { registry, connect } = await mcpApp(t);
    const slot = registry.create('run-1', cwdA, 'alice', { owner: runOwner('run-1', 'attempt-1') }, { workspaceId: 'ws-a' });
    t.after(() => registry.dispose(slot.slotId));
    const client = await connect(registry.endpoint(slot.slotId).url);
    const names = client.getServerCapabilities()?.tools ? (await client.listTools()).tools.map((tool) => tool.name) : [];
    for (const name of ARTIFACT_TOOL_NAMES) assert.ok(!names.includes(name), name);
  });
});

describe('Pi built-in tools', () => {
  async function piTools(owner: unknown, extra: Record<string, unknown> = {}) {
    configureRuntimeDeps({
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null } as any,
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined } as any,
      dataDir: root,
    });
    const { Type } = await loadPiTypebox();
    try {
      return buildPiTools({
        bridge: {} as any, cwd: cwdA, parentChatId: 'p', workspaceId: 'ws-a', enableFollowUps: false,
        imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set<string>(), Type,
        ownerUserId: 'alice', owner, ...extra,
      } as any);
    } finally {
      configureDeps();
    }
  }

  /** Pi's question channel answering `answer` the way the user would on the card. */
  function answering(prompts: Array<{ questions: UserInputQuestion[]; signal?: AbortSignal }>) {
    return async (questions: UserInputQuestion[], signal?: AbortSignal): Promise<UserInputAnswer[] | null> => {
      prompts.push({ questions, signal });
      if (!answer.approved && answer.reason !== 'declined') return null;
      return [{ question: questions[0].question, answer: answer.approved ? 'Delete' : (answer.note ?? 'Cancel') }];
    };
  }

  test('chat threads get the three tools; a delete asks through ask_user and reports artifact_deleted', async () => {
    artifact('c-notes', 'ws-a', 'notes');
    doc(cwdA, 'notes', 'pi notes');
    const prompts: Array<{ questions: UserInputQuestion[]; signal?: AbortSignal }> = [];
    const tools = await piTools(chatOwner('n-a'), { requestUserInput: answering(prompts) });
    for (const name of ARTIFACT_TOOL_NAMES) assert.ok(tools.some((tool: any) => tool.name === name), name);
    const tool = (name: string) => tools.find((candidate: any) => candidate.name === name);
    assert.equal(tool('delete_artifact').executionMode, 'sequential');
    const found = await tool('search_artifacts').execute('call-1', { __tool_use_purpose: 'find', query: 'pi' });
    assert.deepEqual(JSON.parse(found.content[0].text).artifacts.map((entry: any) => entry.name), ['notes']);

    const missing = await tool('delete_artifact').execute('call-2', { name: 'nope' });
    assert.equal(missing.isError, true);
    const ctx = { cumulative: { inputTokens: 0, outputTokens: 0, totalCost: 0 }, runStartMs: 0 };
    const end = (result: unknown, isError = false) => [...mapAgentEvent({
      type: 'tool_execution_end', toolName: 'delete_artifact', toolCallId: 'call', isError, result,
    }, ctx)].filter((event) => event.kind === 'host_event');
    assert.deepEqual(end(missing, true), []);

    // Declined: kept, nothing reported.
    answer = { approved: false, reason: 'declined' };
    const declined = await tool('delete_artifact').execute('call-3', { name: 'notes' });
    assert.equal(JSON.parse(declined.content[0].text).status, 'not_deleted');
    assert.deepEqual(end(declined), []);
    assert.equal(listContexts('ws-a', 'alice').length, 1);

    answer = { approved: true };
    const signal = new AbortController().signal;
    const deleted = await tool('delete_artifact').execute('call-4', { __tool_use_purpose: 'clean up', name: 'notes' }, signal);
    assert.equal(JSON.parse(deleted.content[0].text).status, 'deleted');
    assert.deepEqual(prompts.map((prompt) => prompt.questions.map((question) => question.header)), [['Artifacts'], ['Artifacts']]);
    for (const prompt of prompts) assert.match(prompt.questions[0].question, /^Delete artifact “@notes”\?\n/);
    assert.deepEqual(prompts[1].questions[0].options.map((option) => option.label), ['Delete', 'Cancel']);
    assert.equal(prompts[1].signal, signal);
    assert.deepEqual(end(deleted), [{ kind: 'host_event', type: 'artifact_deleted', payload: { contextId: 'c-notes', name: 'notes' } }]);
    assert.deepEqual(listContexts('ws-a', 'alice'), []);
  });

  test('Trust and YOLO, even with a grant, still ask before a delete', async () => {
    for (const mode of ['trust', 'yolo'] as const) {
      artifact(`c-${mode}`, 'ws-a', `notes-${mode}`);
      const prompts: Array<{ questions: UserInputQuestion[]; signal?: AbortSignal }> = [];
      answer = { approved: false, reason: 'declined' };
      const tools = await piTools(chatOwner('n-a'), { requestUserInput: answering(prompts) });
      configureDeps(mode);
      const tool = tools.find((candidate: any) => candidate.name === 'delete_artifact');
      const result = await tool.execute('call', { name: `notes-${mode}` });
      assert.equal(JSON.parse(result.content[0].text).status, 'not_deleted', mode);
      assert.equal(prompts.length, 1, mode);
      assert.equal(listContexts('ws-a', 'alice').some((row) => row.id === `c-${mode}`), true, mode);
    }
  });

  test('without its question channel, a Pi delete deletes nothing', async () => {
    artifact('c-notes', 'ws-a', 'notes');
    const tools = await piTools(chatOwner('n-a'));
    const result = await tools.find((candidate: any) => candidate.name === 'delete_artifact').execute('call', { name: 'notes' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^APPROVAL_UNAVAILABLE/);
    assert.equal(listContexts('ws-a', 'alice').length, 1);
  });

  test('Agent Runs get none', async () => {
    const tools = await piTools(runOwner('run-1', 'attempt-1'));
    for (const name of ARTIFACT_TOOL_NAMES) assert.ok(!tools.some((tool: any) => tool.name === name), name);
  });
});

// ── Catalog, trust and permission entries ────────────────────────────────────

describe('catalog entries', () => {
  test('defined once, chat-only, trusted Michi tools; only list and search reach maintenance', () => {
    for (const name of ARTIFACT_TOOL_NAMES) {
      assert.equal(BUILTIN_TOOLS.filter((tool) => tool.name === name).length, 1, name);
      assert.ok(CHAT_ONLY_BUILTIN_TOOLS.has(name), name);
      assert.ok(MICHI_TOOL_NAMES.has(name), name);
      assert.equal(classifyToolTrust({ runtimeId: 'claude', toolName: name, mcpServer: '__michi_internal__', hostTool: true }), 'trusted');
      assert.ok(!MAIN_TOOL_NAMES.includes(name), `${name} not in the agent's catalog`);
      assert.ok(!CHECKIN_TOOL_NAMES.includes(name), `${name} not in a check-in's catalog`);
    }
    assert.equal(isMaintenanceInternalTool('list_artifacts'), true);
    assert.equal(isMaintenanceInternalTool('search_artifacts'), true);
    assert.equal(isMaintenanceInternalTool('delete_artifact'), false);
    const deleteDescription = BUILTIN_TOOLS.find((tool) => tool.name === 'delete_artifact')!.description;
    assert.match(deleteDescription, /never deleted/);
    assert.match(deleteDescription, /asks the user to confirm every deletion, in every permission mode/);
  });

  test("no runtime prompt for any of them under any runtime's name: delete asks through its own card instead", () => {
    configureRuntimeDeps({
      dataDir: root,
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined },
      chatPermissions: { getMode: (id) => (id === 'trusting' ? 'trust' : 'ask'), hasGrant: () => false, grant: () => {} },
    });
    try {
      const policy = (name: string, nativeRequest: boolean, hostTool = false, owner = chatOwner('n-a')) =>
        resolveChatPolicy(owner, null, name, nativeRequest, undefined, hostTool);
      for (const tool of ARTIFACT_TOOL_NAMES) {
        // Each runtime's name for Michi's own: Pi's built-in check, Claude's
        // (the prefix dropped, hostTool), the MCP prefix, Kiro's and Crew's @michi/.
        const own: Array<[string, string, boolean, boolean]> = [
          ['Pi', tool, false, false],
          ['Claude', tool, true, true],
          ['MCP', `mcp____michi_internal____${tool}`, true, false],
          ['Kiro', `@michi/${tool}`, true, false],
        ];
        for (const [runtime, name, nativeRequest, hostTool] of own) {
          assert.equal(policy(name, nativeRequest, hostTool), 'allow', `${runtime} ${name}`);
          assert.equal(policy(name, nativeRequest, hostTool, chatOwner('trusting')), 'allow', `Trust ${runtime} ${name}`);
        }
        // Another server's tool of the same name asks like any tool: bare in a
        // native request (nothing says it is Michi's), or under its own server.
        for (const name of [tool, `@github/${tool}`, `mcp__github__${tool}`, `mcp____michi_internal____x${tool}`]) {
          assert.equal(policy(name, true), 'ask', `foreign ${name}`);
        }
        assert.equal(policy(`mcp__github__${tool}`, false), 'ask', `Pi foreign mcp__github__${tool}`);
      }
      // Michi's other artifact writes are unchanged: they follow the chat's mode.
      assert.equal(resolveChatPolicy(chatOwner('n-a'), null, 'mcp____michi_internal____save_artifact', true), 'ask');
    } finally {
      __resetRuntimeDeps();
    }
    // Kiro names a Michi tool's permission request by its title: the policy sees the tool.
    for (const tool of ARTIFACT_TOOL_NAMES) {
      assert.equal(acpPermissionToolName({ title: `@michi/${tool}` }), `@michi/${tool}`, tool);
    }
  });
});
