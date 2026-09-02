# PRD: DeepThink 平台 K8s 云端部署与数据持久化改造

> 版本: 1.0 | 创建: 2026-09-02 | 状态: draft

## 1. 背景与目标

### 1.1 现状

DeepThink 当前是一个**单进程 + 单机部署**的 Agent 平台:
- Web 服务(Hono)运行在单进程,PM2/watchdog 守护
- 数据库:单 SQLite 文件(`messages.db`,59 张表,WAL 模式)
- Agent 执行:`child_process.spawn` 启动 Docker 容器或宿主机进程
- 状态管理:全在进程内存(GroupQueue、wsClients、ProcessingLock、Scheduler)
- 文件存储:本地磁盘(`~/.deepthink/data/` 下 groups/sessions/trace-io/skills/memory 等)
- 无 K8s 部署清单、无健康检查端点、无 Dockerfile(仅 agent 容器有)

### 1.2 目标

将 DeepThink 部署到 K8s 云端,支持大量 C 端用户:
1. **弹性扩缩容** — 流量高峰自动扩容,低谷自动缩容
2. **数据持久化** — Pod 重建/迁移后数据零丢失
3. **高可用** — 单 Pod 故障不影响服务
4. **生产级** — 健康检查、优雅关闭、配置管理、日志聚合

### 1.3 核心约束

- 不破坏现有单机开发体验(dev 模式照常跑)
- 不引入过度复杂的中间件(遵循 Simplicity First)
- 改动必须是外科手术式的(Surgical Changes)

## 2. 架构设计

### 2.1 整体架构

```
                        ┌─────────────┐
                        │  Ingress     │
                        │  (TLS/WS)    │
                        └──────┬──────┘
                               │
                    ┌──────────┴──────────┐
                    │   Service (ClusterIP) │
                    │   + Sticky Sessions   │
                    └──────────┬──────────┘
                               │
           ┌───────────────────┼───────────────────┐
           │                   │                   │
    ┌──────┴──────┐     ┌──────┴──────┐     ┌──────┴──────┐
    │  Pod-1      │     │  Pod-2      │     │  Pod-N      │
    │  Web Server │     │  Web Server │     │  Web Server │
    │  (Hono)     │     │  (Hono)     │     │  (Hono)     │
    │  + Agent    │     │  + Agent    │     │  + Agent    │
    └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
           │                   │                   │
           └───────────────────┼───────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │   Shared Storage     │
                    │                      │
                    │  ┌────────────────┐ │
                    │  │  PVC (RWM)      │ │
                    │  │  /data          │ │
                    │  │  SQLite + files │ │
                    │  └────────────────┘ │
                    │  ┌────────────────┐ │
                    │  │  Redis          │ │
                    │  │  (pub/sub+lock) │ │
                    │  └────────────────┘ │
                    └─────────────────────┘
```

### 2.2 分层策略

| 层 | 方案 | 说明 |
|---|---|---|
| **接入层** | Ingress + TLS + WS 透传 | 支持 WebSocket upgrade,sticky session |
| **计算层** | Deployment + HPA | 无状态 Web Pod 可水平扩缩容 |
| **状态层** | Redis (pub/sub + 分布式锁) | WebSocket 广播、调度器选主、并发锁 |
| **数据层** | PVC (ReadWriteMany) | SQLite + 文件系统,持久化卷 |
| **Agent 执行** | 同 Pod 内 spawn (Phase 1) / 独立 Worker Pod (Phase 2) | |

### 2.3 分阶段实施

#### Phase 1: 单副本可部署 (MVP — 本次实施重点)
- K8s 部署清单(Deployment/Service/Ingress/PVC/ConfigMap/Secret)
- Web 服务 Dockerfile
- 健康检查端点(`/health`、`/ready`)
- 优雅关闭(SIGTERM handler)
- PVC 挂载,数据持久化
- 环境变量配置外部化
- HPA 配置(基于 CPU/内存)

#### Phase 2: 多副本弹性扩缩容 (设计 + 关键代码)
- Redis 集成:WebSocket pub/sub 跨 Pod 广播
- 分布式锁:调度器选主(Redis lease)
- 数据库抽象层:支持 SQLite(开发) / PostgreSQL(生产)
- Session 共享:Redis session store
- Agent 执行:独立 Worker Deployment

#### Phase 3: 全自主闭环 (未来)
- PostgreSQL 完整迁移(pgvector 替代 sqlite-vec)
- MinIO/S3 对象存储(大文件 trace-io、downloads)
- Litestream WAL 实时备份
- 多集群灾备

## 3. 功能需求与验收标准

### 3.1 健康检查端点

**需求**: 添加 `/health`(liveness)和 `/ready`(readiness)HTTP 端点

**验收标准**:
- [ ] `GET /health` 返回 200 + `{"status":"ok"}`,不需要认证
- [ ] `GET /ready` 返回 200 当数据库可读写,503 当不可用
- [ ] `/health` 响应时间 < 50ms
- [ ] 不影响现有路由

### 3.2 Web 服务 Dockerfile

**需求**: 构建包含后端 + 前端 + agent-runner 的生产镜像

**验收标准**:
- [ ] `docker build -t deepthink-server:latest .` 成功
- [ ] 镜像包含 `dist/`(后端)、`web/dist/`(前端)、`container/agent-runner/dist/`(agent runner)
- [ ] 镜像运行时 `WEB_PORT=9999 node dist/index.js` 正常启动
- [ ] 非 root 用户运行
- [ ] 镜像大小 < 800MB

### 3.3 K8s 部署清单

**需求**: 完整的 K8s 资源清单,支持一键部署

**验收标准**:
- [ ] `kubectl apply -f deploy/k8s/` 成功部署所有资源
- [ ] Pod 启动后 `/health` 返回 200
- [ ] PVC 挂载到 `/data`,数据持久化(Pod 删除重建后数据仍在)
- [ ] Ingress 正确路由 HTTP + WebSocket
- [ ] Secret 正确注入环境变量(WEB_SESSION_SECRET、API keys 等)
- [ ] HPA 基于 CPU > 70% 自动扩容

### 3.4 优雅关闭

**需求**: Pod 收到 SIGTERM 时优雅关闭

**验收标准**:
- [ ] 收到 SIGTERM 后停止接受新请求
- [ ] 等待进行中的 agent 任务完成(最长 60s)
- [ ] 关闭 WebSocket 连接并通知客户端
- [ ] 关闭数据库连接
- [ ] 在 terminationGracePeriodSeconds(120s)内退出

### 3.5 数据持久化

**需求**: 所有用户数据在 Pod 重建后不丢失

**验收标准**:
- [ ] `data/db/` (SQLite) 在 PVC 上
- [ ] `data/groups/` (工作区) 在 PVC 上
- [ ] `data/sessions/` 在 PVC 上
- [ ] `data/memory/` 在 PVC 上
- [ ] `data/config/` 在 PVC 上
- [ ] `data/skills/` 在 PVC 上
- [ ] `data/trace-io/` 在 PVC 上
- [ ] Pod 删除重建后,用户数据、会话历史、记忆、技能全部保留

### 3.6 数据库抽象层 (Phase 2 关键代码)

**需求**: 抽象数据库访问,支持 SQLite 和 PostgreSQL 双后端

**验收标准**:
- [ ] 定义 `DatabaseAdapter` 接口(query/all/run/prepare)
- [ ] SQLiteAdapter 保持现有行为(向后兼容)
- [ ] PostgreSQLAdapter 支持 pg 模块(async)
- [ ] 通过 `DATABASE_URL` 环境变量选择后端
- [ ] 不设 `DATABASE_URL` 时默认 SQLite,不影响现有行为

### 3.7 Redis 状态共享 (Phase 2 设计)

**需求**: 提取进程内状态到 Redis,支持多副本

**验收标准**:
- [ ] WebSocket 广播通过 Redis pub/sub
- [ ] 调度器通过 Redis lease 选主
- [ ] GroupQueue 并发计数通过 Redis 原子操作
- [ ] 不设 `REDIS_URL` 时退回单进程内存模式

## 4. 非功能需求

| 指标 | 目标 |
|---|---|
| Pod 启动时间 | < 30s |
| 健康检查延迟 | < 50ms |
| 单 Pod 并发用户 | 100+ WebSocket |
| HPA 扩容响应 | < 2min |
| 数据持久化 RPO | 0 (PVC 即时写入) |
| 优雅关闭超时 | 120s |

## 5. 测试用例

| 编号 | 用例 | 步骤 | 预期 |
|---|---|---|---|
| TC-01 | 健康检查 | curl /health, /ready | 200, JSON |
| TC-02 | Docker 构建 | docker build | 镜像生成成功 |
| TC-03 | K8s 部署 | kubectl apply | Pod Running |
| TC-04 | PVC 持久化 | 写数据→删Pod→重建 | 数据存在 |
| TC-05 | WS 路由 | Ingress WS upgrade | WS 连接成功 |
| TC-06 | 优雅关闭 | kubectl delete pod | 60s内退出,无报错 |
| TC-07 | HPA 扩容 | 压测CPU>70% | Pod 数增加 |
| TC-08 | 登录功能 | POST /api/auth/login | 登录成功 |
| TC-09 | 发消息 | Web UI 发消息 | Agent 响应 |
| TC-10 | 数据库抽象 | 设 DATABASE_URL | 正常切换 |
