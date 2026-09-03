# 任务状态：分布式 IPC 遗留三项

## 改动清单

### 1. redis-bus.ts — 新增输出方向函数
- `subscribeIpcOutput(folder, subdir, handler)` — 订阅 `deepthink:ipc-out:{folder}:{subdir}`
- `publishIpcTaskResult(folder, requestId, result)` — 发布 task result 到 `deepthink:ipc-task:{folder}:{requestId}`
- `publishAgentTask(taskInput)` — 发布任务到 `deepthink:agent-tasks`
- `hasDistributedRunners()` — 检查 `deepthink:agent-runners:pool` 集合是否有成员

### 2. index.ts (Web Server)
- **import**: 新增 `subscribeIpcOutput, publishIpcTaskResult, publishAgentTask, hasDistributedRunners`
- **IpcWatcherManager**:
  - watchers Map 新增 `redisOutputUnsubs: (() => void)[]` 字段
  - 新增 `distributedOutputHandlers: Map<folder, handler>` 和 `registerDistributedOutput`/`unregisterDistributedOutput`
  - `watchGroup()`: 新增订阅 `deepthink:ipc-out:{folder}:messages`（agent_output → 注册的 onOutput；message → 写本地 messages/ 目录）和 `deepthink:ipc-out:{folder}:tasks`（写本地 tasks/ 目录）
  - `unwatchGroup()`: 清理 redisOutputUnsubs 和 distributedOutputHandlers
- **writeTaskResult()**: Redis 连接时额外 `publishIpcTaskResult` 发布结果
- **runAgent()**: 新增分布式分支 — `isRedisConnected() && hasDistributedRunners()` 时走 `publishAgentTask` + 等待 `finalOutputPromise`（10 分钟超时保底）

### 3. mcp-bridge.ts (Agent Runner)
- 新增 `DT_REDIS_URL` + `DT_DISTRIBUTED_MODE` 环境变量读取
- 新增 `initRedisBridge()` — 创建 Redis pub/sub 客户端
- 新增 `redisPublishMessage(data)` — 发布到 `deepthink:ipc-out:{folder}:messages`
- 新增 `redisRequestTask(data, prefix, timeout)` — 发布请求到 `deepthink:ipc-out:{folder}:tasks`，订阅 `deepthink:ipc-task:{folder}:{requestId}` 等待结果
- `writeIpcFile(MESSAGES_DIR, data)`: 分布式时走 `redisPublishMessage`
- `pollIpcResult()`: 分布式时走 `redisRequestTask`
- 启动时 `initRedisBridge()` → `server.connect(transport)`
- SIGTERM/SIGINT 清理 Redis 连接

### 4. codex-engine.ts / opencode-engine.ts
- env_vars 列表新增 `DT_REDIS_URL` 和 `DT_DISTRIBUTED_MODE`

### 5. agent-runner index.ts — 长驻循环
- `main()` 拆分为 `main()` + `processOneTask()`
- `main()` 分布式模式: `initRedisIpc()` → `while(true) { processOneTask(); cleanup; }`
- `main()` 非分布式模式: `processOneTask()` → `forceExitWithSafetyNet(0)`
- 引擎分支(atomcode/codex/opencode/pi) `process.exit(0)` → `return`
- `processOneTask()` 正常结束 `forceExitWithSafetyNet(0)` → `return`
- 保留 `process.exit(1)` 致命错误
- 分布式模式设置 `process.env.DT_REDIS_URL` + `DT_DISTRIBUTED_MODE` 传递给子进程
- SIGTERM handler 改为 async，清理 `closeRedisIpc()`

## 测试状态

- ✅ 后端 tsc --noEmit 通过（零错误）
- ✅ agent-runner tsc --noEmit 通过（零错误）
- ✅ 向后兼容：无 REDIS_URL 时全部 no-op

## 已知限制（非本次范围）
- 分布式模式下 queue.registerProcess 未调用（无本地进程），queue 的 markRunnerActivity 在分布式模式下为 no-op（可接受 — 消息发送/中断/close 已由 Redis 桥接处理）
- 分布式 dispatch 10 分钟超时后返回错误（保底机制，防止 Pod 崩溃时永久挂起）
