# PRD: DeepThink 真正横向多 Pod 无状态化

> 版本: 2.0 | 创建: 2026-09-03 | 状态: draft

## 1. 目标

将 DeepThink 从单进程 + SQLite 架构彻底重构为**真正横向多 Pod 无状态化**:
- 多 Pod 水平扩缩容,Pod 无状态,可随时销毁重建
- 支持大量 C 端用户(1000+ 并发)
- 数据零丢失,服务零中断

## 2. 四大重构方向

### 2.1 Redis Pub/Sub 跨 Pod 事件总线
- WebSocket 广播通过 Redis Pub/Sub 跨 Pod 传播
- `safeBroadcast` 拆分为本地发送 + Redis 发布
- Redis 订阅器接收跨 Pod 消息并转发到本地 wsClients

### 2.2 调度器/IM 分布式锁 + Leader Election
- 调度器通过 Redis lease 选主,只有 leader 执行 task tick
- IM 消息处理通过分布式锁去重
- 单进程模式(无 Redis)退化为内存模式

### 2.3 PostgreSQL 数据库迁移
- SQLite → PostgreSQL,支持多 Pod 并发读写
- 通过 worker_thread + Atomics 同步桥保持 401 个 db.ts 函数的同步 API 不变
- SQL 方言翻译器:运行时 SQLite SQL → PostgreSQL SQL
- sqlite-vec → pgvector,FTS5 → PostgreSQL tsvector

### 2.4 Agent IPC 消息驱动化
- Agent runner 的文件系统 IPC(.json + fs.watch)→ Redis Pub/Sub
- `sendMessage` 通过 Redis 发布,agent runner 通过 Redis 订阅
- 消除对共享文件系统的依赖(Pod 可真正无状态)

## 3. 验收标准

| # | 功能 | 验收标准 |
|---|---|---|
| AC-1 | Redis 事件总线 | `safeBroadcast` 发布到 Redis,订阅器转发到本地,跨 Pod 消息可达 |
| AC-2 | 分布式调度选主 | 多 Pod 同时运行,只有一个 Pod 执行 scheduler tick |
| AC-3 | PostgreSQL 同步桥 | `DATABASE_URL=postgresql://...` 时正常启动,DB 操作同步返回 |
| AC-4 | SQL 翻译 | `? → $1`, `datetime('now') → NOW()`, `BLOB → BYTEA` 等 |
| AC-5 | 单进程退化 | 不设 REDIS_URL/DATABASE_URL 时完全兼容现有行为 |
| AC-6 | 优雅关闭 | SIGTERM → Redis 连接关闭 → exit 0 |
| AC-7 | K8s 多副本 | `kubectl apply -k` 部署 2 replicas + Redis + PostgreSQL |
| AC-8 | 数据迁移脚本 | SQLite → PostgreSQL 数据迁移,行数一致 |
