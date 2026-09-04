// Tier A real-PG integration: verify upsert + cursor update + lastInsertRowid + date substr.
import { initPgSyncDriver, getPgSyncDriver, closePgSyncDriver } from '../dist/pg-sync-driver.js';
import { translateSqliteToPg } from '../dist/sql-translator.js';

const URL = 'postgresql://deepthink:deepthink123@localhost:5433/deepthink';
let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log('  PASS', label); }
  else { fail++; console.log('  FAIL', label); }
}

// Run a SQLite-dialect SQL through translate + sync driver (mirrors PgDatabase.prepare path).
function run(sql, params = []) {
  const t = translateSqliteToPg(sql);
  return getPgSyncDriver().querySync(t, params);
}

await initPgSyncDriver(URL);
console.log('PG sync driver initialized');

// Fresh test tables (drop to allow re-runs).
for (const t of ['messages', 'router_state', 't_serial', 'usage_records']) {
  getPgSyncDriver().querySync(`DROP TABLE IF EXISTS ${t}`, []);
}

getPgSyncDriver().querySync(
  `CREATE TABLE messages (id TEXT, chat_jid TEXT, content TEXT, source_kind TEXT, PRIMARY KEY(id, chat_jid))`, []);
getPgSyncDriver().querySync(
  `CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT)`, []);
getPgSyncDriver().querySync(
  `CREATE TABLE t_serial (id BIGSERIAL PRIMARY KEY, name TEXT)`, []);
getPgSyncDriver().querySync(
  `CREATE TABLE usage_records (id TEXT, source TEXT, input_tokens INT, cost_usd REAL, created_at TEXT)`, []);

console.log('\n== A1: messages draft→finalize upsert ==');
// SQLite INSERT OR REPLACE path (same id+chat_jid, SDK finalize pattern)
run(`INSERT OR REPLACE INTO messages (id, chat_jid, content, source_kind) VALUES (?, ?, ?, ?)`,
    ['m1', 'c1', 'draft', 'sdk_draft']);
run(`INSERT OR REPLACE INTO messages (id, chat_jid, content, source_kind) VALUES (?, ?, ?, ?)`,
    ['m1', 'c1', 'final', 'sdk_final']);
let r = run(`SELECT content, source_kind FROM messages WHERE id = ? AND chat_jid = ?`, ['m1', 'c1']);
check(r.rows.length === 1, 'exactly one message row (upsert replaced, not duplicated)');
check(r.rows[0].content === 'final', 'content updated draft→final (true upsert, not DO NOTHING skip)');
check(r.rows[0].source_kind === 'sdk_final', 'source_kind updated');

console.log('\n== A1: router_state cursor same-key update ==');
run(`INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)`, ['cursor', 't1']);
run(`INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)`, ['cursor', 't2']);
let rc = run(`SELECT value FROM router_state WHERE key = ?`, ['cursor']);
check(rc.rows.length === 1, 'single cursor row');
check(rc.rows[0].value === 't2', 'cursor advanced t1→t2 (not frozen at t1)');

console.log('\n== A2: lastInsertRowid via RETURNING * ==');
let ri = run(`INSERT INTO t_serial (name) VALUES (?)`, ['alice']);
const id = ri.lastInsertRowid;
check(typeof id === 'number' && id > 0, `lastInsertRowid is real positive number (got ${id}), not 0/undefined`);
let rf = run(`SELECT name FROM t_serial WHERE id = ?`, [id]);
check(rf.rows[0]?.name === 'alice', `row recoverable by returned id=${id}`);

console.log('\n== A3: getOpenPlatformUsage date substr grouping ==');
// Insert two rows on different ISO dates.
run(`INSERT INTO usage_records (id, source, input_tokens, cost_usd, created_at) VALUES (?, 'open-platform', 100, 0.5, ?)`,
    ['u1', '2026-09-04T10:00:00Z']);
run(`INSERT INTO usage_records (id, source, input_tokens, cost_usd, created_at) VALUES (?, 'open-platform', 200, 0.7, ?)`,
    ['u2', '2026-09-05T11:00:00Z']);
let ru = run(
  `SELECT date(created_at, 'localtime') AS d, COUNT(*) AS c, COALESCE(SUM(input_tokens),0) AS t FROM usage_records WHERE source = 'open-platform' GROUP BY date(created_at, 'localtime') ORDER BY d ASC`);
check(ru.rows.length === 2, `grouped into 2 days (got ${ru.rows.length}) — date(localtime) translated, no PG error`);
check(ru.rows[0].d === '2026-09-04', `first group date substr'd correctly (got ${ru.rows[0]?.d})`);

console.log('\n== A3: exact production getOpenPlatformUsage shape (alias AS date) ==');
let rp = run(
  `SELECT date(created_at, 'localtime') AS date, COUNT(*) AS requests FROM usage_records WHERE source = 'open-platform' AND date(created_at, 'localtime') >= ? GROUP BY date(created_at, 'localtime') ORDER BY date ASC`,
  ['2026-09-01']);
check(rp.rows.length === 2, `production-shape query runs on PG (got ${rp.rows.length} rows)`);
check(rp.rows[0].date === '2026-09-04', `production-shape first date correct (got ${rp.rows[0]?.date})`);

console.log(`\nReal-PG integration: ${pass} pass, ${fail} fail`);
closePgSyncDriver();
process.exit(fail > 0 ? 1 : 0);
