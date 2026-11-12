import { describe, expect, it } from 'vitest';
import { reduceProject } from './chatReducers';
import type { ArtifactEntry, Project } from './chatTypes';

const artifact = (id: string, name: string, extra: Partial<ArtifactEntry> = {}): ArtifactEntry => ({
  id, name, filePath: `.contexts/${name}.md`, source: 'agent', kind: 'embedded', createdAt: 1, updatedAt: 1, ...extra,
});

const project = (...artifacts: ArtifactEntry[]): Project => ({
  id: 'p1', name: 'demo', chatIds: [], edges: [], createdAt: 0, trees: [], activeTreeId: null, artifacts,
});

/** What chatStore's onArtifactSaved / onArtifactUpdated dispatch for a report from the backend. */
const saved = (p: Project, id: string | undefined, name: string, size = 3) => reduceProject(p, {
  type: 'upsert-context', projectId: 'p1',
  context: { id, name, filePath: `.contexts/${name}.md`, size, type: 'doc', kind: 'embedded', source: 'agent' },
});
const updated = (p: Project, id: string | undefined, name: string, size = 3) => reduceProject(p, {
  type: 'update-context-by-name', projectId: 'p1',
  context: { id, name, filePath: `.contexts/${name}.md`, size, type: 'doc', kind: 'embedded', source: 'agent' },
});
const rows = (p: Project) => (p.artifacts ?? []).map((entry) => [entry.id, entry.name, entry.size ?? null]);

describe('an artifact the backend reports is matched by its id, never another one by name', () => {
  it('a replayed save of a deleted artifact leaves the live one now holding its name alone', () => {
    // A ("foo") was deleted, then C saved as "foo"; a reconnect replays A's save.
    const live = project(artifact('ctx-c', 'foo', { size: 9, pinnedAt: 4 }));
    expect(saved(live, 'ctx-a', 'foo')).toBe(live);
    expect(updated(live, 'ctx-a', 'foo')).toBe(live);
  });

  it('a report of an artifact this window holds updates that one, whatever another is named', () => {
    const p = project(artifact('ctx-c', 'foo'), artifact('ctx-d', 'bar'));
    // A save of the same name keeps its id (upsertAgentContextMetadata): an update in place.
    expect(rows(saved(p, 'ctx-d', 'bar', 7))).toEqual([['ctx-c', 'foo', null], ['ctx-d', 'bar', 7]]);
    // Renamed to a name this window still shows on another: that one is not rewritten.
    expect(rows(saved(p, 'ctx-d', 'foo', 7))).toEqual([['ctx-c', 'foo', null], ['ctx-d', 'foo', 7]]);
    expect(rows(updated(p, 'ctx-d', 'foo', 7))).toEqual([['ctx-c', 'foo', null], ['ctx-d', 'foo', 7]]);
  });

  it('a new artifact under a name differing only in case is another one: added as reported, its name not suffixed', () => {
    const p = project(artifact('ctx-c', 'notes'));
    expect(rows(saved(p, 'ctx-x', 'Notes'))).toEqual([['ctx-c', 'notes', null], ['ctx-x', 'Notes', 3]]);
    expect(rows(updated(p, 'ctx-x', 'Notes'))).toEqual([['ctx-c', 'notes', null], ['ctx-x', 'Notes', 3]]);
    // And one under a free name is added as before.
    expect(rows(saved(p, 'ctx-y', 'plan'))).toEqual([['ctx-c', 'notes', null], ['ctx-y', 'plan', 3]]);
  });

  it("an older backend's report, without an id, still finds its artifact by name", () => {
    const p = project(artifact('ctx-c', 'Foo'));
    expect(rows(updated(p, undefined, 'foo', 5))).toEqual([['ctx-c', 'foo', 5]]);
  });

  it("a window's own new artifact takes the id it was given (newId) and still a free name", () => {
    const p = project(artifact('ctx-c', 'notes'));
    const made = reduceProject(p, {
      type: 'upsert-context', projectId: 'p1', newId: 'ctx-new',
      context: { name: 'Notes', filePath: 'notes.md', source: 'user' },
    });
    expect(rows(made)).toEqual([['ctx-c', 'notes', null], ['ctx-new', 'Notes-2', null]]);
  });
});
