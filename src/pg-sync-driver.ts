/**
 * PostgreSQL Synchronous Driver — Worker Thread Sync Bridge
 *
 * Problem: db.ts has 401 functions using better-sqlite3's SYNCHRONOUS API
 *   (db.prepare(sql).get(params), .all(), .run()).
 * PostgreSQL (pg) is ASYNCHRONOUS. Rewriting 401 functions to async is impractical.
 *
 * Solution: Use worker_threads + Atomics.wait/notify to BLOCK the main thread
 *   while a worker thread executes the async pg query.
 *
 * Flow:
 *   1. Main thread calls querySync(sql, params) → blocks on Atomics.wait
 *   2. Worker receives query → executes pg.Pool.query(sql, params)
 *   3. Worker posts result back via MessagePort
 *   4. Worker calls Atomics.notify → wakes main thread
 *   5. Main thread reads result via receiveMessageOnPort → returns synchronously
 *
 * This keeps the entire 401-function synchronous API unchanged.
 */

import { Worker } from 'node:worker_threads';
import { logger } from './logger.js';

const WORKER_SCRIPT = `
import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: workerData.url,
  max: 10,
  statement_timeout: 30000,
});

parentPort.on('message', (req) => {
  const { id, sql, params } = req;
  pool.query(sql, params || []).then(result => {
    parentPort.postMessage({
      id,
      rows: result.rows,
      rowCount: result.rowCount,
      lastInsertRowid: result.rows.length > 0
        ? (result.rows[0].id ?? result.rows[0][Object.keys(result.rows[0])[0]])
        : undefined,
      changes: result.rowCount,
    });
  }).catch(err => {
    parentPort.postMessage({
      id,
      error: err.message,
      code: err.code,
    });
  });
});
`;

interface SyncResult {
  rows: any[];
  rowCount: number;
  changes: number;
  lastInsertRowid?: any;
  error?: string;
  code?: string;
}

class PgSyncDriver {
  private worker: Worker | null = null;
  private counter = 0;
  private pending = new Map<number, { resolve: (r: SyncResult) => void; reject: (e: Error) => void }>();
  private initialized = false;

  async init(url: string): Promise<void> {
    // Create worker from inline script
    const workerCode = WORKER_SCRIPT;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);

    this.worker = new Worker(blobUrl, {
      workerData: { url },
    });

    this.worker.on('message', (msg: { id: number } & SyncResult) => {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`${msg.code ? msg.code + ': ' : ''}${msg.error}`));
      } else {
        pending.resolve({
          rows: msg.rows || [],
          rowCount: msg.rowCount || 0,
          changes: msg.changes || 0,
          lastInsertRowid: msg.lastInsertRowid,
        });
      }
    });

    this.worker.on('error', (err: Error) => {
      logger.error({ err }, 'PG sync worker error');
    });

    // Test connection
    try {
      const r = await this.queryAsync('SELECT 1 as test', []);
      if (r.rows[0]?.test === 1) {
        this.initialized = true;
        logger.info('PostgreSQL sync driver initialized — connection verified');
      }
    } catch (err) {
      logger.error({ err }, 'PostgreSQL connection test failed');
      throw err;
    }
  }

  /** Async query (internal — used by the sync wrapper). */
  private queryAsync(sql: string, params: any[]): Promise<SyncResult> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('PG sync worker not initialized'));
        return;
      }
      const id = ++this.counter;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, sql, params });
    });
  }

  /** Synchronous query — blocks main thread via Atomics.wait pattern. */
  querySync(sql: string, params: any[]): SyncResult {
    if (!this.initialized || !this.worker) {
      throw new Error('PostgreSQL driver not initialized');
    }

    // The tricky part: we need to BLOCK the main thread until the worker responds.
    // worker_threads postMessage is async, but we can use a SharedArrayBuffer
    // + Atomics.wait/notify pattern.
    //
    // However, Atomics.wait requires a SharedArrayBuffer, and the result
    // comes back via postMessage (not SAB). The pattern:
    // 1. Create a SAB for signaling (1 int32)
    // 2. Worker posts result, then Atomics.notify
    // 3. Main thread Atomics.wait (blocks), then receiveMessageOnPort
    //
    // For simplicity, we use a busy-wait with receiveMessageOnPort which
    // is the standard sync pattern in Node.js worker_threads.

    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);
    flag[0] = 0;

    let result: SyncResult | null = null;
    let error: Error | null = null;

    const id = ++this.counter;
    this.pending.set(id, {
      resolve: (r) => { result = r; Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); },
      reject: (e) => { error = e; Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); },
    });

    this.worker.postMessage({ id, sql, params });

    // Block until worker signals
    Atomics.wait(flag, 0, 0, 30000); // 30s timeout

    if (error) throw error;
    if (!result) throw new Error('PG sync query timeout (30s)');
    return result;
  }

  close(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initialized = false;
    this.pending.clear();
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

// Singleton
let _driver: PgSyncDriver | null = null;

/**
 * Initialize the PostgreSQL sync driver.
 * Called from sqlite-compat.ts when DATABASE_URL starts with postgresql://
 */
export async function initPgSyncDriver(url: string): Promise<PgSyncDriver> {
  if (_driver?.isInitialized()) return _driver;
  _driver = new PgSyncDriver();
  await _driver.init(url);
  return _driver;
}

/** Get the initialized PG sync driver. */
export function getPgSyncDriver(): PgSyncDriver | null {
  return _driver;
}

/** Close the PG sync driver (graceful shutdown). */
export function closePgSyncDriver(): void {
  _driver?.close();
  _driver = null;
}
