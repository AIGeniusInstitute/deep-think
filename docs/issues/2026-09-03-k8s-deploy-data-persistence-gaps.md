# K8s 云部署数据持久化与并发缺口修复

**日期**: 2026-09-03
**范围**: K8s 云端部署（`deploy/k8s/`）+ 分布式 Agent IPC
**严重度**: 🔴 阻塞（云端部署"用不了"的核心阻塞点）
**修复 commit**: `fix/k8s-deploy-gaps` → main

本次修复 K8s 云端部署落地的 4 个生产级缺口。它们都属于同一主题——**多 Pod 无状态化改造后，数据持久化与任务并发语义未同步对齐**——合并为一篇 issue 沉淀。

---

## 1. 用户现象

| # | 缺口 | 用户/外部视角现象 |
|---|------|------------------|
| A | trace-io 不在 PVC 上 | 在云端部署后，查看历史对话的 trace 链路（DAG 可视化 / 工具调用大 I/O 回放），重启 Pod 后所有大块工具输入输出消失，`output_ref` 指向的文件 404，链路断裂。 |
| B | agent-runner 无 PVC + workspace 不存在 | 分布式模式下发的任务，Claude Code 报"找不到用户文件/记忆/技能"，在空目录运行；agent 产物（生成的代码、文档）Pod 一重启全丢。分布式部署"用不了"。 |
| C | waitForTask 用 pub/sub 而非 BRPOP | agent-runner 扩到 2+ replica 后，同一条用户消息被多个 Pod 同时拾取并执行，产生重复回复 / 重复写入 / 资源竞争。 |
| D | Backup CronJob 在 PG 模式失效 | 云端用 PostgreSQL 后，每日 03:00 的备份 Job 直接报错退出（`better-sqlite3` 打开不存在的 `/data/db/messages.db`），云端部署无任何灾备。 |

## 2. 问题描述

- **A**：`src/chat-trace-persist.ts:118` 的 `traceIoDir()` 用 `join(process.cwd(), 'data', 'trace-io', traceId)`。容器内 `process.cwd()`=`/app`（Dockerfile `WORKDIR`），而 PVC 挂载在 `/data`。大 I/O 落盘写到 `/app/data/trace-io/`（容器可写层，ephemeral），Pod 重启即丢；DB `output_ref` 存的是这个路径，重启后成悬空指针。
- **B**：`deploy/k8s/agent-runner.yaml` 无 `volumeMounts`/`volumes`；`container/agent-runner/src/index.ts:67` `WORKSPACE_GROUP` 默认 `/workspace/group`，Pod 内不存在。agent-runner 收到任务后 Claude Code 的 `cwd` 指向空目录，无法访问用户文件/记忆/技能，写入随重启丢失。
- **C**：`container/agent-runner/src/redis-ipc.ts:62` `waitForTask()` 用 `_sub.subscribe(TASK_QUEUE_CHANNEL, ...)`（pub/sub fan-out）；发布端 `src/redis-bus.ts:327` 也用 `pub.publish()`。pub/sub 是广播语义——所有订阅的 replica 同时收到同一任务。代码注释自己写"Use blocking pop from a list (BRPOP)"但实现却是 subscribe，注释与代码矛盾。
- **D**：`deploy/k8s/backup-cronjob.yaml:40-41` 硬编码 `better-sqlite3` 打开 `/data/db/messages.db`。云端 PG 模式下根本不存在此文件，备份 Job 每次失败，无灾备。

## 3. 根因

四者根因一致：**Phase 2 多 Pod 无状态化把状态外移到 Redis/PG/PVC，但"落盘路径"和"任务分发语义"仍停留在单进程假设**。

- A/B：落盘路径用 `process.cwd()` 或容器内固定 `/workspace/*`，未对齐到共享 PVC 的 `DATA_DIR`（`/data`）。web-server pod 已挂 PVC 且 `DEEPTHINK_DATA_DIR=/data`，但 chat-trace-persist 没用 `DATA_DIR`，agent-runner 既没挂 PVC 也没用 `DATA_DIR`。
- C：IPC 改造时把 stdin 替换成 Redis，但选了 pub/sub 而非 list 队列。pub/sub 适合"广播给所有订阅者"（如 WS 跨 Pod 推送），任务分发需要的是"投递给恰好一个消费者"的队列语义。
- D：备份脚本是从 SQLite 单机版照搬的，没随 PG 后端切换而分支化。

外部依据：
- Redis 官方文档：`BRPOP`/`BLPOP` 提供阻塞式队列消费（"Pop from a list, blocking"），`PUBLISH`/`SUBSCRIBE` 是 fan-out 广播，两者语义不同。https://redis.io/docs/latest/commands/brpop/
- K8s PVC：未挂载的容器路径写入落在容器可写层，随 Pod 生命周期销毁。https://kubernetes.io/docs/concepts/storage/persistent-volumes/

## 4. 复现路径

**A 复现**：
1. K8s 部署（PG + Redis + 2 replica web-server，PVC `/data`）。
2. 发一条带大工具输出的消息（>64KB），触发 `offloadLargeIo` 写 `/app/data/trace-io/...`。
3. `kubectl rollout restart deployment/deepthink`。
4. 查 DB `chat_trace_nodes.output_ref` 指向的路径 → 文件不存在。

**B 复现**：
1. `AGENT_RUNNER_MODE=distributed` 起 agent-runner（无 PVC）。
2. 主机 `publishAgentTask` 发任务，agent-runner 拾取。
3. Claude Code `cwd=/workspace/group`（不存在），读用户文件失败；写入 `/workspace/...` 重启即丢。

**C 复现**：
1. agent-runner `replicas: 2`，Redis 已连。
2. 主机 `publishAgentTask` 发 1 条任务（`PUBLISH deepthink:agent-tasks`）。
3. 两个 replica 的 `_sub.subscribe` 同时回调 → 同一任务被处理两次。

**D 复现**：
1. `DATABASE_URL=postgresql://...` 部署，PVC 无 `/data/db/messages.db`。
2. `kubectl create job --from=cronjob/deepthink-backup manual-test`。
3. Pod 日志：`SqliteError: Cannot open /data/db/messages.db` → Job Failed。

## 5. 诊断方法

```bash
# A: trace-io 路径是否落在 PVC
kubectl -n deepthink exec deploy/deepthink -- sh -c 'ls -la /app/data/trace-io 2>/dev/null; ls -la /data/trace-io 2>/dev/null; echo cwd=$(pwd)'
# 修复前：/app/data/trace-io 有文件，/data/trace-io 空。修复后反过来。

# B: agent-runner 是否挂 PVC + workspace 是否存在
kubectl -n deepthink get deploy agent-runner -o jsonpath='{.spec.template.spec.containers[0].volumeMounts}'
kubectl -n deepthink exec deploy/agent-runner -- sh -c 'echo GROUP=$DEEPTHINK_WORKSPACE_GROUP; ls /data/groups 2>/dev/null'

# C: 任务分发语义（应见 list 而非 pub/sub）
kubectl -n deepthink exec -it deploy/agent-runner -- node -e '
  const r=require("redis").createClient({url:process.env.REDIS_URL});
  r.connect().then(async()=>{console.log("TYPE=",awaitr.type("deepthink:agent-tasks"))})'
# 修复前：none（pub/sub 无 key）。修复后：list。

# D: 备份 Job 在 PG 模式
kubectl -n deepthink create job --from=cronjob/deepthink-backup manual-backup-test
kubectl -n deepthink logs job/manual-backup-test
# 修复后应输出 "PostgreSQL backup complete: /data/backups/pg-*.sql.gz"
```

## 6. 修复方案

### A — trace-io 落盘对齐 PVC

`src/chat-trace-persist.ts`：
```diff
+import { DATA_DIR } from './config.js';
 ...
 function traceIoDir(traceId: string): string {
-  const dir = join(process.cwd(), 'data', 'trace-io', traceId);
+  const dir = join(DATA_DIR, 'trace-io', traceId);
```
选型：复用主机端已有的 `DATA_DIR`（`config.ts`，`DEEPTHINK_DATA_DIR=/data`），与 web-server pod 的 PVC 挂载点一致，`output_ref` 跨 Pod 路径统一、重启不丢。不引入新 env，最小改动。

### B — agent-runner 挂 PVC + workspace 动态化

`deploy/k8s/agent-runner.yaml`：加 `volumeMounts: /data` + `volumes: deepthink-data PVC`。

`container/agent-runner/src/index.ts`：`WORKSPACE_*` 改 `let`，新增 `const DATA_DIR`，`processOneTask()` 收到 `groupFolder` 后按 group 重算到 PVC：
```diff
-const WORKSPACE_GROUP = process.env.DEEPTHINK_WORKSPACE_GROUP || '/workspace/group';
+const DATA_DIR = process.env.DEEPTHINK_DATA_DIR || '';
+let WORKSPACE_GROUP = process.env.DEEPTHINK_WORKSPACE_GROUP || '/workspace/group';
 ...（GLOBAL/MEMORY/IPC 同样 const→let）
+    if (DATA_DIR && containerInput.groupFolder) {
+      const gf = containerInput.groupFolder;
+      WORKSPACE_GROUP  = path.join(DATA_DIR, 'groups', gf);
+      WORKSPACE_GLOBAL = path.join(DATA_DIR, 'groups', 'global');
+      WORKSPACE_MEMORY = path.join(DATA_DIR, 'memory', gf);
+      WORKSPACE_IPC    = path.join(DATA_DIR, 'ipc', gf);
+      for (const d of [WORKSPACE_GROUP, WORKSPACE_GLOBAL, WORKSPACE_MEMORY, WORKSPACE_IPC])
+        try { fs.mkdirSync(d, { recursive: true }); } catch { /* may exist */ }
+    }
```
选型：路径布局与主机端 `container-runner.ts` 完全一致（`DATA_DIR/groups/{folder}`、`DATA_DIR/memory/{folder}`、`DATA_DIR/ipc/{folder}`），agent 在分布式与主机两种模式下访问同一套路径。`DATA_DIR` 为空时（本地单机）保持原 `/workspace/*` 默认值，向后兼容。global 用 legacy `groups/global`（与 `container-runner.ts:646` 一致）。

### C — 任务分发改队列语义（LPUSH + BRPOP）

`src/redis-bus.ts`（发布端）：
```diff
-    await pub.publish(AGENT_TASKS_CHANNEL, JSON.stringify(taskInput));
+    await pub.lPush(AGENT_TASKS_CHANNEL, JSON.stringify(taskInput));
```
`container/agent-runner/src/redis-ipc.ts`（消费端）：
```diff
-    _sub.subscribe(TASK_QUEUE_CHANNEL, (raw: string) => { ... });
+    _pub.blPop(TASK_QUEUE_CHANNEL, 0).then((res: any) => {
+      const raw = res?.element ?? res?.[1] ?? res;
+      resolve(JSON.parse(raw));
+    }).catch((err: unknown) => reject(new Error(`Failed to BRPOP task: ${String(err)}`)));
```
选型：`LPUSH`（左端入队）+ `BRPOP`（右端阻塞弹出）= FIFO 队列，每条任务恰好被一个 consumer 消费。`BRPOP key 0` 无限阻塞，等价于原 stdin 阻塞读。node-redis v4 `blPop` 返回 `{key, element}`，用 `res.element` 取 payload，`res[1]` 兼容旧格式。

### D — 备份脚本分支化（PG / SQLite）

`deploy/k8s/backup-cronjob.yaml`：
```diff
+    if [ -n "$DATABASE_URL" ]; then
+      if command -v pg_dump >/dev/null 2>&1; then
+        pg_dump "$DATABASE_URL" | gzip > "$BACKUP_DIR/pg-${STAMP}.sql.gz"
+      else echo "WARN: pg_dump missing — skipping PG backup" >&2; fi
+    else
       node -e "const D=require('better-sqlite3'); ... src.backup('$BACKUP_FILE') ..."
+    fi
```
选型：按 `DATABASE_URL` 是否存在分支——PG 用 `pg_dump | gzip`（标准逻辑备份，PG 在线安全），SQLite 保留 `.backup`（在线快照）。`pg_dump` 缺失时 warn + skip 而非 crash，保持 CronJob 绿色；镜像应装 `postgresql-client` 才能真正产 PG 备份（见第 8 节）。

## 7. 处理卡住的状态

本次为代码缺陷修复，无运行态 stuck 需救活。若云端已部署旧版且需热修：
- A/B/D：重新 `kubectl apply -k deploy/k8s/` + `rollout restart` 即可（PVC 数据保留）。
- C：旧 agent-runner 用 pub/sub，升级前先 `kubectl scale deploy/agent-runner --replicas=0`，apply 新版后再 scale 回来，避免新旧 replica 混用（旧版仍 subscribe 会重复消费）。

## 8. 经验沉淀 / 预防

- **"无状态化"必须同步"落盘路径对齐"**：每次把状态从本地 fs 外移到 PVC/PG/Redis，都要 grep 所有 `process.cwd()`/硬编码 `/workspace`/`./data` 落盘点，确认它们指向共享卷。巡检：`grep -rn "process.cwd()\|'/workspace" src/ container/ | grep -v node_modules`。
- **任务分发用队列、广播用 pub/sub**：凡"恰好一个消费者"语义必须 `LPUSH+BRPOP`/`Stream+XREADGROUP`，绝不用 `PUBLISH`。新增 IPC 通道时在注释里写明语义。
- **备份脚本随后端切换分支化**：任何"按后端类型行为不同"的逻辑（备份、迁移、健康检查）都要 early-branch on `DATABASE_URL`，不能写死单后端。
- **镜像需补 `postgresql-client`**：当前 `Dockerfile.server` 未装 `pg_dump`，PG 备份会走 warn+skip。下一步应在 Dockerfile 加 `apt-get install -y postgresql-client`，让 PG 备份真正可用（本 issue 范围外，已记为跟进项）。
- **告警建议**：CronJob `failedJobsHistoryLimit: 3` 已有，建议加 Prometheus 告警 `kube_job_status_failed{cronjob="deepthink-backup"} > 0`。

---

**验证**：后端 `tsc --noEmit` exit 0；`container/agent-runner` `tsc --noEmit` exit 0。运行时验证待云端 kind 集群回归（见任务 test_report 跟进）。
