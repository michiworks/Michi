import path from 'node:path';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import type { NodeGroupedResult, SearchRequest, SearchResult } from '../routes/search';
import { getDbPath } from './db';
import { log } from './logger';

declare const __MICHIBUNDLE__: boolean | undefined;

/**
 * Message search (routes/search.ts) runs on read-only worker connections
 * (searchWorker.ts), so a broad query occupies a worker, not the backend.
 * At most LANES queries run at once and QUEUE_LIMIT more wait; past that a
 * search is refused. A caller waits at most WAIT_MS, queue included.
 * node:sqlite cannot interrupt a query, so a caller that stops waiting leaves
 * its query to run to the end, and its lane stays taken until then.
 */
const LANES = 2;
const QUEUE_LIMIT = 8;
const WAIT_MS = 10_000;

export class SearchLimitError extends Error {
  constructor(readonly code: 'search_too_broad' | 'search_busy', message: string) {
    super(message);
  }
}

type SearchOutput<R extends SearchRequest> = R extends { kind: 'grouped' } ? NodeGroupedResult[] : SearchResult[];

interface Job {
  request: SearchRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  detach?: () => void;
  /** The caller has its answer or has stopped waiting: a later result is dropped. */
  settled: boolean;
}

interface Lane { worker: Worker; job: Job | null }

export class SearchReader {
  private lanes: Lane[] = [];
  private queue: Job[] = [];
  private closed = false;

  constructor(readonly dbPath: string, private readonly options: {
    workerFactory?: (dbPath: string) => Worker;
    waitMs?: number;
    lanes?: number;
    queueLimit?: number;
  } = {}) {}

  run<R extends SearchRequest>(request: R, signal?: AbortSignal): Promise<SearchOutput<R>> {
    if (this.closed) return Promise.reject(new Error('Search reader is closed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const laneFree = this.lanes.some((lane) => !lane.job) || this.lanes.length < (this.options.lanes ?? LANES);
    if (!laneFree && this.queue.length >= (this.options.queueLimit ?? QUEUE_LIMIT)) {
      return Promise.reject(busy());
    }
    return new Promise((resolve, reject) => {
      const job: Job = { request, resolve: resolve as (value: unknown) => void, reject, settled: false };
      const waitMs = this.options.waitMs ?? WAIT_MS;
      job.timer = setTimeout(() => {
        if (this.dequeue(job)) {
          this.settle(job, { error: busy() });
          return;
        }
        log.warn('http', 'search exceeded its wait limit', { kind: request.kind, waitMs });
        this.settle(job, { error: new SearchLimitError('search_too_broad',
          `The search was still running after ${waitMs / 1000} s: the query is too broad. Use more specific words, or search one workspace.`) });
      }, waitMs);
      if (signal) {
        const abort = () => { this.dequeue(job); this.settle(job, { error: signal.reason }); };
        signal.addEventListener('abort', abort, { once: true });
        job.detach = () => signal.removeEventListener('abort', abort);
      }
      this.queue.push(job);
      this.pump();
    });
  }

  /** Rejects what waits and stops the workers. A worker inside a query exits when the query ends. */
  async close(): Promise<void> {
    this.closed = true;
    const stopped = new Error('Search reader stopped');
    for (const job of this.queue.splice(0)) this.settle(job, { error: stopped });
    const lanes = this.lanes.splice(0);
    for (const lane of lanes) if (lane.job) this.settle(lane.job, { error: stopped });
    await Promise.all(lanes.map((lane) => lane.worker.terminate().catch(() => {})));
  }

  private pump(): void {
    while (!this.closed && this.queue.length > 0) {
      let lane = this.lanes.find((candidate) => !candidate.job);
      if (!lane) {
        if (this.lanes.length >= (this.options.lanes ?? LANES)) return;
        try {
          lane = this.startLane();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          for (const job of this.queue.splice(0)) this.settle(job, { error: failure });
          return;
        }
      }
      const job = this.queue.shift()!;
      lane.job = job;
      lane.worker.ref();
      lane.worker.postMessage(job.request);
    }
  }

  private startLane(): Lane {
    const bundled = typeof __MICHIBUNDLE__ !== 'undefined' && __MICHIBUNDLE__;
    const worker = this.options.workerFactory?.(this.dbPath) ?? new Worker(path.join(__dirname, bundled ? 'searchWorker.js' : 'searchWorker.ts'), {
      workerData: { dbPath: this.dbPath },
      // The owner filter reads MICHI_CLOUD in the worker, as it did on the main thread.
      env: SHARE_ENV,
      ...(!bundled ? { execArgv: ['--require', 'ts-node/register/transpile-only'] } : {}),
    });
    const lane: Lane = { worker, job: null };
    this.lanes.push(lane);
    worker.on('message', (message: { result?: unknown; error?: string; durationMs: number }) => {
      const job = lane.job;
      if (!job) return;
      lane.job = null;
      worker.unref();
      if (job.settled) {
        log.info('http', 'search finished after its caller stopped waiting', { kind: job.request.kind, durationMs: Math.round(message.durationMs) });
      } else {
        this.settle(job, message.error !== undefined ? { error: new Error(message.error) } : { value: message.result });
      }
      this.pump();
    });
    worker.on('error', (error) => this.dropLane(lane, error));
    worker.on('exit', (code) => this.dropLane(lane, new Error(`Search worker exited (${code})`)));
    return lane;
  }

  private dropLane(lane: Lane, error: Error): void {
    const index = this.lanes.indexOf(lane);
    if (index === -1) return;
    this.lanes.splice(index, 1);
    if (lane.job) this.settle(lane.job, { error });
    lane.job = null;
    void lane.worker.terminate().catch(() => {});
    this.pump();
  }

  private dequeue(job: Job): boolean {
    const index = this.queue.indexOf(job);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    return true;
  }

  private settle(job: Job, outcome: { error: Error } | { value: unknown }): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.detach?.();
    if ('error' in outcome) job.reject(outcome.error); else job.resolve(outcome.value);
  }
}

function busy(): SearchLimitError {
  return new SearchLimitError('search_busy', 'Search is busy with other searches. Try again in a moment.');
}

let reader: SearchReader | null = null;

/** Runs `request` on the search workers of the current data.db. */
export function runSearch<R extends SearchRequest>(request: R, signal?: AbortSignal): Promise<SearchOutput<R>> {
  const dbPath = getDbPath();
  if (reader?.dbPath !== dbPath) {
    void reader?.close();
    reader = new SearchReader(dbPath);
  }
  return reader.run(request, signal);
}

/** Server shutdown: does not wait for a query that is still running. */
export function stopSearchReader(): void {
  const previous = reader;
  reader = null;
  void previous?.close();
}
