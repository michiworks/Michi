import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeSkill } from '../src/contract/types';
import {
  claudeLibraryCommand, claudeLibraryRow, claudeRunsOwnCommand, claudeSkillCommands, parseClaudeSlashCommands, readClaudeSkillLibrary,
  withoutClaudeLibraryRows,
} from '../src/adapters/claude/claudeSkills';
import { claudeSkillListing, listClaudeSkills, probeClaudeSkills } from '../src/adapters/claude/claudeSkillProbe';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-skills-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function skillFile(name: string, description: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody of ${name}.\n`;
}

/** Rows as CLI 2.1.318 reports them: scope suffixes, plugin prefixes and aliases included. */
const TABLE = parseClaudeSlashCommands([
  { name: 'model', description: 'Set the AI model', argumentHint: '[model]', builtin: true },
  { name: 'code-review', description: 'Review the diff', argumentHint: '', builtin: true },
  { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost'], builtin: true },
  { name: 'renamed-skill', description: 'Frontmatter name differs from its folder. (user)', argumentHint: '', aliases: ['folder-a'] },
  { name: 'personal-one', description: 'Personal probe skill. (user)', argumentHint: '<topic>' },
  { name: 'project-one', description: 'Project probe skill. (project)', argumentHint: '' },
  { name: 'legacy-cmd', description: 'A legacy personal command. (user)', argumentHint: 'what' },
  { name: 'exampleplug:example-skill', description: '(exampleplug) An Plugin manager skill.', argumentHint: '', aliases: ['example-skill'] },
  { name: 'plain:plain-skill', description: '(plain) A plain plugin skill.', argumentHint: '', aliases: ['plain-skill'] },
  { name: 'plain:plain-cmd', description: '(plain) A plugin command.', argumentHint: '[x]', aliases: ['plain-cmd'] },
  { name: 'gone:orphan', description: '(gone) From a plugin system/init did not name.', argumentHint: '' },
  { name: 'mcp__srv__summarize', description: 'An MCP prompt', argumentHint: '' },
  { name: 'personal-one', description: 'A second row of the same name', argumentHint: '' },
  { description: 'no name' }, 'not a row',
])!;

describe('Claude command table', () => {
  it('offers every row that is not Claude Code\'s own, MCP prompts as prompts', () => {
    assert.deepEqual(claudeSkillCommands(TABLE).slice(0, 3), [
      { name: 'renamed-skill', description: 'Frontmatter name differs from its folder. (user)', kind: 'skill', aliases: ['folder-a'] },
      { name: 'personal-one', description: 'Personal probe skill. (user)', kind: 'skill', argumentHint: '<topic>' },
      { name: 'project-one', description: 'Project probe skill. (project)', kind: 'skill' },
    ]);
    const kinds = claudeSkillCommands(TABLE).map((command) => [command.name, command.kind]);
    assert.ok(!kinds.some(([name]) => name === 'model' || name === 'code-review' || name === 'usage'));
    assert.deepEqual(kinds.find(([name]) => name === 'mcp__srv__summarize'), ['mcp__srv__summarize', 'prompt']);
    assert.equal(parseClaudeSlashCommands({ commands: [] }), null);
  });

  it('runs a name only as the row of that name, built-in rows first, never through an alias', () => {
    assert.equal(claudeRunsOwnCommand(TABLE, 'personal-one'), true);
    assert.equal(claudeRunsOwnCommand(TABLE, 'plain-skill'), false, 'a plugin skill\'s bare alias');
    assert.equal(claudeRunsOwnCommand(TABLE, 'exampleplug:example-skill'), true);
    assert.equal(claudeRunsOwnCommand(TABLE, 'code-review'), false, 'Claude Code\'s own');
    assert.equal(claudeRunsOwnCommand(TABLE, 'cost'), false, 'an alias of a built-in');
    assert.equal(claudeRunsOwnCommand(TABLE, 'no-such-skill'), false);
    const shadowed = parseClaudeSlashCommands([
      { name: 'review', description: '', argumentHint: '', builtin: true },
      { name: 'review', description: 'Mine', argumentHint: '' },
    ])!;
    assert.equal(claudeRunsOwnCommand(shadowed, 'review'), false, '/review runs the built-in row');
    // A process that loaded a plugin's review but not the personal skill of the same name.
    const pluginOnly = parseClaudeSlashCommands([{ name: 'acme:review', description: '', argumentHint: '', aliases: ['review'] }])!;
    assert.equal(claudeRunsOwnCommand(pluginOnly, 'review'), false, 'the personal review is not the plugin\'s');
    assert.equal(claudeRunsOwnCommand(pluginOnly, 'acme:review'), true);
  });
});

describe('Claude library rows', () => {
  /**
   * CLI 2.1.319 with the library as an additional folder `michi`: `review`
   * and `projclash` clash with a personal and a project skill, `alpha` with
   * nothing, `cmdclash` with a project command it hides, and the
   * `user-invocable: false` `hidden` with a personal skill, which keeps its
   * plain row.
   */
  const table = parseClaudeSlashCommands([
    { name: 'hidden', description: 'Personal hidden. (user)', argumentHint: '' },
    { name: 'review', description: 'Personal review. (user)', argumentHint: '' },
    { name: 'projclash', description: 'Project projclash. (project)', argumentHint: '' },
    { name: 'alpha', description: 'Library alpha. (project)', argumentHint: '' },
    { name: 'cmdclash', description: 'Library cmdclash. (project)', argumentHint: '' },
    { name: 'michi:projclash', description: 'Library projclash. (scoped to michi/) (project)', argumentHint: '' },
    { name: 'michi:review', description: 'Library review. (scoped to michi/) (project)', argumentHint: '' },
  ])!;
  const folder = path.join(root, 'mount', 'michi');
  for (const name of ['alpha', 'review', 'projclash', 'cmdclash']) write(path.join(folder, '.claude', 'skills', name, 'SKILL.md'), skillFile(name, `Library ${name}.`));
  write(path.join(folder, '.claude', 'skills', 'hidden', 'SKILL.md'), skillFile('hidden', 'Library hidden.', 'user-invocable: false\n'));

  it('reads the names of the library skills a person may run, and the folder\'s prefix', async () => {
    const library = await readClaudeSkillLibrary(folder);
    assert.equal(library.prefix, 'michi:');
    assert.deepEqual([...library.names].sort(), ['alpha', 'cmdclash', 'projclash', 'review']);
    assert.deepEqual([...(await readClaudeSkillLibrary(path.join(root, 'missing'))).names], []);
  });

  it('leaves the library\'s rows to the host and runs each skill by the row that is its own', async () => {
    const library = await readClaudeSkillLibrary(folder);
    assert.deepEqual(claudeSkillCommands(withoutClaudeLibraryRows(table, library)).map((command) => command.name), ['hidden', 'review', 'projclash']);
    assert.deepEqual(['alpha', 'review', 'cmdclash', 'hidden'].map((name) => claudeLibraryCommand(table, library, name)),
      ['alpha', 'michi:review', 'cmdclash', null]);
    // The project's cmdclash command lost its row to the library's.
    assert.deepEqual(['cmdclash', 'review', 'hidden', 'alpha'].map((name) => claudeLibraryRow(table, library, name)), [true, false, false, true]);
  });
});

describe('Claude skill listing', () => {
  const configRoot = path.join(root, 'profile');
  const cwd = path.join(root, 'work');
  const examplePlugin = path.join(root, '.example', 'cc-plugins', 'exampleplug');
  const plainPlugin = path.join(root, 'plugins', 'plain');
  write(path.join(configRoot, 'skills', 'personal-one', 'SKILL.md'), skillFile('personal-one', 'Personal probe skill.', 'argument-hint: <topic>\n'));
  write(path.join(configRoot, 'skills', 'folder-a', 'SKILL.md'), skillFile('renamed-skill', 'Frontmatter name differs from its folder.'));
  write(path.join(configRoot, 'skills', 'model-only', 'SKILL.md'), skillFile('model-only', 'Only the model loads it.', 'user-invocable: false\n'));
  write(path.join(configRoot, 'commands', 'legacy-cmd.md'), '---\ndescription: A legacy personal command.\n---\nDo it.\n');
  write(path.join(cwd, '.claude', 'skills', 'project-one', 'SKILL.md'), skillFile('project-one', 'Project probe skill.', 'disable-model-invocation: true\n'));
  write(path.join(examplePlugin, 'skills', 'example-skill', 'SKILL.md'), skillFile('example-skill', 'An Plugin manager skill.'));
  write(path.join(examplePlugin, 'skills', 'example-hidden', 'SKILL.md'), skillFile('example-hidden', 'Plugin manager, model only.', 'user-invocable: false\n'));
  write(path.join(plainPlugin, 'skills', 'plain-skill', 'SKILL.md'), skillFile('plain-skill', 'A plain plugin skill.'));
  write(path.join(plainPlugin, 'commands', 'plain-cmd.md'), 'Run the plain command.\n');

  const view = (skill: RuntimeSkill) => [skill.name, skill.nativeName ?? null, skill.scope, skill.path ? path.relative(root, skill.path) : null,
    skill.managedBy ?? null, skill.userInvocable ?? null, skill.pluginId ?? null];

  it('maps the command table to skills with their files, plugins and model-only skills', async () => {
    const listing = await claudeSkillListing({
      commands: TABLE,
      plugins: [
        { name: 'exampleplug', path: examplePlugin, source: 'exampleplug@example' }, { name: 'plain', path: plainPlugin, source: 'plain@market' },
        { name: 'cc-plugin-privacy', path: 'builtin', source: 'cc-plugin-privacy@builtin' },
      ],
      pluginErrors: ['Claude plugin broken@market: Plugin broken not found in marketplace market'],
    }, { cwd, configRoot });
    assert.deepEqual(listing.skills.map(view), [
      ['renamed-skill', null, 'user', 'profile/skills/folder-a/SKILL.md', null, true, null],
      ['personal-one', null, 'user', 'profile/skills/personal-one/SKILL.md', null, true, null],
      ['project-one', null, 'project', 'work/.claude/skills/project-one/SKILL.md', null, true, null],
      ['legacy-cmd', null, 'command', 'profile/commands/legacy-cmd.md', null, null, null],
      ['example-skill', 'exampleplug:example-skill', 'plugin', '.example/cc-plugins/exampleplug/skills/example-skill/SKILL.md', 'Claude plugin', true, 'exampleplug@example'],
      ['plain-skill', 'plain:plain-skill', 'plugin', 'plugins/plain/skills/plain-skill/SKILL.md', 'Claude plugin', true, 'plain@market'],
      ['plain-cmd', 'plain:plain-cmd', 'plugin', 'plugins/plain/commands/plain-cmd.md', 'Claude plugin', null, 'plain@market'],
      ['orphan', 'gone:orphan', 'plugin', null, 'Claude plugin', null, 'gone'],
      ['model-only', null, 'user', 'profile/skills/model-only/SKILL.md', null, false, null],
      ['example-hidden', 'exampleplug:example-hidden', 'plugin', '.example/cc-plugins/exampleplug/skills/example-hidden/SKILL.md', 'Claude plugin', false, 'exampleplug@example'],
    ]);
    const byName = new Map(listing.skills.map((skill) => [skill.name, skill]));
    assert.equal(byName.get('personal-one')?.argumentHint, '<topic>');
    assert.equal(byName.get('personal-one')?.description, 'Personal probe skill.');
    assert.equal(byName.get('project-one')?.modelInvocable, false);
    assert.equal(byName.get('legacy-cmd')?.description, 'A legacy personal command.', 'without the CLI\'s scope suffix');
    assert.equal(byName.get('plain-cmd')?.description, 'A plugin command.', 'without the CLI\'s plugin prefix');
    assert.equal(byName.get('plain-cmd')?.argumentHint, '[x]');
    assert.deepEqual(listing.errors, ['Claude plugin broken@market: Plugin broken not found in marketplace market']);
  });

  it('lists plugin skills without paths when system/init did not say where plugins loaded from', async () => {
    const listing = await claudeSkillListing({ commands: TABLE }, { cwd, configRoot });
    const example = listing.skills.find((skill) => skill.nativeName === 'exampleplug:example-skill');
    assert.deepEqual(example && view(example), ['example-skill', 'exampleplug:example-skill', 'plugin', null, 'Claude plugin', null, 'exampleplug']);
  });

  it('fails, rather than list only some folders, when the CLI does not answer', async () => {
    await assert.rejects(listClaudeSkills({ spawnEnv: () => ({}), binaryPath: () => undefined }, { cwd, configDir: configRoot },
      async () => { throw new Error('claude skill probe timed out after 20000ms'); }), /timed out after 20000ms/);
  });
});

describe('Claude skill probe', () => {
  const env = (): NodeJS.ProcessEnv => ({ ANTHROPIC_API_KEY: 'test-key', PATH: '/bin' });
  const config = { spawnEnv: env, binaryPath: () => process.execPath };

  /** A fake SDK: initialize answers `answer`; each input message gets `frames`, then the probe's turn ends. */
  function fakeSdk(answer: unknown, frames: Array<Record<string, unknown>>, initialize?: () => Promise<unknown>) {
    const seen = { options: undefined as Record<string, any> | undefined, sent: [] as Array<Record<string, any>>, closed: false };
    const query = ({ prompt, options }: { prompt: AsyncIterable<Record<string, any>>; options: Record<string, any> }) => {
      seen.options = options;
      const output: Array<Record<string, unknown>> = [];
      let wake: (() => void) | undefined;
      void (async () => {
        for await (const message of prompt) { seen.sent.push(message); output.push(...frames, { type: 'result', subtype: 'success' }); wake?.(); }
      })();
      return {
        initializationResult: initialize ?? (async () => answer),
        close: () => { seen.closed = true; wake?.(); },
        async *[Symbol.asyncIterator]() {
          while (!seen.closed) {
            if (!output.length) await new Promise<void>((resolve) => { wake = resolve; });
            while (output.length) yield output.shift()!;
          }
        },
      };
    };
    return { sdk: { query: query as any }, seen };
  }

  it('starts the CLI as a chat would, without hooks, MCP servers, the library or a model call, and always closes', async () => {
    const { sdk, seen } = fakeSdk({ commands: [{ name: 'personal-one', description: 'Mine', argumentHint: '' }] }, [
      { type: 'system', subtype: 'init', plugins: [{ name: 'plain', path: '/plugins/plain', source: 'plain@market' }],
        plugin_errors: [{ plugin: 'broken@market', type: 'generic-error', message: 'failed' }] },
    ]);
    const result = await probeClaudeSkills(config, { cwd: '/work', configDir: '/profile', sdk });
    assert.deepEqual(result, {
      commands: [{ name: 'personal-one', description: 'Mine', argumentHint: '' }],
      plugins: [{ name: 'plain', path: '/plugins/plain', source: 'plain@market' }],
      pluginErrors: ['Claude plugin broken@market: failed'],
    });
    const options = seen.options!;
    assert.equal(options.cwd, '/work');
    assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
    assert.deepEqual(options.settings, { disableAllHooks: true });
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.strictMcpConfig, true);
    assert.equal(options.persistSession, false);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, '/profile');
    assert.equal(options.additionalDirectories, undefined, 'the host lists its own library');
    assert.equal(options.extraArgs, undefined, 'bare would hide personal and project skills');
    assert.equal(seen.sent.length, 1);
    assert.equal(seen.sent[0].shouldQuery, false, 'system/init without a model call');
    assert.ok(seen.closed);
  });

  it('keeps the command table when system/init does not come, and closes on an initialize timeout', async () => {
    const quiet = fakeSdk({ commands: [] }, []);
    assert.deepEqual(await probeClaudeSkills(config, { cwd: '/work', sdk: quiet.sdk }), { commands: [] });
    const stuck = fakeSdk(undefined, [], () => new Promise(() => {}));
    await assert.rejects(probeClaudeSkills(config, { cwd: '/work', timeoutMs: 20, sdk: stuck.sdk }), /timed out after 20ms/);
    assert.ok(stuck.seen.closed);
  });
});
