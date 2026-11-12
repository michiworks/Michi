import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkflowRunDto, type WorkflowRunDtoV1 } from 'michi-shared';
import { approvalForRow } from '../components/terminal/multiModel/multiModelPresentation';
import { workflowNodeRows } from '../components/terminal/workflows/workflowPresentation';
import { backendEntityId, backendRequestUrl, mapBackendPayload } from '../config/backendIdentity';
import { backendApiBase, indexBackendProjects, nodeBackendApiBase, workspaceBackendApiBase } from '../config/backendConnections';
import { backendFetch, backendStreamResponse } from './api/backendRequest';
import {
  backendConnectionGeneration, backendConnectionUnavailable, confirmBackendConnection, markBackendConnectionProvisional,
  markBackendConnectionReady, markBackendConnectionUnavailable, resetBackendConnectionProvisional,
} from '../config/backendConnectionState';
import { hydrateBackendWorkspaces } from '../state/chatHydration';
import { importWorkspaceFile } from './api/uploads';
import { getPageMaintenance } from './api/pageMaintenance';
import { listPageComponents } from './api/pageComponents';
import { pagesFetch } from './api/pages';

import { fetchStream } from './api/streamTransport';
import { answerWorkflowApproval, getWorkflowRun, subscribeWorkflowRuns } from './api/workflowRuns';
import { fetchReadyModels, startMultiModelRun } from './api/multiModelRuns';
import { workflowCardSections } from '../components/terminal/backgroundWork/workflowCardModel';

describe('remote connection data isolation', () => {
  const connectionId = 'remote-isolation';
  const workspaceId = backendEntityId(connectionId, 'ws');
  const nodeId = backendEntityId(connectionId, 'n1');
  const base = backendApiBase(connectionId);
  beforeEach(() => { markBackendConnectionReady(connectionId); indexBackendProjects([]); });
  afterEach(() => { vi.unstubAllGlobals(); markBackendConnectionReady(connectionId); resetBackendConnectionProvisional(); });

  it('routes a detached remote identity to its own server and never needs a Local registration', async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ workspace: { id: 'ws' }, nodes: [{ id: 'n1', workspace_id: 'ws', acp_session_id: 'n1' }] })));
    vi.stubGlobal('fetch', fetch);
    expect(nodeBackendApiBase(nodeId)).toBe(base);
    const response = await backendFetch(`${workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(workspaceId)}`);
    expect(fetch.mock.calls[0][0]).toBe(`${base}/workspaces/ws`);
    const data = await response.json();
    expect(data.workspace.id).toBe(workspaceId);
    expect(data.nodes[0]).toEqual({ id: nodeId, workspace_id: workspaceId, acp_session_id: 'n1' });
    const hydrated = hydrateBackendWorkspaces([data], null, connectionId);
    expect(hydrated.nodes[nodeId].runtimeId).toBe('pi');
  });

  it('rejects a late snapshot and blocks writes after the owning connection disconnects', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetch);
    const pending = backendFetch(`${base}/workspaces/all?meta=1`);
    markBackendConnectionUnavailable(connectionId);
    resolve(new Response(JSON.stringify({ workspaces: [] })));
    await expect((await pending).json()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(backendFetch(`${base}/workspaces/ws/commands`, { method: 'POST', body: '{}' })).rejects.toThrow('unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('converts pane and move references while leaving search text and native sessions opaque', () => {
    const raw = { fromWorkspaceId: 'ws', toWorkspaceId: 'target', sourceWorkspaceId: 'ws',
      views: [{ paneId: 'node:n1', target: { kind: 'node', nodeId: 'n1' } }], paneIds: ['node:n1', 'surface:browser'],
      acp_session_id: 'n1', sessionId: 'n1' };
    const mapped = mapBackendPayload(raw, connectionId, 'renderer');
    expect(mapped.views[0]).toEqual({ paneId: `node:${nodeId}`, target: { kind: 'node', nodeId } });
    expect(mapped.toWorkspaceId).toBe(backendEntityId(connectionId, 'target'));
    expect(mapBackendPayload(mapped, connectionId, 'server')).toEqual(raw);
    const url = new URL(backendRequestUrl(`${base}/panes/output?${new URLSearchParams({
      paneId: `node:${nodeId}`, executionRef: JSON.stringify({ kind: 'chat_turn', nodeId, turnId: 'turn' }), q: nodeId,
    })}`));
    expect(url.searchParams.get('paneId')).toBe('node:n1');
    expect(JSON.parse(url.searchParams.get('executionRef')!)).toEqual({ kind: 'chat_turn', nodeId: 'n1', turnId: 'turn' });
    expect(url.searchParams.get('q')).toBe(nodeId);
    expect(() => mapBackendPayload({ fromWorkspaceId: workspaceId, toWorkspaceId: backendEntityId('other', 'ws') }, connectionId, 'server')).toThrow('different backend');
  });

  it('converts upload bodies even when upload progress uses XMLHttpRequest', async () => {
    const sent: { url?: string; body?: string } = {};
    vi.stubGlobal('XMLHttpRequest', class {
      upload = {};
      status = 200;
      responseText = JSON.stringify({ name: 'note.txt', filePath: '/srv/note.txt', size: 3 });
      onload!: () => void;
      open(_method: string, url: string) { sent.url = url; }
      setRequestHeader() {}
      send(body: string) { sent.body = body; this.onload(); }
    });
    await importWorkspaceFile(workspaceId, '/srv', 'note.txt', 'abc', { onProgress: vi.fn() });
    expect(sent.url).toBe(`${base}/workspaces/import-file`);
    expect(JSON.parse(sent.body!)).toMatchObject({ workspaceId: 'ws', cwd: '/srv', content: 'abc' });
  });

  it('checks a healthy remote before a failed upload with progress marks it down, and holds it for a provisional one', async () => {
    const sends = vi.fn();
    let outcome: 'gateway' | 'network' = 'gateway';
    vi.stubGlobal('XMLHttpRequest', class {
      upload = {};
      status = 502;
      responseText = JSON.stringify({ error: 'socket closed' });
      onload!: () => void;
      onerror!: () => void;
      open() {}
      setRequestHeader() {}
      send() { sends(); if (outcome === 'gateway') this.onload(); else this.onerror(); }
    });
    const health = vi.fn(async (_url: string) => Response.json({ service: 'michi-backend', status: 'healthy' }));
    vi.stubGlobal('fetch', health);
    const generation = backendConnectionGeneration(connectionId);
    const upload = () => importWorkspaceFile(workspaceId, '/srv', 'note.txt', 'abc', { onProgress: vi.fn() });
    await expect(upload()).rejects.toThrow('socket closed');
    outcome = 'network';
    await expect(upload()).rejects.toThrow('upload failed');
    expect(health.mock.calls.map(([url]) => url)).toEqual([`${base}/health`, `${base}/health`]);
    expect(backendConnectionUnavailable(connectionId)).toBe(false);
    expect(backendConnectionGeneration(connectionId)).toBe(generation);
    markBackendConnectionProvisional(connectionId);
    const held = upload().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sends).toHaveBeenCalledTimes(2);
    confirmBackendConnection(connectionId);
    await held;
    expect(sends).toHaveBeenCalledTimes(3);
  });

  it('rejects stream headers from a previous connection generation', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const pending = fetchStream(`${base}/chats/${encodeURIComponent(nodeId)}/stream`);
    markBackendConnectionUnavailable(connectionId);
    markBackendConnectionReady(connectionId);
    resolve(new Response('event: chunk\ndata: {"nodeId":"n1","text":"late"}\n\n'));
    await expect((await pending).text()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('scopes the node ids that key background subagent liveness, so a remote agent reads as running after its turn', async () => {
    const frames = [
      { version: 1, event: 'background_subagents', run: null, backgroundSubagents: { snapshot: true, nodes: { n1: ['toolu_a'] } }, emittedAt: 1 },
      { version: 1, event: 'background_subagents', run: null, backgroundSubagents: { snapshot: false, nodes: { n1: [] } }, emittedAt: 2 },
      { version: 1, event: 'background_subagents_ended', run: null,
        backgroundSubagentsEnded: { nodeId: 'n1', subagents: [{ sessionId: 'toolu_a', outcome: 'cancelled' }] }, emittedAt: 3 },
    ];
    const body = frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
    const fetch = vi.fn(async (_url: string) => new Response(body));
    vi.stubGlobal('fetch', fetch);
    const liveness = vi.fn();
    const ended = vi.fn();
    await new Promise<void>((resolve) => subscribeWorkflowRuns(workspaceId, {
      onRun: vi.fn(), onBackgroundSubagents: liveness, onBackgroundSubagentsEnded: ended, onDisconnect: () => resolve(),
    }));
    expect(new URL(fetch.mock.calls[0][0], 'http://renderer').searchParams.get('workspaceId')).toBe('ws');
    expect(liveness.mock.calls.map(([update]) => update)).toEqual([
      { snapshot: true, nodes: { [nodeId]: ['toolu_a'] } },
      { snapshot: false, nodes: { [nodeId]: [] } },
    ]);
    expect(ended).toHaveBeenCalledWith({ nodeId, subagents: [{ sessionId: 'toolu_a', outcome: 'cancelled' }] });
    const raw = frames[0];
    expect(mapBackendPayload(mapBackendPayload(raw, connectionId, 'renderer'), connectionId, 'server')).toEqual(raw);
  });

  it('marks a broken stream unavailable but preserves intentional observer cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const brokenStream = () => new Response(new ReadableStream({ pull() { throw new TypeError('socket closed'); } }));
    await expect(backendStreamResponse(brokenStream(), connectionId).text()).rejects.toThrow('socket closed');
    expect(backendConnectionUnavailable(connectionId)).toBe(true);
    markBackendConnectionReady(connectionId);
    const controller = new AbortController();
    controller.abort();
    await expect(backendStreamResponse(brokenStream(), connectionId, backendConnectionGeneration(connectionId), controller.signal).text()).rejects.toThrow();
    expect(backendConnectionUnavailable(connectionId)).toBe(false);
  });

  it('keeps loaded remote data valid after an isolated failed write and never replays it', async () => {
    const generation = backendConnectionGeneration(connectionId);
    const fetch = vi.fn(async (url: string) => url.endsWith('/health')
      ? Response.json({ service: 'michi-backend', status: 'healthy' })
      : Response.json({ error: 'socket closed' }, { status: 502 }));
    vi.stubGlobal('fetch', fetch);
    const response = await backendFetch(`${base}/workspaces/ws/commands`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'socket closed' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${base}/workspaces/ws/commands`, `${base}/health`]);
    expect(backendConnectionUnavailable(connectionId)).toBe(false);
    expect(backendConnectionGeneration(connectionId)).toBe(generation);
  });

  it('keeps a healthy remote available when a Pages or component request fails, and shows the server\'s reason', async () => {
    const generation = backendConnectionGeneration(connectionId);
    const fetch = vi.fn(async (url: string) => url.endsWith('/health')
      ? Response.json({ service: 'michi-backend', status: 'healthy' })
      : url.endsWith('/maintenance')
        ? Response.json({ error: { code: 'scheduler_unavailable', message: 'Scheduled jobs are off on this backend' } }, { status: 503 })
        : Response.json({ error: { code: 'upstream', message: 'socket closed' } }, { status: 502 }));
    vi.stubGlobal('fetch', fetch);
    await expect(getPageMaintenance({ backendConnectionId: connectionId, workspaceId })).rejects.toMatchObject({
      status: 503, code: 'scheduler_unavailable', message: 'Scheduled jobs are off on this backend',
    });
    await expect(listPageComponents(workspaceId, connectionId)).rejects.toMatchObject({ status: 502, message: 'socket closed' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${base}/workspaces/ws/maintenance`, `${base}/health`, `${base}/workspaces/ws/components`, `${base}/health`,
    ]);
    expect(backendConnectionUnavailable(connectionId)).toBe(false);
    expect(backendConnectionGeneration(connectionId)).toBe(generation);
  });

  it('holds a Pages write to a remote still shown from the local cache until its own data arrives', async () => {
    const fetch = vi.fn(async (_url: string) => Response.json({}));
    vi.stubGlobal('fetch', fetch);
    markBackendConnectionProvisional(connectionId);
    const write = pagesFetch(`${base}/pages/p1/edits`, { method: 'POST', body: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
    confirmBackendConnection(connectionId);
    await write;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shares an outage check across failed requests and blocks writes when health also fails', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(async (url: string) => url.endsWith('/health')
      ? new Promise<Response>(done => { resolve = done; })
      : Response.json({ error: 'connection failed' }, { status: 502 }));
    vi.stubGlobal('fetch', fetch);
    const first = backendFetch(`${base}/workspaces/ws`);
    const second = backendFetch(`${base}/agent/status`);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/health'))).toHaveLength(1);
    resolve(Response.json({ error: 'offline' }, { status: 502 }));
    await Promise.all([first, second]);
    expect(backendConnectionUnavailable(connectionId)).toBe(true);
    await expect(backendFetch(`${base}/workspaces/ws/commands`, { method: 'POST', body: '{}' })).rejects.toThrow('unavailable');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not invalidate a recovered generation after an old health check fails', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/health')
      ? new Promise<Response>(done => { resolve = done; })
      : Response.json({}, { status: 502 })));
    const request = backendFetch(`${base}/agent/status`);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    markBackendConnectionUnavailable(connectionId);
    markBackendConnectionReady(connectionId);
    resolve(Response.json({}, { status: 503 }));
    await request;
    expect(backendConnectionUnavailable(connectionId)).toBe(false);
  });

  it('ignores a late failed request from an older connection generation', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetch);
    const request = backendFetch(`${base}/agent/status`);
    markBackendConnectionUnavailable(connectionId);
    markBackendConnectionReady(connectionId);
    resolve(Response.json({}, { status: 502 }));
    await request;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(backendConnectionUnavailable(connectionId)).toBe(false);
  });

  it('preserves a healthy remote when an SSE body fails and exposes the original stream error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ service: 'michi-backend', status: 'healthy' })));
    const broken = new Response(new ReadableStream({ pull() { throw new TypeError('stream reset'); } }));
    await expect(backendStreamResponse(broken, connectionId).text()).rejects.toThrow('stream reset');
    expect(backendConnectionUnavailable(connectionId)).toBe(false);
  });

  it('does not start recovery for an aborted request or treat an arbitrary HTTP 200 as healthy', async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn().mockRejectedValue(new TypeError('request aborted'));
    vi.stubGlobal('fetch', fetch);
    await expect(backendFetch(`${base}/agent/status`, { signal: controller.signal })).rejects.toThrow('request aborted');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(backendConnectionUnavailable(connectionId)).toBe(false);
    fetch.mockImplementation(async () => Response.json({ ok: true }));
    fetch.mockRejectedValueOnce(new TypeError('socket closed'));
    await expect(backendFetch(`${base}/agent/status`)).rejects.toThrow('socket closed');
    expect(backendConnectionUnavailable(connectionId)).toBe(true);
  });

  it('scopes trees, trim restoration and per-window draft references alongside workspace and node identities', () => {
    const trim = JSON.stringify({ parentId: 'parent', childrenIds: ['child'], wasTreeRoot: { treeId: 'tree' } });
    const draft = JSON.stringify({ value: 'mention', mentions: [{ kind: 'node', refId: 'child' }] });
    const raw = { workspace: { id: 'ws', active_tree_id: 'tree' }, trees: [{ id: 'tree', root_node_id: 'parent' }],
      nodes: [{ id: 'child', tree_id: 'tree', trim_snapshot: trim, composer_draft: JSON.stringify({ __michiWindowDrafts: { window: draft } }) }],
      metadata: JSON.stringify({ threadMessage: { fromNodeId: 'parent', fromTitle: 'Parent' } }) };
    const mapped = mapBackendPayload(raw, connectionId, 'renderer');
    const treeId = backendEntityId(connectionId, 'tree');
    expect(mapped.trees[0].id).toBe(treeId);
    expect(mapped.workspace.active_tree_id).toBe(treeId);
    expect(mapped.nodes[0].tree_id).toBe(treeId);
    expect(JSON.parse(mapped.nodes[0].trim_snapshot)).toEqual({ parentId: backendEntityId(connectionId, 'parent'),
      childrenIds: [backendEntityId(connectionId, 'child')], wasTreeRoot: { treeId } });
    const windowDraft = JSON.parse(JSON.parse(mapped.nodes[0].composer_draft).__michiWindowDrafts.window);
    expect(windowDraft.mentions[0].refId).toBe(backendEntityId(connectionId, 'child'));
    expect(JSON.parse(mapped.metadata).threadMessage.fromNodeId).toBe(backendEntityId(connectionId, 'parent'));
    expect(mapBackendPayload(mapped, connectionId, 'server')).toEqual(raw);
  });

  it('scopes a multi-model run\'s caller and branch nodes, so its card opens the drawer and branches on a remote', () => {
    const raw = { run: { id: 'wfr_1', nodeId: 'n1', multiModel: { callerNodeId: 'n1', synthesis: { messageId: 'self-n1-turn' },
      threads: [{ key: 't1', childNodeId: 'b2', previousChildNodeIds: ['b1'] }, { key: 't2', childNodeId: null }] } } };
    const mapped = mapBackendPayload(raw, connectionId, 'renderer');
    const view = mapped.run.multiModel;
    expect(view.callerNodeId).toBe(nodeId);
    expect(view.callerNodeId).toBe(mapped.run.nodeId);
    expect(view.threads[0]).toEqual({ key: 't1', childNodeId: backendEntityId(connectionId, 'b2'), previousChildNodeIds: [backendEntityId(connectionId, 'b1')] });
    expect(view.threads[1].childNodeId).toBeNull();
    // Message ids are not connection-scoped; the synthesis link keeps the server's.
    expect(view.synthesis.messageId).toBe('self-n1-turn');
    expect(mapped.run.id).toBe('wfr_1');
    expect(mapBackendPayload(mapped, connectionId, 'server')).toEqual(raw);
  });

  describe('a remote workflow run', () => {
    const rawRun = {
      version: 1, id: 'wfr_1', runtime: 'michi', nativeId: 'mm_1', workspaceId: 'ws', nodeId: 'n1', parentToolCallId: 'toolu_1',
      name: 'Caches', status: 'running', actions: ['stop'], startedAt: 1, updatedAt: 2, revision: 3,
      nodes: [
        { id: 'answer', kind: 'phase', title: 'Answer', status: 'running' },
        { id: 't1@0', parentId: 'answer', kind: 'agent', title: 'Codex · gpt', status: 'running' },
      ],
      approvals: [{ id: 'ap1', nodeId: 't1@0', title: 'Run: ls', requestedAt: 2,
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] }],
      log: [{ at: 2, text: 'Codex started', nodeId: 't1@0' }],
      multiModel: {
        version: 1, phase: 'running', title: 'Caches', askPreview: 'Which cache?', callerNodeId: 'n1', callerMessageId: 'm1',
        callerRuntimeId: 'claude', callerRuntimeLabel: 'Claude', callerModelLabel: 'Opus', permissionMode: 'ask', reviewRounds: 0,
        threads: [{ key: 't1', runtimeId: 'codex', providerId: null, modelId: 'gpt', reasoning: null, runtimeLabel: 'Codex',
          modelLabel: 'gpt', context: 'fresh', promptPreview: 'Which cache?', childNodeId: 'c1', previousChildNodeIds: ['c0'],
          steps: [{ kind: 'answer', round: 0, status: 'waiting' }] }],
        synthesis: { status: 'pending' },
      },
    };
    const parsed = parseWorkflowRunDto(rawRun)!;
    // Only the chat references are connection-scoped; step ids are the runtime's own.
    const expected = {
      ...parsed, workspaceId, nodeId,
      multiModel: { ...parsed.multiModel!, callerNodeId: nodeId, threads: [{ ...parsed.multiModel!.threads[0],
        childNodeId: backendEntityId(connectionId, 'c1'), previousChildNodeIds: [backendEntityId(connectionId, 'c0')] }] },
    };

    it('keeps its step ids from the feed, so steps nest and a row finds its approval', async () => {
      const frame = { version: 1, event: 'workflow_run', run: rawRun, emittedAt: 1 };
      vi.stubGlobal('fetch', vi.fn(async () => new Response(`event: workflow_run\ndata: ${JSON.stringify(frame)}\n\n`)));
      const onRun = vi.fn();
      await new Promise<void>((resolve) => subscribeWorkflowRuns(workspaceId, { onRun, onDisconnect: () => resolve() }));
      const run = onRun.mock.calls[0][0] as WorkflowRunDtoV1;
      expect(run).toEqual(expected);
      expect(workflowNodeRows(run.nodes).map(({ node, depth }) => [node.id, depth])).toEqual([['answer', 0], ['t1@0', 1]]);
      expect(approvalForRow(run, 't1', 0)?.id).toBe('ap1');
      expect(mapBackendPayload(run, connectionId, 'server')).toEqual(parsed);
    });

    it('keeps a Claude run\'s agents under their phases, as the Background work card groups them', async () => {
      const claudeRun = {
        version: 1, id: 'wfr_2', runtime: 'claude', nativeId: 'wf_1', workspaceId: 'ws', nodeId: 'n1', parentToolCallId: null,
        name: 'probe', status: 'running', actions: [], startedAt: 1, updatedAt: 2, revision: 1,
        nodes: [
          { id: 'phase:1', kind: 'phase', title: 'Fix', status: 'running' },
          { id: 'agent:1', kind: 'agent', title: 'fix:a', status: 'running', parentId: 'phase:1' },
          { id: 'agent:2', kind: 'agent', title: 'fix:b', status: 'completed', parentId: 'phase:1' },
        ],
        omittedLeaves: { 'phase:1': { completed: 3 } },
      };
      const frame = { version: 1, event: 'workflow_run', run: claudeRun, emittedAt: 3 };
      vi.stubGlobal('fetch', vi.fn(async () => new Response(`event: workflow_run\ndata: ${JSON.stringify(frame)}\n\n`)));
      const onRun = vi.fn();
      await new Promise<void>((resolve) => subscribeWorkflowRuns(workspaceId, { onRun, onDisconnect: () => resolve() }));
      const run = onRun.mock.calls[0][0] as WorkflowRunDtoV1;
      expect(run.omittedLeaves).toEqual(claudeRun.omittedLeaves);
      expect(workflowCardSections(run.nodes).map((section) => [section.node?.title, section.leaves.length])).toEqual([['Fix', 2]]);
    });

    it('reads the same run from its own requests and commands as from the feed', async () => {
      const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ run: rawRun }));
      vi.stubGlobal('fetch', fetch);
      await expect(getWorkflowRun(connectionId, 'wfr_1')).resolves.toEqual(expected);
      await expect(answerWorkflowApproval(connectionId, 'wfr_1', 'ap1', 'allow')).resolves.toEqual(expected);
      await expect(startMultiModelRun(connectionId, 'wfr_1')).resolves.toEqual(expected);
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        `${base}/workflow-runs/wfr_1`, `${base}/workflow-runs/wfr_1/approvals/ap1`, `${base}/multi-model-runs/wfr_1/start`,
      ]);
    });

    it('asks the remote for the ready models of its own workspace id', async () => {
      const fetch = vi.fn(async (_url: string) => Response.json({ version: 1, runtimes: [] }));
      vi.stubGlobal('fetch', fetch);
      await expect(fetchReadyModels(connectionId, workspaceId)).resolves.toEqual({ version: 1, runtimes: [] });
      expect(new URL(fetch.mock.calls[0][0]).searchParams.get('workspaceId')).toBe('ws');
    });
  });
});
