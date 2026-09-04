/**
 * SQLite 兼容层：支持三种后端
 *
 * 1. Bun → bun:sqlite (Bun runtime)
 * 2. Node + SQLite → better-sqlite3 (默认, 单进程/单机)
 * 3. Node + PostgreSQL → pg sync driver (多 Pod 水平扩缩容)
 *
 * 选择逻辑:
 *   - DATABASE_URL 以 postgresql:// 或 postgres:// 开头 → PostgreSQL sync driver
 *   - Bun 运行时 → bun:sqlite
 *   - 其他 → better-sqlite3
 *
 * PostgreSQL 模式下,所有 better-sqlite3 同步 API (prepare/get/all/run/exec/transaction)
 * 通过 worker_thread + Atomics 同步桥保持同步语义,401 个 db.ts 函数无需改写。
 * SQL 方言差异通过 sql-translator.ts 在运行时翻译。
 */

import { translateSqliteToPg, translateCreateTable } from './sql-translator.js';
import { getPgSyncDriver, closePgSyncDriver } from './pg-sync-driver.js';

const isBun = typeof (globalThis as any).Bun !== 'undefined';

const DATABASE_URL = process.env.DATABASE_URL || '';
const usePostgres =
  DATABASE_URL.startsWith('postgresql://') || DATABASE_URL.startsWith('postgres://');

/** True when running on the PostgreSQL sync-driver backend (multi-pod cloud mode). */
export const isPostgresBackend = usePostgres && !isBun;

let DatabaseConstructor: new (path: string) => any;

if (usePostgres && !isBun) {
  // ─── PostgreSQL sync driver mode ───
  DatabaseConstructor = createPgDatabaseClass();
} else if (isBun) {
  // 动态字符串阻止 tsc 尝试解析 bun:sqlite 模块
  const modName = 'bun:sqlite';
  const mod = await import(modName);
  DatabaseConstructor = mod.Database;
} else {
  const mod = await import('better-sqlite3');
  DatabaseConstructor = mod.default;
}

export default DatabaseConstructor;

// ─── PostgreSQL Database Wrapper (sync API via worker_threads) ───

function createPgDatabaseClass(): new (path: string) => any {
  /**
   * PostgreSQL Database — wraps the sync driver to provide
   * better-sqlite3-compatible API.
   *
   * Note: `path` parameter is ignored; connection is via DATABASE_URL.
   */
  return class PgDatabase {
    constructor(_path: string) {
      // Driver must be initialized BEFORE initDatabase() —
      // index.ts main() calls initPgSyncDriver() before initDatabase()
      // when DATABASE_URL is set to postgresql://.
      // We use the singleton from pg-sync-driver.ts.
    }

    private getDriver(): any {
      // Access the singleton driver (already initialized by index.ts)
      const driver = getPgSyncDriver();
      if (!driver?.isInitialized()) {
        throw new Error(
          'PostgreSQL sync driver not initialized. ' +
            'Ensure initPgSyncDriver() is called before initDatabase().',
        );
      }
      return driver;
    }

    prepare(sql: string): PgStatement {
      const pgSql = translateSqliteToPg(sql);
      return new PgStatement(pgSql, this);
    }

    exec(sql: string): void {
      const isCreate = /^\s*CREATE\s+TABLE/i.test(sql);
      let pgSql: string;
      if (isCreate) {
        pgSql = translateCreateTable(sql);
      } else {
        pgSql = translateSqliteToPg(sql);
        // ALTER TABLE ADD COLUMN may carry SQLite types (BLOB/REAL) that PG
        // rejects (42704 "type blob does not exist"). Map them here — exec
        // is DDL-only (CREATE/ALTER/PRAGMA), so this never touches row data.
        pgSql = pgSql.replace(/\bBLOB\b/gi, 'BYTEA');
        pgSql = pgSql.replace(/\bREAL\b/gi, 'DOUBLE PRECISION');
        // INTEGER PRIMARY KEY already handled by translateCreateTable for CREATE;
        // for ALTER ADD COLUMN, map plain INTEGER → BIGINT (ms-timestamp safety).
        pgSql = pgSql.replace(/\bINTEGER\b/gi, 'BIGINT');
      }
      if (pgSql.trim().startsWith('--')) return; // Skip PRAGMA comments
      this.getDriver().querySync(pgSql, []);
    }

    transaction(fn: (...args: any[]) => void): (...args: any[]) => void {
      // Match better-sqlite3 semantics: return a callable wrapper that runs
      // fn inside BEGIN/COMMIT. This supports both idioms used in db.ts:
      //   db.transaction(() => {})()        // IIFE
      //   const tx = db.transaction(fn); tx(arg)
      return (...args: any[]) => {
        this.getDriver().querySync('BEGIN', []);
        try {
          const result = fn(...args);
          this.getDriver().querySync('COMMIT', []);
          return result;
        } catch (err) {
          try {
            this.getDriver().querySync('ROLLBACK', []);
          } catch {
            /* ignore rollback failure */
          }
          throw err;
        }
      };
    }

    pragma(name: string, _value?: string): any {
      const map: Record<string, string> = {
        journal_mode: '',
        foreign_keys: 'SET session_replication_role',
        busy_timeout: 'SET statement_timeout',
      };
      const pgCmd = map[name.toLowerCase()];
      if (pgCmd && _value !== undefined) {
        try { this.getDriver().querySync(`${pgCmd} = ${_value}`, []); } catch { /* ignore */ }
      }
      return undefined;
    }

    close(): void {
      closePgSyncDriver();
    }
  };
}

/**
 * PostgreSQL Prepared Statement — mirrors better-sqlite3's sync API.
 * Each call to get()/all()/run() blocks via the sync driver.
 */
class PgStatement {
  constructor(private sql: string, private db: any) {}

  get(...params: any[]): any | undefined {
    const result = this.db.getDriver().querySync(this.sql, params);
    return result.rows?.[0];
  }

  all(...params: any[]): any[] {
    const result = this.db.getDriver().querySync(this.sql, params);
    return result.rows || [];
  }

  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.db.getDriver().querySync(this.sql, params);
    return {
      changes: result.changes || 0,
      lastInsertRowid: result.lastInsertRowid ?? 0,
    };
  }
}
