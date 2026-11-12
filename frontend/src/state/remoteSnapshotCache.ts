import { isRecord } from 'michi-shared';
import type { TreeMessagePage } from '../services/api';

/**
 * A local copy of what each remote last answered: its workspace metadata and
 * the first pages of the threads this user viewed most recently, so a reload
 * can paint a remote workspace before its tunnel answers. Shown read-only
 * (workspacePersistence: provisional connections); the remote's own answer
 * replaces it.
 *
 * Everything is scoped by user and connection, and stamped with the
 * connection's saved revision (target and credentials): a copy taken from
 * another machine behind the same connection id is never shown. Responses are
 * stored exactly as received. Best effort throughout: a storage failure only
 * means a slower boot.
 */

/** Hydration's remote snapshot, minus its connection id: the metadata response as received. */
export interface CachedRemoteSnapshot {
  workspaces: unknown[];
  [field: string]: unknown;
}

export interface CachedRemoteConnection {
  revision: string;
  snapshot: CachedRemoteSnapshot | null;
  savedAt?: number;
  /** Workspace id → the thread this user last had open in it. */
  activeTrees: Record<string, string>;
}

/** The key/value store under the cache: IndexedDB in the app, a Map in tests. */
export interface RemoteCacheStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  /** Every key starting with `prefix`. */
  keys(prefix: string): Promise<string[]>;
  clear(): Promise<void>;
}

export const REMOTE_CACHE_PAGE_LIMIT = 5;
export const REMOTE_CACHE_MAX_BYTES = 24 * 1024 * 1024;

const SEP = '\u001f';
const META = `${SEP}meta`;

type EntryKind = 'snapshot' | 'page' | 'view';
interface EntryMeta { kind: EntryKind; size: number; savedAt: number; revision: string }
interface SnapshotRecord { revision: string; savedAt: number; snapshot: CachedRemoteSnapshot }
interface PageRecord { revision: string; savedAt: number; page: TreeMessagePage }
interface ViewRecord { revision: string; activeTrees: Record<string, string> }

function userPrefix(userId: string | undefined): string {
  return `u${SEP}${userId ?? ''}${SEP}`;
}
function connectionPrefix(userId: string | undefined, connectionId: string): string {
  return `${userPrefix(userId)}${connectionId}${SEP}`;
}
function snapshotKey(userId: string | undefined, connectionId: string): string {
  return `${connectionPrefix(userId, connectionId)}snapshot`;
}
function viewKey(userId: string | undefined, connectionId: string): string {
  return `${connectionPrefix(userId, connectionId)}view`;
}
function pageKey(userId: string | undefined, connectionId: string, workspaceId: string, treeId: string): string {
  return `${connectionPrefix(userId, connectionId)}page${SEP}${workspaceId}${SEP}${treeId}`;
}

function sizeOf(value: unknown): number {
  try { return JSON.stringify(value)?.length ?? 0; } catch { return Number.POSITIVE_INFINITY; }
}

export class RemoteSnapshotCache {
  /** Writes run one after another, so eviction always sees the last write. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: RemoteCacheStorage,
    private readonly options: { maxBytes?: number; pageLimit?: number; now?: () => number } = {},
  ) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private queue<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    const next = this.chain.then(work, work).catch(() => fallback);
    this.chain = next;
    return next;
  }

  /** What is kept for `connectionId`, whatever its revision (the caller compares it with the saved one). */
  readConnection(userId: string | undefined, connectionId: string): Promise<CachedRemoteConnection | null> {
    return (async () => {
      const [snapshot, view] = await Promise.all([
        this.storage.get(snapshotKey(userId, connectionId)),
        this.storage.get(viewKey(userId, connectionId)),
      ]);
      const snap = isRecord(snapshot) && typeof snapshot.revision === 'string' && isRecord(snapshot.snapshot)
        && Array.isArray((snapshot.snapshot as CachedRemoteSnapshot).workspaces) ? snapshot as unknown as SnapshotRecord : null;
      const views = isRecord(view) && typeof view.revision === 'string' && isRecord(view.activeTrees)
        ? view as unknown as ViewRecord : null;
      const revision = snap?.revision ?? views?.revision;
      if (revision === undefined) return null;
      return {
        revision,
        snapshot: snap?.snapshot ?? null,
        ...(snap ? { savedAt: snap.savedAt } : {}),
        activeTrees: views && views.revision === revision ? { ...views.activeTrees } as Record<string, string> : {},
      };
    })().catch(() => null);
  }

  readPage(userId: string | undefined, connectionId: string, revision: string, workspaceId: string, treeId: string): Promise<TreeMessagePage | null> {
    return (async () => {
      const record = await this.storage.get(pageKey(userId, connectionId, workspaceId, treeId));
      if (!isRecord(record) || record.revision !== revision || !isRecord(record.page)
        || !Array.isArray(record.page.messages)) return null;
      return (record as unknown as PageRecord).page;
    })().catch(() => null);
  }

  writeSnapshot(userId: string | undefined, connectionId: string, revision: string, snapshot: CachedRemoteSnapshot): Promise<void> {
    return this.queue(async () => {
      await this.adoptRevision(userId, connectionId, revision);
      const record: SnapshotRecord = { revision, savedAt: this.now(), snapshot };
      await this.put(snapshotKey(userId, connectionId), record, 'snapshot', revision);
      await this.evict(userId);
    }, undefined);
  }

  writePage(userId: string | undefined, connectionId: string, revision: string, workspaceId: string, treeId: string,
    page: TreeMessagePage): Promise<void> {
    return this.queue(async () => {
      await this.adoptRevision(userId, connectionId, revision);
      const record: PageRecord = { revision, savedAt: this.now(), page };
      await this.put(pageKey(userId, connectionId, workspaceId, treeId), record, 'page', revision);
      await this.evict(userId);
    }, undefined);
  }

  noteActiveTree(userId: string | undefined, connectionId: string, revision: string, workspaceId: string, treeId: string): Promise<void> {
    return this.queue(async () => {
      await this.adoptRevision(userId, connectionId, revision);
      const key = viewKey(userId, connectionId);
      const current = await this.storage.get(key);
      const activeTrees = isRecord(current) && current.revision === revision && isRecord(current.activeTrees)
        ? { ...current.activeTrees as Record<string, string> } : {};
      if (activeTrees[workspaceId] === treeId) return;
      activeTrees[workspaceId] = treeId;
      await this.put(key, { revision, activeTrees } satisfies ViewRecord, 'view', revision);
    }, undefined);
  }

  /** Drop everything kept for a connection (removed, or now pointing somewhere else). */
  clearConnection(userId: string | undefined, connectionId: string): Promise<void> {
    return this.queue(async () => {
      await this.storage.delete(await this.storage.keys(connectionPrefix(userId, connectionId)));
    }, undefined);
  }

  clearAll(): Promise<void> {
    return this.queue(() => this.storage.clear(), undefined);
  }

  private async put(key: string, value: unknown, kind: EntryKind, revision: string): Promise<void> {
    const size = sizeOf(value);
    // One response this large would push out everything else: keep none of it.
    if (size > (this.options.maxBytes ?? REMOTE_CACHE_MAX_BYTES) / 2) {
      await this.storage.delete([key, `${key}${META}`]);
      return;
    }
    await this.storage.set(key, value);
    await this.storage.set(`${key}${META}`, { kind, size, savedAt: this.now(), revision } satisfies EntryMeta);
  }

  /** A write under a new revision first drops what the old one left. */
  private async adoptRevision(userId: string | undefined, connectionId: string, revision: string): Promise<void> {
    const prefix = connectionPrefix(userId, connectionId);
    const metaKeys = (await this.storage.keys(prefix)).filter((key) => key.endsWith(META));
    const stale: string[] = [];
    for (const key of metaKeys) {
      const meta = await this.storage.get(key);
      if (!isRecord(meta) || meta.revision !== revision) stale.push(key, key.slice(0, -META.length));
    }
    if (stale.length > 0) await this.storage.delete(stale);
  }

  /** Keep this user's copy within the page count and byte budget, oldest pages going first. */
  private async evict(userId: string | undefined): Promise<void> {
    const metaKeys = (await this.storage.keys(userPrefix(userId))).filter((key) => key.endsWith(META));
    const entries: Array<EntryMeta & { key: string }> = [];
    for (const key of metaKeys) {
      const meta = await this.storage.get(key);
      if (isRecord(meta) && typeof meta.size === 'number' && typeof meta.savedAt === 'number') {
        entries.push({ ...(meta as unknown as EntryMeta), key: key.slice(0, -META.length) });
      }
    }
    const drop = new Set<string>();
    const pages = entries.filter((entry) => entry.kind === 'page').sort((a, b) => b.savedAt - a.savedAt);
    for (const page of pages.slice(this.options.pageLimit ?? REMOTE_CACHE_PAGE_LIMIT)) drop.add(page.key);
    let total = entries.reduce((sum, entry) => sum + (drop.has(entry.key) ? 0 : entry.size), 0);
    const maxBytes = this.options.maxBytes ?? REMOTE_CACHE_MAX_BYTES;
    const oldestFirst = [...entries].filter((entry) => entry.kind !== 'view')
      .sort((a, b) => (a.kind === b.kind ? a.savedAt - b.savedAt : a.kind === 'page' ? -1 : 1));
    for (const entry of oldestFirst) {
      if (total <= maxBytes) break;
      if (drop.has(entry.key)) continue;
      drop.add(entry.key);
      total -= entry.size;
    }
    if (drop.size > 0) await this.storage.delete([...drop].flatMap((key) => [key, `${key}${META}`]));
  }
}

/** @internal Exported for tests: a Map-backed store standing in for IndexedDB. */
export class MemoryRemoteCacheStorage implements RemoteCacheStorage {
  readonly values = new Map<string, unknown>();
  async get(key: string) { return structuredCloneSafe(this.values.get(key)); }
  async set(key: string, value: unknown) { this.values.set(key, structuredCloneSafe(value)); }
  async delete(keys: readonly string[]) { for (const key of keys) this.values.delete(key); }
  async keys(prefix: string) { return [...this.values.keys()].filter((key) => key.startsWith(prefix)); }
  async clear() { this.values.clear(); }
}

function structuredCloneSafe<T>(value: T): T {
  if (value === undefined) return value;
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T;
}

const DB_NAME = 'michi-remote-snapshots';
const STORE = 'entries';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export class IndexedDbRemoteCacheStorage implements RemoteCacheStorage {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another window upgrading the schema: let it, and reopen on the next call.
        db.onversionchange = () => { db.close(); this.db = null; };
        resolve(db);
      };
      request.onerror = () => { this.db = null; reject(request.error); };
      request.onblocked = () => { this.db = null; reject(new Error('remote snapshot cache is blocked')); };
    });
    return this.db;
  }

  async get(key: string): Promise<unknown> {
    const db = await this.open();
    return requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
  }

  async set(key: string, value: unknown): Promise<void> {
    const transaction = (await this.open()).transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(value, key);
    await transactionDone(transaction);
  }

  async delete(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const transaction = (await this.open()).transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    for (const key of keys) store.delete(key);
    await transactionDone(transaction);
  }

  async keys(prefix: string): Promise<string[]> {
    const db = await this.open();
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    const keys = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys(range));
    return keys.filter((key): key is string => typeof key === 'string');
  }

  async clear(): Promise<void> {
    const transaction = (await this.open()).transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).clear();
    await transactionDone(transaction);
  }
}

let defaultCache: RemoteSnapshotCache | null | undefined;

/** The app's cache on IndexedDB, or null where there is none (jsdom, private modes). */
export function defaultRemoteSnapshotCache(): RemoteSnapshotCache | null {
  if (defaultCache !== undefined) return defaultCache;
  const factory = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
  defaultCache = factory && typeof IDBKeyRange !== 'undefined'
    ? new RemoteSnapshotCache(new IndexedDbRemoteCacheStorage(factory))
    : null;
  return defaultCache;
}

/** Sign-out: nothing one user's remotes showed stays on this machine for the next. */
export async function clearRemoteSnapshotCache(): Promise<void> {
  await defaultRemoteSnapshotCache()?.clearAll();
}
