# 技术方案: DeepThink K8s 云端部署与数据持久化

> 版本: 1.0 | 创建: 2026-09-02 | 状态: draft

## 1. 现状架构分析

### 1.1 数据存储现状

| 数据类别 | 存储方式 | 位置 | 云部署问题 |
|---|---|---|---|
| 结构化数据(59表) | SQLite(better-sqlite3) | `data/db/messages.db` | 多 Pod 同时写→损坏 |
| 工作区产物 | 本地文件 | `data/groups/{folder}/` | Pod 重建后丢失 |
| 会话产物 | 本地文件 | `data/sessions/{folder}/` | Pod 重建后丢失 |
| 大对象 I/O | 本地文件 | `data/trace-io/` | Pod 重建后丢失 |
| 记忆 | 本地文件 | `data/memory/` + `data/groups/*/CLAUDE.md` | Pod 重建后丢失 |
| 技能 | 本地文件 | `data/skills/{userId}/` | Pod 重建后丢失 |
| MCP 配置 | 本地文件 | `data/mcp-servers/` | Pod 重建后丢失 |
| 运行时配置 | 本地文件 | `data/config/` | Pod 重建后丢失 |
| 向量索引 | sqlite-vec | 同 `messages.db` | — |
| 全文索引 | FTS5 | 同 `messages.db` | — |

### 1.2 进程内状态(无状态化障碍)

| 状态 | 位置 | 作用 | 多 Pod 后果 |
|---|---|---|---|
| `GroupQueue` | `src/group-queue.ts` | Agent 并发调度,计数器 | 计数溢出,重复调度 |
| `wsClients` Map | `src/web.ts:1210` | WebSocket 连接表 | 广播不全,跨 Pod 消息丢失 |
| `ProcessingLock` | `src/im-safety/` | IM 消息去重锁 | 重复处理 |
| `Scheduler` | `src/task-scheduler.ts` | 60s 轮询定时任务 | 同一任务多 Pod 重复执行 |
| `SandboxManager` | `src/sandbox/manager.ts` | Docker 沙箱单例 | 沙箱跨 Pod 不可达 |

### 1.3 关键依赖路径

```
config.ts (DATA_DIR/GROUPS_DIR/STORE_DIR 常量)
  → db.ts (initDatabase → better-sqlite3 open)
  → web.ts (startWebServer → Hono + WS)
  → index.ts (main → init → serve)
  → container-runner.ts (spawn Docker/host agent)
  → group-queue.ts (GroupQueue 调度)
```

## 2. 技术方案

### 2.1 Phase 1: 单副本可部署 (本次实施)

#### 2.1.1 健康检查端点

**改动文件**: `src/web.ts`

在 Hono app 的路由注册前添加两个公开端点:

```typescript
// Liveness probe — 进程存活即返回 200
app.get('/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

// Readiness probe — 检查数据库可读写
app.get('/ready', (c) => {
  try {
    // dbHealthy: 尝试一个轻量查询
    const ok = checkDbReady();
    if (ok) return c.json({ status: 'ready', timestamp: Date.now() });
    return c.json({ status: 'not-ready' }, 503);
  } catch {
    return c.json({ status: 'not-ready' }, 503);
  }
});
```

`checkDbReady()` 在 `db.ts` 导出:
```typescript
export function checkDbReady(): boolean {
  try {
    db!.prepare('SELECT 1').get();
    return true;
  } catch { return false; }
}
```

K8s probe 配置:
```yaml
livenessProbe:
  httpGet: { path: /health, port: 9898 }
  initialDelaySeconds: 15
  periodSeconds: 30
readinessProbe:
  httpGet: { path: /ready, port: 9898 }
  initialDelaySeconds: 5
  periodSeconds: 10
```

#### 2.1.2 优雅关闭

**改动文件**: `src/index.ts`

现有代码已有 SIGTERM/SIGINT handler(行 10762),需增强:

```typescript
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, starting graceful shutdown...');
  // 1. 标记 not-ready (K8s 摘除路由)
  isShuttingDown = true;
  // 2. 停止接受新 WebSocket 连接
  wss.close();
  // 3. 停止调度器
  stopScheduler();
  // 4. 等待进行中 agent 完成 (最长 90s)
  await waitForActiveAgents(90000);
  // 5. 关闭 HTTP server
  server.close();
  // 6. 关闭数据库
  closeDatabase();
  logger.info('Shutdown complete');
  process.exit(0);
});
```

K8s 配合:
```yaml
terminationGracePeriodSeconds: 120
```

#### 2.1.3 Web 服务 Dockerfile

**新文件**: `deploy/docker/Dockerfile.server`

多阶段构建:
```dockerfile
# Stage 1: 后端构建
FROM node:22-slim AS backend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY . .
RUN npm run build  # tsc → dist/

# Stage 2: 前端构建
FROM node:22-slim AS frontend-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY web/ .
RUN npm run build  # vite → dist/

# Stage 3: Agent runner 构建
FROM node:22-slim AS agent-builder
WORKDIR /app/container/agent-runner
COPY container/agent-runner/package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY container/agent-runner/ .
RUN npm run build

# Stage 4: 生产镜像
FROM node:22-slim AS production
WORKDIR /app
# 安装运行时依赖(better-sqlite3 需编译)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com
COPY --from=backend-builder /app/dist ./dist
COPY --from=frontend-builder /app/web/dist ./web/dist
COPY --from=agent-builder /app/container/agent-runner/dist ./container/agent-runner/dist
COPY config/ ./config/
COPY container/skills/ ./container/skills/
COPY container/entrypoint.sh ./container/entrypoint.sh
# 非 root 用户
RUN useradd -r -u 1000 -g root deepthink && \
    mkdir -p /data && chown -R deepthink:root /app /data
USER deepthink
ENV DEEPTHINK_DATA_DIR=/data
ENV WEB_PORT=9898
EXPOSE 9898
CMD ["node", "dist/index.js"]
```

#### 2.1.4 K8s 部署清单

**新文件**: `deploy/k8s/` 目录

文件结构:
```
deploy/k8s/
├── namespace.yaml          # Namespace: deepthink
├── configmap.yaml           # 非敏感配置
├── secret.yaml.example      # 敏感配置模板
├── pvc.yaml                 # 持久化卷
├── deployment.yaml          # Deployment + 健康检查 + PVC
├── service.yaml             # ClusterIP + session affinity
├── ingress.yaml             # Ingress + TLS + WS
├── hpa.yaml                 # 水平自动扩缩容
└── kustomization.yaml       # Kustomize 聚合
```

**关键设计**:

**PVC (ReadWriteMany)**:
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: deepthink-data
  namespace: deepthink
spec:
  accessModes: ["ReadWriteMany"]  # RWX 支持多 Pod 共享
  storageClassName: nfs-client     # 或 cephfs/efs
  resources:
    requests:
      storage: 100Gi
```

> 注意: Phase 1 单副本时用 ReadWriteOnce 即可。Phase 2 多副本需 RWX + NFS/CephFS。

**Deployment**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: deepthink
  namespace: deepthink
spec:
  replicas: 1  # Phase 1 单副本
  strategy:
    type: Recreate  # 单副本必须 Recreate,避免双写
  template:
    spec:
      terminationGracePeriodSeconds: 120
      containers:
        - name: deepthink
          image: deepthink-server:latest
          ports:
            - containerPort: 9898
          envFrom:
            - configMapRef: { name: deepthink-config }
            - secretRef: { name: deepthink-secret }
          volumeMounts:
            - name: data
              mountPath: /data
          livenessProbe:
            httpGet: { path: /health, port: 9898 }
            initialDelaySeconds: 15
            periodSeconds: 30
          readinessProbe:
            httpGet: { path: /ready, port: 9898 }
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: deepthink-data
```

**Service (session affinity)**:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: deepthink
  namespace: deepthink
spec:
  type: ClusterIP
  sessionAffinity: ClientIP  # WebSocket sticky
  sessionAffinityConfig:
    clientIP: { timeoutSeconds: 10800 }  # 3h
  ports:
    - port: 9898
      targetPort: 9898
```

**Ingress (WebSocket 支持)**:
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: deepthink
  namespace: deepthink
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/websocket-services: deepthink
spec:
  rules:
    - host: deepthink.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: deepthink, port: { number: 9898 } }
```

**HPA**:
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: deepthink
  namespace: deepthink
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: deepthink
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 70 }
```

> Phase 1 min=1 max=1(单副本),Phase 2 改 min=2 max=10。

### 2.2 Phase 2: 多副本弹性扩缩容 (设计 + 关键代码)

#### 2.2.1 数据库抽象层

**新文件**: `src/db-adapter.ts`

定义统一接口,保持 better-sqlite3 的同步语义:

```typescript
// 统一 DB 接口(同步语义,PostgreSQL 通过同步队列模拟)
export interface DatabaseAdapter {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  transaction(fn: () => void): void;
  pragma(name: string, value?: string): any;
  close(): void;
}

export interface PreparedStatement {
  get(...params: any[]): any;
  all(...params: any[]): any[];
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
}
```

**SQLiteAdapter**: 包装现有 better-sqlite3,零行为变更。

**PostgreSQLAdapter**: 使用 `pg` + 同步桥(在 Node.js 单线程里通过 `deasync` 或 worker_threads 阻塞等待)。但由于 better-sqlite3 是真同步,而 pg 是异步,真正的异步迁移需要重写所有 401 个函数。

**务实方案**: Phase 2 先不改 SQLite 同步语义,而是:
1. 单写者 Pod(通过 Redis 分布式锁选主)
2. 其他 Pod 只读(读写分离)
3. 写请求通过 Redis 转发到主 Pod

#### 2.2.2 Redis 状态共享

**新文件**: `src/redis-client.ts`

```typescript
import { createClient } from 'redis';

export const redisEnabled = !!process.env.REDIS_URL;
export const redis = redisEnabled ? createClient({ url: process.env.REDIS_URL }) : null;

// WebSocket 跨 Pod 广播
export async function publish(channel: string, msg: any): Promise<void> {
  if (redis) await redis.publish(channel, JSON.stringify(msg));
}

// 分布式锁(调度器选主)
export async function acquireLease(key: string, ttl: number): Promise<boolean> {
  if (!redis) return true; // 单进程退化为内存模式
  return (await redis.set(key, '1', { NX, PX: ttl })) === 'OK';
}
```

**WebSocket 广播改造** (`src/web.ts`):
```typescript
// 广播时:先发本地 wsClients,再 publish 到 Redis
function broadcastStreamEvent(jid: string, event: any) {
  broadcastToLocal(jid, event);
  publish(`stream:${jid}`, event);
}
// 订阅 Redis channel,转发到本地 wsClients
if (redis) {
  redis.subscribe('stream:*', (msg) => broadcastToLocal(msg.jid, msg.event));
}
```

**调度器选主** (`src/task-scheduler.ts`):
```typescript
async function startSchedulerLoop() {
  while (true) {
    if (await acquireLease('scheduler:leader', 60000)) {
      // 我是 leader,执行调度
      const tasks = getDueTasks();
      for (const t of tasks) executeTask(t);
    }
    await sleep(60000);
  }
}
```

#### 2.2.3 Agent 执行:独立 Worker (设计)

Phase 2 将 agent 执行从主 Pod 分离:
- 主 Pod:处理 HTTP/WS/调度
- Worker Pod:执行 agent(CPU 密集)
- 通过 Redis 队列分发任务

```
Main Pod → Redis Queue → Worker Pod → spawn agent → 结果回写
```

### 2.3 Phase 3: PostgreSQL 完整迁移 (未来)

- 重写 `db.ts` 401 个函数为 async
- sqlite-vec → pgvector
- FTS5 → pg_trgm + tsvector
- 全量数据迁移脚本
- 测试覆盖

## 3. 改动清单

### 3.1 代码改动

| 文件 | 改动 | 阶段 |
|---|---|---|
| `src/web.ts` | 添加 /health、/ready 端点;isShuttingDown 标志 | P1 |
| `src/db.ts` | 导出 checkDbReady()、closeDatabase() | P1 |
| `src/index.ts` | 增强 SIGTERM 优雅关闭 | P1 |
| `src/config.ts` | 确认 DEEPTHINK_DATA_DIR 已支持(无需改) | P1 |
| `src/db-adapter.ts` | 数据库抽象接口(新建) | P2 |
| `src/redis-client.ts` | Redis 客户端(新建) | P2 |

### 3.2 基础设施改动

| 文件 | 内容 | 阶段 |
|---|---|---|
| `deploy/docker/Dockerfile.server` | Web 服务生产镜像 | P1 |
| `deploy/docker/docker-compose.yml` | 本地测试编排 | P1 |
| `deploy/k8s/namespace.yaml` | Namespace | P1 |
| `deploy/k8s/configmap.yaml` | 非敏感配置 | P1 |
| `deploy/k8s/secret.yaml.example` | 敏感配置模板 | P1 |
| `deploy/k8s/pvc.yaml` | 持久化卷 | P1 |
| `deploy/k8s/deployment.yaml` | Deployment | P1 |
| `deploy/k8s/service.yaml` | Service | P1 |
| `deploy/k8s/ingress.yaml` | Ingress | P1 |
| `deploy/k8s/hpa.yaml` | HPA | P1 |
| `deploy/k8s/kustomization.yaml` | Kustomize | P1 |
| `deploy/k8s/README.md` | 部署指南 | P1 |

## 4. 数据持久化保障

### 4.1 PVC 挂载策略

```
/data (PVC mount point)
├── db/messages.db*         # SQLite 数据库
├── groups/                 # 工作区(用户数据)
├── sessions/               # 会话产物
├── memory/                 # 记忆
├── config/                # 运行时配置(密钥等)
├── skills/                 # 用户技能
├── trace-io/               # 大对象 I/O
├── ipc/                    # IPC 通道
├── mcp-servers/            # MCP 配置
└── harness/                # Harness 版本
```

容器内 `DEEPTHINK_DATA_DIR=/data`,所有路径自动归到 PVC 上。

### 4.2 备份策略

```bash
# 定时备份 (K8s CronJob)
kubectl create -f deploy/k8s/backup-cronjob.yaml
# 或手动备份
kubectl exec deepthink-0 -- sqlite3 /data/db/messages.db ".backup /data/backup-$(date +%Y%m%d).db"
```

## 5. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| SQLite RWX 并发写 | 高 | 数据损坏 | Phase 1 用 RWO + Recreate;Phase 2 选主 |
| WebSocket 不粘滞 | 中 | 消息丢失 | sessionAffinity: ClientIP |
| better-sqlite3 ABI 不兼容 | 中 | 启动失败 | Dockerfile 内编译,匹配 node:22 |
| Agent DinD 在 K8s 内不可用 | 中 | Agent 无法执行 | Phase 1 用 host 模式;Phase 2 Worker Pod |
| PVC 存储类不可用 | 低 | Pod 挂起 | 支持多种 storageClass |
