import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyWorkspaceCommands, fetchAllWorkspacesMeta, fetchNodeWorkspace, fetchPersistenceCapabilities, fetchTreeMessages, fetchTreeMessagePage,
  supportsArtifactWriteAnswers, supportsPaneInspection, workspacesFromMetaBody,
} from './persistence';
import { RemoteServiceRecoveryError } from './remoteRecovery';
import { fetchStream } from './streamTransport';
import { backendEntityId } from '../../config/backendIdentity';

describe('remote history pages', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('scopes node references and forwards opaque message cursors', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [{ id: 'm1', node_id: 'n1' }], pages: [{ nodeId: 'n1', total: 70, before: { seq: 20, id: 'm1' } }],
    })));
    vi.stubGlobal('fetch', fetch);
    const result = await fetchTreeMessagePage(backendEntityId('r', 'ws'), backendEntityId('r', 'tree'), 'r', undefined,
      { nodeId: backendEntityId('r', 'n1'), before: { seq: 30, id: 'm&30' } });
    const url = new URL(fetch.mock.calls[0][0], 'http://localhost');
    expect(url.pathname).toContain('/workspaces/ws/trees/tree/messages');
    expect(url.searchParams.get('nodeId')).toBe('n1');
    expect(url.searchParams.get('beforeId')).toBe('m&30');
    expect(result.pages?.[0].nodeId).toBe(backendEntityId('r', 'n1'));
    expect(result.pages?.[0].before?.id).toBe('m1');
  });
  it('accepts full history from older gateways and rejects malformed pagination', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [], pages: [{ nodeId: 'n', total: 1 }] })));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchTreeMessagePage('ws', 'tree')).toEqual({ messages: [] });
    await expect(fetchTreeMessagePage('ws', 'tree')).rejects.toThrow('Invalid message page');
  });
  it('asks the connection that owns a node where it lives, in that connection’s scope', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaceId: 'ws', treeId: 'tree' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchNodeWorkspace(backendEntityId('r', 'n1'))).toEqual({
      workspaceId: backendEntityId('r', 'ws'), treeId: backendEntityId('r', 'tree'),
    });
    expect(new URL(fetch.mock.calls[0][0], 'http://localhost').pathname)
      .toMatch(/\/backend-connections\/r\/proxy\/nodes\/n1\/workspace$/);
    expect(await fetchNodeWorkspace('local-node')).toBeNull();
    expect(new URL(fetch.mock.calls[1][0], 'http://localhost').pathname).not.toContain('backend-connections');
  });
});

describe('fetchPersistenceCapabilities — paneInspection field', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({
      protocolVersion: 2,
      authoritativeTurnPersistence: true,
      durableNodePrerequisite: true,
      explicitCommands: true,
      backgroundWorkspaceSync: false,
      legacySyncAccepted: false,
      streamTransport: 'websocket-v1',
      paneInspection: 'v1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skipped artifact writes are answered only by a backend that says v1; an older one says nothing', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ protocolVersion: 2, artifactWriteAnswers: 'v1' })));
    expect(supportsArtifactWriteAnswers(await fetchPersistenceCapabilities('local', { configureTransport: false }))).toBe(true);
    // The default response here is an older backend's: no field.
    expect(supportsArtifactWriteAnswers(await fetchPersistenceCapabilities('local', { configureTransport: false }))).toBe(false);
    for (const value of [true, 'v2', 1, null, {}]) expect(supportsArtifactWriteAnswers({ artifactWriteAnswers: value })).toBe(false);
    expect(supportsArtifactWriteAnswers(null)).toBe(false);
  });

  it('an old-gateway response with no paneInspection field is reported as unsupported', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      protocolVersion: 1,
      authoritativeTurnPersistence: false,
      durableNodePrerequisite: false,
      explicitCommands: false,
      backgroundWorkspaceSync: true,
      legacySyncAccepted: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const capabilities = await fetchPersistenceCapabilities('local');
    expect(supportsPaneInspection(capabilities)).toBe(false);
  });

  it('a scope probe does not replace the boot transport or change its protocol', async () => {
    vi.stubGlobal('WebSocket', class {});
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ protocolVersion: 1 })));
    await fetchPersistenceCapabilities('local');
    // A scope read can be for a newer backend (or fail during handover), but
    // only an explicit boot configuration owns authenticated stream sockets.
    await fetchPersistenceCapabilities('local', { configureTransport: false });
    fetchMock.mockResolvedValueOnce(new Response('data: {}\n\n'));
    await fetchStream('http://localhost:3000/api/chats/one/stream');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://localhost:3000/api/chats/one/stream');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('tree message read deadlines', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('bounds a stalled response body and respects caller cancellation', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true,
      json: () => new Promise((_, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();
    const pending = fetchTreeMessages('ws', 'tree', undefined, caller.signal);
    const failed = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(caller.signal.aborted).toBe(false);

    const next = fetchTreeMessages('ws', 'tree', undefined, caller.signal);
    const cancelled = expect(next).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await cancelled;
  });
});

it('retains gateway recovery state for workspace retries and ignores a different machine’s status', async () => {
  const recovery = { connectionId: 'remote-c', phase: 'starting', message: 'Checking SSH…', diagnostic: { stage: 'ssh', log: 'Proxy waiting' } };
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: 'Starting remote Michi…', recovery }), { status: 502 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const error = await fetchAllWorkspacesMeta('remote-c').catch(error => error);
    expect(error).toBeInstanceOf(RemoteServiceRecoveryError);
    expect(error.recovery).toEqual(recovery);
    expect(error.message).toContain('HTTP 502');
    const unrelated = await fetchAllWorkspacesMeta('other-machine').catch(error => error);
    expect(unrelated).not.toBeInstanceOf(RemoteServiceRecoveryError);
  } finally { vi.unstubAllGlobals(); }
});

describe('a committed command batch names the artifacts whose upserts it skipped', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  const commands = [
    { type: 'context.upsert' as const, payload: { id: 'ctx-1', workspace_id: 'ws' } },
    { type: 'context.upsert' as const, payload: { id: 'ctx-2', workspace_id: 'ws' } },
  ];
  const none = { goneContextIds: [], nameTakenContextIds: [] };

  it('takes goneContextIds and nameTakenContextIds, unscoped for a remote workspace like its artifact ids', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => answer({
      ok: true, operationId: 'op', applied: [], goneContextIds: ['ctx-1'], nameTakenContextIds: ['ctx-2'],
    })));
    const expected = { goneContextIds: ['ctx-1'], nameTakenContextIds: ['ctx-2'] };
    expect(await applyWorkspaceCommands('ws', 'op', commands)).toEqual(expected);
    expect(await applyWorkspaceCommands(backendEntityId('r', 'ws'), 'op', commands)).toEqual(expected);
  });

  it('an older backend, an unreadable body or ids that are not ids answer nothing skipped', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(answer({ ok: true, operationId: 'op', applied: [{ type: 'context.upsert', id: 'ctx-1' }] }))
      .mockResolvedValueOnce(answer('not json'))
      .mockResolvedValueOnce(answer({ ok: true, goneContextIds: 'ctx-1', nameTakenContextIds: 'ctx-2' }))
      .mockResolvedValueOnce(answer({
        ok: true, goneContextIds: [7, '', 'x'.repeat(161), null, 'ctx-2'], nameTakenContextIds: [{ id: 'ctx-1' }, 'ctx-1'],
      }));
    vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 3; i += 1) expect(await applyWorkspaceCommands('ws', 'op', commands)).toEqual(none);
    expect(await applyWorkspaceCommands('ws', 'op', commands)).toEqual({ goneContextIds: ['ctx-2'], nameTakenContextIds: ['ctx-1'] });
    // An empty batch is not sent.
    expect(await applyWorkspaceCommands('ws', 'op', [])).toEqual(none);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('says this window matches artifacts by id only, to a remote workspace too (an older backend ignores the field)', async () => {
    const fetch = vi.fn().mockImplementation(async () => answer({ ok: true, operationId: 'op', applied: [] }));
    vi.stubGlobal('fetch', fetch);
    await applyWorkspaceCommands('ws', 'op', commands);
    await applyWorkspaceCommands(backendEntityId('r', 'ws'), 'op-remote', commands);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)))).toEqual([
      { operationId: 'op', commands, artifactIdentity: 'id' },
      { operationId: 'op-remote', commands, artifactIdentity: 'id' },
    ]);
  });
});

describe('lean remote metadata', () => {
  afterEach(() => vi.unstubAllGlobals());
  const leanBody = {
    structureCursor: null,
    leanNodeFields: ['branch_overview', 'follow_ups', 'composer_draft', 'not_a_field'],
    workspaces: [{ workspace: { id: 'ws', name: 'W' }, nodes: [{ id: 'n1', tree_id: 'tree', message_count: 2 }], trees: [], edges: [] }],
  };

  it('asks a remote connection for lean rows and stamps each workspace with the fields they left out', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(leanBody)));
    vi.stubGlobal('fetch', fetch);
    const [remote] = await fetchAllWorkspacesMeta('r') as Array<{ leanNodeFields: string[]; nodes: Array<{ id: string }> }>;
    const url = new URL(fetch.mock.calls[0][0], 'http://localhost');
    expect(url.pathname).toMatch(/\/backend-connections\/r\/proxy\/workspaces\/all$/);
    expect(url.searchParams.get('meta')).toBe('1');
    expect(url.searchParams.get('lean')).toBe('1');
    expect(remote.leanNodeFields).toEqual(['branch_overview', 'follow_ups', 'composer_draft']);
    expect(remote.nodes[0].id).toBe(backendEntityId('r', 'n1'));
    for (const local of [undefined, 'local']) {
      await fetchAllWorkspacesMeta(local);
      expect(new URL(fetch.mock.calls.at(-1)![0], 'http://localhost').searchParams.has('lean')).toBe(false);
    }
  });

  it('leaves an older backend\'s workspaces as they are (no marker, nothing deferred)', () => {
    const { leanNodeFields: _marker, ...older } = leanBody;
    expect(workspacesFromMetaBody(older)).toBe(older.workspaces);
    expect(workspacesFromMetaBody({ ...older, leanNodeFields: [] })).toBe(older.workspaces);
    expect(workspacesFromMetaBody(null)).toEqual([]);
  });

  it('keeps a page\'s lean node fields, scoped like the rows they came from', async () => {
    const draft = JSON.stringify({ value: 'see @x', mentions: [{ start: 4, end: 6, kind: 'node', refId: 'n2', label: 'x' }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [], pages: [{ nodeId: 'n1', total: 0, before: null, node: { branch_overview: null, follow_ups: '["Next?"]', follow_ups_source_message_id: 'a-1', composer_draft: draft } }],
    }))));
    const page = await fetchTreeMessagePage(backendEntityId('r', 'ws'), backendEntityId('r', 'tree'), 'r');
    const node = page.pages![0].node!;
    expect(node.follow_ups).toBe('["Next?"]');
    expect(node.follow_ups_source_message_id).toBe('a-1');
    expect(JSON.parse(node.composer_draft as string).mentions[0].refId).toBe(backendEntityId('r', 'n2'));
  });
});
