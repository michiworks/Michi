/**
 * Skills on the runtimes built on AcpAgentRuntime (Kiro, Kiro Crew,
 * Antigravity): the commands a session reports, where Kiro V3 marks its
 * skills and prompts in `_meta.kiro` and agy marks nothing, and the ones a
 * chat runs before it has a session; the prompt of a skill turn, whose
 * instructions Michi sends itself; and the skill folders each preset lists.
 */
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultHost } from '../src/core/defaultHost';
import { expandSkillPrompt } from '../src/core/skills';
import type { SkillTurnInvocation } from '../src/contract/types';
import { AcpAgentRuntime } from '../src/adapters/kiro/AcpAgentRuntime';
import { AcpAgentSession } from '../src/adapters/kiro/AcpAgentSession';
import { AcpClient, type AcpClientOptions, type AcpLaunch } from '../src/adapters/kiro/acpClient';
import { KIRO_FLAVOR } from '../src/adapters/kiro/acpAgentFlavor';
import { kiroCommand as interfaceCommand } from '../src/adapters/kiro/v3Commands';
import type { KiroEngine } from '../src/adapters/kiro/kiroProtocol';
import { createCrewRuntime } from '../src/adapters/crew/index';
import { createAntigravityRuntime } from '../src/adapters/antigravity/index';

const LIBRARY = '/data/skill-mounts/kiro-workspace';

/** A command as Kiro V3 advertises a skill, prompt or agent. */
function kiroCommand(name: string, type: string, source: Record<string, unknown>) {
    return {
        name, description: `About ${name}`, input: { hint: 'optional context' },
        _meta: { kiro: { type, resource: { resourceType: type, source }, originalName: name } },
    };
}

function tempDir(t: TestContext): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-skills-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeSkill(root: string, name: string, description: string): void {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`);
}

/** os.homedir() reads HOME (USERPROFILE on Windows) at each call. */
function useHome(t: TestContext, home: string): void {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    Object.assign(process.env, { HOME: home, USERPROFILE: home });
    t.after(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
}

/** A client in `cwd` that has received `commands` for session S1; no agent process runs. */
function advertised(engine: KiroEngine, commands: unknown[], options: AcpClientOptions = {}, launch?: AcpLaunch, cwd = '/work'): AcpClient {
    const client = new AcpClient('/bin/false', cwd, undefined, engine, launch, 'kiro', options);
    const internal = client as any;
    internal.initialization = { agentCapabilities: { _meta: { kiro: { extensionMethods: ['_kiro/session/compact'] } } } };
    internal.dispatch({ method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'available_commands_update', availableCommands: commands } } });
    return client;
}

/** Resolves when the session's state is next published; rejects when none is within 5 s. */
function nextSessionState(client: AcpClient, sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { stop(); reject(new Error('No session state was published')); }, 5_000);
        const stop = client.onSessionState(sessionId, () => { clearTimeout(timer); stop(); resolve(); });
    });
}

describe('the commands a session reports', () => {
    // Kiro expands a prompt only when its `/name` is the whole prompt, which
    // Michi's context and reminders around the user's text never leave it.
    it("Kiro V3: Michi's commands, then the skills Kiro advertises, less its prompts and the host's library", () => {
        const client = advertised('v3', [
            { name: 'compact', description: 'Compact the conversation' },
            kiroCommand('review', 'skill', { origin: 'workspace', root: '/work' }),
            kiroCommand('release-notes', 'prompt', { origin: 'user' }),
            kiroCommand('compact', 'skill', { origin: 'user' }),
            kiroCommand('context-gatherer', 'custom-agent', { origin: 'bundled' }),
            kiroCommand('from-library', 'skill', { origin: 'workspace', root: LIBRARY }),
            { name: 'doctor' },
        ], { skillLibraryWorkspace: LIBRARY });
        assert.deepEqual(client.getSessionState('S1').commands, [
            interfaceCommand('clear'), interfaceCommand('tools'), interfaceCommand('mcp'),
            // A skill named like one of Michi's commands does not describe it.
            { name: 'compact', description: 'Compact the conversation', kind: 'command' },
            { name: 'usage', description: 'Show your Kiro usage', kind: 'command' },
            { name: 'review', description: 'About review', input: { hint: 'optional context' }, kind: 'skill' },
            { name: 'compact', description: 'About compact', input: { hint: 'optional context' }, kind: 'skill' },
        ]);
    });

    // A warm chat then runs them as commands whatever the host's catalog says.
    it('Kiro V2 and Crew: every command executeCommand runs is a command, advertised or not', () => {
        const host = createDefaultHost({ logLevel: 'silent' });
        const commands = (runtime: AcpAgentRuntime, advertisedCommands: unknown[]) =>
            advertised('v2', advertisedCommands, (runtime as any).acpClientOptions()).getSessionState('S1').commands;
        assert.deepEqual(commands(new AcpAgentRuntime({ host, bridge: {}, engine: 'v2' }), [{ name: 'tools', description: 'Kiro\'s own' }, { name: 'help' }]), [
            interfaceCommand('clear'),
            { ...interfaceCommand('tools'), description: 'Kiro\'s own' },
            interfaceCommand('context'), interfaceCommand('effort'),
            { name: 'help' },
        ]);
        assert.deepEqual(commands(createCrewRuntime({ host, bridge: {} }), []), [
            { name: 'effort', description: 'Set the reasoning effort', kind: 'command', argumentHint: '<level>' },
        ]);
    });

    it('names no skill of the machine where the host shows none (cloud mode), in its state or on its turn', () => {
        const client = advertised('v3', [], { advertiseSkills: () => false });
        const internal = client as any;
        const queued: unknown[] = [];
        internal.sessionQueues.set('S1', { push: (item: unknown) => queued.push(item) });
        internal.dispatch({ method: 'session/update', params: { sessionId: 'S1', update: {
            sessionUpdate: 'available_commands_update', availableCommands: [kiroCommand('review', 'skill', { origin: 'workspace', root: '/work' })],
        } } });
        assert.deepEqual(client.getSessionState('S1').commands?.map((command) => command.name), ['clear', 'tools', 'mcp', 'compact', 'usage']);
        assert.deepEqual(queued, [], 'an advertisement reaches a chat only as its state');
    });

    // agy advertises its skills as plain commands: unmarked, `/deploy` would
    // take the name from the listed skill and go out as typed text.
    it('Antigravity: the commands it advertises, those named like its skills as skills', async (t) => {
        const cwd = tempDir(t);
        useHome(t, tempDir(t));
        writeSkill(path.join(cwd, '.agents', 'skills'), 'deploy', 'Deploy skill');
        const runtime = createAntigravityRuntime({ host: createDefaultHost({ logLevel: 'silent' }), bridge: {} });
        const client = advertised('v2', [{ name: 'deploy', description: 'Deploy skill', input: { hint: 'target' } }, { name: 'skills' }],
            (runtime as any).acpClientOptions(), { bin: '/bin/false', args: () => ['acp'], standardAcp: true }, cwd);
        // The skill folders are read after the commands arrive, and the state is published again.
        await nextSessionState(client, 'S1');
        assert.deepEqual(client.getSessionState('S1').commands, [
            { name: 'deploy', description: 'Deploy skill', input: { hint: 'target' }, kind: 'skill' },
            { name: 'skills' },
        ]);
    });
});

/** The AcpAgentSession's view of a runtime, over a client that records each prompt and ends the turn at once. */
function session(options: { restricted?: boolean } = {}) {
    const prompts: string[] = [];
    const client = {
        async *prompt(_sid: string, text: string) {
            prompts.push(text);
            yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
        },
    };
    const runtime = {
        host: createDefaultHost({ logLevel: 'silent', ports: { prompt: { turnSuffix: () => '\n[reminder]', skillTurnNote: () => '\n[skill turn]' } } }),
        engine: 'v3',
        flavor: KIRO_FLAVOR,
        ensureClient: async () => client,
        getClient: () => client,
        assertMetaAgentReady: () => {},
        // As on a shared MCP catalog (session anchors).
        getMcpSessionReminder: (sid: string, turn?: { skill?: boolean }) => `\n[${sid}${turn?.skill ? '' : ', metadata tools'}]`,
    } as unknown as AcpAgentRuntime;
    const chat = new AcpAgentSession('chat', 'S1', runtime, '/work', options.restricted ? { toolProfile: { restricted: true } as never } : {});
    return { chat, prompts };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
    for await (const _ of events) { /* the turn's events are not under test */ }
}

describe('a skill turn', () => {
    const review: SkillTurnInvocation = {
        id: 'library:review', name: 'review', origin: 'library',
        path: '/library/review/SKILL.md', body: 'Review $ARGUMENTS with care.', args: 'the diff',
    };

    it("sends the skill ahead of the user's text, inside Michi's context, with the skill turn's note instead of the reminders and no metadata tools", async () => {
        const { chat, prompts } = session();
        chat.primeFirstMessage('PREAMBLE');
        await drain(chat.send('the diff', { skill: review, memoryContext: 'MEMORY', pageContext: 'PAGE' }));
        await drain(chat.send('next question'));
        assert.deepEqual(prompts, [
            `PREAMBLE\nMEMORY\n\n---\n\nPAGE\n\n---\n\n${expandSkillPrompt(review, 'the diff')}\n[skill turn]\n[S1]`,
            'next question\n[reminder]\n[S1, metadata tools]',
        ]);
        assert.deepEqual(chat.getHistory().filter((message) => message.role === 'user').map((message) => message.content),
            ['/review the diff', 'next question'], "a branch's transcript shows the command, not the skill's text");
    });

    it("keeps a skill turn's context ahead of the command in history, not as its arguments", async () => {
        const { chat } = session();
        const attached = '[Attached files: a.md — /w/a.md]';
        await drain(chat.send(`${attached}\n\nfix the bug`, { skill: { ...review, args: 'fix the bug' } }));
        assert.deepEqual(chat.getHistory().filter((message) => message.role === 'user').map((message) => message.content),
            [`${attached}\n\n/review fix the bug`]);
    });

    it('keeps a restricted session from running a skill Kiro would take as a command', async () => {
        const { chat, prompts } = session({ restricted: true });
        const { body: _body, ...byName } = review;
        await assert.rejects(drain(chat.send('the diff', { skill: byName })), /Kiro commands are off in the restricted session/);
        assert.deepEqual(prompts, []);
    });
});

describe('hostCommands', () => {
    it("names the commands each preset runs before a chat has a session, never the host's /compact", () => {
        const host = createDefaultHost({ logLevel: 'silent' });
        const names = (runtime: AcpAgentRuntime) => runtime.hostCommands().map((command) => command.name);
        assert.deepEqual(names(new AcpAgentRuntime({ host, bridge: {}, engine: 'v2' })), ['clear', 'tools', 'context', 'effort']);
        // A chat without live state runs all of them; a session's state names those this kiro-cli serves.
        assert.deepEqual(names(new AcpAgentRuntime({ host, bridge: {}, engine: 'v3' })),
            ['clear', 'tools', 'mcp', 'effort', 'context', 'history', 'export', 'code', 'usage']);
        assert.deepEqual(names(createCrewRuntime({ host, bridge: {} })), ['effort']);
        assert.deepEqual(names(createAntigravityRuntime({ host, bridge: {} })), []);
        assert.ok(new AcpAgentRuntime({ host, bridge: {}, engine: 'v3' }).hostCommands().every((command) => command.kind === 'command' && command.description));
    });
});

describe('listSkills', () => {
    it("reads each runtime's own skill folders, the first winning a name clash", async (t) => {
        const home = tempDir(t);
        const cwd = tempDir(t);
        useHome(t, home);
        writeSkill(path.join(cwd, '.kiro', 'skills'), 'shared', 'The workspace one');
        writeSkill(path.join(home, '.kiro', 'skills'), 'shared', "The user's one");
        writeSkill(path.join(home, '.kiro', 'skills'), 'mine', 'A user skill');
        writeSkill(path.join(home, '.kiro', 'crew', 'skills'), 'crew-only', 'A Crew skill');
        writeSkill(path.join(cwd, '.agents', 'skills'), 'agy-project', 'An Antigravity workspace skill');
        writeSkill(path.join(home, '.gemini', 'config', 'skills'), 'agy-user', 'An Antigravity user skill');
        const host = createDefaultHost({ logLevel: 'silent' });
        const listed = async (runtime: AcpAgentRuntime) => (await runtime.listSkills({ cwd })).skills
            .map((skill) => [skill.name, skill.scope, skill.description, skill.managedBy ?? null]);

        assert.deepEqual(await listed(new AcpAgentRuntime({ host, bridge: {}, defaultCwd: cwd })), [
            ['shared', 'workspace', 'The workspace one', null],
            ['mine', 'user', 'A user skill', null],
        ]);
        assert.deepEqual(await listed(createCrewRuntime({ host, bridge: {} })), [
            ['crew-only', 'crew', 'A Crew skill', 'Crew'],
            ['mine', 'user', 'A user skill', null],
            ['shared', 'user', "The user's one", null],
        ]);
        const crewHome = tempDir(t);
        writeSkill(path.join(crewHome, 'skills'), 'elsewhere', 'Under KIROCREW_HOME');
        assert.deepEqual((await listed(createCrewRuntime({ host, bridge: {}, crew: { kirocrewHome: crewHome } })))[0],
            ['elsewhere', 'crew', 'Under KIROCREW_HOME', 'Crew']);
        assert.deepEqual(await listed(createAntigravityRuntime({ host, bridge: {} })), [
            ['agy-project', 'workspace', 'An Antigravity workspace skill', null],
            ['agy-user', 'user', 'An Antigravity user skill', null],
        ]);
    });
});
