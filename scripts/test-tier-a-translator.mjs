// Tier A verification: sql-translator output + real PG roundtrip.
import { translateSqliteToPg } from '../dist/sql-translator.js';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = actual.trim().replace(/\s+/g, ' ');
  const e = expected.trim().replace(/\s+/g, ' ');
  if (a === e) { pass++; console.log('  PASS', label); }
  else { fail++; console.log('  FAIL', label); console.log('    got:     ', a); console.log('    expected:', e); }
}

console.log('== A1: INSERT OR REPLACE → ON CONFLICT(pk) DO UPDATE ==');

// messages: PK (id, chat_jid) — all non-PK cols should be in SET
eq(
  translateSqliteToPg(`INSERT OR REPLACE INTO messages (id, chat_jid, content, timestamp, sender) VALUES (?, ?, ?, ?, ?)`),
  `INSERT INTO messages (id, chat_jid, content, timestamp, sender) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id, chat_jid) DO UPDATE SET content = excluded.content, timestamp = excluded.timestamp, sender = excluded.sender`,
  'messages upsert (id,chat_jid) PK excluded from SET'
);

// router_state: PK key — value should be in SET
eq(
  translateSqliteToPg(`INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)`),
  `INSERT INTO router_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  'router_state upsert'
);

// chats: PK jid
eq(
  translateSqliteToPg(`INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`),
  `INSERT INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', $1) ON CONFLICT (jid) DO UPDATE SET name = excluded.name, last_message_time = excluded.last_message_time`,
  'chats upsert'
);

// user_pinned_groups: PK (user_id, jid)
eq(
  translateSqliteToPg(`INSERT OR REPLACE INTO user_pinned_groups (user_id, jid, pinned_at) VALUES (?, ?, ?)`),
  `INSERT INTO user_pinned_groups (user_id, jid, pinned_at) VALUES ($1, $2, $3) ON CONFLICT (user_id, jid) DO UPDATE SET pinned_at = excluded.pinned_at`,
  'user_pinned_groups upsert'
);

// mcp_registry_tokens: PK user_id
eq(
  translateSqliteToPg(`INSERT OR REPLACE INTO mcp_registry_tokens (user_id, token, created_at) VALUES (?, ?, ?)`),
  `INSERT INTO mcp_registry_tokens (user_id, token, created_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`,
  'mcp_registry_tokens upsert'
);

console.log('== A1 fallback: INSERT OR IGNORE → DO NOTHING ==');
eq(
  translateSqliteToPg(`INSERT OR IGNORE INTO user_balances (user_id, balance) VALUES (?, ?)`),
  `INSERT INTO user_balances (user_id, balance) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
  'OR IGNORE → DO NOTHING'
);

console.log('== A1 fallback: unknown table OR REPLACE → DO NOTHING ==');
eq(
  translateSqliteToPg(`INSERT OR REPLACE INTO some_other (a, b) VALUES (?, ?)`),
  `INSERT INTO some_other (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
  'unknown table → DO NOTHING (no regression)'
);

console.log('== A1 fallback: no column list OR REPLACE ==');
eq(
  translateSqliteToPg(`INSERT OR REPLACE INTO t VALUES (?, ?)`),
  `INSERT INTO t VALUES ($1, $2) ON CONFLICT DO NOTHING`,
  'no-col-list → DO NOTHING'
);

console.log('== A1 fallback: multi-row OR REPLACE → DO NOTHING ==');
eq(
  translateSqliteToPg(`INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?), (?, ?)`),
  `INSERT INTO router_state (key, value) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING`,
  'multi-row → DO NOTHING'
);

console.log('== A3: date(col, "localtime") → substr ==');
eq(
  translateSqliteToPg(`SELECT date(created_at, 'localtime') AS d FROM usage_records GROUP BY date(created_at, 'localtime')`),
  `SELECT substr(created_at, 1, 10) AS d FROM usage_records GROUP BY substr(created_at, 1, 10)`,
  'date(localtime) → substr'
);

console.log(`\nTranslator unit: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
