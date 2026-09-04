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
  // PG has no `INSERT OR REPLACE`/`OR IGNORE` syntax.
  //  - INSERT OR IGNORE → `INSERT INTO ... ON CONFLICT DO NOTHING` (exact match).
  //  - INSERT OR REPLACE → a true upsert: `INSERT INTO ... ON CONFLICT (pk)
  //    DO UPDATE SET <non-pk cols> = excluded.<col>`. This requires the table's
  //    conflict-target columns (PK/UNIQUE), which we can't infer generically —
  //    so we keep an explicit registry of the tables used with OR REPLACE in
  //    db.ts. For tables not in the registry, OR REPLACE falls back to
  //    `ON CONFLICT DO NOTHING` (the old approximation — no regression).
  //    We only transform the single-row `VALUES (...)` form; multi-row or
  //    column-less INSERTs fall back too.
  //    Why this matters: the two hottest write paths use OR REPLACE —
  //    storeMessageInsert (messages, draft→finalize same id) and
  //    setRouterState (router_state cursor, same key per batch). With
  //    `ON CONFLICT DO NOTHING` they would silently skip the update, leaving
  //    stale drafts and a frozen cursor → duplicate message processing.
  result = translateInsertOrReplace(result);

  // 5a. date(col, 'localtime') → substr(col, 1, 10).
  // SQLite `date(X, 'localtime')` returns the local date of an ISO-text
  // timestamp. Columns here store ISO-8601 TEXT (e.g. created_at). PG has no
  // `date(text, 'localtime')` form. `substr(col, 1, 10)` extracts the leading
  // `YYYY-MM-DD` from the ISO text identically in both backends — sufficient for
  // the GROUP-BY-date usage reports that are the only consumers
  // (getOpenPlatformUsage). The `'localtime'` second arg is dropped (the stored
  // text already carries its wall-clock value). Single-arg `date(col)` is left
  // untouched (PG accepts `date(timestamp)`).
  result = result.replace(
    /\bdate\(\s*([^,)]+?)\s*,\s*['"]localtime['"]\s*\)/gi,
    'substr($1, 1, 10)',
  );

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
 * Conflict-target registry for tables used with `INSERT OR REPLACE` in db.ts.
 * Maps table name → array of PK/UNIQUE columns that serve as the ON CONFLICT
 * target. Only tables listed here get a true upsert; others fall back to
 * `ON CONFLICT DO NOTHING` (no regression vs. the old behavior).
 * PK definitions (from db.ts CREATE TABLE):
 *   messages            : PRIMARY KEY (id, chat_jid)
 *   router_state        : key TEXT PRIMARY KEY
 *   chats               : jid TEXT PRIMARY KEY
 *   registered_groups   : jid TEXT PRIMARY KEY
 *   user_pinned_groups   : PRIMARY KEY (user_id, jid)
 *   mcp_registry_tokens  : user_id TEXT PRIMARY KEY
 */
const UPSERT_CONFLICT_TARGETS: Record<string, string[]> = {
  messages: ['id', 'chat_jid'],
  router_state: ['key'],
  chats: ['jid'],
  registered_groups: ['jid'],
  user_pinned_groups: ['user_id', 'jid'],
  mcp_registry_tokens: ['user_id'],
};

/**
 * Translate `INSERT OR REPLACE INTO t (cols) VALUES (...)` into a true PG
 * upsert `INSERT INTO t (cols) VALUES (...) ON CONFLICT (pk) DO UPDATE SET
 * <non-pk cols> = excluded.<col>`. Falls back to `ON CONFLICT DO NOTHING`
 * when: the statement is OR IGNORE (not OR REPLACE); the table is absent from
 * the registry; the INSERT has no explicit column list; or the VALUES clause
 * is multi-row / cannot be matched.
 *
 * `INSERT OR REPLACE` in SQLite means "delete the existing row and insert the
 * new one" — i.e. every listed column takes the new value. The PG equivalent
 * is `ON CONFLICT (pk) DO UPDATE SET <each non-pk listed col> = excluded.<col>`,
 * which writes exactly the new values for all listed non-PK columns (matching
 * SQLite's replace semantics for listed columns).
 */
function translateInsertOrReplace(sql: string): string {
  // Fast path: not an OR-INSERT — leave untouched.
  if (!/^\s*INSERT\s+OR\s+(?:IGNORE|REPLACE)\s+INTO/im.test(sql)) return sql;

  // Attempt to match the explicit column-list form.
  const head = /^\s*INSERT\s+OR\s+(IGNORE|REPLACE)\s+INTO\s+([\w"]+)\s*\(([^]*)$/is.exec(sql);
  if (!head) {
    // No column list (e.g. `INSERT OR REPLACE INTO t VALUES (...)`) — can't
    // build a targeted upsert; fall back to DO NOTHING (old behavior).
    return stripOrPrefix(sql) + ' ON CONFLICT DO NOTHING';
  }

  const [, modeRaw, tableRaw, rest] = head;
  const table = tableRaw.replace(/"/g, '').toLowerCase();
  const mode = modeRaw.toUpperCase();

  // The column list is everything up to the first `)` that closes the col list.
  // `rest` starts right after the opening `(` of the column list.
  // Find the matching close paren of the column list (columns contain no
  // nested parens, so the first `)` at depth 0 is it).
  let depth = 1;
  let i = 0;
  let colListEnd = -1;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) { colListEnd = i; break; }
    }
    i++;
  }
  if (colListEnd === -1) {
    // No explicit column list matched → fall back to DO NOTHING.
    return stripOrPrefix(sql) + ' ON CONFLICT DO NOTHING';
  }

  const colListRaw = rest.slice(0, colListEnd);
  const afterCols = rest.slice(colListEnd + 1); // should start with ` VALUES (...)`

  // OR IGNORE → always DO NOTHING (exact SQLite semantics).
  if (mode === 'IGNORE') {
    return `INSERT INTO ${tableRaw} (${colListRaw})${afterCols} ON CONFLICT DO NOTHING`;
  }

  // OR REPLACE → try true upsert. Need table in registry + single-row VALUES.
  const targetCols = UPSERT_CONFLICT_TARGETS[table];
  if (!targetCols) {
    return `INSERT INTO ${tableRaw} (${colListRaw})${afterCols} ON CONFLICT DO NOTHING`;
  }

  // Parse column names (trim, drop quotes, lowercase for comparison).
  const cols = colListRaw.split(',').map((c) => c.trim().replace(/"/g, ''));
  if (cols.length === 0 || cols.some((c) => !/^[a-z_][a-z0-9_]*$/i.test(c))) {
    return `INSERT INTO ${tableRaw} (${colListRaw})${afterCols} ON CONFLICT DO NOTHING`;
  }
  const colsLower = cols.map((c) => c.toLowerCase());

  // Only transform single-row `VALUES (...)`. Detect multi-row via top-level
  // `)` followed by `,` followed by `(` after the VALUES group.
  const valuesMatch = /^\s*VALUES\s*\(/i.exec(afterCols);
  if (!valuesMatch) {
    return `INSERT INTO ${tableRaw} (${colListRaw})${afterCols} ON CONFLICT DO NOTHING`;
  }
  const valuesStart = valuesMatch.index! + valuesMatch[0].length;
  let vd = 1;
  let j = valuesStart;
  let valuesEnd = -1;
  while (j < afterCols.length) {
    const ch = afterCols[j];
    if (ch === '(') vd++;
    else if (ch === ')') {
      vd--;
      if (vd === 0) { valuesEnd = j; break; }
    }
    j++;
  }
  if (valuesEnd === -1) {
    return `INSERT INTO ${tableRaw} (${colListRaw})${afterCols} ON CONFLICT DO NOTHING`;
  }
  const afterValues = afterCols.slice(valuesEnd + 1);
  // Multi-row if another group follows.
  if (/^\s*,\s*\(/i.test(afterValues)) {
    return `INSERT INTO ${tableRaw} (${colListRaw})${afterCols} ON CONFLICT DO NOTHING`;
  }

  // Build the SET clause: every listed column that is NOT part of the conflict
  // target gets `<col> = excluded.<col>`. Listed conflict-target columns are
  // not assigned (they'd violate the conflict). If all listed columns are PK
  // (nothing to update), use DO NOTHING.
  const setCols = colsLower.filter((c) => !targetCols.includes(c));
  if (setCols.length === 0) {
    return `INSERT INTO ${tableRaw} (${colListRaw})${afterCols} ON CONFLICT (${targetCols.join(', ')}) DO NOTHING`;
  }
  const setClause = setCols.map((c) => `${c} = excluded.${c}`).join(', ');
  return `INSERT INTO ${tableRaw} (${colListRaw})${afterCols} ON CONFLICT (${targetCols.join(', ')}) DO UPDATE SET ${setClause}`;
}

function stripOrPrefix(sql: string): string {
  return sql.replace(/^\s*INSERT\s+OR\s+(?:IGNORE|REPLACE)\s+INTO/ims, 'INSERT INTO');
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
