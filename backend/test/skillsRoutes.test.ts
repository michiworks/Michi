/**
 * The Michi Skills REST API (routes/skills.ts) over HTTP: library writes,
 * the two catalogs and the runtime listings behind them, the gates, and a
 * message that runs a skill.
 */
import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { builtinSkillId, librarySkillId, readSkillFileInfo, runtimeSkillId } from 'michi-shared';
import type { AgentRuntime, AgentSession, ListRuntimeSkillsOptions, RuntimeSkill, RuntimeSkillListing } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { normalizeWorkspaceCwd } from '../src/agents/tools/pathSandbox';
import { __resetRuntimeManager, registerSession } from '../src/agents/sessionRegistry';
import { ChatManager } from '../src/services/chatManager';
import { closeDb, getDb, initDb } from '../src/services/db';
import { setupMichiRoutes } from '../src/routes/michi';
import { setupSkillRoutes } from '../src/routes/skills';
import { setSkillListingTimingForTests } from '../src/services/skills/catalog';
import { setBuiltinSkillsForTests } from '../src/services/skills/builtin';
import { COMPARE_SKILL } from '../src/services/skills/builtin/compare';
import { resetSkillMountsForTests } from '../src/services/skills/mounts';
import { skillLibraryRoot, skillMountsRoot, skillStatePath } from '../src/services/skills/paths';
import { readSkillsState, updateSkillsState } from '../src/services/skills/state';
import type { AgentCommand } from 'michi-shared';

let tmp: string;
let project: string;
let server: http.Server;
let port: number;
let listings: Array<{ runtimeId: string } & ListRuntimeSkillsOptions>;

const skillFile = (name: string, extra = '') => `---\nname: ${name}\ndescription: About ${name}\n${extra}---\n\nDo ${name} for $ARGUMENTS.\n`;

function librarySkill(name: string, extra = ''): string {
  const dir = path.join(skillLibraryRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillFile(name, extra));
  return dir;
}

/** A SKILL.md in a runtime's own folder, outside the library. */
function runtimeSkillFile(home: string, name: string): string {
  const file = path.join(tmp, home, name, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, skillFile(name));
  return file;
}

function fakeRuntime(id: string, options: {
  skills?: RuntimeSkill[];
  list?: (opts: ListRuntimeSkillsOptions) => Promise<RuntimeSkillListing>;
  available?: boolean;
  commands?: AgentCommand[];
} = {}): void {
  registerRuntime({
    id, label: `${id[0].toUpperCase()}${id.slice(1)}`, capabilities: {},
    checkAvailability: () => ({ available: options.available !== false }),
    listSkills: async (opts: ListRuntimeSkillsOptions) => {
      listings.push({ runtimeId: id, ...opts });
      return options.list ? options.list(opts) : { skills: options.skills ?? [] };
    },
    ...(options.commands ? { hostCommands: () => options.commands } : {}),
    warm: async () => {},
    newSession: async () => { throw new Error('not used'); },
    releaseSession: () => {},
  } as unknown as AgentRuntime);
}

interface Reply { status: number; body: any }

async function api(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** fetch() cannot send another Host header; the local-only guard reads it. */
function rawRequest(method: string, route: string, headers: Record<string, string>, body: unknown): Promise<Reply> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, method, path: `/api${route}`,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-skills-routes-'));
  fs.mkdirSync(path.join(tmp, 'project'));
  project = fs.realpathSync(path.join(tmp, 'project'));
  process.env.MICHI_DATA_DIR = path.join(tmp, 'data');
  delete process.env.MICHI_CLOUD;
  delete process.env.MICHI_REQUIRE_AUTH;
  closeDb();
  initDb();
  fs.rmSync(skillLibraryRoot(), { recursive: true, force: true });
  fs.rmSync(skillStatePath(), { force: true });
  resetSkillMountsForTests();
  // Built-in skills have their own tests (skillsBuiltin.test.ts).
  setBuiltinSkillsForTests([]);
  listings = [];
  const db = getDb();
  db.prepare('INSERT INTO workspaces (id,name,owner_user_id,cwd,created_at,updated_at) VALUES (?,?,NULL,?,1,1)').run('ws-a', 'A', project);
  db.prepare('INSERT INTO workspaces (id,name,owner_user_id,cwd,created_at,updated_at) VALUES (?,?,NULL,NULL,1,1)').run('ws-bare', 'Bare');
  for (const [node, workspace] of [['n-a', 'ws-a'], ['n-b', 'ws-a'], ['n-bare', 'ws-bare']]) {
    db.prepare("INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at) VALUES (?,?,'chat','idle',0,0,1)").run(node, workspace);
  }
  const app = express();
  app.use(express.json());
  // What server.ts's /api stack decides before these routes: a verified remote token, a cloud session's user.
  app.use((req, res, next) => {
    if (req.headers['x-test-remote'] === '1') res.locals.remoteAccessAuthenticated = true;
    if (typeof req.headers['x-test-user'] === 'string') (req as unknown as { user: { id: string } }).user = { id: req.headers['x-test-user'] };
    next();
  });
  app.use('/api', setupSkillRoutes());
  app.use('/api', setupMichiRoutes(new ChatManager(undefined, project)));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  __resetRuntimeManager();
  setSkillListingTimingForTests();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  delete process.env.MICHI_CLOUD;
  delete process.env.MICHI_REQUIRE_AUTH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('library writes', () => {
  test('create, edit, turn off, rename and delete a library skill; its setting moves with it', async () => {
    // A folder deleted by hand left its name off; a new skill of that name is on.
    updateSkillsState((state) => ({ ...state, library: { alpha: { enabled: false } } }));
    const created = await api('POST', '/skills/library', { name: 'alpha', content: skillFile('alpha') });
    assert.equal(created.status, 201);
    assert.deepEqual([created.body.skill.id, created.body.skill.enabled], ['library:alpha', true]);
    assert.equal(fs.readFileSync(path.join(skillLibraryRoot(), 'alpha', 'SKILL.md'), 'utf8'), skillFile('alpha'));
    assert.equal((await api('POST', '/skills/library', { name: 'alpha', content: skillFile('alpha') })).body.code, 'name_taken');
    const mismatch = await api('POST', '/skills/library', { name: 'alpha-two', content: skillFile('alpha') });
    assert.deepEqual([mismatch.status, mismatch.body.code], [400, 'invalid_skill']);
    assert.match(mismatch.body.problems.join(' '), /must match the skill folder "alpha-two"/);
    assert.equal((await api('POST', '/skills/library', { name: 'Bad Name', content: skillFile('Bad Name') })).body.code, 'invalid_skill');

    const edited = await api('PUT', '/skills/library/alpha', { content: skillFile('alpha').replace('About alpha', 'Changed') });
    assert.equal(edited.body.skill.description, 'Changed');

    // So did one for beta: a skill renamed onto it keeps its own setting.
    updateSkillsState((state) => ({ ...state, library: { beta: { enabled: false } } }));
    const renamed = await api('PUT', '/skills/library/alpha', { newName: 'beta' });
    assert.equal(renamed.status, 200);
    assert.deepEqual([renamed.body.skill.id, renamed.body.skill.enabled], ['library:beta', true]);
    assert.equal(fs.existsSync(path.join(skillLibraryRoot(), 'alpha')), false);
    assert.match(fs.readFileSync(path.join(skillLibraryRoot(), 'beta', 'SKILL.md'), 'utf8'), /^---\nname: beta\ndescription: Changed\n/);
    assert.deepEqual(readSkillsState(), { version: 1, library: {}, builtin: {} });
    assert.equal((await api('PUT', '/skills/library/alpha', { enabled: true })).status, 404);
    assert.equal((await api('PUT', '/skills/library/beta', { runtimes: null })).body.code, 'invalid_argument');

    assert.equal((await api('PUT', '/skills/library/beta', { enabled: false })).body.skill.enabled, false);
    const moved = await api('PUT', '/skills/library/beta', { newName: 'gamma' });
    assert.deepEqual([moved.body.skill.id, moved.body.skill.enabled], ['library:gamma', false]);
    assert.deepEqual(readSkillsState(), { version: 1, library: { gamma: { enabled: false } }, builtin: {} });

    assert.equal((await api('DELETE', '/skills/library/gamma')).status, 204);
    assert.equal(fs.existsSync(path.join(skillLibraryRoot(), 'gamma')), false);
    assert.deepEqual(readSkillsState(), { version: 1, library: {}, builtin: {} });
    assert.equal((await api('DELETE', '/skills/library/gamma')).status, 404);
  });

  test('a SKILL.md edit needs no settings, so it saves while skills-state.json is locked or unreadable', async (t) => {
    const file = path.join(librarySkill('alpha'), 'SKILL.md');
    updateSkillsState((state) => ({ ...state, library: { alpha: { enabled: false } } }));
    const settings = fs.readFileSync(skillStatePath(), 'utf8');
    const edit = (description: string, extra: Record<string, unknown> = {}) =>
      api('PUT', '/skills/library/alpha', { content: skillFile('alpha').replace('About alpha', description), ...extra });

    // A writer that died holding the lock: state writes fail closed until someone removes it.
    const lock = `${skillStatePath()}.lock`;
    fs.writeFileSync(lock, '');
    t.after(() => fs.rmSync(lock, { force: true }));
    const saved = await edit('Edited');
    assert.deepEqual([saved.status, saved.body.skill?.description, saved.body.skill?.enabled], [200, 'Edited', false]);
    assert.match(fs.readFileSync(file, 'utf8'), /description: Edited/);
    const toggled = await edit('Toggled', { enabled: true });
    assert.deepEqual([toggled.status, toggled.body.code], [500, 'CONFIG_LOCKED']);
    assert.match(fs.readFileSync(file, 'utf8'), /description: Edited/, 'a change that needs the settings is refused whole');
    assert.equal(fs.readFileSync(skillStatePath(), 'utf8'), settings);
    fs.rmSync(lock);

    fs.writeFileSync(skillStatePath(), '{not json');
    const unreadable = await edit('Again');
    assert.deepEqual([unreadable.status, unreadable.body.skill?.description], [200, 'Again']);
    assert.equal(fs.readFileSync(skillStatePath(), 'utf8'), '{not json');
  });

  test('an edit writes a linked SKILL.md where it points and keeps its mode', { skip: process.platform === 'win32' }, async () => {
    const dir = librarySkill('alpha');
    const elsewhere = path.join(tmp, 'elsewhere-skill.md');
    fs.renameSync(path.join(dir, 'SKILL.md'), elsewhere);
    fs.chmodSync(elsewhere, 0o640);
    fs.symlinkSync(elsewhere, path.join(dir, 'SKILL.md'));
    const saved = await api('PUT', '/skills/library/alpha', { content: skillFile('alpha').replace('About alpha', 'Linked edit') });
    assert.equal(saved.status, 200);
    assert.equal(fs.lstatSync(path.join(dir, 'SKILL.md')).isSymbolicLink(), true);
    assert.match(fs.readFileSync(elsewhere, 'utf8'), /description: Linked edit/);
    assert.equal(fs.statSync(elsewhere).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(path.dirname(elsewhere)).filter((name) => name.endsWith('.tmp')), []);
  });

  test('a linked skill folder names its target, and deleting it removes the link, never the folder it points to', async () => {
    const elsewhere = path.join(tmp, 'elsewhere', 'linked');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), skillFile('linked'));
    fs.mkdirSync(skillLibraryRoot(), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(skillLibraryRoot(), 'linked'), 'dir');
    const listed = (await api('GET', '/skills')).body;
    assert.deepEqual(listed.skills.map((skill: { id: string; linkTarget?: string }) => [skill.id, skill.linkTarget]), [['library:linked', fs.realpathSync(elsewhere)]]);
    assert.equal(listed.libraryPath, skillLibraryRoot());
    assert.equal((await api('DELETE', '/skills/library/linked')).status, 204);
    assert.equal(fs.existsSync(path.join(skillLibraryRoot(), 'linked')), false);
    assert.equal(fs.readFileSync(path.join(elsewhere, 'SKILL.md'), 'utf8'), skillFile('linked'));
  });
});

describe('catalogs', () => {
  test('list the library and every available runtime for the workspace folder, name every runtime, and tell a failed listing from a partial one', async () => {
    setSkillListingTimingForTests({ timeoutMs: 200 });
    librarySkill('alpha');
    fakeRuntime('claude', { list: async () => ({ skills: [{ name: 'tool', description: 'About tool', scope: 'user' }], errors: ['big/SKILL.md: too large'] }) });
    fakeRuntime('codex', { list: async () => { throw new Error('app-server exited'); } });
    fakeRuntime('kiro', { list: () => new Promise(() => {}) });
    fakeRuntime('pi', { available: false });
    const page = await api('GET', '/skills?workspaceId=ws-a');
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.skills.map((skill: { id: string }) => skill.id), ['library:alpha', runtimeSkillId('claude', 'user', 'tool')]);
    assert.deepEqual(page.body.runtimes, [
      { id: 'claude', label: 'Claude', available: true }, { id: 'codex', label: 'Codex', available: true },
      { id: 'kiro', label: 'Kiro', available: true }, { id: 'pi', label: 'Pi', available: false },
    ]);
    assert.deepEqual(page.body.errors.map(({ runtimeId, failed }: { runtimeId: string; failed?: boolean }) => [runtimeId, failed ?? false]),
      [['claude', false], ['codex', true], ['kiro', true]], 'a listing still running after timeoutMs has failed; one SKILL.md problem is a note');
    assert.deepEqual(page.body.errors.slice(0, 2).map((error: { message: string }) => error.message), ['big/SKILL.md: too large', 'app-server exited']);
    assert.match(page.body.errors[2].message, /took longer than/);
    assert.equal(page.body.pending, undefined);
    assert.deepEqual(listings.map((call) => [call.runtimeId, call.cwd]), [['claude', project], ['codex', project], ['kiro', project]],
      'the folder comes from the workspace row; a runtime that is not installed is not asked');
    assert.equal(page.body.commands, undefined);
    await api('GET', '/skills?workspaceId=ws-a&refresh=1');
    assert.deepEqual(listings.slice(3).map((call) => [call.runtimeId, call.refresh]), [['claude', true], ['codex', true], ['kiro', true]]);
  });

  test('a runtime that has not answered yet holds back neither the library nor the commands: it is pending, and its late answer comes with the next request', async () => {
    setSkillListingTimingForTests({ catalogWaitMs: 200 });
    librarySkill('alpha');
    let answer: (listing: RuntimeSkillListing) => void = () => {};
    let fail: (error: Error) => void = () => {};
    fakeRuntime('claude', {
      list: () => new Promise((resolve, reject) => { answer = resolve; fail = reject; }),
      commands: [{ name: 'status', description: 'Show the session', kind: 'command' }],
    });
    const started = Date.now();
    const menu = (await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-a')).body;
    assert.ok(Date.now() - started < 1_000);
    assert.deepEqual([menu.skills.map((skill: { id: string }) => skill.id), menu.errors, menu.pending, menu.commands.map((command: AgentCommand) => command.name)],
      [['library:alpha'], [], ['claude'], ['status']]);
    assert.deepEqual((await api('GET', '/skills?workspaceId=ws-a')).body.pending, ['claude']);
    assert.equal(listings.length, 1, 'both catalogs wait on the one listing in flight');

    answer({ skills: [{ name: 'tool', description: 'About tool', scope: 'user' }] });
    const next = (await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-a')).body;
    assert.deepEqual([next.skills.map((skill: { id: string }) => skill.id), next.pending], [['library:alpha', runtimeSkillId('claude', 'user', 'tool')], undefined]);
    assert.equal(listings.length, 1);

    // ↻ on the Skills page asks again; until that answers, its old listing is not shown as current.
    const refreshed = (await api('GET', '/skills?workspaceId=ws-a&refresh=1')).body;
    assert.deepEqual([refreshed.skills.map((skill: { id: string }) => skill.id), refreshed.pending], [['library:alpha'], ['claude']]);
    answer({ skills: [{ name: 'renamed', description: 'About it', scope: 'user' }] });
    assert.deepEqual((await api('GET', '/skills?workspaceId=ws-a')).body.skills.map((skill: { id: string }) => skill.id),
      ['library:alpha', runtimeSkillId('claude', 'user', 'renamed')]);

    // A refresh that fails keeps the listing it would have replaced, with a note instead of a failure.
    const failing = api('GET', '/skills?workspaceId=ws-a&refresh=1');
    while (listings.length < 3) await new Promise((resolve) => setTimeout(resolve, 1));
    fail(new Error('not signed in'));
    const kept = (await failing).body;
    assert.deepEqual([kept.skills.length, kept.errors], [2, [{ runtimeId: 'claude', message: 'not signed in; these are the skills it listed before', stale: true }]]);
  });

  /** A runtime whose listings answer when the test says. */
  function heldRuntime(id: string) {
    const calls: Array<{ answer: (listing: RuntimeSkillListing) => void; fail: (error: Error) => void }> = [];
    fakeRuntime(id, { list: () => new Promise((answer, fail) => { calls.push({ answer, fail }); }) });
    return calls;
  }
  const ids = (body: { skills: Array<{ id: string }> }) => body.skills.map((skill) => skill.id);

  test('a listing that fails after the catalogs\' wait is their answer, as failed, until one answers; the next one still runs', async () => {
    setSkillListingTimingForTests({ catalogWaitMs: 100 });
    librarySkill('alpha');
    const calls = heldRuntime('claude');
    assert.deepEqual((await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-a')).body.pending, ['claude']);
    calls[0].fail(new Error('not signed in'));

    const failed = [{ runtimeId: 'claude', message: 'not signed in', failed: true }];
    const menu = (await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-a')).body;
    const page = (await api('GET', '/skills?workspaceId=ws-a')).body;
    assert.deepEqual([ids(menu), menu.errors, menu.pending, ids(page), page.errors, page.pending],
      [['library:alpha'], failed, undefined, ['library:alpha'], failed, undefined]);
    assert.equal(calls.length, 2, 'the menu asked again; the page waited on that listing');
    calls[1].answer({ skills: [{ name: 'tool', description: 'About tool', scope: 'user' }] });
    const next = (await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-a')).body;
    assert.deepEqual([ids(next), next.errors], [['library:alpha', runtimeSkillId('claude', 'user', 'tool')], []]);
  });

  test('while a ↻ runs only the Skills page waits for it; the / menu and a skill\'s detail keep the listing it replaces', async () => {
    setSkillListingTimingForTests({ catalogWaitMs: 100 });
    const skillMd = runtimeSkillFile('claude-home', 'tool');
    const tool = runtimeSkillId('claude', 'user', 'tool');
    const calls = heldRuntime('claude');
    const first = api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-a');
    while (calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
    calls[0].answer({ skills: [{ name: 'tool', description: 'About tool', scope: 'user', path: skillMd }] });
    await first;
    assert.deepEqual((await api('GET', '/skills?workspaceId=ws-a&refresh=1')).body.pending, ['claude']);

    const started = Date.now();
    const menu = (await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-a')).body;
    const detail = await api('GET', `/skills/detail?id=${encodeURIComponent(tool)}&workspaceId=ws-a`);
    assert.ok(Date.now() - started < 1_000, 'neither waits for the ↻');
    assert.deepEqual([ids(menu), menu.pending, detail.status], [[tool], undefined, 200]);
    assert.deepEqual((await api('GET', '/skills?workspaceId=ws-a')).body.pending, ['claude']);

    // The ↻ fails after the page's wait: the page hears of it beside the listing it keeps.
    calls[1].fail(new Error('not signed in'));
    const page = (await api('GET', '/skills?workspaceId=ws-a')).body;
    assert.deepEqual([ids(page), page.errors], [[tool], [{ runtimeId: 'claude', message: 'not signed in; these are the skills it listed before', stale: true }]]);
    assert.deepEqual((await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-a')).body.errors, []);
    assert.equal(calls.length, 2);
  });

  test('a detail whose runtime cannot list its skills answers 503 runtime_unavailable with the reason', async () => {
    fakeRuntime('codex', { list: async () => { throw new Error('app-server exited unexpectedly'); } });
    const detail = await api('GET', `/skills/detail?id=${encodeURIComponent(runtimeSkillId('codex', 'repo', 'tool'))}&workspaceId=ws-a`);
    assert.deepEqual([detail.status, detail.body], [503, { error: 'Codex couldn’t list its skills: app-server exited unexpectedly', code: 'runtime_unavailable' }]);
  });

  test('the / menu gets the runnable library skills, every skill of one runtime with its flags, its name and the commands it runs', async () => {
    for (const name of ['alpha', 'gamma']) librarySkill(name);
    librarySkill('delta', 'user-invocable: false\n');
    updateSkillsState((state) => ({ ...state, library: { gamma: { enabled: false } } }));
    fakeRuntime('claude', {
      skills: [
        { name: 'tool', description: 'Runs', scope: 'user', argumentHint: '[file]' },
        { name: 'off-tool', description: 'Off', scope: 'user', enabled: false },
        { name: 'model-tool', description: 'Model only', scope: 'user', userInvocable: false },
        // A listing with Michi's Claude mount in it: the library's alpha, already listed as such.
        { name: 'alpha', description: 'Mounted', scope: 'project', path: path.join(skillMountsRoot(), 'claude', 'michi', '.claude', 'skills', 'alpha', 'SKILL.md') },
      ],
      commands: [{ name: 'status', description: 'Show the session', kind: 'command' }, { name: 'wrong', kind: 'skill' }],
    });
    fakeRuntime('codex', { skills: [{ name: 'other', description: 'Codex only', scope: 'repo' }] });

    const menu = await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-a');
    assert.equal(menu.status, 200);
    assert.deepEqual(menu.body.skills.map((skill: { id: string; userInvocable: boolean; enabled: boolean }) => [skill.id, skill.userInvocable, skill.enabled]), [
      ['library:alpha', true, true],
      // The menu offers only the first; it knows the others when a live session lists them.
      [runtimeSkillId('claude', 'user', 'tool'), true, true],
      [runtimeSkillId('claude', 'user', 'off-tool'), true, false],
      [runtimeSkillId('claude', 'user', 'model-tool'), false, true],
    ]);
    assert.equal(menu.body.skills[1].argumentHint, '[file]');
    assert.deepEqual(menu.body.runtimes, [{ id: 'claude', label: 'Claude', available: true }]);
    assert.deepEqual(menu.body.commands, [{ name: 'status', description: 'Show the session', kind: 'command' }], 'a runtime\'s commands are never skills');
    assert.deepEqual(listings.map((call) => call.runtimeId), ['claude']);
    assert.deepEqual((await api('GET', '/skills/catalog?runtimeId=codex&workspaceId=ws-a')).body.commands, []);

    const page = (await api('GET', '/skills?workspaceId=ws-a')).body.skills as Array<{ id: string; enabled: boolean }>;
    assert.equal(page.find((skill) => skill.id === 'library:gamma')?.enabled, false, 'the page lists skills that are off');
    assert.equal(page.some((skill) => skill.id === runtimeSkillId('claude', 'project', 'alpha')), false);
  });

  test('a workspace without a folder lists the folder its chats run in; no workspace lists the library only; unknown ones are not found', async () => {
    librarySkill('alpha');
    fakeRuntime('claude', { skills: [{ name: 'tool', description: 'About tool', scope: 'user' }] });
    assert.deepEqual((await api('GET', '/skills')).body.skills.map((skill: { id: string }) => skill.id), ['library:alpha']);
    assert.equal(listings.length, 0);
    // ensure-session opens such a workspace's chats in the backend's own folder.
    assert.deepEqual((await api('GET', '/skills?workspaceId=ws-bare')).body.skills.map((skill: { id: string }) => skill.id),
      ['library:alpha', runtimeSkillId('claude', 'user', 'tool')]);
    assert.deepEqual(listings.map((call) => call.cwd), [normalizeWorkspaceCwd(process.cwd())]);
    for (const route of ['/skills?workspaceId=ws-gone', '/skills/catalog?runtimeId=claude&workspaceId=ws-gone', '/skills/catalog?runtimeId=nope&workspaceId=ws-a']) {
      const missing = await api('GET', route);
      assert.deepEqual([missing.status, missing.body.code], [404, 'not_found'], route);
    }
  });

  test('a detail reads files the backend resolved, never a path from the request', async () => {
    const dir = librarySkill('alpha');
    fs.mkdirSync(path.join(dir, 'refs'));
    fs.writeFileSync(path.join(dir, 'refs', 'guide.md'), 'Guide');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(dir, 'outside.txt'));
    const library = await api('GET', `/skills/detail?id=${encodeURIComponent('library:alpha')}`);
    assert.deepEqual([library.body.skill.content, library.body.skill.files], [skillFile('alpha'), ['refs/guide.md']]);

    const skillMd = runtimeSkillFile('claude-home', 'tool');
    fs.writeFileSync(path.join(path.dirname(skillMd), 'notes.md'), 'Notes');
    fakeRuntime('claude', { skills: [{ name: 'tool', description: 'About tool', scope: 'user', path: skillMd }] });
    const listed = await api('GET', `/skills/detail?id=${encodeURIComponent(runtimeSkillId('claude', 'user', 'tool'))}&workspaceId=ws-a`);
    assert.deepEqual([listed.body.skill.content, listed.body.skill.files, listed.body.skill.path], [skillFile('tool'), ['notes.md'], skillMd]);

    for (const [id, status] of [
      ['library:../secret', 400], [path.join(tmp, 'secret.txt'), 400], [runtimeSkillId('claude', 'user', '../../secret.txt'), 404], ['library:gone', 404],
    ] as const) {
      const refused = await api('GET', `/skills/detail?id=${encodeURIComponent(id)}&workspaceId=ws-a`);
      assert.equal(refused.status, status, id);
      assert.equal(JSON.stringify(refused.body).includes('"content"'), false, id);
    }
  });
});

describe('gates', () => {
  test('cloud mode answers skills_unavailable on every route but the / menu, which names the runtime and its commands only', async () => {
    fakeRuntime('claude', { skills: [{ name: 'tool', description: 'A host skill', scope: 'user' }], commands: [{ name: 'status', kind: 'command' }] });
    getDb().prepare('INSERT INTO workspaces (id,name,owner_user_id,cwd,created_at,updated_at) VALUES (?,?,?,?,1,1)').run('ws-cloud', 'Cloud', 'user-1', project);
    process.env.MICHI_CLOUD = '1';
    const menu = await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-cloud', undefined, { 'x-test-user': 'user-1' });
    assert.deepEqual([menu.status, menu.body], [200, {
      skills: [], errors: [], libraryAvailable: false, runtimes: [{ id: 'claude', label: 'Claude', available: true }], commands: [{ name: 'status', kind: 'command' }],
    }]);
    assert.equal(listings.length, 0, 'the host\'s skills are never listed');
    assert.equal((await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-a', undefined, { 'x-test-user': 'user-1' })).body.code, 'not_found');
    for (const [method, route, body] of [
      ['GET', '/skills', undefined],
      ['GET', '/skills/detail?id=library%3Aalpha', undefined],
      ['POST', '/skills/library', { name: 'alpha', content: skillFile('alpha') }],
      ['PUT', '/skills/library/alpha', { enabled: false }],
      ['DELETE', '/skills/library/alpha', undefined],
    ] as const) {
      const reply = await api(method, route, body, { 'x-test-user': 'user-1' });
      assert.deepEqual([reply.status, reply.body?.code], [404, 'skills_unavailable'], `${method} ${route}`);
    }
    assert.equal(fs.existsSync(skillLibraryRoot()), false);
  });

  test('library writes come only from this machine\'s app or its authenticated remote owner', async () => {
    const create = (name: string) => ({ name, content: skillFile(name) });
    assert.equal((await rawRequest('POST', '/skills/library', { host: 'evil.example' }, create('alpha'))).status, 403);
    assert.equal((await rawRequest('POST', '/skills/library', { origin: 'https://evil.example' }, create('alpha'))).status, 403);
    assert.equal((await rawRequest('DELETE', '/skills/library/alpha', { host: 'evil.example' }, {})).status, 403);
    assert.equal(fs.existsSync(path.join(skillLibraryRoot(), 'alpha')), false);
    assert.equal((await rawRequest('POST', '/skills/library', { host: 'evil.example', 'x-test-remote': '1' }, create('alpha'))).status, 201);
    assert.equal((await rawRequest('POST', '/skills/library', {}, create('beta'))).status, 201);
  });

  test('every route needs request access where the backend requires authentication', async () => {
    process.env.MICHI_REQUIRE_AUTH = 'true';
    assert.equal((await api('GET', '/skills')).status, 401);
    assert.equal((await api('POST', '/skills/library', { name: 'alpha', content: skillFile('alpha') })).status, 401);
  });
});

describe('POST /chats/:chatId/message with a skill', () => {
  let sent: Array<{ text: string; skill?: unknown }>;

  function liveSession(id: string): AgentSession {
    return {
      id, runtimeId: 'claude', runtimeProfileHash: null, currentModelId: null,
      getHistory: () => [], getPendingAssistant: () => undefined,
      async *send(text: string, opts?: { skill?: unknown }) {
        sent.push({ text, skill: opts?.skill });
        yield { kind: 'turn_end', stopReason: 'end_turn' };
      },
      async cancel() {},
    } as unknown as AgentSession;
  }

  async function post(nodeId: string, body: unknown): Promise<{ status: number; text: string }> {
    const response = await fetch(`http://127.0.0.1:${port}/api/chats/${nodeId}/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  }

  const storedSkills = (nodeId: string) => (getDb().prepare("SELECT metadata FROM messages WHERE node_id = ? AND role = 'user'").all(nodeId) as Array<{ metadata: string | null }>)
    .map((row) => JSON.parse(row.metadata ?? '{}').skill);

  beforeEach(() => { sent = []; });

  test('the runtime gets the skill the backend resolved, and the user message records it, not the client\'s', async () => {
    librarySkill('alpha');
    const skillMd = runtimeSkillFile('claude-home', 'tool');
    fakeRuntime('claude', { skills: [{ name: 'tool', description: 'About tool', scope: 'user', path: skillMd }] });
    registerSession(liveSession('n-a'), null);
    registerSession(liveSession('n-b'), null);

    const library = await post('n-a', {
      text: 'go', displayText: '/alpha go', turnId: 'turn-library',
      skill: { id: librarySkillId('alpha'), name: 'alpha', args: 'go' },
      userMetadata: { skill: { id: 'library:forged', name: 'forged', origin: 'library', args: '' } },
    });
    assert.equal(library.status, 200);
    assert.deepEqual(sent[0], { text: 'go', skill: {
      id: 'library:alpha', name: 'alpha', origin: 'library', path: path.join(skillLibraryRoot(), 'alpha', 'SKILL.md'), body: 'Do alpha for $ARGUMENTS.\n', args: 'go',
    } });
    assert.deepEqual(storedSkills('n-a'), [{ id: 'library:alpha', name: 'alpha', origin: 'library', args: 'go' }]);

    const id = runtimeSkillId('claude', 'user', 'tool');
    const listed = await post('n-b', { text: '', displayText: '/tool', turnId: 'turn-runtime', skill: { id, name: 'tool', args: '' } });
    assert.equal(listed.status, 200);
    assert.deepEqual(sent[1].skill, { id, name: 'tool', origin: 'runtime', path: skillMd, body: 'Do tool for $ARGUMENTS.\n', args: '' });
    assert.deepEqual(storedSkills('n-b'), [{ id, name: 'tool', origin: 'runtime', runtimeId: 'claude', args: '' }]);

    const unknown = await post('n-a', { text: 'x', turnId: 'turn-unknown', skill: { id: librarySkillId('gone'), name: 'gone', args: '' } });
    assert.deepEqual([unknown.status, JSON.parse(unknown.text)], [404, {
      error: 'Couldn’t run /gone: it’s no longer in your skill library.', code: 'skill_not_found',
    }]);
    assert.equal(sent.length, 2);
  });

  test('a workspace without a folder (default Chats) sends a runtime skill through the message route', async () => {
    const skillMd = runtimeSkillFile('claude-home', 'tool');
    fakeRuntime('claude', { skills: [{ name: 'tool', description: 'About tool', scope: 'user', path: skillMd }] });
    registerSession(liveSession('n-bare'), null);
    const id = runtimeSkillId('claude', 'user', 'tool');
    const reply = await post('n-bare', { text: '', displayText: '/tool', turnId: 'turn-bare', skill: { id, name: 'tool', args: '' } });
    assert.equal(reply.status, 200);
    assert.equal((sent[0]?.skill as { path?: string } | undefined)?.path, skillMd);
    assert.deepEqual(listings.map((call) => call.cwd), [normalizeWorkspaceCwd(process.cwd())]);
  });

  test('a runtime that cannot list its skills answers 503 runtime_unavailable, one not registered 404 skill_not_found, and nothing is sent', async () => {
    registerSession(liveSession('n-a'), null);
    const id = runtimeSkillId('claude', 'user', 'tool');
    const unregistered = await post('n-a', { text: '', displayText: '/tool', turnId: 'turn-unregistered', skill: { id, name: 'tool', args: '' } });
    assert.deepEqual([unregistered.status, JSON.parse(unregistered.text).code], [404, 'skill_not_found']);
    fakeRuntime('claude', { list: async () => { throw new Error('not signed in'); } });
    const reply = await post('n-a', { text: '', displayText: '/tool', turnId: 'turn-unlisted', skill: { id, name: 'tool', args: '' } });
    assert.deepEqual([reply.status, JSON.parse(reply.text)], [503, {
      error: 'Couldn’t run /tool: Claude couldn’t list its skills (not signed in).', code: 'runtime_unavailable',
    }]);
    assert.equal(sent.length, 0);
  });

  test('a built-in skill runs with its body and no path, even beside a library skill of its name, and not while it is off', async () => {
    setBuiltinSkillsForTests();
    librarySkill('compare');
    fakeRuntime('claude');
    registerSession(liveSession('n-a'), null);
    const run = (turnId: string) => post('n-a', {
      text: 'queue storage', displayText: '/compare queue storage', turnId,
      skill: { id: builtinSkillId('compare'), name: 'compare', args: 'queue storage' },
    });
    assert.equal((await run('turn-builtin')).status, 200);
    assert.deepEqual(sent[0].skill, {
      id: 'builtin:compare', name: 'compare', origin: 'builtin', body: readSkillFileInfo(COMPARE_SKILL, 'compare').body, args: 'queue storage',
    });
    assert.deepEqual(storedSkills('n-a'), [{ id: 'builtin:compare', name: 'compare', origin: 'builtin', args: 'queue storage' }]);

    assert.equal((await api('PUT', '/skills/builtin/compare', { enabled: false })).status, 200);
    const off = await run('turn-builtin-off');
    assert.deepEqual([off.status, JSON.parse(off.text)], [404, {
      error: 'Couldn’t run /compare: it’s turned off in Settings › Skills.', code: 'skill_not_found',
    }]);
    assert.equal(sent.length, 1);
  });
});

describe('built-in skills', () => {
  beforeEach(() => setBuiltinSkillsForTests());

  test('are listed read-only beside a library skill of the same name, and their detail is the shipped SKILL.md', async () => {
    librarySkill('compare');
    fakeRuntime('claude');
    const page = await api('GET', '/skills?workspaceId=ws-a');
    assert.deepEqual(page.body.skills.map((skill: { id: string }) => skill.id), ['library:compare', 'builtin:compare']);
    assert.deepEqual(page.body.skills[1], {
      id: 'builtin:compare', name: 'compare', description: readSkillFileInfo(COMPARE_SKILL, 'compare').description, origin: 'builtin',
      argumentHint: '<question>', userInvocable: true, modelInvocable: false, managedBy: 'Michi', enabled: true,
    });
    const menu = await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-a');
    assert.deepEqual(menu.body.skills.map((skill: { id: string }) => skill.id), ['library:compare', 'builtin:compare']);
    const detail = await api('GET', `/skills/detail?id=${encodeURIComponent(builtinSkillId('compare'))}`);
    assert.deepEqual([detail.body.skill.content, detail.body.skill.files], [COMPARE_SKILL, []]);
    assert.equal((await api('GET', `/skills/detail?id=${encodeURIComponent(builtinSkillId('gone'))}`)).status, 404);
  });

  test('can only be turned off and on: the / menu drops one that is off, and the library skill of its name keeps its own setting', async () => {
    librarySkill('compare');
    fakeRuntime('claude');
    const off = await api('PUT', '/skills/builtin/compare', { enabled: false });
    assert.deepEqual([off.status, off.body.skill.id, off.body.skill.enabled], [200, 'builtin:compare', false]);
    assert.deepEqual(readSkillsState(), { version: 1, library: {}, builtin: { compare: { enabled: false } } });
    const menu = await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-a');
    assert.deepEqual(menu.body.skills.map((skill: { id: string }) => skill.id), ['library:compare']);
    const page = await api('GET', '/skills');
    assert.deepEqual(page.body.skills.map((skill: { id: string; enabled: boolean }) => [skill.id, skill.enabled]), [['library:compare', true], ['builtin:compare', false]]);

    assert.equal((await api('PUT', '/skills/library/compare', { enabled: false })).body.skill.enabled, false);
    assert.deepEqual(readSkillsState(), { version: 1, library: { compare: { enabled: false } }, builtin: { compare: { enabled: false } } });
    assert.equal((await api('PUT', '/skills/builtin/compare', { enabled: true })).body.skill.enabled, true);
    assert.deepEqual(readSkillsState(), { version: 1, library: { compare: { enabled: false } }, builtin: {} });

    assert.deepEqual([(await api('PUT', '/skills/builtin/compare', { content: 'x' })).body.code], ['invalid_argument']);
    assert.deepEqual([(await api('PUT', '/skills/builtin/compare', {})).body.code], ['invalid_argument']);
    assert.equal((await api('PUT', '/skills/builtin/gone', { enabled: false })).status, 404);
    // Only this machine or its authenticated remote owner may change settings, as for the library.
    const remote = await rawRequest('PUT', '/skills/builtin/compare', { host: 'example.com' }, { enabled: false });
    assert.equal(remote.status, 403);
  });

  test('cloud mode has none', async () => {
    fakeRuntime('claude');
    getDb().prepare('INSERT INTO workspaces (id,name,owner_user_id,cwd,created_at,updated_at) VALUES (?,?,?,?,1,1)').run('ws-cloud', 'Cloud', 'user-1', project);
    process.env.MICHI_CLOUD = '1';
    const user = { 'x-test-user': 'user-1' };
    const menu = await api('GET', '/skills/catalog?runtimeId=claude&workspaceId=ws-cloud', undefined, user);
    assert.deepEqual([menu.status, menu.body.skills], [200, []]);
    const put = await api('PUT', '/skills/builtin/compare', { enabled: false }, user);
    assert.deepEqual([put.status, put.body.code], [404, 'skills_unavailable']);
  });
});
