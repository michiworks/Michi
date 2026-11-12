import { describe, expect, it } from 'vitest';
import { isSystemWorkspaceSettings } from 'michi-shared';
import type { Project } from '../chatTypes';
import { hydrateBackendWorkspaces } from '../chatHydration';
import { durableNodePrerequisite, serializeWorkspaceRow } from '../workspacePersistence';
import { sortLiveProjects } from '../sidebarSelectors';
import {
  firstLiveUserWorkspaceId, isLiveUserWorkspace, isSystemWorkspace, systemWorkspaceIds, withoutSystemWorkspaces,
} from './systemWorkspace';

function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id, chatIds: [], edges: [], createdAt: 1, trees: [], activeTreeId: null, ...extra };
}

function rawWorkspace(id: string, settings: unknown) {
  return {
    workspace: { id, name: id, created_at: 1, settings: settings === null ? null : JSON.stringify(settings) },
    trees: [{ id: `t-${id}`, root_node_id: `n-${id}`, last_active_at: 1 }],
    nodes: [{ id: `n-${id}`, created_at: 1 }],
    edges: [],
    messages: [],
  };
}

describe('system workspaces', () => {
  it('reads the flag from settings as the backend does', () => {
    const settings = [{ system: 'assistant' }, { system: '' }, { system: true }, { system: null }, { aiGlobalContext: false }, null];
    const state = hydrateBackendWorkspaces(settings.map((value, i) => rawWorkspace(`w${i}`, value)));
    expect(state.projects.find((p) => p.id === 'w0')?.system).toBe('assistant');
    for (const [i, value] of settings.entries()) {
      const hydrated = state.projects.find((p) => p.id === `w${i}`);
      expect(isSystemWorkspace(hydrated), JSON.stringify(value)).toBe(isSystemWorkspaceSettings(value === null ? null : JSON.stringify(value)));
    }
  });

  it('filters lists and returns the same array when there is none', () => {
    const user = [project('a'), project('b')];
    expect(withoutSystemWorkspaces(user)).toBe(user);
    const mixed = [project('a'), project('s', { system: 'assistant' })];
    expect(withoutSystemWorkspaces(mixed).map((p) => p.id)).toEqual(['a']);
    expect([...systemWorkspaceIds(mixed)]).toEqual(['s']);
    expect(isSystemWorkspace(mixed[1])).toBe(true);
  });

  it('hydrates the flag and never opens the system workspace on load', () => {
    const state = hydrateBackendWorkspaces([rawWorkspace('s', { system: 'assistant' }), rawWorkspace('a', null)]);
    expect(state.projects.find((p) => p.id === 's')?.system).toBe('assistant');
    expect(state.projects.find((p) => p.id === 'a')?.system).toBeUndefined();
    expect(state.activeProjectId).toBe('a');
    expect(hydrateBackendWorkspaces([rawWorkspace('s', { system: 'assistant' })], 's').activeProjectId).toBeNull();
  });

  it('keeps the flag when the workspace row is written back', () => {
    const row = serializeWorkspaceRow(project('s', { system: 'assistant', instructions: 'x' }));
    expect(JSON.parse(row.settings!)).toEqual({ instructions: 'x', system: 'assistant' });
    expect(serializeWorkspaceRow(project('a')).settings).toBeNull();
    const node = { nodeId: 'n', projectId: 's', messages: [], followUps: [] } as never;
    const prerequisite = durableNodePrerequisite(project('s', { system: 'assistant', chatIds: ['n'] }), { n: node }, node);
    expect((prerequisite.workspace as { settings: unknown }).settings).toEqual({ system: 'assistant' });
  });

  it('takes only a user workspace that is neither trashed nor archived as live', () => {
    const trashed = project('t', { deletedAt: 2 });
    const archived = project('r', { archivedAt: 2 });
    const system = project('s', { system: 'assistant' });
    expect([trashed, archived, system, undefined, null].some(isLiveUserWorkspace)).toBe(false);
    expect(isLiveUserWorkspace(project('a'))).toBe(true);
    expect(firstLiveUserWorkspaceId([trashed, archived, system, project('a'), project('b')])).toBe('a');
    expect(firstLiveUserWorkspaceId([project('a'), project('b')], 'a')).toBe('b');
    expect(firstLiveUserWorkspaceId([trashed, system])).toBeNull();
  });

  it('is not listed in the sidebar', () => {
    const projects = [project('a'), project('s', { system: 'assistant', createdAt: 9 })];
    expect(sortLiveProjects(projects, []).map((p) => p.id)).toEqual(['a']);
  });
});
