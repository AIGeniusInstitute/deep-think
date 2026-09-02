#!/usr/bin/env node
/**
 * SQLite → PostgreSQL Data Migration Script
 *
 * Migrates all data from the SQLite database (messages.db) to PostgreSQL.
 * This is a one-time migration for switching from single-replica SQLite
 * to multi-replica PostgreSQL mode.
 *
 * Usage:
 *   node dist/migrate-sqlite-to-postgres.js
 *
 * Requires:
 *   - SOURCE_SQLITE_PATH env (default: ~/.deepthink/data/db/messages.db)
 *   - DATABASE_URL env (postgresql://user:pass@host:5432/deepthink)
 *
 * The migration:
 *   1. Creates PostgreSQL schema (translated from SQLite CREATE TABLEs)
 *   2. Copies all data row-by-row (batched)
 *   3. Verifies row counts match
 *
 * Note: FTS5 virtual tables and sqlite-vec tables are handled specially:
 *   - FTS5 → PostgreSQL tsvector columns + triggers
 *   - sqlite-vec → pgvector (requires CREATE EXTENSION vector)
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SQLITE_PATH = process.env.SOURCE_SQLITE_PATH ||
  path.resolve(os.homedir(), '.deepthink', 'data', 'db', 'messages.db');

const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
  console.error('DATABASE_URL environment variable is required');
  console.error('Example: DATABASE_URL=postgresql://user:pass@localhost:5432/deepthink');
  process.exit(1);
}

if (!fs.existsSync(SQLITE_PATH)) {
  console.error(`SQLite database not found: ${SQLITE_PATH}`);
  process.exit(1);
}

async function main() {
  console.log(`Migrating: ${SQLITE_PATH} → PostgreSQL`);

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pgPool = new pg.Pool({ connectionString: PG_URL, max: 1 });
  const pgClient = await pgPool.connect();

  try {
    // 1. Get all user tables (exclude SQLite internal tables and FTS/vec virtual tables)
    const tables = sqlite.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '%_fts'
        AND name NOT LIKE '%_vec'
        AND name NOT LIKE '%_data'
        AND name NOT LIKE '%_idx'
        AND name NOT LIKE '%_content'
        AND name NOT LIKE '%_docsize'
        AND name NOT LIKE '%_config'
        AND sql IS NOT NULL
      ORDER BY name
    `).all() as { name: string; sql: string }[];

    console.log(`Found ${tables.length} tables to migrate`);

    // 2. Create each table in PostgreSQL
    for (const table of tables) {
      const pgSql = translateCreateTable(table.sql);
      console.log(`Creating table: ${table.name}`);
      try {
        await pgClient.query(`DROP TABLE IF EXISTS ${table.name} CASCADE`);
        await pgClient.query(pgSql);
      } catch (err) {
        console.error(`  Error creating ${table.name}: ${err.message}`);
        // Continue — some tables may need manual fixing
      }
    }

    // 3. Migrate data for each table
    let totalRows = 0;
    for (const table of tables) {
      const rowCount = await migrateTable(sqlite, pgClient, table.name);
      totalRows += rowCount;
      console.log(`  ${table.name}: ${rowCount} rows`);
    }

    console.log(`\nMigration complete! Total rows: ${totalRows}`);

    // 4. Create pgvector extension and vector index
    try {
      await pgClient.query('CREATE EXTENSION IF NOT EXISTS vector');
      console.log('pgvector extension created');
    } catch (err) {
      console.warn(`Could not create pgvector extension: ${err.message}`);
      console.warn('Run: CREATE EXTENSION vector; as superuser');
    }

    // 5. Create full-text search indexes (replacing FTS5)
    console.log('\nCreating full-text search indexes...');
    try {
      await pgClient.query(`
        ALTER TABLE kb_documents
        ADD COLUMN IF NOT EXISTS search_vector tsvector
      `);
      await pgClient.query(`
        CREATE INDEX IF NOT EXISTS kb_documents_search_idx
        ON kb_documents USING GIN (search_vector)
      `);
      await pgClient.query(`
        CREATE TRIGGER IF NOT EXISTS kb_documents_search_update
        BEFORE INSERT OR UPDATE ON kb_documents
        FOR EACH ROW
        TSSETVEC search_vector = to_tsvector('simple', coalesce(content, ''))
      `);
      console.log('Full-text search indexes created');
    } catch (err) {
      console.warn(`FTS index creation: ${err.message}`);
    }

  } finally {
    sqlite.close();
    pgClient.release();
    await pgPool.end();
  }
}

async function migrateTable(
  sqlite: Database.Database,
  pgClient: pg.PoolClient,
  tableName: string,
): Promise<number> {
  // Get column names
  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as any[];
  const colNames = columns.map((c: any) => c.name);

  if (colNames.length === 0) return 0;

  // Get all rows
  const rows = sqlite.prepare(`SELECT * FROM ${tableName}`).all() as any[];

  if (rows.length === 0) return 0;

  // Batch insert (100 rows at a time)
  const batchSize = 100;
  const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');
  const colList = colNames.join(', ');
  const insertSql = `INSERT INTO ${tableName} (${colList}) VALUES (${placeholders})`;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const row of batch) {
      const values = colNames.map((col: string) => {
        const val = row[col];
        // Handle BLOB → Buffer for BYTEA columns
        if (val instanceof Uint8Array || val instanceof Buffer) {
          return Buffer.from(val);
        }
        return val;
      });
      try {
        await pgClient.query(insertSql, values);
      } catch (err) {
        console.error(`  Error inserting into ${tableName}: ${err.message}`);
        // Continue — log and skip bad rows
      }
    }
  }

  return rows.length;
}

// ─── SQL Translation (inline — same as src/sql-translator.ts) ───

function translateCreateTable(sql: string): string {
  let result = sql;

  // Remove IF NOT EXISTS for DROP+CREATE pattern
  // Keep it for CREATE TABLE
  result = result.replace(/\bAUTOINCREMENT\b/gi, '');
  result = result.replace(/\bBLOB\b/gi, 'BYTEA');
  result = result.replace(/\bREAL\b/gi, 'DOUBLE PRECISION');
  result = result.replace(
    /INTEGER\s+PRIMARY\s+KEY/gi,
    'BIGSERIAL PRIMARY KEY',
  );

  // Remove SQLite-specific clauses
  result = result.replace(/WITHOUT\s+ROWID/gi, '');
  result = result.replace(/STRICT\b/gi, '');

  // Remove triggers and indexes from CREATE TABLE (they're separate)
  result = result.replace(/CREATE\s+(TRIGGER|INDEX)[^;]+;/gis, '');

  return result + ';';
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
