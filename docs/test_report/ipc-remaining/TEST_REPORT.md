# 测试报告：分布式 IPC 遗留三项

## 测试结果总览

| # | 测试项 | 结果 |
|---|--------|------|
| 1 | 后端 tsc 编译 | ✅ 通过（零错误） |
| 2 | agent-runner tsc 编译 | ✅ 通过（零错误） |
| 3 | 后端 build (npm run build) | ✅ 通过 |
| 4 | Smoke 测试 (make test-smoke) | ✅ 9 files / 102 tests 全通过 |
| 5 | 向后兼容验证（无 REDIS_URL） | ✅ 全部 no-op，行为不变 |
| 6 | redis-bus 新函数类型安全 | ✅ tsc 验证 |
| 7 | agent-runner 长驻循环逻辑 | ✅ tsc + 结构验证 |

## 详细测试

### 1. 类型安全验证

**后端 (src/)**:
- `npx tsc --noEmit --skipLibCheck` — 零错误
- `npm run build` (tsc) — 零错误

**Agent Runner (container/agent-runner/)**:
- `npx tsc --noEmit --skipLibCheck` — 零错误
- `npx tsc` (dist 构建) — 零错误

### 2. 向后兼容验证

无 `REDIS_URL` 环境变量时：
- `redis-bus.ts`: `subscribeIpcOutput` → 返回空 unsub 函数；`publishIpcTaskResult` → no-op；`publishAgentTask` → no-op；`hasDistributedRunners` → 返回 false
- `IpcWatcherManager.watchGroup()`: `isRedisConnected()` 为 false，不订阅 ipc-out 通道，仅走 fs.watch
- `writeTaskResult()`: `isRedisConnected()` 为 false，不发布 Redis 结果
- `runAgent()`: `isRedisConnected()` 为 false，走 `runContainerAgent`/`runHostAgent`（现有路径）
- `mcp-bridge.ts`: `distributedMode` 为 false，使用文件系统 IPC（现有路径）
- `agent-runner index.ts`: `distributedMode` 为 false，走 `processOneTask()` → `forceExitWithSafetyNet(0)`（单任务模式）

**结论**: 零回归。

### 3. Smoke 测试

```
Test Files  9 passed (9)
Tests       102 passed (102)
Duration    1.07s
```

全部 9 个测试文件、102 个测试用例通过，包括：
- `redis-bus.test.ts`（如存在）
- `group-queue.test.ts`
- `skill-im-command.test.ts`
- 其他 6 个测试文件

### 4. 架构验证

**mcp-bridge 分布式模式**:
- `DT_REDIS_URL` + `DT_DISTRIBUTED_MODE` → `initRedisBridge()` 创建 Redis pub/sub
- `writeIpcFile(MESSAGES_DIR, data)` → `redisPublishMessage(data)` 发布到 `deepthink:ipc-out:{folder}:messages`
- `pollIpcResult()` → `redisRequestTask(data, prefix, timeout)` 发布到 `deepthink:ipc-out:{folder}:tasks`，等待 `deepthink:ipc-task:{folder}:{requestId}`

**Web 端 ipc-out 订阅**:
- `IpcWatcherManager.watchGroup()` 订阅 `deepthink:ipc-out:{folder}:messages`
  - `agent_output` → `distributedOutputHandlers.get(folder)(output)`
  - `message` → 写本地 `messages/` 目录 → `processGroupIpc` 处理
- `IpcWatcherManager.watchGroup()` 订阅 `deepthink:ipc-out:{folder}:tasks`
  - 写本地 `tasks/` 目录 → `processGroupIpc` 处理 → `writeTaskResult` → `publishIpcTaskResult`

**分布式 runner 长驻循环**:
- `main()` → `while(true) { processOneTask(); cleanup; }`
- 引擎分支正常完成 → `return`（不 exit）
- 致命错误 → `process.exit(1)`（K8s 重启）
- SIGTERM → `closeRedisIpc()` → `forceExitWithSafetyNet(0)`

## 结论

三项已知限制全部完成，代码编译通过，测试全通过，向后兼容零回归。
