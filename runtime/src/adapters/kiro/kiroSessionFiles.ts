import fs from 'node:fs';
import path from 'node:path';

/**
 * Kiro v3's own record of a native session, as kiro-cli 3.0.0 keeps it under
 * its config directory `<config>` (`~/.kiro`, or KIRO_HOME), seen in probes
 * P1 and P1b (DESIGN-v2 §3.2; v2/probes.md):
 * - `sessions/<hash>/sess_<uuid>/` holds `session.json` and `messages.jsonl`
 *   (the transcript);
 * - `sessions/<hash>/.index/index.json` caches the bucket's sessions, titles
 *   included: `{schemaVersion, walkedAtMs, dirMtimeMs, dirNamesHash,
 *   entries: [{id, title, workspacePaths, ...}]}`;
 * - `sessions/<hash>/.index/.lock` is empty and stays after kiro-cli exits:
 *   it says nothing about a live process;
 * - `session-index/<hash>.jsonl` is an append-only log of
 *   `{"op":"add"|"remove","sessionPath":"<hash>/sess_<uuid>","at":<ms>}`;
 *   Kiro's own session/delete appends the remove.
 * `<hash>` (16 hex characters) is derived from the workspace path.
 * `session.json` names the session's directory in `workspacePaths`; it has
 * no `cwd` key.
 */

/** A v3 native session id: `sess_<uuid>`. Nothing else is looked up on disk. */
export const KIRO_V3_SESSION_ID = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_DIR = /^[0-9a-f]{16}$/i;

/** What one config directory holds of a session. */
export interface KiroSessionTrace {
  /** Entries named after the session under `sessions/<hash>/`, of whatever kind. */
  dirs: Array<{ hash: string; dir: string }>;
  /** Buckets whose `.index/index.json` still lists the session (its title with it). */
  cached: string[];
  /** Buckets whose index log names the session at all, as added or removed. */
  logged: string[];
}

/**
 * Where `configDir` keeps (or kept) `sessionId`. Empty for an id that is not
 * `sess_<uuid>`. Read only; a file it cannot read counts as not there.
 */
export function kiroSessionTrace(configDir: string, sessionId: string): KiroSessionTrace {
  const trace: KiroSessionTrace = { dirs: [], cached: [], logged: [] };
  if (!KIRO_V3_SESSION_ID.test(sessionId)) return trace;
  const root = path.resolve(configDir);
  for (const hash of listNames(path.join(root, 'sessions'), true)) {
    const dir = path.join(root, 'sessions', hash, sessionId);
    try { fs.lstatSync(dir); trace.dirs.push({ hash, dir }); } catch { /* none */ }
    if (cachedEntry(path.join(root, 'sessions', hash, '.index', 'index.json'), sessionId) !== undefined) trace.cached.push(hash);
  }
  for (const name of listNames(path.join(root, 'session-index'), false)) {
    if (!name.endsWith('.jsonl') || !HASH_DIR.test(name.slice(0, -'.jsonl'.length))) continue;
    const hash = name.slice(0, -'.jsonl'.length);
    if (indexOps(path.join(root, 'session-index', name), `${hash}/${sessionId}`).length > 0) trace.logged.push(hash);
  }
  return trace;
}

/** A kiro-cli process as the store registry sees it (AcpClient.processRunning). */
export interface KiroStoreProcess {
  processRunning(): boolean;
}

/**
 * kiro-cli processes this process started on a config directory (resolved),
 * from spawn until their exit is seen, whichever runtime or worker owns them.
 */
const processesByStore = new Map<string, Set<KiroStoreProcess>>();

/** Counts a just-spawned kiro-cli whose child env set KIRO_HOME = `configDir` (AcpClient.start). */
export function trackKiroStoreProcess(configDir: string, kiroCli: KiroStoreProcess): void {
  const key = path.resolve(configDir);
  let processes = processesByStore.get(key);
  if (!processes) processesByStore.set(key, (processes = new Set()));
  processes.add(kiroCli);
}

/**
 * The kiro-cli processes started here on `configDir` that may still run,
 * stopping ones included: a check-in discard removes no session files under
 * a running kiro-cli (Kiro keeps no lock that would say so).
 */
export function runningKiroStoreProcesses<T extends KiroStoreProcess>(configDir: string): T[] {
  const key = path.resolve(configDir);
  const processes = processesByStore.get(key);
  if (!processes) return [];
  for (const kiroCli of [...processes]) if (!kiroCli.processRunning()) processes.delete(kiroCli);
  if (processes.size === 0) processesByStore.delete(key);
  return [...processes] as T[];
}

/** Whether `configDir` holds `sessionId`'s `session.json` (Kiro stored the session there). */
export function kiroSessionStored(configDir: string, sessionId: string): boolean {
  return kiroSessionTrace(configDir, sessionId).dirs.some(({ dir }) => {
    try { return fs.statSync(path.join(dir, 'session.json')).isFile(); } catch { return false; }
  });
}

export interface KiroSessionFilesDiscard {
  /** Kiro's config directory the session lived under (Michi: the check-in worker's KIRO_HOME). */
  configDir: string;
  sessionId: string;
  /** Whether a directory a session ran in is one the caller owns; every `workspacePaths` entry must be. */
  ownsWorkspace(dir: string): boolean;
}

/**
 * Removes one released session's record from Kiro's store the way Kiro's
 * own session/delete does: its session directory goes, its entry leaves the
 * bucket's index cache, and the index log gets a remove op. Only for a store
 * no kiro-cli process is using (the caller makes sure none runs; Kiro keeps
 * no lock that would say so). Answers:
 * - `unsupported`: an id that is not `sess_<uuid>`; a session this store
 *   has no trace of (it lives elsewhere, e.g. `~/.kiro`); or one whose
 *   `session.json` or cached entry is unreadable or names a directory the
 *   caller does not own. Nothing is removed.
 * - `absent`: this store had it and holds nothing of it any more.
 * - `discarded`: removed now.
 */
export function discardKiroSessionFiles(input: KiroSessionFilesDiscard): 'discarded' | 'absent' | 'unsupported' {
  if (!KIRO_V3_SESSION_ID.test(input.sessionId)) return 'unsupported';
  const root = path.resolve(input.configDir);
  const trace = kiroSessionTrace(root, input.sessionId);
  if (!trace.dirs.length && !trace.cached.length) return trace.logged.length ? 'absent' : 'unsupported';
  const owned = (workspaces: unknown) => Array.isArray(workspaces) && workspaces.length > 0
    && workspaces.every((entry) => typeof entry === 'string' && path.isAbsolute(entry) && input.ownsWorkspace(entry));
  // Check every copy before removing any.
  for (const { dir } of trace.dirs) {
    try {
      if (!fs.lstatSync(dir).isDirectory()) return 'unsupported';
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as { id?: unknown; workspacePaths?: unknown };
      if (parsed.id !== undefined && parsed.id !== input.sessionId) return 'unsupported';
      if (!owned(parsed.workspacePaths)) return 'unsupported';
    } catch {
      return 'unsupported';
    }
  }
  for (const hash of trace.cached) {
    const entry = cachedEntry(path.join(root, 'sessions', hash, '.index', 'index.json'), input.sessionId);
    if (!entry || !owned(entry.workspacePaths)) return 'unsupported';
  }
  const buckets = new Set<string>();
  for (const { hash, dir } of trace.dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
    buckets.add(hash);
  }
  for (const hash of trace.cached) {
    dropCachedEntry(path.join(root, 'sessions', hash, '.index', 'index.json'), input.sessionId);
    buckets.add(hash);
  }
  for (const hash of buckets) {
    const log = path.join(root, 'session-index', `${hash}.jsonl`);
    const ops = indexOps(log, `${hash}/${input.sessionId}`);
    if (ops.length > 0 && ops[ops.length - 1] === 'remove') continue;
    fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
    fs.appendFileSync(log, `${JSON.stringify({ op: 'remove', sessionPath: `${hash}/${input.sessionId}`, at: Date.now() })}\n`, { mode: 0o600 });
  }
  return 'discarded';
}

function listNames(dir: string, directories: boolean): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => directories ? entry.isDirectory() && HASH_DIR.test(entry.name) : entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The ops (`add`, `remove`, or another) the index log records for `sessionPath`, in order. */
function indexOps(file: string, sessionPath: string): string[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const ops: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes(sessionPath)) continue;
    try {
      const parsed = JSON.parse(line) as { op?: unknown; sessionPath?: unknown };
      if (parsed.sessionPath === sessionPath) ops.push(typeof parsed.op === 'string' ? parsed.op : '');
    } catch { /* a torn line */ }
  }
  return ops;
}

interface CachedEntry { id?: unknown; workspacePaths?: unknown }

/**
 * The bucket cache's entry for the session; null when the cache names it but
 * cannot be read as Kiro writes it; undefined when it does not name it.
 */
function cachedEntry(file: string, sessionId: string): CachedEntry | null | undefined {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  if (!text.includes(sessionId)) return undefined;
  try {
    const entries = (JSON.parse(text) as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return null;
    const entry = entries.find((item) => (item as CachedEntry | null)?.id === sessionId) as CachedEntry | undefined;
    return entry ?? null;
  } catch {
    return null;
  }
}

/** Rewrites the bucket cache without the session's entry; Kiro re-walks a bucket whose directory changed. */
function dropCachedEntry(file: string, sessionId: string): void {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: CachedEntry[] };
  parsed.entries = parsed.entries.filter((item) => item?.id !== sessionId);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(parsed), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
