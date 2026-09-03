# 技术方案：分布式 IPC 遗留三项

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│ Pod A (Web Server)                                               │
│                                                                  │
│  runForGroup → runDistributedAgent                               │
│    │ publishAgentTask(task) → deepthink:agent-tasks              │
│    │ registerDistributedOutput(folder, onOutput)                 │
│    │                                                              │
│  IpcWatcherManager.watchGroup(folder)                            │
│    ├─ fs.watch(messages/, tasks/)     ← 本地文件（单 Pod 模式）    │
│    ├─ subscribeAgentIpc(folder)       ← 输入方向（Phase 4）       │
│    └─ subscribeIpcOutput(folder, msgs) ← 输出方向（本次新增）      │
│         ├─ agent_output → registered onOutput handler            │
│         └─ message → 写本地 messages/ → processGroupIpc            │
│    └─ subscribeIpcOutput(folder, tasks) ← mcp-bridge task 请求    │
│         └─ 写本地 tasks/ → processGroupIpc → writeTaskResult      │
│              └─ publishIpcTaskResult → deepthink:ipc-task:{f}:{r} │
└─────────────────────────────────────────────────────────────────┘
         │ Redis Pub/Sub                    │
         ▼                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ Pod B (Agent Runner — 长驻循环)                                   │
│                                                                  │
│  main()                                                          │
│    while (true):                                                 │
│      task = waitForTask()  ← deepthink:agent-tasks               │
│      subscribeIpcInput(folder)  ← deepthink:ipc:{folder}         │
│      processOneTask(task)                                        │
│        ├─ writeOutput() → publishIpcOutput → ipc-out:{f}:messages │
│        ├─ codex/opencode → spawns mcp-bridge                     │
│        │    └─ mcp-bridge send_message → ipc-out:{f}:messages     │
│        │    └─ mcp-bridge task request → ipc-out:{f}:tasks        │
│        │         ← waits on ipc-task:{f}:{requestId}              │
│      cleanup per-task state                                      │
│      continue loop                                               │
│                                                                  │
│  SIGTERM → closeRedisIpc → exit                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 改动清单

### 1. redis-bus.ts — 新增输出方向函数

- `subscribeIpcOutput(folder, subdir, handler)` — 订阅 `deepthink:ipc-out:{folder}:{subdir}`
- `publishIpcTaskResult(folder, requestId, result)` — 发布到 `deepthink:ipc-task:{folder}:{requestId}`
- `publishAgentTask(taskInput)` — 发布任务到 `deepthink:agent-tasks`

### 2. index.ts — IpcWatcherManager + writeTaskResult + runDistributedAgent

**IpcWatcherManager:**
- 新增 `distributedOutputHandlers: Map<folder, (output) => Promise<void>>`
- 新增 `registerDistributedOutput(folder, handler)` / `unregisterDistributedOutput(folder)`
- `watchGroup()` 新增订阅 `deepthink:ipc-out:{folder}:messages` 和 `deepthink:ipc-out:{folder}:tasks`
  - messages handler: `agent_output` → 调用注册的 onOutput；`message` → 写本地 messages/
  - tasks handler: 写本地 tasks/ 目录
- `unwatchGroup()` 清理 ipc-out 订阅

**writeTaskResult():**
- Redis 连接时，额外 `publishIpcTaskResult(folder, requestId, result)`

**runForGroup 新增分布式分支:**
- Redis 连接时走 `runDistributedAgent`，否则走现有 `runContainerAgent`/`runHostAgent`

**runDistributedAgent(group, input, onOutput):**
- `publishAgentTask(input)` 发布任务
- `ipcWatcherManager.registerDistributedOutput(folder, onOutput)` 注册回调
- 等待最终输出（status: success/error/closed）
- `unregisterDistributedOutput` 后返回

### 3. mcp-bridge.ts — Redis 分布式模式

- 读取 `DT_REDIS_URL` + `DT_DISTRIBUTED_MODE` 环境变量
- 分布式模式下创建 Redis pub/sub 客户端
- `writeIpcFile(MESSAGES_DIR, data)`: 分布式时 `publishIpcOutput(folder, 'messages', data)`
- `pollIpcResult(TASKS_DIR, data, prefix, timeout)`: 分布式时发布到 `ipc-out:{folder}:tasks`，订阅 `ipc-task:{folder}:{requestId}` 等待结果

### 4. codex-engine.ts / opencode-engine.ts — 传递 Redis 环境变量

- env_vars 列表新增 `DT_REDIS_URL` 和 `DT_DISTRIBUTED_MODE`

### 5. agent-runner index.ts — 长驻循环

- `main()` → `processOneTask()`（原 main 主体）
- 新 `main()`:
  - 分布式: `initRedisIpc()` → `while(true) { processOneTask(); cleanup; }`
  - 非分布式: `processOneTask()` → `forceExitWithSafetyNet(0)`
- 引擎分支 `process.exit(0)` → `return`
- `forceExitWithSafetyNet(0)` 正常结束 → `return`
- 保留 `process.exit(1)` 致命错误
- SIGTERM: `closeRedisIpc()` → `process.exit(0)`

## 向后兼容

无 REDIS_URL 时：
- redis-bus 新函数 no-op
- IpcWatcherManager 不订阅 ipc-out
- mcp-bridge 使用文件系统 IPC
- agent-runner 单任务模式
- runForGroup 走 runContainerAgent/runHostAgent

零回归。
