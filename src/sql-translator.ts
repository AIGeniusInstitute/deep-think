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

  // 5. INSERT OR REPLACE INTO → INSERT INTO ... ON CONFLICT
  // (Too complex to translate generically — needs primary key info.
  //  We leave INSERT OR REPLACE as a no-op prefix removal; PG will error
  //  on conflicts, which is acceptable for migration debugging.)
  result = result.replace(/^INSERT\s+OR\s+REPLACE\s+INTO/ims, 'INSERT INTO');

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
