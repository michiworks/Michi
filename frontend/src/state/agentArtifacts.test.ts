import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  ARTIFACT_MANIFEST_MAX, ARTIFACT_TOOLS_FAILURE_TTL_MS, ARTIFACT_TOOLS_PROBE_WAIT_MS, artifactManifestForBackend, backendHasArtifactTools,
  buildArtifactManifest, deletedArtifactId, knownArtifactManifest,
} from './agentArtifacts';
import { reduceProject } from './chatReducers';
import type { ArtifactEntry, Project } from './chatTypes';
import { fetchPersistenceCapabilities, type PersistenceCapabilities } from '../services/api/persistence';

vi.mock('../services/api/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/api/persistence')>(),
  fetchPersistenceCapabilities: vi.fn(),
}));

const probe = vi.mocked(fetchPersistenceCapabilities);

const entry = (id: string, name: string, fields: Partial<ArtifactEntry> = {}): ArtifactEntry => ({
  id, name, filePath: `.contexts/${name}.md`, source: 'agent', createdAt: 1, updatedAt: 1, ...fields,
});

const project = (artifacts: ArtifactEntry[]): Project => ({
  id: 'p1', name: 'demo', cwd: '/tmp/demo', chatIds: [], edges: [], createdAt: 0, trees: [], activeTreeId: null, artifacts,
});

const capabilities = (extra: Partial<PersistenceCapabilities> = {}): PersistenceCapabilities => ({
  protocolVersion: 2, authoritativeTurnPersistence: true, durableNodePrerequisite: true, explicitCommands: true,
  backgroundWorkspaceSync: false, legacySyncAccepted: false, ...extra,
});

const shelf = [
  entry('a', 'old-pin', { pinnedAt: 10, updatedAt: 1 }),
  entry('b', 'plain', { updatedAt: 5 }),
  entry('c', 'site', { filePath: '', url: 'https://example.com', pinnedAt: 30, kind: 'reference' }),
  entry('d', 'other', { updatedAt: 9 }),
];

afterEach(() => {
  probe.mockReset();
  vi.useRealTimers();
});

describe('buildArtifactManifest, backend with the artifact tools', () => {
  it('names only the pinned artifacts, most recently pinned first, and counts them all', () => {
    expect(buildArtifactManifest(shelf, true)).toEqual({
      contextManifest: [
        { name: 'site', filePath: '', url: 'https://example.com', kind: 'reference' },
        { name: 'old-pin', filePath: '.contexts/old-pin.md', url: undefined, kind: undefined },
      ],
      artifactCount: 4,
    });
  });

  it('artifacts but none pinned: only the count; no artifacts: nothing', () => {
    expect(buildArtifactManifest([entry('a', 'plain')], true)).toEqual({ artifactCount: 1 });
    expect(buildArtifactManifest([], true)).toEqual({});
    expect(buildArtifactManifest(undefined, true)).toEqual({});
  });

  it(`keeps at most ${ARTIFACT_MANIFEST_MAX} pinned artifacts however many there are`, () => {
    const many = Array.from({ length: 300 }, (_, i) => entry(`id-${i}`, `pin-${i}`, { pinnedAt: i }));
    const manifest = buildArtifactManifest(many, true);
    expect(manifest.contextManifest).toHaveLength(ARTIFACT_MANIFEST_MAX);
    expect(manifest.contextManifest?.[0].name).toBe('pin-299');
    expect(manifest.artifactCount).toBe(300);
  });
});

describe('buildArtifactManifest, older backend', () => {
  it('lists every artifact, pinned first, then the most recently updated, without artifactCount', () => {
    const manifest = buildArtifactManifest(shelf, false);
    expect(manifest.contextManifest?.map((item) => item.name)).toEqual(['site', 'old-pin', 'other', 'plain']);
    expect(manifest).not.toHaveProperty('artifactCount');
    expect(buildArtifactManifest([], false)).toEqual({});
  });

  it(`sends at most ${ARTIFACT_MANIFEST_MAX}, which such a backend accepts, unpinned included`, () => {
    const many = [
      ...Array.from({ length: 10 }, (_, i) => entry(`pin-${i}`, `pin-${i}`, { pinnedAt: i })),
      ...Array.from({ length: 290 }, (_, i) => entry(`doc-${i}`, `doc-${i}`, { updatedAt: i })),
    ];
    const listed = buildArtifactManifest(many, false).contextManifest!.map((item) => item.name);
    expect(listed).toHaveLength(ARTIFACT_MANIFEST_MAX);
    expect(listed.slice(0, 11)).toEqual([...Array.from({ length: 10 }, (_, i) => `pin-${9 - i}`), 'doc-289']);
  });
});

describe('artifactManifestForBackend', () => {
  it('a backend advertising the tools gets the pinned ones and the count; asked once per connection', async () => {
    probe.mockResolvedValue(capabilities({ artifactTools: 'v1' }));
    expect(await artifactManifestForBackend('remote-new', shelf)).toEqual(buildArtifactManifest(shelf, true));
    expect(await artifactManifestForBackend('remote-new', shelf)).toEqual(buildArtifactManifest(shelf, true));
    expect(probe).toHaveBeenCalledTimes(1);
    // The remote's own capabilities, without reconfiguring this window's stream transport.
    expect(probe).toHaveBeenCalledWith('remote-new', { configureTransport: false });
  });

  it('an older backend, which does not advertise them, gets the full list', async () => {
    probe.mockResolvedValue(capabilities());
    expect(await artifactManifestForBackend('remote-old', shelf)).toEqual(buildArtifactManifest(shelf, false));
    expect(await backendHasArtifactTools('remote-old')).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('a failed probe sends the full list and is asked again next time', async () => {
    probe.mockRejectedValueOnce(new Error('unreachable')).mockResolvedValue(capabilities({ artifactTools: 'v1' }));
    expect(await artifactManifestForBackend('remote-flaky', shelf)).toEqual(buildArtifactManifest(shelf, false));
    expect(await artifactManifestForBackend('remote-flaky', shelf)).toEqual(buildArtifactManifest(shelf, true));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it(`a probe slower than ${ARTIFACT_TOOLS_PROBE_WAIT_MS} ms sends the full list`, async () => {
    vi.useFakeTimers();
    probe.mockReturnValue(new Promise(() => {}));
    const manifest = artifactManifestForBackend('remote-slow', shelf);
    await vi.advanceTimersByTimeAsync(ARTIFACT_TOOLS_PROBE_WAIT_MS);
    expect(await manifest).toEqual(buildArtifactManifest(shelf, false));
  });

  it('asks again once the answer is old: the backend may have been updated', async () => {
    vi.useFakeTimers();
    probe.mockResolvedValueOnce(capabilities()).mockResolvedValue(capabilities({ artifactTools: 'v1' }));
    expect(await backendHasArtifactTools('remote-updated')).toBe(false);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(await backendHasArtifactTools('remote-updated')).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  /** The manifest, and whether it had settled once `ms` of fake time passed. */
  async function sendAfter(connectionId: string, ms: number) {
    let settled = false;
    const manifest = artifactManifestForBackend(connectionId, shelf).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(ms);
    return { settled, manifest };
  }

  it('an old answer is used at once while it is refreshed in the background', async () => {
    vi.useFakeTimers();
    probe.mockResolvedValueOnce(capabilities({ artifactTools: 'v1' }));
    expect(await artifactManifestForBackend('remote-swr', shelf)).toEqual(buildArtifactManifest(shelf, true));
    vi.setSystemTime(Date.now() + 6 * 60_000);
    let answer!: (value: PersistenceCapabilities) => void;
    probe.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    // The refresh has not answered: the send does not wait for it, and uses the old answer.
    const stale = await sendAfter('remote-swr', 1);
    expect(stale.settled).toBe(true);
    expect(await stale.manifest).toEqual(buildArtifactManifest(shelf, true));
    expect(probe).toHaveBeenCalledTimes(2);
    // Once it lands, the next send uses its answer without asking again.
    answer(capabilities());
    await vi.advanceTimersByTimeAsync(0);
    expect(await artifactManifestForBackend('remote-swr', shelf)).toEqual(buildArtifactManifest(shelf, false));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('a refresh that fails keeps the old answer', async () => {
    vi.useFakeTimers();
    probe.mockResolvedValueOnce(capabilities({ artifactTools: 'v1' })).mockRejectedValue(new Error('unreachable'));
    expect(await artifactManifestForBackend('remote-swr-down', shelf)).toEqual(buildArtifactManifest(shelf, true));
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(await (await sendAfter('remote-swr-down', 1)).manifest).toEqual(buildArtifactManifest(shelf, true));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it(`a probe that hung costs one ${ARTIFACT_TOOLS_PROBE_WAIT_MS} ms wait per ${ARTIFACT_TOOLS_FAILURE_TTL_MS / 1000} s, not one per send`, async () => {
    vi.useFakeTimers();
    probe.mockReturnValue(new Promise(() => {}));
    const first = await sendAfter('remote-hung', ARTIFACT_TOOLS_PROBE_WAIT_MS - 1);
    expect(first.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first.manifest).toEqual(buildArtifactManifest(shelf, false));
    // Within the window a send takes the full list at once; the hung probe is not asked again.
    const second = await sendAfter('remote-hung', 1);
    expect(second.settled).toBe(true);
    expect(await second.manifest).toEqual(buildArtifactManifest(shelf, false));
    expect(probe).toHaveBeenCalledTimes(1);
    // After it, one send waits again, for a new probe.
    vi.setSystemTime(Date.now() + ARTIFACT_TOOLS_FAILURE_TTL_MS);
    const third = await sendAfter('remote-hung', 1);
    expect(third.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(ARTIFACT_TOOLS_PROBE_WAIT_MS);
    expect(await third.manifest).toEqual(buildArtifactManifest(shelf, false));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('after a failed probe, sends in the window do not wait for the next one', async () => {
    vi.useFakeTimers();
    probe.mockRejectedValueOnce(new Error('unreachable')).mockReturnValue(new Promise(() => {}));
    expect(await artifactManifestForBackend('remote-refused', shelf)).toEqual(buildArtifactManifest(shelf, false));
    const next = await sendAfter('remote-refused', 1);
    expect(next.settled).toBe(true);
    expect(await next.manifest).toEqual(buildArtifactManifest(shelf, false));
    // It is still asked again, in the background.
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('knownArtifactManifest answers at once only when no probe is needed', async () => {
    vi.useFakeTimers();
    expect(knownArtifactManifest('remote-known', [])).toEqual({});
    expect(knownArtifactManifest('remote-known', undefined)).toEqual({});
    // Never asked: unknown, and asking it does not start a probe.
    expect(knownArtifactManifest('remote-known', shelf)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    probe.mockResolvedValue(capabilities({ artifactTools: 'v1' }));
    await artifactManifestForBackend('remote-known', shelf);
    expect(knownArtifactManifest('remote-known', shelf)).toEqual(buildArtifactManifest(shelf, true));
    // An old answer needs a refresh first.
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(knownArtifactManifest('remote-known', shelf)).toBeUndefined();
  });

  it('a workspace without artifacts needs no probe', async () => {
    expect(await artifactManifestForBackend('local', [])).toEqual({});
    expect(await artifactManifestForBackend('local', undefined)).toEqual({});
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('artifact_deleted: deletedArtifactId + delete-context', () => {
  const remove = (p: Project, deleted: { name: string; contextId?: string }): Project => {
    const id = deletedArtifactId(p.artifacts, deleted);
    return id ? reduceProject(p, { type: 'delete-context', projectId: p.id, contextId: id }) : p;
  };

  it('removes the artifact the event names by id', () => {
    const p = project([entry('ctx-1', 'notes'), entry('ctx-2', 'spec')]);
    expect(remove(p, { name: 'notes', contextId: 'ctx-1' }).artifacts?.map((a) => a.id)).toEqual(['ctx-2']);
  });

  it('with an id, leaves alone another artifact that has the name now', () => {
    const p = project([entry('ctx-new', 'notes')]);
    expect(deletedArtifactId(p.artifacts, { name: 'notes', contextId: 'ctx-gone' })).toBeUndefined();
    expect(remove(p, { name: 'notes', contextId: 'ctx-gone' })).toBe(p);
  });

  it('without an id, by exact name, else by the one name that matches ignoring case', () => {
    const p = project([entry('a', 'Notes'), entry('b', 'notes'), entry('c', 'Spec'), entry('d', 'Plan'), entry('e', 'PLAN')]);
    expect(deletedArtifactId(p.artifacts, { name: 'notes' })).toBe('b');
    expect(deletedArtifactId(p.artifacts, { name: 'SPEC' })).toBe('c');
    expect(deletedArtifactId(p.artifacts, { name: 'plan' })).toBeUndefined();
    expect(deletedArtifactId(p.artifacts, { name: '' })).toBeUndefined();
  });

  it('a replayed event, or one for a workspace hydrated without the artifact, changes nothing', () => {
    const once = remove(project([entry('ctx-1', 'notes')]), { name: 'notes', contextId: 'ctx-1' });
    expect(once.artifacts).toEqual([]);
    expect(remove(once, { name: 'notes', contextId: 'ctx-1' })).toBe(once);
    const empty = project([]);
    expect(remove(empty, { name: 'notes' })).toBe(empty);
  });
});
