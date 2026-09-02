/**
 * Database Adapter — abstraction layer for multi-backend database support.
 *
 * Phase 1 (current): SQLite via better-sqlite3 (synchronous, single-file).
 * Phase 2 (future):  PostgreSQL via pg (async, multi-writer for horizontal scaling).
 *
 * The interface mirrors the better-sqlite3 synchronous API. The PostgreSQL
 * adapter (when implemented) would use worker_threads or a sync bridge to
 * maintain compatibility with the 401 existing call sites in db.ts.
 *
 * Selection:
 *   - No DATABASE_URL  → SQLite (default, backward compatible)
 *   - DATABASE_URL=postgresql://... → PostgreSQL (Phase 2, not yet implemented)
 *   - DATABASE_URL=sqlite://path/to.db → explicit SQLite path
 */

import { logger } from './logger.js';

export type DbValue = string | number | bigint | boolean | Uint8Array | null;

export interface PreparedStatement {
  /** Get a single row (or undefined). */
  get(...params: DbValue[]): Record<string, any> | undefined;
  /** Get all matching rows. */
  all(...params: DbValue[]): Record<string, any>[];
  /** Execute and return metadata. */
  run(...params: DbValue[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface DatabaseAdapter {
  /** Prepare (compile) a SQL statement. Implementations should cache. */
  prepare(sql: string): PreparedStatement;
  /** Execute raw SQL (DDL, PRAGMA, etc.). */
  exec(sql: string): void;
  /** Run a function inside a transaction. */
  transaction<T>(fn: () => T): T;
  /** Execute a PRAGMA and return the result. */
  pragma(name: string, value?: string): any;
  /** Close the connection. */
  close(): void;
  /** Check if the connection is live. */
  isHealthy(): boolean;
}

/** Determine which database backend to use based on environment. */
export function resolveDatabaseBackend(): 'sqlite' | 'postgresql' {
  const url = process.env.DATABASE_URL || '';
  if (url.startsWith('postgresql://') || url.startsWith('postgres://')) {
    return 'postgresql';
  }
  return 'sqlite';
}

/**
 * Factory: create the appropriate adapter.
 *
 * NOTE: PostgreSQL adapter is stubbed for Phase 2. When implemented, it will
 * use `pg` with a worker_thread sync bridge to maintain the synchronous
 * contract expected by db.ts's 401 functions.
 */
export async function createDatabaseAdapter(): Promise<DatabaseAdapter> {
  const backend = resolveDatabaseBackend();

  if (backend === 'postgresql') {
    logger.warn(
      'PostgreSQL backend selected via DATABASE_URL — not yet implemented (Phase 2). ' +
        'Falling back to SQLite.',
    );
    // Fall through to SQLite for now.
  }

  // SQLite (default) — no adapter wrapper needed, db.ts uses better-sqlite3 directly.
  // This factory exists for future Phase 2 where PostgreSQL is wired in.
  return null as unknown as DatabaseAdapter;
}

/**
 * Phase 2 stub: PostgreSQL adapter skeleton.
 *
 * Implementation plan (future):
 * 1. Import `pg.Pool`
 * 2. Use a worker_thread that blocks on pg queries, posting results back via MessageChannel
 * 3. Map SQL dialect differences:
 *    - sqlite-vec  → pgvector (CREATE EXTENSION vector; column type vector(1536))
 *    - FTS5        → pg_trgm + tsvector
 *    - AUTOINCREMENT → SERIAL / BIGSERIAL
 *    - PRAGMA      → SET (e.g. PRAGMA foreign_keys=ON → SET session_replication_role)
 *    - ?           → $1, $2, ... (parameterized placeholders)
 * 4. Migration script: sqlite3 .dump → psql
 */
export class PostgreSQLAdapter implements DatabaseAdapter {
  constructor(private _url: string) {}

  prepare(_sql: string): PreparedStatement {
    throw new Error('PostgreSQLAdapter not yet implemented (Phase 2)');
  }
  exec(_sql: string): void {
    throw new Error('PostgreSQLAdapter not yet implemented (Phase 2)');
  }
  transaction<T>(_fn: () => T): T {
    throw new Error('PostgreSQLAdapter not yet implemented (Phase 2)');
  }
  pragma(_name: string, _value?: string): any {
    throw new Error('PostgreSQLAdapter not yet implemented (Phase 2)');
  }
  close(): void {
    /* noop stub */
  }
  isHealthy(): boolean {
    return false;
  }
}
