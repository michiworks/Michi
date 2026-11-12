import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpSlot, McpSlotCallbacks, McpSlotProvider } from '../src/contract/mcp';
import type { AgentTurnInput, SkillTurnInvocation } from '../src/contract/types';
import type { PromptPolicyPort, RuntimeLogLevel } from '../src/contract/host';
import { createDefaultHost } from '../src/core/defaultHost';
import { expandSkillPrompt } from '../src/core/skills';
import { CodexAppServerClient } from '../src/adapters/codex/CodexAppServerClient';
import { CodexRuntime } from '../src/adapters/codex/CodexRuntime';

// Wire shapes are the ones codex 0.167.0 answered in isolated probes
// (/tmp/skills-research/codex, /tmp/skills-impl/codex): a skill in a linked
// folder is listed by its real path, and an unknown method is -32600
// "unknown variant".

interface Sent { method: string; id?: number; params?: any; child: number }

/** app-server behind the real JSONL client: a new fake child per start, answering by method. */
function fakeAppServer(options: { skills?: (cwd: string) => unknown[]; errors?: unknown[]; extraRootsMissing?: boolean } = {}) {
  const sent: Sent[] = [];
  const children: Array<EventEmitter & { stdout: PassThrough }> = [];
  let threads = 0;
  const spawn = () => {
    const index = children.length;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { child.emit('exit', 0); return true; },
    });
    const write = (message: object) => child.stdout.write(JSON.stringify(message) + '\n');
    let buffer = '';
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (typeof message.method !== 'string') continue;
        sent.push({ ...message, child: index });
        const id = message.id;
        if (id === undefined) continue;
        switch (message.method) {
          case 'skills/extraRoots/set':
            write(options.extraRootsMissing
              ? { id, error: { code: -32600, message: 'Invalid request: unknown variant `skills/extraRoots/set`, expected one of `initialize`, `thread/start`' } }
              : { id, result: {} });
            break;
          case 'skills/list':
            write({ id, result: { data: message.params.cwds.map((cwd: string) => ({
              cwd, skills: options.skills?.(cwd) ?? [], errors: options.errors ?? [],
            })) } });
            break;
          case 'thread/start':
            write({ id, result: { thread: { id: `thread-${++threads}` } } });
            break;
          case 'turn/start':
            write({ id, result: { turn: { id: `turn-${id}` } } });
            setImmediate(() => write({ method: 'turn/completed', params: {
              threadId: message.params.threadId, turn: { id: `turn-${id}`, items: [], status: 'completed' },
            } }));
            break;
          case 'mcpServerStatus/list':
            write({ id, result: { data: [] } });
            break;
          default:
            write({ id, result: {} });
        }
      }
    });
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return {
    spawn,
    children,
    sent,
    calls: (method: string) => sent.filter((message) => message.method === method),
    notify: (method: string, params: object) => children.at(-1)!.stdout.write(JSON.stringify({ method, params }) + '\n'),
  };
}

function slotProvider(): McpSlotProvider {
  let slots = 0;
  return {
    create: (parentChatId: string, cwd: string, ownerUserId: string | null, cbs: McpSlotCallbacks) =>
      ({ slotId: `slot-${++slots}`, parentChatId, cwd, ownerUserId, nodeId: null, workspaceId: null, ...cbs }) as McpSlot,
    dispose: async () => {},
    endpoint: (slotId: string) => ({ type: 'http', url: `http://127.0.0.1:1/api/mcp/${slotId}`, headers: [] }),
  } as unknown as McpSlotProvider;
}

/** A library folder and the flat mount the host links it into, as Michi's skill mounts lay them out. */
function skillFolders(t: TestContext) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skills-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const library = path.join(tmp, 'library');
  const mount = path.join(tmp, 'mount');
  fs.mkdirSync(mount, { recursive: true });
  for (const name of ['review', 'broken']) {
    fs.mkdirSync(path.join(library, name), { recursive: true });
    fs.writeFileSync(path.join(library, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Library ${name}\n---\nReview it.\n`);
    fs.symlinkSync(path.join(library, name), path.join(mount, name));
  }
  return { tmp, library, mount };
}

function codexRuntime(t: TestContext, server: ReturnType<typeof fakeAppServer>, mount: string, prompt: Partial<PromptPolicyPort> = {}) {
  const logs: Array<[RuntimeLogLevel, string]> = [];
  const sink = Object.fromEntries((['debug', 'info', 'warn', 'error'] as const).map((level) => [level, (line: string) => { logs.push([level, line]); }]));
  const changes = new Set<() => void>();
  const client = new CodexAppServerClient({ spawnFn: server.spawn, rpcTimeoutMs: 2_000, initTimeoutMs: 2_000 });
  const runtime = new CodexRuntime({
    host: createDefaultHost({
      logLevel: 'debug', logSink: sink as unknown as Pick<Console, RuntimeLogLevel>,
      ports: { prompt },
    }),
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    mcpSlots: slotProvider(),
    skillRoots: () => [mount],
    onSkillRootsChanged: (listener) => { changes.add(listener); return () => { changes.delete(listener); }; },
  }, { client });
  t.after(() => runtime.shutdown());
  return { runtime, logs, libraryChanged: () => { for (const listener of changes) listener(); }, subscribers: () => changes.size };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('Codex skills: listing', () => {
  it('maps skills/list for the cwd and leaves out the host\'s own skills, even by their real path', async (t) => {
    const { library, mount } = skillFolders(t);
    const server = fakeAppServer({ skills: () => [
      { name: 'stageshow', description: 'Product UI', path: '/work/repo/.agents/skills/stageshow/SKILL.md', scope: 'repo', enabled: true, pluginId: null },
      { name: 'ExampleTools:build-package', description: '', shortDescription: 'Build package builds',
        path: '/codex-home/plugins/cache/example/ExampleTools/1/skills/build-package/SKILL.md', scope: 'user', enabled: true,
        pluginId: 'ExampleTools@example', interface: null, dependencies: null },
      { name: 'playwright-cli', description: 'Browser', path: '/home/u/.example/skills/playwright-cli/SKILL.md', scope: 'user', enabled: false, pluginId: null },
      { name: 'imagegen', description: 'Images', path: '/codex-home/skills/.system/imagegen/SKILL.md', scope: 'system', enabled: true, pluginId: null },
      { name: 'review', description: 'Library review', path: path.join(library, 'review', 'SKILL.md'), scope: 'user', enabled: true, pluginId: null },
      { name: 'inner', description: 'Nested in a library folder', path: path.join(library, 'review', 'examples', 'inner', 'SKILL.md'), scope: 'user', enabled: true },
      { name: 'stageshow', description: 'Same scope and name', path: '/work/repo/sub/.agents/skills/stageshow/SKILL.md', scope: 'repo', enabled: true },
    ], errors: [
      { path: '/work/repo/.agents/skills/bad/SKILL.md', message: 'missing field `description`' },
      { path: path.join(library, 'broken', 'SKILL.md'), message: 'invalid YAML' },
    ] });
    const { runtime } = codexRuntime(t, server, mount);
    const listing = await runtime.listSkills({ cwd: '/work/repo' });
    assert.deepEqual(server.calls('skills/list').map((call) => call.params), [{ cwds: ['/work/repo'], forceReload: false }]);
    assert.deepEqual(listing, { skills: [
      { name: 'stageshow', description: 'Product UI', path: '/work/repo/.agents/skills/stageshow/SKILL.md', scope: 'repo', enabled: true },
      { name: 'build-package', description: 'Build package builds', nativeName: 'ExampleTools:build-package',
        path: '/codex-home/plugins/cache/example/ExampleTools/1/skills/build-package/SKILL.md', scope: 'user',
        pluginId: 'ExampleTools@example', managedBy: 'Codex plugin', enabled: true },
      { name: 'playwright-cli', description: 'Browser', path: '/home/u/.example/skills/playwright-cli/SKILL.md', scope: 'user', enabled: false },
      { name: 'imagegen', description: 'Images', path: '/codex-home/skills/.system/imagegen/SKILL.md', scope: 'system', managedBy: 'Codex', enabled: true },
    ], errors: ['/work/repo/.agents/skills/bad/SKILL.md: missing field `description`'] });
  });

  it('caches per cwd until app-server reports skills/changed; refresh re-reads from disk', async (t) => {
    const server = fakeAppServer({ skills: (cwd) => [{ name: 'repo-skill', description: cwd, path: `${cwd}/.agents/skills/repo-skill/SKILL.md`, scope: 'repo', enabled: true }] });
    const { runtime } = codexRuntime(t, server, skillFolders(t).mount);
    const first = await runtime.listSkills({ cwd: '/a' });
    assert.deepEqual(await runtime.listSkills({ cwd: '/a' }), first);
    assert.equal((await runtime.listSkills({ cwd: '/b' })).skills[0].description, '/b');
    assert.equal(server.calls('skills/list').length, 2);
    server.notify('skills/changed', {});
    await tick();
    await runtime.listSkills({ cwd: '/a' });
    await runtime.listSkills({ cwd: '/a', refresh: true });
    assert.deepEqual(server.calls('skills/list').map((call) => call.params), [
      { cwds: ['/a'], forceReload: false }, { cwds: ['/b'], forceReload: false },
      { cwds: ['/a'], forceReload: false }, { cwds: ['/a'], forceReload: true },
    ]);
  });
});

describe('Codex skills: the host\'s skill roots', () => {
  it('are given to every app-server right after initialize, and again after a library change', async (t) => {
    const { mount } = skillFolders(t);
    const server = fakeAppServer();
    const { runtime, libraryChanged, subscribers } = codexRuntime(t, server, mount);
    await runtime.listSkills({ cwd: '/a' });
    assert.deepEqual(server.sent.filter((message) => message.child === 0).map((message) => message.method),
      ['initialize', 'initialized', 'skills/extraRoots/set', 'skills/list']);
    assert.deepEqual(server.calls('skills/extraRoots/set')[0].params, { extraRoots: [mount] });

    // app-server exits and a new one starts: it gets the roots again before any thread opens.
    server.children[0].emit('exit', 1);
    await runtime.newSession({ sessionId: 'chat-after-restart', cwd: '/a', model: 'test-model' });
    assert.deepEqual(server.sent.filter((message) => message.child === 1).map((message) => message.method).slice(0, 3),
      ['initialize', 'initialized', 'skills/extraRoots/set']);

    // A library change: the running app-server re-scans the roots, and the next listing re-reads from disk once.
    libraryChanged();
    await tick();
    assert.equal(server.calls('skills/extraRoots/set').length, 3);
    await runtime.listSkills({ cwd: '/a' });
    await runtime.listSkills({ cwd: '/a' });
    assert.deepEqual(server.calls('skills/list').map((call) => call.params.forceReload), [false, true]);
    await runtime.shutdown();
    assert.equal(subscribers(), 0);
  });

  it('an older Codex without skills/extraRoots/set still starts, says so once, and runs library skills as text', async (t) => {
    const { library, mount } = skillFolders(t);
    const server = fakeAppServer({ extraRootsMissing: true, skills: () => [
      { name: 'review', description: 'Library review', path: path.join(library, 'review', 'SKILL.md'), scope: 'user', enabled: true },
    ] });
    const { runtime, logs, libraryChanged } = codexRuntime(t, server, mount);
    await runtime.warm('/a');
    libraryChanged();
    server.children[0].emit('exit', 1);
    const session = await runtime.newSession({ sessionId: 'chat-old-codex', cwd: '/a', model: 'test-model' });
    assert.deepEqual(server.calls('skills/extraRoots/set').map((call) => call.child), [0, 1], 'once per app-server, not on a library change');
    assert.deepEqual(logs.filter(([, line]) => line.includes('extraRoots')).map(([level]) => level), ['info']);

    const skill: SkillTurnInvocation = { id: 'library:review', name: 'review', origin: 'library', path: path.join(library, 'review', 'SKILL.md'), body: 'Review it.\n', args: 'the diff' };
    for await (const _event of session.send('the diff', { skill })) { /* drain */ }
    assert.deepEqual(server.calls('turn/start').at(-1)!.params.input, [{ type: 'text', text: expandSkillPrompt(skill, 'the diff') }]);
  });
});

describe('Codex skills: skill turns', () => {
  it('send `$name` before the user text with a skill item Codex can match, else the expanded skill, with the skill turn\'s note instead of the reminders', async (t) => {
    const { tmp, library, mount } = skillFolders(t);
    const image = path.join(tmp, 'shot.png');
    fs.writeFileSync(image, 'png');
    const server = fakeAppServer({ skills: () => [
      { name: 'review', description: 'Library review', path: path.join(library, 'review', 'SKILL.md'), scope: 'user', enabled: true },
      { name: 'ExampleTools:build-package', description: 'Build package', path: '/plugins/build-package/SKILL.md', scope: 'user', enabled: true, pluginId: 'core@example' },
      { name: 'old', description: 'Turned off', path: '/home/u/.agents/skills/old/SKILL.md', scope: 'user', enabled: false },
    ] });
    const { runtime } = codexRuntime(t, server, mount, { skillTurnNote: () => '\n[skill turn]', followUpsTurnReminder: () => '\n[reminder]' });
    const session = await runtime.newSession({ sessionId: 'chat-skills', cwd: '/work/repo', model: 'test-model' });
    const input = async (text: string, turn?: AgentTurnInput) => {
      for await (const _event of session.send(text, turn)) { /* drain */ }
      return server.calls('turn/start').at(-1)!.params.input;
    };
    const librarySkill = (name: string, args: string): SkillTurnInvocation =>
      ({ id: `library:${name}`, name, origin: 'library', path: path.join(library, name, 'SKILL.md'), body: 'Review it.\n', args });

    // A library skill is sent at its mount path, though app-server lists the linked folder's real path.
    assert.deepEqual(await input('check the build', {
      skill: librarySkill('review', 'check the build'), memoryContext: 'Memory: m', attachments: [{ name: 'shot.png', absPath: image }],
    }), [
      { type: 'text', text: 'Memory: m\n\n---\n\n$review check the build\n[skill turn]' },
      { type: 'skill', name: 'review', path: path.join(mount, 'review', 'SKILL.md') },
      { type: 'localImage', path: image },
    ]);
    assert.deepEqual(await input('', { skill: { id: 'runtime:codex:user:ExampleTools:build-package', name: 'build-package',
      nativeName: 'ExampleTools:build-package', origin: 'runtime', path: '/plugins/build-package/SKILL.md', body: 'Build.', args: '' } }), [
      { type: 'text', text: '$ExampleTools:build-package\n[skill turn]' },
      { type: 'skill', name: 'ExampleTools:build-package', path: '/plugins/build-package/SKILL.md' },
    ]);

    // Codex would drop these items without a word: disabled, not listed for this cwd, or not linked into the mount.
    const fallbacks: SkillTurnInvocation[] = [
      { id: 'runtime:codex:user:old', name: 'old', origin: 'runtime', path: '/home/u/.agents/skills/old/SKILL.md', body: 'Old body.', args: 'go' },
      { id: 'runtime:codex:repo:gone', name: 'gone', origin: 'runtime', path: '/work/repo/.agents/skills/gone/SKILL.md', body: 'Gone.', args: 'go' },
      librarySkill('notes', 'go'),
      // Michi's built-in skills are never mounted; one named like a listed skill is still its own.
      { id: 'builtin:review', name: 'review', origin: 'builtin', body: 'Built in.', args: 'go' },
    ];
    for (const skill of fallbacks) {
      assert.deepEqual(await input('go', { skill }), [{ type: 'text', text: `${expandSkillPrompt(skill, 'go')}\n[skill turn]` }], skill.id);
    }
    assert.deepEqual(await input('hello'), [{ type: 'text', text: 'hello\n[reminder]' }], 'other turns are unchanged');
    assert.equal(server.calls('skills/list').length, 1, 'one listing serves every turn of the cwd');
  });

  it('enter history as the command the person ran, after its context, never as `$name` or the expanded skill', async (t) => {
    const { library, mount } = skillFolders(t);
    const server = fakeAppServer({ skills: () => [
      { name: 'review', description: 'Library review', path: path.join(library, 'review', 'SKILL.md'), scope: 'user', enabled: true },
    ] });
    const { runtime } = codexRuntime(t, server, mount, { firstTurnPrefix: () => 'Parent thread' });
    const session = await runtime.newSession({ sessionId: 'chat-history', cwd: '/work/repo', model: 'test-model' });
    const send = async (text: string, turn?: AgentTurnInput) => {
      for await (const _event of session.send(text, turn)) { /* drain */ }
      return server.calls('turn/start').at(-1)!.params.input[0].text;
    };
    const librarySkill = (name: string, args: string): SkillTurnInvocation =>
      ({ id: `library:${name}`, name, origin: 'library', path: path.join(library, name, 'SKILL.md'), body: 'Review it.\n', args });

    assert.equal(await send('> the failing step\n\ncheck the build', { skill: librarySkill('review', 'check the build') }),
      'Parent thread\n\n---\n\n$review > the failing step\n\ncheck the build', 'app-server still gets `$review`');
    await send('go', { skill: librarySkill('notes', 'go') });
    await send('Look at this comment:\n\nshot.png\n\n[Attached files: shot.png — /d/shot.png]', { skill: librarySkill('notes', 'shot.png') });
    await send('hello');
    // A branch's preamble quotes this history: app-server would run a `$name`
    // there, and the expanded skill would copy its whole SKILL.md.
    assert.deepEqual(session.getHistory(), [
      { role: 'user', content: 'Parent thread\n\n---\n\n> the failing step\n\n/review check the build' },
      { role: 'user', content: '/notes go' },
      { role: 'user', content: 'Look at this comment:\n\n[Attached files: shot.png — /d/shot.png]\n\n/notes shot.png' },
      { role: 'user', content: 'hello' },
    ]);
  });
});
