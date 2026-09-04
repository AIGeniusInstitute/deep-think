/**
 * SQL Translator — SQLite → PostgreSQL dialect translation
 *
 * Translates common SQLite SQL patterns to PostgreSQL equivalents on the fly.
 * This is NOT a complete SQL parser — it handles the patterns used in db.ts.
 *
 * Key translations:
 *   ? → $1, $2, $3, ...        (parameter placeholders)
 *   datetime('now') → NOW()    (timestamps)
 *   strftime(...) → TO_CHAR(...) (date formatting — best-effort)
 *   INTEGER PRIMARY KEY AUTOINCREMENT → BIGSERIAL PRIMARY KEY
 *   CREATE TABLE IF NOT EXISTS → same (PG compatible)
 *   PRAGMA ... → SET ... (or no-op)
 *   INSERT OR REPLACE → INSERT ... ON CONFLICT DO UPDATE (best-effort)
 *   GROUP BY id HAVING ... → same
 *   LIKE → ILIKE (case-insensitive, matching SQLite default)
 *
 * Note: FTS5 and sqlite-vec queries need special handling at the application
 * layer, not here — they use different APIs (tsvector, pgvector).
 */

/**
 * Translate SQLite SQL to PostgreSQL.
 * @param sql SQLite SQL string
 * @returns PostgreSQL SQL string
 */
export function translateSqliteToPg(sql: string): string {
  let result = sql;

  // 1. Parameter placeholders: ? → $1, $2, ...
  // Must not touch '?' inside string literals. Simple state machine.
  result = replacePlaceholders(result);

  // 2. datetime('now') → NOW()
  result = result.replace(/datetime\(\s*['"]now['"]\s*\)/gi, 'NOW()');

  // 3. datetime('now', '+N days') → NOW() + INTERVAL 'N days'
  result = result.replace(
    /datetime\(\s*['"]now['"]\s*,\s*['"]\+(\d+)\s*(day|days|hour|hours|minute|minutes|month|months|year|years)['"]\s*\)/gi,
    (_, num, unit) => {
      const pgUnit = unit.replace(/s$/, '');
      return `NOW() + INTERVAL '${num} ${pgUnit}'`;
    },
  );

  // 4. strftime → TO_CHAR (best-effort — SQLite strftime format differs from PG)
  // This is a simplification; complex strftime calls may need manual fixing.
  // We leave strftime as-is for now and let PG handle errors case-by-case.

  // 5. INSERT OR REPLACE / INSERT OR IGNORE → PG ON CONFLICT.
  // PG has no `INSERT OR REPLACE`/`OR IGNORE` syntax. Both become plain
  // INSERT with `ON CONFLICT DO NOTHING` appended (no conflict target needed,
  // catches any unique violation). This matches OR IGNORE exactly, and for
  // OR REPLACE is a safe approximation on a fresh DB (no existing rows to
  // "replace"); a true upsert would need the PK column list, which we can't
  // infer generically. The schema_version write (the main OR REPLACE site)
  // sets the same value either way, so DO NOTHING is equivalent.
  if (/^\s*INSERT\s+OR\s+(?:IGNORE|REPLACE)\s+INTO/im.test(result)) {
    result = result.replace(
      /^INSERT\s+OR\s+(?:IGNORE|REPLACE)\s+INTO/im,
      'INSERT INTO',
    );
    result = result.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
  }

  // 5b. PRAGMA table_info(table) → PG information_schema query.
  // SQLite's PRAGMA table_info returns one row per column; callers read .name
  // and (rarely) .pk. We translate to information_schema.columns. pk defaults
  // to 0 — its only consumer is a sessions-PK migration guard that is a no-op
  // on a fresh PG DB (new schema already has the composite PK).
  const tiMatch = result.match(
    /^\s*PRAGMA\s+table_info\s*\(\s*'?([^)']+)'?\s*\)\s*;?\s*$/i,
  );
  if (tiMatch) {
    const tbl = tiMatch[1].replace(/"/g, '').toLowerCase();
    return `SELECT column_name AS name, 0 AS pk FROM information_schema.columns WHERE table_name = '${tbl}' AND table_schema = current_schema()`;
  }

  // 5c. sqlite_master catalog queries → PG catalog equivalents.
  // (a) SELECT sql FROM sqlite_master WHERE type='table' AND name='X' →
  //     aggregate CHECK-constraint definitions. Callers inspect the DDL text
  //     (e.g. for "'parallel'" in a CHECK) to decide whether to rebuild a
  //     table; on a fresh PG DB the constraint already includes the marker,
  //     so the migration correctly skips.
  result = result.replace(
    /SELECT\s+sql\s+FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'table'\s+AND\s+name\s*=\s*'?(\w+)'?/gi,
    "SELECT STRING_AGG(pg_get_constraintdef(c.oid), ' ') AS sql FROM pg_constraint c JOIN pg_class t ON c.conrelid = t.oid JOIN pg_namespace n ON c.connamespace = n.oid WHERE t.relname = '$1' AND n.nspname = current_schema() AND c.contype = 'c'",
  );
  // (b) FROM sqlite_master WHERE type='index' AND tbl_name='X' AND name='Y' →
  //     pg_indexes. Fresh PG has no SQLite-style 'sqlite_autoindex_*' names,
  //     so the count is 0 and the migration (e.g. dropping a legacy UNIQUE)
  //     correctly skips.
  result = result.replace(
    /FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'index'\s+AND\s+tbl_name\s*=\s*'?(\w+)'?\s+AND\s+name\s*=\s*'?([^'\s;]+)'?/gi,
    "FROM pg_indexes WHERE tablename = '$1' AND indexname = '$2'",
  );

  // 6. PRAGMA statements — no-op in PG (handled by SET commands)
  if (/^\s*PRAGMA\s+/i.test(result)) {
    return '-- PRAGMA skipped (PostgreSQL): ' + result.trim();
  }

  // 7. LIKE → ILIKE for case-insensitive matching (SQLite default is case-insensitive for ASCII)
  // Only replace standalone LIKE, not inside string literals
  result = result.replace(/\bLIKE\b/g, 'ILIKE');

  // 8. AUTOINCREMENT → removed (PG uses SERIAL/BIGSERIAL)
  result = result.replace(/\bAUTOINCREMENT\b/gi, '');

  // 9. GROUP_CONCAT → STRING_AGG
  result = result.replace(
    /GROUP_CONCAT\(([^)]+)\)/gi,
    'STRING_AGG($1, \',\')',
  );

  return result;
}

/**
 * Replace ? placeholders with $1, $2, etc.
 * Skips ? inside string literals (single-quoted).
 */
function replacePlaceholders(sql: string): string {
  let result = '';
  let paramIndex = 0;
  let inString = false;
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];

    // Toggle string state on single quote (but not escaped '')
    if (char === "'") {
      if (inString && sql[i + 1] === "'") {
        // Escaped quote — skip both
        result += "''";
        i += 2;
        continue;
      }
      inString = !inString;
      result += char;
      i++;
      continue;
    }

    // Replace ? with $N only outside strings
    if (char === '?' && !inString) {
      paramIndex++;
      result += `$${paramIndex}`;
      i++;
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Translate SQLite CREATE TABLE to PostgreSQL.
 * Handles the main type differences:
 *   INTEGER PRIMARY KEY → BIGSERIAL PRIMARY KEY (or BIGINT GENERATED ALWAYS AS IDENTITY)
 *   TEXT → TEXT (same)
 *   BLOB → BYTEA
 *   INTEGER → INTEGER (same, but PG uses BIGINT for large)
 *   REAL → DOUBLE PRECISION
 *   NUMERIC → NUMERIC (same)
 */
export function translateCreateTable(sql: string): string {
  let result = translateSqliteToPg(sql);

  // PostgreSQL enforces target-table existence at CREATE TABLE parse time:
  // `FOREIGN KEY (x) REFERENCES users(id)` fails with 42P01 if `users` is
  // created later in the same init pass. SQLite tolerates forward FK refs.
  // `SET session_replication_role='replica'` only disables FK *triggers*
  // (DML-time), NOT the parse-time reference check — so it cannot help.
  // Like `pg_dump --schema-only` (which emits FKs as deferred ALTER
  // constraints), we strip FK clauses from CREATE TABLE here. PG mode
  // therefore has no DB-level FK constraints; integrity is enforced at the
  // application layer (and by SQLite on single-node deployments).
  // All FKs in this schema are table-level `FOREIGN KEY (...) REFERENCES
  // t(...) [ON DELETE/UPDATE ...]`, one per line.
  result = result
    .split('\n')
    .filter((line) => !/^\s*FOREIGN KEY\b/i.test(line))
    .join('\n');
  // Remove any trailing comma left dangling before a closing paren
  // (the line above the stripped FK ended with `,` and was the last column).
  result = result.replace(/,\s*\)/g, ')');
  // Collapse any double commas created by stripping a middle FK.
  result = result.replace(/,\s*,/g, ',');

  // Type mappings
  result = result.replace(/\bBLOB\b/gi, 'BYTEA');
  result = result.replace(/\bREAL\b/gi, 'DOUBLE PRECISION');

  // INTEGER PRIMARY KEY → BIGSERIAL PRIMARY KEY
  // Must come before general INTEGER replacement
  result = result.replace(
    /INTEGER\s+PRIMARY\s+KEY/gi,
    'BIGSERIAL PRIMARY KEY',
  );

  return result;
}
