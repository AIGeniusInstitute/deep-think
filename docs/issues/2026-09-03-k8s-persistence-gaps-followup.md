# K8s 云端部署 4 缺口首修的 3 项遗留补修

> 2026-09-03 · 跟进 `2026-09-03-k8s-deploy-data-persistence-gaps.md`
> 首修（commit eec7333）修了写盘/挂载/BRPOP/备份分支骨架，但留下 3 处真实缺陷，本补修修正。

## 1. 用户现象

首修合并后仍复现：
- 对话 trace 点击查看大 tool I/O → 400 Invalid ref（文件写到了 `/data/trace-io`，读取端守卫仍算 `/app/data/trace-io`，路径不匹配）。
- 每日 03:00 备份 CronJob 绿灯，但 `/data/backups/` 下无 PG dump 文件（镜像无 pg_dump，走 warn-and-skip 静默跳过）。
- 多租户下，用户 A 的全局 CLAUDE.md 被用户 B 的分布式 agent 读到（global 撞进共享 `groups/global`）；非 home 组 agent 写的记忆 host 记忆路由读不到（memory 落进组目录而非 owner home 目录）。

## 2. 问题描述

1. **trace 读取端路径守卫漏改** — `src/routes/chat-trace.ts:108` 仍 `resolve(process.cwd(), 'data', 'trace-io')`，与写盘端 `DATA_DIR` 不一致，路径穿越守卫恒拒 → `GET /:jid/trace/steps/:spanId/io` 返回 400。
2. **备份镜像缺 pg_dump** — `backup-cronjob.yaml` 用 `deepthink-server:latest`（node 镜像，无 pg_dump），PG 分支 `command -v pg_dump` 失败 → warn-and-skip，CronJob 假绿无产物。
3. **分布式 workspace 多租户路由错误** — agent-runner 仅凭 `groupFolder` 推导 `WORKSPACE_GLOBAL=groups/global`（共享，应为 `groups/user-global/{ownerId}`）、`WORKSPACE_MEMORY=memory/{gf}`（应为 `memory/{ownerHomeFolder}` for 非 home 组）。

## 3. 根因

- **缺口 1**：首修只改了写盘端 `chat-trace-persist.ts`，漏改同模块读取端 `chat-trace.ts` 的路径守卫——读写两端必须同源 `DATA_DIR`。
- **缺口 2**：首修加了 `command -v pg_dump` 防御分支但未换镜像，默认 node 镜像无 pg_dump，防御分支成了"静默吞掉备份"。
- **缺口 3**：首修让 runner 内部从 `DATA_DIR+groupFolder` 自推导 workspace，但 runner 无法仅凭 groupFolder 得知 ownerId / ownerHomeFolder，故 global/memory 退化到共享/组级路径，与单机 container-runner 的 per-user 语义不一致。
- 依据：`src/routes/chat-trace.ts:108`；`deploy/k8s/backup-cronjob.yaml:28,41-48`；`container/agent-runner/src/index.ts:2509-2511`；对照 `src/container-runner.ts:2019-2034`（per-user global + ownerHomeFolder memory）。

## 4. 复现路径

1. 触发 >64KB tool 输出 → 重启 Pod → `GET .../trace/steps/:spanId/io` → 400。
2. `kubectl -n deepthink create job --from=cronjob/deepthink-backup t` → `kubectl logs` 见 "pg_dump missing... Skipping" → `ls /data/backups/` 无 pg-*.sql.gz。
3. 两用户各自设全局记忆 → 分布式 agent 都读 `groups/global/CLAUDE.md`（串扰）。

## 5. 诊断方法

```bash
# 缺口 1：读取端守卫路径
grep -n "ioRoot = resolve" src/routes/chat-trace.ts   # 修复后含 DATA_DIR
# 缺口 2：备份镜像
grep "image:" deploy/k8s/backup-cronjob.yaml          # 修复后 postgres:16-alpine
kubectl -n deepthink create job --from=cronjob/deepthink-backup t && kubectl -n deepthink logs job/t
# 缺口 3：workspace 路由
kubectl -n deepthink logs deploy/agent-runner | grep "Workspace resolved"  # 修复后含 per-user global/memory
```

## 6. 修复方案

### 缺口 1：读取端守卫改 DATA_DIR
```diff
 // src/routes/chat-trace.ts
+import { DATA_DIR } from '../config.js';
-  const ioRoot = resolve(process.cwd(), 'data', 'trace-io');
+  const ioRoot = resolve(DATA_DIR, 'trace-io');
```

### 缺口 2：备份换 postgres 镜像
- `deploy/k8s/backup-cronjob.yaml` `image: deepthink-server:latest` → `postgres:16-alpine`（自带 pg_dump）；SQLite 分支由 `node -e better-sqlite3` 改 `cp`（postgres 镜像无 node）；`envFrom: deepthink-secret` 注入 DATABASE_URL。
- 选型：云端目标即 PG，pg_dump 是标准灾备工具；postgres 镜像原生提供，无需改 deepthink 镜像。

### 缺口 3：per-user global + owner-home memory 走 payload
- `container/agent-runner/src/types.ts`：ContainerInput 加 `workspaceGlobal?/workspaceMemory?`。
- `src/index.ts`（taskInput）：host 按 `group.created_by` 解析 per-user global、按 `group.is_home?group.folder:ownerHomeFolder` 解析 memory，随任务下发 + `mkdirSync`。
- `container/agent-runner/src/index.ts`：runner 在 DATA_DIR 推导后，用 payload 覆盖 `WORKSPACE_GLOBAL/WORKSPACE_MEMORY`（缺省回退原共享/组级路径，向后兼容）。
- 选型：runner 无法推导 owner，故由持元的 host 下发；与单机 container-runner 语义对齐，多租户隔离正确。

### 测试 mock 修复
- `tests/chat-trace-store.test.ts` 的 `vi.mock('../src/config.js')` 补 `DATA_DIR: tmpDir`（首修改写盘端用 DATA_DIR 后该 mock 漏补，导致 offload 用例在 main 上即失败）。

## 7. 处理卡住的状态

无运行态卡死。`kubectl rollout restart deploy/deepthink deploy/agent-runner -n deepthink` 滚动重启生效。

## 8. 经验沉淀 / 预防

- **"写盘 + 读路径"成对改**：凡 DB 存文件路径引用的落盘逻辑，改写端必须同步改读取端路径守卫，且同源 `DATA_DIR`。审计清单：grep 写端 + grep 读端，两端根必须一致。
- **CronJob 镜像必须自带其调用的工具**：加了 `command -v` 防御分支却配缺工具的镜像，等于把"失败"伪装成"绿灯跳过"——比直接 fail 更危险（静默无灾备）。防御分支应配可执行镜像，或失败时 `exit 1` 让 CronJob 变红。
- **分布式 worker 凡需 owner 上下文的路径，由 host 下发 payload**，不要让 worker 凭 groupFolder 猜——多租户下 global/memory 路由必然错。
- **改 config.js 依赖项后跑相关测试 mock**：`vi.mock(config.js)` 要覆盖新引入的导出（DATA_DIR），否则测试在 CI 才暴露。
