# PRD: 分布式 IPC 遗留三项 — mcp-bridge Redis 输出 / Web 端 ipc-out 订阅 / 分布式 Runner 长驻循环

## 背景

Phase 4（commit c52bdd8）交付了 Agent IPC Redis 消息驱动 + Agent Runner 独立 Service，但遗留三项已知限制：

1. **mcp-bridge.ts 输出 IPC 在分布式模式下未走 Redis** — mcp-bridge 是 codex/opencode 引擎的子进程，用文件系统写 IPC（send_message → messages/、task requests → tasks/）。分布式模式下 agent-runner 在另一个 Pod，web 服务器无法 fs.watch 这些文件。
2. **Web 端未订阅 ipc-out 通道** — agent-runner 的 writeOutput() 已通过 publishIpcOutput 发布到 `deepthink:ipc-out:{folder}:messages`，但 web 服务器未订阅该通道，输出无法跨 Pod 到达 web 端。
3. **分布式 runner 单任务后退出** — agent-runner 的 main() 处理完一个任务后 process.exit(0)，靠 K8s 重启 Pod。应改为长驻循环，连续处理多任务。

## 目标

- mcp-bridge 在分布式模式下通过 Redis 发布 IPC 输出（send_message + task requests），实现跨 Pod 传递。
- Web 服务器订阅 `deepthink:ipc-out:{folder}:messages` 和 `deepthink:ipc-out:{folder}:tasks` 通道，接收分布式 agent-runner 的输出和 mcp-bridge 的 IPC 消息。
- Web 服务器 `writeTaskResult` 在 Redis 连接时同时将结果发布到 `deepthink:ipc-task:{folder}:{requestId}`，供分布式 mcp-bridge 接收。
- Agent-runner main() 改为长驻循环：处理完一个任务后不退出，继续 waitForTask() 等待下一个任务。
- Web 服务器在 Redis 连接且有分布式 runner 可用时，通过 `runDistributedAgent` 将任务发布到 `deepthink:agent-tasks`，并经 ipc-out 订阅接收流式输出。

## 非目标

- 不改变单 Pod 模式的行为（无 REDIS_URL 时全部 no-op，向后兼容）。
- 不重构 agent-runner 的 3500 行 main() 为多函数拆分（仅提取为 processOneTask + 循环包装）。
- 不改造 memory_append/search/get（这些工具直接操作工作区文件，经 PVC 共享，无需 Redis）。

## 验收标准

1. mcp-bridge 在 `DT_DISTRIBUTED_MODE=true` + `DT_REDIS_URL` 设置时，send_message 通过 Redis 发布，task requests 通过 Redis 请求/响应模式完成。
2. Web 服务器 IpcWatcherManager 在 Redis 连接时订阅 ipc-out 通道，agent_output 路由到 onOutput 回调，message 写入本地 messages/ 目录由 processGroupIpc 处理。
3. writeTaskResult 在 Redis 连接时发布结果到 ipc-task 通道。
4. 分布式 agent-runner 处理完一个任务后不退出，继续等待下一个任务。SIGTERM 时优雅退出。
5. Web 服务器在分布式模式下通过 runDistributedAgent 发布任务到 agent-tasks 频道并接收流式输出。
6. 无 REDIS_URL 时全部行为不变（单 Pod 模式零回归）。
7. `npm run build` 通过（tsc 无错误）。
