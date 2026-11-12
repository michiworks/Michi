import type { Route } from '@playwright/test';
import type {
  ConversationMemoryMode, MemoryChangedEvent, MemoryMode, MemoryProfileResponse, MemoryRecord, MemoryScope, ReplyMemorySource,
} from '../../shared/src/memory';

/**
 * Browser-only Michi Memory: /api/memories (with reset), /api/memory-settings,
 * the change feed, automatic memory's status, the profile of the user and a
 * conversation's memory setting, answered from in-memory state.
 * installMockApi uses an empty instance by default; a spec that needs data
 * seeds its own and passes `handle` as `custom`. No backend or SQLite. With
 * `sources`, what each reply was based on (GET /nodes/:id/memory-sources)
 * and Don't recall (POST /memory-recall/hide) answer too.
 *
 * The change feed answers each request at once with the changes queued by
 * `announce` and then ends, so the app reconnects (after its backoff) for the
 * next ones; nothing is sent twice.
 */
export interface MemoryMockOptions {
  records?: MemoryRecord[];
  /** On ('auto') by default, as on the backend; 'explicit' is retired and stored as 'auto'. */
  mode?: MemoryMode;
  /** Automatic memory's status; omitted answers 404, as a backend without it does. */
  extraction?: Record<string, unknown>;
  /** The one-time notice's state; omitted, the settings carry none, as an older backend's do. */
  notice?: { migratedFromExplicit: boolean; noticeSeen: boolean };
  /** About the user, each line's refs naming seeded records by id; omitted answers as a backend without it. */
  profile?: { lines: Array<{ topic: string; text: string; refs: string[] }>; builtAt: number; version: number };
  /** Answer GET/PUT /api/nodes/:id/memory-mode (every chat starts in learn); omitted, chats show no memory control. */
  conversations?: boolean;
  /**
   * What each reply was based on, by assistant message id: GET /api/nodes/:id/memory-sources answers these (a chat set
   * to Off answers none, a forgotten memory leaves them). Omitted, the route answers as a backend without it.
   */
  sources?: Record<string, ReplyMemorySource[]>;
  /** How long GET memory-sources waits before it answers (ms). */
  sourcesDelayMs?: number;
}

export interface MemoryMockController {
  handle(route: Route): Promise<boolean>;
  /** The stored memories, as the last request left them. */
  readonly records: MemoryRecord[];
  /** The stored memory mode, as the last request left it. */
  readonly mode: MemoryMode;
  /** Every write this controller answered, as `METHOD /path`. */
  readonly writes: string[];
  /** The JSON bodies of those writes, in the same order (null for none). */
  readonly writeBodies: unknown[];
  /** Each conversation's memory setting by node id, as the last request left it. */
  readonly conversationModes: Record<string, ConversationMemoryMode>;
  /** The message ids each GET memory-sources asked about, in order. */
  readonly sourceRequests: string[][];
  /** Queues changes for the next change feed request. */
  announce(...events: MemoryChangedEvent[]): void;
  /** How many times the change feed was opened. */
  feedRequests(): number;
}

export function memoryRecord(id: string, body: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id, ownerUserId: 'local', scope: { kind: 'user' }, kind: 'preference', body, source: null, status: 'active',
    origin: 'explicit', version: 1, supersedesId: null, sourceRisk: null, createdAt: now, updatedAt: now - 60_000, ...overrides,
  };
}

export function memoryChange(record: MemoryRecord, action: MemoryChangedEvent['action'] = 'created'): MemoryChangedEvent {
  return {
    ownerUserId: record.ownerUserId, workspaceId: record.scope.kind === 'workspace' ? record.scope.workspaceId : null,
    memoryId: record.id, action, status: record.status, body: record.body, origin: record.origin,
    ...(record.source?.nodeId ? { nodeId: record.source.nodeId } : {}), supersedesId: record.supersedesId,
  };
}

const json = (route: Route, value: unknown, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(value),
});

const stored = (mode: MemoryMode): MemoryMode => mode === 'explicit' ? 'auto' : mode;

export function createMemoryMock(options: MemoryMockOptions = {}): MemoryMockController {
  const state = {
    records: [...(options.records ?? [])],
    mode: stored(options.mode ?? 'auto'),
    notice: options.notice ? { ...options.notice } : null,
    profile: options.profile ? { ...options.profile, lines: [...options.profile.lines], rebuildRequested: false } : null,
    conversations: {} as Record<string, ConversationMemoryMode>,
  };
  const writes: string[] = [];
  const writeBodies: unknown[] = [];
  const sourceRequests: string[][] = [];
  const hiddenDocs = new Set<number>();
  let queued: MemoryChangedEvent[] = [];
  let feeds = 0;
  let next = 1;

  const find = (id: string) => state.records.find((record) => record.id === id);
  const notFound = (route: Route) => json(route, { error: 'Memory not found', code: 'not_found' }, 404);
  const settings = () => ({ mode: state.mode, ...(state.notice ?? {}) });
  /** As the backend shows it: the lines whose memories all still exist, each with them. */
  const profileView = (): MemoryProfileResponse => {
    const profile = state.profile!;
    const lines = profile.lines.filter((line) => line.refs.every((id) => find(id)));
    return {
      lines: lines.map((line) => ({ topic: line.topic, text: line.text, refs: line.refs.map((id) => ({ ref: `m:${id}v1`, id, body: find(id)!.body })) })),
      builtAt: profile.builtAt, version: profile.version, rebuildRequested: profile.rebuildRequested,
    };
  };

  async function handle(route: Route): Promise<boolean> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*?\/api/, '');
    const method = request.method();
    const conversation = /^\/nodes\/([^/]+)\/memory-mode$/.exec(path);
    if (conversation && !options.conversations) return false;
    const replySources = /^\/nodes\/([^/]+)\/memory-sources$/.exec(path);
    if ((replySources || path === '/memory-recall/hide') && !options.sources) return false;
    if (!conversation && !replySources && path !== '/memory-recall/hide' && path !== '/memory-settings' && path !== '/memories'
      && !path.startsWith('/memories/') && !path.startsWith('/memory-extraction/') && !path.startsWith('/memory-profile')) return false;
    if (method !== 'GET') {
      writes.push(`${method} ${path}`);
      writeBodies.push(request.postData() ? request.postDataJSON() : null);
    }

    if (method === 'GET' && path === '/memories/changes/stream') {
      feeds += 1;
      const body = queued.map((event) => `event: memory_changed\ndata: ${JSON.stringify(event)}\n\n`).join('');
      queued = [];
      await route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'cache-control': 'no-cache' }, body: `: connected\n\n${body}` });
      return true;
    }
    if (path === '/memory-settings') {
      if (method === 'PUT') {
        const body = request.postDataJSON() as { mode?: MemoryMode; noticeSeen?: true };
        if (body.mode) state.mode = stored(body.mode);
        if (body.noticeSeen && state.notice) state.notice.noticeSeen = true;
      }
      await json(route, settings());
      return true;
    }
    if (replySources && method === 'GET') {
      const nodeId = decodeURIComponent(replySources[1]);
      const ids = (url.searchParams.get('messages') ?? '').split(',').filter(Boolean);
      sourceRequests.push(ids);
      if (options.sourcesDelayMs) await new Promise((resolve) => setTimeout(resolve, options.sourcesDelayMs));
      const off = state.conversations[nodeId] === 'off' || state.mode === 'off';
      const live = (source: ReplyMemorySource) => (source.kind === 'memory' ? !!find(source.memoryId) : !hiddenDocs.has(source.docId));
      const messages = off ? [] : ids.flatMap((messageId) => {
        const listed = (options.sources?.[messageId] ?? []).filter(live);
        return listed.length ? [{ messageId, sources: listed }] : [];
      });
      await json(route, { messages });
      return true;
    }
    if (path === '/memory-recall/hide' && method === 'POST') {
      const { docId } = request.postDataJSON() as { docId: number };
      hiddenDocs.add(docId);
      await json(route, { hidden: true });
      return true;
    }
    if (conversation) {
      const nodeId = decodeURIComponent(conversation[1]);
      const previous = state.conversations[nodeId] ?? 'learn';
      if (method === 'PUT') {
        const mode = (request.postDataJSON() as { mode: ConversationMemoryMode }).mode;
        state.conversations[nodeId] = mode;
        await json(route, { mode, hiddenTurns: 0, removedMemories: previous === 'learn' && mode !== 'learn' ? 1 : 0 });
        return true;
      }
      await json(route, { mode: previous });
      return true;
    }
    if (path.startsWith('/memory-profile')) {
      if (!state.profile) { await json(route, { error: 'not found' }, 404); return true; }
      if (method === 'POST' && path === '/memory-profile/rebuild') {
        state.profile.rebuildRequested = true;
        await json(route, profileView(), 202);
        return true;
      }
      if (method === 'POST' && path === '/memory-profile/remove-line') {
        const { index, version } = request.postDataJSON() as { index: number; version?: number };
        if (version !== undefined && version !== state.profile.version) {
          await json(route, { error: 'The profile changed since it was read', code: 'version_conflict' }, 409);
          return true;
        }
        const line = state.profile.lines.filter((candidate) => candidate.refs.every((id) => find(id)))[index];
        if (!line) { await json(route, { error: 'Profile line not found', code: 'not_found' }, 404); return true; }
        state.records = state.records.filter((record) => !line.refs.includes(record.id));
        state.profile.lines = state.profile.lines.filter((candidate) => candidate !== line);
        state.profile.rebuildRequested = true;
        await json(route, profileView());
        return true;
      }
      await json(route, profileView());
      return true;
    }
    if (path.startsWith('/memory-extraction/')) {
      if (!options.extraction) { await json(route, { error: 'not found' }, 404); return true; }
      if (method === 'POST') options.extraction.paused = path.endsWith('/pause');
      await json(route, options.extraction);
      return true;
    }
    if (method === 'POST' && path === '/memories/reset') {
      const removed = state.records.length;
      state.records = [];
      if (state.profile) state.profile.lines = [];
      await json(route, { removed, hiddenTurns: 0 });
      return true;
    }
    if (method === 'GET' && path === '/memories') {
      const statuses = (url.searchParams.get('status') ?? 'active,pending').split(',');
      const scope = url.searchParams.get('scope');
      const workspaceId = url.searchParams.get('workspaceId');
      const q = url.searchParams.get('q');
      const items = state.records
        .filter((record) => statuses.includes(record.status))
        .filter((record) => scope !== 'user' || record.scope.kind === 'user')
        .filter((record) => scope !== 'workspace' || (record.scope.kind === 'workspace' && (!workspaceId || record.scope.workspaceId === workspaceId)))
        .filter((record) => !q || record.body.includes(q))
        .sort((a, b) => b.createdAt - a.createdAt);
      await json(route, { items, nextCursor: null });
      return true;
    }
    if (method === 'POST' && path === '/memories') {
      const input = request.postDataJSON() as { scope: MemoryScope; kind: MemoryRecord['kind']; body: string };
      const record = memoryRecord(`mem-added-${next++}`, input.body.trim(), { scope: input.scope, kind: input.kind });
      state.records.push(record);
      await json(route, { memory: record }, 201);
      return true;
    }
    const match = /^\/memories\/([^/]+)$/.exec(path);
    if (!match) return false;
    const record = find(decodeURIComponent(match[1]));
    if (!record) { await notFound(route); return true; }
    if (method === 'PATCH') {
      const patch = request.postDataJSON() as { body?: string; scope?: MemoryScope; expectedVersion: number };
      if (patch.expectedVersion !== record.version) {
        await json(route, { error: 'The memory changed since it was read', code: 'version_conflict', currentVersion: record.version }, 409);
        return true;
      }
      if (patch.body !== undefined) record.body = patch.body;
      if (patch.scope) record.scope = patch.scope;
      record.version += 1;
      record.updatedAt = Date.now();
      await json(route, { memory: record });
      return true;
    }
    if (method === 'DELETE') {
      state.records = state.records.filter((item) => item !== record);
      await route.fulfill({ status: 204, body: '' });
      return true;
    }
    return false;
  }

  return {
    handle,
    get records() { return state.records; },
    get mode() { return state.mode; },
    writes,
    writeBodies,
    get conversationModes() { return state.conversations; },
    sourceRequests,
    announce(...events) { queued.push(...events); },
    feedRequests: () => feeds,
  };
}
