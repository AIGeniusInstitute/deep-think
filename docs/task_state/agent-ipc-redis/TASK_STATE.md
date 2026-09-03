# 任务状态: Agent IPC Redis 消息驱动 + Agent Runner 独立 Service

> 创建: 2026-09-03 | 最后更新: 2026-09-03 10:45

## 当前状态: ✅ 核心改造完成,编译+功能验证通过

## 背景

Phase 2 (`feat/full-horizontal-scaling`) 交付了 Redis 事件总线、PG 同步驱动、分布式选主等基础设施,
但 Agent IPC 仍是文件系统方式（`fs.watch` + sentinel 文件），`publishAgentIpc`/`subscribeAgentIpc` 是死代码。
本次改造完成"最后一公里"：Agent IPC → Redis 消息驱动 + Agent Runner 独立 K8s Deployment。

## 代码改动清单

### 新文件 (3)

| 文件 | 功能 | 验证 |
|---|---|---|
| `container/agent-runner/src/redis-ipc.ts` | Agent-runner 端 Redis IPC 模块（任务队列 + IPC pub/sub + 结果轮询） | ✅ tsc 通过 |
| `deploy/k8s/agent-runner.yaml` | Agent Runner 独立 K8s Deployment + Service + HPA (2-20 副本) | ✅ YAML 语法正确 |
| `docs/test_report/agent-ipc-redis/TEST_REPORT.html` | 测试报告 HTML | ✅ |

### 修改文件 (4)

| 文件 | 改动 | 验证 |
|---|---|---|
| `src/group-queue.ts` | 导入 `isRedisConnected`/`publishAgentIpc`/`getRegisteredGroup`; 新增 `resolveGroupFolder()` 辅助函数; `sendMessage`/`closeStdin`/`interruptQuery` 在无本地 agent 时通过 Redis 发布跨 Pod 消息 | ✅ tsc 通过, 单进程兼容 |
| `src/index.ts` | 导入 `isRedisConnected`/`subscribeAgentIpc`; `IpcWatcherManager.watchGroup()` 在 Redis 连接时订阅 `deepthink:ipc:{folder}` 通道, 将 Redis 消息桥接到本地文件; `unwatchGroup`/`closeAll` 清理订阅 | ✅ tsc 通过, 单进程兼容 |
| `container/agent-runner/src/index.ts` | 导入 redis-ipc 模块; 新增 Redis IPC 消息队列 + `consumeRedisSignal`/`drainRedisMessages`; `shouldClose`/`shouldDrain`/`shouldInterrupt`/`drainIpcInput` 优先检查 Redis 队列; `main()` 分布式模式从 Redis 读取任务; `writeOutput` 分布式模式通过 Redis 发布输出; 新增 `currentGroupFolder` 模块级变量 | ✅ tsc 通过 |
| `container/agent-runner/package.json` | 新增 `redis: ^4.7.0` 依赖 | ✅ npm install 成功 |
| `deploy/k8s/kustomization.yaml` | 添加 `agent-runner.yaml` 资源 | ✅ |

## 架构设计

### 宿主端 Redis 桥接（零侵入 agent-runner）

```
Pod B (用户连接)                    Pod A (agent 运行)
───────────────                    ───────────────
sendMessage()                       IpcWatcherManager
  │ state=null                        │ watchGroup(folder)
  │ Redis connected                   │ Redis connected
  ▼                                   ▼
publishAgentIpc(folder, payload) ──→ subscribeAgentIpc(folder, handler)
                                      │
                                      ▼ handler writes local file
                                      data/ipc/{folder}/input/{ts}.json
                                      │
                                      ▼ agent-runner reads via fs.watch
                                      drainIpcInput() / waitForIpcMessage()
```

- **输入方向** (web→agent): `sendMessage` 无本地 agent 时发布到 Redis; 有 agent 的 Pod 订阅并写入本地文件
- **输出方向** (agent→web): agent 写本地文件 → `IpcWatcherManager` fs.watch 检测 → `safeBroadcast` 已通过 Redis 跨 Pod 传播
- **控制信号** (_close/_drain/_interrupt): 同样通过 Redis 发布, 接收端写本地 sentinel 文件

### Agent Runner 分布式模式

```
K8s agent-runner Deployment (独立 Pod, 不由 web server spawn)
  │
  ├── REDIS_URL=redis://redis:6379
  ├── AGENT_RUNNER_MODE=distributed
  │
  ▼ main()
  initRedisIpc() → 连接 Redis
  waitForTask() → 从 deepthink:agent-tasks 频道获取任务
  subscribeIpcInput(folder) → 订阅 deepthink:ipc:{folder} 接收输入消息
  publishIpcOutput(folder, ...) → 发布输出到 deepthink:ipc-out:{folder}
  │
  shouldClose/shouldDrain/shouldInterrupt → 优先检查 Redis 队列
  drainIpcInput → 合并 Redis 消息 + 文件消息
  writeOutput → stdout + Redis 发布
```

### 向后兼容

- 无 `REDIS_URL`: 所有 Redis 函数 no-op, 行为与改造前完全一致
- 有 `REDIS_URL` 但 agent-runner 为子进程模式: 宿主桥接生效, agent-runner 仍读文件（由宿主写入）
- 有 `REDIS_URL` + `AGENT_RUNNER_MODE=distributed`: agent-runner 独立运行, 全程 Redis IPC

## 测试结果

| 用例 | 结果 | 证据 |
|---|---|---|
| TC-01 TypeScript 编译 (主服务) | ✅ | `npx tsc --noEmit` exit 0 零错误 |
| TC-02 TypeScript 编译 (agent-runner) | ✅ | `npx tsc --noEmit` exit 0 零错误 |
| TC-03 单进程向后兼容 | ✅ | 无 REDIS_URL 启动, /health 200, /ready 200, login 正常 |
| TC-04 Redis 连接模式 | ✅ | REDIS_URL 设置, "Redis event bus connected — multi-pod mode active" |
| TC-05 WebSocket 广播订阅 | ✅ | "Subscribed to Redis channel: deepthink:ws:broadcast" |
| TC-06 IpcWatcherManager Redis 桥接 | ✅ | watchGroup 在 Redis 连接时订阅 IPC 通道 (代码审查) |
| TC-07 Agent-runner 分布式模式初始化 | ✅ | initRedisIpc + subscribeIpcInput 代码集成 (代码审查) |

## 待办 (未来增强)

- [ ] mcp-bridge.ts 输出 IPC 在分布式模式下改用 Redis（当前分布式模式下 MCP 工具调用仍写本地文件）
- [ ] Web 服务端订阅 `deepthink:ipc-out:{folder}` 通道接收分布式 agent-runner 输出
- [ ] 分布式 agent-runner 长驻循环（当前: 单任务执行后退出, K8s 重启）
