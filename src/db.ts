import crypto from 'crypto';
import { createRequire } from 'module';
import Database from './sqlite-compat.js';
import fs from 'fs';
import path from 'path';

import { STORE_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import {
  AgentKind,
  AgentStatus,
  AuthAuditLog,
  AuthEventType,
  BalanceOperatorType,
  BalanceReferenceType,
  BalanceTransaction,
  BalanceTransactionSource,
  BalanceTransactionType,
  BillingAuditEventType,
  BillingAuditLog,
  BillingPlan,
  DailyUsage,
  ExecutionMode,
  GroupMember,
  InviteCode,
  InviteCodeWithCreator,
  MessageFinalizationReason,
  MonthlyUsage,
  NewMessage,
  MessageCursor,
  MessageSourceKind,
  ImContextBinding,
  RedeemCode,
  RegisteredGroup,
  ScheduledTask,
  SubAgent,
  TaskRunLog,
  User,
  UserBalance,
  UserPublic,
  UserStatus,
  UserRole,
  UserSubscription,
  UserSession,
  UserSessionWithUser,
  Permission,
  PermissionTemplateKey,
} from './types.js';
import { getDefaultPermissions, normalizePermissions } from './permissions.js';

let db: InstanceType<typeof Database>;
let vecExtensionLoaded = false;

/** Access the initialized database instance. */
export function getDb(): InstanceType<typeof Database> {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function isVecExtensionLoaded(): boolean {
  return vecExtensionLoaded;
}

export function vecVersion(): string | null {
  if (!vecExtensionLoaded) return null;
  try {
    const r = db.prepare('SELECT vec_version() as v').get() as { v: string } | undefined;
    return r?.v ?? null;
  } catch {
    return null;
  }
}

// Prepared statement cache — lazy-initialized on first use after initDatabase()
let _stmts: {
  storeMessageSelect: any;
  storeMessageInsert: any;
  insertUsageInsert: any;
  insertUsageUpsert: any;
  getSessionWithUser: any;
  deleteSession: any;
  updateSessionLastActive: any;
  updateTokenUsageById: any;
  updateTokenUsageLatest: any;
  getMessagesSince: any;
  getExpiredSessionIds: any;
} | null = null;

const _newMsgStmtCache = new Map<number, any>();

function stmts() {
  if (!_stmts) {
    _stmts = {
      storeMessageSelect: db.prepare(
        `SELECT id FROM messages
         WHERE chat_jid = ? AND turn_id = ? AND source_kind = 'sdk_final'
         ORDER BY timestamp DESC LIMIT 1`,
      ),
      storeMessageInsert: db.prepare(
        `INSERT OR REPLACE INTO messages (
          id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me,
          attachments, token_usage, turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason, task_id, autonomous
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertUsageInsert: db.prepare(
        `INSERT INTO usage_records (id, user_id, group_folder, agent_id, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertUsageUpsert: db.prepare(
        `INSERT INTO usage_daily_summary (user_id, model, date,
          total_input_tokens, total_output_tokens,
          total_cache_read_tokens, total_cache_creation_tokens,
          total_cost_usd, request_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
        ON CONFLICT(user_id, model, date) DO UPDATE SET
          total_input_tokens = total_input_tokens + excluded.total_input_tokens,
          total_output_tokens = total_output_tokens + excluded.total_output_tokens,
          total_cache_read_tokens = total_cache_read_tokens + excluded.total_cache_read_tokens,
          total_cache_creation_tokens = total_cache_creation_tokens + excluded.total_cache_creation_tokens,
          total_cost_usd = total_cost_usd + excluded.total_cost_usd,
          request_count = request_count + 1,
          updated_at = datetime('now')`,
      ),
      getSessionWithUser: db.prepare(
        `SELECT s.*, u.username, u.role, u.status, u.display_name, u.permissions, u.must_change_password
         FROM user_sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = ?`,
      ),
      deleteSession: db.prepare('DELETE FROM user_sessions WHERE id = ?'),
      updateSessionLastActive: db.prepare(
        'UPDATE user_sessions SET last_active_at = ? WHERE id = ?',
      ),
      updateTokenUsageById: db.prepare(
        `UPDATE messages SET token_usage = ?, cost_usd = ? WHERE id = ? AND chat_jid = ?`,
      ),
      updateTokenUsageLatest: db.prepare(
        `UPDATE messages SET token_usage = ?, cost_usd = ?
         WHERE rowid = (
           SELECT rowid FROM messages
           WHERE chat_jid = ? AND is_from_me = 1 AND token_usage IS NULL
             AND COALESCE(source_kind, 'legacy') != 'sdk_send_message'
           ORDER BY timestamp DESC LIMIT 1
         )`,
      ),
      getMessagesSince: db.prepare(
        `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, attachments, task_id, autonomous
         FROM messages
         WHERE chat_jid = ? AND (timestamp > ? OR (timestamp = ? AND id > ?)) AND is_from_me = 0
         ORDER BY timestamp ASC, id ASC`,
      ),
      getExpiredSessionIds: db.prepare(
        'SELECT id FROM user_sessions WHERE expires_at < ?',
      ),
    };
  }
  return _stmts;
}

function getNewMessagesStmt(jidCount: number): any {
  let s = _newMsgStmtCache.get(jidCount);
  if (!s) {
    const placeholders = Array(jidCount).fill('?').join(',');
    s = db.prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, attachments, task_id, autonomous
       FROM messages
       WHERE (timestamp > ? OR (timestamp = ? AND id > ?))
         AND chat_jid IN (${placeholders})
         AND is_from_me = 0
         AND COALESCE(source_kind, '') NOT IN ('user_command', 'scheduled_task_prompt')
       ORDER BY timestamp ASC, id ASC`,
    );
    // Cap cache size to avoid unbounded growth in deployments where the
    // distinct jidCount values shift over time. better-sqlite3 does not
    // explicitly require finalization for prepared statements (it relies on
    // GC), so dropping the reference is safe. 64 entries covers any plausible
    // workload (the cache key is # of jids polled in one batch, normally 1..32).
    if (_newMsgStmtCache.size >= 64) {
      const firstKey = _newMsgStmtCache.keys().next().value as
        | number
        | undefined;
      if (firstKey !== undefined) _newMsgStmtCache.delete(firstKey);
    }
    _newMsgStmtCache.set(jidCount, s);
  } else {
    // touch — LRU: re-insert to move to end (Map preserves insertion order).
    _newMsgStmtCache.delete(jidCount);
    _newMsgStmtCache.set(jidCount, s);
  }
  return s;
}

interface StoredMessageMeta {
  turnId?: string | null;
  sessionId?: string | null;
  sdkMessageUuid?: string | null;
  sourceKind?: MessageSourceKind | null;
  finalizationReason?: MessageFinalizationReason | null;
  taskId?: string | null;
  /** Per-message autonomous flag: true when the user sent this message via the
   *  Web "全托管" button (per-message override). At cold-start, this overrides
   *  the per-group config to set containerInput.autonomous = true. */
  autonomous?: boolean | null;
}

function hasColumn(tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === columnName);
}

function ensureColumn(
  tableName: string,
  columnName: string,
  sqlTypeWithDefault: string,
): void {
  if (hasColumn(tableName, columnName)) return;
  db.exec(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlTypeWithDefault}`,
  );
}

function assertSchema(
  tableName: string,
  requiredColumns: string[],
  forbiddenColumns: string[] = [],
): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((c) => c.name));

  const missing = requiredColumns.filter((c) => !names.has(c));
  const forbidden = forbiddenColumns.filter((c) => names.has(c));

  if (missing.length > 0 || forbidden.length > 0) {
    throw new Error(
      `Incompatible DB schema in table "${tableName}". Missing: [${missing.join(', ')}], forbidden: [${forbidden.join(', ')}]. ` +
        'Please remove data/db/messages.db (or legacy store/messages.db) and restart.',
    );
  }
}

/** Internal helper — reads router_state before initDatabase exports are available. */
function getRouterStateInternal(key: string): string | undefined {
  try {
    const row = db
      .prepare('SELECT value FROM router_state WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  } catch {
    return undefined; // Table may not exist yet on first run
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Enable WAL mode for better concurrency and performance
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  // Enable foreign-key enforcement. SQLite defaults to OFF for backward
  // compatibility, so all FK declarations on existing schemas are silent
  // no-ops without this PRAGMA. We log existing orphans (if any) but only
  // for visibility — enforcement is reset to OFF when violations exist
  // because turning it on with violations would refuse the next write.
  // Operators can clean up via PRAGMA foreign_key_check then restart.
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const violations = db.prepare('PRAGMA foreign_key_check').all() as Array<{
      table: string;
      rowid: number;
      parent: string;
      fkid: number;
    }>;
    if (violations.length > 0) {
      const summary = violations
        .slice(0, 10)
        .map((v) => `${v.table} → ${v.parent}`)
        .join(', ');
      logger.warn(
        { violationCount: violations.length, sample: summary },
        'Foreign-key violations detected; disabling enforcement to avoid blocking writes. Clean up orphans (PRAGMA foreign_key_check) and restart to re-enable.',
      );
      db.exec('PRAGMA foreign_keys = OFF');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to enable foreign-key enforcement');
  }

  // Phase 3: 加载 sqlite-vec 扩展（向量索引）。失败时回退线性扫描。
  try {
    const sqliteVecReq = createRequire(import.meta.url);
    const sqliteVec = sqliteVecReq('sqlite-vec');
    sqliteVec.load(db);
    vecExtensionLoaded = true;
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_documents_vec USING vec0(
        doc_id TEXT PRIMARY KEY,
        embedding FLOAT[1536]
      )`);
    } catch (err) {
      logger.warn({ err }, 'kb_documents_vec virtual table creation failed — vector index disabled');
      vecExtensionLoaded = false;
    }
    logger.info({ version: vecVersion() }, 'sqlite-vec extension loaded — vector index enabled');
  } catch (err) {
    logger.warn({ err }, 'sqlite-vec extension load failed — falling back to linear scan');
    vecExtensionLoaded = false;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      source_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      attachments TEXT,
      token_usage TEXT,
      turn_id TEXT,
      session_id TEXT,
      sdk_message_uuid TEXT,
      source_kind TEXT,
      finalization_reason TEXT,
      autonomous INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      execution_type TEXT DEFAULT 'agent',
      script_command TEXT,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      created_by TEXT,
      notify_channels TEXT,
      autonomous INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);
  `);

  // Loop Engineering tables (v41)
  db.exec(`
    CREATE TABLE IF NOT EXISTS loop_runs (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('goal','loop','schedule','proactive')),
      goal_text TEXT NOT NULL,
      success_criteria TEXT,
      max_turns INTEGER NOT NULL DEFAULT 5,
      current_turn INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','running','reviewing','iterating','completed','failed','cancelled')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      root_prompt TEXT,
      scheduled_task_id TEXT,
      workflow_mode TEXT,
      cancel_reason TEXT,
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_loop_runs_owner ON loop_runs(owner_user_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_loop_runs_status ON loop_runs(status);

    CREATE TABLE IF NOT EXISTS loop_iterations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loop_run_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running','completed','failed','skipped')),
      agent_session_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      review_result TEXT CHECK(review_result IN ('pass','fail','needs_improvement','skipped')),
      review_reason TEXT,
      agent_output TEXT,
      FOREIGN KEY (loop_run_id) REFERENCES loop_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_loop_iterations_run ON loop_iterations(loop_run_id, turn_index);

    CREATE TABLE IF NOT EXISTS loop_trace_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loop_run_id TEXT NOT NULL,
      iteration_id INTEGER,
      node_type TEXT NOT NULL CHECK(node_type IN ('turn','tool','review','goal_check','skill','subagent')),
      parent_node_id INTEGER,
      tool_name TEXT,
      tool_use_id TEXT,
      title TEXT,
      input_summary TEXT,
      output_summary TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      tokens INTEGER NOT NULL DEFAULT 0,
      status TEXT,
      FOREIGN KEY (loop_run_id) REFERENCES loop_runs(id),
      FOREIGN KEY (iteration_id) REFERENCES loop_iterations(id),
      FOREIGN KEY (parent_node_id) REFERENCES loop_trace_nodes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_loop_trace_run ON loop_trace_nodes(loop_run_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_loop_trace_parent ON loop_trace_nodes(parent_node_id);

    CREATE TABLE IF NOT EXISTS chat_trace_nodes (
      id INTEGER NOT NULL,
      chat_jid TEXT NOT NULL,
      session_id TEXT,
      parent_node_id INTEGER,
      node_type TEXT NOT NULL CHECK(node_type IN ('turn','tool','review','goal_check','skill','subagent')),
      title TEXT,
      input_summary TEXT,
      output_summary TEXT,
      tokens INTEGER NOT NULL DEFAULT 0,
      status TEXT,
      annotation_input TEXT,
      annotation_output TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      UNIQUE(chat_jid, id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_trace_jid ON chat_trace_nodes(chat_jid, started_at);
    CREATE INDEX IF NOT EXISTS idx_chat_trace_parent ON chat_trace_nodes(parent_node_id);
  `);

  // Graph Engineering tables (v52)
  // Graph = orchestration layer over Loop. A graph definition declares nodes +
  // edges (DAG); a graph_run is an execution instance; graph_node_runs are
  // per-node checkpoints (resume point); graph_node_run_locks isolate concurrent
  // node workspaces within one folder (see AC2.7). Modeled on loop_runs /
  // loop_iterations / loop_trace_nodes (v41) three-piece pattern.
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_definitions (
      id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      parent_version_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      nodes_json TEXT NOT NULL,
      edges_json TEXT NOT NULL,
      state_schema_json TEXT,
      budget_json TEXT,
      manifest_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated')),
      created_at TEXT NOT NULL,
      UNIQUE(id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_def_status ON graph_definitions(status);

    CREATE TABLE IF NOT EXISTS graph_runs (
      id TEXT PRIMARY KEY,
      definition_id TEXT NOT NULL,
      definition_version INTEGER NOT NULL,
      owner_user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      goal_text TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','running','paused','completed','failed','cancelled')),
      current_node_id TEXT,
      state_json TEXT NOT NULL DEFAULT '{}',
      max_parallel INTEGER NOT NULL DEFAULT 4,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      manifest_hash TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      cancel_reason TEXT,
      FOREIGN KEY (definition_id, definition_version) REFERENCES graph_definitions(id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_runs_owner ON graph_runs(owner_user_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_graph_runs_status ON graph_runs(status);

    -- Super Agent Team 异步组建任务表：POST /api/team/runs 立即返回 buildId，
    -- decompose + 成员创建 + graph 注册启动在后台 detached 执行（最坏 ~240s），
    -- 结果（plan + runId）或 error 回写本表，前端轮询 GET /api/team/runs/:buildId
    -- 拿终态。与 graph_runs 解耦：graph_runs.definition_id 为 NOT NULL+FK，
    -- decompose 之前没有 graph definition，无法承载 build 期。
    CREATE TABLE IF NOT EXISTS team_builds (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      goal_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running','completed','failed')),
      plan_json TEXT,
      run_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_team_builds_owner ON team_builds(owner_user_id, created_at DESC);

    -- OPC（一人公司）模块：在既有 team/graph 等子系统之上叠加的目标驱动编排层。
    -- opc_companies 承载一人公司配置（愿景/商业目标/运营策略/规模/领域/分成），
    -- opc_objectives 承载挂在公司下的商业目标，launch 后回写 team_build_id/run_id
    -- 关联既有 team_builds / graph_runs，复用而非重造 agent 基础设施。
    CREATE TABLE IF NOT EXISTS opc_companies (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      vision TEXT,
      commercial_goals TEXT,
      operating_strategy TEXT,
      scale_tier TEXT NOT NULL DEFAULT 'solo'
        CHECK(scale_tier IN ('solo','small','mid')),
      domains_json TEXT,
      revenue_share_json TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','archived')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_opc_companies_owner ON opc_companies(owner_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS opc_objectives (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      domain TEXT,
      acceptance_criteria TEXT,
      metrics_json TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','active','running','completed','failed')),
      team_build_id TEXT,
      run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_opc_objectives_company ON opc_objectives(company_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS graph_node_runs (
      id TEXT PRIMARY KEY,
      graph_run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_type TEXT NOT NULL
        CHECK(node_type IN ('agent','gate','branch','join','human','llm','tool','start','end','parallel','aggregate')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','running','completed','failed','skipped','paused')),
      attempt INTEGER NOT NULL DEFAULT 0,
      input_summary TEXT,
      output_summary TEXT,
      state_patch_json TEXT,
      parent_node_run_id TEXT,
      started_at TEXT,
      ended_at TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      error TEXT,
      is_idempotent INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (graph_run_id) REFERENCES graph_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_node_runs_run ON graph_node_runs(graph_run_id, status);
    CREATE INDEX IF NOT EXISTS idx_graph_node_runs_parent ON graph_node_runs(parent_node_run_id);

    CREATE TABLE IF NOT EXISTS graph_node_run_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graph_run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      workspace_folder TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      released_at TEXT,
      FOREIGN KEY (graph_run_id) REFERENCES graph_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_locks_run ON graph_node_run_locks(graph_run_id, released_at);

    -- Super Agent Team trace table (v53)
    -- Stores raw tool-call input/output JSON for graph agent nodes, enabling
    -- full per-step traceability inside a graph node (sub-graph). Keyed on
    -- (graph_run_id, tool_use_id) for idempotent upsert. See
    -- docs/tech_solution/super-agent-team/SOLUTION.md §2.2.
    CREATE TABLE IF NOT EXISTS trace_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graph_run_id TEXT,
      graph_node_id TEXT,
      chat_jid TEXT,
      tool_use_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_json TEXT,
      output_json TEXT,
      status TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      UNIQUE(graph_run_id, tool_use_id)
    );
    CREATE INDEX IF NOT EXISTS idx_trace_tool_graph ON trace_tool_calls(graph_run_id, graph_node_id);
  `);

  // Self-Evolving Harness tables (v43)
  // DGM-style version archive + AHE falsifiable contracts + Harness-Bench mini eval.
  // Design notes:
  // - Versions are text manifests (manifest_json), NOT executable code. Mutation
  //   unit is prompt/skill text (ACE "text-layer evolution").
  // - Eval runner is NOT versioned — it stays in code as the external judge
  //   (SEAGym pattern) to avoid the bootstrapping paradox.
  // - promote/rollback is a single status field flip — atomic, reset-free
  //   (Continual Harness).
  db.exec(`
    CREATE TABLE IF NOT EXISTS harness_versions (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      hash TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'experimental'
        CHECK(status IN ('experimental','promoted','archived','rolled_back')),
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      promoted_at TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_harness_versions_status ON harness_versions(status);
    CREATE INDEX IF NOT EXISTS idx_harness_versions_parent ON harness_versions(parent_id);

    CREATE TABLE IF NOT EXISTS harness_proposals (
      id TEXT PRIMARY KEY,
      proposed_version_id TEXT NOT NULL,
      baseline_version_id TEXT NOT NULL,
      hypothesis TEXT NOT NULL,
      expected_behavior TEXT NOT NULL,
      mutation_patch TEXT NOT NULL,
      verdict TEXT,
      evidence_run_ids_json TEXT,
      trace_summary TEXT,
      created_at TEXT NOT NULL,
      judged_at TEXT,
      FOREIGN KEY (proposed_version_id) REFERENCES harness_versions(id),
      FOREIGN KEY (baseline_version_id) REFERENCES harness_versions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_harness_proposals_baseline ON harness_proposals(baseline_version_id);

    CREATE TABLE IF NOT EXISTS harness_eval_runs (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      proposal_id TEXT,
      case_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','running','completed','failed')),
      pass INTEGER,
      score REAL,
      trace_node_root_id INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT,
      FOREIGN KEY (version_id) REFERENCES harness_versions(id),
      FOREIGN KEY (proposal_id) REFERENCES harness_proposals(id)
    );
    CREATE INDEX IF NOT EXISTS idx_harness_eval_runs_version ON harness_eval_runs(version_id);
    CREATE INDEX IF NOT EXISTS idx_harness_eval_runs_proposal ON harness_eval_runs(proposal_id);

    CREATE TABLE IF NOT EXISTS harness_eval_cases (
      case_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      assertions_json TEXT NOT NULL,
      rubric_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
  `);

  // Long-running Supervisor Agent tables (v44)
  // A persistent, crash-recoverable supervisor that monitors the main
  // conversation agent throughout a task lifecycle. Distinct from the
  // stateless supervisor.ts pre-dispatch intent parser.
  // Design notes:
  // - supervisor_sessions: one long-running supervisor per chat. status drives
  //   the tick loop. next_check_at (ISO) is the scheduling anchor.
  // - supervisor_decisions: per-check audit row. status='running' acts as a
  //   heartbeat; boot cleanup flips stale 'running' -> 'error' (task-scheduler
  //   pattern). evidence_json holds the decision evidence for visualization.
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_sessions (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      owner_user_id TEXT,
      goal_text TEXT NOT NULL,
      success_criteria TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT 'periodic'
        CHECK(strategy IN ('periodic','on_iteration','hybrid')),
      period_ms INTEGER NOT NULL DEFAULT 300000,
      max_checks INTEGER NOT NULL DEFAULT 100,
      bound_loop_run_id TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','paused','completed','failed','aborted')),
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      current_checks INTEGER NOT NULL DEFAULT 0,
      last_check_at TEXT,
      next_check_at TEXT,
      last_bound_turn INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      config_json TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_supervisor_sessions_status ON supervisor_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_supervisor_sessions_chat ON supervisor_sessions(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_supervisor_sessions_next ON supervisor_sessions(next_check_at);

    CREATE TABLE IF NOT EXISTS supervisor_decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      action TEXT NOT NULL
        CHECK(action IN ('continue','redirect','escalate','complete','abort','error')),
      conclusion TEXT,
      evidence_json TEXT,
      next_action_hint TEXT,
      confidence REAL,
      trace_summary TEXT,
      triggered_by TEXT NOT NULL DEFAULT 'tick',
      status TEXT NOT NULL DEFAULT 'completed'
        CHECK(status IN ('running','completed','error')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      error TEXT,
      FOREIGN KEY (session_id) REFERENCES supervisor_sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_session ON supervisor_decisions(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_status ON supervisor_decisions(status);
  `);

  // State tables (replacing JSON files)
  db.exec(`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (group_folder, agent_id)
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      created_by TEXT,
      is_home INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS im_context_bindings (
      source_jid TEXT NOT NULL,
      context_type TEXT NOT NULL,
      context_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      root_message_id TEXT,
      title TEXT,
      last_active_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_jid, context_type, context_id)
    );
    CREATE INDEX IF NOT EXISTS idx_icb_workspace ON im_context_bindings(workspace_jid);
    CREATE INDEX IF NOT EXISTS idx_icb_agent ON im_context_bindings(agent_id);
  `);

  // Auth tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      permissions TEXT NOT NULL DEFAULT '[]',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disable_reason TEXT,
      notes TEXT,
      avatar_emoji TEXT,
      avatar_color TEXT,
      ai_name TEXT,
      ai_avatar_emoji TEXT,
      ai_avatar_color TEXT,
      ai_avatar_url TEXT,
      default_require_mention INTEGER NOT NULL DEFAULT 0,
      reminder_enabled INTEGER NOT NULL DEFAULT 1,
      language TEXT NOT NULL DEFAULT 'zh-CN',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      permission_template TEXT,
      permissions TEXT NOT NULL DEFAULT '[]',
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      username TEXT NOT NULL,
      actor_username TEXT,
      ip_address TEXT,
      user_agent TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
    CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
    CREATE INDEX IF NOT EXISTS idx_invites_created_at ON invite_codes(created_at);
  `);

  // Group members table for shared workspaces
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_folder TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      added_at TEXT NOT NULL,
      added_by TEXT,
      PRIMARY KEY (group_folder, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
  `);

  // User pinned groups (per-user workspace pinning)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_pinned_groups (
      user_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      PRIMARY KEY (user_id, jid)
    );
  `);

  // Sub-agents table for multi-agent parallel execution
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_by TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      result_summary TEXT,
      last_im_jid TEXT,
      spawned_from_jid TEXT,
      source_kind TEXT,
      thread_id TEXT,
      root_message_id TEXT,
      title_source TEXT,
      last_active_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agents_group ON agents(group_folder);
    CREATE INDEX IF NOT EXISTS idx_agents_jid ON agents(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  `);

  // Billing tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      tier INTEGER NOT NULL DEFAULT 0,
      monthly_cost_usd REAL NOT NULL DEFAULT 0,
      monthly_token_quota INTEGER,
      monthly_cost_quota REAL,
      daily_cost_quota REAL,
      weekly_cost_quota REAL,
      daily_token_quota INTEGER,
      weekly_token_quota INTEGER,
      rate_multiplier REAL NOT NULL DEFAULT 1.0,
      trial_days INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      display_price TEXT,
      highlight INTEGER NOT NULL DEFAULT 0,
      max_groups INTEGER,
      max_concurrent_containers INTEGER,
      max_im_channels INTEGER,
      max_mcp_servers INTEGER,
      max_storage_mb INTEGER,
      allow_overage INTEGER NOT NULL DEFAULT 0,
      features TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      expires_at TEXT,
      cancelled_at TEXT,
      trial_ends_at TEXT,
      notes TEXT,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (plan_id) REFERENCES billing_plans(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_sub_user ON user_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sub_status ON user_subscriptions(status);

    CREATE TABLE IF NOT EXISTS user_balances (
      user_id TEXT PRIMARY KEY,
      balance_usd REAL NOT NULL DEFAULT 0,
      total_deposited_usd REAL NOT NULL DEFAULT 0,
      total_consumed_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS balance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      balance_after REAL NOT NULL,
      description TEXT,
      reference_type TEXT,
      reference_id TEXT,
      actor_id TEXT,
      source TEXT NOT NULL DEFAULT 'system_adjustment',
      operator_type TEXT NOT NULL DEFAULT 'system',
      notes TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bal_tx_user ON balance_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_bal_tx_created ON balance_transactions(created_at);

    CREATE TABLE IF NOT EXISTS monthly_usage (
      user_id TEXT NOT NULL,
      month TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, month)
    );

    CREATE TABLE IF NOT EXISTS redeem_codes (
      code TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      value_usd REAL,
      plan_id TEXT,
      duration_days INTEGER,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_by TEXT NOT NULL,
      notes TEXT,
      batch_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS redeem_code_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redeemed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_redeem_usage_user ON redeem_code_usage(user_id);

    CREATE TABLE IF NOT EXISTS billing_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      actor_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bill_audit_user ON billing_audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_bill_audit_created ON billing_audit_log(created_at);

    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);
    CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_usage(user_id, date);
  `);

  // Token usage tracking tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      agent_id TEXT,
      message_id TEXT,
      model TEXT NOT NULL DEFAULT 'unknown',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_records(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_group_date ON usage_records(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_model_date ON usage_records(model, created_at);

    CREATE TABLE IF NOT EXISTS usage_daily_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, model, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_user_date ON usage_daily_summary(user_id, date);

    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id TEXT PRIMARY KEY,
      monthly_cost_limit_usd REAL NOT NULL DEFAULT -1,
      monthly_token_limit INTEGER NOT NULL DEFAULT -1,
      daily_cost_limit_usd REAL NOT NULL DEFAULT -1,
      daily_request_limit INTEGER NOT NULL DEFAULT -1,
      billing_cycle_start TEXT,
      subscription_tier TEXT,
      subscription_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_definitions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      model TEXT,
      engine TEXT NOT NULL DEFAULT 'claude',
      avatar_emoji TEXT,
      avatar_color TEXT,
      max_turns INTEGER,
      temperature REAL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_defs_user ON agent_definitions(user_id);

    CREATE TABLE IF NOT EXISTS agent_mounts (
      id TEXT PRIMARY KEY,
      agent_def_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (agent_def_id, resource_type, resource_id),
      FOREIGN KEY (agent_def_id) REFERENCES agent_definitions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_mounts_def ON agent_mounts(agent_def_id);

    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      doc_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_user ON knowledge_bases(user_id);

    CREATE TABLE IF NOT EXISTS kb_documents (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kb_docs_kb ON kb_documents(kb_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS kb_documents_fts USING fts5(
      filename, content, content='kb_documents', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS kb_docs_ai AFTER INSERT ON kb_documents BEGIN
      INSERT INTO kb_documents_fts(rowid, filename, content) VALUES (new.rowid, new.filename, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS kb_docs_ad AFTER DELETE ON kb_documents BEGIN
      INSERT INTO kb_documents_fts(kb_documents_fts, rowid, filename, content) VALUES('delete', old.rowid, old.filename, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS kb_docs_au AFTER UPDATE ON kb_documents BEGIN
      INSERT INTO kb_documents_fts(kb_documents_fts, rowid, filename, content) VALUES('delete', old.rowid, old.filename, old.content);
      INSERT INTO kb_documents_fts(rowid, filename, content) VALUES (new.rowid, new.filename, new.content);
    END;

    CREATE TABLE IF NOT EXISTS marketplace_items (
      id TEXT PRIMARY KEY,
      item_type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      payload TEXT NOT NULL,
      installed_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'approved',
      submitted_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_market_type ON marketplace_items(item_type);
    -- idx_market_status 在后续 ensureColumn 补齐 status 列后再创建，
    -- 避免老库（marketplace_items 缺 status 列）启动时 "no such column: status"

    CREATE TABLE IF NOT EXISTS marketplace_reviews (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(item_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_item ON marketplace_reviews(item_id);

    CREATE TABLE IF NOT EXISTS agent_definition_versions (
      id TEXT PRIMARY KEY,
      agent_def_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      UNIQUE(agent_def_id, version),
      FOREIGN KEY (agent_def_id) REFERENCES agent_definitions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_versions_def ON agent_definition_versions(agent_def_id);

    CREATE TABLE IF NOT EXISTS agent_shares (
      id TEXT PRIMARY KEY,
      agent_def_id TEXT NOT NULL,
      share_token TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      install_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (agent_def_id) REFERENCES agent_definitions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_shares_def ON agent_shares(agent_def_id);

    CREATE TABLE IF NOT EXISTS agent_collaborators (
      agent_def_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent_def_id, user_id),
      FOREIGN KEY (agent_def_id) REFERENCES agent_definitions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS marketplace_review_reports (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      reporter_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      handled_by TEXT,
      handled_at TEXT,
      UNIQUE(review_id, reporter_id),
      FOREIGN KEY (review_id) REFERENCES marketplace_reviews(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_review_reports_status ON marketplace_review_reports(status);

    CREATE TABLE IF NOT EXISTS sandbox_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      container_name TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'python',
      browser_enabled INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'created',
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      stopped_at INTEGER,
      stopped_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_user ON sandbox_sessions(user_id, status);

    CREATE TABLE IF NOT EXISTS sandbox_executions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      language TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      stdout_bytes INTEGER NOT NULL DEFAULT 0,
      stderr_bytes INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      peak_memory_mb INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sandbox_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sandbox_executions_session ON sandbox_executions(session_id, created_at);
  `);

  // Phase 2 columns
  ensureColumn('kb_documents', 'embedding', 'BLOB');
  ensureColumn('kb_documents', 'embedding_model', 'TEXT');
  ensureColumn('marketplace_items', 'status', "TEXT NOT NULL DEFAULT 'approved'");
  ensureColumn('marketplace_items', 'submitted_by', 'TEXT');
  // 补齐 status 列后再创建索引（老库 marketplace_items 缺 status 列）
  db.exec('CREATE INDEX IF NOT EXISTS idx_market_status ON marketplace_items(status);');

  // Lightweight migrations for existing DBs
  ensureColumn('users', 'permissions', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'disable_reason', 'TEXT');
  ensureColumn('users', 'notes', 'TEXT');
  ensureColumn('users', 'deleted_at', 'TEXT');
  ensureColumn('invite_codes', 'permission_template', 'TEXT');
  ensureColumn('invite_codes', 'permissions', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('users', 'avatar_emoji', 'TEXT');
  ensureColumn('users', 'avatar_color', 'TEXT');
  ensureColumn(
    'registered_groups',
    'execution_mode',
    "TEXT DEFAULT 'container'",
  );
  ensureColumn('registered_groups', 'custom_cwd', 'TEXT');
  ensureColumn('registered_groups', 'init_source_path', 'TEXT');
  ensureColumn('registered_groups', 'init_git_url', 'TEXT');
  ensureColumn('messages', 'attachments', 'TEXT');
  ensureColumn('messages', 'source_jid', 'TEXT');
  ensureColumn('registered_groups', 'created_by', 'TEXT');
  ensureColumn('registered_groups', 'is_home', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'avatar_url', 'TEXT');
  ensureColumn('users', 'ai_name', 'TEXT');
  ensureColumn('users', 'ai_avatar_emoji', 'TEXT');
  ensureColumn('users', 'ai_avatar_color', 'TEXT');
  ensureColumn('users', 'ai_avatar_url', 'TEXT');
  ensureColumn('users', 'language', "TEXT NOT NULL DEFAULT 'zh-CN'");
  ensureColumn(
    'users',
    'default_require_mention',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn('users', 'reminder_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('scheduled_tasks', 'created_by', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_type', "TEXT DEFAULT 'agent'");
  ensureColumn('scheduled_tasks', 'script_command', 'TEXT');
  ensureColumn('scheduled_tasks', 'notify_channels', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_mode', 'TEXT');
  ensureColumn('scheduled_tasks', 'workspace_jid', 'TEXT');
  ensureColumn('scheduled_tasks', 'workspace_folder', 'TEXT');
  ensureColumn('scheduled_tasks', 'autonomous', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn('registered_groups', 'selected_skills', 'TEXT');
  ensureColumn('sessions', 'agent_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('agents', 'kind', "TEXT NOT NULL DEFAULT 'task'");
  ensureColumn('registered_groups', 'target_agent_id', 'TEXT');
  ensureColumn('registered_groups', 'target_main_jid', 'TEXT');
  ensureColumn(
    'registered_groups',
    'reply_policy',
    "TEXT DEFAULT 'source_only'",
  );
  ensureColumn('registered_groups', 'require_mention', 'INTEGER DEFAULT 0');
  ensureColumn('registered_groups', 'mcp_mode', "TEXT DEFAULT 'inherit'");
  ensureColumn('registered_groups', 'selected_mcps', 'TEXT');
  ensureColumn('registered_groups', 'activation_mode', "TEXT DEFAULT 'auto'");
  ensureColumn('registered_groups', 'owner_im_id', 'TEXT');
  ensureColumn(
    'registered_groups',
    'conversation_source',
    "TEXT DEFAULT 'manual'",
  );
  ensureColumn(
    'registered_groups',
    'conversation_nav_mode',
    "TEXT DEFAULT 'horizontal'",
  );
  ensureColumn(
    'registered_groups',
    'binding_mode',
    "TEXT DEFAULT 'single_context'",
  );
  ensureColumn('registered_groups', 'feishu_chat_mode', 'TEXT');
  ensureColumn('registered_groups', 'feishu_group_message_type', 'TEXT');
  ensureColumn('registered_groups', 'sender_allowlist', 'TEXT');
  ensureColumn('registered_groups', 'engine', "TEXT DEFAULT 'claude'");
  ensureColumn('registered_groups', 'agent_def_id', 'TEXT');
  ensureColumn('sessions', 'atomcode_session_id', 'TEXT');
  ensureColumn('sessions', 'sandbox_session_id', 'TEXT');
  ensureColumn('sessions', 'codex_thread_id', 'TEXT');
  ensureColumn('sessions', 'opencode_session_id', 'TEXT');
  ensureColumn('sessions', 'pi_session_id', 'TEXT');
  ensureColumn('users', 'agent_quota', 'INTEGER NOT NULL DEFAULT 10');
  ensureColumn('messages', 'token_usage', 'TEXT');
  ensureColumn('messages', 'turn_id', 'TEXT');
  ensureColumn('messages', 'session_id', 'TEXT');
  ensureColumn('messages', 'sdk_message_uuid', 'TEXT');
  ensureColumn('messages', 'source_kind', 'TEXT');
  ensureColumn('messages', 'finalization_reason', 'TEXT');
  ensureColumn('messages', 'task_id', 'TEXT');
  ensureColumn('messages', 'autonomous', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn('loop_trace_nodes', 'edited_at', 'TEXT');
  ensureColumn('agents', 'source_kind', 'TEXT');
  ensureColumn('agents', 'thread_id', 'TEXT');
  ensureColumn('agents', 'root_message_id', 'TEXT');
  ensureColumn('agents', 'title_source', 'TEXT');
  ensureColumn('agents', 'last_active_at', 'TEXT');

  // Add index on target_agent_id for fast lookup of IM bindings
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rg_target_agent ON registered_groups(target_agent_id)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rg_target_main ON registered_groups(target_main_jid)',
  );

  // Migration: remove UNIQUE constraint from registered_groups.folder
  // Multiple groups (web:main + feishu chats) share folder='main' by design.
  // The old UNIQUE constraint caused INSERT OR REPLACE to silently delete
  // the conflicting row, making web:main and feishu groups mutually exclusive.
  const hasUniqueFolder =
    (
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM sqlite_master
         WHERE type='index' AND tbl_name='registered_groups'
         AND name='sqlite_autoindex_registered_groups_2'`,
        )
        .get() as { cnt: number }
    ).cnt > 0;
  if (hasUniqueFolder) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE registered_groups_new (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          execution_mode TEXT DEFAULT 'container',
          custom_cwd TEXT,
          init_source_path TEXT,
          init_git_url TEXT,
          created_by TEXT,
          is_home INTEGER DEFAULT 0
        );
        INSERT INTO registered_groups_new SELECT jid, name, folder, added_at, container_config, execution_mode, custom_cwd, NULL, NULL, NULL, 0 FROM registered_groups;
        DROP TABLE registered_groups;
        ALTER TABLE registered_groups_new RENAME TO registered_groups;
      `);
    })();
  }

  // v19→v20 migration: add token_usage column to messages
  ensureColumn('messages', 'token_usage', 'TEXT');
  assertSchema('messages', [
    'id',
    'chat_jid',
    'source_jid',
    'sender',
    'sender_name',
    'content',
    'timestamp',
    'is_from_me',
    'attachments',
    'token_usage',
  ]);
  assertSchema('scheduled_tasks', [
    'id',
    'group_folder',
    'chat_jid',
    'prompt',
    'schedule_type',
    'schedule_value',
    'context_mode',
    'next_run',
    'last_run',
    'last_result',
    'status',
    'created_at',
    'created_by',
  ]);
  assertSchema(
    'registered_groups',
    [
      'jid',
      'name',
      'folder',
      'added_at',
      'container_config',
      'execution_mode',
      'custom_cwd',
      'init_source_path',
      'init_git_url',
      'created_by',
      'is_home',
      'selected_skills',
      'target_agent_id',
      'target_main_jid',
      'reply_policy',
    ],
    ['trigger_pattern', 'requires_trigger'],
  );

  assertSchema('users', [
    'id',
    'username',
    'password_hash',
    'display_name',
    'role',
    'status',
    'permissions',
    'must_change_password',
    'disable_reason',
    'notes',
    'avatar_emoji',
    'avatar_color',
    'avatar_url',
    'ai_name',
    'ai_avatar_emoji',
    'ai_avatar_color',
    'ai_avatar_url',
    'default_require_mention',
    'reminder_enabled',
    'created_at',
    'updated_at',
    'last_login_at',
    'deleted_at',
  ]);
  assertSchema('user_sessions', [
    'id',
    'user_id',
    'ip_address',
    'user_agent',
    'created_at',
    'expires_at',
    'last_active_at',
  ]);
  assertSchema('invite_codes', [
    'code',
    'created_by',
    'role',
    'permission_template',
    'permissions',
    'max_uses',
    'used_count',
    'expires_at',
    'created_at',
  ]);
  assertSchema('auth_audit_log', [
    'id',
    'event_type',
    'username',
    'actor_username',
    'ip_address',
    'user_agent',
    'details',
    'created_at',
  ]);

  // Store schema version after all migrations complete
  // Migrate existing web groups: assign to first admin
  db.exec(`
    UPDATE registered_groups SET created_by = (
      SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1
    ) WHERE jid LIKE 'web:%' AND folder != 'main' AND created_by IS NULL
  `);

  // Backfill owner for legacy web:main if missing.
  db.exec(`
    UPDATE registered_groups SET created_by = (
      SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1
    ) WHERE jid = 'web:main' AND created_by IS NULL
  `);

  // Backfill created_by for feishu/telegram groups by matching sibling groups in the same folder.
  // Only backfill when the folder has exactly one distinct owner; otherwise keep NULL
  // to avoid misrouting in ambiguous folders (e.g., shared admin main).
  db.exec(`
    UPDATE registered_groups
    SET created_by = (
      SELECT MIN(rg2.created_by)
      FROM registered_groups rg2
      WHERE rg2.folder = registered_groups.folder
        AND rg2.created_by IS NOT NULL
    )
    WHERE (jid LIKE 'feishu:%' OR jid LIKE 'telegram:%')
      AND created_by IS NULL
      AND (
        SELECT COUNT(DISTINCT rg3.created_by)
        FROM registered_groups rg3
        WHERE rg3.folder = registered_groups.folder
          AND rg3.created_by IS NOT NULL
      ) = 1
  `);

  // v13 migration: mark existing web:main group as is_home=1
  db.exec(`
    UPDATE registered_groups SET is_home = 1
    WHERE jid = 'web:main' AND folder = 'main' AND is_home = 0
  `);

  // v15 migration: backfill group_members for existing web groups
  const currentVersion = getRouterStateInternal('schema_version');
  if (!currentVersion || parseInt(currentVersion, 10) < 15) {
    db.transaction(() => {
      // Backfill owner records for all web groups with created_by set
      const webGroups = db
        .prepare(
          "SELECT DISTINCT folder, created_by FROM registered_groups WHERE jid LIKE 'web:%' AND created_by IS NOT NULL",
        )
        .all() as Array<{ folder: string; created_by: string }>;
      for (const g of webGroups) {
        db.prepare(
          `INSERT OR IGNORE INTO group_members (group_folder, user_id, role, added_at, added_by)
           VALUES (?, ?, 'owner', ?, ?)`,
        ).run(g.folder, g.created_by, new Date().toISOString(), g.created_by);
      }
    })();
  }

  // v16→v17 migration: rebuild sessions table with composite primary key
  // Old PK was (group_folder), which cannot store multiple agent sessions per folder.
  // New PK is (group_folder, COALESCE(agent_id, '')) to support per-agent sessions.
  const curVer = getRouterStateInternal('schema_version');
  if (curVer && parseInt(curVer, 10) < 17) {
    db.transaction(() => {
      // Check if the old table has single-column PK by inspecting table_info
      const pkCols = (
        db.prepare("PRAGMA table_info('sessions')").all() as Array<{
          name: string;
          pk: number;
        }>
      ).filter((c) => c.pk > 0);
      // Old schema: single PK column 'group_folder'. New schema: composite PK needs rebuild.
      if (pkCols.length === 1 && pkCols[0].name === 'group_folder') {
        db.exec(`
          CREATE TABLE sessions_new (
            group_folder TEXT NOT NULL,
            session_id TEXT NOT NULL,
            agent_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (group_folder, agent_id)
          );
          INSERT OR IGNORE INTO sessions_new (group_folder, session_id, agent_id)
            SELECT group_folder, session_id, COALESCE(agent_id, '') FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_new RENAME TO sessions;
        `);
      }
    })();
  }

  // v22: Fix target_main_jid that used folder-based JID (web:${folder})
  // instead of actual registered group JID (web:${uuid}).
  // Only affects non-home workspaces where folder != uuid.
  if (curVer && parseInt(curVer, 10) < 22) {
    const rows = db
      .prepare(
        "SELECT jid, target_main_jid FROM registered_groups WHERE target_main_jid IS NOT NULL AND target_main_jid != ''",
      )
      .all() as Array<{ jid: string; target_main_jid: string }>;
    for (const row of rows) {
      const targetJid = row.target_main_jid;
      // Check if target_main_jid is a real registered group JID
      const exists = db
        .prepare('SELECT 1 FROM registered_groups WHERE jid = ?')
        .get(targetJid);
      if (exists) continue;
      // Not a valid JID — try to resolve via folder
      if (!targetJid.startsWith('web:')) continue;
      const folder = targetJid.slice(4);
      const candidates = db
        .prepare(
          "SELECT jid FROM registered_groups WHERE folder = ? AND jid LIKE 'web:%'",
        )
        .all(folder) as Array<{ jid: string }>;
      if (candidates.length === 1) {
        db.prepare(
          'UPDATE registered_groups SET target_main_jid = ? WHERE jid = ?',
        ).run(candidates[0].jid, row.jid);
      }
    }
  }

  // v23→v24 migration: billing system initialization
  ensureColumn('users', 'subscription_plan_id', 'TEXT');
  const v24Ver = getRouterStateInternal('schema_version');
  if (!v24Ver || parseInt(v24Ver, 10) < 24) {
    db.transaction(() => {
      // Ensure a default free plan exists
      const existingDefault = db
        .prepare('SELECT id FROM billing_plans WHERE is_default = 1')
        .get();
      if (!existingDefault) {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO billing_plans (id, name, description, tier, monthly_cost_usd, allow_overage, features, is_default, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'free',
          '免费版',
          '基础免费套餐',
          0,
          0,
          0,
          '[]',
          1,
          1,
          now,
          now,
        );
      }

      // Initialize balances for all existing users
      const users = db
        .prepare("SELECT id FROM users WHERE status != 'deleted'")
        .all() as Array<{ id: string }>;
      const now = new Date().toISOString();
      for (const u of users) {
        db.prepare(
          'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
        ).run(u.id, now);
      }

      // Create active subscriptions for existing users → free plan
      const freePlan = db
        .prepare('SELECT id FROM billing_plans WHERE is_default = 1')
        .get() as { id: string } | undefined;
      if (freePlan) {
        for (const u of users) {
          const existing = db
            .prepare(
              "SELECT id FROM user_subscriptions WHERE user_id = ? AND status = 'active'",
            )
            .get(u.id);
          if (!existing) {
            const subId = `sub_${u.id}_${Date.now()}`;
            db.prepare(
              `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, created_at)
               VALUES (?, ?, ?, 'active', ?, ?)`,
            ).run(subId, u.id, freePlan.id, now, now);
          }
        }
      }
    })();
  }

  // v24→v25 migration: billing system enhancement (daily/weekly quotas, rate_multiplier, trial)
  ensureColumn('billing_plans', 'daily_cost_quota', 'REAL');
  ensureColumn('billing_plans', 'weekly_cost_quota', 'REAL');
  ensureColumn('billing_plans', 'daily_token_quota', 'INTEGER');
  ensureColumn('billing_plans', 'weekly_token_quota', 'INTEGER');
  ensureColumn('billing_plans', 'rate_multiplier', 'REAL NOT NULL DEFAULT 1.0');
  ensureColumn('billing_plans', 'trial_days', 'INTEGER');
  ensureColumn('billing_plans', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('billing_plans', 'display_price', 'TEXT');
  ensureColumn('billing_plans', 'highlight', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('user_subscriptions', 'trial_ends_at', 'TEXT');
  ensureColumn('user_subscriptions', 'notes', 'TEXT');
  ensureColumn('redeem_codes', 'batch_id', 'TEXT');

  // v25→v26 migration: cost_usd on messages + idempotency key for balance transactions
  ensureColumn('messages', 'cost_usd', 'REAL');

  // idempotency key for balance transactions
  ensureColumn('balance_transactions', 'idempotency_key', 'TEXT');
  ensureColumn(
    'balance_transactions',
    'source',
    "TEXT NOT NULL DEFAULT 'system_adjustment'",
  );
  ensureColumn(
    'balance_transactions',
    'operator_type',
    "TEXT NOT NULL DEFAULT 'system'",
  );
  ensureColumn('balance_transactions', 'notes', 'TEXT');
  // Create unique index only if it doesn't exist
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bal_tx_idempotency ON balance_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL`);

  // v26→v27 migration: wallet-first commercialization baseline
  const v27Ver = getRouterStateInternal('schema_version');
  if (!v27Ver || parseInt(v27Ver, 10) < 27) {
    db.transaction(() => {
      const now = new Date().toISOString();
      const users = db
        .prepare(
          "SELECT id, role FROM users WHERE status != 'deleted' AND role != 'admin'",
        )
        .all() as Array<{ id: string; role: UserRole }>;
      for (const user of users) {
        db.prepare(
          `INSERT OR IGNORE INTO user_balances (
            user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at
          ) VALUES (?, 0, 0, 0, ?)`,
        ).run(user.id, now);
        db.prepare(
          `UPDATE user_balances
           SET balance_usd = 0, total_deposited_usd = 0, total_consumed_usd = 0, updated_at = ?
           WHERE user_id = ?`,
        ).run(now, user.id);

        const hasOpening = db
          .prepare(
            "SELECT 1 FROM balance_transactions WHERE user_id = ? AND source = 'migration_opening' LIMIT 1",
          )
          .get(user.id);
        if (!hasOpening) {
          db.prepare(
            `INSERT INTO balance_transactions (
              user_id, type, amount_usd, balance_after, description, reference_type,
              reference_id, actor_id, source, operator_type, notes, idempotency_key, created_at
            ) VALUES (?, 'adjustment', 0, 0, ?, NULL, NULL, NULL, 'migration_opening', 'system', ?, NULL, ?)`,
          ).run(
            user.id,
            '商业化计费上线初始化',
            '上线迁移：普通用户默认余额归零，需充值后使用',
            now,
          );
        }
      }
    })();
  }

  // v27→v28: Token usage tables + history migration
  const v28Check = getRouterStateInternal('schema_version');
  if (!v28Check || parseInt(v28Check, 10) < 28) {
    db.transaction(() => {
      // Count messages with token_usage for logging
      const countBefore = (
        db
          .prepare(
            "SELECT COUNT(*) as cnt FROM messages WHERE token_usage IS NOT NULL AND json_extract(token_usage, '$.modelUsage') IS NOT NULL",
          )
          .get() as { cnt: number }
      ).cnt;

      // Migrate from messages.token_usage modelUsage into usage_records
      db.exec(`
        INSERT OR IGNORE INTO usage_records (id, user_id, group_folder, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        SELECT
          lower(hex(randomblob(16))),
          COALESCE(rg.created_by, 'system'),
          COALESCE(rg.folder, m.chat_jid),
          m.id,
          COALESCE(jme.key, 'unknown'),
          COALESCE(json_extract(jme.value, '$.inputTokens'), 0),
          COALESCE(json_extract(jme.value, '$.outputTokens'), 0),
          0, 0,
          COALESCE(json_extract(jme.value, '$.costUSD'), 0),
          COALESCE(json_extract(m.token_usage, '$.durationMs'), 0),
          COALESCE(json_extract(m.token_usage, '$.numTurns'), 0),
          'agent',
          m.timestamp
        FROM messages m
          JOIN json_each(json_extract(m.token_usage, '$.modelUsage')) jme
          LEFT JOIN registered_groups rg ON rg.jid = m.chat_jid
        WHERE m.token_usage IS NOT NULL
          AND json_extract(m.token_usage, '$.modelUsage') IS NOT NULL
      `);

      // Migrate messages without modelUsage (legacy) using root-level fields
      db.exec(`
        INSERT OR IGNORE INTO usage_records (id, user_id, group_folder, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        SELECT
          lower(hex(randomblob(16))),
          COALESCE(rg.created_by, 'system'),
          COALESCE(rg.folder, m.chat_jid),
          m.id,
          'legacy-unknown',
          COALESCE(json_extract(m.token_usage, '$.inputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.outputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.cacheReadInputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.cacheCreationInputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.costUSD'), 0),
          COALESCE(json_extract(m.token_usage, '$.durationMs'), 0),
          COALESCE(json_extract(m.token_usage, '$.numTurns'), 0),
          'agent',
          m.timestamp
        FROM messages m
          LEFT JOIN registered_groups rg ON rg.jid = m.chat_jid
        WHERE m.token_usage IS NOT NULL
          AND (json_extract(m.token_usage, '$.modelUsage') IS NULL
               OR json_type(json_extract(m.token_usage, '$.modelUsage')) != 'object')
      `);

      // Build daily summary from usage_records
      db.exec(`
        INSERT OR REPLACE INTO usage_daily_summary (user_id, model, date,
          total_input_tokens, total_output_tokens,
          total_cache_read_tokens, total_cache_creation_tokens,
          total_cost_usd, request_count, updated_at)
        SELECT
          user_id, model, date(created_at, 'localtime'),
          SUM(input_tokens), SUM(output_tokens),
          SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
          SUM(cost_usd), COUNT(*), datetime('now')
        FROM usage_records
        GROUP BY user_id, model, date(created_at, 'localtime')
      `);

      const countAfter = (
        db.prepare('SELECT COUNT(*) as cnt FROM usage_records').get() as {
          cnt: number;
        }
      ).cnt;
      logger.info(
        { countBefore, countAfter },
        'Token usage migration v27→v28 completed',
      );
    })();
  }

  // v29 → v30: Add last_im_jid to agents table (#225)
  if (
    !db
      .prepare("PRAGMA table_info('agents')")
      .all()
      .some((c: any) => c.name === 'last_im_jid')
  ) {
    db.exec('ALTER TABLE agents ADD COLUMN last_im_jid TEXT');
  }

  // v31 → v32: Add spawned_from_jid to agents table (spawn parallel tasks)
  if (
    !db
      .prepare("PRAGMA table_info('agents')")
      .all()
      .some((c: any) => c.name === 'spawned_from_jid')
  ) {
    db.exec('ALTER TABLE agents ADD COLUMN spawned_from_jid TEXT');
  }

  // v36 → v37: Add provider_id to sessions table for sticky provider binding.
  // Prevents "Invalid signature in thinking block" errors when a Claude session
  // resumed across container restarts gets routed to a different OAuth account.
  if (
    !db
      .prepare("PRAGMA table_info('sessions')")
      .all()
      .some((c: any) => c.name === 'provider_id')
  ) {
    db.exec('ALTER TABLE sessions ADD COLUMN provider_id TEXT');
  }

  // v37 → v38: Added users.default_require_mention column (per-user default
  // for require_mention on auto-registered IM group chats). The actual
  // ensureColumn migration runs above with the other users.* additions —
  // its position before assertSchema('users', …) matters because the
  // schema check would otherwise reject pre-v38 databases on startup.

  // v38 → v39: Lowercase usernames + add COLLATE NOCASE uniqueness.
  // R1 added `username.toLowerCase()` to login/register/setup/admin-create/
  // profile-update routes for case-insensitive auth; without this migration
  // any pre-existing mixed-case username (e.g. 'Admin') is permanently
  // locked out (login lowercases input → DB lookup misses → 401).
  // We only run UPDATE; the existing UNIQUE constraint already prevents
  // future mixed-case inserts because the routes lowercase before INSERT.
  // Conflicts (e.g. both 'admin' and 'Admin' rows already exist) are rare
  // because the original UNIQUE was case-sensitive, so they exist only when
  // the operator manually inserted both. We log the conflict and refuse to
  // mutate that row, leaving the operator to clean up by hand.
  {
    const v = getRouterStateInternal('schema_version');
    const numV = v ? parseInt(v, 10) : 0;
    if (numV < 39 || !v) {
      const mixedCaseRows = db
        .prepare(
          // ORDER BY 让多次 dry-run 结果稳定 + 让"早创建的真账号"优先被
          // lowercase 化，避免后注册的混淆账号顶替原账号。
          "SELECT id, username FROM users WHERE username != lower(username) ORDER BY created_at ASC, id ASC",
        )
        .all() as Array<{ id: string; username: string }>;
      if (mixedCaseRows.length > 0) {
        const txn = db.transaction(() => {
          for (const row of mixedCaseRows) {
            const lower = row.username.toLowerCase();
            const conflict = db
              .prepare('SELECT id FROM users WHERE id != ? AND username = ?')
              .get(row.id, lower) as { id: string } | undefined;
            if (conflict) {
              logger.error(
                {
                  userId: row.id,
                  username: row.username,
                  conflictUserId: conflict.id,
                },
                'Username case-normalization migration: conflict, leaving row as-is',
              );
              continue;
            }
            db.prepare('UPDATE users SET username = ? WHERE id = ?').run(
              lower,
              row.id,
            );
          }
        });
        txn();
        logger.info(
          { rows: mixedCaseRows.length },
          'Username case-normalization migration v39 completed',
        );
      }
    }
  }

  // v40 → v41: Loop Engineering — add loop_kind/loop_run_id to scheduled_tasks
  // and ensure loop_runs/loop_iterations/loop_trace_nodes tables exist (CREATE
  // TABLE IF NOT EXISTS in the schema block above already handles new tables;
  // ALTER TABLE below extends the existing scheduled_tasks table in-place).
  if (
    !db
      .prepare("PRAGMA table_info('scheduled_tasks')")
      .all()
      .some((c: any) => c.name === 'loop_kind')
  ) {
    db.exec('ALTER TABLE scheduled_tasks ADD COLUMN loop_kind TEXT');
  }
  if (
    !db
      .prepare("PRAGMA table_info('scheduled_tasks')")
      .all()
      .some((c: any) => c.name === 'loop_run_id')
  ) {
    db.exec('ALTER TABLE scheduled_tasks ADD COLUMN loop_run_id TEXT');
  }

  // v52 → v53: Super Agent Team — extend chat_trace_nodes with graph linkage +
  // tool-call columns (aligned with loop_trace_nodes), so graph agent nodes'
  // internal steps form a traceable sub-tree. CREATE TABLE IF NOT EXISTS in the
  // schema block above already created trace_tool_calls for fresh DBs; ALTER
  // TABLE below extends existing chat_trace_nodes in-place (nullable columns,
  // no CHECK constraint changes — backward compatible with existing chat trace).
  for (const col of ['graph_run_id', 'graph_node_id', 'tool_name', 'tool_use_id']) {
    if (
      !db
        .prepare("PRAGMA table_info('chat_trace_nodes')")
        .all()
        .some((c: any) => c.name === col)
    ) {
      db.exec(`ALTER TABLE chat_trace_nodes ADD COLUMN ${col} TEXT`);
    }
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_chat_trace_graph ON chat_trace_nodes(graph_run_id, graph_node_id)',
  );

  // v53 → v54: Autonomy Layer — 7-capability registry + quantified metrics +
  // cross-session lessons + adaptation signals. All IF NOT EXISTS, no changes
  // to existing tables. See docs/tech_solution/autonomy-system/SOLUTION.md §2.
  db.exec(`
    CREATE TABLE IF NOT EXISTS autonomy_capabilities (
      capability TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_event_at INTEGER,
      metrics_summary_json TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS autonomy_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capability TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      numerator INTEGER NOT NULL DEFAULT 0,
      denominator INTEGER NOT NULL DEFAULT 0,
      run_id TEXT,
      graph_run_id TEXT,
      ts INTEGER NOT NULL,
      details_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_am_cap_metric ON autonomy_metrics(capability, metric_name, ts);

    CREATE TABLE IF NOT EXISTS autonomy_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capability TEXT NOT NULL,
      lesson_text TEXT NOT NULL,
      derived_from_run_ids TEXT,
      applied_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS autonomy_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_type TEXT NOT NULL,
      payload_json TEXT,
      target_run_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      applied_at INTEGER
    );
  `);

  // v54 → v55: Graph Task Planning — DSL v2 extensions.
  // 1) graph_definitions.budget_json (execution budget / circuit breaker).
  // 2) graph_runs.manifest_hash (captured at start so resume detects drift).
  // Both are additive nullable columns — backward compatible.
  ensureColumn('graph_definitions', 'budget_json', 'TEXT');
  ensureColumn('graph_runs', 'manifest_hash', 'TEXT');
  // 3) graph_node_runs.node_type CHECK constraint must accept the new node
  //    kinds (llm/tool/start/end/parallel/aggregate). SQLite cannot ALTER a
  //    CHECK in place, so we rebuild the table (drop+recreate+copy), mirroring
  //    the registered_groups migration at line ~1428. Safe because node runs
  //    are execution records (regenerable) and the table is empty between runs
  //    in normal operation; a transaction preserves any in-flight rows.
  const graphNodeRunCheckOk = (
    db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='graph_node_runs'`,
      )
      .get() as { sql: string } | undefined
  )?.sql;
  if (
    graphNodeRunCheckOk &&
    !graphNodeRunCheckOk.includes("'parallel'") &&
    !graphNodeRunCheckOk.includes("'aggregate'")
  ) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE graph_node_runs_new (
          id TEXT PRIMARY KEY,
          graph_run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          node_type TEXT NOT NULL
            CHECK(node_type IN ('agent','gate','branch','join','human','llm','tool','start','end','parallel','aggregate')),
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','running','completed','failed','skipped','paused')),
          attempt INTEGER NOT NULL DEFAULT 0,
          input_summary TEXT,
          output_summary TEXT,
          state_patch_json TEXT,
          parent_node_run_id TEXT,
          started_at TEXT,
          ended_at TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          error TEXT,
          is_idempotent INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (graph_run_id) REFERENCES graph_runs(id)
        );
        INSERT INTO graph_node_runs_new
          SELECT id, graph_run_id, node_id, node_type, status, attempt, input_summary,
                 output_summary, state_patch_json, parent_node_run_id, started_at, ended_at,
                 input_tokens, output_tokens, cost_usd, error, is_idempotent
          FROM graph_node_runs;
        DROP TABLE graph_node_runs;
        ALTER TABLE graph_node_runs_new RENAME TO graph_node_runs;
        CREATE INDEX IF NOT EXISTS idx_graph_node_runs_run ON graph_node_runs(graph_run_id, status);
        CREATE INDEX IF NOT EXISTS idx_graph_node_runs_parent ON graph_node_runs(parent_node_run_id);
      `);
    })();
  }

  const SCHEMA_VERSION = '55';
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run('schema_version', SCHEMA_VERSION);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Coerce a value flowing through a TEXT-affinity column into a JS string.
 *
 * SQLite is dynamically typed: a TEXT column will silently accept a
 * Buffer/Uint8Array binding and store it as BLOB. better-sqlite3 reads such
 * cells back as Buffer, which propagates through JSON.stringify as
 * `{type:"Buffer",data:[…]}` and breaks any consumer expecting a string.
 *
 * Wraps both write paths (where `warnField` surfaces the offending caller)
 * and read paths (no `warnField`, silent normalization of legacy bad data).
 */
function toUtf8String(value: unknown, warnField?: string): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const decoded = Buffer.from(value as Uint8Array).toString('utf8');
    if (warnField) {
      logger.warn(
        { field: warnField, byteLen: (value as Uint8Array).byteLength, sample: decoded.slice(0, 80) },
        'toUtf8String: Buffer on TEXT column, decoded as UTF-8',
      );
    }
    return decoded;
  }
  const coerced = String(value);
  if (warnField) {
    logger.warn(
      { field: warnField, jsType: typeof value, sample: coerced.slice(0, 80) },
      'toUtf8String: non-string on TEXT column, coerced via String()',
    );
  }
  return coerced;
}

/** Variant that preserves null (vs the default '' fallback). */
function toUtf8StringOrNull(value: unknown): string | null {
  return value == null ? null : toUtf8String(value);
}

/** Normalize a raw message row from sqlite: decode content + boolify is_from_me.
 *  The is_from_me overload must come first — TS overload resolution stops at
 *  the first match and `NewMessage & { is_from_me: number }` is a subtype of
 *  `NewMessage`. */
function normalizeMessageRow(
  row: NewMessage & { is_from_me: number },
): NewMessage & { is_from_me: boolean };
function normalizeMessageRow(row: NewMessage): NewMessage;
function normalizeMessageRow(row: NewMessage & { is_from_me?: number }): NewMessage & { is_from_me?: boolean } {
  const { is_from_me, content, autonomous, ...rest } = row;
  const out: NewMessage & { is_from_me?: boolean } = {
    ...rest,
    content: toUtf8String(content),
  };
  if (typeof is_from_me === 'number') {
    out.is_from_me = is_from_me === 1;
  }
  // autonomous column is INTEGER (0/1). Normalize to boolean for downstream
  // consumers (HTTP /api/messages response, WebSocket new_message push).
  if (typeof autonomous === 'number') {
    out.autonomous = autonomous === 1;
  }
  return out;
}

/**
 * Ensure a chat row exists in the chats table (avoids FK violation on messages insert).
 */
export function ensureChatExists(chatJid: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
  ).run(chatJid, chatJid, new Date().toISOString());
}

/**
 * Store a message with full content (channel-agnostic).
 * Only call this for registered groups where message history is needed.
 */
export function storeMessageDirect(
  msgId: string,
  chatJid: string,
  sender: string,
  senderName: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
  opts?: {
    attachments?: string;
    tokenUsage?: string;
    sourceJid?: string;
    meta?: StoredMessageMeta;
  },
): string {
  const { attachments, tokenUsage, sourceJid, meta } = opts ?? {};
  // truncation_continue 与 sdk_final 同属"最终回复"：截断自动续写的后续 turn
  // 复用挂起序列的 turnId 时必须命中同一行（全渠道一条回复的 DB 合并基础）。
  const existingFinalRow =
    (meta?.sourceKind === 'sdk_final' || meta?.sourceKind === 'truncation_continue') &&
    meta.turnId
      ? (stmts().storeMessageSelect.get(chatJid, meta.turnId) as { id: string } | undefined)
      : undefined;
  const effectiveMsgId = existingFinalRow?.id || msgId;
  stmts().storeMessageInsert.run(
    effectiveMsgId,
    chatJid,
    sourceJid ?? chatJid,
    sender,
    senderName,
    toUtf8String(content, 'messages.content'),
    timestamp,
    isFromMe ? 1 : 0,
    attachments ?? null,
    tokenUsage ?? null,
    meta?.turnId ?? null,
    meta?.sessionId ?? null,
    meta?.sdkMessageUuid ?? null,
    meta?.sourceKind ?? null,
    meta?.finalizationReason ?? null,
    meta?.taskId ?? null,
    meta?.autonomous ? 1 : 0,
  );
  return effectiveMsgId;
}

/**
 * Overwrite the `attachments` JSON column for a single message row.
 *
 * Used by the plugin-command expander to persist the expanded-prompt
 * sentinel after inline `!` commands run successfully (P1 round-14
 * crash-safety): the next recovery pass reads the sentinel and reuses
 * the stored prompt instead of re-executing inline.
 */
export function updateMessageAttachments(
  chatJid: string,
  msgId: string,
  attachmentsJson: string,
): void {
  db.prepare(
    `UPDATE messages SET attachments = ? WHERE id = ? AND chat_jid = ?`,
  ).run(attachmentsJson, msgId, chatJid);
}

/**
 * Read the `attachments` JSON column for a single message row, or null
 * if the row is missing (caller treats null as "no persisted state").
 */
export function getMessageAttachments(
  chatJid: string,
  msgId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT attachments FROM messages WHERE id = ? AND chat_jid = ? LIMIT 1`,
    )
    .get(msgId, chatJid) as { attachments: string | null } | undefined;
  if (!row) return null;
  return row.attachments ?? null;
}

/**
 * Update the token_usage field on a specific agent message, or fall back to
 * the most recent agent message without token_usage for the given chat.
 * When msgId is provided, uses precise `WHERE id = ? AND chat_jid = ?` match
 * to avoid race conditions in concurrent scenarios.
 */
export function updateLatestMessageTokenUsage(
  chatJid: string,
  tokenUsage: string,
  msgId?: string,
  costUsd?: number,
): void {
  if (msgId) {
    stmts().updateTokenUsageById.run(tokenUsage, costUsd ?? null, msgId, chatJid);
  } else {
    stmts().updateTokenUsageLatest.run(tokenUsage, costUsd ?? null, chatJid);
  }
}

/**
 * Get token usage statistics aggregated by date.
 */
export function getTokenUsageStats(
  days: number,
  chatJids?: string[],
): Array<{
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  message_count: number;
}> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const jidFilter =
    chatJids && chatJids.length > 0
      ? `AND m.chat_jid IN (${chatJids.map(() => '?').join(',')})`
      : '';
  const params: unknown[] = [sinceStr, ...(chatJids || [])];

  const baseQuery = `
    SELECT
      date(m.timestamp) as date,
      json_extract(m.token_usage, '$.modelUsage') as model_usage_json,
      json_extract(m.token_usage, '$.inputTokens') as input_tokens,
      json_extract(m.token_usage, '$.outputTokens') as output_tokens,
      json_extract(m.token_usage, '$.cacheReadInputTokens') as cache_read_tokens,
      json_extract(m.token_usage, '$.cacheCreationInputTokens') as cache_creation_tokens,
      json_extract(m.token_usage, '$.costUSD') as cost_usd
    FROM messages m
    WHERE m.token_usage IS NOT NULL
      AND m.timestamp >= ?
      ${jidFilter}
    ORDER BY m.timestamp ASC
  `;

  const rows = db.prepare(baseQuery).all(...params) as Array<{
    date: string;
    model_usage_json: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
  }>;

  // Aggregate by date + model
  type AggregatedEntry = {
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
    message_count: number;
  };
  const aggregated = new Map<string, AggregatedEntry>();

  function addToAggregated(
    date: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
    costUsd: number,
  ): void {
    const key = `${date}|${model}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.input_tokens += inputTokens;
      existing.output_tokens += outputTokens;
      existing.cache_read_tokens += cacheReadTokens;
      existing.cache_creation_tokens += cacheCreationTokens;
      existing.cost_usd += costUsd;
      existing.message_count += 1;
    } else {
      aggregated.set(key, {
        date,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
        cost_usd: costUsd,
        message_count: 1,
      });
    }
  }

  for (const row of rows) {
    if (row.model_usage_json) {
      try {
        const modelUsage = JSON.parse(row.model_usage_json) as Record<
          string,
          { inputTokens: number; outputTokens: number; costUSD: number }
        >;
        for (const [model, usage] of Object.entries(modelUsage)) {
          addToAggregated(
            row.date,
            model,
            usage.inputTokens || 0,
            usage.outputTokens || 0,
            0,
            0,
            usage.costUSD || 0,
          );
        }
      } catch (e) {
        logger.warn(
          { date: row.date, error: e },
          'Failed to parse model_usage_json',
        );
        // fallback: use aggregate fields
        addToAggregated(
          row.date,
          'unknown',
          row.input_tokens || 0,
          row.output_tokens || 0,
          row.cache_read_tokens || 0,
          row.cache_creation_tokens || 0,
          row.cost_usd || 0,
        );
      }
    } else {
      addToAggregated(
        row.date,
        'unknown',
        row.input_tokens || 0,
        row.output_tokens || 0,
        row.cache_read_tokens || 0,
        row.cache_creation_tokens || 0,
        row.cost_usd || 0,
      );
    }
  }

  return Array.from(aggregated.values());
}

/**
 * Get token usage summary totals.
 */
export function getTokenUsageSummary(
  days: number,
  chatJids?: string[],
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
} {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const jidFilter =
    chatJids && chatJids.length > 0
      ? `AND chat_jid IN (${chatJids.map(() => '?').join(',')})`
      : '';
  const params: unknown[] = [sinceStr, ...(chatJids || [])];

  const row = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(json_extract(token_usage, '$.inputTokens')), 0) as total_input,
      COALESCE(SUM(json_extract(token_usage, '$.outputTokens')), 0) as total_output,
      COALESCE(SUM(json_extract(token_usage, '$.cacheReadInputTokens')), 0) as total_cache_read,
      COALESCE(SUM(json_extract(token_usage, '$.cacheCreationInputTokens')), 0) as total_cache_creation,
      COALESCE(SUM(json_extract(token_usage, '$.costUSD')), 0) as total_cost,
      COUNT(*) as total_messages,
      COUNT(DISTINCT date(timestamp)) as total_active_days
    FROM messages
    WHERE token_usage IS NOT NULL AND timestamp >= ?
      ${jidFilter}
  `,
    )
    .get(...params) as {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_creation: number;
    total_cost: number;
    total_messages: number;
    total_active_days: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheReadTokens: row.total_cache_read,
    totalCacheCreationTokens: row.total_cache_creation,
    totalCostUSD: row.total_cost,
    totalMessages: row.total_messages,
    totalActiveDays: row.total_active_days,
  };
}

/**
 * Get a local timezone date string (YYYY-MM-DD) from a Date or ISO string.
 */
function toLocalDateString(date?: Date | string): string {
  const d = date ? new Date(date) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Insert a usage record and update daily summary.
 */
export function insertUsageRecord(record: {
  userId: string;
  groupFolder: string;
  agentId?: string | null;
  messageId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  durationMs?: number;
  numTurns?: number;
  source?: string;
}): void {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const localDate = toLocalDateString();

  db.transaction(() => {
    stmts().insertUsageInsert.run(
      id,
      record.userId,
      record.groupFolder,
      record.agentId ?? null,
      record.messageId ?? null,
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadInputTokens,
      record.cacheCreationInputTokens,
      record.costUSD,
      record.durationMs ?? 0,
      record.numTurns ?? 0,
      record.source ?? 'agent',
      now,
    );
    stmts().insertUsageUpsert.run(
      record.userId,
      record.model,
      localDate,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadInputTokens,
      record.cacheCreationInputTokens,
      record.costUSD,
    );
  })();
}

/**
 * Get usage stats from daily summary table (fixes timezone + token KPI issues).
 */
export function getUsageDailyStats(
  days: number,
  userId?: string,
  modelFilter?: string,
): Array<{
  date: string;
  model: string;
  user_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  request_count: number;
}> {
  const sinceDate = toLocalDateString(new Date(Date.now() - days * 86400000));
  const conditions: string[] = ['date >= ?'];
  const params: unknown[] = [sinceDate];

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (modelFilter) {
    conditions.push('model = ?');
    params.push(modelFilter);
  }

  const whereClause = conditions.join(' AND ');
  return db
    .prepare(
      `
    SELECT date, model, user_id,
      total_input_tokens as input_tokens,
      total_output_tokens as output_tokens,
      total_cache_read_tokens as cache_read_tokens,
      total_cache_creation_tokens as cache_creation_tokens,
      total_cost_usd as cost_usd,
      request_count
    FROM usage_daily_summary
    WHERE ${whereClause}
    ORDER BY date ASC
  `,
    )
    .all(...params) as Array<{
    date: string;
    model: string;
    user_id: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
    request_count: number;
  }>;
}

/**
 * Get usage summary from daily summary table.
 */
export function getUsageDailySummary(
  days: number,
  userId?: string,
  modelFilter?: string,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
} {
  const sinceDate = toLocalDateString(new Date(Date.now() - days * 86400000));
  const conditions: string[] = ['date >= ?'];
  const params: unknown[] = [sinceDate];

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (modelFilter) {
    conditions.push('model = ?');
    params.push(modelFilter);
  }

  const whereClause = conditions.join(' AND ');
  const row = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(total_input_tokens), 0) as total_input,
      COALESCE(SUM(total_output_tokens), 0) as total_output,
      COALESCE(SUM(total_cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(total_cache_creation_tokens), 0) as total_cache_creation,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(request_count), 0) as total_messages,
      COUNT(DISTINCT date) as total_active_days
    FROM usage_daily_summary
    WHERE ${whereClause}
  `,
    )
    .get(...params) as {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_creation: number;
    total_cost: number;
    total_messages: number;
    total_active_days: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheReadTokens: row.total_cache_read,
    totalCacheCreationTokens: row.total_cache_creation,
    totalCostUSD: row.total_cost,
    totalMessages: row.total_messages,
    totalActiveDays: row.total_active_days,
  };
}

/**
 * Get list of all models that have usage data.
 */
export function getUsageModels(): string[] {
  const rows = db
    .prepare('SELECT DISTINCT model FROM usage_daily_summary ORDER BY model')
    .all() as Array<{ model: string }>;
  return rows.map((r) => r.model);
}

/**
 * Get list of users that have usage data.
 */
export function getUsageUsers(): Array<{ id: string; username: string }> {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT uds.user_id as id, COALESCE(u.username, uds.user_id) as username
    FROM usage_daily_summary uds
    LEFT JOIN users u ON u.id = uds.user_id
    ORDER BY u.username
  `,
    )
    .all() as Array<{ id: string; username: string }>;
  return rows;
}

export function getNewMessages(
  jids: string[],
  cursor: MessageCursor,
): { messages: NewMessage[]; newCursor: MessageCursor } {
  if (jids.length === 0) return { messages: [], newCursor: cursor };

  const rawRows = getNewMessagesStmt(jids.length).all(
    cursor.timestamp,
    cursor.timestamp,
    cursor.id,
    ...jids,
  ) as NewMessage[];
  const rows = rawRows.map((r) => normalizeMessageRow(r));
  const last = rows[rows.length - 1];
  return {
    messages: rows,
    newCursor: last ? { timestamp: last.timestamp, id: last.id } : cursor,
  };
}

export function getMessagesSince(
  chatJid: string,
  cursor: MessageCursor,
): NewMessage[] {
  const rows = stmts().getMessagesSince.all(
    chatJid,
    cursor.timestamp,
    cursor.timestamp,
    cursor.id,
  ) as NewMessage[];
  return rows.map((row) => normalizeMessageRow(row));
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'> & {
    loop_kind?: string | null;
    loop_run_id?: string | null;
  },
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, execution_type, script_command, execution_mode, next_run, status, created_at, created_by, notify_channels, loop_kind, loop_run_id, autonomous)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    toUtf8String(task.prompt, 'scheduled_tasks.prompt'),
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'group',
    task.execution_type || 'agent',
    task.script_command == null
      ? null
      : toUtf8String(task.script_command, 'scheduled_tasks.script_command'),
    task.execution_mode ?? null,
    task.next_run,
    task.status,
    task.created_at,
    task.created_by ?? null,
    task.notify_channels != null ? JSON.stringify(task.notify_channels) : null,
    task.loop_kind ?? null,
    task.loop_run_id ?? null,
    task.autonomous ? 1 : 0,
  );
}

/** Parse notify_channels from JSON string stored in DB and normalize new fields */
function mapTaskRow(row: unknown): ScheduledTask {
  const r = row as any;
  if (typeof r.notify_channels === 'string') {
    try {
      r.notify_channels = JSON.parse(r.notify_channels);
    } catch {
      r.notify_channels = null;
    }
  } else if (r.notify_channels === undefined) {
    r.notify_channels = null;
  }
  // Normalize new nullable fields
  if (r.execution_mode === undefined) r.execution_mode = null;
  if (r.workspace_jid === undefined) r.workspace_jid = null;
  if (r.workspace_folder === undefined) r.workspace_folder = null;
  // Normalize autonomous: DB stores INTEGER (0/1), expose as boolean
  if (r.autonomous !== undefined) {
    r.autonomous = r.autonomous === 1 || r.autonomous === true;
  } else {
    r.autonomous = false;
  }
  // Defensive: legacy BLOB cells in TEXT-affinity columns come back as Buffer.
  r.prompt = toUtf8String(r.prompt);
  if (r.script_command !== undefined) r.script_command = toUtf8StringOrNull(r.script_command);
  return r as ScheduledTask;
}

export function getTaskById(id: string): ScheduledTask | undefined {
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id);
  return row ? mapTaskRow(row) : undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder)
    .map(mapTaskRow);
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all()
    .map(mapTaskRow);
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'context_mode'
      | 'execution_type'
      | 'execution_mode'
      | 'script_command'
      | 'next_run'
      | 'status'
      | 'notify_channels'
      | 'chat_jid'
      | 'group_folder'
      | 'autonomous'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(toUtf8String(updates.prompt, 'scheduled_tasks.prompt'));
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.context_mode !== undefined) {
    fields.push('context_mode = ?');
    values.push(updates.context_mode);
  }
  if (updates.execution_type !== undefined) {
    fields.push('execution_type = ?');
    values.push(updates.execution_type);
  }
  if (updates.execution_mode !== undefined) {
    fields.push('execution_mode = ?');
    values.push(updates.execution_mode);
  }
  if (updates.script_command !== undefined) {
    fields.push('script_command = ?');
    values.push(
      updates.script_command == null
        ? null
        : toUtf8String(updates.script_command, 'scheduled_tasks.script_command'),
    );
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.notify_channels !== undefined) {
    fields.push('notify_channels = ?');
    values.push(updates.notify_channels != null ? JSON.stringify(updates.notify_channels) : null);
  }
  if (updates.chat_jid !== undefined) {
    fields.push('chat_jid = ?');
    values.push(updates.chat_jid);
  }
  if (updates.group_folder !== undefined) {
    fields.push('group_folder = ?');
    values.push(updates.group_folder);
  }
  if (updates.autonomous !== undefined) {
    fields.push('autonomous = ?');
    values.push(updates.autonomous ? 1 : 0);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function updateTaskWorkspace(
  id: string,
  workspaceJid: string,
  workspaceFolder: string,
): void {
  db.prepare(
    'UPDATE scheduled_tasks SET workspace_jid = ?, workspace_folder = ? WHERE id = ?',
  ).run(workspaceJid, workspaceFolder, id);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function deleteTasksForGroup(groupFolder: string): void {
  const tx = db.transaction((folder: string) => {
    db.prepare(
      `
      DELETE FROM task_run_logs
      WHERE task_id IN (
        SELECT id FROM scheduled_tasks WHERE group_folder = ?
      )
      `,
    ).run(folder);
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
  });
  tx(groupFolder);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now)
    .map(mapTaskRow);
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

// Advance next_run for a task we deliberately did NOT execute (e.g. overdue
// beyond the backfill grace window). Does not touch last_run, so the task
// detail view continues to reflect the last *actual* run.
export function advanceSkippedTask(id: string, nextRun: string | null): void {
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, nextRun, id);
}

// Pause a recurring task that just ran but whose schedule produces no next_run
// (corrupted schedule_value, cron parse failure). Unlike updateTaskAfterRun(null)
// it does NOT flip status to 'completed' (which would silently disable it);
// it records THIS run's last_run/last_result so the task detail view is accurate
// and clears next_run so the owner can fix the schedule and re-activate.
export function pauseTaskAfterRun(id: string, lastResult: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = NULL, last_run = ?, last_result = ?, status = 'paused'
    WHERE id = ?
  `,
  ).run(now, lastResult, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function logTaskRunStart(taskId: string): number {
  const result = db
    .prepare(
      `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, 0, 'running', NULL, NULL)
  `,
    )
    .run(taskId, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function updateTaskRunLog(
  id: number,
  updates: { duration_ms: number; status: 'success' | 'error'; result: string | null; error: string | null },
): void {
  db.prepare(
    `
    UPDATE task_run_logs SET duration_ms = ?, status = ?, result = ?, error = ?
    WHERE id = ?
  `,
  ).run(updates.duration_ms, updates.status, updates.result, updates.error, id);
}

export function cleanupStaleRunningLogs(): number {
  const result = db
    .prepare(
      `
    UPDATE task_run_logs SET status = 'error', error = 'Process crashed before completion'
    WHERE status = 'running'
  `,
    )
    .run();
  return result.changes;
}

export function cleanupOldTaskRunLogs(retentionDays = 30): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare(`DELETE FROM task_run_logs WHERE run_at < ?`)
    .run(cutoff);
  return result.changes;
}

export function cleanupOldDailyUsage(retentionDays = 90): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString().slice(0, 10);
  const result = db
    .prepare('DELETE FROM daily_usage WHERE date < ?')
    .run(cutoff);
  return result.changes;
}

export function cleanupOldBillingAuditLog(retentionDays = 365): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare('DELETE FROM billing_audit_log WHERE created_at < ?')
    .run(cutoff);
  return result.changes;
}

// --- Loop Engineering CRUD ---

export interface LoopRunRow {
  id: string;
  owner_user_id: string;
  group_folder: string;
  chat_jid: string;
  kind: 'goal' | 'loop' | 'schedule' | 'proactive' | 'adaptive' | 'skill_evolution';
  goal_text: string;
  success_criteria: string | null;
  max_turns: number;
  current_turn: number;
  status: 'pending' | 'running' | 'reviewing' | 'iterating' | 'completed' | 'failed' | 'cancelled';
  started_at: string;
  ended_at: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  root_prompt: string | null;
  scheduled_task_id: string | null;
  workflow_mode: string | null;
  cancel_reason: string | null;
}

export interface LoopIterationRow {
  id: number;
  loop_run_id: string;
  turn_index: number;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  agent_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  review_result: 'pass' | 'fail' | 'needs_improvement' | 'skipped' | null;
  review_reason: string | null;
  agent_output: string | null;
}

export interface LoopTraceNodeRow {
  id: number;
  loop_run_id: string;
  iteration_id: number | null;
  node_type: 'turn' | 'tool' | 'review' | 'goal_check' | 'skill' | 'subagent';
  parent_node_id: number | null;
  tool_name: string | null;
  tool_use_id: string | null;
  title: string | null;
  input_summary: string | null;
  output_summary: string | null;
  started_at: string;
  ended_at: string | null;
  tokens: number;
  status: string | null;
  edited_at: string | null;
}

// =============================================================================
// Graph Engineering — row types + CRUD.
// Graph = orchestration layer over Loop. See docs/tech_solution/graph-engineering/SOLUTION.md.
// =============================================================================

export interface GraphDefinitionRow {
  id: string;
  version: number;
  parent_version_id: string | null;
  name: string;
  description: string | null;
  nodes_json: string;
  edges_json: string;
  state_schema_json: string | null;
  budget_json: string | null;
  manifest_hash: string;
  status: 'active' | 'deprecated';
  created_at: string;
}

export interface GraphRunRow {
  id: string;
  definition_id: string;
  definition_version: number;
  owner_user_id: string;
  group_folder: string;
  chat_jid: string;
  goal_text: string | null;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  current_node_id: string | null;
  state_json: string;
  max_parallel: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  started_at: string;
  ended_at: string | null;
  cancel_reason: string | null;
  /** DSL v2: definition manifest hash captured at run start, so resume can
   *  detect version drift (defense-in-depth on top of immutable version rows). */
  manifest_hash: string | null;
}

/** 异步 team build 任务行（POST /api/team/runs 立即创建，后台 buildTeam 回写）。 */
export interface TeamBuildRow {
  id: string;
  owner_user_id: string;
  group_folder: string;
  chat_jid: string;
  goal_text: string;
  status: 'running' | 'completed' | 'failed';
  plan_json: string | null;
  run_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

// --- OPC（一人公司）行类型 ---
export interface OpcCompanyRow {
  id: string;
  owner_user_id: string;
  name: string;
  vision: string | null;
  commercial_goals: string | null;
  operating_strategy: string | null;
  scale_tier: 'solo' | 'small' | 'mid';
  domains_json: string | null;
  revenue_share_json: string | null;
  status: 'active' | 'archived';
  created_at: number;
  updated_at: number;
}

export interface OpcObjectiveRow {
  id: string;
  company_id: string;
  owner_user_id: string;
  title: string;
  description: string | null;
  domain: string | null;
  acceptance_criteria: string | null;
  metrics_json: string | null;
  status: 'draft' | 'active' | 'running' | 'completed' | 'failed';
  team_build_id: string | null;
  run_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface GraphNodeRunRow {
  id: string;
  graph_run_id: string;
  node_id: string;
  node_type:
    | 'agent' | 'gate' | 'branch' | 'join' | 'human'
    | 'llm' | 'tool' | 'start' | 'end'
    | 'parallel' | 'aggregate';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'paused';
  attempt: number;
  input_summary: string | null;
  output_summary: string | null;
  state_patch_json: string | null;
  parent_node_run_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error: string | null;
  is_idempotent: number;
}

export interface GraphNodeRunLockRow {
  id: number;
  graph_run_id: string;
  node_id: string;
  workspace_folder: string;
  acquired_at: string;
  released_at: string | null;
}

// =============================================================================
// Long-running Supervisor Agent — row types + CRUD.
// =============================================================================

export interface SupervisorSessionRow {
  id: string;
  group_folder: string;
  chat_jid: string;
  owner_user_id: string | null;
  goal_text: string;
  success_criteria: string;
  strategy: 'periodic' | 'on_iteration' | 'hybrid';
  period_ms: number;
  max_checks: number;
  bound_loop_run_id: string | null;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'aborted';
  consecutive_errors: number;
  current_checks: number;
  last_check_at: string | null;
  next_check_at: string | null;
  last_bound_turn: number;
  started_at: string;
  ended_at: string | null;
  config_json: string | null;
  created_at: string;
  created_by: string | null;
}

export interface SupervisorDecisionRow {
  id: string;
  session_id: string;
  turn_index: number;
  action: 'continue' | 'redirect' | 'escalate' | 'complete' | 'abort' | 'error';
  conclusion: string | null;
  evidence_json: string | null;
  next_action_hint: string | null;
  confidence: number | null;
  trace_summary: string | null;
  triggered_by: string;
  status: 'running' | 'completed' | 'error';
  started_at: string;
  ended_at: string | null;
  error: string | null;
}

export function createSupervisorSession(row: {
  id: string;
  group_folder: string;
  chat_jid: string;
  owner_user_id?: string | null;
  goal_text: string;
  success_criteria: string;
  strategy?: SupervisorSessionRow['strategy'];
  period_ms?: number;
  max_checks?: number;
  bound_loop_run_id?: string | null;
  status?: SupervisorSessionRow['status'];
  next_check_at?: string | null;
  started_at: string;
  created_at: string;
  created_by?: string | null;
}): string {
  db.prepare(
    `INSERT INTO supervisor_sessions
      (id, group_folder, chat_jid, owner_user_id, goal_text, success_criteria, strategy,
       period_ms, max_checks, bound_loop_run_id, status, consecutive_errors, current_checks,
       last_check_at, next_check_at, last_bound_turn, started_at, ended_at, config_json,
       created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, 0, ?, NULL, NULL, ?, ?)`,
  ).run(
    row.id,
    row.group_folder,
    row.chat_jid,
    row.owner_user_id ?? null,
    row.goal_text,
    row.success_criteria,
    row.strategy ?? 'periodic',
    row.period_ms ?? 300000,
    row.max_checks ?? 100,
    row.bound_loop_run_id ?? null,
    row.status ?? 'active',
    row.next_check_at ?? null,
    row.started_at,
    row.created_at,
    row.created_by ?? null,
  );
  return row.id;
}

export function getSupervisorSession(id: string): SupervisorSessionRow | undefined {
  return db.prepare('SELECT * FROM supervisor_sessions WHERE id = ?').get(id) as
    | SupervisorSessionRow
    | undefined;
}

export function getActiveSupervisorSessionForChat(
  chatJid: string,
): SupervisorSessionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM supervisor_sessions WHERE chat_jid = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(chatJid) as SupervisorSessionRow | undefined;
}

export function listSupervisorSessions(
  ownerUserId: string | null,
  opts: { status?: string; chatJid?: string; limit?: number; offset?: number } = {},
): SupervisorSessionRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (ownerUserId !== null) {
    where.push('owner_user_id = ?');
    params.push(ownerUserId);
  }
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.chatJid) {
    where.push('chat_jid = ?');
    params.push(opts.chatJid);
  }
  params.push(opts.limit ?? 50);
  params.push(opts.offset ?? 0);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT * FROM supervisor_sessions ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params) as SupervisorSessionRow[];
}

export function listDueSupervisorSessions(nowIso: string): SupervisorSessionRow[] {
  return db
    .prepare(
      `SELECT * FROM supervisor_sessions
       WHERE status = 'active' AND next_check_at IS NOT NULL AND next_check_at <= ?
       ORDER BY next_check_at ASC`,
    )
    .all(nowIso) as SupervisorSessionRow[];
}

export function listStaleHeartbeatSupervisorSessions(
  nowMs: number,
): SupervisorSessionRow[] {
  // Active sessions whose last_check_at is older than 3x their period — i.e. a
  // check almost certainly crashed or never fired. Returned in ms-agnostic form;
  // caller compares. We fetch all active rows and filter in JS for precision.
  const rows = db
    .prepare(
      `SELECT * FROM supervisor_sessions WHERE status = 'active' AND last_check_at IS NOT NULL`,
    )
    .all() as SupervisorSessionRow[];
  return rows.filter((r) => {
    const last = Date.parse(r.last_check_at!);
    if (Number.isNaN(last)) return false;
    return nowMs - last > r.period_ms * 3;
  });
}

export function updateSupervisorSession(
  id: string,
  patch: Partial<
    Pick<
      SupervisorSessionRow,
      | 'status'
      | 'goal_text'
      | 'success_criteria'
      | 'strategy'
      | 'period_ms'
      | 'max_checks'
      | 'bound_loop_run_id'
      | 'consecutive_errors'
      | 'current_checks'
      | 'last_check_at'
      | 'next_check_at'
      | 'last_bound_turn'
      | 'ended_at'
      | 'config_json'
    >
  >,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    values.push(v as string | number | null);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE supervisor_sessions SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteSupervisorSession(id: string): void {
  db.prepare('DELETE FROM supervisor_decisions WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM supervisor_sessions WHERE id = ?').run(id);
}

export function createSupervisorDecision(row: {
  id: string;
  session_id: string;
  turn_index: number;
  started_at: string;
  triggered_by?: string;
}): string {
  db.prepare(
    `INSERT INTO supervisor_decisions
      (id, session_id, turn_index, action, conclusion, evidence_json, next_action_hint,
       confidence, trace_summary, triggered_by, status, started_at, ended_at, error)
     VALUES (?, ?, ?, 'continue', NULL, NULL, NULL, NULL, NULL, ?, 'running', ?, NULL, NULL)`,
  ).run(
    row.id,
    row.session_id,
    row.turn_index,
    row.triggered_by ?? 'tick',
    row.started_at,
  );
  return row.id;
}

export function finalizeSupervisorDecision(
  id: string,
  patch: {
    action: SupervisorDecisionRow['action'];
    conclusion?: string | null;
    evidence_json?: string | null;
    next_action_hint?: string | null;
    confidence?: number | null;
    trace_summary?: string | null;
    status?: SupervisorDecisionRow['status'];
    ended_at?: string;
    error?: string | null;
  },
): void {
  db.prepare(
    `UPDATE supervisor_decisions SET
      action = ?, conclusion = COALESCE(?, conclusion),
      evidence_json = COALESCE(?, evidence_json),
      next_action_hint = COALESCE(?, next_action_hint),
      confidence = COALESCE(?, confidence),
      trace_summary = COALESCE(?, trace_summary),
      status = ?, ended_at = COALESCE(?, ended_at),
      error = COALESCE(?, error)
     WHERE id = ?`,
  ).run(
    patch.action,
    patch.conclusion ?? null,
    patch.evidence_json ?? null,
    patch.next_action_hint ?? null,
    patch.confidence ?? null,
    patch.trace_summary ?? null,
    patch.status ?? 'completed',
    patch.ended_at ?? null,
    patch.error ?? null,
    id,
  );
}

export function listSupervisorDecisions(
  sessionId: string,
  opts: { limit?: number; offset?: number } = {},
): SupervisorDecisionRow[] {
  return db
    .prepare(
      `SELECT * FROM supervisor_decisions WHERE session_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    )
    .all(sessionId, opts.limit ?? 50, opts.offset ?? 0) as SupervisorDecisionRow[];
}

export function getLatestSupervisorDecision(
  sessionId: string,
): SupervisorDecisionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM supervisor_decisions WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(sessionId) as SupervisorDecisionRow | undefined;
}

export function cleanupStaleSupervisorChecks(): number {
  // Flip stale 'running' decisions to 'error'. Mirrors the task-scheduler
  // cleanupStaleRunningLogs() boot-time recovery pattern.
  const result = db
    .prepare(
      `UPDATE supervisor_decisions SET status = 'error', ended_at = ?,
       error = COALESCE(error, 'interrupted by process restart')
       WHERE status = 'running'`,
    )
    .run(new Date().toISOString());
  return result.changes;
}

export function cleanupOldSupervisorSessions(retentionDays = 30): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare(
      `DELETE FROM supervisor_sessions
       WHERE status IN ('completed','failed','aborted') AND started_at < ?`,
    )
    .run(cutoff);
  return result.changes;
}

export function createLoopRun(row: Partial<LoopRunRow> & {
  id: string;
  owner_user_id: string;
  group_folder: string;
  chat_jid: string;
  kind: LoopRunRow['kind'];
  goal_text: string;
  max_turns: number;
  started_at: string;
}): string {
  const id = row.id;
  db.prepare(
    `INSERT INTO loop_runs
      (id, owner_user_id, group_folder, chat_jid, kind, goal_text, success_criteria,
       max_turns, current_turn, status, started_at, total_input_tokens, total_output_tokens,
       total_cost_usd, root_prompt, scheduled_task_id, workflow_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, 0, ?, ?, ?)`,
  ).run(
    id,
    row.owner_user_id,
    row.group_folder,
    row.chat_jid,
    row.kind,
    row.goal_text,
    row.success_criteria ?? null,
    row.max_turns,
    row.status ?? 'pending',
    row.started_at,
    row.root_prompt ?? null,
    row.scheduled_task_id ?? null,
    row.workflow_mode ?? null,
  );
  return id;
}

export function getLoopRun(id: string): LoopRunRow | undefined {
  return db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(id) as
    | LoopRunRow
    | undefined;
}

export function listLoopRuns(
  ownerUserId: string,
  opts: { status?: string; kind?: string; limit?: number; offset?: number } = {},
): LoopRunRow[] {
  const where: string[] = ['owner_user_id = ?'];
  const params: (string | number)[] = [ownerUserId];
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }
  params.push(opts.limit ?? 50);
  params.push(opts.offset ?? 0);
  return db
    .prepare(
      `SELECT * FROM loop_runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params) as LoopRunRow[];
}

export function updateLoopRunStatus(
  id: string,
  status: LoopRunRow['status'],
  extra?: { currentTurn?: number; endedAt?: string; cancelReason?: string },
): void {
  if (extra) {
    db.prepare(
      `UPDATE loop_runs SET status = ?, current_turn = COALESCE(?, current_turn),
       ended_at = COALESCE(?, ended_at), cancel_reason = COALESCE(?, cancel_reason) WHERE id = ?`,
    ).run(
      status,
      extra.currentTurn ?? null,
      extra.endedAt ?? null,
      extra.cancelReason ?? null,
      id,
    );
  } else {
    db.prepare('UPDATE loop_runs SET status = ? WHERE id = ?').run(status, id);
  }
}

export function addLoopRunUsage(
  id: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  db.prepare(
    `UPDATE loop_runs SET
      total_input_tokens = total_input_tokens + ?,
      total_output_tokens = total_output_tokens + ?,
      total_cost_usd = total_cost_usd + ?
    WHERE id = ?`,
  ).run(inputTokens, outputTokens, costUsd, id);
}

export function createLoopIteration(
  loopRunId: string,
  turnIndex: number,
  startedAt: string,
): number {
  const result = db
    .prepare(
      `INSERT INTO loop_iterations (loop_run_id, turn_index, status, started_at)
       VALUES (?, ?, 'running', ?)`,
    )
    .run(loopRunId, turnIndex, startedAt);
  return Number(result.lastInsertRowid);
}

export function updateLoopIteration(
  id: number,
  updates: Partial<Pick<LoopIterationRow, 'status' | 'agent_session_id' | 'ended_at' | 'input_tokens' | 'output_tokens' | 'cost_usd' | 'review_result' | 'review_reason' | 'agent_output'>>,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    values.push(v as string | number | null);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE loop_iterations SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function listLoopIterations(loopRunId: string): LoopIterationRow[] {
  return db
    .prepare(
      'SELECT * FROM loop_iterations WHERE loop_run_id = ? ORDER BY turn_index ASC',
    )
    .all(loopRunId) as LoopIterationRow[];
}

export function createLoopTraceNode(
  row: Partial<Omit<LoopTraceNodeRow, 'id'>> & {
    loop_run_id: string;
    node_type: LoopTraceNodeRow['node_type'];
    started_at: string;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO loop_trace_nodes
       (loop_run_id, iteration_id, node_type, parent_node_id, tool_name, tool_use_id,
        title, input_summary, output_summary, started_at, ended_at, tokens, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.loop_run_id,
      row.iteration_id ?? null,
      row.node_type,
      row.parent_node_id ?? null,
      row.tool_name ?? null,
      row.tool_use_id ?? null,
      row.title ?? null,
      row.input_summary ?? null,
      row.output_summary ?? null,
      row.started_at,
      row.ended_at ?? null,
      row.tokens ?? 0,
      row.status ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function updateLoopTraceNode(
  id: number,
  updates: Partial<Pick<LoopTraceNodeRow, 'ended_at' | 'output_summary' | 'tokens' | 'status' | 'edited_at'>>,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    values.push(v as string | number | null);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE loop_trace_nodes SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function listLoopTraceNodes(loopRunId: string): LoopTraceNodeRow[] {
  return db
    .prepare(
      'SELECT * FROM loop_trace_nodes WHERE loop_run_id = ? ORDER BY started_at ASC',
    )
    .all(loopRunId) as LoopTraceNodeRow[];
}

export function cleanupOldLoopRuns(retentionDays = 30): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare(
      `DELETE FROM loop_runs WHERE status IN ('completed','failed','cancelled') AND started_at < ?`,
    )
    .run(cutoff);
  return result.changes;
}

// =============================================================================
// Graph Engineering — CRUD accessors.
// Used by src/graph-engineering/* (orchestrator, scheduler, runner, recovery).
// =============================================================================

/** Insert a new graph definition version. Returns composite key "id@version". */
export function createGraphDefinition(
  row: Omit<GraphDefinitionRow, 'created_at'> & { created_at?: string },
): string {
  const version = row.version ?? 1;
  const created_at = row.created_at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO graph_definitions
      (id, version, parent_version_id, name, description, nodes_json, edges_json,
       state_schema_json, budget_json, manifest_hash, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    version,
    row.parent_version_id ?? null,
    row.name,
    row.description ?? null,
    row.nodes_json,
    row.edges_json,
    row.state_schema_json ?? null,
    row.budget_json ?? null,
    row.manifest_hash,
    row.status ?? 'active',
    created_at,
  );
  return `${row.id}@${version}`;
}

/** Get a specific (id, version) definition. */
export function getGraphDefinition(
  id: string,
  version: number,
): GraphDefinitionRow | undefined {
  return db
    .prepare('SELECT * FROM graph_definitions WHERE id = ? AND version = ?')
    .get(id, version) as GraphDefinitionRow | undefined;
}

/** Get the latest active version of a definition by id. */
export function getLatestGraphDefinition(id: string): GraphDefinitionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM graph_definitions WHERE id = ? AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
    )
    .get(id) as GraphDefinitionRow | undefined;
}

/** List all graph definitions (latest active version per id). */
export function listGraphDefinitions(): GraphDefinitionRow[] {
  return db
    .prepare(
      `SELECT * FROM graph_definitions WHERE status = 'active'
       GROUP BY id HAVING version = MAX(version)
       ORDER BY created_at DESC`,
    )
    .all() as GraphDefinitionRow[];
}

// --- graph_runs ---

export function createGraphRun(row: {
  id: string;
  definition_id: string;
  definition_version: number;
  owner_user_id: string;
  group_folder: string;
  chat_jid: string;
  goal_text?: string | null;
  max_parallel?: number;
  state_json?: string;
  manifest_hash?: string | null;
  started_at: string;
}): string {
  db.prepare(
    `INSERT INTO graph_runs
      (id, definition_id, definition_version, owner_user_id, group_folder, chat_jid,
       goal_text, status, current_node_id, state_json, max_parallel, started_at,
       total_input_tokens, total_output_tokens, total_cost_usd, manifest_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, 0, 0, 0, ?)`,
  ).run(
    row.id,
    row.definition_id,
    row.definition_version,
    row.owner_user_id,
    row.group_folder,
    row.chat_jid,
    row.goal_text ?? null,
    row.state_json ?? '{}',
    row.max_parallel ?? 4,
    row.started_at,
    row.manifest_hash ?? null,
  );
  return row.id;
}

export function getGraphRun(id: string): GraphRunRow | undefined {
  return db.prepare('SELECT * FROM graph_runs WHERE id = ?').get(id) as
    | GraphRunRow
    | undefined;
}

// --- team_builds（异步组建任务） ---

/** 创建一条 status='running' 的 team build 任务，返回 id。 */
export function createTeamBuild(row: {
  id: string;
  owner_user_id: string;
  group_folder: string;
  chat_jid: string;
  goal_text: string;
}): string {
  const now = Date.now();
  db.prepare(
    `INSERT INTO team_builds
      (id, owner_user_id, group_folder, chat_jid, goal_text, status,
       plan_json, run_id, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, ?)`,
  ).run(
    row.id,
    row.owner_user_id,
    row.group_folder,
    row.chat_jid,
    row.goal_text,
    now,
    now,
  );
  return row.id;
}

export function getTeamBuild(id: string): TeamBuildRow | undefined {
  return db.prepare('SELECT * FROM team_builds WHERE id = ?').get(id) as
    | TeamBuildRow
    | undefined;
}

/** 后台 buildTeam 成功后回写 plan + runId，置 status='completed'。 */
export function completeTeamBuild(
  id: string,
  result: { plan_json: string; run_id: string },
): void {
  db.prepare(
    `UPDATE team_builds
     SET status = 'completed', plan_json = ?, run_id = ?, error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(result.plan_json, result.run_id, Date.now(), id);
}

/** 后台 buildTeam 失败后回写 error，置 status='failed'。 */
export function failTeamBuild(id: string, error: string): void {
  db.prepare(
    `UPDATE team_builds
     SET status = 'failed', error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(error, Date.now(), id);
}

/**
 * List a user's team builds (history). Newest first. Reuses the existing
 * idx_team_builds_owner index. v2 (TeamPage UI): powers the "历史任务" list so
 * the user can reopen a past team run with its full plan (role names intact).
 */
export function listTeamBuilds(
  ownerUserId: string,
  limit = 20,
): TeamBuildRow[] {
  return db
    .prepare(
      `SELECT * FROM team_builds WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(ownerUserId, limit) as TeamBuildRow[];
}

// --- OPC（一人公司）CRUD ---

/** 创建一人公司，返回 id。 */
export function createOpcCompany(row: {
  id: string;
  owner_user_id: string;
  name: string;
  vision?: string | null;
  commercial_goals?: string | null;
  operating_strategy?: string | null;
  scale_tier?: 'solo' | 'small' | 'mid';
  domains_json?: string | null;
  revenue_share_json?: string | null;
}): string {
  const now = Date.now();
  db.prepare(
    `INSERT INTO opc_companies
      (id, owner_user_id, name, vision, commercial_goals, operating_strategy,
       scale_tier, domains_json, revenue_share_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    row.id,
    row.owner_user_id,
    row.name,
    row.vision ?? null,
    row.commercial_goals ?? null,
    row.operating_strategy ?? null,
    row.scale_tier ?? 'solo',
    row.domains_json ?? null,
    row.revenue_share_json ?? null,
    now,
    now,
  );
  return row.id;
}

export function getOpcCompany(id: string): OpcCompanyRow | undefined {
  return db.prepare('SELECT * FROM opc_companies WHERE id = ?').get(id) as
    | OpcCompanyRow
    | undefined;
}

export function listOpcCompanies(ownerUserId: string): OpcCompanyRow[] {
  return db
    .prepare(
      `SELECT * FROM opc_companies WHERE owner_user_id = ? ORDER BY created_at DESC`,
    )
    .all(ownerUserId) as OpcCompanyRow[];
}

/** 局部更新公司字段——仅更新传入的键，避免覆盖未传字段。 */
export function updateOpcCompany(
  id: string,
  fields: Partial<{
    name: string;
    vision: string | null;
    commercial_goals: string | null;
    operating_strategy: string | null;
    scale_tier: 'solo' | 'small' | 'mid';
    domains_json: string | null;
    revenue_share_json: string | null;
    status: 'active' | 'archived';
  }>,
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const params = keys.map((k) => (fields as Record<string, unknown>)[k]);
  params.push(Date.now(), id);
  db.prepare(
    `UPDATE opc_companies SET ${setClause}, updated_at = ? WHERE id = ?`,
  ).run(...params);
}

/** 删除公司并级联删除其下所有目标——不依赖外键，显式删。 */
export function deleteOpcCompany(id: string): void {
  db.prepare('DELETE FROM opc_objectives WHERE company_id = ?').run(id);
  db.prepare('DELETE FROM opc_companies WHERE id = ?').run(id);
}

// --- OPC 商业目标 CRUD ---

/** 在公司下创建商业目标，返回 id。 */
export function createOpcObjective(row: {
  id: string;
  company_id: string;
  owner_user_id: string;
  title: string;
  description?: string | null;
  domain?: string | null;
  acceptance_criteria?: string | null;
  metrics_json?: string | null;
}): string {
  const now = Date.now();
  db.prepare(
    `INSERT INTO opc_objectives
      (id, company_id, owner_user_id, title, description, domain,
       acceptance_criteria, metrics_json, status, team_build_id, run_id,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, ?, ?)`,
  ).run(
    row.id,
    row.company_id,
    row.owner_user_id,
    row.title,
    row.description ?? null,
    row.domain ?? null,
    row.acceptance_criteria ?? null,
    row.metrics_json ?? null,
    now,
    now,
  );
  return row.id;
}

export function getOpcObjective(id: string): OpcObjectiveRow | undefined {
  return db.prepare('SELECT * FROM opc_objectives WHERE id = ?').get(id) as
    | OpcObjectiveRow
    | undefined;
}

export function listOpcObjectivesByCompany(companyId: string): OpcObjectiveRow[] {
  return db
    .prepare(
      `SELECT * FROM opc_objectives WHERE company_id = ? ORDER BY created_at DESC`,
    )
    .all(companyId) as OpcObjectiveRow[];
}

/** 局部更新目标——launch 成功/失败时回写 status/team_build_id/run_id。 */
export function updateOpcObjective(
  id: string,
  fields: Partial<{
    title: string;
    description: string | null;
    domain: string | null;
    acceptance_criteria: string | null;
    metrics_json: string | null;
    status: 'draft' | 'active' | 'running' | 'completed' | 'failed';
    team_build_id: string | null;
    run_id: string | null;
  }>,
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const params = keys.map((k) => (fields as Record<string, unknown>)[k]);
  params.push(Date.now(), id);
  db.prepare(
    `UPDATE opc_objectives SET ${setClause}, updated_at = ? WHERE id = ?`,
  ).run(...params);
}

export function deleteOpcObjective(id: string): void {
  db.prepare('DELETE FROM opc_objectives WHERE id = ?').run(id);
}

export function listGraphRuns(
  ownerUserId: string,
  opts: { status?: string; limit?: number; offset?: number } = {},
): GraphRunRow[] {
  const where: string[] = ['owner_user_id = ?'];
  const params: (string | number)[] = [ownerUserId];
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  params.push(opts.limit ?? 50);
  params.push(opts.offset ?? 0);
  return db
    .prepare(
      `SELECT * FROM graph_runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params) as GraphRunRow[];
}

export function updateGraphRunStatus(
  id: string,
  status: GraphRunRow['status'],
  extra?: {
    currentNodeId?: string | null;
    stateJson?: string;
    endedAt?: string;
    cancelReason?: string;
  },
): void {
  if (extra) {
    db.prepare(
      `UPDATE graph_runs SET status = ?,
        current_node_id = CASE WHEN ? IS NULL THEN current_node_id ELSE ? END,
        state_json = COALESCE(?, state_json),
        ended_at = COALESCE(?, ended_at),
        cancel_reason = COALESCE(?, cancel_reason)
       WHERE id = ?`,
    ).run(
      status,
      extra.currentNodeId === undefined ? null : 1,
      extra.currentNodeId ?? null,
      extra.stateJson ?? null,
      extra.endedAt ?? null,
      extra.cancelReason ?? null,
      id,
    );
  } else {
    db.prepare('UPDATE graph_runs SET status = ? WHERE id = ?').run(status, id);
  }
}

/** P1: repoint a graph run to a new definition version (dynamic re-plan).
 *  Used after registerDefinition creates v(N+1) so resume loads the new
 *  nodes/edges. Completed-node set is unaffected; new nodes become ready. */
export function repointGraphRunDefinition(
  runId: string,
  definitionId: string,
  version: number,
): void {
  db.prepare(
    `UPDATE graph_runs SET definition_id = ?, definition_version = ? WHERE id = ?`,
  ).run(definitionId, version, runId);
}

export function addGraphRunUsage(
  id: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  db.prepare(
    `UPDATE graph_runs SET
      total_input_tokens = total_input_tokens + ?,
      total_output_tokens = total_output_tokens + ?,
      total_cost_usd = total_cost_usd + ?
    WHERE id = ?`,
  ).run(inputTokens, outputTokens, costUsd, id);
}

/** List graph_runs not in a terminal state — used by boot recovery. */
export function listNonTerminalGraphRuns(): GraphRunRow[] {
  return db
    .prepare(
      `SELECT * FROM graph_runs WHERE status IN ('running','paused','pending')`,
    )
    .all() as GraphRunRow[];
}

/**
 * DSL v2: aggregated usage for a run (input + output tokens + cost). Read from
 * the run-level cumulative columns maintained by addGraphRunUsage. Used by the
 * orchestrator's budget circuit breaker (maxTokens / maxCostUsd).
 */
export function getGraphRunUsage(id: string): {
  totalTokens: number;
  totalCostUsd: number;
} {
  const row = db
    .prepare(
      'SELECT total_input_tokens, total_output_tokens, total_cost_usd FROM graph_runs WHERE id = ?',
    )
    .get(id) as
    | { total_input_tokens: number; total_output_tokens: number; total_cost_usd: number }
    | undefined;
  if (!row) return { totalTokens: 0, totalCostUsd: 0 };
  return {
    totalTokens: (row.total_input_tokens ?? 0) + (row.total_output_tokens ?? 0),
    totalCostUsd: row.total_cost_usd ?? 0,
  };
}

// --- graph_node_runs ---

export function createGraphNodeRun(row: {
  id: string;
  graph_run_id: string;
  node_id: string;
  node_type: GraphNodeRunRow['node_type'];
  parent_node_run_id?: string | null;
  is_idempotent?: boolean;
  input_summary?: string;
}): string {
  db.prepare(
    `INSERT INTO graph_node_runs
      (id, graph_run_id, node_id, node_type, status, attempt, input_summary,
       output_summary, state_patch_json, parent_node_run_id, started_at, ended_at,
       input_tokens, output_tokens, cost_usd, error, is_idempotent)
     VALUES (?, ?, ?, ?, 'running', 0, ?, NULL, NULL, ?, ?, NULL, 0, 0, 0, NULL, ?)`,
  ).run(
    row.id,
    row.graph_run_id,
    row.node_id,
    row.node_type,
    row.input_summary ?? null,
    row.parent_node_run_id ?? null,
    new Date().toISOString(),
    row.is_idempotent ? 1 : 0,
  );
  return row.id;
}

export function getGraphNodeRun(id: string): GraphNodeRunRow | undefined {
  return db.prepare('SELECT * FROM graph_node_runs WHERE id = ?').get(id) as
    | GraphNodeRunRow
    | undefined;
}

export function listGraphNodeRuns(graphRunId: string): GraphNodeRunRow[] {
  return db
    .prepare(
      'SELECT * FROM graph_node_runs WHERE graph_run_id = ? ORDER BY started_at ASC',
    )
    .all(graphRunId) as GraphNodeRunRow[];
}

/**
 * DSL v2: timeline of node status changes for a run, ordered by start time.
 * Each row is one node's run (start → end window + terminal status). Used by
 * the frontend history-replay player to rebuild the canvas state at a given
 * timestamp. Filters out pending (never-started) rows.
 */
export function listGraphNodeTimeline(graphRunId: string): Array<{
  nodeId: string;
  nodeType: GraphNodeRunRow['node_type'];
  title: string | null;
  status: GraphNodeRunRow['status'];
  startedAt: string | null;
  endedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error: string | null;
}> {
  return db
    .prepare(
      `SELECT node_id AS nodeId, node_type AS nodeType, NULL AS title,
              status, started_at AS startedAt, ended_at AS endedAt,
              input_tokens AS inputTokens, output_tokens AS outputTokens,
              cost_usd AS costUsd, error
       FROM graph_node_runs
       WHERE graph_run_id = ? AND started_at IS NOT NULL
       ORDER BY started_at ASC`,
    )
    .all(graphRunId) as Array<{
      nodeId: string;
      nodeType: GraphNodeRunRow['node_type'];
      title: string | null;
      status: GraphNodeRunRow['status'];
      startedAt: string | null;
      endedAt: string | null;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      error: string | null;
    }>;
}

/** Latest node_run for a given (run, node_id), regardless of status. */
export function getLatestGraphNodeRun(
  graphRunId: string,
  nodeId: string,
): GraphNodeRunRow | undefined {
  return db
    .prepare(
      `SELECT * FROM graph_node_runs WHERE graph_run_id = ? AND node_id = ?
       ORDER BY attempt DESC LIMIT 1`,
    )
    .get(graphRunId, nodeId) as GraphNodeRunRow | undefined;
}

export function updateGraphNodeRun(
  id: string,
  updates: Partial<
    Pick<
      GraphNodeRunRow,
      | 'status'
      | 'attempt'
      | 'output_summary'
      | 'state_patch_json'
      | 'ended_at'
      | 'input_tokens'
      | 'output_tokens'
      | 'cost_usd'
      | 'error'
    >
  >,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    values.push(v as string | number | null);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE graph_node_runs SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

/** Set of node_id values that reached 'completed' for a run — resume skip set. */
export function getCompletedGraphNodeIds(graphRunId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT node_id FROM graph_node_runs WHERE graph_run_id = ? AND status = 'completed'`,
    )
    .all(graphRunId) as { node_id: string }[];
  return new Set(rows.map((r) => r.node_id));
}

/** Reset a node and its downstream to pending (rerun). */
export function resetGraphNodeAndDownstream(
  graphRunId: string,
  nodeId: string,
): number {
  // P0: reset the single node (downstream recompute is driven by scheduler
  // re-deriving ready queue from completed-set). Mark node pending, attempt+1
  // is applied when the runner picks it up again.
  const result = db
    .prepare(
      `UPDATE graph_node_runs SET status = 'pending', ended_at = NULL, error = NULL
       WHERE graph_run_id = ? AND node_id = ? AND status NOT IN ('running')`,
    )
    .run(graphRunId, nodeId);
  return result.changes;
}

// --- graph_node_run_locks (workspace isolation, AC2.7) ---

export function acquireNodeLock(row: {
  graph_run_id: string;
  node_id: string;
  workspace_folder: string;
}): number {
  const result = db
    .prepare(
      `INSERT INTO graph_node_run_locks (graph_run_id, node_id, workspace_folder, acquired_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(row.graph_run_id, row.node_id, row.workspace_folder, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function releaseNodeLock(id: number): void {
  db.prepare(
    `UPDATE graph_node_run_locks SET released_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

export function getActiveNodeLocks(graphRunId: string): GraphNodeRunLockRow[] {
  return db
    .prepare(
      `SELECT * FROM graph_node_run_locks WHERE graph_run_id = ? AND released_at IS NULL`,
    )
    .all(graphRunId) as GraphNodeRunLockRow[];
}

// =============================================================================
// Self-Evolving Harness — version archive, proposals, eval runs, eval cases.
// Row types + CRUD. The harness registry (src/harness-registry.ts) and the
// eval runner (src/harness-eval.ts) build on these accessors.
// =============================================================================

export type HarnessVersionStatus =
  | 'experimental'
  | 'promoted'
  | 'archived'
  | 'rolled_back';

export interface HarnessVersionRow {
  id: string;
  parent_id: string | null;
  hash: string;
  manifest_json: string;
  status: HarnessVersionStatus;
  source: string;
  created_at: string;
  promoted_at: string | null;
  notes: string | null;
}

export type HarnessVerdict =
  | 'improved'
  | 'regressed'
  | 'neutral'
  | 'inconclusive'
  | null;

export interface HarnessProposalRow {
  id: string;
  proposed_version_id: string;
  baseline_version_id: string;
  hypothesis: string;
  expected_behavior: string;
  mutation_patch: string;
  verdict: HarnessVerdict;
  evidence_run_ids_json: string | null;
  trace_summary: string | null;
  created_at: string;
  judged_at: string | null;
}

export type HarnessEvalRunStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface HarnessEvalRunRow {
  id: string;
  version_id: string;
  proposal_id: string | null;
  case_id: string;
  status: HarnessEvalRunStatus;
  pass: number | null; // 0 / 1 / null (null = inconclusive)
  score: number | null;
  trace_node_root_id: number | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface HarnessEvalCaseRow {
  case_id: string;
  name: string;
  prompt: string;
  assertions_json: string;
  rubric_json: string;
  enabled: number; // 0 / 1
  created_at: string;
}

export function createHarnessVersion(row: {
  id: string;
  parentId?: string | null;
  hash: string;
  manifestJson: string;
  status?: HarnessVersionStatus;
  source?: string;
  notes?: string | null;
}): string {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO harness_versions
      (id, parent_id, hash, manifest_json, status, source, created_at, promoted_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.parentId ?? null,
    row.hash,
    row.manifestJson,
    row.status ?? 'experimental',
    row.source ?? 'manual',
    now,
    row.status === 'promoted' ? now : null,
    row.notes ?? null,
  );
  return row.id;
}

export function getHarnessVersion(id: string): HarnessVersionRow | undefined {
  return db.prepare('SELECT * FROM harness_versions WHERE id = ?').get(id) as
    | HarnessVersionRow
    | undefined;
}

export function listHarnessVersions(
  opts: { status?: HarnessVersionStatus; limit?: number; offset?: number } = {},
): HarnessVersionRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  params.push(opts.limit ?? 100);
  params.push(opts.offset ?? 0);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT * FROM harness_versions ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params) as HarnessVersionRow[];
}

export function getPromotedHarnessVersion(): HarnessVersionRow | undefined {
  return db
    .prepare("SELECT * FROM harness_versions WHERE status = 'promoted' ORDER BY promoted_at DESC LIMIT 1")
    .get() as HarnessVersionRow | undefined;
}

export function updateHarnessVersionStatus(
  id: string,
  status: HarnessVersionStatus,
  extra?: { promotedAt?: string | null; notes?: string | null },
): void {
  const now = extra?.promotedAt ?? (status === 'promoted' ? new Date().toISOString() : null);
  db.prepare(
    `UPDATE harness_versions
     SET status = ?, promoted_at = COALESCE(?, promoted_at), notes = COALESCE(?, notes)
     WHERE id = ?`,
  ).run(status, now, extra?.notes ?? null, id);
}

export function createHarnessProposal(row: {
  id: string;
  proposedVersionId: string;
  baselineVersionId: string;
  hypothesis: string;
  expectedBehavior: string;
  mutationPatch: string;
}): string {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO harness_proposals
      (id, proposed_version_id, baseline_version_id, hypothesis, expected_behavior,
       mutation_patch, verdict, evidence_run_ids_json, trace_summary, created_at, judged_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)`,
  ).run(
    row.id,
    row.proposedVersionId,
    row.baselineVersionId,
    row.hypothesis,
    row.expectedBehavior,
    row.mutationPatch,
    now,
  );
  return row.id;
}

export function getHarnessProposal(id: string): HarnessProposalRow | undefined {
  return db.prepare('SELECT * FROM harness_proposals WHERE id = ?').get(id) as
    | HarnessProposalRow
    | undefined;
}

export function listHarnessProposals(
  opts: { baselineVersionId?: string; limit?: number } = {},
): HarnessProposalRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.baselineVersionId) {
    where.push('baseline_version_id = ?');
    params.push(opts.baselineVersionId);
  }
  params.push(opts.limit ?? 50);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT * FROM harness_proposals ${whereClause} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params) as HarnessProposalRow[];
}

export function updateHarnessProposalVerdict(
  id: string,
  verdict: NonNullable<HarnessVerdict>,
  evidence: { runIds: string[]; traceSummary: string },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE harness_proposals
     SET verdict = ?, evidence_run_ids_json = ?, trace_summary = ?, judged_at = ?
     WHERE id = ?`,
  ).run(
    verdict,
    JSON.stringify(evidence.runIds),
    evidence.traceSummary,
    now,
    id,
  );
}

export function createHarnessEvalRun(row: {
  id: string;
  versionId: string;
  proposalId?: string | null;
  caseId: string;
  startedAt: string;
}): string {
  db.prepare(
    `INSERT INTO harness_eval_runs
      (id, version_id, proposal_id, case_id, status, pass, score, trace_node_root_id,
       started_at, finished_at, error)
     VALUES (?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, NULL, NULL)`,
  ).run(
    row.id,
    row.versionId,
    row.proposalId ?? null,
    row.caseId,
    row.startedAt,
  );
  return row.id;
}

export function updateHarnessEvalRun(
  id: string,
  updates: {
    status: HarnessEvalRunStatus;
    pass?: number | null;
    score?: number | null;
    traceNodeRootId?: number | null;
    finishedAt?: string;
    error?: string | null;
  },
): void {
  db.prepare(
    `UPDATE harness_eval_runs
     SET status = ?, pass = COALESCE(?, pass), score = COALESCE(?, score),
         trace_node_root_id = COALESCE(?, trace_node_root_id),
         finished_at = COALESCE(?, finished_at), error = COALESCE(?, error)
     WHERE id = ?`,
  ).run(
    updates.status,
    updates.pass ?? null,
    updates.score ?? null,
    updates.traceNodeRootId ?? null,
    updates.finishedAt ?? null,
    updates.error ?? null,
    id,
  );
}

export function listHarnessEvalRuns(
  opts: { versionId?: string; proposalId?: string; limit?: number } = {},
): HarnessEvalRunRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.versionId) {
    where.push('version_id = ?');
    params.push(opts.versionId);
  }
  if (opts.proposalId) {
    where.push('proposal_id = ?');
    params.push(opts.proposalId);
  }
  params.push(opts.limit ?? 200);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT * FROM harness_eval_runs ${whereClause} ORDER BY started_at DESC LIMIT ?`,
    )
    .all(...params) as HarnessEvalRunRow[];
}

export function upsertHarnessEvalCase(row: {
  caseId: string;
  name: string;
  prompt: string;
  assertionsJson: string;
  rubricJson: string;
  enabled?: boolean;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO harness_eval_cases
      (case_id, name, prompt, assertions_json, rubric_json, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(case_id) DO UPDATE SET
       name = excluded.name,
       prompt = excluded.prompt,
       assertions_json = excluded.assertions_json,
       rubric_json = excluded.rubric_json,
       enabled = excluded.enabled`,
  ).run(
    row.caseId,
    row.name,
    row.prompt,
    row.assertionsJson,
    row.rubricJson,
    row.enabled === false ? 0 : 1,
    now,
  );
}

export function listHarnessEvalCases(enabledOnly = false): HarnessEvalCaseRow[] {
  const sql = enabledOnly
    ? 'SELECT * FROM harness_eval_cases WHERE enabled = 1 ORDER BY case_id'
    : 'SELECT * FROM harness_eval_cases ORDER BY case_id';
  return db.prepare(sql).all() as HarnessEvalCaseRow[];
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

export function deleteRouterState(key: string): void {
  db.prepare('DELETE FROM router_state WHERE key = ?').run(key);
}

// --- Chat trace nodes (DAG visualization for regular chat conversations) ---

export interface ChatTraceNodeRow {
  id: number;
  chat_jid: string;
  session_id: string | null;
  parent_node_id: number | null;
  node_type: 'turn' | 'tool' | 'review' | 'goal_check' | 'skill' | 'subagent';
  title: string | null;
  input_summary: string | null;
  output_summary: string | null;
  tokens: number;
  status: string | null;
  annotation_input: string | null;
  annotation_output: string | null;
  started_at: string;
  ended_at: string | null;
  // Super Agent Team (v53): link trace node to its graph run/node + tool call.
  graph_run_id: string | null;
  graph_node_id: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
}

export interface ChatTraceNodeUpsertInput {
  id: number;
  chat_jid: string;
  session_id?: string | null;
  parent_node_id?: number | null;
  node_type: ChatTraceNodeRow['node_type'];
  title?: string | null;
  input_summary?: string | null;
  output_summary?: string | null;
  tokens?: number;
  status?: string | null;
  started_at: string;
  ended_at?: string | null;
  graph_run_id?: string | null;
  graph_node_id?: string | null;
  tool_name?: string | null;
  tool_use_id?: string | null;
}

/**
 * Idempotent upsert keyed on (chat_jid, id). The agent-runner allocates nodeIds
 * within a single session; the main process persists them as they arrive via
 * stream events. Replays (e.g. on page refresh) are safe.
 */
export function upsertChatTraceNode(row: ChatTraceNodeUpsertInput): void {
  db.prepare(
    `INSERT INTO chat_trace_nodes
       (id, chat_jid, session_id, parent_node_id, node_type, title,
        input_summary, output_summary, tokens, status, started_at, ended_at,
        graph_run_id, graph_node_id, tool_name, tool_use_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_jid, id) DO UPDATE SET
       session_id = COALESCE(excluded.session_id, session_id),
       parent_node_id = COALESCE(excluded.parent_node_id, parent_node_id),
       title = COALESCE(excluded.title, title),
       input_summary = COALESCE(excluded.input_summary, input_summary),
       output_summary = COALESCE(excluded.output_summary, output_summary),
       tokens = MAX(tokens, excluded.tokens),
       status = COALESCE(excluded.status, status),
       ended_at = COALESCE(excluded.ended_at, ended_at),
       graph_run_id = COALESCE(excluded.graph_run_id, graph_run_id),
       graph_node_id = COALESCE(excluded.graph_node_id, graph_node_id),
       tool_name = COALESCE(excluded.tool_name, tool_name),
       tool_use_id = COALESCE(excluded.tool_use_id, tool_use_id)`,
  ).run(
    row.id,
    row.chat_jid,
    row.session_id ?? null,
    row.parent_node_id ?? null,
    row.node_type,
    row.title ?? null,
    row.input_summary ?? null,
    row.output_summary ?? null,
    row.tokens ?? 0,
    row.status ?? null,
    row.started_at,
    row.ended_at ?? null,
    row.graph_run_id ?? null,
    row.graph_node_id ?? null,
    row.tool_name ?? null,
    row.tool_use_id ?? null,
  );
}

export function listChatTraceNodes(chatJid: string): ChatTraceNodeRow[] {
  return db
    .prepare(
      'SELECT * FROM chat_trace_nodes WHERE chat_jid = ? ORDER BY id ASC',
    )
    .all(chatJid) as ChatTraceNodeRow[];
}

export function getChatTraceNode(
  chatJid: string,
  nodeId: number,
): ChatTraceNodeRow | undefined {
  return db
    .prepare('SELECT * FROM chat_trace_nodes WHERE chat_jid = ? AND id = ?')
    .get(chatJid, nodeId) as ChatTraceNodeRow | undefined;
}

export function saveChatTraceNodeAnnotation(
  chatJid: string,
  nodeId: number,
  annotationInput: string | null,
  annotationOutput: string | null,
): void {
  db.prepare(
    `UPDATE chat_trace_nodes
     SET annotation_input = ?, annotation_output = ?
     WHERE chat_jid = ? AND id = ?`,
  ).run(annotationInput, annotationOutput, chatJid, nodeId);
}

export function deleteChatTraceNodes(chatJid: string): number {
  const result = db
    .prepare('DELETE FROM chat_trace_nodes WHERE chat_jid = ?')
    .run(chatJid);
  return result.changes;
}

// ---- Super Agent Team: graph-node trace + tool-call persistence (v53) ----

/** Trace nodes belonging to a specific agent node's internal sub-graph. */
export function listGraphNodeTraceNodes(
  graphRunId: string,
  graphNodeId: string,
): ChatTraceNodeRow[] {
  return db
    .prepare(
      'SELECT * FROM chat_trace_nodes WHERE graph_run_id = ? AND graph_node_id = ? ORDER BY id ASC',
    )
    .all(graphRunId, graphNodeId) as ChatTraceNodeRow[];
}

export interface TraceToolCallRow {
  id: number;
  graph_run_id: string | null;
  graph_node_id: string | null;
  chat_jid: string | null;
  tool_use_id: string;
  tool_name: string;
  input_json: string | null;
  output_json: string | null;
  status: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface TraceToolCallUpsertInput {
  graph_run_id?: string | null;
  graph_node_id?: string | null;
  chat_jid?: string | null;
  tool_use_id: string;
  tool_name: string;
  input_json?: string | null;
  output_json?: string | null;
  status?: string | null;
  started_at: string;
  ended_at?: string | null;
}

/**
 * Idempotent upsert keyed on (graph_run_id, tool_use_id). The agent-runner
 * emits tool-input then tool-result as separate stream events; each call
 * merges into the same row (input_json on the first, output_json on the
 * second). Null graph_run_id rows are allowed for non-graph (plain chat)
 * tool calls if later needed.
 */
export function upsertTraceToolCall(row: TraceToolCallUpsertInput): void {
  db.prepare(
    `INSERT INTO trace_tool_calls
       (graph_run_id, graph_node_id, chat_jid, tool_use_id, tool_name,
        input_json, output_json, status, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(graph_run_id, tool_use_id) DO UPDATE SET
       graph_node_id = COALESCE(excluded.graph_node_id, graph_node_id),
       chat_jid = COALESCE(excluded.chat_jid, chat_jid),
       tool_name = COALESCE(excluded.tool_name, tool_name),
       input_json = COALESCE(excluded.input_json, input_json),
       output_json = COALESCE(excluded.output_json, output_json),
       status = COALESCE(excluded.status, status),
       ended_at = COALESCE(excluded.ended_at, ended_at)`,
  ).run(
    row.graph_run_id ?? null,
    row.graph_node_id ?? null,
    row.chat_jid ?? null,
    row.tool_use_id,
    row.tool_name,
    row.input_json ?? null,
    row.output_json ?? null,
    row.status ?? null,
    row.started_at,
    row.ended_at ?? null,
  );
}

export function listTraceToolCalls(
  graphRunId: string,
  graphNodeId?: string,
): TraceToolCallRow[] {
  if (graphNodeId) {
    return db
      .prepare(
        'SELECT * FROM trace_tool_calls WHERE graph_run_id = ? AND graph_node_id = ? ORDER BY id ASC',
      )
      .all(graphRunId, graphNodeId) as TraceToolCallRow[];
  }
  return db
    .prepare('SELECT * FROM trace_tool_calls WHERE graph_run_id = ? ORDER BY id ASC')
    .all(graphRunId) as TraceToolCallRow[];
}

/** Look up an agent definition by (owner user id, name) for idempotent team build. */
export function getAgentDefinitionByName(
  userId: string,
  name: string,
): AgentDefinitionRow | undefined {
  return db
    .prepare('SELECT * FROM agent_definitions WHERE user_id = ? AND name = ?')
    .get(userId, name) as AgentDefinitionRow | undefined;
}

export function getRouterStateByPrefix(
  prefix: string,
): Array<{ key: string; value: string }> {
  return db
    .prepare('SELECT key, value FROM router_state WHERE key LIKE ?')
    .all(`${prefix}%`) as Array<{ key: string; value: string }>;
}

// --- Session accessors ---

export function getSession(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(
  groupFolder: string,
  sessionId: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id) VALUES (?, ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET session_id = excluded.session_id`,
  ).run(groupFolder, sessionId, effectiveAgentId);
}

export function deleteSession(
  groupFolder: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    'DELETE FROM sessions WHERE group_folder = ? AND agent_id = ?',
  ).run(groupFolder, effectiveAgentId);
}

/**
 * Get the sandbox_session_id bound to an agent session (group_folder + agent_id).
 * Returns null if none.
 */
export function getSandboxSessionId(
  groupFolder: string,
  agentId?: string | null,
): string | null {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT sandbox_session_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as
    | { sandbox_session_id: string | null }
    | undefined;
  return row?.sandbox_session_id ?? null;
}

/** Set the sandbox_session_id for an agent session. Creates the row if missing. */
export function setSandboxSessionId(
  groupFolder: string,
  sandboxSessionId: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id, sandbox_session_id) VALUES (?, '', ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET sandbox_session_id = excluded.sandbox_session_id`,
  ).run(groupFolder, effectiveAgentId, sandboxSessionId);
}

/** Clear the sandbox_session_id for an agent session. */
export function clearSandboxSessionId(
  groupFolder: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    'UPDATE sessions SET sandbox_session_id = NULL WHERE group_folder = ? AND agent_id = ?',
  ).run(groupFolder, effectiveAgentId);
}

/**
 * Get the provider_id bound to a session (group_folder + agent_id).
 * Returns undefined if no row or no binding recorded.
 *
 * Used by ProviderPool sticky-selection: when resuming a Claude session that
 * already produced thinking blocks, route back to the same provider/account so
 * thinking-block signatures validate.
 */
export function getSessionProviderId(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT provider_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as
    | { provider_id: string | null }
    | undefined;
  return row?.provider_id ?? undefined;
}

/**
 * Bind a session to a specific provider_id, or clear the binding (provider_id=null).
 * Upserts a sessions row if one does not yet exist (with empty session_id).
 */
export function setSessionProviderId(
  groupFolder: string,
  agentId: string | null | undefined,
  providerId: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id, provider_id)
     VALUES (?, '', ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET provider_id = excluded.provider_id`,
  ).run(groupFolder, effectiveAgentId, providerId);
}

/**
 * AtomCode engine session helpers. AtomCode session IDs are stored in a
 * separate column (atomcode_session_id) to avoid colliding with Claude SDK
 * session IDs in the same (group_folder, agent_id) row.
 */
export function getAtomcodeSessionId(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT atomcode_session_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as
    | { atomcode_session_id: string | null }
    | undefined;
  return row?.atomcode_session_id ?? undefined;
}

export function setAtomcodeSessionId(
  groupFolder: string,
  sessionId: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id, atomcode_session_id)
     VALUES (?, '', ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET atomcode_session_id = excluded.atomcode_session_id`,
  ).run(groupFolder, effectiveAgentId, sessionId);
}

export function clearAtomcodeSessionId(
  groupFolder: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `UPDATE sessions SET atomcode_session_id = NULL WHERE group_folder = ? AND agent_id = ?`,
  ).run(groupFolder, effectiveAgentId);
}

/**
 * Codex engine session helpers. Codex thread IDs (UUIDv7) are stored in a
 * separate column (codex_thread_id) for resume on subsequent turns.
 */
export function getCodexThreadId(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT codex_thread_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as
    | { codex_thread_id: string | null }
    | undefined;
  return row?.codex_thread_id ?? undefined;
}

export function setCodexThreadId(
  groupFolder: string,
  threadId: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id, codex_thread_id)
     VALUES (?, '', ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET codex_thread_id = excluded.codex_thread_id`,
  ).run(groupFolder, effectiveAgentId, threadId);
}

export function clearCodexThreadId(
  groupFolder: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `UPDATE sessions SET codex_thread_id = NULL WHERE group_folder = ? AND agent_id = ?`,
  ).run(groupFolder, effectiveAgentId);
}

/**
 * OpenCode engine session helpers. OpenCode session IDs (prefixed `ses_`)
 * are stored in a separate column (opencode_session_id).
 */
export function getOpencodeSessionId(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT opencode_session_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as
    | { opencode_session_id: string | null }
    | undefined;
  return row?.opencode_session_id ?? undefined;
}

export function setOpencodeSessionId(
  groupFolder: string,
  sessionId: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id, opencode_session_id)
     VALUES (?, '', ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET opencode_session_id = excluded.opencode_session_id`,
  ).run(groupFolder, effectiveAgentId, sessionId);
}

export function clearOpencodeSessionId(
  groupFolder: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `UPDATE sessions SET opencode_session_id = NULL WHERE group_folder = ? AND agent_id = ?`,
  ).run(groupFolder, effectiveAgentId);
}

/**
 * pi engine session helpers. pi session IDs (from RPC agent_start /
 * session_info_changed events) are stored in a separate column
 * (pi_session_id) to avoid colliding with other engines' session IDs.
 */
export function getPiSessionId(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT pi_session_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as
    | { pi_session_id: string | null }
    | undefined;
  return row?.pi_session_id ?? undefined;
}

export function setPiSessionId(
  groupFolder: string,
  sessionId: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id, pi_session_id)
     VALUES (?, '', ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET pi_session_id = excluded.pi_session_id`,
  ).run(groupFolder, effectiveAgentId, sessionId);
}

export function clearPiSessionId(
  groupFolder: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `UPDATE sessions SET pi_session_id = NULL WHERE group_folder = ? AND agent_id = ?`,
  ).run(groupFolder, effectiveAgentId);
}

export function deleteAllSessionsForFolder(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

/**
 * Delete all session rows bound to the given provider_id.
 *
 * Used when a provider's protocol-level fields (anthropicBaseUrl /
 * anthropicModel) change: any session whose history contains thinking blocks /
 * model-specific framing produced by this provider must restart fresh,
 * otherwise resuming under the new config can fail with "Invalid signature in
 * thinking block" or "model mismatch" errors. Sessions bound to *other*
 * providers are left intact so unrelated sticky bindings survive a partial
 * config update — see issue #476.
 *
 * Returns the affected `group_folder` values so callers can also evict the
 * in-memory sessions cache and the row count for telemetry.
 */
export function deleteSessionsByProviderId(providerId: string): {
  deletedCount: number;
  affectedFolders: string[];
} {
  const tx = db.transaction((id: string) => {
    const rows = db
      .prepare(
        'SELECT DISTINCT group_folder FROM sessions WHERE provider_id = ?',
      )
      .all(id) as Array<{ group_folder: string }>;
    const affectedFolders = rows.map((r) => r.group_folder);
    const result = db
      .prepare('DELETE FROM sessions WHERE provider_id = ?')
      .run(id);
    return {
      deletedCount: result.changes,
      affectedFolders,
    };
  });
  return tx(providerId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare(
      "SELECT group_folder, session_id FROM sessions WHERE agent_id = ''",
    )
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

function parseExecutionMode(
  raw: string | null,
  context: string,
): ExecutionMode {
  if (raw === 'container' || raw === 'host') return raw;
  if (raw !== null && raw !== '') {
    console.warn(
      `Invalid execution_mode "${raw}" for ${context}, falling back to "container"`,
    );
  }
  return 'container';
}

/** Raw row shape from registered_groups table — single source of truth for column mapping. */
type RegisteredGroupRow = {
  jid: string;
  name: string;
  folder: string;
  added_at: string;
  container_config: string | null;
  execution_mode: string | null;
  custom_cwd: string | null;
  init_source_path: string | null;
  init_git_url: string | null;
  created_by: string | null;
  is_home: number;
  selected_skills: string | null;
  target_agent_id: string | null;
  target_main_jid: string | null;
  reply_policy: string | null;
  require_mention: number;
  activation_mode: string | null;
  owner_im_id: string | null;
  mcp_mode: string | null;
  selected_mcps: string | null;
  conversation_source: string | null;
  conversation_nav_mode: string | null;
  binding_mode: string | null;
  feishu_chat_mode: string | null;
  feishu_group_message_type: string | null;
  sender_allowlist: string | null;
  engine: string | null;
  agent_def_id: string | null;
};

/** Convert a raw DB row into a RegisteredGroup domain object. */
function parseGroupRow(
  row: RegisteredGroupRow,
): RegisteredGroup & { jid: string } {
  // 防御性 JSON.parse：parseGroupRow 在启动期 loadState 路径上被调用，单条
  // 损坏的 row（手工 SQL / 部分写入 / migration 失误）不能让进程退出。
  // 用 warn 日志保留可观测性，损坏字段 fallback 到 undefined。
  let containerConfig: RegisteredGroup['containerConfig'];
  if (row.container_config) {
    try {
      containerConfig = JSON.parse(row.container_config);
    } catch (err) {
      logger.warn(
        { jid: row.jid, err, raw: row.container_config.slice(0, 200) },
        'parseGroupRow: container_config JSON malformed, dropping',
      );
    }
  }
  let senderAllowlist: string[] | undefined;
  if (row.sender_allowlist != null) {
    try {
      const parsed = JSON.parse(row.sender_allowlist) as unknown;
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
        senderAllowlist = parsed as string[];
      } else {
        // Fail-closed：semantics 层把 [] 视为「禁止所有发送者」。坏数据回退
        // 到 [] 比 undefined（=允许全部）更安全 —— 与 R0 的 owner-only 默认
        // 一致，不会把限制群默默改成开放群。
        senderAllowlist = [];
        logger.warn(
          { jid: row.jid },
          'parseGroupRow: sender_allowlist not a string[], falling back to [] (fail-closed)',
        );
      }
    } catch (err) {
      // 解析失败同样 fail-closed：[] = 禁止所有，等待运维修复。
      senderAllowlist = [];
      logger.warn(
        { jid: row.jid, err, raw: row.sender_allowlist.slice(0, 200) },
        'parseGroupRow: sender_allowlist JSON malformed, falling back to [] (fail-closed)',
      );
    }
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    added_at: row.added_at,
    containerConfig,
    executionMode: parseExecutionMode(row.execution_mode, `group ${row.jid}`),
    customCwd: row.custom_cwd ?? undefined,
    initSourcePath: row.init_source_path ?? undefined,
    initGitUrl: row.init_git_url ?? undefined,
    created_by: row.created_by ?? undefined,
    is_home: row.is_home === 1,
    target_agent_id: row.target_agent_id ?? undefined,
    target_main_jid: row.target_main_jid ?? undefined,
    reply_policy: row.reply_policy === 'mirror' ? 'mirror' : 'source_only',
    require_mention: row.require_mention === 1,
    activation_mode: parseActivationMode(row.activation_mode),
    owner_im_id: row.owner_im_id ?? undefined,
    conversation_source:
      row.conversation_source === 'feishu_thread' ? 'feishu_thread' : 'manual',
    conversation_nav_mode:
      row.conversation_nav_mode === 'vertical_threads'
        ? 'vertical_threads'
        : 'horizontal',
    binding_mode:
      row.binding_mode === 'thread_map' ? 'thread_map' : 'single_context',
    feishu_chat_mode: row.feishu_chat_mode ?? undefined,
    feishu_group_message_type: row.feishu_group_message_type ?? undefined,
    sender_allowlist: senderAllowlist,
    engine:
      row.engine === 'atomcode' || row.engine === 'codex' || row.engine === 'opencode' || row.engine === 'pi'
        ? (row.engine as 'atomcode' | 'codex' | 'opencode' | 'pi')
        : 'claude',
    agentDefId: row.agent_def_id ?? null,
  };
}

export const VALID_ACTIVATION_MODES = new Set([
  'auto',
  'always',
  'when_mentioned',
  'owner_mentioned',
  'disabled',
]);

function parseActivationMode(
  raw: string | null,
): 'auto' | 'always' | 'when_mentioned' | 'owner_mentioned' | 'disabled' {
  if (raw && VALID_ACTIVATION_MODES.has(raw))
    return raw as 'auto' | 'always' | 'when_mentioned' | 'owner_mentioned' | 'disabled';
  return 'auto';
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as RegisteredGroupRow | undefined;
  if (!row) return undefined;
  return parseGroupRow(row);
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, added_at, container_config, execution_mode, custom_cwd, init_source_path, init_git_url, created_by, is_home, selected_skills, target_agent_id, target_main_jid, reply_policy, require_mention, activation_mode, owner_im_id, mcp_mode, selected_mcps, conversation_source, conversation_nav_mode, binding_mode, feishu_chat_mode, feishu_group_message_type, sender_allowlist, engine, agent_def_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.executionMode ?? 'container',
    group.customCwd ?? null,
    group.initSourcePath ?? null,
    group.initGitUrl ?? null,
    group.created_by ?? null,
    group.is_home ? 1 : 0,
    null, // selected_skills: deprecated, always null (user-level skills apply globally)
    group.target_agent_id ?? null,
    group.target_main_jid ?? null,
    group.reply_policy ?? 'source_only',
    group.require_mention === true ? 1 : 0,
    group.activation_mode ?? 'auto',
    group.owner_im_id ?? null,
    'inherit', // mcp_mode: deprecated, always inherit (user-level MCP applies globally)
    null, // selected_mcps: deprecated, always null
    group.conversation_source ?? 'manual',
    group.conversation_nav_mode ?? 'horizontal',
    group.binding_mode ?? 'single_context',
    group.feishu_chat_mode ?? null,
    group.feishu_group_message_type ?? null,
    group.sender_allowlist != null ? JSON.stringify(group.sender_allowlist) : null,
    group.engine ?? 'claude',
    group.agentDefId ?? null,
  );
}

export function deleteRegisteredGroup(jid: string): void {
  db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
}

/**
 * Find groups owned by `userId` whose sender_allowlist is the empty array `[]` —
 * the "owner-locked trap" state where no one (not even the owner) can trigger
 * the bot. Created by buildOnNewChat when a Feishu group is auto-registered
 * before the owner has DM'd the bot. Used by Feishu owner backfill.
 */
export function findEmptyAllowlistFeishuGroupsForUser(userId: string): string[] {
  const rows = db
    .prepare(
      "SELECT jid FROM registered_groups WHERE created_by = ? AND jid LIKE 'feishu:%' AND sender_allowlist = '[]'",
    )
    .all(userId) as Array<{ jid: string }>;
  return rows.map((r) => r.jid);
}

/**
 * Replace empty `sender_allowlist=[]` with `[ownerOpenId]` for the user's
 * Feishu groups. Returns the JIDs that were updated. Run once when the
 * Feishu owner is first identified via P2P DM, to unstick groups that were
 * registered before the owner was known.
 */
export function backfillEmptyAllowlistsForUser(
  userId: string,
  ownerOpenId: string,
): string[] {
  const jids = findEmptyAllowlistFeishuGroupsForUser(userId);
  if (jids.length === 0) return [];
  const allowlistJson = JSON.stringify([ownerOpenId]);
  const stmt = db.prepare(
    'UPDATE registered_groups SET sender_allowlist = ? WHERE jid = ?',
  );
  const tx = db.transaction((targets: string[]) => {
    for (const jid of targets) stmt.run(allowlistJson, jid);
  });
  tx(jids);
  return jids;
}

/**
 * Clear `sender_allowlist` for a single group (set to NULL = unrestricted).
 * Used as a manual escape hatch from the owner-locked trap.
 */
export function clearSenderAllowlist(jid: string): void {
  db.prepare(
    'UPDATE registered_groups SET sender_allowlist = NULL WHERE jid = ?',
  ).run(jid);
}

/** Get all JIDs that share the same folder (e.g., all JIDs with folder='main'). */
export function getJidsByFolder(folder: string): string[] {
  const rows = db
    .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
    .all(folder) as Array<{ jid: string }>;
  return rows.map((r) => r.jid);
}

/** Check if any registered group uses container execution mode (efficient targeted query). */
export function hasContainerModeGroups(): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM registered_groups WHERE execution_mode = 'container' OR execution_mode IS NULL LIMIT 1",
    )
    .get();
  return row !== undefined;
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as RegisteredGroupRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = parseGroupRow(row);
  }
  return result;
}

/**
 * Get all registered groups that route to a specific conversation agent.
 * Returns array of { jid, group } for each IM group targeting the given agentId.
 */
export function getGroupsByTargetAgent(
  agentId: string,
): Array<{ jid: string; group: RegisteredGroup }> {
  const rows = db
    .prepare('SELECT * FROM registered_groups WHERE target_agent_id = ?')
    .all(agentId) as RegisteredGroupRow[];
  return rows.map((row) => ({ jid: row.jid, group: parseGroupRow(row) }));
}

/**
 * Get all registered groups that route to a specific workspace's main conversation.
 */
export function getGroupsByTargetMainJid(
  webJid: string,
): Array<{ jid: string; group: RegisteredGroup }> {
  const rows = db
    .prepare('SELECT * FROM registered_groups WHERE target_main_jid = ?')
    .all(webJid) as RegisteredGroupRow[];
  return rows.map((row) => ({ jid: row.jid, group: parseGroupRow(row) }));
}

function mapImContextBindingRow(
  row: Record<string, unknown>,
): ImContextBinding {
  return {
    source_jid: String(row.source_jid),
    context_type: 'thread',
    context_id: String(row.context_id),
    workspace_jid: String(row.workspace_jid),
    agent_id: String(row.agent_id),
    root_message_id:
      typeof row.root_message_id === 'string' ? row.root_message_id : null,
    title: typeof row.title === 'string' ? row.title : null,
    last_active_at: String(row.last_active_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function getImContextBinding(
  sourceJid: string,
  contextType: 'thread',
  contextId: string,
): ImContextBinding | undefined {
  const row = db
    .prepare(
      'SELECT * FROM im_context_bindings WHERE source_jid = ? AND context_type = ? AND context_id = ?',
    )
    .get(sourceJid, contextType, contextId) as Record<string, unknown> | undefined;
  return row ? mapImContextBindingRow(row) : undefined;
}

export function upsertImContextBinding(binding: ImContextBinding): void {
  db.prepare(
    `INSERT INTO im_context_bindings (
      source_jid, context_type, context_id, workspace_jid, agent_id,
      root_message_id, title, last_active_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_jid, context_type, context_id) DO UPDATE SET
      workspace_jid = excluded.workspace_jid,
      agent_id = excluded.agent_id,
      -- COALESCE: 首条消息设定 root_message_id/title 后，后续消息传 null 不会覆盖
      root_message_id = COALESCE(excluded.root_message_id, im_context_bindings.root_message_id),
      title = COALESCE(excluded.title, im_context_bindings.title),
      last_active_at = excluded.last_active_at,
      updated_at = excluded.updated_at`,
  ).run(
    binding.source_jid,
    binding.context_type,
    binding.context_id,
    binding.workspace_jid,
    binding.agent_id,
    binding.root_message_id,
    binding.title,
    binding.last_active_at,
    binding.created_at,
    binding.updated_at,
  );
}

export function listImContextBindingsByWorkspace(
  workspaceJid: string,
): ImContextBinding[] {
  const rows = db
    .prepare(
      'SELECT * FROM im_context_bindings WHERE workspace_jid = ? ORDER BY last_active_at DESC, created_at DESC',
    )
    .all(workspaceJid) as Record<string, unknown>[];
  return rows.map(mapImContextBindingRow);
}

export function deleteImContextBindingsByWorkspace(workspaceJid: string): void {
  db.prepare('DELETE FROM im_context_bindings WHERE workspace_jid = ?').run(
    workspaceJid,
  );
}

export function deleteImContextBindingsByAgent(agentId: string): void {
  db.prepare('DELETE FROM im_context_bindings WHERE agent_id = ?').run(agentId);
}

/** Lightweight update: only touch last_active_at + updated_at on an existing binding. */
export function touchImContextBindingActivity(
  sourceJid: string,
  contextType: 'thread',
  contextId: string,
  lastActiveAt: string,
): void {
  db.prepare(
    'UPDATE im_context_bindings SET last_active_at = ?, updated_at = ? WHERE source_jid = ? AND context_type = ? AND context_id = ?',
  ).run(lastActiveAt, lastActiveAt, sourceJid, contextType, contextId);
}

/** List feishu_thread agent IDs for a workspace JID (for cleanup on unbind). */
export function listFeishuThreadAgentIds(workspaceJid: string): string[] {
  const rows = db
    .prepare(
      "SELECT id FROM agents WHERE chat_jid = ? AND source_kind = 'feishu_thread'",
    )
    .all(workspaceJid) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Find a user's home group (is_home=1 + created_by=userId).
 * For admin users, also matches web:main even if created_by differs
 * (all admins share folder=main).
 */
export function getUserHomeGroup(
  userId: string,
): (RegisteredGroup & { jid: string }) | undefined {
  // First try exact match: is_home=1 AND created_by=userId
  let row = db
    .prepare(
      'SELECT * FROM registered_groups WHERE is_home = 1 AND created_by = ?',
    )
    .get(userId) as RegisteredGroupRow | undefined;

  // Fallback for admin users: all admins share web:main (folder=main).
  // If no exact match, check if the user is an admin and web:main exists.
  if (!row) {
    const user = db
      .prepare("SELECT role FROM users WHERE id = ? AND status = 'active'")
      .get(userId) as { role: string } | undefined;
    if (user?.role === 'admin') {
      row = db
        .prepare(
          "SELECT * FROM registered_groups WHERE jid = 'web:main' AND is_home = 1",
        )
        .get() as RegisteredGroupRow | undefined;
    }
  }

  if (!row) return undefined;
  return parseGroupRow(row);
}

/**
 * Ensure a user has a home group. If not, create one.
 * Admin gets folder='main' with executionMode='host'.
 * Member gets folder='home-{userId}' with executionMode='container'.
 * Returns the JID of the home group.
 */
export function ensureUserHomeGroup(
  userId: string,
  role: 'admin' | 'member',
  username?: string,
): string {
  const existing = getUserHomeGroup(userId);
  if (existing) return existing.jid;

  const now = new Date().toISOString();
  const isAdmin = role === 'admin';
  const jid = isAdmin ? 'web:main' : `web:home-${userId}`;
  const folder = isAdmin ? 'main' : `home-${userId}`;

  // For admin: check if web:main already exists (created by another admin)
  // In that case, reuse it rather than overwriting created_by
  if (isAdmin) {
    const existingMain = getRegisteredGroup(jid);
    if (existingMain) {
      // web:main already exists.
      // Ensure is_home, created_by, and executionMode are correct for owner-based routing.
      const patched = { ...existingMain };
      let changed = false;
      if (!patched.is_home) {
        patched.is_home = true;
        changed = true;
      }
      if (!patched.created_by) {
        patched.created_by = userId;
        changed = true;
      }
      // Admin home container must use host mode
      if (patched.executionMode !== 'host') {
        patched.executionMode = 'host';
        changed = true;
      }
      if (changed) {
        setRegisteredGroup(jid, patched);
      }
      ensureChatExists(jid);
      return jid;
    }
  }

  const name = username ? `${username} Home` : isAdmin ? 'Main' : 'Home';

  const group: RegisteredGroup = {
    name,
    folder,
    added_at: now,
    executionMode: isAdmin ? 'host' : 'container',
    created_by: userId,
    is_home: true,
  };

  setRegisteredGroup(jid, group);

  // Ensure chat row exists
  ensureChatExists(jid);

  // Create user-global memory directory and initialize CLAUDE.md from template
  const userGlobalDir = path.join(GROUPS_DIR, 'user-global', userId);
  fs.mkdirSync(userGlobalDir, { recursive: true });
  const userClaudeMd = path.join(userGlobalDir, 'CLAUDE.md');
  if (!fs.existsSync(userClaudeMd)) {
    const templatePath = path.resolve(
      process.cwd(),
      'config',
      'global-claude-md.template.md',
    );
    if (fs.existsSync(templatePath)) {
      try {
        fs.writeFileSync(userClaudeMd, fs.readFileSync(templatePath, 'utf-8'), {
          flag: 'wx',
        });
      } catch {
        // EEXIST race or read error — ignore
      }
    }
  }

  return jid;
}

export function deleteChatHistory(chatJid: string): void {
  const tx = db.transaction((jid: string) => {
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
  });
  tx(chatJid);
}

/**
 * Delete an IM group's registered_groups entry and all jid-scoped data
 * (messages, chat record, pinned references). Does NOT touch folder-scoped
 * data (sessions, scheduled_tasks, group_members) because IM groups typically
 * share their folder with the owner's home workspace.
 *
 * Used when an IM group is detected as dead (bot removed, group disbanded,
 * health-check unreachable, or repeated send failures) and for the manual
 * "delete this IM binding" UI button.
 */
export function deleteImGroupRecord(jid: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
    db.prepare('DELETE FROM user_pinned_groups WHERE jid = ?').run(jid);
    // Feishu thread agents (source_kind='feishu_thread') and other chat-scoped
    // agents reference this jid via agents.chat_jid — without this, deleting
    // an IM group leaves orphan agent rows visible in the agents list.
    db.prepare('DELETE FROM agents WHERE chat_jid = ?').run(jid);
    db.prepare(
      'UPDATE scheduled_tasks SET workspace_jid = NULL, workspace_folder = NULL WHERE workspace_jid = ?',
    ).run(jid);
  });
  tx();
}

export function deleteGroupData(jid: string, folder: string): void {
  const tx = db.transaction(() => {
    // 1. 删除定时任务运行日志 + 定时任务
    db.prepare(
      'DELETE FROM task_run_logs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?)',
    ).run(folder);
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
    // 2. 删除成员记录
    db.prepare('DELETE FROM group_members WHERE group_folder = ?').run(folder);
    // 3. 删除注册信息
    db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    // 4. 删除会话
    db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(folder);
    // 5. 删除聊天记录
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
    // 6. 删除 pin 记录
    db.prepare('DELETE FROM user_pinned_groups WHERE jid = ?').run(jid);
    // 7. 清除定时任务的工作区关联（任务本身不删，只断开绑定）
    db.prepare(
      'UPDATE scheduled_tasks SET workspace_jid = NULL, workspace_folder = NULL WHERE workspace_jid = ?',
    ).run(jid);
  });
  tx();
}

// --- User pinned groups ---

export function getUserPinnedGroups(userId: string): Record<string, string> {
  const rows = db
    .prepare('SELECT jid, pinned_at FROM user_pinned_groups WHERE user_id = ?')
    .all(userId) as Array<{ jid: string; pinned_at: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[row.jid] = row.pinned_at;
  return result;
}

export function pinGroup(userId: string, jid: string): string {
  const pinned_at = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO user_pinned_groups (user_id, jid, pinned_at) VALUES (?, ?, ?)',
  ).run(userId, jid, pinned_at);
  return pinned_at;
}

export function unpinGroup(userId: string, jid: string): void {
  db.prepare(
    'DELETE FROM user_pinned_groups WHERE user_id = ? AND jid = ?',
  ).run(userId, jid);
}

// --- Web API accessors ---

/**
 * Get paginated messages for a chat, cursor-based pagination.
 * Returns messages in descending timestamp order (newest first).
 */
export function getMessagesPage(
  chatJid: string,
  before?: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  const sql = before
    ? `
      SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
             turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason, autonomous
      FROM messages
      WHERE chat_jid = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
    : `
      SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
             turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason, autonomous
      FROM messages
      WHERE chat_jid = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `;

  const params = before ? [chatJid, before, limit] : [chatJid, limit];
  const rows = db.prepare(sql).all(...params) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * Get messages after a given timestamp (for polling new messages).
 * Returns in ASC order (oldest first).
 */
export function getMessagesAfter(
  chatJid: string,
  after: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason, autonomous
       FROM messages
       WHERE chat_jid = ? AND timestamp > ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(chatJid, after, limit) as Array<NewMessage & { is_from_me: number }>;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * 多 JID 分页查询（用于主容器合并 web:main + feishu:xxx 消息）。
 */
export function getMessagesPageMulti(
  chatJids: string[],
  before?: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  if (chatJids.length === 0) return [];
  if (chatJids.length === 1) return getMessagesPage(chatJids[0], before, limit);

  const placeholders = chatJids.map(() => '?').join(',');
  const sql = before
    ? `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason, autonomous
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp < ?
       ORDER BY timestamp DESC
       LIMIT ?`
    : `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason, autonomous
       FROM messages
       WHERE chat_jid IN (${placeholders})
       ORDER BY timestamp DESC
       LIMIT ?`;

  const params = before ? [...chatJids, before, limit] : [...chatJids, limit];
  const rows = db.prepare(sql).all(...params) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * 多 JID 增量查询（用于主容器轮询合并消息）。
 */
export function getMessagesAfterMulti(
  chatJids: string[],
  after: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  if (chatJids.length === 0) return [];
  if (chatJids.length === 1) return getMessagesAfter(chatJids[0], after, limit);

  const placeholders = chatJids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason, autonomous
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp > ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(...chatJids, after, limit) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * Get task run logs for a specific task, ordered by most recent first.
 */
export function getTaskRunLogs(taskId: string, limit = 20): TaskRunLog[] {
  return db
    .prepare(
      `
    SELECT id, task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs
    WHERE task_id = ?
    ORDER BY run_at DESC
    LIMIT ?
  `,
    )
    .all(taskId, limit) as TaskRunLog[];
}

// ===================== Daily Summary Queries =====================

/**
 * Get messages for a chat within a time range, ordered by timestamp ASC.
 */
export function getMessagesByTimeRange(
  chatJid: string,
  startTs: number,
  endTs: number,
  limit = 500,
): Array<NewMessage & { is_from_me: boolean }> {
  const startIso = new Date(startTs).toISOString();
  const endIso = new Date(endTs).toISOString();
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid = ? AND timestamp >= ? AND timestamp < ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(chatJid, startIso, endIso, limit) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * Get all registered groups owned by a specific user.
 */
export function getGroupsByOwner(
  userId: string,
): Array<RegisteredGroup & { jid: string }> {
  const rows = db
    .prepare('SELECT * FROM registered_groups WHERE created_by = ?')
    .all(userId) as Array<{
    jid: string;
    name: string;
    folder: string;
    added_at: string;
    container_config: string | null;
    execution_mode: string | null;
    custom_cwd: string | null;
    init_source_path: string | null;
    init_git_url: string | null;
    created_by: string | null;
    is_home: number;
    selected_skills: string | null;
    target_main_jid: string | null;
    target_agent_id: string | null;
  }>;

  return rows.map((row) => {
    let containerConfig: RegisteredGroup['containerConfig'];
    if (row.container_config) {
      try {
        containerConfig = JSON.parse(row.container_config);
      } catch (err) {
        logger.warn(
          { jid: row.jid, err },
          'getGroupsByOwner: container_config JSON malformed, dropping',
        );
      }
    }
    return {
      jid: row.jid,
      name: row.name,
      folder: row.folder,
      added_at: row.added_at,
      containerConfig,
      executionMode: parseExecutionMode(row.execution_mode, `group ${row.jid}`),
      customCwd: row.custom_cwd ?? undefined,
      initSourcePath: row.init_source_path ?? undefined,
      initGitUrl: row.init_git_url ?? undefined,
      created_by: row.created_by ?? undefined,
      is_home: row.is_home === 1,
      target_main_jid: row.target_main_jid ?? undefined,
      target_agent_id: row.target_agent_id ?? undefined,
    };
  });
}

// ===================== Auth CRUD =====================

function parseUserRole(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'member';
}

function parseUserStatus(value: unknown): UserStatus {
  if (value === 'deleted') return 'deleted';
  if (value === 'disabled') return 'disabled';
  return 'active';
}

function parsePermissionsFromDb(raw: unknown, role: UserRole): Permission[] {
  if (typeof raw === 'string') {
    try {
      const parsed = normalizePermissions(JSON.parse(raw));
      if (parsed.length > 0) return parsed;
    } catch {
      // ignore and fall back to role defaults
    }
  }
  return getDefaultPermissions(role);
}

function parseJsonDetails(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapUserRow(row: Record<string, unknown>): User {
  const role = parseUserRole(row.role);
  const status = parseUserStatus(row.status);
  return {
    id: String(row.id),
    username: String(row.username),
    password_hash: String(row.password_hash),
    display_name: String(row.display_name ?? ''),
    role,
    status,
    permissions: parsePermissionsFromDb(row.permissions, role),
    must_change_password: !!row.must_change_password,
    disable_reason:
      typeof row.disable_reason === 'string' ? row.disable_reason : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    avatar_emoji:
      typeof row.avatar_emoji === 'string' ? row.avatar_emoji : null,
    avatar_color:
      typeof row.avatar_color === 'string' ? row.avatar_color : null,
    avatar_url:
      typeof row.avatar_url === 'string' ? row.avatar_url : null,
    ai_name: typeof row.ai_name === 'string' ? row.ai_name : null,
    ai_avatar_emoji:
      typeof row.ai_avatar_emoji === 'string' ? row.ai_avatar_emoji : null,
    ai_avatar_color:
      typeof row.ai_avatar_color === 'string' ? row.ai_avatar_color : null,
    ai_avatar_url:
      typeof row.ai_avatar_url === 'string' ? row.ai_avatar_url : null,
    default_require_mention: !!row.default_require_mention,
    reminder_enabled: row.reminder_enabled === undefined ? true : !!row.reminder_enabled,
    language:
      typeof row.language === 'string' && row.language ? row.language : 'zh-CN',
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_login_at:
      typeof row.last_login_at === 'string' ? row.last_login_at : null,
    deleted_at: typeof row.deleted_at === 'string' ? row.deleted_at : null,
  };
}

function toUserPublic(user: User, lastActiveAt: string | null): UserPublic {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    permissions: user.permissions,
    must_change_password: user.must_change_password,
    disable_reason: user.disable_reason,
    notes: user.notes,
    avatar_emoji: user.avatar_emoji,
    avatar_color: user.avatar_color,
    avatar_url: user.avatar_url,
    ai_name: user.ai_name,
    ai_avatar_emoji: user.ai_avatar_emoji,
    ai_avatar_color: user.ai_avatar_color,
    ai_avatar_url: user.ai_avatar_url,
    default_require_mention: user.default_require_mention,
    reminder_enabled: user.reminder_enabled,
    language: user.language,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
    last_active_at: lastActiveAt,
    deleted_at: user.deleted_at,
  };
}

// --- Users ---

export interface CreateUserInput {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  permissions?: Permission[];
  must_change_password?: boolean;
  disable_reason?: string | null;
  notes?: string | null;
  last_login_at?: string | null;
  deleted_at?: string | null;
}

function initializeBillingForUser(
  userId: string,
  role: UserRole,
  createdAt: string,
): void {
  const now = createdAt || new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
  ).run(userId, now);

  if (role === 'admin') return;

  const defaultPlan = getDefaultBillingPlan();
  if (!defaultPlan) return;

  const activeSubscription = db
    .prepare(
      "SELECT id FROM user_subscriptions WHERE user_id = ? AND status = 'active'",
    )
    .get(userId) as { id: string } | undefined;
  if (activeSubscription) return;

  const subId = `sub_${userId}_${Date.now()}`;
  db.prepare(
    `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, created_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
  ).run(subId, userId, defaultPlan.id, now, now);
  db.prepare('UPDATE users SET subscription_plan_id = ? WHERE id = ?').run(
    defaultPlan.id,
    userId,
  );

  const hasOpening = db
    .prepare(
      "SELECT 1 FROM balance_transactions WHERE user_id = ? AND source = 'migration_opening' LIMIT 1",
    )
    .get(userId);
  if (!hasOpening) {
    db.prepare(
      `INSERT INTO balance_transactions (
        user_id, type, amount_usd, balance_after, description, reference_type,
        reference_id, actor_id, source, operator_type, notes, idempotency_key, created_at
      ) VALUES (?, 'adjustment', 0, 0, ?, NULL, NULL, NULL, 'migration_opening', 'system', ?, NULL, ?)`,
    ).run(
      userId,
      '用户钱包初始化',
      '新用户默认余额为 0，需管理员充值或兑换后方可消费',
      now,
    );
  }
}

export function createUser(user: CreateUserInput): void {
  const permissions = normalizePermissions(
    user.permissions ?? getDefaultPermissions(user.role),
  );
  db.prepare(
    `INSERT INTO users (
      id, username, password_hash, display_name, role, status, permissions, must_change_password,
      disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    user.id,
    user.username,
    user.password_hash,
    user.display_name,
    user.role,
    user.status,
    JSON.stringify(permissions),
    user.must_change_password ? 1 : 0,
    user.disable_reason ?? null,
    user.notes ?? null,
    user.created_at,
    user.updated_at,
    user.last_login_at ?? null,
    user.deleted_at ?? null,
  );
  initializeBillingForUser(user.id, user.role, user.created_at);
}

export type CreateInitialAdminResult =
  | { ok: true }
  | { ok: false; reason: 'already_initialized' | 'username_taken' };

export function createInitialAdminUser(
  user: CreateUserInput,
): CreateInitialAdminResult {
  const tx = db.transaction(
    (input: CreateUserInput): CreateInitialAdminResult => {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
        count: number;
      };
      if (row.count > 0) return { ok: false, reason: 'already_initialized' };
      createUser(input);
      return { ok: true };
    },
  );

  try {
    return tx(user);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export function getUserById(id: string): User | undefined {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapUserRow(row) : undefined;
}

export function getUserByUsername(username: string): User | undefined {
  const row = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username) as Record<string, unknown> | undefined;
  return row ? mapUserRow(row) : undefined;
}

export interface ListUsersOptions {
  query?: string;
  role?: UserRole | 'all';
  status?: UserStatus | 'all';
  page?: number;
  pageSize?: number;
}

export interface ListUsersResult {
  users: UserPublic[];
  total: number;
  page: number;
  pageSize: number;
}

export function listUsers(options: ListUsersOptions = {}): ListUsersResult {
  const role = options.role && options.role !== 'all' ? options.role : null;
  const status =
    options.status && options.status !== 'all' ? options.status : null;
  const query = options.query?.trim() || '';
  const page = Math.max(1, Math.floor(options.page || 1));
  const pageSize = Math.min(
    200,
    Math.max(1, Math.floor(options.pageSize || 50)),
  );
  const offset = (page - 1) * pageSize;

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (role) {
    whereParts.push('u.role = ?');
    params.push(role);
  }
  if (status) {
    whereParts.push('u.status = ?');
    params.push(status);
  } else {
    whereParts.push("u.status != 'deleted'");
  }
  if (query) {
    whereParts.push(
      "(u.username LIKE ? OR u.display_name LIKE ? OR COALESCE(u.notes, '') LIKE ?)",
    );
    const like = `%${query}%`;
    params.push(like, like, like);
  }

  const whereClause =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const totalRow = db
    .prepare(`SELECT COUNT(*) as count FROM users u ${whereClause}`)
    .get(...params) as { count: number };

  const rows = db
    .prepare(
      `
      SELECT u.*, MAX(s.last_active_at) AS last_active_at
      FROM users u
      LEFT JOIN user_sessions s ON s.user_id = u.id
      ${whereClause}
      GROUP BY u.id
      ORDER BY
        CASE u.status
          WHEN 'active' THEN 0
          WHEN 'disabled' THEN 1
          ELSE 2
        END,
        u.created_at DESC
      LIMIT ? OFFSET ?
      `,
    )
    .all(...params, pageSize, offset) as Array<Record<string, unknown>>;

  return {
    users: rows.map((row) => {
      const user = mapUserRow(row);
      const lastActiveAt =
        typeof row.last_active_at === 'string' ? row.last_active_at : null;
      return toUserPublic(user, lastActiveAt);
    }),
    total: totalRow.count,
    page,
    pageSize,
  };
}

export function getAllUsers(): UserPublic[] {
  return listUsers({ role: 'all', status: 'all', page: 1, pageSize: 1000 })
    .users;
}

export function getUserCount(includeDeleted = false): number {
  const row = includeDeleted
    ? (db.prepare('SELECT COUNT(*) as count FROM users').get() as {
        count: number;
      })
    : (db
        .prepare('SELECT COUNT(*) as count FROM users WHERE status != ?')
        .get('deleted') as { count: number });
  return row.count;
}

export function getActiveAdminCount(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM users
       WHERE role = 'admin' AND status = 'active'`,
    )
    .get() as { count: number };
  return row.count;
}

export function updateUserFields(
  id: string,
  updates: Partial<
    Pick<
      User,
      | 'username'
      | 'display_name'
      | 'role'
      | 'status'
      | 'password_hash'
      | 'last_login_at'
      | 'permissions'
      | 'must_change_password'
      | 'disable_reason'
      | 'notes'
      | 'avatar_emoji'
      | 'avatar_color'
      | 'avatar_url'
      | 'ai_name'
      | 'ai_avatar_emoji'
      | 'ai_avatar_color'
      | 'ai_avatar_url'
      | 'default_require_mention'
      | 'reminder_enabled'
      | 'language'
      | 'deleted_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.username !== undefined) {
    fields.push('username = ?');
    values.push(updates.username);
  }
  if (updates.display_name !== undefined) {
    fields.push('display_name = ?');
    values.push(updates.display_name);
  }
  if (updates.role !== undefined) {
    fields.push('role = ?');
    values.push(updates.role);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.password_hash !== undefined) {
    fields.push('password_hash = ?');
    values.push(updates.password_hash);
  }
  if (updates.last_login_at !== undefined) {
    fields.push('last_login_at = ?');
    values.push(updates.last_login_at);
  }
  if (updates.permissions !== undefined) {
    fields.push('permissions = ?');
    values.push(JSON.stringify(normalizePermissions(updates.permissions)));
  }
  if (updates.must_change_password !== undefined) {
    fields.push('must_change_password = ?');
    values.push(updates.must_change_password ? 1 : 0);
  }
  if (updates.disable_reason !== undefined) {
    fields.push('disable_reason = ?');
    values.push(updates.disable_reason);
  }
  if (updates.notes !== undefined) {
    fields.push('notes = ?');
    values.push(updates.notes);
  }
  if (updates.avatar_emoji !== undefined) {
    fields.push('avatar_emoji = ?');
    values.push(updates.avatar_emoji);
  }
  if (updates.avatar_color !== undefined) {
    fields.push('avatar_color = ?');
    values.push(updates.avatar_color);
  }
  if (updates.avatar_url !== undefined) {
    fields.push('avatar_url = ?');
    values.push(updates.avatar_url);
  }
  if (updates.ai_name !== undefined) {
    fields.push('ai_name = ?');
    values.push(updates.ai_name);
  }
  if (updates.ai_avatar_emoji !== undefined) {
    fields.push('ai_avatar_emoji = ?');
    values.push(updates.ai_avatar_emoji);
  }
  if (updates.ai_avatar_color !== undefined) {
    fields.push('ai_avatar_color = ?');
    values.push(updates.ai_avatar_color);
  }
  if (updates.ai_avatar_url !== undefined) {
    fields.push('ai_avatar_url = ?');
    values.push(updates.ai_avatar_url);
  }
  if (updates.default_require_mention !== undefined) {
    fields.push('default_require_mention = ?');
    values.push(updates.default_require_mention ? 1 : 0);
  }
  if (updates.reminder_enabled !== undefined) {
    fields.push('reminder_enabled = ?');
    values.push(updates.reminder_enabled ? 1 : 0);
  }
  if (updates.language !== undefined) {
    fields.push('language = ?');
    values.push(updates.language);
  }
  if (updates.deleted_at !== undefined) {
    fields.push('deleted_at = ?');
    values.push(updates.deleted_at);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteUser(id: string): void {
  const now = new Date().toISOString();
  const tx = db.transaction((userId: string) => {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
    db.prepare(
      `UPDATE users
       SET status = 'deleted', deleted_at = ?, disable_reason = COALESCE(disable_reason, 'deleted_by_admin'), updated_at = ?
       WHERE id = ?`,
    ).run(now, now, userId);
  });
  tx(id);
}

export function restoreUser(id: string): void {
  db.prepare(
    `UPDATE users
     SET status = 'disabled', deleted_at = NULL, disable_reason = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

// --- User Sessions ---

export function createUserSession(session: UserSession): void {
  db.prepare(
    `INSERT INTO user_sessions (id, user_id, ip_address, user_agent, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.user_id,
    session.ip_address,
    session.user_agent,
    session.created_at,
    session.expires_at,
    session.last_active_at,
  );
}

export function getSessionWithUser(
  sessionId: string,
): UserSessionWithUser | undefined {
  const row = stmts().getSessionWithUser.get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const role = parseUserRole(row.role);
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    ip_address: typeof row.ip_address === 'string' ? row.ip_address : null,
    user_agent: typeof row.user_agent === 'string' ? row.user_agent : null,
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    last_active_at: String(row.last_active_at),
    username: String(row.username),
    role,
    status: parseUserStatus(row.status),
    display_name: String(row.display_name ?? ''),
    permissions: parsePermissionsFromDb(row.permissions, role),
    must_change_password: !!row.must_change_password,
  };
}

export function getUserSessions(userId: string): UserSession[] {
  return db
    .prepare(
      `SELECT * FROM user_sessions WHERE user_id = ? ORDER BY last_active_at DESC`,
    )
    .all(userId) as UserSession[];
}

export function deleteUserSession(sessionId: string): void {
  stmts().deleteSession.run(sessionId);
}

export function deleteUserSessionsByUserId(userId: string): void {
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
}

export function updateSessionLastActive(sessionId: string): void {
  stmts().updateSessionLastActive.run(new Date().toISOString(), sessionId);
}

export function getExpiredSessionIds(): string[] {
  const now = new Date().toISOString();
  return (stmts().getExpiredSessionIds.all(now) as { id: string }[]).map(
    (r) => r.id,
  );
}

export function deleteExpiredSessions(): number {
  const now = new Date().toISOString();
  const result = db
    .prepare('DELETE FROM user_sessions WHERE expires_at < ?')
    .run(now);
  return result.changes;
}

// --- Invite Codes ---

export function createInviteCode(invite: InviteCode): void {
  const permissions = normalizePermissions(invite.permissions);
  db.prepare(
    `INSERT INTO invite_codes (code, created_by, role, permission_template, permissions, max_uses, used_count, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    invite.code,
    invite.created_by,
    invite.role,
    invite.permission_template ?? null,
    JSON.stringify(permissions),
    invite.max_uses,
    invite.used_count,
    invite.expires_at,
    invite.created_at,
  );
}

export function getInviteCode(code: string): InviteCode | undefined {
  const row = db
    .prepare('SELECT * FROM invite_codes WHERE code = ?')
    .get(code) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const role = parseUserRole(row.role);
  return {
    code: String(row.code),
    created_by: String(row.created_by),
    role,
    permission_template:
      typeof row.permission_template === 'string'
        ? (row.permission_template as PermissionTemplateKey)
        : null,
    permissions: parsePermissionsFromDb(row.permissions, role),
    max_uses: Number(row.max_uses),
    used_count: Number(row.used_count),
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    created_at: String(row.created_at),
  };
}

export type RegisterUserWithInviteResult =
  | { ok: true; role: UserRole; permissions: Permission[] }
  | {
      ok: false;
      reason:
        | 'invalid_or_expired_invite'
        | 'invite_exhausted'
        | 'username_taken';
    };

export function registerUserWithInvite(input: {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  invite_code: string;
  created_at: string;
  updated_at: string;
}): RegisterUserWithInviteResult {
  const tx = db.transaction(
    (params: typeof input): RegisterUserWithInviteResult => {
      const inviteRow = db
        .prepare(
          `SELECT code, role, permissions, max_uses, expires_at
         FROM invite_codes
         WHERE code = ?`,
        )
        .get(params.invite_code) as Record<string, unknown> | undefined;

      if (!inviteRow) return { ok: false, reason: 'invalid_or_expired_invite' };
      const inviteRole = parseUserRole(inviteRow.role);
      const invitePermissions = parsePermissionsFromDb(
        inviteRow.permissions,
        inviteRole,
      );
      const inviteExpiresAt =
        typeof inviteRow.expires_at === 'string' ? inviteRow.expires_at : null;

      if (inviteExpiresAt) {
        const expiresAt = Date.parse(inviteExpiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
          return { ok: false, reason: 'invalid_or_expired_invite' };
        }
      }

      const existing = db
        .prepare('SELECT id FROM users WHERE username = ?')
        .get(params.username) as { id: string } | undefined;
      if (existing) return { ok: false, reason: 'username_taken' };

      const inviteUsage = db
        .prepare(
          `UPDATE invite_codes
         SET used_count = used_count + 1
         WHERE code = ?
           AND (max_uses = 0 OR used_count < max_uses)`,
        )
        .run(params.invite_code);
      if (inviteUsage.changes === 0) {
        return { ok: false, reason: 'invite_exhausted' };
      }

      const permissions = normalizePermissions(invitePermissions);
      db.prepare(
        `INSERT INTO users (
        id, username, password_hash, display_name, role, status, permissions, must_change_password,
        disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.id,
        params.username,
        params.password_hash,
        params.display_name,
        inviteRole,
        'active',
        JSON.stringify(permissions),
        0,
        null,
        null,
        params.created_at,
        params.updated_at,
        null,
        null,
      );
      initializeBillingForUser(params.id, inviteRole, params.created_at);

      return { ok: true, role: inviteRole, permissions };
    },
  );

  try {
    return tx(input);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export type RegisterUserWithoutInviteResult =
  | { ok: true; role: UserRole; permissions: Permission[] }
  | { ok: false; reason: 'username_taken' };

export function registerUserWithoutInvite(input: {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}): RegisterUserWithoutInviteResult {
  const role: UserRole = 'member';
  const permissions: Permission[] = [];

  try {
    db.prepare(
      `INSERT INTO users (
        id, username, password_hash, display_name, role, status, permissions, must_change_password,
        disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.username,
      input.password_hash,
      input.display_name,
      role,
      'active',
      JSON.stringify(permissions),
      0,
      null,
      null,
      input.created_at,
      input.updated_at,
      null,
      null,
    );
    initializeBillingForUser(input.id, role, input.created_at);
    return { ok: true, role, permissions };
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export function getAllInviteCodes(): InviteCodeWithCreator[] {
  const rows = db
    .prepare(
      `SELECT i.*, u.username as creator_username
       FROM invite_codes i
       JOIN users u ON i.created_by = u.id
       ORDER BY i.created_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const role = parseUserRole(row.role);
    return {
      code: String(row.code),
      created_by: String(row.created_by),
      creator_username: String(row.creator_username),
      role,
      permission_template:
        typeof row.permission_template === 'string'
          ? (row.permission_template as PermissionTemplateKey)
          : null,
      permissions: parsePermissionsFromDb(row.permissions, role),
      max_uses: Number(row.max_uses),
      used_count: Number(row.used_count),
      expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
      created_at: String(row.created_at),
    };
  });
}

export function deleteInviteCode(code: string): void {
  db.prepare('DELETE FROM invite_codes WHERE code = ?').run(code);
}

// --- Auth Audit Log ---

export function logAuthEvent(event: {
  event_type: AuthEventType;
  username: string;
  actor_username?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  details?: Record<string, unknown> | null;
}): void {
  db.prepare(
    `INSERT INTO auth_audit_log (event_type, username, actor_username, ip_address, user_agent, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.event_type,
    event.username,
    event.actor_username ?? null,
    event.ip_address ?? null,
    event.user_agent ?? null,
    event.details ? JSON.stringify(event.details) : null,
    new Date().toISOString(),
  );
}

export interface AuthAuditLogQuery {
  limit?: number;
  offset?: number;
  event_type?: AuthEventType | 'all';
  username?: string;
  actor_username?: string;
  from?: string;
  to?: string;
}

export interface AuthAuditLogPage {
  logs: AuthAuditLog[];
  total: number;
  limit: number;
  offset: number;
}

export function queryAuthAuditLogs(
  query: AuthAuditLogQuery = {},
): AuthAuditLogPage {
  const limit = Math.min(500, Math.max(1, Math.floor(query.limit || 100)));
  const offset = Math.max(0, Math.floor(query.offset || 0));

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (query.event_type && query.event_type !== 'all') {
    whereParts.push('event_type = ?');
    params.push(query.event_type);
  }
  if (query.username?.trim()) {
    whereParts.push('username LIKE ?');
    params.push(`%${query.username.trim()}%`);
  }
  if (query.actor_username?.trim()) {
    whereParts.push('actor_username LIKE ?');
    params.push(`%${query.actor_username.trim()}%`);
  }
  if (query.from) {
    whereParts.push('created_at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    whereParts.push('created_at <= ?');
    params.push(query.to);
  }
  const whereClause =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const total = (
    db
      .prepare(`SELECT COUNT(*) as count FROM auth_audit_log ${whereClause}`)
      .get(...params) as {
      count: number;
    }
  ).count;

  const rows = db
    .prepare(
      `SELECT * FROM auth_audit_log ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<Record<string, unknown>>;

  const logs = rows.map((row) => ({
    id: Number(row.id),
    event_type: row.event_type as AuthEventType,
    username: String(row.username),
    actor_username:
      typeof row.actor_username === 'string' ? row.actor_username : null,
    ip_address: typeof row.ip_address === 'string' ? row.ip_address : null,
    user_agent: typeof row.user_agent === 'string' ? row.user_agent : null,
    details: parseJsonDetails(row.details),
    created_at: String(row.created_at),
  }));

  return { logs, total, limit, offset };
}

export function getAuthAuditLogs(limit = 100, offset = 0): AuthAuditLog[] {
  return queryAuthAuditLogs({ limit, offset }).logs;
}

export function checkLoginRateLimitFromAudit(
  username: string,
  ip: string,
  maxAttempts: number,
  lockoutMinutes: number,
): { allowed: boolean; retryAfterSeconds?: number; attempts: number } {
  if (maxAttempts <= 0) return { allowed: true, attempts: 0 };
  const windowStart = new Date(
    Date.now() - lockoutMinutes * 60 * 1000,
  ).toISOString();
  const rows = db
    .prepare(
      `
      SELECT created_at
      FROM auth_audit_log
      WHERE event_type = 'login_failed'
        AND username = ?
        AND ip_address = ?
        AND created_at >= ?
        AND (details IS NULL OR details NOT LIKE '%"reason":"rate_limited"%')
      ORDER BY created_at ASC
      `,
    )
    .all(username, ip, windowStart) as Array<{ created_at: string }>;

  const attempts = rows.length;
  if (attempts < maxAttempts) return { allowed: true, attempts };

  const oldest = rows[0]?.created_at;
  const oldestTs = oldest ? Date.parse(oldest) : Date.now();
  const retryAt = oldestTs + lockoutMinutes * 60 * 1000;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((retryAt - Date.now()) / 1000),
  );
  return { allowed: false, retryAfterSeconds, attempts };
}

// ===================== Group Members =====================

export function addGroupMember(
  groupFolder: string,
  userId: string,
  role: 'owner' | 'member',
  addedBy?: string,
): void {
  db.prepare(
    `INSERT INTO group_members (group_folder, user_id, role, added_at, added_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_folder, user_id) DO UPDATE SET
       role = CASE WHEN excluded.role = 'owner' THEN 'owner'
                   WHEN group_members.role = 'owner' THEN 'owner'
                   ELSE excluded.role END,
       added_by = COALESCE(excluded.added_by, group_members.added_by)`,
  ).run(groupFolder, userId, role, new Date().toISOString(), addedBy ?? null);
}

export function removeGroupMember(groupFolder: string, userId: string): void {
  db.prepare(
    'DELETE FROM group_members WHERE group_folder = ? AND user_id = ?',
  ).run(groupFolder, userId);
}

export function getGroupMembers(groupFolder: string): GroupMember[] {
  const rows = db
    .prepare(
      `SELECT gm.user_id, gm.role, gm.added_at, gm.added_by,
              u.username, COALESCE(u.display_name, '') as display_name
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_folder = ?
       ORDER BY gm.role DESC, gm.added_at ASC`,
    )
    .all(groupFolder) as Array<{
    user_id: string;
    role: string;
    added_at: string;
    added_by: string | null;
    username: string;
    display_name: string;
  }>;
  return rows.map((r) => ({
    user_id: r.user_id,
    role: r.role as 'owner' | 'member',
    added_at: r.added_at,
    added_by: r.added_by ?? undefined,
    username: r.username,
    display_name: r.display_name,
  }));
}

export function getGroupMemberRole(
  groupFolder: string,
  userId: string,
): 'owner' | 'member' | null {
  const row = db
    .prepare(
      'SELECT role FROM group_members WHERE group_folder = ? AND user_id = ?',
    )
    .get(groupFolder, userId) as { role: string } | undefined;
  if (!row) return null;
  return row.role as 'owner' | 'member';
}

export function getUserMemberFolders(
  userId: string,
): Array<{ group_folder: string; role: 'owner' | 'member' }> {
  const rows = db
    .prepare('SELECT group_folder, role FROM group_members WHERE user_id = ?')
    .all(userId) as Array<{ group_folder: string; role: string }>;
  return rows.map((r) => ({
    group_folder: r.group_folder,
    role: r.role as 'owner' | 'member',
  }));
}

// ===================== Sub-Agent CRUD =====================

export function createAgent(agent: SubAgent): void {
  db.prepare(
    `INSERT INTO agents (id, group_folder, chat_jid, name, prompt, status, kind, created_by, created_at, completed_at, result_summary, spawned_from_jid, source_kind, thread_id, root_message_id, title_source, last_active_at, last_im_jid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agent.id,
    agent.group_folder,
    agent.chat_jid,
    agent.name,
    agent.prompt,
    agent.status,
    agent.kind || 'task',
    agent.created_by ?? null,
    agent.created_at,
    agent.completed_at ?? null,
    agent.result_summary ?? null,
    agent.spawned_from_jid ?? null,
    agent.source_kind ?? null,
    agent.thread_id ?? null,
    agent.root_message_id ?? null,
    agent.title_source ?? null,
    agent.last_active_at ?? null,
    agent.last_im_jid ?? null,
  );
}

export function getAgent(id: string): SubAgent | undefined {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return mapAgentRow(row);
}

export function listAgentsByFolder(folder: string): SubAgent[] {
  const rows = db
    .prepare(
      'SELECT * FROM agents WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(folder) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRow);
}

export function listAgentsByJid(chatJid: string): SubAgent[] {
  const rows = db
    .prepare('SELECT * FROM agents WHERE chat_jid = ? ORDER BY created_at DESC')
    .all(chatJid) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRow);
}

export function updateAgentStatus(
  id: string,
  status: AgentStatus,
  resultSummary?: string,
): void {
  const completedAt =
    status !== 'running' && status !== 'idle' ? new Date().toISOString() : null;
  db.prepare(
    'UPDATE agents SET status = ?, completed_at = ?, result_summary = ? WHERE id = ?',
  ).run(status, completedAt, resultSummary ?? null, id);
}

export function updateAgentLastImJid(
  id: string,
  lastImJid: string | null,
): void {
  db.prepare('UPDATE agents SET last_im_jid = ? WHERE id = ?').run(
    lastImJid,
    id,
  );
}

export function updateAgentInfo(
  id: string,
  name: string,
  prompt: string,
): void {
  db.prepare('UPDATE agents SET name = ?, prompt = ? WHERE id = ?').run(
    name,
    prompt,
    id,
  );
}

export function updateAgentContextInfo(
  id: string,
  updates: Partial<
    Pick<
      SubAgent,
      | 'name'
      | 'source_kind'
      | 'thread_id'
      | 'root_message_id'
      | 'title_source'
      | 'last_active_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.source_kind !== undefined) {
    fields.push('source_kind = ?');
    values.push(updates.source_kind);
  }
  if (updates.thread_id !== undefined) {
    fields.push('thread_id = ?');
    values.push(updates.thread_id);
  }
  if (updates.root_message_id !== undefined) {
    fields.push('root_message_id = ?');
    values.push(updates.root_message_id);
  }
  if (updates.title_source !== undefined) {
    fields.push('title_source = ?');
    values.push(updates.title_source);
  }
  if (updates.last_active_at !== undefined) {
    fields.push('last_active_at = ?');
    values.push(updates.last_active_at);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteCompletedAgents(beforeTimestamp: string): number {
  const result = db
    .prepare(
      "DELETE FROM agents WHERE kind IN ('task', 'spawn') AND status IN ('completed', 'error') AND completed_at IS NOT NULL AND completed_at < ?",
    )
    .run(beforeTimestamp);
  return result.changes;
}

export function getRunningTaskAgentsByChat(chatJid: string): SubAgent[] {
  const rows = db
    .prepare(
      "SELECT * FROM agents WHERE chat_jid = ? AND kind = 'task' AND status = 'running'",
    )
    .all(chatJid) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRow);
}

export function markRunningTaskAgentsAsError(chatJid: string): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE agents SET status = 'error', completed_at = ? WHERE chat_jid = ? AND kind = 'task' AND status = 'running'",
    )
    .run(now, chatJid);
  return result.changes;
}

export function markAllRunningTaskAgentsAsError(
  summary = '进程重启，任务中断',
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE agents SET status = 'error', completed_at = ?, result_summary = COALESCE(result_summary, ?) WHERE kind = 'task' AND status = 'running'",
    )
    .run(now, summary);
  return result.changes;
}

/**
 * Mark stale spawn agents (idle/running) as error at startup.
 * After a process restart, spawn agents that were idle or running can never
 * resume — their in-memory task callbacks are lost. Mark them as error so
 * they don't render as "正在思考..." in the frontend.
 */
export function markStaleSpawnAgentsAsError(
  summary = '进程重启，并行任务中断',
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE agents SET status = 'error', completed_at = ?, result_summary = COALESCE(result_summary, ?) WHERE kind = 'spawn' AND status IN ('idle', 'running')",
    )
    .run(now, summary);
  return result.changes;
}

export function listActiveConversationAgents(): SubAgent[] {
  return (
    db
      .prepare(
        "SELECT * FROM agents WHERE kind IN ('conversation', 'spawn') AND status IN ('running', 'idle')",
      )
      .all() as Record<string, unknown>[]
  ).map(mapAgentRow);
}

export function deleteAgent(id: string): void {
  // Delete associated session
  db.prepare('DELETE FROM sessions WHERE agent_id = ?').run(id);
  deleteImContextBindingsByAgent(id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

function mapAgentRow(row: Record<string, unknown>): SubAgent {
  return {
    id: String(row.id),
    group_folder: String(row.group_folder),
    chat_jid: String(row.chat_jid),
    name: String(row.name),
    prompt: String(row.prompt),
    status: (row.status as AgentStatus) || 'running',
    kind: (row.kind as AgentKind) || 'task',
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: String(row.created_at),
    completed_at:
      typeof row.completed_at === 'string' ? row.completed_at : null,
    result_summary:
      typeof row.result_summary === 'string' ? row.result_summary : null,
    last_im_jid:
      typeof row.last_im_jid === 'string' ? row.last_im_jid : null,
    spawned_from_jid:
      typeof row.spawned_from_jid === 'string' ? row.spawned_from_jid : null,
    source_kind:
      typeof row.source_kind === 'string'
        ? (row.source_kind as 'manual' | 'feishu_thread' | 'auto_im')
        : null,
    thread_id: typeof row.thread_id === 'string' ? row.thread_id : null,
    root_message_id:
      typeof row.root_message_id === 'string' ? row.root_message_id : null,
    title_source:
      typeof row.title_source === 'string'
        ? (row.title_source as
            | 'manual'
            | 'feishu_root'
            | 'auto'
            | 'auto_pending')
        : null,
    last_active_at:
      typeof row.last_active_at === 'string' ? row.last_active_at : null,
  };
}

export function deleteMessagesForChatJid(chatJid: string): void {
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
  db.prepare('DELETE FROM chats WHERE jid = ?').run(chatJid);
}

export function getMessage(
  chatJid: string,
  messageId: string,
): {
  id: string;
  chat_jid: string;
  sender: string | null;
  is_from_me: number;
} | null {
  const row = db
    .prepare(
      'SELECT id, chat_jid, sender, is_from_me FROM messages WHERE id = ? AND chat_jid = ?',
    )
    .get(messageId, chatJid) as
    | {
        id: string;
        chat_jid: string;
        sender: string | null;
        is_from_me: number;
      }
    | undefined;
  return row ?? null;
}

export function deleteMessage(chatJid: string, messageId: string): boolean {
  const result = db
    .prepare('DELETE FROM messages WHERE id = ? AND chat_jid = ?')
    .run(messageId, chatJid);
  return result.changes > 0;
}

export function isGroupShared(groupFolder: string): boolean {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM group_members WHERE group_folder = ?')
    .get(groupFolder) as { cnt: number };
  return row.cnt > 1;
}

// --- Billing CRUD functions ---

export function getBillingPlan(id: string): BillingPlan | undefined {
  const row = db.prepare('SELECT * FROM billing_plans WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapBillingPlanRow(row) : undefined;
}

export function getActiveBillingPlans(): BillingPlan[] {
  return (
    db
      .prepare(
        'SELECT * FROM billing_plans WHERE is_active = 1 ORDER BY tier ASC, name ASC',
      )
      .all() as Record<string, unknown>[]
  ).map(mapBillingPlanRow);
}

export function getAllBillingPlans(): BillingPlan[] {
  return (
    db
      .prepare('SELECT * FROM billing_plans ORDER BY tier ASC, name ASC')
      .all() as Record<string, unknown>[]
  ).map(mapBillingPlanRow);
}

export function getDefaultBillingPlan(): BillingPlan | undefined {
  const row = db
    .prepare('SELECT * FROM billing_plans WHERE is_default = 1')
    .get() as Record<string, unknown> | undefined;
  return row ? mapBillingPlanRow(row) : undefined;
}

export function createBillingPlan(plan: BillingPlan): void {
  db.transaction(() => {
    // Clear old default BEFORE inserting the new plan to avoid brief dual-default
    if (plan.is_default) {
      db.prepare(
        'UPDATE billing_plans SET is_default = 0 WHERE is_default = 1',
      ).run();
    }
    db.prepare(
      `INSERT INTO billing_plans (id, name, description, tier, monthly_cost_usd, monthly_token_quota, monthly_cost_quota,
       daily_cost_quota, weekly_cost_quota, daily_token_quota, weekly_token_quota,
       rate_multiplier, trial_days, sort_order, display_price, highlight,
       max_groups, max_concurrent_containers, max_im_channels, max_mcp_servers, max_storage_mb,
       allow_overage, features, is_default, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      plan.id,
      plan.name,
      plan.description,
      plan.tier,
      plan.monthly_cost_usd,
      plan.monthly_token_quota,
      plan.monthly_cost_quota,
      plan.daily_cost_quota,
      plan.weekly_cost_quota,
      plan.daily_token_quota,
      plan.weekly_token_quota,
      plan.rate_multiplier,
      plan.trial_days,
      plan.sort_order,
      plan.display_price,
      plan.highlight ? 1 : 0,
      plan.max_groups,
      plan.max_concurrent_containers,
      plan.max_im_channels,
      plan.max_mcp_servers,
      plan.max_storage_mb,
      plan.allow_overage ? 1 : 0,
      JSON.stringify(plan.features),
      plan.is_default ? 1 : 0,
      plan.is_active ? 1 : 0,
      plan.created_at,
      plan.updated_at,
    );
  })();
}

export function updateBillingPlan(
  id: string,
  updates: Partial<Omit<BillingPlan, 'id' | 'created_at'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.tier !== undefined) {
    fields.push('tier = ?');
    values.push(updates.tier);
  }
  if (updates.monthly_cost_usd !== undefined) {
    fields.push('monthly_cost_usd = ?');
    values.push(updates.monthly_cost_usd);
  }
  if (updates.monthly_token_quota !== undefined) {
    fields.push('monthly_token_quota = ?');
    values.push(updates.monthly_token_quota);
  }
  if (updates.monthly_cost_quota !== undefined) {
    fields.push('monthly_cost_quota = ?');
    values.push(updates.monthly_cost_quota);
  }
  if (updates.daily_cost_quota !== undefined) {
    fields.push('daily_cost_quota = ?');
    values.push(updates.daily_cost_quota);
  }
  if (updates.weekly_cost_quota !== undefined) {
    fields.push('weekly_cost_quota = ?');
    values.push(updates.weekly_cost_quota);
  }
  if (updates.daily_token_quota !== undefined) {
    fields.push('daily_token_quota = ?');
    values.push(updates.daily_token_quota);
  }
  if (updates.weekly_token_quota !== undefined) {
    fields.push('weekly_token_quota = ?');
    values.push(updates.weekly_token_quota);
  }
  if (updates.rate_multiplier !== undefined) {
    fields.push('rate_multiplier = ?');
    values.push(updates.rate_multiplier);
  }
  if (updates.trial_days !== undefined) {
    fields.push('trial_days = ?');
    values.push(updates.trial_days);
  }
  if (updates.sort_order !== undefined) {
    fields.push('sort_order = ?');
    values.push(updates.sort_order);
  }
  if (updates.display_price !== undefined) {
    fields.push('display_price = ?');
    values.push(updates.display_price);
  }
  if (updates.highlight !== undefined) {
    fields.push('highlight = ?');
    values.push(updates.highlight ? 1 : 0);
  }
  if (updates.max_groups !== undefined) {
    fields.push('max_groups = ?');
    values.push(updates.max_groups);
  }
  if (updates.max_concurrent_containers !== undefined) {
    fields.push('max_concurrent_containers = ?');
    values.push(updates.max_concurrent_containers);
  }
  if (updates.max_im_channels !== undefined) {
    fields.push('max_im_channels = ?');
    values.push(updates.max_im_channels);
  }
  if (updates.max_mcp_servers !== undefined) {
    fields.push('max_mcp_servers = ?');
    values.push(updates.max_mcp_servers);
  }
  if (updates.max_storage_mb !== undefined) {
    fields.push('max_storage_mb = ?');
    values.push(updates.max_storage_mb);
  }
  if (updates.allow_overage !== undefined) {
    fields.push('allow_overage = ?');
    values.push(updates.allow_overage ? 1 : 0);
  }
  if (updates.features !== undefined) {
    fields.push('features = ?');
    values.push(JSON.stringify(updates.features));
  }
  if (updates.is_default !== undefined) {
    fields.push('is_default = ?');
    values.push(updates.is_default ? 1 : 0);
  }
  if (updates.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.is_active ? 1 : 0);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.transaction(() => {
    // Clear old default BEFORE setting new one to avoid brief dual-default state
    if (updates.is_default) {
      db.prepare(
        'UPDATE billing_plans SET is_default = 0 WHERE id != ?',
      ).run(id);
    }
    db.prepare(
      `UPDATE billing_plans SET ${fields.join(', ')} WHERE id = ?`,
    ).run(...values);
  })();
}

export function deleteBillingPlan(id: string): boolean {
  // Don't delete if any subscription (any status) references this plan.
  // PRAGMA foreign_keys=ON 会因 cancelled/expired 残留行让 DELETE 抛
  // SQLITE_CONSTRAINT_FOREIGNKEY 把请求 500；先在应用层校验给 caller 一个
  // 干净的 false 返回，运维需要手动迁移残留订阅再删 plan。
  const hasReferences = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM user_subscriptions WHERE plan_id = ?',
    )
    .get(id) as { cnt: number };
  if (hasReferences.cnt > 0) return false;
  const result = db.prepare('DELETE FROM billing_plans WHERE id = ?').run(id);
  return result.changes > 0;
}

function mapBillingPlanRow(row: Record<string, unknown>): BillingPlan {
  return {
    id: String(row.id),
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : null,
    tier: Number(row.tier) || 0,
    monthly_cost_usd: Number(row.monthly_cost_usd) || 0,
    monthly_token_quota:
      row.monthly_token_quota != null ? Number(row.monthly_token_quota) : null,
    monthly_cost_quota:
      row.monthly_cost_quota != null ? Number(row.monthly_cost_quota) : null,
    daily_cost_quota:
      row.daily_cost_quota != null ? Number(row.daily_cost_quota) : null,
    weekly_cost_quota:
      row.weekly_cost_quota != null ? Number(row.weekly_cost_quota) : null,
    daily_token_quota:
      row.daily_token_quota != null ? Number(row.daily_token_quota) : null,
    weekly_token_quota:
      row.weekly_token_quota != null ? Number(row.weekly_token_quota) : null,
    rate_multiplier: Number(row.rate_multiplier) || 1.0,
    trial_days:
      row.trial_days != null ? Number(row.trial_days) : null,
    sort_order: Number(row.sort_order) || 0,
    display_price:
      typeof row.display_price === 'string' ? row.display_price : null,
    highlight: !!(row.highlight as number),
    max_groups: row.max_groups != null ? Number(row.max_groups) : null,
    max_concurrent_containers:
      row.max_concurrent_containers != null
        ? Number(row.max_concurrent_containers)
        : null,
    max_im_channels:
      row.max_im_channels != null ? Number(row.max_im_channels) : null,
    max_mcp_servers:
      row.max_mcp_servers != null ? Number(row.max_mcp_servers) : null,
    max_storage_mb:
      row.max_storage_mb != null ? Number(row.max_storage_mb) : null,
    allow_overage: !!(row.allow_overage as number),
    features: safeParseJsonArray(row.features),
    is_default: !!(row.is_default as number),
    is_active: !!(row.is_active as number),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function safeParseJsonArray(val: unknown): string[] {
  if (typeof val !== 'string') return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// --- User Subscriptions ---

export function getUserActiveSubscription(
  userId: string,
): (UserSubscription & { plan: BillingPlan }) | undefined {
  const row = db
    .prepare(
      `SELECT s.*, p.name as plan_name FROM user_subscriptions s
       JOIN billing_plans p ON s.plan_id = p.id
       WHERE s.user_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const plan = getBillingPlan(String(row.plan_id));
  if (!plan) return undefined;
  return { ...mapSubscriptionRow(row), plan };
}

export function createUserSubscription(sub: UserSubscription): void {
  // Wrap in a transaction so partial failure can't leave the user without an
  // active subscription (cancel succeeded, insert/update failed). Same shape
  // as expireSubscriptions / batchAssignPlan elsewhere in this file.
  const txn = db.transaction(() => {
    // Cancel existing active subscriptions
    db.prepare(
      "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
    ).run(new Date().toISOString(), sub.user_id);

    db.prepare(
      `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, cancelled_at, trial_ends_at, notes, auto_renew, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sub.id,
      sub.user_id,
      sub.plan_id,
      sub.status,
      sub.started_at,
      sub.expires_at,
      sub.cancelled_at,
      sub.trial_ends_at,
      sub.notes,
      sub.auto_renew ? 1 : 0,
      sub.created_at,
    );

    // Update user's subscription_plan_id
    db.prepare('UPDATE users SET subscription_plan_id = ? WHERE id = ?').run(
      sub.plan_id,
      sub.user_id,
    );
  });
  txn();
}

export function cancelUserSubscription(userId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
  ).run(now, userId);
  db.prepare(
    'UPDATE users SET subscription_plan_id = NULL WHERE id = ?',
  ).run(userId);
}

export function expireSubscriptions(): number {
  const now = new Date().toISOString();

  // Phase 1: Handle auto_renew=1 subscriptions — renew them instead of expiring
  const renewableRows = db
    .prepare(
      "SELECT * FROM user_subscriptions WHERE status = 'active' AND auto_renew = 1 AND expires_at IS NOT NULL AND expires_at <= ?",
    )
    .all(now) as Record<string, unknown>[];

  let renewed = 0;
  for (const row of renewableRows) {
    const userId = String(row.user_id);
    const planId = String(row.plan_id);
    const oldId = String(row.id);
    const oldStarted = String(row.started_at);
    const oldExpires = String(row.expires_at);

    // Calculate same duration as original subscription
    const startMs = new Date(oldStarted).getTime();
    const expiresMs = new Date(oldExpires).getTime();
    const durationMs = expiresMs - startMs;
    if (durationMs <= 0) continue;

    const plan = getBillingPlan(planId);
    if (!plan || !plan.is_active) {
      // Plan no longer active, expire instead
      continue;
    }

    // Check if user has sufficient balance for paid plans
    if (plan.monthly_cost_usd > 0) {
      const balance = getUserBalance(userId);
      if (balance.balance_usd < plan.monthly_cost_usd) {
        // Insufficient balance, expire instead
        logBillingAudit('subscription_expired', userId, null, {
          planId,
          planName: plan.name,
          reason: 'insufficient_balance_for_renewal',
          balance: balance.balance_usd,
          required: plan.monthly_cost_usd,
        });
        continue;
      }
    }

    // Wrap the entire renewal in a transaction for atomicity
    const renewTx = db.transaction(() => {
      // Deduct subscription cost (if paid plan)
      if (plan.monthly_cost_usd > 0) {
        adjustUserBalance(
          userId,
          -plan.monthly_cost_usd,
          'deduction',
          `自动续费: ${plan.name}`,
          'subscription',
          oldId,
          null,
          null,
          {
            source: 'subscription_renewal',
            operatorType: 'system',
            notes: `自动续费扣款: ${plan.name}`,
          },
        );
      }

      // Expire old subscription
      db.prepare(
        "UPDATE user_subscriptions SET status = 'expired' WHERE id = ?",
      ).run(oldId);

      // Create new subscription with same duration
      const newNow = new Date();
      const newExpires = new Date(newNow.getTime() + durationMs).toISOString();
      const newSub = {
        id: `sub_${userId}_${Date.now()}_renew`,
        user_id: userId,
        plan_id: planId,
        status: 'active',
        started_at: newNow.toISOString(),
        expires_at: newExpires,
        cancelled_at: null,
        trial_ends_at: null,
        notes: '自动续费',
        auto_renew: 1,
        created_at: newNow.toISOString(),
      };

      db.prepare(
        `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, cancelled_at, trial_ends_at, notes, auto_renew, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newSub.id, newSub.user_id, newSub.plan_id, newSub.status,
        newSub.started_at, newSub.expires_at, newSub.cancelled_at,
        newSub.trial_ends_at, newSub.notes, newSub.auto_renew, newSub.created_at,
      );

      logBillingAudit('subscription_assigned', userId, null, {
        planId,
        planName: plan.name,
        autoRenew: true,
        renewedFrom: oldId,
      });
    });

    try {
      renewTx();
      renewed++;
    } catch (err) {
      logBillingAudit('subscription_expired', userId, null, {
        planId,
        planName: plan.name,
        reason: 'renewal_transaction_failed',
        error: String(err),
      });
    }
  }

  // Phase 2: Expire remaining (non-auto-renew or failed renewal)
  const result = db
    .prepare(
      "UPDATE user_subscriptions SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
    )
    .run(now);
  return result.changes + renewed;
}

export function updateSubscriptionAutoRenew(
  userId: string,
  autoRenew: boolean,
): boolean {
  const result = db
    .prepare(
      "UPDATE user_subscriptions SET auto_renew = ? WHERE user_id = ? AND status = 'active'",
    )
    .run(autoRenew ? 1 : 0, userId);
  return result.changes > 0;
}

function mapSubscriptionRow(row: Record<string, unknown>): UserSubscription {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    plan_id: String(row.plan_id),
    status: String(row.status) as UserSubscription['status'],
    started_at: String(row.started_at),
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    cancelled_at:
      typeof row.cancelled_at === 'string' ? row.cancelled_at : null,
    trial_ends_at:
      typeof row.trial_ends_at === 'string' ? row.trial_ends_at : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    auto_renew: !!(row.auto_renew as number),
    created_at: String(row.created_at),
  };
}

// --- User Balances ---

export function getUserBalance(userId: string): UserBalance {
  const row = db
    .prepare('SELECT * FROM user_balances WHERE user_id = ?')
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) {
    // Auto-init balance
    const now = new Date().toISOString();
    db.prepare(
      'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
    ).run(userId, now);
    return {
      user_id: userId,
      balance_usd: 0,
      total_deposited_usd: 0,
      total_consumed_usd: 0,
      updated_at: now,
    };
  }
  return {
    user_id: String(row.user_id),
    balance_usd: Number(row.balance_usd) || 0,
    total_deposited_usd: Number(row.total_deposited_usd) || 0,
    total_consumed_usd: Number(row.total_consumed_usd) || 0,
    updated_at: String(row.updated_at),
  };
}

export function adjustUserBalance(
  userId: string,
  amount: number,
  type: BalanceTransactionType,
  description: string | null,
  referenceType: BalanceReferenceType | null,
  referenceId: string | null,
  actorId: string | null,
  idempotencyKey?: string | null,
  options?: {
    source?: BalanceTransactionSource;
    operatorType?: BalanceOperatorType;
    notes?: string | null;
    allowNegative?: boolean;
  },
): BalanceTransaction {
  const source = options?.source ?? 'system_adjustment';
  const operatorType = options?.operatorType ?? 'system';
  const notes = options?.notes ?? description ?? null;
  const allowNegative = options?.allowNegative ?? false;

  // Idempotency check: if key already used, return the existing transaction
  if (idempotencyKey) {
    const existing = db
      .prepare(
        'SELECT * FROM balance_transactions WHERE idempotency_key = ?',
      )
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      return {
        id: Number(existing.id),
        user_id: String(existing.user_id),
        type: String(existing.type) as BalanceTransactionType,
        amount_usd: Number(existing.amount_usd),
        balance_after: Number(existing.balance_after),
        description: typeof existing.description === 'string' ? existing.description : null,
        reference_type: typeof existing.reference_type === 'string' ? existing.reference_type as BalanceReferenceType : null,
        reference_id: typeof existing.reference_id === 'string' ? existing.reference_id : null,
        actor_id: typeof existing.actor_id === 'string' ? existing.actor_id : null,
        source:
          typeof existing.source === 'string'
            ? (existing.source as BalanceTransactionSource)
            : 'system_adjustment',
        operator_type:
          typeof existing.operator_type === 'string'
            ? (existing.operator_type as BalanceOperatorType)
            : 'system',
        notes: typeof existing.notes === 'string' ? existing.notes : null,
        idempotency_key:
          typeof existing.idempotency_key === 'string'
            ? existing.idempotency_key
            : null,
        created_at: String(existing.created_at),
      };
    }
  }

  const now = new Date().toISOString();

  // Wrap read-check-update-record in a transaction for atomicity
  const txFn = db.transaction(() => {
    // Ensure balance row exists
    db.prepare(
      'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
    ).run(userId, now);

    const currentRow = db
      .prepare('SELECT balance_usd FROM user_balances WHERE user_id = ?')
      .get(userId) as { balance_usd: number };
    const currentBalance = Number(currentRow.balance_usd);
    const nextBalance = currentBalance + amount;
    if (!allowNegative && nextBalance < 0) {
      throw new Error(
        `Balance cannot be negative: current=${currentBalance.toFixed(2)} next=${nextBalance.toFixed(2)}`,
      );
    }

    // Update balance
    if (amount > 0) {
      db.prepare(
        'UPDATE user_balances SET balance_usd = balance_usd + ?, total_deposited_usd = total_deposited_usd + ?, updated_at = ? WHERE user_id = ?',
      ).run(amount, amount, now, userId);
    } else {
      db.prepare(
        'UPDATE user_balances SET balance_usd = balance_usd + ?, total_consumed_usd = total_consumed_usd + ?, updated_at = ? WHERE user_id = ?',
      ).run(amount, Math.abs(amount), now, userId);
    }

    // Read new balance within the same transaction
    const newRow = db
      .prepare('SELECT balance_usd FROM user_balances WHERE user_id = ?')
      .get(userId) as { balance_usd: number };
    const balanceAfter = Number(newRow.balance_usd);

    // Record transaction
    const result = db.prepare(
      `INSERT INTO balance_transactions (
        user_id, type, amount_usd, balance_after, description, reference_type,
        reference_id, actor_id, source, operator_type, notes, created_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      type,
      amount,
      balanceAfter,
      description,
      referenceType,
      referenceId,
      actorId,
      source,
      operatorType,
      notes,
      now,
      idempotencyKey ?? null,
    );

    return {
      id: Number(result.lastInsertRowid),
      balanceAfter,
    };
  });

  const { id: txId, balanceAfter } = txFn();

  return {
    id: txId,
    user_id: userId,
    type,
    amount_usd: amount,
    balance_after: balanceAfter,
    description,
    reference_type: referenceType,
    reference_id: referenceId,
    actor_id: actorId,
    source,
    operator_type: operatorType,
    notes,
    idempotency_key: idempotencyKey ?? null,
    created_at: now,
  };
}

export function getBalanceTransactions(
  userId: string,
  limit = 50,
  offset = 0,
): { transactions: BalanceTransaction[]; total: number } {
  const total = (
    db
      .prepare(
        'SELECT COUNT(*) as cnt FROM balance_transactions WHERE user_id = ?',
      )
      .get(userId) as { cnt: number }
  ).cnt;

  const rows = db
    .prepare(
      'SELECT * FROM balance_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    )
    .all(userId, limit, offset) as Record<string, unknown>[];

  return {
    transactions: rows.map((r) => ({
      id: Number(r.id),
      user_id: String(r.user_id),
      type: String(r.type) as BalanceTransactionType,
      amount_usd: Number(r.amount_usd),
      balance_after: Number(r.balance_after),
      description: typeof r.description === 'string' ? r.description : null,
      reference_type: typeof r.reference_type === 'string'
        ? (r.reference_type as BalanceReferenceType)
        : null,
      reference_id:
        typeof r.reference_id === 'string' ? r.reference_id : null,
      actor_id: typeof r.actor_id === 'string' ? r.actor_id : null,
      source:
        typeof r.source === 'string'
          ? (r.source as BalanceTransactionSource)
          : 'system_adjustment',
      operator_type:
        typeof r.operator_type === 'string'
          ? (r.operator_type as BalanceOperatorType)
          : 'system',
      notes: typeof r.notes === 'string' ? r.notes : null,
      idempotency_key:
        typeof r.idempotency_key === 'string' ? r.idempotency_key : null,
      created_at: String(r.created_at),
    })),
    total,
  };
}

// --- Monthly Usage ---

function mapMonthlyUsageRow(row: Record<string, unknown>): MonthlyUsage {
  return {
    user_id: String(row.user_id),
    month: String(row.month),
    total_input_tokens: Number(row.total_input_tokens) || 0,
    total_output_tokens: Number(row.total_output_tokens) || 0,
    total_cost_usd: Number(row.total_cost_usd) || 0,
    message_count: Number(row.message_count) || 0,
    updated_at: String(row.updated_at),
  };
}

export function getMonthlyUsage(
  userId: string,
  month: string,
): MonthlyUsage | undefined {
  const row = db
    .prepare(
      'SELECT * FROM monthly_usage WHERE user_id = ? AND month = ?',
    )
    .get(userId, month) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapMonthlyUsageRow(row);
}

export function incrementMonthlyUsage(
  userId: string,
  month: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO monthly_usage (user_id, month, total_input_tokens, total_output_tokens, total_cost_usd, message_count, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET
       total_input_tokens = total_input_tokens + excluded.total_input_tokens,
       total_output_tokens = total_output_tokens + excluded.total_output_tokens,
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       message_count = message_count + 1,
       updated_at = excluded.updated_at`,
  ).run(userId, month, inputTokens, outputTokens, costUsd, now);
}

/**
 * Atomic monthly+daily usage increment. Wraps the two UPSERTs in a single
 * SQLite transaction so a crash between them can't leave the two tables
 * divergent for that turn (silent drift over time). billing.ts uses this
 * instead of calling the two helpers in sequence.
 */
export function incrementUsageBoth(
  userId: string,
  month: string,
  date: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  const txn = db.transaction(() => {
    incrementMonthlyUsage(userId, month, inputTokens, outputTokens, costUsd);
    incrementDailyUsage(userId, date, inputTokens, outputTokens, costUsd);
  });
  txn();
}

export function getUserMonthlyUsageHistory(
  userId: string,
  months = 6,
): MonthlyUsage[] {
  return (
    db
      .prepare(
        'SELECT * FROM monthly_usage WHERE user_id = ? ORDER BY month DESC LIMIT ?',
      )
      .all(userId, months) as Record<string, unknown>[]
  ).map(mapMonthlyUsageRow);
}

// --- Redeem Codes ---

export function getRedeemCode(code: string): RedeemCode | undefined {
  const row = db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(code) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return mapRedeemCodeRow(row);
}

export function getAllRedeemCodes(): RedeemCode[] {
  return (
    db
      .prepare('SELECT * FROM redeem_codes ORDER BY created_at DESC')
      .all() as Record<string, unknown>[]
  ).map(mapRedeemCodeRow);
}

export function createRedeemCode(code: RedeemCode): void {
  db.prepare(
    `INSERT INTO redeem_codes (code, type, value_usd, plan_id, duration_days, max_uses, used_count, expires_at, created_by, notes, batch_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    code.code,
    code.type,
    code.value_usd,
    code.plan_id,
    code.duration_days,
    code.max_uses,
    code.used_count,
    code.expires_at,
    code.created_by,
    code.notes,
    code.batch_id,
    code.created_at,
  );
}

export function incrementRedeemCodeUsage(code: string, userId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ?',
  ).run(code);
  db.prepare(
    'INSERT INTO redeem_code_usage (code, user_id, redeemed_at) VALUES (?, ?, ?)',
  ).run(code, userId, now);
}

export function deleteRedeemCode(code: string): boolean {
  const result = db.prepare('DELETE FROM redeem_codes WHERE code = ?').run(code);
  return result.changes > 0;
}

export function hasUserRedeemedCode(
  userId: string,
  code: string,
): boolean {
  const row = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM redeem_code_usage WHERE user_id = ? AND code = ?',
    )
    .get(userId, code) as { cnt: number };
  return row.cnt > 0;
}

function mapRedeemCodeRow(row: Record<string, unknown>): RedeemCode {
  return {
    code: String(row.code),
    type: String(row.type) as RedeemCode['type'],
    value_usd: row.value_usd != null ? Number(row.value_usd) : null,
    plan_id: typeof row.plan_id === 'string' ? row.plan_id : null,
    duration_days:
      row.duration_days != null ? Number(row.duration_days) : null,
    max_uses: Number(row.max_uses) || 1,
    used_count: Number(row.used_count) || 0,
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    created_by: String(row.created_by),
    notes: typeof row.notes === 'string' ? row.notes : null,
    batch_id: typeof row.batch_id === 'string' ? row.batch_id : null,
    created_at: String(row.created_at),
  };
}

// --- Billing Audit Log ---

export function logBillingAudit(
  eventType: BillingAuditEventType,
  userId: string,
  actorId: string | null,
  details: Record<string, unknown> | null,
): void {
  db.prepare(
    'INSERT INTO billing_audit_log (event_type, user_id, actor_id, details, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    eventType,
    userId,
    actorId,
    details ? JSON.stringify(details) : null,
    new Date().toISOString(),
  );
}

export function getBillingAuditLog(
  limit = 50,
  offset = 0,
  userId?: string,
  eventType?: string,
): { logs: BillingAuditLog[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (eventType) {
    conditions.push('event_type = ?');
    params.push(eventType);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM billing_audit_log ${where}`)
      .get(...params) as { cnt: number }
  ).cnt;

  const rows = db
    .prepare(
      `SELECT * FROM billing_audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  return {
    logs: rows.map((r) => ({
      id: Number(r.id),
      event_type: String(r.event_type) as BillingAuditEventType,
      user_id: String(r.user_id),
      actor_id: typeof r.actor_id === 'string' ? r.actor_id : null,
      // 防御性 parse：单行损坏不应让整个审计 API 500（事故排查的关键时刻
      // 不能因一行坏数据看不到日志）。parseJsonDetails 出错时返回 null。
      details: parseJsonDetails(r.details),
      created_at: String(r.created_at),
    })),
    total,
  };
}

// --- Billing summary helpers ---

export function getUserGroupCount(userId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(DISTINCT rg.folder) as cnt FROM registered_groups rg WHERE rg.created_by = ? AND rg.jid LIKE 'web:%'",
    )
    .get(userId) as { cnt: number };
  return row.cnt;
}

export function getAllUserBillingOverview(): Array<{
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  plan_id: string | null;
  plan_name: string | null;
  balance_usd: number;
  current_month_cost: number;
}> {
  const month = new Date().toISOString().slice(0, 7);
  return db
    .prepare(
      `SELECT u.id as user_id, u.username, u.display_name, u.role,
              s.plan_id, p.name as plan_name,
              COALESCE(b.balance_usd, 0) as balance_usd,
              COALESCE(mu.total_cost_usd, 0) as current_month_cost
       FROM users u
       LEFT JOIN user_subscriptions s ON s.user_id = u.id AND s.status = 'active'
       LEFT JOIN billing_plans p ON p.id = s.plan_id
       LEFT JOIN user_balances b ON b.user_id = u.id
       LEFT JOIN monthly_usage mu ON mu.user_id = u.id AND mu.month = ?
       WHERE u.status != 'deleted'
       ORDER BY u.created_at ASC`,
    )
    .all(month) as Array<{
    user_id: string;
    username: string;
    display_name: string;
    role: string;
    plan_id: string | null;
    plan_name: string | null;
    balance_usd: number;
    current_month_cost: number;
  }>;
}

export function getRevenueStats(): {
  totalDeposited: number;
  totalConsumed: number;
  activeSubscriptions: number;
  currentMonthRevenue: number;
} {
  const month = new Date().toISOString().slice(0, 7);
  const deposited = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_deposited_usd), 0) as total FROM user_balances',
      )
      .get() as { total: number }
  ).total;
  const consumed = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_consumed_usd), 0) as total FROM user_balances',
      )
      .get() as { total: number }
  ).total;
  const activeSubs = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active'",
      )
      .get() as { cnt: number }
  ).cnt;
  const monthRevenue = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM monthly_usage WHERE month = ?',
      )
      .get(month) as { total: number }
  ).total;
  return {
    totalDeposited: deposited,
    totalConsumed: consumed,
    activeSubscriptions: activeSubs,
    currentMonthRevenue: monthRevenue,
  };
}

// --- Daily Usage ---

function mapDailyUsageRow(row: Record<string, unknown>): DailyUsage {
  return {
    user_id: String(row.user_id),
    date: String(row.date),
    total_input_tokens: Number(row.total_input_tokens) || 0,
    total_output_tokens: Number(row.total_output_tokens) || 0,
    total_cost_usd: Number(row.total_cost_usd) || 0,
    message_count: Number(row.message_count) || 0,
  };
}

export function incrementDailyUsage(
  userId: string,
  date: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  db.prepare(
    `INSERT INTO daily_usage (user_id, date, total_input_tokens, total_output_tokens, total_cost_usd, message_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(user_id, date) DO UPDATE SET
       total_input_tokens = total_input_tokens + excluded.total_input_tokens,
       total_output_tokens = total_output_tokens + excluded.total_output_tokens,
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       message_count = message_count + 1`,
  ).run(userId, date, inputTokens, outputTokens, costUsd);
}

export function getDailyUsage(
  userId: string,
  date: string,
): DailyUsage | undefined {
  const row = db
    .prepare('SELECT * FROM daily_usage WHERE user_id = ? AND date = ?')
    .get(userId, date) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapDailyUsageRow(row);
}

export function getWeeklyUsageSummary(
  userId: string,
): { totalCost: number; totalTokens: number } {
  // Align to calendar week (Monday–Sunday) to match checkQuota() reset logic
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysSinceMonday);
  const startDate = monday.toISOString().slice(0, 10);

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) as totalCost,
              COALESCE(SUM(total_input_tokens + total_output_tokens), 0) as totalTokens
       FROM daily_usage WHERE user_id = ? AND date >= ?`,
    )
    .get(userId, startDate) as { totalCost: number; totalTokens: number };
  return { totalCost: row.totalCost, totalTokens: row.totalTokens };
}

export function getUserDailyUsageHistory(
  userId: string,
  days = 14,
): DailyUsage[] {
  return (
    db
      .prepare(
        'SELECT * FROM daily_usage WHERE user_id = ? ORDER BY date DESC LIMIT ?',
      )
      .all(userId, days) as Record<string, unknown>[]
  ).map(mapDailyUsageRow);
}

export function getDailyUsageSumForMonth(
  userId: string,
  month: string,
): { totalInputTokens: number; totalOutputTokens: number; totalCost: number; messageCount: number } {
  const startDate = `${month}-01`;
  // End date: first day of next month
  const [y, m] = month.split('-').map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const endDate = `${nextMonth}-01`;

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_input_tokens), 0) as totalInputTokens,
              COALESCE(SUM(total_output_tokens), 0) as totalOutputTokens,
              COALESCE(SUM(total_cost_usd), 0) as totalCost,
              COALESCE(SUM(message_count), 0) as messageCount
       FROM daily_usage WHERE user_id = ? AND date >= ? AND date < ?`,
    )
    .get(userId, startDate, endDate) as {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    messageCount: number;
  };
  return row;
}

export function correctMonthlyUsage(
  userId: string,
  month: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  messageCount: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO monthly_usage (user_id, month, total_input_tokens, total_output_tokens, total_cost_usd, message_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET
       total_input_tokens = excluded.total_input_tokens,
       total_output_tokens = excluded.total_output_tokens,
       total_cost_usd = excluded.total_cost_usd,
       message_count = excluded.message_count,
       updated_at = excluded.updated_at`,
  ).run(userId, month, inputTokens, outputTokens, costUsd, messageCount, now);
}

export function getSubscriptionHistory(
  userId: string,
): (UserSubscription & { plan_name: string })[] {
  return (
    db
      .prepare(
        `SELECT s.*, p.name as plan_name FROM user_subscriptions s
         JOIN billing_plans p ON s.plan_id = p.id
         WHERE s.user_id = ?
         ORDER BY s.created_at DESC`,
      )
      .all(userId) as Record<string, unknown>[]
  ).map((row) => ({
    ...mapSubscriptionRow(row),
    plan_name: String(row.plan_name),
  }));
}

export function getRedeemCodeUsageDetails(
  code: string,
): Array<{ user_id: string; username: string; redeemed_at: string }> {
  return db
    .prepare(
      `SELECT rcu.user_id, u.username, rcu.redeemed_at
       FROM redeem_code_usage rcu
       LEFT JOIN users u ON u.id = rcu.user_id
       WHERE rcu.code = ?
       ORDER BY rcu.redeemed_at DESC`,
    )
    .all(code) as Array<{
    user_id: string;
    username: string;
    redeemed_at: string;
  }>;
}

export function getDashboardStats(): {
  activeUsers: number;
  totalUsers: number;
  planDistribution: Array<{ plan_name: string; count: number }>;
  todayCost: number;
  monthCost: number;
  activeSubscriptions: number;
} {
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  const totalUsers = (
    db.prepare("SELECT COUNT(*) as cnt FROM users WHERE status != 'deleted'")
      .get() as { cnt: number }
  ).cnt;

  const activeUsers = (
    db.prepare(
      "SELECT COUNT(DISTINCT user_id) as cnt FROM daily_usage WHERE date = ?",
    ).get(today) as { cnt: number }
  ).cnt;

  const planDistribution = db
    .prepare(
      `SELECT COALESCE(p.name, '无套餐') as plan_name, COUNT(*) as count
       FROM users u
       LEFT JOIN user_subscriptions s ON s.user_id = u.id AND s.status = 'active'
       LEFT JOIN billing_plans p ON p.id = s.plan_id
       WHERE u.status != 'deleted'
       GROUP BY p.name
       ORDER BY count DESC`,
    )
    .all() as Array<{ plan_name: string; count: number }>;

  const todayCost = (
    db.prepare(
      'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM daily_usage WHERE date = ?',
    ).get(today) as { total: number }
  ).total;

  const monthCost = (
    db.prepare(
      'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM monthly_usage WHERE month = ?',
    ).get(month) as { total: number }
  ).total;

  const activeSubscriptions = (
    db.prepare(
      "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active'",
    ).get() as { cnt: number }
  ).cnt;

  return {
    activeUsers,
    totalUsers,
    planDistribution,
    todayCost,
    monthCost,
    activeSubscriptions,
  };
}

export function getRevenueTrend(
  months = 6,
): Array<{ month: string; revenue: number; users: number }> {
  return db
    .prepare(
      `SELECT month, SUM(total_cost_usd) as revenue, COUNT(DISTINCT user_id) as users
       FROM monthly_usage
       GROUP BY month
       ORDER BY month DESC
       LIMIT ?`,
    )
    .all(months) as Array<{ month: string; revenue: number; users: number }>;
}

export function batchAssignPlan(
  userIds: string[],
  planId: string,
  actorId: string,
  durationDays?: number,
): number {
  const plan = getBillingPlan(planId);
  if (!plan) throw new Error(`Plan not found: ${planId}`);

  const now = new Date();
  const expiresAt = durationDays
    ? new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  let count = 0;
  const txn = db.transaction(() => {
    for (const userId of userIds) {
      // Cancel existing
      db.prepare(
        "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
      ).run(now.toISOString(), userId);

      const subId = `sub_${userId}_${Date.now()}_${count}`;
      db.prepare(
        `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, auto_renew, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, 0, ?)`,
      ).run(subId, userId, planId, now.toISOString(), expiresAt, now.toISOString());

      db.prepare('UPDATE users SET subscription_plan_id = ? WHERE id = ?').run(
        planId,
        userId,
      );

      logBillingAudit('subscription_assigned', userId, actorId, {
        planId,
        planName: plan.name,
        durationDays: durationDays ?? null,
        batch: true,
      });
      count++;
    }
  });
  txn();
  return count;
}

export function getPlanSubscriberCount(planId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE plan_id = ? AND status = 'active'",
    )
    .get(planId) as { cnt: number };
  return row.cnt;
}

export function getAllPlanSubscriberCounts(): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT plan_id, COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active' GROUP BY plan_id",
    )
    .all() as Array<{ plan_id: string; cnt: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.plan_id] = row.cnt;
  }
  return result;
}


/**
 * Atomically increment redeem code usage with optimistic locking.
 * Returns true if the increment succeeded (used_count < max_uses).
 */
export function tryIncrementRedeemCodeUsage(
  code: string,
  userId: string,
): boolean {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const result = db
      .prepare(
        'UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses',
      )
      .run(code);
    if (result.changes === 0) return false;
    db.prepare(
      'INSERT INTO redeem_code_usage (code, user_id, redeemed_at) VALUES (?, ?, ?)',
    ).run(code, userId, now);
    return true;
  })();
}

/**
 * Close the database connection.
 * Should be called during graceful shutdown.
 */
export function closeDatabase(): void {
  _stmts = null;
  _newMsgStmtCache.clear();
  if (db) {
    db.close();
  }
}

// ─── Agent PaaS: Agent Definitions ─────────────────────────

export type AgentDefinitionRow = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  system_prompt: string;
  model: string | null;
  engine: string;
  avatar_emoji: string | null;
  avatar_color: string | null;
  max_turns: number | null;
  temperature: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type AgentMountRow = {
  id: string;
  agent_def_id: string;
  resource_type: string;
  resource_id: string;
  created_at: string;
};

function isoNow(): string {
  return new Date().toISOString();
}

export function listAgentDefinitions(userId: string): AgentDefinitionRow[] {
  return db
    .prepare('SELECT * FROM agent_definitions WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as AgentDefinitionRow[];
}

export function getAgentDefinition(
  id: string,
  userId: string,
): AgentDefinitionRow | null {
  const row = db
    .prepare('SELECT * FROM agent_definitions WHERE id = ? AND user_id = ?')
    .get(id, userId) as AgentDefinitionRow | undefined;
  return row ?? null;
}

export function countAgentDefinitions(userId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) as n FROM agent_definitions WHERE user_id = ?')
    .get(userId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function createAgentDefinition(
  userId: string,
  input: {
    name: string;
    description?: string;
    system_prompt?: string;
    model?: string | null;
    engine?: string;
    avatar_emoji?: string | null;
    avatar_color?: string | null;
    max_turns?: number | null;
    temperature?: number | null;
    enabled?: boolean;
  },
): AgentDefinitionRow {
  const id = crypto.randomUUID();
  const now = isoNow();
  db.prepare(
    `INSERT INTO agent_definitions (id, user_id, name, description, system_prompt, model, engine, avatar_emoji, avatar_color, max_turns, temperature, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    input.name,
    input.description ?? '',
    input.system_prompt ?? '',
    input.model ?? null,
    input.engine ?? 'claude',
    input.avatar_emoji ?? null,
    input.avatar_color ?? null,
    input.max_turns ?? null,
    input.temperature ?? null,
    input.enabled === false ? 0 : 1,
    now,
    now,
  );
  return getAgentDefinition(id, userId)!;
}

export function updateAgentDefinition(
  id: string,
  userId: string,
  patch: {
    name?: string;
    description?: string;
    system_prompt?: string;
    model?: string | null;
    engine?: string;
    avatar_emoji?: string | null;
    avatar_color?: string | null;
    max_turns?: number | null;
    temperature?: number | null;
    enabled?: boolean;
  },
): AgentDefinitionRow | null {
  const existing = getAgentDefinition(id, userId);
  if (!existing) return null;
  // Phase 2: snapshot current state before mutating. Even if patch doesn't
  // change any field (caller bug), the snapshot is harmless.
  const existingMounts = listAgentMounts(id);
  saveAgentVersionSnapshot(id, existing, existingMounts, userId);
  const next: AgentDefinitionRow = {
    ...existing,
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    system_prompt: patch.system_prompt ?? existing.system_prompt,
    model: patch.model !== undefined ? patch.model : existing.model,
    engine: patch.engine ?? existing.engine,
    avatar_emoji: patch.avatar_emoji !== undefined ? patch.avatar_emoji : existing.avatar_emoji,
    avatar_color: patch.avatar_color !== undefined ? patch.avatar_color : existing.avatar_color,
    max_turns: patch.max_turns !== undefined ? patch.max_turns : existing.max_turns,
    temperature: patch.temperature !== undefined ? patch.temperature : existing.temperature,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
    updated_at: isoNow(),
  };
  db.prepare(
    `UPDATE agent_definitions SET name=?, description=?, system_prompt=?, model=?, engine=?, avatar_emoji=?, avatar_color=?, max_turns=?, temperature=?, enabled=?, updated_at=? WHERE id=? AND user_id=?`,
  ).run(
    next.name,
    next.description,
    next.system_prompt,
    next.model,
    next.engine,
    next.avatar_emoji,
    next.avatar_color,
    next.max_turns,
    next.temperature,
    next.enabled,
    next.updated_at,
    id,
    userId,
  );
  return next;
}

export function deleteAgentDefinition(id: string, userId: string): boolean {
  const result = db
    .prepare('DELETE FROM agent_definitions WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return result.changes > 0;
}

// ─── Agent PaaS: Agent Mounts ───────────────────────────────

export function listAgentMounts(agentDefId: string): AgentMountRow[] {
  return db
    .prepare('SELECT * FROM agent_mounts WHERE agent_def_id = ? ORDER BY created_at')
    .all(agentDefId) as AgentMountRow[];
}

export function addAgentMount(
  agentDefId: string,
  resourceType: string,
  resourceId: string,
): AgentMountRow {
  // Check uniqueness; if exists, return existing
  const existing = db
    .prepare(
      'SELECT * FROM agent_mounts WHERE agent_def_id = ? AND resource_type = ? AND resource_id = ?',
    )
    .get(agentDefId, resourceType, resourceId) as AgentMountRow | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  const now = isoNow();
  db.prepare(
    'INSERT INTO agent_mounts (id, agent_def_id, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, agentDefId, resourceType, resourceId, now);
  return {
    id,
    agent_def_id: agentDefId,
    resource_type: resourceType,
    resource_id: resourceId,
    created_at: now,
  };
}

export function deleteAgentMount(
  id: string,
  agentDefId: string,
): boolean {
  const result = db
    .prepare('DELETE FROM agent_mounts WHERE id = ? AND agent_def_id = ?')
    .run(id, agentDefId);
  return result.changes > 0;
}

// ─── Agent PaaS: Knowledge Bases ──────────────────────────

export type KnowledgeBaseRow = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  doc_count: number;
  created_at: string;
  updated_at: string;
};

export type KbDocumentRow = {
  id: string;
  kb_id: string;
  user_id: string;
  filename: string;
  content: string;
  content_hash: string;
  size_bytes: number;
  created_at: string;
  parser_type?: string | null;
  embedding?: Buffer | null;
  embedding_model?: string | null;
};

export function listKnowledgeBases(userId: string): KnowledgeBaseRow[] {
  return db
    .prepare('SELECT * FROM knowledge_bases WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as KnowledgeBaseRow[];
}

export function getKnowledgeBase(
  id: string,
  userId: string,
): KnowledgeBaseRow | null {
  const row = db
    .prepare('SELECT * FROM knowledge_bases WHERE id = ? AND user_id = ?')
    .get(id, userId) as KnowledgeBaseRow | undefined;
  return row ?? null;
}

export function createKnowledgeBase(
  userId: string,
  name: string,
  description?: string,
): KnowledgeBaseRow {
  const id = crypto.randomUUID();
  const now = isoNow();
  db.prepare(
    `INSERT INTO knowledge_bases (id, user_id, name, description, doc_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, userId, name, description ?? '', now, now);
  return getKnowledgeBase(id, userId)!;
}

export function updateKnowledgeBase(
  id: string,
  userId: string,
  patch: { name?: string; description?: string },
): KnowledgeBaseRow | null {
  const existing = getKnowledgeBase(id, userId);
  if (!existing) return null;
  const next = {
    ...existing,
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    updated_at: isoNow(),
  };
  db.prepare(
    'UPDATE knowledge_bases SET name=?, description=?, updated_at=? WHERE id=? AND user_id=?',
  ).run(next.name, next.description, next.updated_at, id, userId);
  return next;
}

export function deleteKnowledgeBase(id: string, userId: string): boolean {
  // FTS trigger handles cascade delete of docs
  // But FTS5 content table is `kb_documents` — deletion via FK cascade works only if docs deleted via SQL.
  // Explicit delete to ensure FTS triggers fire:
  if (vecExtensionLoaded) {
    try {
      db.prepare(
        `DELETE FROM kb_documents_vec WHERE doc_id IN (SELECT id FROM kb_documents WHERE kb_id = ?)`,
      ).run(id);
    } catch (err) {
      logger.warn({ err, kbId: id }, 'Failed to clean kb_documents_vec on KB delete');
    }
  }
  db.prepare('DELETE FROM kb_documents WHERE kb_id = ?').all(id);
  const result = db
    .prepare('DELETE FROM knowledge_bases WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return result.changes > 0;
}

export function listKbDocuments(
  kbId: string,
  userId: string,
): KbDocumentRow[] {
  return db
    .prepare('SELECT * FROM kb_documents WHERE kb_id = ? AND user_id = ? ORDER BY created_at DESC')
    .all(kbId, userId) as KbDocumentRow[];
}

export function addKbDocument(
  kbId: string,
  userId: string,
  filename: string,
  content: string,
): { row: KbDocumentRow; duplicate: boolean } {
  const hash = crypto
    .createHash('sha256')
    .update(content)
    .digest('hex');
  // Duplicate check within same KB
  const existing = db
    .prepare('SELECT * FROM kb_documents WHERE kb_id = ? AND content_hash = ?')
    .get(kbId, hash) as KbDocumentRow | undefined;
  if (existing) {
    return { row: existing, duplicate: true };
  }
  const id = crypto.randomUUID();
  const now = isoNow();
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  db.prepare(
    `INSERT INTO kb_documents (id, kb_id, user_id, filename, content, content_hash, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kbId, userId, filename, content, hash, sizeBytes, now);
  // Update doc_count
  db.prepare(
    'UPDATE knowledge_bases SET doc_count = (SELECT COUNT(*) FROM kb_documents WHERE kb_id = ?), updated_at = ? WHERE id = ?',
  ).run(kbId, now, kbId);
  return {
    row: {
      id,
      kb_id: kbId,
      user_id: userId,
      filename,
      content,
      content_hash: hash,
      size_bytes: sizeBytes,
      created_at: now,
    },
    duplicate: false,
  };
}

export function deleteKbDocument(
  docId: string,
  userId: string,
): boolean {
  const doc = db
    .prepare('SELECT kb_id FROM kb_documents WHERE id = ? AND user_id = ?')
    .get(docId, userId) as { kb_id: string } | undefined;
  if (!doc) return false;
  deleteDocFromVecIndex(docId);
  const result = db
    .prepare('DELETE FROM kb_documents WHERE id = ? AND user_id = ?')
    .run(docId, userId);
  if (result.changes > 0) {
    const now = isoNow();
    db.prepare(
      'UPDATE knowledge_bases SET doc_count = (SELECT COUNT(*) FROM kb_documents WHERE kb_id = ?), updated_at = ? WHERE id = ?',
    ).run(doc.kb_id, now, doc.kb_id);
  }
  return result.changes > 0;
}

export function searchKbDocuments(
  kbIds: string[],
  query: string,
  limit: number = 5,
): Array<{
  doc_id: string;
  kb_id: string;
  filename: string;
  snippet: string;
  rank: number;
}> {
  if (kbIds.length === 0 || !query.trim()) return [];
  // Sanitize: wrap as quoted phrase to avoid FTS5 syntax injection
  const sanitized = query.replace(/["'\n\r]/g, ' ').trim();
  if (!sanitized) return [];
  const ftsQuery = `"${sanitized}"`;
  const placeholders = kbIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
         kb_documents.id as doc_id,
         kb_documents.kb_id as kb_id,
         kb_documents.filename as filename,
         snippet(kb_documents_fts, 1, '[', ']', '…', 8) as snippet,
         bm25(kb_documents_fts) as rank
       FROM kb_documents_fts
       JOIN kb_documents ON kb_documents.id = kb_documents_fts.rowid
       WHERE kb_documents_fts MATCH ?
         AND kb_documents.kb_id IN (${placeholders})
       ORDER BY rank
       LIMIT ?`,
    )
    .all(ftsQuery, ...kbIds, limit);
  return rows as Array<{
    doc_id: string;
    kb_id: string;
    filename: string;
    snippet: string;
    rank: number;
  }>;
}

// ─── Agent PaaS: Marketplace ───────────────────────────────

export type MarketplaceItemRow = {
  id: string;
  item_type: string;
  name: string;
  description: string;
  author_name: string;
  tags: string;
  payload: string;
  installed_count: number;
  created_at: string;
  updated_at: string;
  status: MarketplaceStatus;
  submitted_by: string | null;
};

export function listMarketplaceItems(
  status?: MarketplaceStatus,
  itemType?: string,
): MarketplaceItemRow[] {
  let sql = 'SELECT * FROM marketplace_items';
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (itemType) { clauses.push('item_type = ?'); params.push(itemType); }
  if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY installed_count DESC, created_at DESC';
  return db.prepare(sql).all(...params) as MarketplaceItemRow[];
}

export function getMarketplaceItem(id: string): MarketplaceItemRow | null {
  const row = db
    .prepare('SELECT * FROM marketplace_items WHERE id = ?')
    .get(id) as MarketplaceItemRow | undefined;
  return row ?? null;
}

export function createMarketplaceItem(
  input: {
    item_type: string;
    name: string;
    description?: string;
    author_name?: string;
    tags?: string[];
    payload: unknown;
  },
): MarketplaceItemRow {
  const id = crypto.randomUUID();
  const now = isoNow();
  db.prepare(
    `INSERT INTO marketplace_items (id, item_type, name, description, author_name, tags, payload, installed_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    input.item_type,
    input.name,
    input.description ?? '',
    input.author_name ?? '',
    JSON.stringify(input.tags ?? []),
    JSON.stringify(input.payload),
    now,
    now,
  );
  return getMarketplaceItem(id)!;
}

export function incrementInstallCount(id: string): void {
  db.prepare(
    'UPDATE marketplace_items SET installed_count = installed_count + 1, updated_at = ? WHERE id = ?',
  ).run(isoNow(), id);
}

export function countMarketplaceItems(): number {
  const row = db
    .prepare('SELECT COUNT(*) as n FROM marketplace_items')
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export function setGroupAgentDefId(
  jid: string,
  agentDefId: string | null,
): void {
  db.prepare('UPDATE registered_groups SET agent_def_id = ? WHERE jid = ?').run(
    agentDefId,
    jid,
  );
}

export function getUserAgentQuota(userId: string): number {
  const row = db
    .prepare('SELECT agent_quota FROM users WHERE id = ?')
    .get(userId) as { agent_quota: number } | undefined;
  return row?.agent_quota ?? 10;
}

// ─── Agent PaaS Phase 2: Embedding / Review / Version / Quota ───

export function updateDocEmbedding(
  docId: string,
  embedding: Float32Array | Buffer,
  model: string,
): void {
  const buf = embedding instanceof Buffer ? embedding : Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  db.prepare(
    'UPDATE kb_documents SET embedding = ?, embedding_model = ? WHERE id = ?',
  ).run(buf, model, docId);
  // Phase 3: 同步写入 sqlite-vec 虚拟表（若扩展已加载）
  if (vecExtensionLoaded) {
    try {
      db.prepare(
        `INSERT INTO kb_documents_vec (doc_id, embedding) VALUES (?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET embedding = excluded.embedding`,
      ).run(docId, buf);
    } catch (err) {
      logger.warn({ err, docId }, 'Failed to upsert into kb_documents_vec');
    }
  }
}

export function deleteDocFromVecIndex(docId: string): void {
  if (!vecExtensionLoaded) return;
  try {
    db.prepare('DELETE FROM kb_documents_vec WHERE doc_id = ?').run(docId);
  } catch (err) {
    logger.warn({ err, docId }, 'Failed to delete from kb_documents_vec');
  }
}

export function getKbDocumentContent(docId: string): string | null {
  const row = db
    .prepare('SELECT content FROM kb_documents WHERE id = ?')
    .get(docId) as { content: string } | undefined;
  return row?.content ?? null;
}

export function listUnembeddedDocsInKb(kbId: string): Array<{ id: string; content: string }> {
  return db
    .prepare(
      'SELECT id, content FROM kb_documents WHERE kb_id = ? AND embedding IS NULL',
    )
    .all(kbId) as Array<{ id: string; content: string }>;
}

export function getDocEmbedding(docId: string): Buffer | null {
  const row = db
    .prepare('SELECT embedding FROM kb_documents WHERE id = ?')
    .get(docId) as { embedding: Buffer | null } | undefined;
  return row?.embedding ?? null;
}

export function listAllKbDocIds(kbId: string): Array<{ id: string; filename: string; embedding: Buffer | null }> {
  return db
    .prepare(
      'SELECT id, filename, embedding FROM kb_documents WHERE kb_id = ?',
    )
    .all(kbId) as Array<{ id: string; filename: string; embedding: Buffer | null }>;
}

export interface HybridSearchRow {
  doc_id: string;
  kb_id: string;
  filename: string;
  snippet: string;
  rank: number;
  source: 'fts' | 'vector' | 'hybrid';
}

/**
 * Vector search: dispatches to sqlite-vec when loaded, else falls back to linear scan.
 * Returns top-K by cosine similarity to the query embedding.
 */
export function vectorSearchKbDocuments(
  kbIds: string[],
  queryEmbedding: Float32Array,
  limit: number,
): Array<{ doc_id: string; kb_id: string; filename: string; score: number; snippet: string }> {
  if (kbIds.length === 0) return [];
  if (vecExtensionLoaded) return vectorSearchViaVec(kbIds, queryEmbedding, limit);
  return vectorSearchKbDocumentsLinear(kbIds, queryEmbedding, limit);
}

function vectorSearchViaVec(
  kbIds: string[],
  queryEmbedding: Float32Array,
  limit: number,
): Array<{ doc_id: string; kb_id: string; filename: string; score: number; snippet: string }> {
  const placeholders = kbIds.map(() => '?').join(',');
  const qbuf = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
  try {
    const rows = db
      .prepare(
        `SELECT v.doc_id as doc_id, v.distance as distance, d.kb_id as kb_id, d.filename as filename, d.content as content
         FROM kb_documents_vec v
         JOIN kb_documents d ON d.id = v.doc_id
         WHERE v.embedding MATCH ? AND d.kb_id IN (${placeholders})
         ORDER BY v.distance
         LIMIT ?`,
      )
      .all(qbuf, ...kbIds, limit) as Array<{ doc_id: string; kb_id: string; filename: string; content: string; distance: number }>;
    return rows.map((r) => ({
      doc_id: r.doc_id,
      kb_id: r.kb_id,
      filename: r.filename,
      score: Math.max(0, 1 - r.distance),
      snippet: r.content.slice(0, 200).replace(/\s+/g, ' ').trim(),
    }));
  } catch (err) {
    logger.warn({ err }, 'vec table KNN query failed — falling back to linear scan');
    return vectorSearchKbDocumentsLinear(kbIds, queryEmbedding, limit);
  }
}

function vectorSearchKbDocumentsLinear(
  kbIds: string[],
  queryEmbedding: Float32Array,
  limit: number,
): Array<{ doc_id: string; kb_id: string; filename: string; score: number; snippet: string }> {
  const placeholders = kbIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id as doc_id, kb_id, filename, content, embedding
       FROM kb_documents
       WHERE kb_id IN (${placeholders}) AND embedding IS NOT NULL`,
    )
    .all(...kbIds) as Array<{ doc_id: string; kb_id: string; filename: string; content: string; embedding: Buffer }>;
  const scored: Array<{ doc_id: string; kb_id: string; filename: string; score: number; snippet: string }> = [];
  for (const r of rows) {
    const emb = bufferToFloat32InDb(r.embedding);
    if (!emb || emb.length === 0) continue;
    const score = cosineSimInDb(queryEmbedding, emb);
    const snippet = r.content.slice(0, 200).replace(/\s+/g, ' ').trim();
    scored.push({ doc_id: r.doc_id, kb_id: r.kb_id, filename: r.filename, score, snippet });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function bufferToFloat32InDb(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.length / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function cosineSimInDb(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let nA = 0;
  let nB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    nA += av * av;
    nB += bv * bv;
  }
  if (nA === 0 || nB === 0) return 0;
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

/**
 * Hybrid search: FTS5 bm25 + cosine similarity, normalized and weighted 0.5/0.5.
 * Falls back to FTS5-only when queryEmbedding is null.
 */
export function hybridSearchKbDocuments(
  kbIds: string[],
  query: string,
  limit: number,
  queryEmbedding: Float32Array | null,
): HybridSearchRow[] {
  // FTS5 top-N (limit * 2)
  const ftsLimit = Math.max(limit * 2, 10);
  const ftsRows = searchKbDocuments(kbIds, query, ftsLimit);

  if (!queryEmbedding) {
    return ftsRows.map((r) => ({
      doc_id: r.doc_id,
      kb_id: r.kb_id,
      filename: r.filename,
      snippet: r.snippet,
      rank: r.rank,
      source: 'fts' as const,
    }));
  }

  // Vector top-N (limit * 2)
  const vecRows = vectorSearchKbDocuments(kbIds, queryEmbedding, ftsLimit);

  // Normalize FTS scores (bm25 is negative, lower is better — invert)
  const ftsScores = ftsRows.map((r) => -r.rank);
  const ftsMin = Math.min(...ftsScores, 0);
  const ftsMax = Math.max(...ftsScores, 1);
  const ftsRange = ftsMax - ftsMin || 1;

  // Normalize vector scores (cosine, 0-1, higher is better)
  const vecScores = vecRows.map((r) => r.score);
  const vecMin = Math.min(...vecScores, 0);
  const vecMax = Math.max(...vecScores, 1);
  const vecRange = vecMax - vecMin || 1;

  const map = new Map<string, HybridSearchRow>();
  for (const r of ftsRows) {
    const norm = (ftsScores[ftsRows.indexOf(r)] - ftsMin) / ftsRange;
    map.set(r.doc_id, {
      doc_id: r.doc_id,
      kb_id: r.kb_id,
      filename: r.filename,
      snippet: r.snippet,
      rank: norm * 0.5,
      source: 'hybrid',
    });
  }
  for (const r of vecRows) {
    const norm = (r.score - vecMin) / vecRange;
    const existing = map.get(r.doc_id);
    if (existing) {
      existing.rank += norm * 0.5;
    } else {
      map.set(r.doc_id, {
        doc_id: r.doc_id,
        kb_id: r.kb_id,
        filename: r.filename,
        snippet: r.snippet,
        rank: norm * 0.5,
        source: 'hybrid',
      });
    }
  }
  const merged = Array.from(map.values());
  merged.sort((a, b) => b.rank - a.rank);
  return merged.slice(0, limit);
}

// ─── Marketplace: review + status ───

export type MarketplaceStatus = 'pending' | 'approved' | 'rejected';

export function setMarketplaceItemStatus(id: string, status: MarketplaceStatus): void {
  db.prepare('UPDATE marketplace_items SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    isoNow(),
    id,
  );
}

export function listMarketplaceItemsByUser(userId: string): MarketplaceItemRow[] {
  return db
    .prepare(
      'SELECT * FROM marketplace_items WHERE submitted_by = ? ORDER BY created_at DESC',
    )
    .all(userId) as MarketplaceItemRow[];
}

export interface MarketplaceReviewRow {
  id: string;
  item_id: string;
  user_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
  updated_at: string;
}

export function upsertReview(
  itemId: string,
  userId: string,
  rating: number,
  comment: string | null,
): MarketplaceReviewRow {
  const existing = db
    .prepare('SELECT * FROM marketplace_reviews WHERE item_id = ? AND user_id = ?')
    .get(itemId, userId) as MarketplaceReviewRow | undefined;
  const now = isoNow();
  if (existing) {
    db.prepare(
      'UPDATE marketplace_reviews SET rating = ?, comment = ?, updated_at = ? WHERE id = ?',
    ).run(rating, comment, now, existing.id);
    return { ...existing, rating, comment, updated_at: now };
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO marketplace_reviews (id, item_id, user_id, rating, comment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, itemId, userId, rating, comment, now, now);
  return {
    id,
    item_id: itemId,
    user_id: userId,
    rating,
    comment,
    created_at: now,
    updated_at: now,
  };
}

export function listReviews(itemId: string): MarketplaceReviewRow[] {
  return db
    .prepare(
      'SELECT * FROM marketplace_reviews WHERE item_id = ? ORDER BY updated_at DESC',
    )
    .all(itemId) as MarketplaceReviewRow[];
}

export function getReviewStats(itemId: string): { avg: number; count: number } {
  const row = db
    .prepare(
      'SELECT AVG(rating) as avg, COUNT(*) as count FROM marketplace_reviews WHERE item_id = ?',
    )
    .get(itemId) as { avg: number | null; count: number } | undefined;
  return {
    avg: row?.avg ?? 0,
    count: row?.count ?? 0,
  };
}

// ─── Marketplace admin: item create with status + submitted_by ───

export function createMarketplaceItemWithStatus(input: {
  item_type: string;
  name: string;
  description?: string;
  author_name?: string;
  tags?: string[];
  payload: unknown;
  status: MarketplaceStatus;
  submitted_by: string | null;
}): MarketplaceItemRow {
  const id = crypto.randomUUID();
  const now = isoNow();
  db.prepare(
    `INSERT INTO marketplace_items
     (id, item_type, name, description, author_name, tags, payload, installed_count, created_at, updated_at, status, submitted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    input.item_type,
    input.name,
    input.description ?? '',
    input.author_name ?? '',
    JSON.stringify(input.tags ?? []),
    JSON.stringify(input.payload),
    now,
    now,
    input.status,
    input.submitted_by,
  );
  return getMarketplaceItem(id)!;
}

// ─── Agent quota admin ───

export function listUserAgentQuotas(): Array<{
  user_id: string;
  username: string;
  agent_quota: number;
  used: number;
}> {
  return db
    .prepare(
      `SELECT u.id as user_id, u.username, u.agent_quota,
              (SELECT COUNT(*) FROM agent_definitions WHERE user_id = u.id) as used
       FROM users u
       WHERE u.deleted_at IS NULL
       ORDER BY u.username ASC`,
    )
    .all() as Array<{ user_id: string; username: string; agent_quota: number; used: number }>;
}

export function updateUserAgentQuota(userId: string, quota: number): void {
  db.prepare('UPDATE users SET agent_quota = ? WHERE id = ?').run(quota, userId);
}

// ─── Agent version snapshots ───

export interface AgentVersionRow {
  id: string;
  agent_def_id: string;
  version: number;
  snapshot_json: string;
  created_at: string;
  created_by: string | null;
}

export interface AgentSnapshot {
  name: string;
  description: string;
  system_prompt: string;
  model: string | null;
  engine: 'claude' | 'atomcode' | 'codex' | 'opencode' | 'pi';
  avatar_emoji: string | null;
  avatar_color: string | null;
  max_turns: number | null;
  temperature: number | null;
  enabled: boolean;
  mounts: Array<{ resource_type: string; resource_id: string }>;
}

const MAX_VERSIONS_PER_AGENT = 20;

export function saveAgentVersionSnapshot(
  agentDefId: string,
  existing: AgentDefinitionRow,
  mounts: AgentMountRow[],
  createdBy: string | null,
): void {
  const snapshot: AgentSnapshot = {
    name: existing.name,
    description: existing.description,
    system_prompt: existing.system_prompt,
    model: existing.model,
    engine:
      existing.engine === 'atomcode' || existing.engine === 'codex' || existing.engine === 'opencode' || existing.engine === 'pi'
        ? (existing.engine as 'atomcode' | 'codex' | 'opencode' | 'pi')
        : 'claude',
    avatar_emoji: existing.avatar_emoji,
    avatar_color: existing.avatar_color,
    max_turns: existing.max_turns,
    temperature: existing.temperature,
    enabled: existing.enabled === 1,
    mounts: mounts.map((m) => ({ resource_type: m.resource_type, resource_id: m.resource_id })),
  };
  const versionRow = db
    .prepare('SELECT COALESCE(MAX(version), 0) + 1 as next FROM agent_definition_versions WHERE agent_def_id = ?')
    .get(agentDefId) as { next: number };
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO agent_definition_versions (id, agent_def_id, version, snapshot_json, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, agentDefId, versionRow.next, JSON.stringify(snapshot), isoNow(), createdBy);
  // Prune oldest beyond MAX
  const all = db
    .prepare('SELECT id, version FROM agent_definition_versions WHERE agent_def_id = ? ORDER BY version DESC')
    .all(agentDefId) as Array<{ id: string; version: number }>;
  if (all.length > MAX_VERSIONS_PER_AGENT) {
    const stale = all.slice(MAX_VERSIONS_PER_AGENT);
    const del = db.prepare('DELETE FROM agent_definition_versions WHERE id = ?');
    for (const r of stale) del.run(r.id);
  }
}

export function listAgentVersions(agentDefId: string): Array<{
  id: string;
  version: number;
  created_at: string;
  created_by: string | null;
}> {
  return db
    .prepare(
      'SELECT id, version, created_at, created_by FROM agent_definition_versions WHERE agent_def_id = ? ORDER BY version DESC',
    )
    .all(agentDefId) as Array<{
    id: string;
    version: number;
    created_at: string;
    created_by: string | null;
  }>;
}

export function getAgentVersionSnapshot(versionId: string): AgentSnapshot | null {
  const row = db
    .prepare('SELECT snapshot_json FROM agent_definition_versions WHERE id = ?')
    .get(versionId) as { snapshot_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.snapshot_json) as AgentSnapshot;
  } catch {
    return null;
  }
}

// ─── Agent version restore ───

export function restoreAgentVersion(
  agentDefId: string,
  versionId: string,
  userId: string,
): AgentDefinitionRow | null {
  const existing = getAgentDefinition(agentDefId, userId);
  if (!existing) return null;
  const snapshot = getAgentVersionSnapshot(versionId);
  if (!snapshot) return null;
  // Snapshot the *current* state before restoring (gives a way to undo a restore)
  const existingMounts = listAgentMounts(agentDefId);
  saveAgentVersionSnapshot(agentDefId, existing, existingMounts, userId);
  // Rewrite the definition fields from snapshot
  const next: AgentDefinitionRow = {
    ...existing,
    name: snapshot.name,
    description: snapshot.description,
    system_prompt: snapshot.system_prompt,
    model: snapshot.model,
    engine: snapshot.engine,
    avatar_emoji: snapshot.avatar_emoji,
    avatar_color: snapshot.avatar_color,
    max_turns: snapshot.max_turns,
    temperature: snapshot.temperature,
    enabled: snapshot.enabled ? 1 : 0,
    updated_at: isoNow(),
  };
  db.prepare(
    `UPDATE agent_definitions SET name=?, description=?, system_prompt=?, model=?, engine=?, avatar_emoji=?, avatar_color=?, max_turns=?, temperature=?, enabled=?, updated_at=? WHERE id=? AND user_id=?`,
  ).run(
    next.name,
    next.description,
    next.system_prompt,
    next.model,
    next.engine,
    next.avatar_emoji,
    next.avatar_color,
    next.max_turns,
    next.temperature,
    next.enabled,
    next.updated_at,
    agentDefId,
    userId,
  );
  // Also restore mounts: clear current, insert from snapshot
  db.prepare('DELETE FROM agent_mounts WHERE agent_def_id = ?').run(agentDefId);
  for (const m of snapshot.mounts) {
    addAgentMount(agentDefId, m.resource_type, m.resource_id);
  }
  return next;
}

// ─── Agent PaaS Phase 3: Share / Collaborator / Review Report ───

export interface AgentShareRow {
  id: string;
  agent_def_id: string;
  share_token: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  install_count: number;
}

export function createAgentShare(
  agentDefId: string,
  userId: string,
  expiresAt: string | null,
): AgentShareRow {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  db.prepare(
    `INSERT INTO agent_shares (id, agent_def_id, share_token, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, agentDefId, token, userId, expiresAt);
  return getAgentShare(id)!;
}

export function getAgentShare(id: string): AgentShareRow | null {
  const row = db
    .prepare('SELECT * FROM agent_shares WHERE id = ?')
    .get(id) as AgentShareRow | undefined;
  return row ?? null;
}

export function getAgentShareByToken(token: string): AgentShareRow | null {
  const row = db
    .prepare('SELECT * FROM agent_shares WHERE share_token = ?')
    .get(token) as AgentShareRow | undefined;
  return row ?? null;
}

export function listAgentShares(agentDefId: string): AgentShareRow[] {
  return db
    .prepare('SELECT * FROM agent_shares WHERE agent_def_id = ? ORDER BY created_at DESC')
    .all(agentDefId) as AgentShareRow[];
}

export function deleteAgentShare(id: string): boolean {
  const r = db.prepare('DELETE FROM agent_shares WHERE id = ?').run(id);
  return r.changes > 0;
}

export function incrementShareInstall(token: string): void {
  db.prepare('UPDATE agent_shares SET install_count = install_count + 1 WHERE share_token = ?').run(token);
}

export interface AgentCollaboratorRow {
  agent_def_id: string;
  user_id: string;
  role: 'editor' | 'viewer';
  added_by: string;
  added_at: string;
}

export function addAgentCollaborator(
  agentDefId: string,
  userId: string,
  role: 'editor' | 'viewer',
  addedBy: string,
): AgentCollaboratorRow {
  db.prepare(
    `INSERT INTO agent_collaborators (agent_def_id, user_id, role, added_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_def_id, user_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by`,
  ).run(agentDefId, userId, role, addedBy);
  return {
    agent_def_id: agentDefId,
    user_id: userId,
    role,
    added_by: addedBy,
    added_at: new Date().toISOString(),
  };
}

export function removeAgentCollaborator(agentDefId: string, userId: string): boolean {
  const r = db
    .prepare('DELETE FROM agent_collaborators WHERE agent_def_id = ? AND user_id = ?')
    .run(agentDefId, userId);
  return r.changes > 0;
}

export function listAgentCollaborators(agentDefId: string): Array<AgentCollaboratorRow & { username: string | null }> {
  return db
    .prepare(
      `SELECT c.*, u.username FROM agent_collaborators c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.agent_def_id = ? ORDER BY c.added_at DESC`,
    )
    .all(agentDefId) as Array<AgentCollaboratorRow & { username: string | null }>;
}

export function getAgentCollaboratorRole(
  agentDefId: string,
  userId: string,
): 'editor' | 'viewer' | null {
  const row = db
    .prepare('SELECT role FROM agent_collaborators WHERE agent_def_id = ? AND user_id = ?')
    .get(agentDefId, userId) as { role: 'editor' | 'viewer' } | undefined;
  return row?.role ?? null;
}

export interface ReviewReportRow {
  id: string;
  review_id: string;
  reporter_id: string;
  reason: string;
  status: 'pending' | 'dismissed' | 'resolved';
  created_at: string;
  handled_by: string | null;
  handled_at: string | null;
}

export function createReviewReport(
  reviewId: string,
  reporterId: string,
  reason: string,
): ReviewReportRow | null {
  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO marketplace_review_reports (id, review_id, reporter_id, reason)
       VALUES (?, ?, ?, ?)`,
    ).run(id, reviewId, reporterId, reason);
  } catch (err) {
    logger.warn({ err, reviewId, reporterId }, 'createReviewReport failed (likely duplicate)');
    return null;
  }
  const row = db
    .prepare('SELECT * FROM marketplace_review_reports WHERE id = ?')
    .get(id) as ReviewReportRow | undefined;
  return row ?? null;
}

export function listPendingReviewReports(): Array<ReviewReportRow & {
  rating: number;
  comment: string | null;
  item_id: string;
  item_name: string;
  reporter_username: string | null;
}> {
  return db
    .prepare(
      `SELECT r.*, rev.rating as rating, rev.comment as comment, rev.item_id as item_id, m.name as item_name, u.username as reporter_username
       FROM marketplace_review_reports r
       JOIN marketplace_reviews rev ON rev.id = r.review_id
       LEFT JOIN marketplace_items m ON m.id = rev.item_id
       LEFT JOIN users u ON u.id = r.reporter_id
       WHERE r.status = 'pending'
       ORDER BY r.created_at DESC`,
    )
    .all() as Array<ReviewReportRow & {
    rating: number;
    comment: string | null;
    item_id: string;
    item_name: string;
    reporter_username: string | null;
  }>;
}

export function resolveReviewReport(
  reportId: string,
  action: 'dismiss' | 'delete_review',
  handlerId: string,
): boolean {
  const report = db
    .prepare('SELECT review_id FROM marketplace_review_reports WHERE id = ? AND status = ?')
    .get(reportId, 'pending') as { review_id: string } | undefined;
  if (!report) return false;
  if (action === 'delete_review') {
    db.prepare('DELETE FROM marketplace_reviews WHERE id = ?').run(report.review_id);
    // report 会通过 CASCADE 删除，但保险起见再 UPDATE 一次状态（如果没被 CASCADE 删除）
    db.prepare(
      `UPDATE marketplace_review_reports SET status = 'resolved', handled_by = ?, handled_at = datetime('now')
       WHERE id = ?`,
    ).run(handlerId, reportId);
  } else {
    db.prepare(
      `UPDATE marketplace_review_reports SET status = 'dismissed', handled_by = ?, handled_at = datetime('now')
       WHERE id = ?`,
    ).run(handlerId, reportId);
  }
  return true;
}

export function deleteMarketplaceReview(reviewId: string): boolean {
  const r = db.prepare('DELETE FROM marketplace_reviews WHERE id = ?').run(reviewId);
  return r.changes > 0;
}
