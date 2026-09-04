# PRD — 全量无状态化 + K8s 部署完成度审计与缺口修复

> 分支：`feat/k8s-stateless-completion`
> 日期：2026-09-04
> 目标：在既有 K8s 云端部署（Phase 1-4 + PG 兼容 + 并发计数器接线 + Phase 3 完成项）之上，做一次彻底的代码级 + 文档级交叉审计，找出仍阻塞「无本地状态、可水平扩缩容、数据持久化」的硬缺口，并落地修复。

## 1. 背景

前期已交付：K8s 清单全栈、Redis 事件总线、分布式调度器选主、PG 同步桥、共享并发计数器、Agent IPC Redis 化（mcp-bridge）、Agent Runner 独立 Service、trace-io 对象存储、pgvector/pg_trgm、Litestream、Velero 灾备、FTS5/vec0 后端分支、PG 新库快速路径。

本次审计派出 3 个后台探针（任务状态文档/issue、运行时本地状态残留、PG 数据层与 sql-translator），交叉核对源码实况与文档声明，发现 6 项代码级硬缺口 + 若干文档级矛盾。

## 2. 审计结论（完成情况清单）

### ✅ 已完成并交叉验证
1. K8s 清单全栈（namespace/configmap/secret/pvc/deployment/service/ingress/hpa/backup-cronjob/agent-runner/kustomization）
2. Redis 事件总线 + WS 跨 Pod 广播（redis-bus.ts safeBroadcast）
3. 分布式调度器选主（task-scheduler.ts acquireSchedulerLease，kind 三大验证通过）
4. PG 同步桥架构（pg-sync-driver.ts worker_threads + MessageChannel + receiveMessageOnPort，死锁已修）
5. 共享并发计数器接线（incrUserActive/decrUserActive + mirror，commit 13cca68；文档级 issue 旧称「未接线」是合并前状态，代码实况已接线）
6. Agent IPC Redis 化（mcp-bridge.ts，codex/opencode 引擎）
7. Agent Runner 独立 Deployment + Headless + HPA + 共享 PVC + workspace 动态解析
8. trace-io 对象存储（object-store.ts fs/s3 双后端对称）
9. pgvector 向量搜索 + 优雅降级线性扫描
10. pg_trgm（FTS5→PG 全文，ILIKE + GIN）
11. Litestream sidecar（SQLite 模式 WAL 备份）
12. Velero 灾备 schedule + DR_RUNBOOK
13. Backup CronJob 分支化（PG pg_dump / SQLite .backup）
14. FTS5 / sqlite-vec 后端分支（PG 不创建 FTS5、不加载 vec0）
15. PG 新库快速路径（schema_version=59 跳过迁移）

### ❌ 本次发现并修复的硬缺口

**Tier A — PG 数据层致命缺口（PG 模式无法支撑生产消息流）**
- A1. `INSERT OR REPLACE` 被翻译成 `ON CONFLICT DO NOTHING`（静默跳过更新）→ 消息写入 `storeMessageInsert`（db.ts:104）draft→finalize 不更新；游标持久化 `setRouterState`（db.ts:5432）每批同 key 更新被跳过→游标冻结→消息重复处理。另含 chats/registered_groups/user_pinned_groups/mcp_registry_tokens 共 ~8 处。
- A2. `lastInsertRowid` PG 下恒为 0（worker 对无 RETURNING 的 INSERT 返回空 rows）→ db.ts:3495/4166/4224/5083/8956（定时任务日志/循环迭代/节点锁/计费事务）后续 UPDATE 错行。
- A3. `date(col,'localtime')` 不翻译 → 开放平台用量 `getOpenPlatformUsage`（db.ts:10182）PG 下报错。

**Tier B — 水平扩缩容功能性阻塞**
- B1. IM 连接无 leader 选举（index.ts:12033-12199，每 Pod 连所有用户 IM）→ 重复收消息 / Telegram getUpdates 抢消费 / WhatsApp 多设备封号。头号阻塞。
- B2. Claude 引擎 mcp-tools.ts IPC 无 Redis 分支（mcp-bridge.ts 已修，mcp-tools.ts 漏修）→ 无共享 PVC 时 send_message / 任务请求丢失 + 超时。
- B3. 周期任务未 leader 门控（index.ts:11539-11627，session 清理 / billing expire / reconcileMonthlyUsage 全 Pod 并发，计费 reconcile 有重复统计风险）。

### ⏸ 本次不推进（独立大改 / 需云凭证）
- Tier C — 本地文件作真值源（记忆/Skills 运行时内容/MCP server 配置/WhatsApp baileys auth/embedding 配置/工作区产物与文件上传）：共享 RWX PVC 下可工作（持久化 + 多 Pod 共享达标），全量迁 DB / 对象存储是独立大改，后续单独推进。
- Tier D — 真实云集群 `kubectl apply -k` 端到端：PRD 明确列为非本地可完成（需云凭证）。本次以真实 PG + 真实 Redis 的代码级端到端验证替代。

## 3. 验收标准（AC）

- AC-A1：`INSERT OR REPLACE INTO {messages|router_state|chats|registered_groups|user_pinned_groups|mcp_registry_tokens}` 在 PG 下翻译为带正确冲突列的 `ON CONFLICT(pk) DO UPDATE SET`；真实 PG 验证 messages draft→finalize 真更新、router_state 同 key 游标真推进。
- AC-A2：PG 下 `INSERT` 返回真实自增 `lastInsertRowid`（非 0）；真实 PG 验证返回的 id 可回查行。
- AC-A3：`getOpenPlatformUsage` 形态查询（含 `AS date` 别名 + `ORDER BY date`）在 PG 下无报错并正确分组。
- AC-B1：真实 Redis 下 IM-leader CAS——仅一个 token 持有 lease；非 owner 无法释放；TTL 过期后另一 token 接管（failover）。
- AC-B2：mcp-tools.ts 分布式模式 send_message 走 Redis 发布到 `deepthink:ipc-out:{folder}:messages`；任务请求走 `:tasks` + `deepthink:ipc-task:{folder}:{requestId}` 回应，channel 与 web-server 订阅端一致。
- AC-B3：真实 Redis 下 `withOwnership` 同 key N 并发仅 1 个执行 fn。
- AC-NO-REG：SQLite smoke 102/102 通过，零回归；后端 + agent-runner tsc exit 0。
