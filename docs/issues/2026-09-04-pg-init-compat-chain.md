# 2026-09-04 PG 模式 initDatabase 启动链路 8 连环兼容性阻塞

## 1. 用户现象
DeepThink Web 服务以 PostgreSQL 后端部署到 K8s(kind) 时，`deepthink` Pod 持续 `CrashLoopBackOff`，无法进入 Ready。日志每次停在 `Failed to start deepthink`，错误码在 PG 方言错误之间逐个跳变(42P01 / 42704 / 42703 / 42601 / 23505 / 42883 / TypeError)。

## 2. 问题描述
代码库以 better-sqlite3 同步 API 为假设编写(401 个 db.ts 函数)，PG 模式通过 `sqlite-compat.ts` + `pg-sync-driver.ts`(worker_threads + Atomics 同步桥)保留同步语义，SQL 方言差异由 `sql-translator.ts` 运行时翻译。但 `initDatabase()` 的 schema 建表 + 幂等迁移链路密集使用 SQLite 专有语法，翻译器此前只覆盖了部分场景，导致 cold-start 逐行触发 PG 报错。

## 3. 根因(8 个连环阻塞，逐个定位)

| # | 错误 | 根因 | 代码位置 |
|---|------|------|---------|
| 1 | `42P01 relation "users" does not exist` | CREATE TABLE 含前向 `FOREIGN KEY ... REFERENCES users(id)`，但 users 表后建。PG 在 parse 阶段强制 FK 目标表存在；`SET session_replication_role='replica'` 只禁用 FK **触发器**(DML 时)，不禁用 parse 阶段检查 | `sql-translator.ts translateCreateTable` |
| 2 | `42704 type "blob" does not exist` | `ensureColumn` 走 `ALTER TABLE ADD COLUMN ... BLOB`，BLOB→BYTEA 映射只在 translateCreateTable(CREATE 专用)里，ALTER 路径未覆盖 | `sqlite-compat.ts PgDatabase.exec` |
| 3 | `column "embedding" already exists`(42701) | `PRAGMA table_info` 被翻译器跳过→`hasColumn` 永远返回 false→重复 ALTER | `sql-translator.ts` |
| 4 | `42P01 relation "sqlite_master" does not exist` | 迁移查询 `sqlite_master` 系统表，PG 无此表 | `sql-translator.ts` |
| 5 | `TypeError: db.transaction(...) is not a function` | `db.transaction(fn)()` IIFE 惯用法，PgDatabase.transaction 直接执行返回 void→`void()` | `sqlite-compat.ts PgDatabase.transaction` |
| 6 | `42601 syntax error at or near "OR"` | `INSERT OR IGNORE` 未翻译 | `sql-translator.ts` |
| 7 | `42883 function json_extract does not exist` | v27→v28 迁移用 json_extract/json_each，PG 无此函数；且 fresh 库 schema_version 末尾才写，迁移误跑 | `db.ts` 迁移链 + schema_version 时序 |
| 8 | `23505 duplicate key`(router_state_pkey) + setup 500 `reading 'ok'` | `INSERT OR REPLACE` 撞提前写入的行；`db.transaction(fn)` 包装器未 `return` fn 结果 | `sql-translator.ts` + `sqlite-compat.ts` |

## 4. 复现路径
```bash
# 1. kind 集群 + 应用清单(secret 用 secret.yaml.example)
kind create cluster --name deepthink
kubectl apply -k deploy/k8s-kind/        # overlay: PVC RWO
kubectl apply -f deploy/k8s/secret.yaml.example
kind load docker-image deepthink-server:latest --name deepthink
# 2. 修复前: pod CrashLoopBackOff
kubectl -n deepthink logs deploy/deepthink | grep ERROR
# → 逐个出现 42P01→42704→...→23505 链
```

## 5. 诊断方法
```bash
# 看 initDatabase 走到哪步崩
kubectl -n deepthink logs deploy/deepthink --previous | grep -A3 ERROR | head
# 查 PG 表/数据是否落盘
kubectl -n deepthink exec postgres-0 -- psql -U deepthink -d deepthink \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
kubectl -n deepthink exec postgres-0 -- psql -U deepthink -d deepthink -c "SELECT * FROM users;"
# 注意:host 9999 若被 prod 占用,port-forward 会静默失败打到你以为是 kind 的 prod
ss -tlnp | grep 9999   # 确认端口归属
kubectl port-forward svc/deepthink 19999:9898   # 用 19999 避免撞 prod
```

## 6. 修复方案

### `src/sql-translator.ts` — translateCreateTable 剥离 FK
```diff
 export function translateCreateTable(sql: string): string {
   let result = translateSqliteToPg(sql);
+  // 剥离 FOREIGN KEY 子句(PG parse 阶段强制目标表存在,SQLite 容忍前向引用)
+  result = result.split('\n').filter(l => !/^\s*FOREIGN KEY\b/i.test(l)).join('\n');
+  result = result.replace(/,\s*\)/g, ')');  // 清理悬空逗号
+  result = result.replace(/,\s*,/g, ',');
   result = result.replace(/\bBLOB\b/gi, 'BYTEA');
   ...
 }
```

### `src/sql-translator.ts` — PRAGMA table_info / sqlite_master / INSERT OR IGNORE 翻译
- `PRAGMA table_info(t)` → `SELECT column_name AS name, 0 AS pk FROM information_schema.columns WHERE table_name='t' AND table_schema=current_schema()`
- `SELECT sql FROM sqlite_master WHERE type='table' AND name='t'` → 聚合 `pg_constraint` CHECK 定义
- `FROM sqlite_master WHERE type='index'...` → `FROM pg_indexes WHERE ...`
- `INSERT OR {IGNORE,REPLACE} INTO` → `INSERT INTO ... ON CONFLICT DO NOTHING`

### `src/sqlite-compat.ts` — exec 补类型映射 + transaction 返回包装函数
```diff
 exec(sql) {
-  const pgSql = isCreate ? translateCreateTable(sql) : translateSqliteToPg(sql);
+  if (isCreate) pgSql = translateCreateTable(sql);
+  else { pgSql = translateSqliteToPg(sql);
+         pgSql = pgSql.replace(/\bBLOB\b/gi,'BYTEA').replace(/\bREAL\b/gi,'DOUBLE PRECISION'); }
 ...
-transaction(fn) { BEGIN; fn(); COMMIT; }   // 直接执行返回 void
+transaction(fn) { return (...args) => { BEGIN; const r = fn(...args); COMMIT; return r; }; }  // 返回可调用包装,匹配 db.transaction(fn)() 和 const tx=db.transaction(fn); tx(arg)
```

### `src/db.ts` — PG fresh 库提前写 schema_version
```diff
+if (isPostgresBackend) {
+  if (!getRouterStateInternal('schema_version'))
+    db.prepare('INSERT OR REPLACE INTO router_state (key,value) VALUES (?,?)').run('schema_version','59');
+}
```
fresh PG schema 已是 v59,版本门控迁移(< 15/17/24/27/28…)全跳过,避免 json_extract 迁移报错。

### `src/pg-sync-driver.ts` — worker pool max:1
```diff
-const pool = new pg.Pool({ connectionString, max: 10, statement_timeout: 30000 });
+const pool = new pg.Pool({ connectionString, max: 1, idleTimeoutMillis: 0, statement_timeout: 30000 });
```

### `deploy/docker/Dockerfile.server` — 补 agent-runner prompts COPY
```diff
+COPY container/agent-runner/prompts ./container/agent-runner/prompts
```

### `deploy/k8s-kind/kustomization.yaml` — kind overlay(PVC RWO)
新建,base 在 `deploy/k8s/`。

## 7. 处理卡住的状态
Pod CrashLoopBackOff 且日志看不到新错误时:确认 port-forward 是否真绑上(host 9999 常被 prod 占用,`kubectl port-forward` 静默 fallback 到 prod,制造"PG 有数据"假象)。`ss -tlnp | grep 9999` 确认,改用 19999 端口。

## 8. 经验沉淀 / 预防
1. **翻译器覆盖矩阵**:SQLite→PG 翻译需覆盖 `CREATE TABLE`(FK/类型)、`ALTER TABLE`(类型)、`PRAGMA table_info`、`sqlite_master`、`INSERT OR IGNORE/REPLACE`、`transaction` 语义、`json_extract`(暂以 fresh 库跳过规避)。新增 schema 时跑 `npx tsc && docker build && kind apply` cold-start 冒烟。
2. **多 Pod init 竞态**:两副本同时建 73 表会偶发冲突重启,最终一致(1/1)。生产应加 init Job 或 leader 选举做一次性 schema 初始化。
3. **端口归属校验**:port-forward 必须检查 bind 日志,否则打到 prod 制造假象。
4. **schema_version 时序**:fresh 库应在建表后立即写版本号,避免幂等迁移误跑。
5. **agent-runner 运行时资源**:Dockerfile 别只 COPY dist,prompts/skills 等运行时读取的资源也要 COPY。
