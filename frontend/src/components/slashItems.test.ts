import { matchSlashContext, buildSlashItems, buildAgentItems } from './slashItems';
import { buildSlashEntries } from '../state/slashEntries';
import type { AgentCommand, SessionMode } from '../services/api';

describe('buildSlashItems', () => {
  const summary = { description: 'A skill', userInvocable: true, modelInvocable: true, enabled: true };

  it("drops an agent command whose name collides with a local (local wins)", () => {
    const agent: AgentCommand[] = [
      { name: 'branch', description: 'This would shadow /branch' },
      { name: 'kiro-only', description: 'unique' },
    ];
    const items = buildSlashItems(buildSlashEntries({ agentCommands: agent }), '');
    const branches = items.filter((i) => i.name === 'branch');
    expect(branches).toHaveLength(1);
    expect(branches[0].source).toBe('local');
    expect(items.find((i) => i.name === 'kiro-only')?.source).toBe('runtime');
  });

  it('puts exact names first, then commands before skills, each with prefix before substring matches', () => {
    const entries = buildSlashEntries({
      runtimeId: 'claude',
      catalog: { commands: [{ name: 'review' }, { name: 'preview' }, { name: 'reviewers' }], skills: [
        { ...summary, id: 'library:review-pr', name: 'review-pr', origin: 'library' },
        { ...summary, id: 'library:exp', name: 'exp', origin: 'library' },
        { ...summary, id: 'runtime:claude:user:review', name: 'review', origin: 'runtime', runtimeId: 'claude' },
        { ...summary, id: 'runtime:claude:plugin:core:packagebuild', name: 'packagebuild', nativeName: 'core:packagebuild', origin: 'runtime', runtimeId: 'claude' },
      ] },
    });
    expect(buildSlashItems(entries, 'Review').map((item) => [item.name, item.source])).toEqual([
      ['review', 'runtime'], ['review', 'skill'], ['reviewers', 'runtime'], ['preview', 'runtime'], ['review-pr', 'skill'],
    ]);
    expect(buildSlashItems(entries, 'exp').map((item) => item.name)).toEqual(['exp', 'explore']);
    expect(buildSlashItems(entries, 'core:p').map((item) => item.name)).toEqual(['core:packagebuild']);
    expect(buildSlashItems(undefined, 'br').map((item) => item.name)).toEqual(['branch']);
  });
});

describe('matchSlashContext', () => {
  it('matches /agent with trailing space (empty query)', () => {
    expect(matchSlashContext('/agent ', 7)).toEqual({ query: '', command: 'agent' });
  });

  it('keeps the menu open through a qualified name, and closes it at the arguments', () => {
    expect(matchSlashContext('/core:bra', 9)).toEqual({ query: 'core:bra' });
    expect(matchSlashContext('/plugin:skill args', 18)).toBeNull();
  });
});

describe('buildAgentItems', () => {
  const modes: SessionMode[] = [
    { id: 'explorer', name: 'explorer', description: 'Codebase exploration' },
    { id: 'planner', name: 'planner', description: 'Work breakdown' },
    { id: 'reviewer', name: 'reviewer' },
  ];
  const current = 'explorer';

  it('returns [] when availableModes is undefined', () => {
    expect(buildAgentItems(undefined, current, '')).toEqual([]);
  });

  it('maps every available mode to an item with source="agent" and modeId', () => {
    const items = buildAgentItems(modes, current, '');
    expect(items.map((i) => i.name)).toEqual(['explorer', 'planner', 'reviewer']);
    expect(items.every((i) => i.source === 'agent')).toBe(true);
    expect(items.every((i) => i.takesArgs === false)).toBe(true);
    expect(items.find((i) => i.name === 'explorer')?.modeId).toBe('explorer');
  });

  it('filters by query (prefix ranks above substring)', () => {
    const items = buildAgentItems(modes, current, 're');
    const names = items.map((i) => i.name);
    // 'reviewer' prefix-matches; 'explorer' substring-matches.
    expect(names.indexOf('reviewer')).toBeLessThan(names.indexOf('explorer'));
  });
});
