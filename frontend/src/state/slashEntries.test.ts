import { describe, expect, it } from 'vitest';
import type { AgentCommand, SkillSummary } from 'michi-shared';
import { buildSlashEntries, liveSlashCommands, pickedSlashEntry, recordedSlashSkill, resolveSlashRun, type SlashSkillCatalog } from './slashEntries';

function skill(overrides: Partial<SkillSummary> & Pick<SkillSummary, 'id' | 'name' | 'origin'>): SkillSummary {
  return { description: `${overrides.name} skill`, userInvocable: true, modelInvocable: true, enabled: true, ...overrides };
}

const library = (name: string, extra: Partial<SkillSummary> = {}) => skill({ id: `library:${name}`, name, origin: 'library', ...extra });
const builtin = (name: string, extra: Partial<SkillSummary> = {}) =>
  skill({ id: `builtin:${name}`, name, origin: 'builtin', managedBy: 'Michi', modelInvocable: false, ...extra });
const claudeSkill = (name: string, extra: Partial<SkillSummary> = {}) =>
  skill({ id: `runtime:claude:user:${extra.nativeName ?? name}`, name, origin: 'runtime', runtimeId: 'claude', scope: 'user', ...extra });
const catalog = (skills: SkillSummary[], commands: AgentCommand[] = []): SlashSkillCatalog => ({ skills, commands });
const rows = (entries: { name: string; source: string; tag?: string }[]) => entries.map((entry) => [entry.name, entry.source, entry.tag]);
const LOCAL = ['agent', 'branch', 'btw', 'fanout', 'fan-out', 'explore', 'compact'];

describe('buildSlashEntries', () => {
  it('lists Michi\'s commands, the catalog\'s and the session\'s commands, then library and runtime skills', () => {
    const entries = buildSlashEntries({
      runtimeId: 'claude',
      runtimeLabel: 'Claude Code',
      agentCommands: [{ name: 'status', kind: 'command' }, { name: 'model', kind: 'command', description: 'Switch the model' }, { name: 'doctor' }, { name: 'compact', description: 'Theirs' }],
      catalog: catalog([claudeSkill('build-package', { nativeName: 'core:build-package', argumentHint: '<package>' }), library('review')],
        [{ name: 'status', description: 'Show status' }, { name: 'model', argumentHint: '<model>' }]),
    });
    expect(entries.map((entry) => entry.name)).toEqual([...LOCAL, 'status', 'model', 'doctor', 'review', 'core:build-package']);
    expect(entries.find((entry) => entry.name === 'compact')).toMatchObject({ source: 'local', runsCommand: true, description: expect.stringMatching(/^Summarize/) });
    // The session's command fills in what the catalog's of the same name lacks.
    expect(entries.find((entry) => entry.name === 'model')).toMatchObject({
      source: 'runtime', runsCommand: true, takesArgs: true, hint: '<model>', description: 'Switch the model',
    });
    expect(entries.find((entry) => entry.name === 'review')).toMatchObject({
      source: 'skill', sourceLabel: 'Michi', takesArgs: true, skill: { id: 'library:review', name: 'review', origin: 'library' },
    });
    expect(entries.find((entry) => entry.name === 'core:build-package')).toMatchObject({
      sourceLabel: 'Claude Code', hint: '<package>',
      skill: { id: 'runtime:claude:user:core:build-package', name: 'build-package', origin: 'runtime', runtimeId: 'claude' },
    });
    expect(entries.every((entry) => !entry.tag)).toBe(true);
  });

  it('lists a command and skills that share a name, tagging the skills', () => {
    const entries = buildSlashEntries({
      runtimeId: 'kiro',
      runtimeLabel: 'Kiro',
      catalog: catalog([library('context'), skill({ id: 'runtime:kiro:user:context', name: 'context', origin: 'runtime', runtimeId: 'kiro' }),
        library('deploy'), skill({ id: 'runtime:kiro:user:deploy', name: 'deploy', origin: 'runtime', runtimeId: 'kiro' }),
        library('notes')], [{ name: 'context' }]),
    });
    expect(rows(entries.filter((entry) => entry.source !== 'local'))).toEqual([
      ['context', 'runtime', undefined],
      ['context', 'skill', 'Michi'],
      ['deploy', 'skill', 'Michi'],
      ['notes', 'skill', undefined],
      ['context', 'skill', 'Kiro'],
      ['deploy', 'skill', 'Kiro'],
    ]);
    const lone = buildSlashEntries({ runtimeId: 'kiro', catalog: catalog([library('context')], [{ name: 'context' }]) });
    expect(rows(lone.filter((entry) => entry.name === 'context'))).toEqual([['context', 'runtime', undefined], ['context', 'skill', 'Skill']]);
  });

  it('lists Michi\'s built-in skills after the library\'s and before the runtime\'s, each tagged where they share a name; one turned off is left out', () => {
    const entries = buildSlashEntries({
      runtimeId: 'claude',
      runtimeLabel: 'Claude',
      catalog: catalog([claudeSkill('compare'), builtin('compare', { argumentHint: '<question>' }), library('compare'), builtin('off', { enabled: false })]),
    });
    expect(rows(entries.filter((entry) => entry.source !== 'local'))).toEqual([
      ['compare', 'skill', 'Michi'],
      ['compare', 'skill', 'Built-in'],
      ['compare', 'skill', 'Claude'],
    ]);
    expect(entries.find((entry) => entry.skill?.origin === 'builtin')).toMatchObject({
      sourceLabel: 'Built-in', hint: '<question>', skill: { id: 'builtin:compare', name: 'compare', origin: 'builtin' },
    });
    expect(entries.find((entry) => entry.skill?.origin === 'builtin')?.skill).not.toHaveProperty('runtimeId');
    // Typed without a pick, the library's runs; the built-in one runs from its own row.
    expect(resolveSlashRun('/compare queues', entries)).toMatchObject({ kind: 'skill', skill: { id: 'library:compare' } });
    const row = entries.find((entry) => entry.skill?.id === 'builtin:compare');
    expect(resolveSlashRun('/compare queues', entries, row)).toMatchObject({ kind: 'skill', skill: { id: 'builtin:compare' }, args: 'queues' });
    const alone = buildSlashEntries({ runtimeId: 'claude', catalog: catalog([builtin('compare')]) });
    expect(resolveSlashRun('/compare', alone)).toMatchObject({ kind: 'skill', skill: { id: 'builtin:compare' }, args: '' });
  });

  it('adds the live skill commands the catalog lacks, but not prompts', () => {
    const agentCommands: AgentCommand[] = [
      { name: 'core:build-package', kind: 'skill', aliases: ['build-package'] },
      { name: 'power-skill', kind: 'skill', description: 'From a power the listing does not scan', input: { hint: 'topic' } },
      { name: 'standup', kind: 'prompt', argumentHint: '[team]' },
    ];
    const entries = buildSlashEntries({ runtimeId: 'claude', agentCommands, catalog: catalog([library('review'), claudeSkill('build-package', { nativeName: 'core:build-package' })]) });
    expect(entries.filter((entry) => entry.source !== 'local').map((entry) => entry.name)).toEqual(['review', 'core:build-package', 'power-skill']);
    expect(entries.find((entry) => entry.name === 'power-skill')).toMatchObject({
      hint: 'topic', skill: { id: 'live:claude:power-skill', name: 'power-skill', origin: 'runtime', runtimeId: 'claude' },
    });
    // Before the catalog answers, the session's skills fill in.
    expect(buildSlashEntries({ runtimeId: 'claude', agentCommands, catalog: catalog([]) })
      .filter((entry) => entry.source === 'skill').map((entry) => entry.name)).toEqual(['core:build-package', 'power-skill']);
  });

  it('offers only the runtime skills a person may run, keeps their live commands out, and lists a live skill named like a library one', () => {
    const agentCommands: AgentCommand[] = [
      { name: 'internal-only', kind: 'skill' }, { name: 'switched-off', kind: 'skill' }, { name: 'review', kind: 'skill' },
    ];
    const entries = buildSlashEntries({ runtimeId: 'kiro', runtimeLabel: 'Kiro', agentCommands, catalog: catalog([
      library('review'),
      skill({ id: 'runtime:kiro:workspace:internal-only', name: 'internal-only', origin: 'runtime', runtimeId: 'kiro', userInvocable: false }),
      skill({ id: 'runtime:kiro:user:switched-off', name: 'switched-off', origin: 'runtime', runtimeId: 'kiro', enabled: false }),
    ]) });
    expect(rows(entries.filter((entry) => entry.source === 'skill'))).toEqual([['review', 'skill', 'Michi'], ['review', 'skill', 'Kiro']]);
    expect(resolveSlashRun('/internal-only', entries)).toBeNull();
    expect(resolveSlashRun('/review', entries)).toMatchObject({ skill: { id: 'library:review' } });
  });

  it('runs only the commands the backend says the runtime runs, and sends what else a session lists as text', () => {
    const entries = buildSlashEntries({ runtimeId: 'antigravity',
      agentCommands: [{ name: 'doctor' }, { name: 'status', kind: 'command' }, { name: 'tools' }],
      catalog: catalog([], [{ name: 'tools' }]) });
    expect(entries.filter((entry) => entry.source === 'runtime').map((entry) => entry.name)).toEqual(['tools', 'doctor', 'status']);
    expect(resolveSlashRun('/doctor', entries)).toBeNull();
    expect(resolveSlashRun('/status', entries)).toEqual({ kind: 'command', name: 'status' });
    expect(resolveSlashRun('/tools', entries)).toEqual({ kind: 'command', name: 'tools' });
  });

  it('lets a session that names its commands drop the catalog commands it does not run', () => {
    const entries = buildSlashEntries({ runtimeId: 'kiro',
      agentCommands: [{ name: 'context', kind: 'command' }, { name: 'tools', kind: 'command' }],
      catalog: catalog([], [{ name: 'context', description: 'Show the context' }, { name: 'history' }, { name: 'tools' }]) });
    expect(entries.filter((entry) => entry.source === 'runtime').map((entry) => [entry.name, entry.description])).toEqual([['context', 'Show the context'], ['tools', undefined]]);
    expect(resolveSlashRun('/history', entries)).toBeNull();
  });

  it('offers no skills where the chat runs none, and drops names a slash cannot carry', () => {
    const agentCommands: AgentCommand[] = [{ name: 'tools' }, { name: 'deploy', kind: 'skill' }];
    expect(buildSlashEntries({ runtimeId: 'kiro', agentCommands }).map((entry) => entry.name)).toEqual([...LOCAL, 'tools']);
    // The assistant's chats: the catalog's commands, no skills.
    expect(buildSlashEntries({ runtimeId: 'kiro', agentCommands, skills: false, catalog: catalog([library('review')], [{ name: 'usage' }]) })
      .map((entry) => entry.name)).toEqual([...LOCAL, 'usage', 'tools']);
    const entries = buildSlashEntries({ runtimeId: 'pi', catalog: catalog([skill({ id: 'runtime:pi:example:Write Docs', name: 'Write Docs', origin: 'runtime', runtimeId: 'pi' })]) });
    expect(entries.filter((entry) => entry.source === 'skill')).toEqual([]);
  });
});

describe('liveSlashCommands', () => {
  it('drops the commands of a session on another runtime than the next message', () => {
    const commands: AgentCommand[] = [{ name: 'tools' }];
    const node = { agentCommands: commands, runtimeId: 'kiro', sessionState: { runtimeId: 'kiro' } };
    expect(liveSlashCommands(node, 'kiro')).toBe(commands);
    expect(liveSlashCommands(node, 'claude')).toBeUndefined();
    expect(liveSlashCommands({ agentCommands: commands }, 'claude')).toBe(commands);
  });
});

describe('resolveSlashRun', () => {
  const entries = buildSlashEntries({
    runtimeId: 'kiro',
    catalog: catalog([library('review'), library('context'), skill({ id: 'runtime:kiro:user:plan', name: 'plan', origin: 'runtime', runtimeId: 'kiro' }),
      skill({ id: 'runtime:kiro:user:review', name: 'review', origin: 'runtime', runtimeId: 'kiro' })], [{ name: 'context', input: {} }]),
  });

  it('runs a skill with its arguments, multi-line and empty ones included, the library\'s before the runtime\'s', () => {
    expect(resolveSlashRun('/review src/app.ts  ', entries)).toEqual({ kind: 'skill', skill: expect.objectContaining({ id: 'library:review' }), args: 'src/app.ts' });
    expect(resolveSlashRun('/Review\nfirst\nsecond', entries)).toMatchObject({ kind: 'skill', args: 'first\nsecond' });
    expect(resolveSlashRun('/plan', entries)).toEqual({ kind: 'skill', skill: expect.objectContaining({ id: 'runtime:kiro:user:plan' }), args: '' });
  });

  it('runs the command where a command and a skill share the name, unless the skill row was picked', () => {
    expect(resolveSlashRun('/context why', entries)).toEqual({ kind: 'command', name: 'context', value: 'why' });
    expect(resolveSlashRun('/compact', entries)).toEqual({ kind: 'command', name: 'compact' });
    const contextSkill = entries.find((entry) => entry.skill?.id === 'library:context');
    expect(resolveSlashRun('/context why', entries, contextSkill)).toMatchObject({ kind: 'skill', skill: { id: 'library:context' }, args: 'why' });
    const runtimeReview = entries.find((entry) => entry.skill?.id === 'runtime:kiro:user:review');
    expect(resolveSlashRun('/review 12', entries, runtimeReview)).toMatchObject({ kind: 'skill', skill: { id: 'runtime:kiro:user:review' } });
    // Once the text no longer starts with the picked row's `/name`, the name decides.
    expect(resolveSlashRun('/Context why', entries, contextSkill)).toEqual({ kind: 'command', name: 'context', value: 'why' });
  });

  it('sends Michi\'s pane commands, unknown names, prose and a command with more lines as messages', () => {
    for (const text of ['/branch review this', '/unknown', '/tmp/review', 'please /review this', '/review-x', '/context\nexplain this']) {
      expect(resolveSlashRun(text, entries)).toBeNull();
    }
  });

  it('honours a pick only on the runtime whose menu offered it', () => {
    const entry = entries[0];
    expect(pickedSlashEntry({ entry, runtimeId: 'kiro' }, 'kiro')).toBe(entry);
    expect(pickedSlashEntry({ entry, runtimeId: 'kiro' }, 'claude')).toBeUndefined();
  });
});

describe('recordedSlashSkill', () => {
  it('runs the skill a message ran by its id, with the arguments its text has now', () => {
    const power = { id: 'live:kiro:power-skill', name: 'power-skill', origin: 'runtime' as const, runtimeId: 'kiro', args: 'old' };
    expect(recordedSlashSkill(power, '/power-skill now')).toEqual({
      kind: 'skill', skill: { id: 'live:kiro:power-skill', name: 'power-skill', origin: 'runtime', runtimeId: 'kiro' }, args: 'now',
    });
    expect(recordedSlashSkill(undefined, '/review 123')).toBeNull();
  });
});
