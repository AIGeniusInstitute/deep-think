/**
 * PostgreSQL Synchronous Driver — Worker Thread Sync Bridge
 *
 * Problem: db.ts has 401 functions using better-sqlite3's SYNCHRONOUS API
 *   (db.prepare(sql).get(params), .all(), .run()).
 * PostgreSQL (pg) is ASYNCHRONOUS. Rewriting 401 functions to async is impractical.
 *
 * Solution: Use worker_threads + a dedicated MessageChannel + Atomics.wait/notify
 *   to BLOCK the main thread while a worker thread executes the async pg query.
 *
 * Flow (querySync):
 *   1. Main thread creates a per-query SharedArrayBuffer (signal flag)
 *   2. Main posts {id, sql, params, sab} to the worker (over parentPort)
 *   3. Main Atomics.wait(flag) — BLOCKS the main thread (no event loop)
 *   4. Worker (own event loop) runs pg.Pool.query, posts result to the
 *      dedicated MessagePort, then Atomics.store(flag,1)+notify
 *   5. Main wakes, receiveMessageOnPort(port) reads the result synchronously
 *
 * CRITICAL: the result MUST come back via a MessagePort + receiveMessageOnPort,
 * NOT via worker.on('message'). The latter requires the main event loop, which
 * is FROZEN while Atomics.wait blocks — so the handler would never run and the
 * query would time out (the bug this rewrite fixes).
 */

import { Worker, type MessagePort, receiveMessageOnPort, MessageChannel } from 'node:worker_threads';
import { logger } from './logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory of this compiled module — used so the temp worker file can
 *  resolve `pg` (and other deps) from the app's node_modules. Writing to
 *  os.tmpdir() breaks ESM resolution because /tmp is outside /app. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const WORKER_SCRIPT = `
import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: workerData.url,
  max: 10,
  statement_timeout: 30000,
});

let syncPort = null;

function respond(msg, sync, sab) {
  if (sync && syncPort) {
    syncPort.postMessage(msg);
    if (sab) { Atomics.store(sab, 0, 1); Atomics.notify(sab, 0); }
  } else {
    parentPort.postMessage(msg);
  }
}

parentPort.on('message', (req) => {
  if (req.type === 'setup-port') {
    syncPort = req.port;
    parentPort.postMessage({ type: 'port-ready' });
    return;
  }
  const { id, sql, params, sync, sab } = req;
  pool.query(sql, params || []).then(result => {
    respond({
      id,
      rows: result.rows,
      rowCount: result.rowCount,
      lastInsertRowid: result.rows.length > 0
        ? (result.rows[0].id ?? result.rows[0][Object.keys(result.rows[0])[0]])
        : undefined,
      changes: result.rowCount,
    }, sync, sab);
  }).catch(err => {
    respond({ id, error: err.message, code: err.code }, sync, sab);
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
  private workerFile: string | null = null;
  private port1: MessagePort | null = null;
  private counter = 0;
  private pending = new Map<number, { resolve: (r: SyncResult) => void; reject: (e: Error) => void }>();
  private initialized = false;

  async init(url: string): Promise<void> {
    // Write the worker script to a real .mjs file under MODULE_DIR so:
    //  (a) Node accepts it as a Worker path (no blob: ERR_WORKER_PATH), and
    //  (b) \`import pg from 'pg'\` resolves from the app's node_modules.
    const workerFile = path.join(
      MODULE_DIR,
      `.pg-worker-${process.pid}-${Date.now()}.mjs`,
    );
    fs.writeFileSync(workerFile, WORKER_SCRIPT, 'utf8');
    this.workerFile = workerFile;

    this.worker = new Worker(workerFile, {
      workerData: { url },
    });

    // Dedicated MessageChannel for SYNC results (read via receiveMessageOnPort,
    // which works while the main thread is blocked in Atomics.wait). The async
    // path (queryAsync) still uses parentPort + worker.on('message').
    const { port1, port2 } = new MessageChannel();
    this.port1 = port1;

    await new Promise<void>((resolve, reject) => {
      if (!this.worker) { reject(new Error('worker gone')); return; }
      const onReady = (msg: any) => {
        if (msg?.type === 'port-ready') {
          this.worker?.off('message', onReady);
          resolve();
        }
      };
      this.worker.on('message', onReady);
      this.worker.on('error', reject);
      this.worker.postMessage({ type: 'setup-port', port: port2 }, [port2]);
    });

    this.worker.on('message', (msg: { id: number; type?: string } & SyncResult) => {
      // Async-path responses (queryAsync) arrive here; sync-path responses
      // arrive on port1 and are drained by receiveMessageOnPort.
      if (msg?.type === 'port-ready') return;
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

    // Test connection (async path)
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

  /** Async query (internal — used by the sync wrapper + init test). */
  private queryAsync(sql: string, params: any[]): Promise<SyncResult> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('PG sync worker not initialized'));
        return;
      }
      const id = ++this.counter;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, sql, params }); // sync:false → parentPort
    });
  }

  /** Synchronous query — blocks the main thread via Atomics.wait + receiveMessageOnPort. */
  querySync(sql: string, params: any[]): SyncResult {
    if (!this.initialized || !this.worker || !this.port1) {
      throw new Error('PostgreSQL driver not initialized');
    }

    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);
    flag[0] = 0;

    const id = ++this.counter;
    // sync:true → worker responds on the dedicated MessagePort + notifies the SAB
    this.worker.postMessage({ id, sql, params, sync: true, sab });

    // Block the main thread (event loop frozen) until the worker notifies.
    Atomics.wait(flag, 0, 0, 30000); // 30s timeout

    if (flag[0] === 0) {
      throw new Error('PG sync query timeout (30s)');
    }

    // Drain the result from the dedicated port synchronously (no event loop needed).
    const msg = receiveMessageOnPort(this.port1);
    if (!msg) {
      throw new Error('PG sync: no message after wake (port drained?)');
    }
    const m = msg.message as SyncResult & { id: number };
    if (m.error) {
      throw new Error(`${m.code ? m.code + ': ' : ''}${m.error}`);
    }
    return {
      rows: m.rows || [],
      rowCount: m.rowCount || 0,
      changes: m.changes || 0,
      lastInsertRowid: m.lastInsertRowid,
    };
  }

  close(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.port1) {
      try { this.port1.close(); } catch { /* best effort */ }
      this.port1 = null;
    }
    if (this.workerFile) {
      try { fs.unlinkSync(this.workerFile); } catch { /* best effort */ }
      this.workerFile = null;
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

export function getPgSyncDriver(): PgSyncDriver | null {
  return _driver;
}

export function closePgSyncDriver(): void {
  _driver?.close();
  _driver = null;
}
