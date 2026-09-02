# 技术方案: DeepThink 真正横向多 Pod 无状态化

> 版本: 2.0 | 创建: 2026-09-03

## 1. 架构总览

```
                    ┌──────────────┐
                    │   Ingress     │ (TLS + WebSocket)
                    └──────┬───────┘
                           │
                ┌──────────┴──────────┐
                │   Service (sticky)  │
                └──────────┬──────────┘
                           │
      ┌────────────────────┼────────────────────┐
      │                    │                    │
 ┌────┴────┐         ┌────┴────┐         ┌────┴────┐
 │  Pod-1  │         │  Pod-2  │         │  Pod-N  │
 │ Hono+WS │         │ Hono+WS │         │ Hono+WS │
 │ Agent   │         │ Agent   │         │ Agent   │
 └──┬───┬──┘         └──┬───┬──┘         └──┬───┬──┘
    │   │                │   │                │   │
    │   └────────────────┼───┼────────────────┘   │
    │                    │   │                    │
    │              ┌─────┴───┴──────┐             │
    │              │  Redis Pub/Sub  │             │
    │              │  (事件总线+锁)   │             │
    │              └────────────────┘             │
    │                                              │
    └──────────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │  PostgreSQL (pg)     │
              │  (多写者, 持久化)     │
              └─────────────────────┘
```

## 2. 代码改动清单

### 2.1 Redis 事件总线 (`src/redis-bus.ts` — 新文件)

核心功能:
- `initRedis()` — 初始化 pub/sub 连接
- `publishWsBroadcast(msg, adminOnly, allowedUserIds)` — 发布 WebSocket 广播
- `subscribeWsBroadcast(handler)` — 订阅,收到时转发到本地 wsClients
- `acquireSchedulerLease()` / `releaseSchedulerLease()` — 调度器选主
- `acquireLock(key, ttl)` / `releaseLock(key)` — 通用分布式锁
- `publishAgentIpc(folder, payload)` / `subscribeAgentIpc(folder, handler)` — Agent IPC
- `incrCounter(key, max)` / `decrCounter(key)` — 共享并发计数器
- `closeRedis()` — 优雅关闭

设计原则: **无 Redis 时所有操作退化为 no-op/true**,单进程零影响。

### 2.2 WebSocket 广播改造 (`src/web.ts`)

`safeBroadcast` 拆分为:
- `safeBroadcastLocal(msg, adminOnly, allowedUserIds)` — 仅遍历本地 `wsClients`(原有逻辑)
- `safeBroadcast(msg, adminOnly, allowedUserIds)` — 调 `safeBroadcastLocal` + fire-and-forget `publishWsBroadcast`

`startWebServer` 末尾添加 Redis 初始化 + 订阅:
```typescript
initRedis().then(() => {
  subscribeWsBroadcast((msg, adminOnly, allowedUserIds) => {
    safeBroadcastLocal(msg, adminOnly, allowedUserIds); // 不回发 Redis,避免循环
  });
});
```

`shutdownWebServer` 添加 `await closeRedis()`。

### 2.3 调度器选主 (`src/task-scheduler.ts`)

在 `loop()` 的 shutdown 检查之后、任务处理之前:
```typescript
if (isRedisConnected()) {
  const isLeader = await acquireSchedulerLease();
  if (!isLeader) {
    setTimeout(loop, SCHEDULER_POLL_INTERVAL); // 非 leader,跳过
    return;
  }
}
```

新增 `stopSchedulerLoop()` 释放 lease。index.ts shutdown 中调用。

### 2.4 PostgreSQL 同步桥 (`src/pg-sync-driver.ts` — 新文件)

**核心技术**: worker_threads + Atomics.wait/notify

```
Main Thread                    Worker Thread
─────────────────             ──────────────
querySync(sql, params)         接收 {id, sql, params}
  → postMessage(req)    ───→   pg.Pool.query(sql, params)
  → Atomics.wait(flag)          (async, 不阻塞主线程事件循环外的 worker)
  (阻塞,等待 notify)           
                               postMessage(result)
                               Atomics.notify(flag)
  ← receiveMessage(result) ←── 
  return result
```

`PgDatabase` 类提供 better-sqlite3 兼容 API:
- `prepare(sql)` → 返回 `PgStatement`(get/all/run 同步)
- `exec(sql)` → 翻译 + 执行
- `transaction(fn)` → BEGIN/COMMIT
- `pragma(name)` → 映射到 SET 命令

### 2.5 SQL 翻译器 (`src/sql-translator.ts` — 新文件)

运行时翻译 SQLite SQL → PostgreSQL SQL:

| SQLite | PostgreSQL |
|---|---|
| `?` | `$1, $2, ...` |
| `datetime('now')` | `NOW()` |
| `datetime('now','+1 day')` | `NOW() + INTERVAL '1 day'` |
| `BLOB` | `BYTEA` |
| `REAL` | `DOUBLE PRECISION` |
| `INTEGER PRIMARY KEY` | `BIGSERIAL PRIMARY KEY` |
| `AUTOINCREMENT` | (移除) |
| `LIKE` | `ILIKE` (大小写不敏感) |
| `GROUP_CONCAT(x)` | `STRING_AGG(x, ',')` |
| `INSERT OR REPLACE` | `INSERT INTO` (冲突处理需手动) |
| `PRAGMA` | `SET` 或 no-op |

### 2.6 sqlite-compat.ts 改造

三后端选择:
```typescript
if (usePostgres && !isBun) → PgDatabase (sync driver)
else if (isBun) → bun:sqlite
else → better-sqlite3
```

index.ts `main()` 在 `initDatabase()` 前添加:
```typescript
if (DATABASE_URL.startsWith('postgresql://')) {
  await initPgSyncDriver(DATABASE_URL);
}
```

### 2.7 K8s 多副本清单

| 文件 | 改动 |
|---|---|
| `deployment.yaml` | replicas: 2, RollingUpdate |
| `pvc.yaml` | ReadWriteMany (NFS/CephFS) |
| `hpa.yaml` | min=2, max=10 |
| `configmap.yaml` | REDIS_URL=redis://redis:6379 |
| `secret.yaml.example` | DATABASE_URL + PG credentials |
| `redis.yaml` (新) | Redis Deployment + PVC + Service |
| `postgres.yaml` (新) | PostgreSQL StatefulSet + pgvector |

### 2.8 数据迁移脚本 (`scripts/migrate-sqlite-to-postgres.mjs`)

SQLite → PostgreSQL 一次性迁移:
1. 读取 SQLite schema (sqlite_master)
2. 翻译 CREATE TABLE 到 PostgreSQL
3. 逐表批量插入数据
4. 创建 pgvector 扩展 + 向量索引
5. 创建 tsvector 列 + 触发器(替代 FTS5)
6. 验证行数一致

## 3. 关键设计决策

### 3.1 为什么用 worker_thread 同步桥而不是 async 重写?

401 个 db.ts 函数全部是同步 API。重写为 async 会:
- 改动 401 个函数签名
- 每个调用点需要 await
- 连锁影响所有 route handler(数百个)
- 引入大量 Promise.all 噪音
- 可能引入新的并发 bug

worker_thread 同步桥:
- 零改动 db.ts 的 401 个函数
- Atomics.wait 阻塞主线程,语义与 better-sqlite3 完全一致
- 性能损失:每个查询多一次线程间通信(~0.1ms)

### 3.2 为什么 Redis 退化为 no-op 而不是报错?

- 开发环境(dev 模式)不装 Redis 是常态
- 单机部署仍然有效(PVC + SQLite)
- 渐进式升级:先上 Phase 1(单 Pod),再加 Redis,最后迁 PostgreSQL

## 4. 数据持久化保障

| 数据 | 存储 | 持久化机制 |
|---|---|---|
| 结构化数据 | PostgreSQL | StatefulSet + PVC (RWX) |
| 工作区文件 | PVC (NFS/CephFS) | ReadWriteMany,多 Pod 共享 |
| Redis 状态 | Redis AOF | PVC 持久化 |
| 备份 | CronJob | 每日 03:00 自动备份 |
