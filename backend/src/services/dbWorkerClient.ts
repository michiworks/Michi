/**
 * Database Worker Client
 *
 * Async interface to the database worker thread. The main Express thread
 * calls these functions instead of the synchronous originals, freeing the
 * event loop while SQLite writes execute on the worker.
 *
 * Usage:
 *   import { initDbWorker, dbWorker } from './dbWorkerClient';
 *   await initDbWorker(dbPath);         // once at startup
 *   const result = await dbWorker.ensureDurableGraphNode(input);
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { EnsureDurableGraphNodeInput, EnsureDurableGraphNodeResult, GraphNodePresence } from './graphCommands';
import { graphNodePresence, recordEnsuredGraphNode } from './graphCommands';
import type { TreeRowChange } from './graphCommandTypes';
import { currentStructureOrigin, runWithStructureOrigin } from './structureEvents';
import type { DurableTurnSnapshot } from 'michi-shared';
import { DomainError, type SerializedDomainError } from './domainErrors';

declare const __MICHIBUNDLE__: boolean | undefined;

let _worker: Worker | null = null;
let _nextId = 1;
const _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let _readyPromise: Promise<void> | null = null;
let _rejectReady: ((error: Error) => void) | null = null;
let _ready = false;

/**
 * Resolve the worker thread entry point.
 *
 * Dev (ts-node): __dirname = .../backend/src/services, file = dbWorkerThread.ts.
 * Bundled: esbuild flattens to dist/server.js, so __dirname = .../backend/dist.
 * The build script needs to emit a separate bundle for the worker entry point
 * at dist/dbWorkerThread.js.
 */
function resolveWorkerPath(): string {
  const bundled = typeof __MICHIBUNDLE__ !== 'undefined' && __MICHIBUNDLE__;
  if (bundled) {
    return path.join(__dirname, 'dbWorkerThread.js');
  }
  // Dev mode: run the TS file directly via ts-node's require hook.
  return path.join(__dirname, 'dbWorkerThread.ts');
}

/** Fail the current generation only: late exit events from a stopped worker
 * must not clear a replacement or reject its requests. Writes are never replayed. */
function clearWorker(worker: Worker, error: Error): void {
  if (_worker !== worker) return;
  _worker = null;
  _ready = false;
  _readyPromise = null;
  const rejectReady = _rejectReady;
  _rejectReady = null;
  rejectReady?.(error);
  for (const [, callback] of _pending) callback.reject(error);
  _pending.clear();
}

export function initDbWorker(dbPath: string): Promise<void> {
  if (_readyPromise) return _readyPromise;

  const workerPath = resolveWorkerPath();
  const isTsFile = workerPath.endsWith('.ts');
  let worker: Worker;
  try {
    worker = new Worker(workerPath, {
      workerData: { dbPath },
      // Dev uses the same transpilation-only model as the esbuild watcher. The
      // workspace typecheck covers this entry point; rechecking its complete
      // imported type graph on each worker start delays readiness under load.
      ...(isTsFile ? { execArgv: ['--require', 'ts-node/register/transpile-only'] } : {}),
    });
  } catch (error) {
    // Keep initialization failures on the promise path used by startup fallback.
    return Promise.reject(error);
  }
  _worker = worker;
  _ready = false;
  _readyPromise = new Promise((resolve, reject) => {
    _rejectReady = reject;
    worker.on('message', (msg: { type?: string; id?: number; result?: unknown; error?: string; domainError?: SerializedDomainError }) => {
      if (_worker !== worker) return;
      if (msg.type === 'ready') {
        _ready = true;
        _rejectReady = null;
        resolve();
        return;
      }
      if (msg.id !== undefined) {
        const callback = _pending.get(msg.id);
        if (callback) {
          _pending.delete(msg.id);
          if (msg.error) {
            callback.reject(msg.domainError
              ? new DomainError(msg.domainError.kind, msg.domainError.code, msg.error)
              : new Error(msg.error));
          } else {
            callback.resolve(msg.result);
          }
        }
      }
    });
    worker.on('error', error => clearWorker(worker, error));
    worker.on('exit', code => clearWorker(worker, new Error(`dbWorker exited with code ${code}`)));
  });
  return _readyPromise;
}

/**
 * `jsonFallback`: args that structured clone refuses (a function, a class
 * the clone cannot carry) go as a JSON copy instead, as every snapshot did
 * before; other args reject.
 */
function rpc<T>(command: string, args: unknown, opts: { jsonFallback?: boolean } = {}): Promise<T> {
  const worker = _worker;
  if (!worker || !_ready) {
    return Promise.reject(new Error('dbWorker not ready — await initDbWorker() first'));
  }
  const id = _nextId++;
  return new Promise<T>((resolve, reject) => {
    _pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    try {
      try {
        worker.postMessage({ id, command, args });
      } catch (error) {
        if (!opts.jsonFallback || (error as Error | null)?.name !== 'DataCloneError') throw error;
        worker.postMessage({ id, command, args: JSON.parse(JSON.stringify(args)) });
      }
    } catch (error) {
      // Nothing was sent, so no reply will settle it.
      _pending.delete(id);
      reject(error);
    }
  });
}

/**
 * A turn snapshot goes as it is: postMessage's structured clone is the copy.
 * Making a JSON copy here first cost 68 s of main-thread time in 18 h
 * (11-09 performance audit P1-5), about 18 ms for a 1.8 MB snapshot. The
 * rows written are the same: the core serializes each column to JSON
 * itself, and durableMessageMetadata stores metadata of undefined values
 * as none, as the JSON copy did.
 */
function snapshotRpc<T>(command: 'beginTurn' | 'checkpointTurn' | 'finalizeTurn', snapshot: DurableTurnSnapshot): Promise<T> {
  return rpc<T>(command, snapshot, { jsonFallback: true });
}

export async function shutdownDbWorker(): Promise<void> {
  const worker = _worker;
  if (!worker) return;
  clearWorker(worker, new Error('dbWorker stopped'));
  await worker.terminate();
}

/** Whether the worker is alive and ready for commands. */
export function isDbWorkerReady(): boolean {
  return _worker !== null && _ready;
}

// ── Public async command API ───────────────────────────────────────────────

export const dbWorker = {
  /**
   * Async version of graphCommands.ensureDurableGraphNode().
   * Runs on the worker thread — does NOT block the Express event loop.
   */
  ensureDurableGraphNode(
    input: EnsureDurableGraphNodeInput,
  ): Promise<EnsureDurableGraphNodeResult> {
    // The worker operates on plain JSON — strip class instances.
    // The input type is already a plain data interface, but we round-trip
    // through JSON to be safe (e.g. undefined → null).
    const payload = JSON.parse(JSON.stringify(input));
    let before: GraphNodePresence | null = null;
    try { before = graphNodePresence(input); } catch { /* malformed input: the worker rejects it */ }
    // A caller applying a window's own payload tags this write as it would a
    // synchronous one; that scope has ended by the time the worker commits.
    const origin = currentStructureOrigin();
    return rpc<EnsureDurableGraphNodeResult & { treeChange: TreeRowChange | null }>(
      'ensureDurableGraphNode', payload,
    ).then(({ treeChange, ...result }) => {
      // Resolved after the worker committed: tell other windows what it changed.
      if (before) {
        const presence = before;
        try { runWithStructureOrigin(origin, () => recordEnsuredGraphNode(input, presence, treeChange)); } catch { /* best effort */ }
      }
      return result;
    });
  },

  /**
   * Async version of persistResumeBinding from michi.ts.
   * Await this before acknowledging session creation or releasing its restore lock.
   */
  persistResumeBinding(args: {
    nodeId: string;
    acp_session_id: string;
    runtime_id: string;
    runtime_engine?: string | null;
    provider_id: string | null;
    model_id: string | null;
    reasoning: string | null;
    resume_fingerprint: string | null;
    current_mode_id: string | null;
  }): Promise<void> {
    return rpc<void>('persistResumeBinding', args);
  },

  /** Health check. */
  ping(): Promise<string> {
    return rpc<string>('ping', null);
  },

  /**
   * Async version of dbRepository.beginTurn().
   * Runs on the worker thread — does NOT block the Express event loop.
   */
  beginTurn(snapshot: DurableTurnSnapshot): Promise<void> {
    return snapshotRpc<void>('beginTurn', snapshot);
  },

  /**
   * Async version of dbRepository.checkpointTurn(), resolving the bytes it
   * rewrote (turnPersistence.core coreCheckpointTurn) for checkpoint pacing.
   */
  checkpointTurn(snapshot: DurableTurnSnapshot): Promise<{ payloadBytes: number | null }> {
    return snapshotRpc<{ payloadBytes: number | null }>('checkpointTurn', snapshot);
  },

  /**
   * Async version of dbRepository.finalizeTurn().
   * Must await — the caller needs the durability guarantee before broadcasting done.
   */
  finalizeTurn(snapshot: DurableTurnSnapshot): Promise<void> {
    return snapshotRpc<void>('finalizeTurn', snapshot);
  },
};
