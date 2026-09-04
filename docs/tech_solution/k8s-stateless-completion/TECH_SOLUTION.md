# 技术方案 — K8s 全量无状态化缺口修复

> 分支 `feat/k8s-stateless-completion`，在 main（031a7cd）+ 工作树未提交 PG-compat WIP 基线上推进。

## 1. 基线说明

审计发现 `~/deepthink` 工作树有 4 个文件（db.ts / pg-sync-driver.ts / sql-translator.ts / sqlite-compat.ts）的未提交 PG-compat 改进（FK 剥离、sqlite_master→pg catalog、PRAGMA table_info 翻译、INSERT OR REPLACE→ON CONFLICT DO NOTHING）。本分支先将该 WIP 作为 baseline 提交（commit b3c09ed），再在其上叠加修复。审计基于该 WIP 状态，故「以代码实况为准」。

## 2. Tier A — PG 数据层三大缺口

### A1. INSERT OR REPLACE → 真 ON CONFLICT(pk) DO UPDATE

**根因**：`sql-translator.ts` 把 `INSERT OR REPLACE` 统一翻成 `ON CONFLICT DO NOTHING`。`OR REPLACE` 语义是 upsert（替换整行），`DO NOTHING` 会让冲突时静默跳过更新——消息草稿不转正、游标不推进。

**方案**（`src/sql-translator.ts`）：
- 新增 `UPSERT_CONFLICT_TARGETS` 注册表，记录各表的冲突列（PK/UNIQUE）：
  - `messages`→`(id, chat_jid)`、`router_state`→`(key)`、`chats`→`(jid)`、`registered_groups`→`(jid)`、`user_pinned_groups`→`(user_id, jid)`、`mcp_registry_tokens`→`(user_id)`。
- 新增 `translateInsertOrReplace(sql)`：匹配单行 `INSERT OR REPLACE INTO t (cols) VALUES (...)`，查注册表得冲突列，生成 `INSERT INTO t (cols) VALUES (...) ON CONFLICT (pk) DO UPDATE SET <非冲突列>=excluded.<列>`。
- 回退路径（零回归）：`OR IGNORE` → `ON CONFLICT DO NOTHING`（语义正确）；未知表 / 无列列表 / 多行 → `ON CONFLICT DO NOTHING`（旧行为）。
- SET 列只取 INSERT 列列表中非冲突列（匹配 SQLite「替换整行」语义）。

### A2. lastInsertRowid → RETURNING * + 数字强转

**根因**：`pg-sync-driver.ts` worker 对无 `RETURNING` 的 INSERT 返回空 rows → `lastInsertRowid=undefined→0`。

**方案**（`src/pg-sync-driver.ts` worker 脚本）：
- worker 收到 SQL 后，若 `^\s*INSERT` 且不含 `RETURNING`，自动附加 ` RETURNING *`（已含 RETURNING 或 WITH-CTE 不动；`ON CONFLICT DO NOTHING/UPDATE` 与 RETURNING 可组合）。
- pg 返回 BIGINT 列为字符串（JS Number 不能容 >2^53）；better-sqlite3 返回 Number。新增数字强转：`rawLid` 为全数字字符串时 `Number(rawLid)`，否则原样（TEXT PK 不变）。
- **坑**：worker 脚本是模板字面量，内嵌正则的 `\d` 会被模板吃掉变 `d`，必须写 `\\d`（同理 `\\s`/`\\b`）。

### A3. date(col,'localtime') → substr

**根因**：PG 无 `date(text,'localtime')` 形态，`getOpenPlatformUsage`（db.ts:10182）PG 下报错。

**方案**（`src/sql-translator.ts`）：翻译 `date(X,'localtime')` → `substr(X,1,10)`。created_at 等列存 ISO-8601 文本，`substr` 取前 10 位 `YYYY-MM-DD`，两后端行为一致，GROUP-BY 日期足够。单参 `date(col)` 不动（PG 接受）。

## 3. Tier B — 水平扩缩容三大阻塞

### B1. IM 连接分布式 leader 选举

**根因**：`index.ts:12033-12199` 启动时每个 Pod 都为所有 active 用户连 IM（Feishu/Telegram/QQ/WeChat/DingTalk/Discord/WhatsApp）→ 重复收消息、Telegram getUpdates 抢消费、WhatsApp 多设备封号。无 leader 门控（对比 task-scheduler 有）。

**方案**：
- `src/redis-bus.ts` 新增 token-CAS 归属原语（Lua compare-and-swap，跨 Pod 安全，修旧 `acquireLock` 用 `process.pid` 不唯一跨 Pod 的缺陷）：
  - `acquireOwnership(key, token, ttlMs)`：SET NX PX。
  - `renewOwnership(key, token, ttlMs)`：Lua CAS 续租（仅 owner 成功）。
  - `releaseOwnership(key, token)`：Lua CAS 释放。
  - `withOwnership(key, ttlMs, fn)`：acquire→fn→release，供周期任务用。
- `index.ts` IM 连接段加 IM-leader lease 门控（`deepthink:im-leader`，TTL 30s）：仅 leader Pod 跑连接循环；10s 续租循环，失联则 `imManager.disconnectAllUserChannels` 断接所有用户 + 清 feishuSyncInterval。
- 无 Redis（单进程）`acquireOwnership` 恒 true → leader 恒 true → 零回归。
- 接管：前任 leader 死亡后 lease 30s 过期，新 Pod（K8s 重启或已运行的新启动）于启动时 acquire 接管。

**已知限制（设计取舍）**：单 leader 模型——所有 IM 摄入经 leader Pod。IM 接收轻量、agent 执行已分布式，正确性优先于 IM 吞吐散布。per-user 分片散布是后续优化。

### B2. Claude 引擎 mcp-tools.ts Redis IPC

**根因**：`container/agent-runner/src/mcp-tools.ts` `writeIpcFile` 无 Redis 分支（mcp-bridge.ts 已有）→ 分布式模式无共享 PVC 时 send_message/任务请求写本地 agent-runner Pod，web-server Pod 看不见→全部丢失 + 超时。

**方案**（`container/agent-runner/src/mcp-tools.ts`）：镜像 mcp-bridge 的 Redis bridge——
- `initRedisBridge` / `redisPublishMessage` / `redisRequestTask`，发布到 web-server 已订阅的同一 channel：`deepthink:ipc-out:{folder}:messages`（send_message，fire-and-forget）与 `:tasks`（任务请求 + `deepthink:ipc-task:{folder}:{requestId}` 回应）。
- `_activeGroupFolder` 从 `createMcpTools(ctx)` 捕获（agent-runner 每 group 一进程，稳定）。
- `writeIpcFile`：`path.basename(dir)==='messages'` 走 Redis；`pollIpcResult`：`_redisConnected` 走 Redis request/response。
- 无 Redis 文件 IPC 路径不变。

### B3. 周期任务 leader 门控

**根因**：`index.ts:11539-11627` 5 个 `setInterval`（清 session / 清 agents / billing expire / reconcileMonthlyUsage / cleanup-billing）全 Pod 并发；reconcileMonthlyUsage 有重复统计风险。

**方案**：5 个回调各用 `withOwnership('deepthink:periodic:<task>', ttl, fn)`（每任务独立 key + token CAS 锁），仅一个 Pod 每周期执行。无 Redis 恒执行（单进程不变）。

## 4. 验证策略

- Tier A：翻译器单元（10/10）+ 真实 PG（pgvector:pg16）集成（11/11）。
- Tier B：真实 Redis（redis:7-alpine）CAS 原语（11/11）。
- 回归：SQLite smoke 102/102；后端 + agent-runner tsc exit 0。
- Tier D 真实云集群 `kubectl apply -k` 全链路：需云凭证，本次不做（PRD 非目标）。

## 5. 影响面 / 风险

- `sql-translator.ts`：仅对注册表内 6 表的 `INSERT OR REPLACE` 行为变化（DO NOTHING→真 upsert），其余 OR REPLACE / OR IGNORE / 未知表回退旧行为。SQLite 路径完全不经过翻译器，零影响。
- `pg-sync-driver.ts`：对所有 PG INSERT 附加 RETURNING *——`.run()` 调用方忽略 rows，无影响；已含 RETURNING 的语句不动。
- `redis-bus.ts`：新增导出函数，不改既有行为。
- `index.ts`：IM 段加门控 + 续租循环；周期任务加锁。无 Redis 恒 leader / 恒执行，单进程部署行为不变。
- `mcp-tools.ts`：无 Redis 文件 IPC 不变。
