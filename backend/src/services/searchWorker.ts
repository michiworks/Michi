import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { runSearchRequest, type SearchRequest } from '../routes/search';

if (!parentPort) throw new Error('Search must run in a worker');
// Read-only: the main connection owns migrations and writes.
const database = new DatabaseSync(workerData.dbPath, { readOnly: true });
database.exec('PRAGMA query_only=ON');
database.exec('PRAGMA busy_timeout=1000');
parentPort.on('message', (request: SearchRequest) => {
  const started = performance.now();
  try {
    // The grouped search's statements (matches, titles, breadcrumbs) read one snapshot.
    database.exec('BEGIN');
    const result = runSearchRequest(request, database);
    database.exec('COMMIT');
    parentPort!.postMessage({ result, durationMs: performance.now() - started });
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* BEGIN may have failed */ }
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error), durationMs: performance.now() - started });
  }
});
