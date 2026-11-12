/**
 * Skills in ClaudeSession, at the SDK boundary: the / menu from the CLI's
 * command table, skill turns run as the CLI's own command (or sent as the
 * skill's text when the process does not list it) with the skill turn's
 * note instead of Michi's reminders, and library reloads.
 *
 * Frames follow CLI 2.1.318 in the probes under /tmp/skills-research: the
 * command runs only when the message's last block is text starting with
 * '/', and plugin skills are named `plugin:skill` with the bare alias. The
 * library's folder skills keep their names, or are `michi:<name>` beside a
 * personal skill of that name, and hide a legacy command of their name;
 * reloadSkills pushes the new table just before it answers (CLI 2.1.319,
 * /tmp/skills-v1/addir-probe, /tmp/skills-v1/claude-names-fix).
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandSkillPrompt, type SkillTurnInvocation } from 'michi-runtime';
import type { ClaudeSdkTransport, ClaudeSdkTransportOptions } from 'michi-runtime/internal/adapters/claude/claudeSdkTransport';
import { claudeHostCommands } from 'michi-runtime/internal/adapters/claude/claudeSkills';
import * as followUpsExperiment from '../src/agents/followUpsExperiment';
import * as agentConfig from '../src/services/agentConfig';
import { formatSkillFile } from 'michi-shared';
import { SKILL_TURN_NOTE } from '../src/agents/preamble';
import { notifySkillLibraryChanged } from '../src/services/skills/events';
import { resetSkillMountsForTests } from '../src/services/skills/mounts';
import { skillLibraryRoot, skillMountsRoot } from '../src/services/skills/paths';
import {
  newScriptedSession, restoreClaudeSpawn, runningScriptedTurn, stubClaudeSpawn, until,
} from './helpers/claudeScriptedChild';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { restrictedChatProfile } from './helpers/restrictedChatProfile';
import type { NormalizedEvent } from '../src/services/chatEvents';

const transportModule = require('michi-runtime/internal/adapters/claude/claudeSdkTransport') as {
  createClaudeSdkTransport: (args: ClaudeSdkTransportOptions) => Promise<ClaudeSdkTransport>;
};
const fixtureTransport = transportModule.createClaudeSdkTransport;

/** The command table the next spawned process answers initialize with, its reloadSkills calls, and what each does before it answers. */
const cli = { commands: [] as unknown[], reloads: 0, onReload: undefined as (() => Promise<void>) | undefined };

const TABLE = [
  { name: 'model', description: 'Set the AI model', argumentHint: '[model]', builtin: true },
  { name: 'code-review', description: 'Review the diff', argumentHint: '', builtin: true },
  { name: 'impeccable', description: 'Design critique (user)', argumentHint: '[target]' },
  { name: 'plain:plain-skill', description: '(plain) A plugin skill.', argumentHint: '', aliases: ['plain-skill'] },
  // The library's review, which no personal skill's name clashes with.
  { name: 'review', description: 'Review a file.', argumentHint: '<file>' },
];

const LIBRARY_REVIEW: SkillTurnInvocation = {
  id: 'library:review', name: 'review', origin: 'library', path: '/library/review/SKILL.md', body: 'Review $ARGUMENTS carefully.', args: 'src/a.ts',
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function sendTurn(session: any, text: string, input: Record<string, unknown>) {
  const events: NormalizedEvent[] = [];
  const done = (async () => { for await (const event of session.send(text, input)) events.push(event); })();
  return { events, done };
}

function writeLibrarySkill(name: string): void {
  const folder = path.join(skillLibraryRoot(), name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), formatSkillFile({ name, description: 'Review a file.', body: 'Review $ARGUMENTS carefully.' }));
}

/** The text of the last block of message `line` the process got. */
function sentText(child: { lines: any[] }, line: number): string {
  const content = child.lines[line].message.content as string | Array<{ text?: string }>;
  return typeof content === 'string' ? content : content.at(-1)!.text!;
}

/** The skills a session's state names. */
const stateSkills = (session: any): string[] => session.getSessionState().commands!
  .filter((entry: { kind: string }) => entry.kind === 'skill').map((entry: { name: string }) => entry.name);

describe('ClaudeSession skills', () => {
  let dir: string;
  beforeEach(() => {
    stubClaudeSpawn();
    mock.restoreAll();
    cli.commands = TABLE;
    cli.reloads = 0;
    cli.onReload = undefined;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-skills-'));
    // Claude's profile (its personal commands) is the test's, not the developer's.
    mock.method(agentConfig, 'resolveClaudeConfigDir', () => dir);
    writeLibrarySkill('review');
    transportModule.createClaudeSdkTransport = async (args) => {
      const transport = await fixtureTransport(args);
      Object.assign(transport.query, { reloadSkills: async () => { cli.reloads += 1; await cli.onReload?.(); return { skills: [] }; } });
      return { ...transport, initialized: Promise.resolve({ commands: cli.commands }) as ClaudeSdkTransport['initialized'] };
    };
  });
  afterEach(() => {
    transportModule.createClaudeSdkTransport = fixtureTransport;
    restoreClaudeSpawn();
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(skillLibraryRoot(), { recursive: true, force: true });
    fs.rmSync(skillMountsRoot(), { recursive: true, force: true });
    resetSkillMountsForTests();
  });

  test('the menu offers the bridge commands and the CLI\'s own skills, not the library\'s, and follows commands_changed', async () => {
    const { session, child } = await newScriptedSession();
    try {
      await until(() => session.getSessionState().commands!.length > 4, 'the initialize answer');
      assert.deepEqual(session.getSessionState().commands, [
        ...claudeHostCommands(),
        { name: 'impeccable', description: 'Design critique (user)', kind: 'skill', argumentHint: '[target]' },
        { name: 'plain:plain-skill', description: '(plain) A plugin skill.', kind: 'skill', aliases: ['plain-skill'] },
      ]);
      const version = session.getSessionState().version;
      let notified = 0;
      session.onSessionState(() => { notified += 1; });
      child.send({ type: 'system', subtype: 'commands_changed', session_id: 'ext-steer-1',
        commands: [...TABLE, { name: 'added-later', description: 'New (user)', argumentHint: '' }] });
      await until(() => notified === 1, 'the pushed table');
      assert.equal(session.getSessionState().commands!.at(-1)!.name, 'added-later');
      assert.ok(session.getSessionState().version! > version!);
    } finally { await session.dispose(); }
  });

  test('the assistant, which takes no skill turns, and a host that shows no skills offer only the bridge commands', async () => {
    for (const overrides of [{ toolProfile: restrictedChatProfile() }, { options: claudeTestOptions({ advertiseSkills: () => false }) }]) {
      const { session } = await newScriptedSession(overrides);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(session.getSessionState().commands!.map((command) => command.name), ['status', 'model', 'context', 'mcp']);
      } finally { await session.dispose(); }
    }
  });

  test('a listed skill runs as the CLI\'s command: every other part of the turn, images included, comes before it, with no reminder', async () => {
    mock.method(followUpsExperiment, 'followUpsTurnReminder', () => '\n\n[REMINDER]');
    const image = path.join(dir, 'shot.png');
    const notes = path.join(dir, 'notes.txt');
    fs.writeFileSync(image, PNG);
    fs.writeFileSync(notes, 'notes');
    const { session, child } = await newScriptedSession();
    try {
      assert.deepEqual((child as any).spawnArgs.addDirs, [path.join(process.env.MICHI_DATA_DIR!, 'skill-mounts', 'claude', 'michi')]);
      session.setFirstTurnPrefix('PREAMBLE');
      const turn = sendTurn(session, 'Look at this comment:\n\nsrc/a.ts', {
        skill: LIBRARY_REVIEW, memoryContext: 'MEMORY', pageContext: 'PAGE', humanOrigin: true,
        attachments: [{ name: 'shot.png', absPath: image }, { name: 'notes.txt', absPath: notes }],
      });
      await until(() => child.lines.length === 1, 'the skill message');
      const sent = child.lines[0];
      const blocks = sent.message.content as Array<Record<string, any>>;
      assert.deepEqual(blocks.map((block) => block.type), ['text', 'image', 'text']);
      assert.equal(blocks[2].text, '/review src/a.ts', 'the command is the last block, its arguments only');
      assert.equal(blocks[0].text, [
        'MEMORY', 'PAGE', 'PREAMBLE', `Look at this comment:${SKILL_TURN_NOTE}` + '\n[Attachments]\nThe user attached the following non-image files. They are not inlined in this\n'
          + `message — read them from disk if they are relevant:\n- notes.txt → ${notes}`,
      ].join('\n\n---\n\n'));
      assert.equal(blocks[0].text.includes('[REMINDER]'), false);
      assert.deepEqual(sent.origin, { kind: 'human' });
      child.init();
      child.chunk('Reviewed.');
      child.result();
      await turn.done;
      assert.deepEqual(session.getHistory().map((message: { content: string }) => message.content),
        ['PREAMBLE\n\n---\n\nLook at this comment:\n\n/review src/a.ts', 'Reviewed.']);
    } finally { await session.dispose(); }
  });

  test('the arguments reach the CLI once, after the command, also when the attached files listed after them repeat them', async () => {
    const image = path.join(dir, 'shot.png');
    fs.writeFileSync(image, PNG);
    const { session, child } = await newScriptedSession();
    try {
      // The composer's wire text: the arguments, then its list of the attached files.
      const listed = `[Attached files: shot.png — ${image}]`;
      const turn = sendTurn(session, `Look at this comment:\n\nshot.png\n\n${listed}`, {
        skill: { ...LIBRARY_REVIEW, args: 'shot.png' }, attachments: [{ name: 'shot.png', absPath: image }],
      });
      await until(() => child.lines.length === 1, 'the skill message');
      const blocks = child.lines[0].message.content as Array<Record<string, any>>;
      assert.deepEqual(blocks.map((block) => block.text ?? block.type), [`Look at this comment:\n\n${listed}${SKILL_TURN_NOTE}`, 'image', '/review shot.png']);
      child.init();
      child.result();
      await turn.done;
      assert.equal(session.getHistory()[0].content, `Look at this comment:\n\n${listed}\n\n/review shot.png`);
    } finally { await session.dispose(); }
  });

  test('a file the turn text already lists is not named again in an attachments note', async () => {
    const notes = path.join(dir, 'notes.txt');
    fs.writeFileSync(notes, 'notes');
    const { session, child } = await newScriptedSession();
    try {
      const listed = `[Attached files: notes.txt — ${notes}]`;
      const turn = sendTurn(session, `${listed}\n\ncheck the notes`, { skill: { ...LIBRARY_REVIEW, args: 'check the notes' }, attachments: [{ name: 'notes.txt', absPath: notes }] });
      await until(() => child.lines.length === 1, 'the skill message');
      const blocks = child.lines[0].message.content as Array<Record<string, any>>;
      assert.deepEqual(blocks.map((block) => block.text ?? block.type), [`${listed}${SKILL_TURN_NOTE}`, '/review check the notes']);
      child.init();
      child.result();
      await turn.done;
    } finally { await session.dispose(); }
  });

  test('a skill with no text of its own is its command after the note; one the process does not list goes as its text', async () => {
    cli.commands = TABLE.filter((command) => command.name !== 'review');
    const { session, child } = await newScriptedSession();
    try {
      const plugin: SkillTurnInvocation = { id: 'runtime:claude:plugin:plain:plain-skill', name: 'plain-skill', origin: 'runtime', nativeName: 'plain:plain-skill', args: '' };
      const first = sendTurn(session, '', { skill: plugin });
      await until(() => child.lines.length === 1, 'the first skill message');
      assert.deepEqual(child.lines[0].message.content, [{ type: 'text', text: SKILL_TURN_NOTE.trim() }, { type: 'text', text: '/plain:plain-skill' }]);
      child.init();
      child.result();
      await first.done;

      mock.method(followUpsExperiment, 'followUpsTurnReminder', () => '\n\n[REMINDER]');
      const second = sendTurn(session, 'src/a.ts', { skill: LIBRARY_REVIEW });
      await until(() => child.lines.length === 2, 'the second skill message');
      assert.equal(child.lines[1].message.content, `${expandSkillPrompt(LIBRARY_REVIEW, 'src/a.ts')}${SKILL_TURN_NOTE}`, 'an ordinary prompt');
      assert.match(child.lines[1].message.content, /^<skill name="review" location="\/library\/review\/SKILL.md">/);
      child.result();
      await second.done;
      assert.equal(session.getHistory().find((message) => message.content.startsWith('/review'))?.content, '/review src/a.ts');
    } finally { await session.dispose(); }
  });

  test('beside a personal skill of its name the library\'s is michi:<name>: the menu keeps the personal one, and each runs by its own row', async () => {
    cli.commands = [...TABLE.filter((command) => command.name !== 'review'),
      { name: 'review', description: 'Mine (user)', argumentHint: '' },
      { name: 'michi:review', description: 'Review a file.', argumentHint: '<file>' }];
    const { session, child } = await newScriptedSession();
    const command = (line: number) => (child.lines[line].message.content as Array<{ text?: string }>).at(-1)!.text;
    try {
      await until(() => session.getSessionState().commands!.length > 4, 'the initialize answer');
      assert.deepEqual(session.getSessionState().commands!.filter((entry) => entry.kind === 'skill').map((entry) => entry.name),
        ['impeccable', 'plain:plain-skill', 'review']);
      const library = sendTurn(session, 'src/a.ts', { skill: LIBRARY_REVIEW });
      await until(() => child.lines.length === 1, 'the library skill');
      assert.equal(command(0), '/michi:review src/a.ts');
      child.init();
      child.result();
      await library.done;
      const personal: SkillTurnInvocation = { id: 'runtime:claude:user:review', name: 'review', origin: 'runtime', args: 'x' };
      const second = sendTurn(session, 'x', { skill: personal });
      await until(() => child.lines.length === 2, 'the personal skill');
      assert.equal(command(1), '/review x');
      child.result();
      await second.done;
    } finally { await session.dispose(); }
  });

  test('a library skill named like a personal command stays out of the folder: the command keeps its row, the skill goes as its text', async () => {
    fs.mkdirSync(path.join(dir, 'commands'));
    fs.writeFileSync(path.join(dir, 'commands', 'review.md'), 'My own review.\n');
    cli.commands = [...TABLE.filter((command) => command.name !== 'review'), { name: 'review', description: 'My own review. (user)', argumentHint: '' }];
    const { session, child } = await newScriptedSession();
    try {
      assert.deepEqual(fs.readdirSync(path.join((child as any).spawnArgs.addDirs[0], '.claude', 'skills')), []);
      await until(() => stateSkills(session).includes('review'), 'the personal command in the menu');
      const turn = sendTurn(session, 'src/a.ts', { skill: LIBRARY_REVIEW });
      await until(() => child.lines.length === 1, 'the library skill');
      assert.equal(child.lines[0].message.content, `${expandSkillPrompt(LIBRARY_REVIEW, 'src/a.ts')}${SKILL_TURN_NOTE}`);
      child.init();
      child.result();
      await turn.done;
    } finally { await session.dispose(); }
  });

  test('a built-in skill always goes as its text, even beside a CLI command of its name', async () => {
    fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'commands', 'review.md'), 'My own review.\n');
    cli.commands = [...TABLE.filter((command) => command.name !== 'review'), { name: 'review', description: 'Mine (user)', argumentHint: '' }];
    const { session, child } = await newScriptedSession();
    try {
      await until(() => stateSkills(session).includes('review'), 'the personal command in the menu');
      const builtin: SkillTurnInvocation = { id: 'builtin:review', name: 'review', origin: 'builtin', body: 'Built in: $ARGUMENTS.', args: 'src/a.ts' };
      const turn = sendTurn(session, 'src/a.ts', { skill: builtin });
      await until(() => child.lines.length === 1, 'the built-in skill');
      assert.equal(child.lines[0].message.content, `${expandSkillPrompt(builtin, 'src/a.ts')}${SKILL_TURN_NOTE}`);
      assert.match(child.lines[0].message.content, /^<skill name="review">\nBuilt in: src\/a\.ts\.\n<\/skill>/);
      child.init();
      child.result();
      await turn.done;
      assert.equal(session.getHistory()[0].content, '/review src/a.ts');
    } finally { await session.dispose(); }
  });

  test('a project command whose row the library\'s skill took goes as its text', async () => {
    const { session, child } = await newScriptedSession();
    try {
      const command: SkillTurnInvocation = {
        id: 'runtime:claude:command:review', name: 'review', origin: 'runtime', path: '/work/.claude/commands/review.md', body: 'Check $ARGUMENTS.', args: 'x',
      };
      const turn = sendTurn(session, 'x', { skill: command });
      await until(() => child.lines.length === 1, 'the command');
      assert.equal(child.lines[0].message.content, `${expandSkillPrompt(command, 'x')}${SKILL_TURN_NOTE}`, 'not /review, which runs the library\'s');
      child.init();
      child.result();
      await turn.done;
    } finally { await session.dispose(); }
  });

  test('a library change reloads an idle process\'s skills at once and a busy one\'s after its turn', async () => {
    const { session, child } = await newScriptedSession();
    try {
      notifySkillLibraryChanged();
      await until(() => cli.reloads === 1, 'the idle reload');
      const turn = await runningScriptedTurn(session, child);
      notifySkillLibraryChanged();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(cli.reloads, 1, 'the running turn keeps the skills it started with');
      child.result();
      await turn.done;
      await until(() => cli.reloads === 2, 'the reload after the turn');
    } finally { await session.dispose(); }
    notifySkillLibraryChanged();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cli.reloads, 2, 'a disposed session no longer follows the library');
  });

  describe('a library skill added beside a personal one of its name', () => {
    const personal = [...TABLE.filter((command) => command.name !== 'review'), { name: 'review', description: 'Mine (user)', argumentHint: '' }];
    const reloaded = [...personal, { name: 'michi:review', description: 'Review a file.', argumentHint: '<file>' }];
    const push = (child: { send: (envelope: object) => void }, commands: unknown[]) =>
      child.send({ type: 'system', subtype: 'commands_changed', session_id: 'ext-steer-1', commands });

    beforeEach(() => {
      fs.rmSync(path.join(skillLibraryRoot(), 'review'), { recursive: true });
      cli.commands = personal;
    });

    test('runs as michi:<name> once the reload\'s table comes before its answer, as CLI 2.1.319 sends it', async () => {
      const { session, child } = await newScriptedSession();
      try {
        await until(() => stateSkills(session).includes('review'), 'the initialize answer');
        let pushed = false;
        cli.onReload = async () => {
          push(child, [...reloaded, { name: 'marker', description: 'Other (user)', argumentHint: '' }]);
          await until(() => stateSkills(session).includes('marker'), 'the reloaded table');
          pushed = true;
        };
        writeLibrarySkill('review');
        notifySkillLibraryChanged();
        await until(() => pushed && !stateSkills(session).includes('michi:review'), 'the reload\'s answer');
        assert.deepEqual(stateSkills(session), ['impeccable', 'plain:plain-skill', 'review', 'marker'], 'the personal review stays');
        const turn = sendTurn(session, 'src/a.ts', { skill: LIBRARY_REVIEW });
        await until(() => child.lines.length === 1, 'the library skill');
        assert.equal(sentText(child, 0), '/michi:review src/a.ts');
        child.init();
        child.result();
        await turn.done;
      } finally { await session.dispose(); }
    });

    test('goes as its text until the reload\'s table comes, however late, and an earlier push changes nothing', async () => {
      const { session, child } = await newScriptedSession();
      try {
        await until(() => stateSkills(session).includes('review'), 'the initialize answer');
        const turn = await runningScriptedTurn(session, child);
        writeLibrarySkill('review');
        notifySkillLibraryChanged();
        // The old table again, with a skill some other change brought, before the CLI reloaded.
        push(child, [...personal, { name: 'marker', description: 'Other (user)', argumentHint: '' }]);
        await until(() => stateSkills(session).includes('marker'), 'the earlier push');
        assert.ok(stateSkills(session).includes('review'), 'the personal review stays');
        child.result();
        await turn.done;
        await until(() => cli.reloads === 1, 'the reload after the turn');
        await new Promise((resolve) => setImmediate(resolve));
        const early = sendTurn(session, 'src/a.ts', { skill: LIBRARY_REVIEW });
        await until(() => child.lines.length === 2, 'the library skill before the reload\'s table');
        assert.equal(sentText(child, 1), `${expandSkillPrompt(LIBRARY_REVIEW, 'src/a.ts')}${SKILL_TURN_NOTE}`, 'not /review, the personal one');
        child.result();
        await early.done;
        push(child, reloaded);
        await until(() => !stateSkills(session).includes('marker'), 'the reloaded table');
        assert.deepEqual(stateSkills(session), ['impeccable', 'plain:plain-skill', 'review']);
        const late = sendTurn(session, 'src/a.ts', { skill: LIBRARY_REVIEW });
        await until(() => child.lines.length === 3, 'the library skill after it');
        assert.equal(sentText(child, 2), '/michi:review src/a.ts');
        child.result();
        await late.done;
      } finally { await session.dispose(); }
    });
  });
});
