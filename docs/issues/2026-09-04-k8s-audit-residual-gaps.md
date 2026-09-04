# K8s 云部署收尾审计：3 处未闭环缺陷（2 修 1 延期）

> 2026-09-04 · 跟进 K8s 云端部署 Phase 1-4 全量交付后的代码级审计
> 审计基于 main HEAD（ec720f8），32 项清单核查发现 3 处"已完成项中的未闭环"。

## 1. 用户现象

Phase 1-4 均已合并 main 并宣称完成，但生产化审计发现：
- SIGTERM 优雅关闭链路中，PostgreSQL 同步驱动的 worker_thread 未被显式关闭（靠 OS 进程退出回收）。
- `docs/task_state/k8s-cloud-deploy/TASK_STATE.md` 仍停留在 2026-09-02 的"Phase 1 完成、Phase 2/3 待办"，与 main 实际（Phase 1-4 全交付）严重不符。
- Redis 共享并发计数器 `incrCounter/decrCounter` 已实现但全代码库无调用方 → 多 Pod 下用户计费并发上限实际不生效。

## 2. 问题描述

1. **PG driver 未优雅关闭** — `src/pg-sync-driver.ts:203` 导出了 `closePgSyncDriver()`，但 `src/index.ts` 的 shutdown handler（:10910-10993）只调了 `closeDatabase()`，未调 `closePgSyncDriver()`。PG 模式下 worker_thread 在进程退出时被 OS 强杀，非优雅。
2. **TASK_STATE 滞后** — 文档只反映 Phase 1，导致无法从文档判断真实交付状态。
3. **共享并发计数器未接线** — `redis-bus.ts:236-264` 的 `incrCounter/decrCounter` 无任何业务调用方。用户级计费并发检查器（`index.ts:11666` `userConcurrentLimitFn`）用进程内 `queue.hasDirectActiveRunner(jid)` + `countActiveTaskRunners(jid)` 计数，多 Pod 分布式下每个 web pod 只看到本 pod 的活跃 runner → 少算 → 用户跨 Pod 突破计费并发上限。

## 3. 根因

- **缺陷 1**：Phase 2 引入 PG 同步驱动时，只接了 init（`index.ts:10816`），漏接了 shutdown 的 close——典型的"成对改"漏改（init/close 必须成对出现在生命周期里）。
- **缺陷 2**：Phase 2-4 在各自独立 worktree 推进，每个 worktree 只更新自己的 task_state，`k8s-cloud-deploy` 的总 task_state 未被回更。
- **缺陷 3**：Phase 2 把共享计数器作为"先备好的能力"实现，但接线点（userConcurrentLimitFn）是 sync 签名 `(groupJid)=>{allowed}`，Redis 计数是 async，接线需把检查器改 async（ripple through sync enqueue 路径）或引入缓存计数器——属并发/计费关键代码的设计决策，被搁置未做。

依据：`src/index.ts:10910-10995`（shutdown）；`src/pg-sync-driver.ts:198-206`；`redis-bus.ts:236-264`；`src/group-queue.ts:259-271` hasCapacityFor；`src/index.ts:11666-11684` userConcurrentLimitFn。

## 4. 复现路径

1. **缺陷 1**：PG 模式启动（`DATABASE_URL=postgresql://...`）→ `kill -TERM <pid>` → 日志无 "closing PG sync driver" 相关 → worker_thread 被 OS 回收（非致命但非优雅）。
2. **缺陷 2**：打开 `docs/task_state/k8s-cloud-deploy/TASK_STATE.md` → 仍见"Phase 1 完成 / Phase 2 待办" → 与 `git log` 矛盾。
3. **缺陷 3**：多 Pod + 计费启用 + 用户并发上限=N → 用户在 Pod-A 起 N 个、Pod-B 再起 N 个 → `userConcurrentLimitFn` 各 pod 本地计数均 < N → 实际跑 2N，突破上限。

## 5. 诊断方法

```bash
# 缺陷 1：shutdown 是否关闭 PG driver
grep -n "closePgSyncDriver" src/index.ts   # 修复后命中 shutdown handler
# 缺陷 2：task_state 是否校准
grep -c "Phase 1-4" docs/task_state/k8s-cloud-deploy/TASK_STATE.md   # 修复后 >=1
# 缺陷 3：计数器是否有调用方
grep -rn "incrCounter\|decrCounter" src/ | grep -v redis-bus.ts      # 修复前仅定义处
```

## 6. 修复方案

### 缺陷 1：shutdown 调用 closePgSyncDriver（已修）
```diff
 // src/index.ts shutdown handler，closeDatabase 之后
+    // Close PostgreSQL sync driver worker thread (graceful, no-op when on SQLite).
+    try {
+      const { closePgSyncDriver } = await import('./pg-sync-driver.js');
+      closePgSyncDriver();
+    } catch (err) {
+      logger.warn({ err }, 'Error closing PG sync driver');
+    }
     logger.info('Shutdown complete');
```
- 选型：`closePgSyncDriver` 内部 `_driver?.close(); _driver = null`，SQLite 模式下 `_driver` 为 null → no-op，零回归。用动态 import 避免在 SQLite 模式加载 pg 模块。

### 缺陷 2：TASK_STATE 校准（已修）
- 重写 `docs/task_state/k8s-cloud-deploy/TASK_STATE.md` 至 Phase 1-4 全交付 + 阶段交付总览表 + 本次缺陷 + 待确认事项。

### 缺陷 3：共享并发计数器接线（延期，需设计确认）
- **不擅改**。给出 3 个设计选项供决策：
  1. `userConcurrentLimitFn` 改 async → ripple through `enqueueMessage`/`enqueueTask`（sync void）的调用链，改动面大。
  2. 在 `registerProcess`/release 处（`group-queue.ts:1222/1308` 等）维护 Redis 计数 + 本地缓存供 sync 检查器读取。
  3. 下沉到 agent-runner 侧 `BLPOP` 取任务前做 per-user 限流（单点、已 async）。
- 选型待用户确认。涉及并发正确性与计费，仓促改风险高。

## 7. 处理卡住的状态

无运行态卡死。

## 8. 经验沉淀 / 预防

- **init/close 必须成对出现在生命周期**：凡在 main()/init 阶段创建的资源（DB 连接、Redis、worker_thread、scheduler），必须在其 shutdown handler 对应关闭。审计清单：`grep init.*Driver\|init.*Manager` 的结果，每项都应在 shutdown 有对应 close。
- **多 worktree 并行推进时，总 task_state 必须由收尾人回更**：各子阶段只更自己的 task_state，会导致总览文档滞后。收尾审计必须校准总 task_state。
- **"先备好的能力"若接线需改关键代码签名，必须显式标 TODO + 设计选项**：未接线的 async 能力遇上 sync 调用方，不能猜改，要列出 ripple 影响供决策。审计应 grep "已定义但无调用方"的导出函数。
- **审计要看"已完成项是否真闭环"**：不仅看功能存在，要看是否被调用、是否在生命周期两端成对、文档是否同步。
